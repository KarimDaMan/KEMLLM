// ========== KEMLLM Agent Mode ==========
// Two backends, in priority order:
//   1. HF Spaces backend (real Ubuntu container, full bash + apt + sudo)
//      → user deploys agent-backend/ to a HF Space, pastes URL+token in Settings
//   2. Pyodide fallback (Python 3.12 in WebAssembly, in-browser)
//      → no setup, but limited to Python + emulated shell commands
//
// e2b was tried and abandoned: their REST API has no command execution
// endpoint; commands go through gRPC-web streaming to envd which a plain
// browser fetch() cannot call.
'use strict';

let agentPyodide = null;
let agentReady = false;
let agentBusy = false;
let agentMessages = [];
let agentBackend = 'pyodide'; // 'hf' or 'pyodide'
let agentSessionId = null;    // for HF backend

function agentLog(text, cls) {
  const term = document.getElementById('ag-term');
  if (!term) return null;
  const welcome = term.querySelector('.ag-welcome');
  if (welcome) welcome.remove();
  const div = document.createElement('div');
  div.className = 'ag-line ' + (cls || 'out');
  div.textContent = text;
  term.appendChild(div);
  term.scrollTop = term.scrollHeight;
  return div;
}

function agentLogHTML(html, cls) {
  const term = document.getElementById('ag-term');
  if (!term) return null;
  const welcome = term.querySelector('.ag-welcome');
  if (welcome) welcome.remove();
  const div = document.createElement('div');
  div.className = 'ag-line ' + (cls || 'out');
  div.innerHTML = html;
  term.appendChild(div);
  term.scrollTop = term.scrollHeight;
  return div;
}

function agentSetStatus(state) {
  const dot = document.getElementById('ag-status-dot');
  const label = document.getElementById('ag-status');
  const startBtn = document.getElementById('ag-start');
  const stopBtn = document.getElementById('ag-stop');
  const input = document.getElementById('ag-cmd');
  if (!dot || !label) return;
  dot.classList.toggle('on', state === 'running');
  label.textContent = state;
  if (state === 'running') {
    startBtn.style.display = 'none';
    stopBtn.style.display = 'inline-flex';
    if (input) { input.disabled = false; input.focus(); }
  } else {
    startBtn.style.display = 'inline-flex';
    stopBtn.style.display = 'none';
    if (input) input.disabled = (state === 'offline');
  }
}

// ===== HF backend helpers =====
function getHfBackendUrl() { return (profileGet('hf-backend-url') || '').trim().replace(/\/$/, ''); }
function getHfBackendToken() { return (profileGet('hf-backend-token') || '').trim(); }

async function hfFetch(path, init) {
  init = init || {};
  init.headers = init.headers || {};
  init.headers['Content-Type'] = 'application/json';
  const tok = getHfBackendToken();
  if (tok) init.headers['Authorization'] = 'Bearer ' + tok;
  const url = getHfBackendUrl() + path;
  return fetch(url, init);
}

// ===== Boot =====
async function agentStart() {
  if (agentBusy) return;
  agentBusy = true;

  const hfUrl = getHfBackendUrl();
  if (hfUrl) {
    // Real Linux backend
    agentBackend = 'hf';
    agentLog('› connecting to ' + hfUrl, 'sys');
    try {
      // Wake the Space if asleep
      const health = await hfFetch('/', { method: 'GET' });
      if (!health.ok) throw new Error('backend health check ' + health.status);
      const hd = await health.json();
      agentLog('  ✓ backend up · ' + (hd.service || 'kemllm-agent') + (hd.auth_required ? ' · token ok' : ' · OPEN MODE (no token)'), 'sys');
      const r = await hfFetch('/sessions', { method: 'POST', body: '{}' });
      if (!r.ok) {
        const t = await r.text();
        throw new Error('create session ' + r.status + ': ' + t.slice(0, 200));
      }
      const data = await r.json();
      agentSessionId = data.session_id;
      agentLog('✓ Ubuntu sandbox ready · session=' + agentSessionId, 'sys');
      agentLog('  shell=' + (data.shell || '/bin/bash') + ' · cwd=' + (data.cwd || '/home/agent') + ' · user=' + (data.user || 'agent'), 'sys');
      agentLog('  full bash · sudo · apt · pip · npm · git · curl · everything pre-installed', 'sys');
      agentLog('', 'sys');
      agentReady = true;
      agentSetStatus('running');
    } catch (e) {
      agentLog('✗ HF backend failed: ' + (e.message || e), 'err');
      agentLog('  falling back to Pyodide…', 'sys');
      await pyodideStart();
    } finally {
      agentBusy = false;
    }
    return;
  }
  // Pyodide fallback
  await pyodideStart();
  agentBusy = false;
}

