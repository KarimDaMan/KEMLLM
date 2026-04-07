// ========== KEMLLM Agent Mode ==========
// A terminal-styled chat with a real Linux sandbox (e2b).
// Chat with the AI normally — it has shell access and can run commands.
// User can run commands directly by prefixing with "!" or just typing them
// as a question and letting the AI decide.
'use strict';

const E2B_BASE = 'https://kemllmx.karimghannam2014.workers.dev/e2b';
const E2B_DIRECT = 'https://api.e2b.dev';

let agentSandboxId = null;
let agentBusy = false;
let agentMessages = []; // conversation with the AI

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
  return fetch(E2B_DIRECT + path, init);
}

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

let agentTemplate = 'base';

function agentSandboxHost() {
  // e2b sandboxes are reachable at https://<port>-<sandboxId>.e2b.dev/
  return agentSandboxId ? agentSandboxId : null;
}

async function agentStart() {
  if (!getE2BKey()) {
    agentLog('✗ Add your e2b API key in Settings first. Get one free at e2b.dev/dashboard.', 'err');
    siNav('settings');
    return;
  }
  if (agentBusy) return;
  agentBusy = true;
  const tplSel = document.getElementById('ag-template');
  agentTemplate = (tplSel && tplSel.value) || 'base';
  agentLog('› booting ' + agentTemplate + ' sandbox…', 'sys');
  try {
    const res = await e2bFetch('/sandboxes', {
      method: 'POST',
      body: JSON.stringify({ templateID: agentTemplate })
    });
    if (!res.ok) throw new Error('e2b ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const data = await res.json();
    agentSandboxId = data.sandboxID || data.id;
    agentLog('✓ sandbox ready · id=' + agentSandboxId + ' · template=' + agentTemplate, 'sys');
    agentLog('  hostname template: https://<port>-' + agentSandboxId + '.e2b.dev/', 'sys');
    agentLog('', 'sys');
    agentSetStatus('running');
    // If desktop template, auto-load the preview
    if (agentTemplate === 'desktop') {
      agentPreviewSet(':6080');
      agentPreviewShow(true);
    }
  } catch (e) {
    agentLog('✗ failed: ' + e.message, 'err');
    agentSetStatus('error');
  } finally {
    agentBusy = false;
  }
}

// ===== Preview pane =====
function agentPreviewShow(show) {
  const p = document.getElementById('ag-preview');
  if (!p) return;
  p.classList.toggle('show', show);
}
function agentPreviewSet(urlOrPort) {
  const frame = document.getElementById('ag-preview-frame');
  const empty = document.getElementById('ag-preview-empty');
  if (!frame || !agentSandboxId) return;
  let full;
  const s = (urlOrPort || '').trim();
  if (!s) return;
  if (s.startsWith('http://') || s.startsWith('https://')) {
    full = s;
  } else if (s.startsWith(':')) {
    const port = s.slice(1).split('/')[0];
    const rest = s.slice(1 + port.length) || '/';
    full = `https://${port}-${agentSandboxId}.e2b.dev${rest}`;
  } else if (s.startsWith('/')) {
    full = `https://3000-${agentSandboxId}.e2b.dev${s}`;
  } else {
    full = `https://${s}-${agentSandboxId}.e2b.dev/`;
  }
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
  if (!p) return;
  p.classList.toggle('fullscreen');
}

async function agentStop() {
  if (!agentSandboxId) { agentSetStatus('offline'); return; }
  agentLog('› stopping sandbox…', 'sys');
  try {
    await e2bFetch('/sandboxes/' + agentSandboxId, { method: 'DELETE' });
    agentLog('✓ stopped', 'sys');
  } catch (e) {
    agentLog('✗ ' + e.message, 'err');
  }
  agentSandboxId = null;
  agentSetStatus('offline');
}

function agentClear() {
  const term = document.getElementById('ag-term');
  if (term) term.innerHTML = '';
  agentMessages = [];
}

// ========== Shell command execution ==========
async function agentRun(cmd, fromAgent, silent) {
  if (!cmd) return { stdout: '', stderr: '', exitCode: -1 };
  if (!agentSandboxId) {
    if (!silent) agentLog('✗ sandbox not running — press Start', 'err');
    return { stdout: '', stderr: 'sandbox offline', exitCode: -1 };
  }
  if (!silent) {
    const prefix = fromAgent ? '[agent]$ ' : '$ ';
    agentLog(prefix + cmd, fromAgent ? 'agent-cmd' : 'cmd');
  }
  try {
    const res = await e2bFetch('/sandboxes/' + agentSandboxId + '/processes', {
      method: 'POST',
      body: JSON.stringify({
        cmd: 'bash',
        args: ['-lc', cmd],
        envs: {},
        cwd: '/home/user'
      })
    });
    if (!res.ok) throw new Error('e2b ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    if (!silent) {
      if (data.stdout) data.stdout.trimEnd().split('\n').forEach(l => agentLog(l, 'out'));
      if (data.stderr) data.stderr.trimEnd().split('\n').forEach(l => agentLog(l, 'err'));
      if (data.exitCode && data.exitCode !== 0) agentLog('exit ' + data.exitCode, 'sys');
    }
    return { stdout: data.stdout || '', stderr: data.stderr || '', exitCode: data.exitCode || 0 };
  } catch (e) {
    if (!silent) agentLog('✗ ' + e.message, 'err');
    return { stdout: '', stderr: e.message, exitCode: -1 };
  }
}

// ========== Chat with the agent AI ==========
function getAgentSystemPrompt() {
  const model = findModel(selectedChat, 'chat');
  const persona = (profileGet('persona') || '').trim();
  const name = model?.name || 'the KEMLLM Agent';
  let s = `You are ${name}, running inside KEMLLM Agent Mode.`;
  s += ' IMPORTANT: You have direct access to a real Linux sandbox VM (Ubuntu, provided by e2b.dev). This is YOUR OWN COMPUTER. You can run ANY shell command in it to accomplish tasks: inspect the filesystem, install packages with apt or pip, write and execute scripts, fetch URLs with curl, edit files, compile code, anything a real Linux machine can do. The sandbox is already running and ready.';
  s += '\n\nTo run a command, write a fenced bash code block:\n```bash\nyour command here\n```\nYou may include multiple bash blocks in a single response; they execute in order and the combined output is shown back to you as a follow-up message so you can continue.';
  s += '\n\nYou share this machine with the user. The user can also type commands directly at the terminal. Treat it as a shared workspace.';
  s += '\n\nStyle: Be terse. This is a terminal. No bullet-point summaries. No filler words like "Sure!", "Certainly!", or "Great question!". Short direct sentences. When a task is done, say so in one line. Do not ask permission before running non-destructive commands — just run them.';
  s += '\n\nDo NOT pretend to run commands. Either actually run them via a bash block, or explicitly say you cannot.';
  if (persona) s += '\n\nUser persona: ' + persona;
  return s;
}

async function agentChat(userMsg) {
  if (!agentSandboxId) {
    agentLog('✗ start the sandbox first', 'err');
    return;
  }
  const model = findModel(selectedChat, 'chat');
  if (!model) { agentLog('✗ no chat model selected', 'err'); return; }

  // Log user message
  agentLog('> ' + userMsg, 'user');
  agentMessages.push({ role: 'user', content: userMsg });

  // Show thinking indicator
  const thinkingEl = agentLog('…', 'sys');

  const agentSys = getAgentSystemPrompt();
  try {
    let full = '';
    await callChat(model, agentMessages, (chunk) => { full += chunk; }, agentSys);
    if (thinkingEl) thinkingEl.remove();

    // Render AI text
    renderAgentAIText(full);
    agentMessages.push({ role: 'assistant', content: full });

    // Auto-execute any bash code blocks
    const blocks = extractBashBlocks(full);
    if (blocks.length) {
      let combined = '';
      for (const b of blocks) {
        const r = await agentRun(b, true, false);
        combined += '\n$ ' + b + '\n' + (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '') + (r.exitCode ? `\n[exit ${r.exitCode}]` : '');
      }
      // Feed results back to AI for a follow-up response
      agentMessages.push({ role: 'user', content: '[execution results]\n' + combined.trim() });
      const typing2 = agentLog('…', 'sys');
      try {
        let more = '';
        await callChat(model, agentMessages, (chunk) => { more += chunk; }, agentSys);
        if (typing2) typing2.remove();
        renderAgentAIText(more);
        agentMessages.push({ role: 'assistant', content: more });
        // Recursive: if that response also has bash blocks, run them (up to 3 rounds)
        // Skipped for now to keep it single-pass per spec
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

function extractBashBlocks(md) {
  const blocks = [];
  const re = /```(?:bash|sh|shell)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const cmd = m[1].trim();
    if (cmd) blocks.push(cmd);
  }
  return blocks;
}

function renderAgentAIText(text) {
  // Strip bash code blocks (they'll be run separately) and render the prose
  // and any remaining text as terminal lines.
  const parts = text.split(/```(?:bash|sh|shell)\n[\s\S]*?```/);
  const prose = parts.join('').trim();
  if (!prose) return;
  prose.split('\n').forEach(line => {
    if (line.trim()) agentLog(line, 'ai');
    else agentLog('', 'ai');
  });
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
