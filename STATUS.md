# KEMLLM — Current Status

**Last updated:** session of 2026-04-07 (overnight fixes)
**Live at:** `https://karimdaman.github.io/KEMLLM/`
**Current build marker:** `v33 · chat reload renders attachments + robust content handling`

Look for the build marker in the browser console (red banner) or at the top of the agent terminal area the first time you use Agent mode. If you see anything earlier than `v31`, your browser is caching old JavaScript — open a private/incognito window.

---

## ✅ What works right now

### Chat
- **Text chat** with every model (Anthropic, OpenAI, Google, xAI, Meta, Mistral, DeepSeek) through your Replicate key as the primary path
- **Direct provider keys are optional overrides** — add them in Settings → API Keys if you want better multimodal support or lower latency
- **New Chat button** in the sidebar (replaces the old "Chat" nav item, since the chat list already handles switching between chats)
- **Chat list** in the sidebar with top 15 recent chats, plus "View all chats" modal
- **Per-profile persistence** of chats, settings, and keys in localStorage
- **Custom persona** in Settings gets appended to every system prompt

### URL routing
- Each panel has its own URL: `#/chat`, `#/code`, `#/models`, `#/settings`
- Browser back/forward buttons work
- Deep links work (share `...#/settings` and it opens straight to settings)
- Page refresh stays on the current panel
- Document title updates to `KEMLLM · Chat`, `KEMLLM · Code`, etc.

### Modes
- **Chat** — normal conversation
- **Code** — code-focused responses
- **Agent** — autonomous loop: AI writes bash, we run it, we feed back output, AI continues, up to 25 iterations or until stop. User can type mid-loop to inject instructions without stopping it.

### Vision chat (images)
- Attach images via the paperclip button or paste
- Images are routed to direct provider APIs first (guaranteed multimodal)
- Falls back to Replicate's chat proxies which accept `image` / `image_input` / `input_image` keys (some models accept vision input)
- Non-image attachments (PDFs, zips, etc.) are accepted by the UI, shown as chips, and uploaded to the Agent sandbox if in agent mode

### Image generation
- Text-to-image via Replicate with auto-fallback chain (flux-schnell → flux-1.1-pro → sd-3-medium → ideogram-v3-turbo)
- Detection regex catches "generate/make/create an image of ..."

### Image editing (img2img)
- Attach an image + ask "edit / change / modify / turn / remove / add / enhance ..."
- Routes to FLUX Kontext Pro via Replicate (dedicated image editor)
- Fallback chain: flux-kontext-pro → flux-kontext-dev → nano-banana → flux-dev

### Code execution
- **Python** — runs entirely in-browser via Pyodide (WebAssembly, persistent state, micropip)
- **JavaScript/TypeScript** — runs in a sandboxed iframe (persistent per-session)
- **C/C++/Rust/Go/Java/Bash/Lua** — need the HF Agent Backend to run

### Agent Mode
- Terminal-style chat inside the chat panel (not a separate panel anymore)
- Two backends: **HF Agent Backend** (real Ubuntu, preferred) or **Pyodide** (fallback)
- Autonomous loop with user interjection queue
- Stop button (send button swaps to stop while loop is running)
- Floating **Desktop button** appears in top-right of chat panel when the HF backend has the desktop stack installed — click it to boot Xvfb + fluxbox + x11vnc + noVNC and see a live Linux desktop in a preview iframe
- Preview pane (file viewer + noVNC desktop) with fullscreen mode

### Other
- GitHub OAuth sign-in (via your `kemllmbackend` worker) and Try Demo
- Mobile responsive: hamburger sidebar, horizontal-scrolling topbar, 92vw modals
- Starry-less minimal dark UI with red accent by default
- Terminal boot animation on the home screen with real model names
- Copy / Regenerate buttons on every AI message

---

## 🛠 What needs a one-time setup step

### 1. HF Agent Backend (for real Linux)
Only needed if you want `apt`, `sudo`, compiled binaries, or the interactive desktop.

The backend code lives in `agent-backend/`. You deploy it as a Hugging Face Space:
1. Create a new HF Space, pick **Docker SDK → Blank**
2. Add three files to the Space:
   - `Dockerfile` (from `agent-backend/Dockerfile`)
   - `app.py` (from `agent-backend/app.py`)
   - `README.md` (from `agent-backend/README.md` — has the HF frontmatter)
3. HF rebuilds (5–7 minutes because of the desktop packages)
4. In KEMLLM → Settings → **Agent Backend URL**: paste `https://YOUR-USERNAME-kemllm-agent.hf.space`
5. Optionally set an `AGENT_TOKEN` secret on the Space for authentication — paste the same string into **Agent Backend Token** in KEMLLM Settings

Full guide in `agent-backend/SETUP.md`.