async function pyodideStart() {
  agentBackend = 'pyodide';
  agentLog('› booting Python 3.12 sandbox (Pyodide WebAssembly)…', 'sys');
  agentLog('  (no HF backend configured — see Settings to enable real Linux)', 'sys');
  try {
    agentPyodide = await getPyodide();
    agentPyodide.runPython(`
import os, sys, json, io, shutil, pathlib, subprocess, datetime, math, random, re, urllib.request
_cwd = '/home/agent'
os.makedirs(_cwd, exist_ok=True)
os.chdir(_cwd)
`);
    await agentPyodide.loadPackage(['micropip']);
    agentLog('✓ Python sandbox ready', 'sys');
    agentLog('', 'sys');
    agentReady = true;
    agentSetStatus('running');
  } catch (e) {
    agentLog('✗ failed: ' + (e.message || e), 'err');
    agentSetStatus('error');
  }
}

async function agentStop() {
  if (agentBackend === 'hf' && agentSessionId) {
    try { await hfFetch('/sessions/' + agentSessionId, { method: 'DELETE' }); } catch {}
    agentSessionId = null;
    agentLog('› session destroyed', 'sys');
  } else if (agentPyodide) {
    try {
      agentPyodide.runPython(`
for _k in list(globals().keys()):
    if not _k.startswith('_') and _k not in ('os','sys','json','io','shutil','pathlib','subprocess','datetime','math','random','re','urllib'):
        del globals()[_k]
import shutil as _sh, os as _o
try:
    _sh.rmtree('/home/agent', ignore_errors=True)
    _o.makedirs('/home/agent', exist_ok=True)
    _o.chdir('/home/agent')
except Exception: pass
`);
    } catch {}
    agentLog('› sandbox state cleared', 'sys');
  }
  agentReady = false;
  agentSetStatus('offline');
}

function agentClear() {
  const term = document.getElementById('ag-term');
  if (term) term.innerHTML = '';
  agentMessages = [];
}

