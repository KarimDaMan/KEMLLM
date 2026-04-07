# KEMLLM

A single-page AI workspace that talks to any model — Claude, GPT, Gemini, Llama, Flux, Nano Banana, Kling, etc. — through one interface. Chat, generate images, generate video, edit images, run code in a browser sandbox, and drive a real Linux desktop through an agent.

Everything is static HTML + CSS + JS. No build step. No framework. Drop it on GitHub Pages and it works.

## Live URL

The canonical deploy is on GitHub Pages. Fork it or host your own copy if you want your own URL.

## Quick start (as a user)

1. Open the site.
2. Click **Sign in with GitHub** to enable cross-device sync, or click **Try demo** for a local-only session.
3. Open **Settings** (sidebar gear icon) and paste at least one API key:
   - **Replicate** — covers most models (Flux, Kling, Llama, Nano Banana, Sonnet, etc.) through one key. Get a token at `https://replicate.com/account/api-tokens`.
   - **Anthropic** — for Claude Opus/Sonnet/Haiku via the direct API (cheaper than Replicate for Claude).
   - **OpenAI** — for GPT via the direct API.
   - **Google** — for Gemini via the direct API.
4. Pick a chat model from the topbar dropdown.
5. Start chatting. That's it.

The AI can generate images, videos, edit images, run code, and write to its own persistent memory — all automatically. You don't have to switch modes.

## Features

- **Universal chat** — Claude / GPT / Gemini / Llama / Mistral / open-source models, all via a single input.
- **Image generation** — Flux, Nano Banana Pro, Ideogram, SDXL, Recraft, and every other Replicate image model. The AI decides when to generate and crafts the prompt itself.
- **Image editing** — Nano Banana, Flux Kontext, Flux Fill, inpainting models. Tap any generated image to re-edit, OCR, download, or use as context.
- **Video generation** — Kling, Luma, Minimax, Veo-style models on Replicate.
- **Code execution** — Python (Pyodide, in-browser), JavaScript (sandboxed iframe), and ~30 other languages (remote Piston sandbox). The AI writes a fenced code block, the app executes it, and the result is fed back automatically. Output shows in a collapsed strip under the message — tap to expand, with an HTML preview button when the code is a web page.
- **Agent Mode** — connects to a Hugging Face Space running a Flask sandbox. The AI gets a persistent `/bin/bash` session, can read/write files, install packages, and (with the desktop build) drive a real Linux desktop you can see in a preview pane.
- **Persistent memory** — two tiers:
  - **Memory** (user-edited): facts you type in and can delete.
  - **AI Memory** (AI-edited, read-only): the model silently emits `[REMEMBER fact="..."]` markers when it learns something about you. You can view and reset but not edit individual entries.
- **LaTeX math** rendered with KaTeX (`$...$` and `$$...$$`).
- **Cross-device sync** via a Cloudflare Worker + KV. Sign in with GitHub on any device and your chats, settings, and memories follow you.
- **Debug log** with a live `fetch()` ring buffer in Settings so you can see exactly what the app is sending and receiving.
- **Export** everything as JSON from the drawer.
- **Mobile** full-screen layout with proper viewport handling, not a squished desktop UI.

## Fork & self-host

```
git clone https://github.com/karimdaman/kemllm.git
cd kemllm
# Open index.html in any browser — no build step needed.
```

Deploy it to **GitHub Pages** in one click: fork → Settings → Pages → source: main / root. Or drop it on Netlify, Vercel, Cloudflare Pages, whatever.

## Backends

Two optional backends live in this repo. Both are optional — KEMLLM works without them using direct provider APIs.

### 1. Cloudflare Worker (`cloudflare-worker/kemllmbackend.js`)

Handles:
- GitHub OAuth callback for sign-in.
- `/sync` endpoints for cross-device storage (KV-backed).
- `/replicate/*` reverse-proxy to `api.replicate.com` (avoids CORS from the browser).

**Deploy:**
1. Create a Cloudflare Worker.
2. Paste `cloudflare-worker/kemllmbackend.js` into the editor → Save and Deploy.
3. Bind a KV namespace called `SYNC` in the worker settings.
4. Add secrets: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (create a GitHub OAuth App first, set the callback to `https://<your-worker>.workers.dev/github/callback`).
5. Update `js/state.js` `GITHUB_CALLBACK` and `SYNC_BASE` constants and `js/api.js` `REPLICATE_BASE` to point at your worker URL.

### 2. Agent backend (`agent-backend/`)

A Flask sandbox you deploy to a free Hugging Face Space so the AI can run shell commands inside a real Linux environment. Two variants:

- **`Dockerfile`** (slim) — headless Python + Flask. Commands only, no GUI. ~150 MB image, boots in seconds, works on the free CPU tier.
- **`Dockerfile.desktop`** (heavy) — adds Xvfb + fluxbox + x11vnc + websockify + noVNC + Chromium so the AI can drive a real desktop and you can watch it live in the preview pane. ~400 MB image, needs at least the 2 vCPU / 16 GB upgrade tier.

**Deploy (slim):**
1. Create an HF Space: `https://huggingface.co/new-space`, SDK = Docker.
2. Upload two files to the Space root:
   - `agent-backend/Dockerfile` (rename to just `Dockerfile`)
   - `agent-backend/app.py`
3. Space Settings → Variables and secrets → Add secret `AGENT_TOKEN` = any long random string.
4. Wait for the build (~2 min).
5. In KEMLLM → Settings → Agent, paste `https://yourname-<spacename>.hf.space` and the same token.

**Deploy (desktop):**
Same steps, but upload `Dockerfile.desktop` (rename to `Dockerfile`) instead of the slim one. The noVNC stack auto-starts — no extra scripts needed. You only ever upload two files: `Dockerfile` and `app.py`. Once it's running, Agent Mode plus the floating Desktop button in the chat pane will both appear.

See `agent-backend/SETUP.md` for a longer walkthrough with screenshots.

## Where everything lives

```
index.html                    Main SPA shell
css/style.css                 All styles
js/
  state.js                    localStorage profiles, cross-device sync
  models.js                   Chat/image/video model catalog + custom models
  api.js                      callChat / generateImage / editImage / generateVideo
  chat.js                     sendMessage, marker processing, image viewer
  code.js                     Pyodide + Piston code execution
  agent.js                    Agent Mode loop + HF backend client
  ui.js                       Settings panels, memory CRUD, export
  app.js                      Event wiring, init, KEMLLM_BUILD version
cloudflare-worker/
  kemllmbackend.js            Worker source (OAuth + sync + Replicate proxy)
agent-backend/
  Dockerfile                  Slim HF Space backend
  Dockerfile.desktop          Heavy HF Space backend with noVNC
  app.py                      Flask sandbox service
  SETUP.md                    Longer deployment walkthrough
STATUS.md                     Rolling notes on what's working and known issues
```

## Contributing

Changes land on `main` and auto-deploy to GitHub Pages. Bump the `KEMLLM_BUILD` constant in `js/app.js` and the `?v=N` cache-buster in `index.html` when you ship something user-visible, so stale browser caches are invalidated.

## License

Personal project. Do whatever you want with it.
