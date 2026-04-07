// ========== KEMLLM Agent Mode (e2b sandbox) ==========
'use strict';

// e2b sandbox goes through the Cloudflare worker /e2b proxy that already
// exists on kemllmx. The worker forwards to api.e2b.dev and passes the
// X-API-Key header through.
const E2B_BASE = 'https://kemllmx.karimghannam2014.workers.dev/e2b';
const E2B_DIRECT = 'https://api.e2b.dev';

let agentSandboxId = null;
let agentBusy = false;

function getE2BKey() { return profileGet('key-e2b') || ''; }

async function e2bFetch(path, init) {
  init = init || {};
  init.headers = init.headers || {};
  init.headers['X-API-Key'] = getE2BKey();
  init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
  try {
    const r = await fetch(E2B_BASE + path, init);
    if (r.ok || r.status < 500) return r;
  } catch {}
  // Direct fallback (may hit CORS)
  return fetch(E2B_DIRECT + path, init);
}

function agentLog(text, cls) {
  const term = document.getElementById('ag-term');
  if (!term) return;
  // Clear welcome on first write
  const welcome = term.querySelector('.ag-welcome');
  if (welcome) welcome.remove();
  const div = document.createElement('div');
  div.className = 'ag-line ' + (cls || 'out');
  div.textContent = text;
  term.appendChild(div);
  term.scrollTop = term.scrollHeight;
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
    if (input) input.disabled = false;
  } else {
    startBtn.style.display = 'inline-flex';
    stopBtn.style.display = 'none';
    if (input) input.disabled = true;
  }
}

async function agentStart() {
  if (!getE2BKey()) {
    agentLog('✗ Add your e2b API key in Settings first. Get one free at e2b.dev/dashboard.', 'err');
    siNav('settings');
    return;
  }
  if (agentBusy) return;
  agentBusy = true;
  agentLog('› Booting Linux sandbox…', 'sys');
  try {
    const res = await e2bFetch('/sandboxes', {
      method: 'POST',
      body: JSON.stringify({ templateID: 'base' })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error('e2b ' + res.status + ': ' + t.slice(0, 200));
    }
    const data = await res.json();
    agentSandboxId = data.sandboxID || data.id;
    agentLog('✓ Sandbox ready (' + agentSandboxId + ')', 'sys');
    agentLog('You and the AI share this shell. Try: whoami, ls -la, cat /etc/os-release', 'sys');
    agentSetStatus('running');
  } catch (e) {
    agentLog('✗ Failed to start sandbox: ' + e.message, 'err');
    agentSetStatus('error');
  } finally {
    agentBusy = false;
  }
}

async function agentStop() {
  if (!agentSandboxId) { agentSetStatus('offline'); return; }
  agentLog('› Stopping sandbox…', 'sys');
  try {
    await e2bFetch('/sandboxes/' + agentSandboxId, { method: 'DELETE' });
    agentLog('✓ Sandbox stopped', 'sys');
  } catch (e) {
    agentLog('✗ Error stopping: ' + e.message, 'err');
  }
  agentSandboxId = null;
  agentSetStatus('offline');
}

function agentClear() {
  const term = document.getElementById('ag-term');
  if (term) term.innerHTML = '';
}

async function agentRun(cmd, fromAgent) {
  if (!cmd) return;
  if (!agentSandboxId) {
    agentLog('✗ Sandbox not running. Press Start sandbox first.', 'err');
    return;
  }
  const prefix = fromAgent ? '[agent] $ ' : '$ ';
  agentLog(prefix + cmd, fromAgent ? 'agent' : 'cmd');
  try {
    // e2b process API: POST /sandboxes/{id}/processes
    const res = await e2bFetch('/sandboxes/' + agentSandboxId + '/processes', {
      method: 'POST',
      body: JSON.stringify({
        cmd: 'bash',
        args: ['-lc', cmd],
        envs: {},
        cwd: '/home/user'
      })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error('e2b ' + res.status + ': ' + t.slice(0, 300));
    }
    const data = await res.json();
    if (data.stdout) agentLog(data.stdout.trimEnd(), 'out');
    if (data.stderr) agentLog(data.stderr.trimEnd(), 'err');
    if (data.exitCode !== 0 && data.exitCode != null) {
      agentLog('exit ' + data.exitCode, 'sys');
    }
    return data;
  } catch (e) {
    agentLog('✗ ' + e.message, 'err');
    return { stdout: '', stderr: e.message, exitCode: -1 };
  }
}

function setupAgentPanel() {
  const startBtn = document.getElementById('ag-start');
  const stopBtn = document.getElementById('ag-stop');
  const clearBtn = document.getElementById('ag-clear');
  const cmdInput = document.getElementById('ag-cmd');
  if (!startBtn) return;
  startBtn.addEventListener('click', agentStart);
  stopBtn.addEventListener('click', agentStop);
  clearBtn.addEventListener('click', agentClear);
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const cmd = cmdInput.value.trim();
      if (cmd) {
        cmdInput.value = '';
        agentRun(cmd, false);
      }
    }
  });
  agentSetStatus('offline');
}
