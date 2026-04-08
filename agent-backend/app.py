"""
KEMLLM Agent Backend
====================
A tiny Flask service that exposes a real Linux shell over REST.

Designed to run on Hugging Face Spaces (Docker SDK) but works anywhere
that can run a Docker container.

Endpoints
---------
GET    /                     → health/status
GET    /healthz              → minimal liveness probe (always 200)
POST   /sessions             → create a new persistent shell session
POST   /sessions/<id>/exec   → run a command in that session (preserves cwd)
POST   /sessions/<id>/write  → write a file
POST   /sessions/<id>/read   → read a file
DELETE /sessions/<id>        → kill the session

Auth
----
Set the AGENT_TOKEN secret in your HF Space. Every request must include
    Authorization: Bearer <AGENT_TOKEN>

CORS is enabled for all origins so you can call from a static web app.
"""
import os
import sys
import subprocess
import secrets
import time
import threading
import signal
import mimetypes
import traceback

# Print startup banner immediately so HF logs show progress even if
# imports below fail. HF marks a Space unhealthy if it sees no output
# during boot.
print("[kemllm-agent] starting…", flush=True)
print(f"[kemllm-agent] python={sys.version.split()[0]} pid={os.getpid()}", flush=True)

try:
    from flask import Flask, request, jsonify, send_file, Response, abort
    print("[kemllm-agent] flask imported", flush=True)
except Exception as e:
    print(f"[kemllm-agent] FATAL: flask import failed: {e}", flush=True)
    traceback.print_exc()
    sys.exit(1)

try:
    from flask_cors import CORS
    print("[kemllm-agent] flask_cors imported", flush=True)
except Exception as e:
    print(f"[kemllm-agent] WARN: flask_cors not available, falling back: {e}", flush=True)
    # Provide a minimal CORS shim so the app still boots
    def CORS(app, **kwargs):
        return None

AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "").strip()
PORT = int(os.environ.get("PORT", "7860"))
SESSION_TIMEOUT = 60 * 30  # 30 minutes idle → kill session
EXEC_TIMEOUT = 120         # per-command timeout

app = Flask(__name__)
# CORS: be extremely permissive so static frontends on any origin work.
# flask-cors' defaults sometimes don't include Authorization in the allowed
# header list, which silently breaks POST requests with a Bearer token
# (preflight fails, fetch shows 'Failed to fetch' in devtools).
CORS(
    app,
    resources={r"/*": {"origins": "*"}},
    allow_headers=["Content-Type", "Authorization", "X-API-Key", "Prefer", "Accept"],
    methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    expose_headers=["*"],
    supports_credentials=False,
)

# Belt-and-suspenders: stamp CORS headers on EVERY response so even if
# flask-cors misbehaves on some edge case, the browser still sees a valid
# preflight reply.
@app.after_request
def _force_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-API-Key, Prefer, Accept"
    response.headers["Access-Control-Allow-Methods"] = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
    response.headers["Access-Control-Max-Age"] = "86400"
    return response

# session_id -> { cwd, env, created, last_used }
SESSIONS: dict = {}
SESSIONS_LOCK = threading.Lock()


def require_auth():
    if not AGENT_TOKEN:
        return None  # No token configured = open mode (insecure but allowed)
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return jsonify({"error": "missing bearer token"}), 401
    if auth.split(" ", 1)[1].strip() != AGENT_TOKEN:
        return jsonify({"error": "invalid token"}), 401
    return None


def cleanup_expired():
    now = time.time()
    with SESSIONS_LOCK:
        dead = [sid for sid, s in SESSIONS.items() if now - s["last_used"] > SESSION_TIMEOUT]
        for sid in dead:
            del SESSIONS[sid]


@app.route("/", methods=["GET", "HEAD"])
def health():
    return jsonify({
        "service": "kemllm-agent-backend",
        "ok": True,
        "auth_required": bool(AGENT_TOKEN),
        "active_sessions": len(SESSIONS),
    })


@app.route("/healthz", methods=["GET", "HEAD"])
def healthz():
    """Minimal liveness probe — always returns 200 with no work.
    HF Spaces and other orchestrators sometimes prefer a dedicated
    /healthz path for readiness checks."""
    return ("ok", 200, {"Content-Type": "text/plain"})


@app.route("/sessions", methods=["POST", "OPTIONS"])
def create_session():
    if request.method == "OPTIONS":
        return ("", 204)
    err = require_auth()
    if err:
        return err
    cleanup_expired()
    sid = secrets.token_urlsafe(12)
    home = f"/home/agent/sessions/{sid}"
    os.makedirs(home, exist_ok=True)
    with SESSIONS_LOCK:
        SESSIONS[sid] = {
            "cwd": home,
            "env": {},
            "created": time.time(),
            "last_used": time.time(),
        }
    return jsonify({
        "session_id": sid,
        "cwd": home,
        "shell": "/bin/bash",
        "user": os.environ.get("USER", "agent"),
    })


