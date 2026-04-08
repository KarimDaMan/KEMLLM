# KEMLLM — Claude session notes

## Deployment workflow

**ALWAYS merge into `main` after committing on a feature branch.** GitHub
Pages auto-deploys from `main`, and the user expects fixes to land on the
live site immediately. Do not leave fixes stranded on a feature branch
waiting for review.

The fast-forward push pattern below avoids touching local `main` (which
has stale pre-refactor history) and never needs `--force`:

```bash
# After committing your fix on the feature branch:
git push -u origin <feature-branch>
git push origin <feature-branch>:main
```

Only do this if `origin/main` is an ancestor of your feature branch
(i.e. a real fast-forward). Verify with:

```bash
git merge-base --is-ancestor origin/main <feature-branch> && echo FF-OK
```

If it's not a fast-forward, stop and ask the user before doing anything
destructive.

## Versioning

Every user-visible change must bump three things in lockstep, otherwise
the auto-reload-on-stale-HTML detector in `js/app.js` breaks and users
get cached old code:

1. `KEMLLM_BUILD = 'vNNN · ...'` constant in `js/app.js`
2. `?v=NNN` cache buster on every `<script>` and `<link>` tag in `index.html`
3. `<body data-kemllm-build="NNN">` attribute in `index.html`

All three numbers must match. The auto-reload detector compares (1) against (3).

## Architecture quick reference

- `index.html` — single-page shell, all DOM lives here
- `css/style.css` — all styles
- `js/state.js` — localStorage profiles, cross-device sync
- `js/models.js` — chat/image/video model catalog
- `js/api.js` — `callChat`, `generateImage`, `editImage`, `generateVideo`,
  `runWebSearch`, `getSystemPrompt`
- `js/chat.js` — `sendMessage`, marker processing (`processAIMarkers`,
  `stripAIMarkers`), image viewer, web-search follow-up loop
- `js/code.js` — Pyodide + Piston code execution
- `js/agent.js` — Agent Mode loop + HF backend client
- `js/ui.js` — settings panels, memory CRUD, export
- `js/app.js` — event wiring, init, `KEMLLM_BUILD`
- `cloudflare-worker/kemllmbackend.js` — OAuth, sync, Replicate proxy,
  `/search` (DuckDuckGo HTML proxy)

## AI markers (handled in `chat.js processAIMarkers` / `sendMessage`)

| Marker | Effect |
|---|---|
| `[GENERATE_IMAGE prompt="..." aspect_ratio="..."]` | runs image gen |
| `[GENERATE_VIDEO prompt="..." aspect_ratio="..."]` | runs video gen |
| `[EDIT_IMAGE prompt="..." aspect_ratio="..."]` | edits last image |
| `[REMEMBER fact="..."]` | appends to AI memory |
| `[WEB_SEARCH query="..."]` | runs `runWebSearch`, feeds results back as a follow-up turn (capped at 3 hops). Works for ALL providers. |
| `[SHOW_PREVIEW path=... title="..."]` / `[SHOW_DESKTOP]` | preview pane |

All markers must be added to `stripAIMarkers` so they don't render as
literal text in the user-visible bubble.

## Web search source order (`runWebSearch` in `js/api.js`)

1. **Jina Reader** (`s.jina.ai`) — CORS, no key, no setup. Primary source.
2. **KEMLLM worker `/search`** — DuckDuckGo HTML proxy. Requires worker deploy.
3. **DuckDuckGo Instant Answer API** — limited but CORS-enabled.
4. **Wikipedia opensearch** — encyclopedic only, always works.

Each source is tried in order; first one that returns results wins.