// ===== Run a command on whichever backend is active =====
async function agentRun(rawCmd, fromAgent, silent) {
  if (!rawCmd) return { stdout: '', stderr: '', exitCode: 0 };
  if (!agentReady) {
    if (!silent) agentLog('✗ sandbox not started — press Start', 'err');
    return { stdout: '', stderr: 'sandbox offline', exitCode: -1 };
  }
  if (!silent) {
    const prefix = fromAgent ? '[agent]$ ' : '$ ';
    agentLog(prefix + rawCmd, fromAgent ? 'agent-cmd' : 'cmd');
  }

  if (agentBackend === 'hf') {
    try {
      const r = await hfFetch('/sessions/' + agentSessionId + '/exec', {
        method: 'POST',
        body: JSON.stringify({ command: rawCmd })
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error('backend ' + r.status + ': ' + t.slice(0, 200));
      }
      const data = await r.json();
      const stdout = data.stdout || '';
      const stderr = data.stderr || '';
      const exitCode = data.exit_code || 0;
      if (!silent) {
        if (stdout) stdout.trimEnd().split('\n').forEach(l => agentLog(l, 'out'));
        if (stderr) stderr.trimEnd().split('\n').forEach(l => agentLog(l, 'err'));
        if (exitCode !== 0) agentLog('exit ' + exitCode, 'sys');
      }
      return { stdout, stderr, exitCode };
    } catch (e) {
      if (!silent) agentLog('✗ ' + e.message, 'err');
      return { stdout: '', stderr: e.message, exitCode: -1 };
    }
  }

  // Pyodide path
  if (!agentPyodide) {
    if (!silent) agentLog('✗ pyodide not loaded', 'err');
    return { stdout: '', stderr: 'no runtime', exitCode: -1 };
  }
  let stdout = '', stderr = '';
  agentPyodide.setStdout({ batched: (s) => { stdout += s + '\n'; } });
  agentPyodide.setStderr({ batched: (s) => { stderr += s + '\n'; } });
  let exitCode = 0;
  try {
    await agentPyodide.runPythonAsync(buildPythonFor(rawCmd));
  } catch (e) {
    stderr += (e.message || String(e)) + '\n';
    exitCode = 1;
  }
  agentPyodide.setStdout({ batched: () => {} });
  agentPyodide.setStderr({ batched: () => {} });
  if (!silent) {
    if (stdout) stdout.trimEnd().split('\n').forEach(l => agentLog(l, 'out'));
    if (stderr) stderr.trimEnd().split('\n').forEach(l => agentLog(l, 'err'));
    if (exitCode !== 0) agentLog('exit ' + exitCode, 'sys');
  }
  return { stdout, stderr, exitCode };
}

// Translate a shell-looking command into Python that Pyodide can run
function buildPythonFor(cmd) {
  const c = cmd.trim();
  // Multi-line or obvious Python → run as Python
  if (c.includes('\n') || /^(import |from |print\(|def |class |for |while |if |try:|with |async |await )/.test(c)) {
    return c;
  }
  // Parse first token
  const m = c.match(/^(\S+)(?:\s+(.*))?$/);
  if (!m) return c;
  const [, cmdName, restRaw] = m;
  const rest = (restRaw || '').trim();
  const args = splitArgs(rest);

  switch (cmdName) {
    case 'ls': {
      const path = args[args.length - 1] && !args[args.length - 1].startsWith('-') ? args[args.length - 1] : '.';
      return `import os\nfor _n in sorted(os.listdir(${pyStr(path)})):\n    print(_n)`;
    }
    case 'pwd':
      return `import os\nprint(os.getcwd())`;
    case 'cd': {
      const path = args[0] || '/home/agent';
      return `import os\nos.chdir(${pyStr(path)})\nprint(os.getcwd())`;
    }
    case 'cat':
      return args.map(f => `import sys\nsys.stdout.write(open(${pyStr(f)}).read())`).join('\n');
    case 'echo':
      return `print(${pyStr(rest)})`;
    case 'mkdir': {
      const paths = args.filter(a => !a.startsWith('-'));
      return `import os\nfor _p in [${paths.map(pyStr).join(',')}]:\n    os.makedirs(_p, exist_ok=True)`;
    }
    case 'rm': {
      const paths = args.filter(a => !a.startsWith('-'));
      const recursive = args.some(a => a.includes('r'));
      if (recursive) return `import shutil\nfor _p in [${paths.map(pyStr).join(',')}]:\n    shutil.rmtree(_p, ignore_errors=True)`;
      return `import os\nfor _p in [${paths.map(pyStr).join(',')}]:\n    try: os.remove(_p)\n    except FileNotFoundError: print(f'rm: {_p}: no such file')`;
    }
    case 'touch':
      return args.map(f => `open(${pyStr(f)}, 'a').close()`).join('\n');
    case 'cp': {
      const [src, dst] = args.filter(a => !a.startsWith('-'));
      return `import shutil\nshutil.copy(${pyStr(src)}, ${pyStr(dst)})`;
    }
    case 'mv': {
      const [src, dst] = args.filter(a => !a.startsWith('-'));
      return `import shutil\nshutil.move(${pyStr(src)}, ${pyStr(dst)})`;
    }
    case 'whoami':
      return `print('agent')`;
    case 'uname':
      return `print('Pyodide 0.26.2 · Python 3.12 · WebAssembly')`;
    case 'date':
      return `import datetime\nprint(datetime.datetime.now().isoformat())`;
    case 'env':
      return `import os\nfor k,v in os.environ.items(): print(f'{k}={v}')`;
    case 'python':
    case 'python3': {
      // python -c "code" or python file.py
      if (args[0] === '-c') return args.slice(1).join(' ').replace(/^["']|["']$/g, '');
      if (args[0]) return `exec(open(${pyStr(args[0])}).read())`;
      return `print('interactive python not available — type code directly')`;
    }
    case 'pip':
    case 'pip3': {
      if (args[0] === 'install') {
        const pkgs = args.slice(1).filter(a => !a.startsWith('-'));
        return `import micropip\nawait micropip.install([${pkgs.map(pyStr).join(',')}])\nprint('installed: ' + ', '.join([${pkgs.map(pyStr).join(',')}]))`;
      }
      if (args[0] === 'list') return `import micropip\nfor p in micropip.list(): print(p)`;
      return `print('pip: only install/list supported')`;
    }
    case 'curl':
    case 'wget': {
      const url = args.filter(a => !a.startsWith('-'))[0];
      return `from pyodide.http import pyfetch\n_r = await pyfetch(${pyStr(url)})\nprint(await _r.string())`;
    }
    case 'head': {
      const f = args[args.length - 1];
      const n = args.includes('-n') ? parseInt(args[args.indexOf('-n') + 1]) : 10;
      return `print('\\n'.join(open(${pyStr(f)}).read().splitlines()[:${n}]))`;
    }
    case 'tail': {
      const f = args[args.length - 1];
      const n = args.includes('-n') ? parseInt(args[args.indexOf('-n') + 1]) : 10;
      return `print('\\n'.join(open(${pyStr(f)}).read().splitlines()[-${n}:]))`;
    }
    case 'wc': {
      const f = args[args.length - 1];
      return `_t = open(${pyStr(f)}).read()\nprint(f'{len(_t.splitlines())} {len(_t.split())} {len(_t)} ${f}')`;
    }
    case 'grep': {
      const pat = args[0];
      const f = args[1];
      return `import re\nfor _l in open(${pyStr(f)}):\n    if re.search(${pyStr(pat)}, _l): print(_l, end='')`;
    }
    case 'clear':
      return `print('\\x1bc', end='')`;
    case 'sudo':
      return `print('sudo: no root in Pyodide sandbox — just run the command directly')`;
    case 'apt':
    case 'apt-get':
    case 'dpkg':
    case 'yum':
      return `print('${cmdName}: Pyodide has no apt — use pip install instead')`;
    default:
      // Fallback: try as raw Python
      return c;
  }
}
function pyStr(s) { return '"' + String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function splitArgs(s) {
  const out = [];
  let cur = '', inQ = null;
  for (const ch of s) {
    if (inQ) {
      if (ch === inQ) { inQ = null; continue; }
      cur += ch;
    } else if (ch === '"' || ch === "'") { inQ = ch; }
    else if (ch === ' ') { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// ===== Chat with the agent AI =====
function getAgentSystemPrompt() {
  const model = findModel(selectedChat, 'chat');
  const persona = (profileGet('persona') || '').trim();
  const name = model?.name || 'the KEMLLM Agent';
  let s = `You are ${name}, running inside KEMLLM Agent Mode.`;

  if (agentBackend === 'hf') {
    s += ' CRITICAL FACT: Right now, this second, you ARE connected to a real Ubuntu 22.04 Linux container. It is running. It is waiting for your commands. It is NOT simulated, it is NOT hypothetical, it is a real machine. Do not say you "cannot run commands" or "don\'t have access to a shell" — you literally do.';
    s += ' Pre-installed: bash, sudo (passwordless), apt, apt-get, pip3, python3, node, npm, git, curl, wget, vim, nano, jq, ripgrep, tree, build-essential, sqlite3. You can install anything else with `sudo apt-get install -y <pkg>` or `pip3 install <pkg>`. You have a persistent working directory that survives between commands in this session.';
    s += '\n\nTo run a command, write a fenced bash code block:\n```bash\nyour command here\n```\nMultiple bash blocks in one response are executed in order and the combined output is shown back to you. Working directory and shell state persist between blocks.';
    s += '\n\nFor apt installs always use `sudo apt-get install -y` (the `-y` is required, it\'s non-interactive). For Python use `pip3 install`. Avoid commands that need a TTY (top, htop, interactive vim/nano, ssh).';
    s += '\n\nWhen the user asks you to do something, actually DO it with a bash block. Do not describe what you would do — just run it. Do not apologize for being an AI. Do not add disclaimers about sandboxes. Just execute.';
  } else {
    s += ' Your runtime is a Python 3.12 sandbox powered by Pyodide (WebAssembly, in-browser). NO apt, NO sudo, NO real Linux. You have stdlib, virtual filesystem at /home/agent, and `micropip.install("pkg")` for pure-Python packages.';
    s += '\n\nUse fenced ```bash blocks (translated to Python under the hood: ls, cat, pwd, cd, echo, mkdir, rm, touch, cp, mv, head, tail, wc, grep, pip, curl) or ```python blocks (run directly). State persists across calls.';
    s += '\n\nIf the user asks for something requiring a real Linux box (apt install, system packages, browsers), tell them in ONE LINE to enable the real backend in Settings → Agent Backend.';
  }

  s += '\n\nYou share this sandbox with the user. The user can also type commands directly at the > prompt.';
  s += '\n\nStyle: Terse. Terminal. No bullet-point summaries. No filler like "Sure!", "Certainly!", "Great question!". Short direct sentences. If a task is impossible, say so in one line.';
  s += ' Do NOT pretend to run commands. Either actually run them via a code block, or say you cannot.';
  if (persona) s += '\n\nUser persona: ' + persona;
  return s;
}

async function agentChat(userMsg) {
  if (!agentReady) { agentLog('✗ start the sandbox first', 'err'); return; }
  const model = findModel(selectedChat, 'chat');
  if (!model) { agentLog('✗ no chat model selected', 'err'); return; }

  agentLog('> ' + userMsg, 'user');
  agentMessages.push({ role: 'user', content: userMsg });
  const thinkingEl = agentLog('…', 'sys');
  const agentSys = getAgentSystemPrompt();

  try {
    let full = '';
    await callChat(model, agentMessages, (chunk) => { full += chunk; }, agentSys);
    if (thinkingEl) thinkingEl.remove();
    renderAgentAIText(full);
    agentMessages.push({ role: 'assistant', content: full });

    const blocks = extractRunnableBlocks(full);
    if (blocks.length) {
      let combined = '';
      for (const b of blocks) {
        const r = await agentRun(b.content, true, false);
        combined += '\n$ ' + b.content + '\n' + (r.stdout || '') +
          (r.stderr ? '\n[stderr]\n' + r.stderr : '') +
          (r.exitCode ? `\n[exit ${r.exitCode}]` : '');
      }
      agentMessages.push({ role: 'user', content: '[execution results]\n' + combined.trim() });
      const typing2 = agentLog('…', 'sys');
      try {
        let more = '';
        await callChat(model, agentMessages, (chunk) => { more += chunk; }, agentSys);
        if (typing2) typing2.remove();
        renderAgentAIText(more);
        agentMessages.push({ role: 'assistant', content: more });
      } catch (e) {
        if (typing2) typing2.remove();
        agentLog('✗ ai error: ' + e.message, 'err');
      }
    }
  } catch (e) {
    if (thinkingEl) thinkingEl.remove();
    agentLog('✗ ai error: ' + e.message, 'err');
  }
}

function extractRunnableBlocks(md) {
  const blocks = [];
  const re = /```(bash|sh|shell|python|py)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const content = m[2].trim();
    if (content) blocks.push({ lang: m[1], content });
  }
  return blocks;
}

function renderAgentAIText(text) {
  const parts = text.split(/```(?:bash|sh|shell|python|py)\n[\s\S]*?```/);
  const prose = parts.join('').trim();
  if (!prose) return;
  prose.split('\n').forEach(line => {
    if (line.trim()) agentLog(line, 'ai');
    else agentLog('', 'ai');
  });
}

// ===== Preview pane (unchanged) =====
function agentPreviewShow(show) {
  const p = document.getElementById('ag-preview');
  if (p) p.classList.toggle('show', show);
}
function agentPreviewSet(urlOrPort) {
  const frame = document.getElementById('ag-preview-frame');
  const empty = document.getElementById('ag-preview-empty');
  if (!frame) return;
  let full = (urlOrPort || '').trim();
  if (!full) return;
  if (!full.startsWith('http')) return; // no sandbox host to route ports to
  frame.src = full;
  if (empty) empty.style.display = 'none';
  frame.style.display = 'block';
  agentPreviewShow(true);
}
function agentPreviewReload() {
  const frame = document.getElementById('ag-preview-frame');
  if (frame && frame.src && frame.src !== 'about:blank') frame.src = frame.src;
}
function agentPreviewFullscreen() {
  const p = document.getElementById('ag-preview');
  if (p) p.classList.toggle('fullscreen');
}

function setupAgentPanel() {
  const startBtn = document.getElementById('ag-start');
  const stopBtn = document.getElementById('ag-stop');
  const clearBtn = document.getElementById('ag-clear');
  const cmdInput = document.getElementById('ag-cmd');
  const previewToggle = document.getElementById('ag-preview-toggle');
  const previewUrl = document.getElementById('ag-preview-url');
  const previewReload = document.getElementById('ag-preview-reload');
  const previewFs = document.getElementById('ag-preview-fullscreen');
  if (!startBtn) return;
  startBtn.addEventListener('click', agentStart);
  stopBtn.addEventListener('click', agentStop);
  clearBtn.addEventListener('click', agentClear);
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const raw = cmdInput.value;
      if (!raw.trim()) return;
      cmdInput.value = '';
      if (raw.startsWith('!')) agentRun(raw.slice(1).trim(), false, false);
      else if (raw.startsWith('$ ')) agentRun(raw.slice(2).trim(), false, false);
      else agentChat(raw.trim());
    }
  });
  previewToggle?.addEventListener('click', () => {
    const p = document.getElementById('ag-preview');
    if (p) p.classList.toggle('show');
  });
  previewUrl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') agentPreviewSet(previewUrl.value);
  });
  previewReload?.addEventListener('click', agentPreviewReload);
  previewFs?.addEventListener('click', agentPreviewFullscreen);
  agentSetStatus('offline');
}


