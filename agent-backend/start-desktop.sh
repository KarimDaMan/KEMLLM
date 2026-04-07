#!/usr/bin/env bash
# Entrypoint for Dockerfile.desktop — boots the noVNC stack before app.py.
# Runs everything in the background, waits for port 6080, then execs the
# Flask server in the foreground so the container's PID 1 is app.py and
# HF Spaces sees a proper health signal on :7860.
set -u

export DISPLAY=:0
export HOME=/home/agent
cd "$HOME"

log(){ echo "[start-desktop] $*" >&2; }

log "starting Xvfb :0 1280x720x24"
Xvfb :0 -screen 0 1280x720x24 -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!

# Wait until the X server is actually ready before anything tries to connect.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if xdpyinfo -display :0 >/dev/null 2>&1; then break; fi
  sleep 0.3
done

log "starting fluxbox"
fluxbox >/tmp/fluxbox.log 2>&1 &

log "starting x11vnc on :5900"
x11vnc -display :0 -forever -nopw -shared -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 &

log "starting websockify 6080 -> 5900 (noVNC)"
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

# Wait until 6080 is actually listening before handing off.
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if (echo >/dev/tcp/127.0.0.1/6080) >/dev/null 2>&1; then
    log "noVNC listening on :6080"
    break
  fi
  sleep 0.4
done

log "launching app.py on :7860"
exec python3 /app/app.py
