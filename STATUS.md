# KEMLLM — Current Status

**Last updated:** session of 2026-04-07 (overnight fixes)
**Live at:** `https://karimdaman.github.io/KEMLLM/`
**Current build marker:** `v37 · regenerate preserves atts; Pyodide retries on failure`

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

- `0053b3e` — regenerateMessage preserves attachments; Pyodide retries on failure
- `15a4949` — Dropdowns clamp to viewport; flip above button if no room below
- `7519fc8` — Mobile polish: prevent iOS input zoom; guard dropdown hover transform
- `dd45b46` — **Mobile sidebar tap fix** — items no longer gray out without firing click
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
- Console (devtools): red banner saying `KEMLLM v37 · ...`
- Or: the first line in the chat area when you press the Desktop button says `› agent.js build: v37 · ...`

If you see any version earlier than v37, your cache is still holding stale JS. Fix: clear site data in browser settings, close all tabs, reload.

Once you're confirmed on v37, the previously-silent agent log lines will actually appear in the chat area — including the raw `POST /sessions` response body, which will finally reveal what your HF backend is returning (if it's misbehaving at all).

## Every fix from this overnight session, in plain English

### The single biggest bug discovery
`agentLog()` — the function every part of the agent boot/run code uses to show diagnostic output — was writing to `#ag-term`, a DOM element I deleted when I moved agent into a chat mode. For every commit after that, ALL the helpful diagnostic lines (boot progress, error messages, backend response bodies, build markers) were silently vanishing into the void. That's why you kept seeing the same error and never any new information — the new information was being generated but never shown. Fixed in commit `9ec3c0b`; agentLog now writes to the main chat area as color-coded mono-font lines.

### Mobile sidebar can't tap items
Three interlocking causes:
1. **Sticky `:hover`** on touch devices — the first tap applied the hover state, which persisted. The second tap would then fire the click, but users interpreted the first tap as "grayed out and broken".
2. **iOS default tap highlight** — a dark translucent overlay appears on tap, which looked exactly like a disabled state.
3. **`transition: all`** on sidebar items combined with `:hover { transform }` — during the 140ms tween, the click target was physically offset from where the user was looking.

Fixes (`dd45b46`): all `transform`-based `:hover` rules wrapped in `@media (hover: hover) and (pointer: fine)` so they only apply to real pointer devices. Touch-friendly `:active` fallbacks added. `-webkit-tap-highlight-color: transparent` and `touch-action: manipulation` on every clickable sidebar item. Mobile sidebar z-index raised to 9990 to eliminate any stacking doubt. Transitions narrowed to `background, color` only.

### iOS Safari auto-zooming on input focus
Any input with `font-size < 16px` triggers a viewport zoom when focused on iOS. Settings inputs at 13px, modal inputs at 12.5px, and the code editor were all affected. Fixed (`7519fc8`) by bumping them all to 16px inside `@media (max-width: 820px)`.

### Dropdowns falling off the edge of small screens
`positionDrop()` just set `top: r.bottom, left: r.left` without any viewport clamping. On mobile this meant the 300-320px chat/image/video model dropdown could extend past the right edge and get chopped, or fall below the input bar and be hidden. Fixed (`15a4949`) by measuring the dropdown, clamping horizontally, and flipping it above the button if there's no room below.

### Vision chat dropping attached images
`callReplicateChat` was turning messages into a plain text prompt, silently discarding the `attachments` array on every message. Since Replicate is the primary chat backend, this meant vision never worked unless the user also had a direct Anthropic/OpenAI/Google key. Fixed (`1736f77`) — `callReplicateChat` now extracts the first image and sends it under `image`, `image_input`, and `input_image` fields simultaneously so whichever schema the model uses, it picks it up. And (`fb753a1`) provider-specific paths filter attachments to images only (before, a PDF would be wrapped as `type: 'image'` in the Anthropic request, rejecting the whole thing).

### Agent boot getting stuck on pyodide after a failed HF attempt
`agentStart()` short-circuited with `Promise.resolve()` whenever `agentReady` was true. If a previous HF attempt had failed and fallen back to Pyodide, `agentReady` was already `true` but on the wrong backend. The Desktop button would call `agentStart()`, get an instant resolve, see `agentBackend === 'pyodide'`, and bail with "needs HF backend". Stuck until page refresh. Fixed (`015dba7`) — now if we're ready on pyodide BUT the user has an HF URL configured, we reset and retry HF. Also added `agentReset()` that the Desktop button proactively calls if state looks broken.

### CORS preflight failing silently
flask-cors default `allow_headers` in older versions doesn't include `Authorization`. When the frontend sent `Authorization: Bearer <token>` on a POST, the preflight OPTIONS response didn't list Authorization as allowed, the browser rejected the actual POST with "Failed to fetch", and no useful error appeared in the backend logs. Fixed in `agent-backend/app.py` with explicit `allow_headers` list AND an `@app.after_request` hook that stamps the full CORS header set on every response. Belt-and-suspenders.

### `localStorage` blowing up from attachment payloads
`saveCurrentChat()` was persisting the full `messages` array including base64 data URLs for every image attachment. A single image can be multiple megabytes; a few chats would hit the ~5 MB localStorage quota and silently fail. Fixed (`ac37cb1`) by stripping payloads before save (keeping name/size/mime/isImage metadata) and wrapping the write in a try/catch that drops oldest chats on `QuotaExceededError`.

### Chat reload showing broken image icons
After `localStorage` strip, reloading a chat tried to render `<img src="undefined">`. Fixed (`6cf601b`) — `renderUserMessage` detects missing dataUrls and falls back to a file chip with icon/name/size. And `loadChat` now passes `m.attachments` through so the chips actually appear.

### `regenerateMessage` losing attachments
Clicking Regenerate on a vision-chat message re-sent the text but without the image. Fixed (`0053b3e`) — now restores the attachments into `pendingAttachments` before re-sending, best-effort (post-reload the dataUrls are gone).

### Pyodide cache locked on failure
`getPyodide()` stored the `loadPyodide()` promise in a module var and returned it on every subsequent call. If the jsdelivr CDN hiccuped on first load, every future attempt would return the same rejected promise — never retrying, never recovering until page refresh. Fixed (`0053b3e`) — on rejection, clear the cached promise so the next call starts fresh.

### Image generation 404 on attached images
The IMG_REGEX was matching any message with "image" or "show" in it, so attaching a photo and saying "what's in this image?" was being routed to Replicate image GENERATION instead of vision chat. And the selected image model's slug was a placeholder that 404'd. Fixed earlier (`2a4bc20`) — attachments skip IMG_REGEX entirely, and image generation has a fallback chain through real known-working Replicate models.

### Sidebar "Chat" button was redundant
The "Chat" sidebar nav item did nothing useful (the chat list below already handles switching between chats). Replaced it with a "New Chat" button (`26d7b46`). Each panel now has its own URL too (`#/chat`, `#/code`, `#/models`, `#/settings`) so browser back/forward and deep-links work.

### Image editing was wired but unused
Added `handleEditImageRequest` + `editImage()` with FLUX Kontext Pro and a fallback chain (`2bced16`). EDIT_REGEX detects "edit/change/modify/turn/remove/add/enhance/colorize/..." keywords when there's an image attached and routes to img2img instead of vision chat.