### 2. If you're getting "session_id" errors after doing step 1
Your Space might be running old `app.py` code from an earlier commit. Update the file on the Space to match the current `agent-backend/app.py` in this repo. The new one has:
- Explicit CORS `allow_headers` including `Authorization`
- `@app.after_request` hook that stamps CORS on every response
- `/desktop` reverse proxy for noVNC
- `/sessions/{id}/files/<path>` file-serving endpoint
- `requests` library used by the desktop proxy (already in the Dockerfile's pip list)

### 3. GitHub OAuth
Already set up via the `kemllmbackend` Cloudflare Worker. Uses Client ID `Ov23li20jlCBobnJjusT`. The Worker is at `kemllmbackend.karimghannam2014.workers.dev` and has the secret set.

### 4. Cloudflare token
The API token `cfut_E9LUsu9d...` that was shared earlier is compromised (it's in the chat log). Rotate it at `https://dash.cloudflare.com/profile/api-tokens`. Nothing in the app depends on this token at runtime — it was only used one-time for deploying the Cloudflare Worker via API.

### 5. GitHub OAuth secrets
Both GitHub client secrets that were shared in chat (`10b522088...` and `66a737a77...`) are compromised. Rotate them at your OAuth App page. Update the kemllmbackend Worker's `GITHUB_CLIENT_SECRET` env var with the new one.

---

## 🐛 Known issues / things to watch

### Agent Mode boot failures
Fixed in commit `9ec3c0b` — the `agentLog` function was writing to a deleted DOM element, so every diagnostic line was silently vanishing. You should now see clear step-by-step progress in the chat area when pressing the Desktop button, including the exact `POST /sessions` response body.

If you still see failures after hard-refreshing to v31+:
- Open your Space's URL in a browser. It should return `{"ok":true,"service":"kemllm-agent-backend",...}`. If it shows HF's "Preparing Space" screen, the Space is sleeping — wait 60s and retry.
- If it returns a 500 error mentioning `requests`, your Dockerfile is out of date — update it.
- If it returns 404 on `/desktop`, your app.py is out of date — update it.

### Stale cache
If you see stale behavior, open a **private/incognito window**. That bypasses almost all caching layers. Look for the build marker to confirm you're on fresh JS.

### Replicate model IDs
Anthropic/OpenAI/Google/xAI chat models have Replicate IDs as given, which may or may not resolve to real Replicate endpoints depending on what Replicate actually hosts. If a specific model 404s on Replicate, the fallback will be to try the direct provider API — that requires adding a key in Settings.

### HF Spaces free tier
Free tier sleeps after ~48h of inactivity. First request after sleep takes 20–60 seconds to wake. The Desktop button has a wait-for-ready polling loop that handles this, but the first chat call in agent mode won't and may need a retry.

### Compromised secrets
See section 4–5 above. Rotate all credentials that appeared in chat.

---

## Morning priority list

1. **Open a private/incognito window** and navigate to the live app
2. **Verify build marker** — should say `v31` or higher. If not, clear site data and reload.
3. **Rotate compromised secrets** (Cloudflare token, 2× GitHub OAuth secrets, all passwords that use `Kooka2014` pattern)
4. **Update HF Space** with the latest `Dockerfile` + `app.py` from this repo if Agent Mode is misbehaving
5. **Try agent mode** with something simple like *"uname -a"* — should work end-to-end. Check the build marker line at the top of the boot log.

---

## Repo layout

```
KEMLLM/
├── index.html              single-page app shell, loads all JS modules
├── css/
│   └── style.css           all styles, dark minimal UI
├── js/
│   ├── state.js            profile system, localStorage
│   ├── models.js           chat/image/video model registry
│   ├── api.js              callChat, vision/text routing, Replicate/Anthropic/OpenAI/Google
│   ├── chat.js             sendMessage, agent loop, preview pane, image gen/edit
│   ├── code.js             Pyodide + sandboxed iframe JS runner
│   ├── agent.js            HF backend client, pyodide fallback, agentLog
│   ├── ui.js               siNav, dropdowns, modals, hash router
│   └── app.js              DOMContentLoaded wiring, build marker
├── agent-backend/          deploy to HF Space for real Linux
│   ├── Dockerfile          Ubuntu 22.04 + dev tools + Xvfb/noVNC/Chromium
│   ├── app.py              Flask REST API with sessions + /desktop proxy
│   ├── README.md           HF Space frontmatter
│   └── SETUP.md            step-by-step deploy guide
└── STATUS.md               this file
```

---

## Commit log (newest first)

- `6cf601b` — Chat reload renders attachment chips; robust content handling
- `ac37cb1` — newChat resets agent loop; strips attachments from localStorage
- `8da87ed` — Add STATUS.md
- `fb753a1` — Filter non-image attachments per provider; preserve atts in agent mode
- `9ec3c0b` — **CRITICAL:** `agentLog` was writing to a DOM element that no longer exists
- `1736f77` — Vision chat via Replicate when no direct provider key
- `015dba7` — Bulletproof agent boot; belt-and-suspenders CORS; `agentReset()`
- `26d7b46` — Hash router per panel; sidebar "Chat" → "New Chat"
- `2bced16` — Image editing (FLUX Kontext) + aggressive cache busting
- `2a4bc20` — Fix Replicate 404 on attachments + HF Space cold-start handling
- `1078743` — Agent mode: autonomous loop with mid-run user injection
- `c14634c` — AI can show a preview pane AND a full interactive Linux desktop
- `b1a1fe5` — Floating Desktop button

## Single most important thing to verify tomorrow

Open the app in a **private/incognito window** and look for the build marker:
- Console (devtools): red banner saying `KEMLLM v33 · ...`
- Or: the first line in the chat area when you press the Desktop button says `› agent.js build: v33 · ...`

If you see any version earlier than v33, your cache is still holding stale JS. Fix: clear site data in browser settings, close all tabs, reload.

Once you're confirmed on v33, the previously-silent agent log lines will actually appear in the chat area — including the raw `POST /sessions` response body, which will finally reveal what your HF backend is returning (if it's misbehaving at all).
