# KEMLLM Status

Current build: `v135`

## Current Surface

- Chat, image, video, and local code workflows are the supported primary surfaces.
- Python runs in Pyodide.
- JavaScript and TypeScript run in the browser sandbox.
- Generated HTML can open in the built-in artifact preview pane.
- Cross-device sync and Replicate proxying are handled by the optional Cloudflare Worker.

## Removed In This Build

- Agent mode.
- Hugging Face sandbox/backend files.
- Desktop/noVNC controls.
- Preview audio streaming.
- Background/home music.
- Remote compiled-language execution options from the visible code UI.

## Verification Checklist

- Open the app and confirm the console build marker says `v135`.
- Confirm Settings has no agent backend fields and no background music fields.
- Confirm the chat plus menu has no agent/desktop option.
- Confirm the code runner only exposes Python, JavaScript, and TypeScript.
- Confirm generated HTML previews still open in the preview pane.
