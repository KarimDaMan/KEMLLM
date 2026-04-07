"""
KEMLLM Agent Backend
====================
A tiny Flask service that exposes a real Linux shell over REST.

Designed to run on Hugging Face Spaces (Docker SDK) but works anywhere
that can run a Docker container.

Endpoints
---------
GET    /                     → health/status
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
import subprocess
import secrets
import time
import threading
import signal
from flask import Flask, request, jsonify
from flask_cors import CORS

AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "").strip()
PORT = int(os.environ.get("PORT", "7860"))
SESSION_TIMEOUT = 60 * 30  # 30 minutes idle → kill session
EXEC_TIMEOUT = 120         # per-command timeout

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}}, expose_headers=["*"])

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


@app.route("/", methods=["GET"])
def health():
    return jsonify({
        "service": "kemllm-agent-backend",
        "ok": True,
        "auth_required": bool(AGENT_TOKEN),
        "active_sessions": len(SESSIONS),
    })


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
    print(f"KEMLLM Agent Backend listening on :{PORT}")
    print(f"Auth: {'token required' if AGENT_TOKEN else 'OPEN MODE — set AGENT_TOKEN env var'}")
    app.run(host="0.0.0.0", port=PORT, threaded=True)
