# KEMLLM Maintainer Notes

## Deployment

GitHub Pages deploys from `main`. If you are shipping directly, make sure your branch can fast-forward `origin/main` before pushing it to `main`.

```bash
git merge-base --is-ancestor origin/main <branch> && echo FF-OK
git push -u origin <branch>
git push origin <branch>:main
```

Stop and ask before any non-fast-forward or destructive Git operation.

## Versioning

Every user-visible change must bump these together:

1. `KEMLLM_BUILD` in `js/app.js`.
2. `?v=N` cache busters in `index.html`.
3. `<body data-kemllm-build="N">` in `index.html`.

The stale-HTML detector compares the build constant with the body attribute.

## Architecture

- `index.html`: SPA shell and static DOM.
- `css/style.css`: all app styling and skin overrides.
- `js/state.js`: local profiles, localStorage, and sync helpers.
- `js/models.js`: chat, image, video, and custom model catalog.
- `js/api.js`: provider calls, generation calls, web search, and system prompt construction.
- `js/chat.js`: message flow, markers, artifact previews, image viewer, and web-search follow-up loop.
- `js/code.js`: Pyodide plus browser-sandboxed JavaScript/TypeScript execution.
- `js/ui.js`: settings, memory UI, exports, and navigation helpers.
- `js/app.js`: event wiring, initialization, and build marker.
- `cloudflare-worker/kemllmbackend.js`: OAuth, sync, Replicate proxy, and search proxy.

## AI Markers

| Marker | Effect |
| --- | --- |
| `[GENERATE_IMAGE prompt="..." aspect_ratio="..."]` | Runs image generation. |
| `[GENERATE_VIDEO prompt="..." aspect_ratio="..."]` | Runs video generation. |
| `[EDIT_IMAGE prompt="..." aspect_ratio="..."]` | Edits the last generated or attached image. |
| `[REMEMBER fact="..."]` | Appends to AI memory. |
| `[WEB_SEARCH query="..."]` | Runs web search and feeds results back as a follow-up turn. |
| `[SHOW_PREVIEW url=... title="..."]` | Opens a URL in the artifact preview pane. |

Add new markers to `stripAIMarkers` in `js/chat.js` so raw marker text does not render in chat bubbles.

## Current Non-Goals

The app intentionally does not include agent mode, a remote shell backend, desktop/noVNC control, preview audio streaming, or background music.