@app.route("/sessions/<sid>/exec", methods=["POST", "OPTIONS"])
def exec_in_session(sid):
    if request.method == "OPTIONS":
        return ("", 204)
    err = require_auth()
    if err:
        return err
    cleanup_expired()
    with SESSIONS_LOCK:
        s = SESSIONS.get(sid)
    if not s:
        return jsonify({"error": "session not found", "code": "no_session"}), 404
    body = request.get_json(silent=True) or {}
    cmd = body.get("command", "").strip()
    if not cmd:
        return jsonify({"error": "missing command"}), 400

    # Track cwd across calls by appending `; pwd` and parsing it out
    marker = "__KEMLLM_PWD_MARKER__"
    wrapped = f"cd {shell_quote(s['cwd'])} && {{ {cmd}; }}; __ec=$?; printf '%s%s\\n' '{marker}' \"$(pwd)\"; exit $__ec"

    env = os.environ.copy()
    env.update(s["env"])
    try:
        proc = subprocess.run(
            ["/bin/bash", "-lc", wrapped],
            capture_output=True,
            text=True,
            timeout=EXEC_TIMEOUT,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return jsonify({"error": "command timed out", "stdout": "", "stderr": "", "exit_code": 124}), 200

    stdout = proc.stdout or ""
    stderr = proc.stderr or ""

    # Pull the marker line out so it doesn't show in user output
    new_cwd = s["cwd"]
    lines = stdout.splitlines()
    cleaned = []
    for line in lines:
        if line.startswith(marker):
            new_cwd = line[len(marker):]
        else:
            cleaned.append(line)
    stdout = "\n".join(cleaned)
    if stdout and not stdout.endswith("\n"):
        stdout += "\n"

    with SESSIONS_LOCK:
        if sid in SESSIONS:
            SESSIONS[sid]["cwd"] = new_cwd
            SESSIONS[sid]["last_used"] = time.time()

    return jsonify({
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": proc.returncode,
        "cwd": new_cwd,
    })


@app.route("/sessions/<sid>/write", methods=["POST", "OPTIONS"])
def write_file(sid):
    if request.method == "OPTIONS":
        return ("", 204)
    err = require_auth()
    if err:
        return err
    with SESSIONS_LOCK:
        s = SESSIONS.get(sid)
    if not s:
        return jsonify({"error": "session not found"}), 404
    body = request.get_json(silent=True) or {}
    path = body.get("path", "")
    content = body.get("content", "")
    if not path:
        return jsonify({"error": "missing path"}), 400
    full = path if path.startswith("/") else os.path.join(s["cwd"], path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(content)
    return jsonify({"ok": True, "path": full, "bytes": len(content)})


@app.route("/sessions/<sid>/read", methods=["POST", "OPTIONS"])
def read_file(sid):
    if request.method == "OPTIONS":
        return ("", 204)
    err = require_auth()
    if err:
        return err
    with SESSIONS_LOCK:
        s = SESSIONS.get(sid)
    if not s:
        return jsonify({"error": "session not found"}), 404
    body = request.get_json(silent=True) or {}
    path = body.get("path", "")
    full = path if path.startswith("/") else os.path.join(s["cwd"], path)
    if not os.path.exists(full):
        return jsonify({"error": "not found"}), 404
    with open(full) as f:
        return jsonify({"content": f.read(), "path": full})


@app.route("/desktop", methods=["GET", "HEAD", "OPTIONS"])
@app.route("/desktop/<path:rest>", methods=["GET", "HEAD", "OPTIONS"])
def desktop_proxy(rest=""):
    """Reverse-proxy the sandbox's noVNC web UI (running on localhost:6080)
    through HF Spaces' single exposed port 7860 so the browser iframe can
    reach it. The AI is expected to have already started Xvfb + fluxbox +
    x11vnc + websockify inside the container via a bash command.
    """
    if request.method == "OPTIONS":
        return ("", 204)
    if AGENT_TOKEN:
        tok = request.args.get("token", "")
        if tok != AGENT_TOKEN:
            return jsonify({"error": "invalid token"}), 401
    try:
        import requests as _rq
    except ImportError:
        return jsonify({"error": "requests library missing — update agent-backend Dockerfile"}), 500
    target = "http://127.0.0.1:6080/" + (rest or "vnc_lite.html")
    # Pass through query string (minus our auth token)
    qs = {k: v for k, v in request.args.items() if k != "token"}
    try:
        r = _rq.get(target, params=qs, timeout=10, stream=True)
    except Exception as e:
        return jsonify({"error": "noVNC not running inside sandbox. Ask the AI to run: `Xvfb :0 -screen 0 1280x720x24 & fluxbox & x11vnc -display :0 -forever -nopw -shared -rfbport 5900 & websockify 6080 localhost:5900 &`. Detail: " + str(e)}), 502
    # Rewrite any absolute URLs in the HTML to stay under /desktop
    ct = r.headers.get("Content-Type", "application/octet-stream")
    body = r.content
    resp = Response(body, status=r.status_code, mimetype=ct)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


@app.route("/audio", methods=["GET", "OPTIONS"])
def audio_stream():
    """Stream the PulseAudio default sink's monitor as a continuous MP3.
    Browser <audio> element plays this URL directly. Uses ffmpeg as a
    one-shot encoder — Flask keeps the HTTP connection open and pipes
    stdout out in chunks until the client disconnects.
    """
    if request.method == "OPTIONS":
        return ("", 204)
    if AGENT_TOKEN:
        tok = request.args.get("token", "")
        if tok != AGENT_TOKEN:
            return jsonify({"error": "invalid token"}), 401

    import subprocess as _sp
    # The null sink created by start-desktop.sh exposes a monitor source
    # called "kemllm_sink.monitor". ffmpeg reads from it via the PulseAudio
    # input and encodes to MP3 at 128 kbps stereo 44.1 kHz.
    env = {
        "PULSE_SERVER": "unix:/tmp/pulse/native",
        "PULSE_RUNTIME_PATH": "/tmp/pulse",
        "HOME": "/home/agent",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
    }
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "pulse",
        "-i", "kemllm_sink.monitor",
        "-ac", "2",
        "-ar", "44100",
        "-c:a", "libmp3lame",
        "-b:a", "128k",
        "-f", "mp3",
        "-",
    ]
    try:
        proc = _sp.Popen(cmd, stdout=_sp.PIPE, stderr=_sp.DEVNULL, env=env, bufsize=0)
    except FileNotFoundError:
        return jsonify({"error": "ffmpeg not installed"}), 500
    except Exception as e:
        return jsonify({"error": "failed to start audio stream: " + str(e)}), 500

    def generate():
        try:
            while True:
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                yield chunk
        finally:
            try: proc.terminate()
            except Exception: pass
            try: proc.wait(timeout=2)
            except Exception:
                try: proc.kill()
                except Exception: pass

    resp = Response(generate(), mimetype="audio/mpeg")
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


@app.route("/sessions/<sid>/files/<path:filepath>", methods=["GET", "OPTIONS"])
def serve_file(sid, filepath):
    """Serve a file from the session directory so iframes can load it.
    Because iframes can't attach Authorization headers, auth here is via
    ?token=... query param (plus the session id is a random secret too).
    """
    if request.method == "OPTIONS":
        return ("", 204)
    if AGENT_TOKEN:
        tok = request.args.get("token", "")
        if tok != AGENT_TOKEN:
            return jsonify({"error": "invalid token"}), 401
    with SESSIONS_LOCK:
        s = SESSIONS.get(sid)
    if not s:
        return jsonify({"error": "session not found"}), 404
    full = filepath
    if not full.startswith("/"):
        full = os.path.join(s["cwd"], full)
    full = os.path.normpath(full)
    # Safety: only allow files inside the agent home
    if not full.startswith("/home/agent/"):
        return jsonify({"error": "path outside session"}), 403
    if not os.path.isfile(full):
        return jsonify({"error": "not a file"}), 404
    mime, _ = mimetypes.guess_type(full)
    with open(full, "rb") as f:
        data = f.read()
    resp = Response(data, mimetype=mime or "application/octet-stream")
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


@app.route("/sessions/<sid>", methods=["DELETE", "OPTIONS"])
def kill_session(sid):
    if request.method == "OPTIONS":
        return ("", 204)
    err = require_auth()
    if err:
        return err
    with SESSIONS_LOCK:
        SESSIONS.pop(sid, None)
    return jsonify({"ok": True})


def shell_quote(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"


if __name__ == "__main__":
    print(f"[kemllm-agent] listening on 0.0.0.0:{PORT}", flush=True)
    print(f"[kemllm-agent] auth: {'token required' if AGENT_TOKEN else 'OPEN MODE'}", flush=True)
    print(f"[kemllm-agent] endpoints: / /healthz /sessions /sessions/<id>/{{exec,read,write,files/<path>}} /desktop", flush=True)
    try:
        # threaded=True is important — single-threaded Flask blocks new
        # requests while a long /sessions/<id>/exec is running.
        # use_reloader=False — the reloader spawns a child process which
        # confuses HF Spaces' port detection.
        app.run(host="0.0.0.0", port=PORT, threaded=True, use_reloader=False, debug=False)
    except Exception as e:
        print(f"[kemllm-agent] FATAL: app.run failed: {e}", flush=True)
        traceback.print_exc()
        sys.exit(1)
