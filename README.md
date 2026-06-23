# KEMLLM

A static single-page AI workspace for chatting with multiple model providers, generating and editing images, generating video, running local browser-sandboxed code, and keeping user memory.

Everything is HTML, CSS, and JavaScript. There is no framework and no build step.

## Quick Start

1. Open `index.html` or host the repo on GitHub Pages, Netlify, Vercel, or Cloudflare Pages.
2. Sign in with GitHub for cross-device sync, or use demo mode for local-only storage.
3. Open Settings and add one or more API keys:
   - Replicate for most image, video, and open model routes.
   - Anthropic for Claude.
   - OpenAI for GPT.
   - Google for Gemini.
   - xAI for Grok.
4. Pick a model and start chatting.

## Features

- Universal chat across direct provider APIs and Replicate-backed models.
- Image generation and image editing through model markers handled by the frontend.
- Video generation through Replicate-backed video models.
- Local code execution for Python via Pyodide and JavaScript/TypeScript in a browser sandbox.
- HTML artifact previews for generated web pages and interactive components.
- Persistent user memory and AI-written memory markers.
- LaTeX math rendering with KaTeX.
- Cross-device sync through the optional Cloudflare Worker.
- Debug logging for frontend network calls.
- Mobile-first responsive layout.

## Optional Backend

The only optional backend in this repo is the Cloudflare Worker at `cloudflare-worker/kemllmbackend.js`.

It handles:

- GitHub OAuth callback for sign-in.
- KV-backed `/sync` storage.
- Replicate reverse proxy routes to avoid browser CORS issues.
- Search proxy routes used by web-search markers.

## Repository Layout

```text
index.html
css/
  style.css
js/
  state.js
  models.js
  api.js
  chat.js
  code.js
  ui.js
  app.js
cloudflare-worker/
  kemllmbackend.js
STATUS.md
CLAUDE.md
```

## Shipping Changes

For user-visible changes, bump these together:

1. `KEMLLM_BUILD` in `js/app.js`.
2. Every `?v=N` script/style cache buster in `index.html`.
3. `<body data-kemllm-build="N">` in `index.html`.

The current UI intentionally has no agent mode, no desktop backend, and no background music.

## License

Personal project. Do whatever you want with it.
