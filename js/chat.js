// ========== KEMLLM Chat System ==========
'use strict';

let messages = [];
let currentChatId = null;
let pendingAttachments = []; // {dataUrl, name}
let abortCtrl = null;
window.webSearchOn = false;
let chatMode = 'chat'; // 'chat' | 'code' | 'agent'
let agentUnlocked = false;

// Agent loop state — lets the AI keep running autonomously until the task
// is done, while the user can inject additional instructions mid-loop.
let agentLoopRunning = false;
let agentLoopAbort = false;
let agentInjectQueue = []; // messages the user types while the loop is running
const AGENT_LOOP_MAX_ITERATIONS = 25;

function setChatMode(mode) {
  // Agent mode is gated: user must have a backend OR explicitly enable Pyodide
  if (mode === 'agent' && !agentUnlocked) {
    const hasBackend = (profileGet('hf-backend-url') || '').trim();
    if (!hasBackend) {
      showToast('Agent mode uses Pyodide (no Linux backend). Set one in Settings for the real thing.');
    }
    agentUnlocked = true;
  }
  chatMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  const lock = document.getElementById('mode-agent-lock');
  if (lock) lock.style.display = agentUnlocked ? 'none' : '';
  const input = document.getElementById('input-text');
  if (input) {
    input.placeholder = mode === 'agent'
      ? 'Agent mode · ask the AI to run commands in a sandbox'
      : mode === 'code'
      ? 'Code mode · ask for code, auto-runs in browser'
      : 'Ask anything, generate images, run code...';
  }
  // If switching to agent, make sure backend is primed
  if (mode === 'agent' && !agentReady) {
    agentStart();
  }
}

const IMG_REGEX = /\b(generate|make|create|draw|render|paint|show|produce)\b.{0,30}\b(image|picture|photo|illustration|art|artwork|wallpaper|logo|portrait|landscape|painting)\b/i;
const VID_REGEX = /\b(generate|make|create|render|animate|produce)\b.{0,30}\b(video|animation|clip|footage|movie|film)\b/i;

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function parseMarkdown(md) {
  if (!md) return '';
  let html = md;
  // Code blocks first
  const blocks = [];
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (m, lang, code) => {
    const idx = blocks.length;
    blocks.push({ lang: lang || '', code });
    return `\u0000CODE${idx}\u0000`;
  });
  // Inline code
  const inlines = [];
  html = html.replace(/`([^`\n]+)`/g, (m, c) => {
    const idx = inlines.length;
    inlines.push(c);
    return `\u0000INL${idx}\u0000`;
  });
  // Escape
  html = escapeHTML(html);
  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold/italic/strike
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Lists
  html = html.replace(/^(?:- |\* )(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>' + m + '</ul>');
  html = html.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');
  html = html.replace(/(<oli>.*<\/oli>\n?)+/g, m => '<ol>' + m.replace(/oli/g, 'li') + '</ol>');
  // Paragraphs
  html = html.split(/\n\n+/).map(p => {
    if (/^<(h\d|ul|ol|blockquote|pre)/.test(p.trim())) return p;
    return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
  }).join('');
  // Restore inline code
  html = html.replace(/\u0000INL(\d+)\u0000/g, (m, i) => `<code>${escapeHTML(inlines[+i])}</code>`);
  // Restore code blocks
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (m, i) => {
    const b = blocks[+i];
    const id = 'cb_' + Math.random().toString(36).slice(2, 9);
    const runBtn = isRunnable(b.lang) ? `<button class="code-act" onclick="runCodeBlock('${id}','${escapeHTML(b.lang)}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>Run</button>` : '';
    const agentBtn = (/^(bash|sh|shell)$/i.test(b.lang)) ? `<button class="code-act" onclick="runInAgent('${id}')" title="Run in Agent sandbox"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>Agent</button>` : '';
    return `<pre><div class="codewrap" data-lang="${escapeHTML(b.lang)}"><div class="code-head"><span class="code-lang">${escapeHTML(b.lang || 'text')}</span><div class="code-acts"><button class="code-act" onclick="copyCode('${id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</button>${runBtn}${agentBtn}</div></div><code id="${id}">${escapeHTML(b.code)}</code></div></pre>`;
  });
  return html;
}

function copyCode(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent);
  showToast('Copied');
}

function runInAgent(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const cmd = el.textContent;
  siNav('agent');
  if (!agentSandboxId) {
    agentLog('› Pending: starting sandbox first…', 'sys');
    agentStart().then(() => { if (agentSandboxId) agentRun(cmd, true); });
  } else {
    agentRun(cmd, true);
  }
}

function isRunnable(lang) {
  return ['python', 'py', 'javascript', 'js', 'typescript', 'ts', 'c', 'cpp', 'c++', 'rust', 'rs', 'go', 'java', 'csharp', 'cs', 'bash', 'sh', 'lua'].includes((lang || '').toLowerCase());
}

async function runCodeBlock(id, lang) {
  const el = document.getElementById(id);
  if (!el) return;
  const code = el.textContent;
  const wrap = el.closest('.codewrap');
  let result = wrap.querySelector('.run-result');
  if (!result) {
    result = document.createElement('div');
    result.className = 'run-result';
    wrap.appendChild(result);
  }
  result.innerHTML = `<div class="run-result-head"><span class="td"></span><span class="td"></span><span class="td"></span> Running...</div>`;
  try {
    const start = Date.now();
    const out = await runViaPiston(lang, code);
    const ms = Date.now() - start;
    const stdout = out.run?.stdout || '';
    const stderr = out.run?.stderr || '';
    result.innerHTML = `<div class="run-result-head">▶ Ran ${escapeHTML(lang)} · ${ms}ms</div><div class="run-result-out${stderr ? ' err' : ''}">${escapeHTML(stdout || stderr || '(no output)')}</div>`;
  } catch (e) {
    result.innerHTML = `<div class="run-result-head">Error</div><div class="run-result-out err">${escapeHTML(e.message)}</div>`;
  }
}

function renderUserMessage(text, attachments) {
  const msgs = document.getElementById('msgs');
  const div = document.createElement('div');
  div.className = 'msg msg-u';
  let imgHtml = '';
  if (attachments && attachments.length) {
    imgHtml = '<div style="display:flex;gap:6px;justify-content:flex-end;margin-bottom:6px;flex-wrap:wrap;">' +
      attachments.map(a => `<img src="${a.dataUrl}" style="max-width:180px;max-height:180px;border-radius:10px;border:1px solid var(--border2);">`).join('') +
      '</div>';
  }
  div.innerHTML = imgHtml + `<div class="bubble">${escapeHTML(text)}</div>`;
  msgs.appendChild(div);
  scrollToBottom();
}

function renderAIMessage(model, contentHTML, rawText) {
  const msgs = document.getElementById('msgs');
  const div = document.createElement('div');
  div.className = 'msg msg-a';
  const color = PROVIDER_COLORS[model.provider] || PROVIDER_COLORS.custom;
  const raw = rawText || '';
  div.dataset.raw = raw;
  div.innerHTML = `
    <div class="ai-dot" style="background:${color}"></div>
    <div class="ai-body">
      <div class="ai-tag">${escapeHTML(model.name)}</div>
      <div class="ai-txt">${contentHTML}</div>
      <div class="msg-actions">
        <button class="msg-act" onclick="copyAIMessage(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</button>
        <button class="msg-act" onclick="regenerateMessage()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Regenerate</button>
      </div>
    </div>`;
  msgs.appendChild(div);
  scrollToBottom();
  return div;
}

function copyAIMessage(btn) {
  const msgEl = btn.closest('.msg-a');
  const text = msgEl?.dataset.raw || msgEl?.querySelector('.ai-txt')?.innerText || '';
  navigator.clipboard.writeText(text);
  showToast('Copied');
}

function regenerateMessage() {
  // Pop last assistant message, re-send
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { messages.splice(i, 1); break; }
  }
  const lastAI = document.querySelector('#msgs .msg-a:last-child');
  if (lastAI) lastAI.remove();
  const last = messages[messages.length - 1];
  if (last?.role === 'user') {
    messages.pop();
    document.querySelectorAll('#msgs .msg-u').forEach((el, i, arr) => {
      if (i === arr.length - 1) el.remove();
    });
    const input = document.getElementById('input-text');
    input.value = typeof last.content === 'string' ? last.content : '';
    sendMessage();
  }
}

function renderTyping(model) {
  const msgs = document.getElementById('msgs');
  const div = document.createElement('div');
  div.className = 'msg msg-a';
  div.id = 'typing-msg';
  const color = PROVIDER_COLORS[model.provider] || PROVIDER_COLORS.custom;
  div.innerHTML = `<div class="ai-dot" style="background:${color}"></div><div class="ai-body"><div class="ai-tag">${escapeHTML(model.name)}</div><div class="typing"><div class="td"></div><div class="td"></div><div class="td"></div></div></div>`;
  msgs.appendChild(div);
  scrollToBottom();
  return div;
}

function scrollToBottom() {
  const a = document.getElementById('chat-area');
  if (a) a.scrollTop = a.scrollHeight;
}

async function sendMessage() {
  const input = document.getElementById('input-text');
  const text = input.value.trim();
  if (!text && !pendingAttachments.length) return;
  input.value = '';
  input.style.height = 'auto';

  // Hide terminal animation forever
  const home = document.getElementById('home-screen');
  if (home) home.classList.add('hidden');
  if (window.termBootStop) window.termBootStop();

  const atts = pendingAttachments.slice();
  pendingAttachments = [];
  renderAttachPreview();

  // AGENT MODE: route through the agent flow
  if (chatMode === 'agent') {
    // If the loop is already running, queue the message as an interjection
    // — it'll be merged into the next AI call, and the loop keeps running.
    if (agentLoopRunning) {
      renderUserMessage(text, atts);
      agentInjectQueue.push(text);
      renderSystemLine('✎ queued — will inject on next iteration');
      return;
    }
    renderUserMessage(text, atts);
    messages.push({ role: 'user', content: text });
    await runAgentModeChat(text);
    saveCurrentChat();
    return;
  }

  const userMsg = atts.length
    ? { role: 'user', content: text, attachments: atts }
    : { role: 'user', content: text };
  messages.push(userMsg);
  renderUserMessage(text, atts);

  // Image/video routing ONLY when no attachments. If the user attached
  // an image, they want vision (chat with image context), not generation.
  if (!atts.length) {
    if (IMG_REGEX.test(text)) {
      return handleImageRequest(text);
    }
    if (VID_REGEX.test(text)) {
      return handleVideoRequest(text);
    }
  }

  const model = findModel(selectedChat, 'chat');
  if (!model) { showToast('No model selected'); return; }

  const typingEl = renderTyping(model);

  try {
    let full = '';
    await callChat(model, messages, (chunk, done) => {
      full += chunk;
    });
    typingEl.remove();
    messages.push({ role: 'assistant', content: full });

    // Claude.ai-style autonomous code execution: if the AI wrote a runnable
    // code block, auto-run it, show the analysis, then let the AI respond
    // once with the result in mind.
    const runnable = extractFirstRunnableBlock(full);
    if (runnable) {
      const aiEl = renderAIMessage(model, parseMarkdown(full));
      const analysisEl = await runAnalysisBlock(aiEl, runnable);
      if (analysisEl) {
        const typing2 = renderTyping(model);
        try {
          const followup = [...messages, {
            role: 'user',
            content: `[code execution result]\n\nStdout:\n${analysisEl.stdout || '(empty)'}${analysisEl.stderr ? `\n\nStderr:\n${analysisEl.stderr}` : ''}\n\nPlease use this result in your explanation. Do not rewrite the same code unless there was an error.`
          }];
          let more = '';
          await callChat(model, followup, (chunk) => { more += chunk; });
          typing2.remove();
          renderAIMessage(model, parseMarkdown(more));
          messages.push({ role: 'assistant', content: more });
        } catch (e) {
          typing2.remove();
        }
      }
    } else {
      renderAIMessage(model, parseMarkdown(full));
    }

    saveCurrentChat();
  } catch (e) {
    typingEl.remove();
    renderAIMessage(model, `<p style="color:var(--red)">${escapeHTML(e.message)}</p>`);
  }
}

function extractFirstRunnableBlock(md) {
  const re = /```(\w+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const lang = (m[1] || '').toLowerCase();
    if (isRunnable(lang)) return { lang, code: m[2] };
  }
  return null;
}

async function runAnalysisBlock(aiEl, block) {
  const body = aiEl.querySelector('.ai-body');
  if (!body) return null;
  const det = document.createElement('details');
  det.className = 'think-block';
  det.open = true;
  det.innerHTML = `<summary>▶ Running ${escapeHTML(block.lang)}…</summary><div class="think-inner">executing via Piston sandbox</div>`;
  body.appendChild(det);
  scrollToBottom();
  try {
    const start = Date.now();
    const out = await runViaPiston(block.lang, block.code);
    const ms = Date.now() - start;
    const stdout = out.run?.stdout || '';
    const stderr = out.run?.stderr || '';
    const exit = out.run?.code;
    det.querySelector('summary').textContent = `▶ Ran ${block.lang} · ${ms}ms · exit ${exit}`;
    det.querySelector('.think-inner').innerHTML =
      (stdout ? `<div style="color:#cbd5e1;">${escapeHTML(stdout)}</div>` : '') +
      (stderr ? `<div style="color:var(--red);margin-top:6px;">${escapeHTML(stderr)}</div>` : '') +
      (!stdout && !stderr ? '<div style="color:var(--text3);">(no output)</div>' : '');
    setTimeout(() => { det.open = false; }, 800);
    return { stdout, stderr, exit };
  } catch (e) {
    det.querySelector('summary').textContent = '▶ Execution error';
    det.querySelector('.think-inner').innerHTML = `<div style="color:var(--red);">${escapeHTML(e.message)}</div>`;
    return { stdout: '', stderr: e.message, exit: -1 };
  }
}

async function handleImageRequest(prompt) {
  const m = findModel(selectedImage, 'image');
  const fakeModel = { name: m?.name || 'Image', provider: 'google' };
  const typingEl = renderTyping(fakeModel);
  try {
    const url = await generateImage(prompt);
    typingEl.remove();
    renderAIMessage(fakeModel, `<p>Generated with ${escapeHTML(m.name)}:</p><img src="${escapeHTML(url)}" alt="generated">`);
    messages.push({ role: 'assistant', content: `[image: ${url}]` });
    saveCurrentChat();
  } catch (e) {
    typingEl.remove();
    renderAIMessage(fakeModel, `<p style="color:var(--red)">${escapeHTML(e.message)}</p>`);
  }
}
async function handleVideoRequest(prompt) {
  const m = findModel(selectedVideo, 'video');
  const fakeModel = { name: m?.name || 'Video', provider: 'google' };
  const typingEl = renderTyping(fakeModel);
  try {
    const url = await generateVideo(prompt);
    typingEl.remove();
    renderAIMessage(fakeModel, `<p>Generated with ${escapeHTML(m.name)}:</p><video controls loop src="${escapeHTML(url)}"></video>`);
    messages.push({ role: 'assistant', content: `[video: ${url}]` });
    saveCurrentChat();
  } catch (e) {
    typingEl.remove();
    renderAIMessage(fakeModel, `<p style="color:var(--red)">${escapeHTML(e.message)}</p>`);
  }
}

// Agent mode — autonomous loop that keeps running until:
//   1. the AI's response has no more bash/python blocks (task done)
//   2. we hit AGENT_LOOP_MAX_ITERATIONS
//   3. the user presses the stop button (sets agentLoopAbort = true)
// While it's running, the user can type new messages that get queued
// and merged into the next AI call, so you can steer the agent mid-task
// without interrupting it.
async function runAgentModeChat(userText) {
  // Pre-set backend so the AI's first-turn system prompt reflects reality
  if (profileGet('hf-backend-url')) agentBackend = 'hf';
  if (!agentReady) {
    showToast('Starting sandbox…');
    await agentStart();
    if (!agentReady) {
      const model = findModel(selectedChat, 'chat');
      renderAIMessage(model || { name: 'Agent', provider: 'custom' },
        '<p style="color:var(--red)">Could not start agent sandbox. Check Settings → Agent Backend URL and token.</p>');
      return;
    }
  }
  const model = findModel(selectedChat, 'chat');
  if (!model) { showToast('No model selected'); return; }
  const agentSys = getAgentSystemPrompt();

  // Set loop state
  agentLoopRunning = true;
  agentLoopAbort = false;
  setAgentLoopUI(true);

  try {
    for (let iter = 0; iter < AGENT_LOOP_MAX_ITERATIONS; iter++) {
      if (agentLoopAbort) { renderSystemLine('⏹ stopped by user'); break; }

      // Inject any user messages that came in while we were running
      if (agentInjectQueue.length) {
        const extra = agentInjectQueue.splice(0).join('\n');
        messages.push({ role: 'user', content: '[user interjection] ' + extra });
        renderSystemLine('✎ user added: ' + extra);
      }

      const typingEl = renderTyping(model);
      let full = '';
      try {
        await callChat(model, messages, (chunk) => { full += chunk; }, agentSys);
      } catch (e) {
        typingEl.remove();
        renderAIMessage(model, `<p style="color:var(--red)">${escapeHTML(e.message)}</p>`);
        break;
      }
      typingEl.remove();
      renderAIMessage(model, parseMarkdown(full), full);
      messages.push({ role: 'assistant', content: full });
      processAIMarkers(full);

      if (agentLoopAbort) { renderSystemLine('⏹ stopped by user'); break; }

      // Find any runnable blocks in the latest response
      const blocks = extractRunnableBlocks(full);
      if (!blocks.length) {
        // AI has nothing left to run → the task is done (or it's asking a question)
        break;
      }

      // Execute every block, feed combined output back
      let combined = '';
      for (const b of blocks) {
        if (agentLoopAbort) break;
        const r = await agentRun(b.content, true, true);
        const stdout = r.stdout || '';
        const stderr = r.stderr || '';
        const aiMsgEl = document.querySelector('#msgs .msg-a:last-child .ai-body');
        if (aiMsgEl) {
          const det = document.createElement('details');
          det.className = 'think-block';
          det.open = true;
          det.innerHTML = `<summary>▶ Ran ${escapeHTML(b.lang)} · exit ${r.exitCode}</summary><div class="think-inner">${stdout ? '<div>' + escapeHTML(stdout) + '</div>' : ''}${stderr ? '<div style="color:var(--red);margin-top:6px;">' + escapeHTML(stderr) + '</div>' : ''}${!stdout && !stderr ? '<div style="color:var(--text3);">(no output)</div>' : ''}</div>`;
          aiMsgEl.appendChild(det);
          setTimeout(() => { det.open = false; }, 1500);
        }
        combined += '\n$ ' + b.content + '\n' + stdout +
          (stderr ? '\n[stderr]\n' + stderr : '') +
          (r.exitCode ? `\n[exit ${r.exitCode}]` : '');
      }

      if (agentLoopAbort) { renderSystemLine('⏹ stopped by user'); break; }

      // Feed results back for the next iteration
      messages.push({
        role: 'user',
        content: '[execution results]\n' + combined.trim() +
          '\n\nContinue working on the task. If you need to run more commands, write another bash block. If the task is complete, say so in one line and stop.'
      });
    }
  } finally {
    agentLoopRunning = false;
    agentLoopAbort = false;
    setAgentLoopUI(false);
  }
}

function stopAgentLoop() {
  if (!agentLoopRunning) return;
  agentLoopAbort = true;
  showToast('Stopping agent…');
}

// ===== Chat preview pane =====
function chatPreviewShow(url, title) {
  const pane = document.getElementById('chat-preview');
  const frame = document.getElementById('chat-preview-frame');
  const titleEl = document.getElementById('chat-preview-title');
  if (!pane || !frame) return;
  if (title && titleEl) titleEl.textContent = title;
  frame.src = url;
  pane.classList.add('show');
}
function chatPreviewClose() {
  const pane = document.getElementById('chat-preview');
  const frame = document.getElementById('chat-preview-frame');
  if (pane) { pane.classList.remove('show'); pane.classList.remove('fullscreen'); }
  if (frame) frame.src = 'about:blank';
}
function chatPreviewReload() {
  const frame = document.getElementById('chat-preview-frame');
  if (frame && frame.src && frame.src !== 'about:blank') frame.src = frame.src;
}
function chatPreviewFullscreen() {
  const pane = document.getElementById('chat-preview');
  if (pane) pane.classList.toggle('fullscreen');
}

// Parse [SHOW_PREVIEW ...] and [SHOW_DESKTOP] markers from AI responses
function processAIMarkers(text) {
  // [SHOW_PREVIEW path=foo.html title="My page"]
  // [SHOW_PREVIEW url=https://... ]
  const previewRe = /\[SHOW_PREVIEW\s+([^\]]+)\]/i;
  const m = text.match(previewRe);
  if (m) {
    const args = m[1];
    const pathMatch = args.match(/path=(\S+)/i);
    const urlMatch = args.match(/url=(\S+)/i);
    const titleMatch = args.match(/title="([^"]+)"/i) || args.match(/title=(\S+)/i);
    const title = titleMatch ? titleMatch[1] : 'Preview';
    if (urlMatch) {
      chatPreviewShow(urlMatch[1], title);
    } else if (pathMatch && agentSessionId) {
      const base = getHfBackendUrl();
      const tok = getHfBackendToken();
      const path = pathMatch[1].replace(/^\/?/, '');
      const url = `${base}/sessions/${agentSessionId}/files/${encodeURI(path)}?token=${encodeURIComponent(tok)}`;
      chatPreviewShow(url, title);
    }
  }
  // [SHOW_DESKTOP] → start and show the noVNC desktop
  if (/\[SHOW_DESKTOP\]/i.test(text)) {
    showAgentDesktop();
  }
}

// Probe the HF backend's /desktop endpoint to see if the new Dockerfile
// (with Xvfb + noVNC) has been deployed. If so, reveal the floating
// Desktop button in the chat panel.
let _desktopProbedOnce = false;
async function probeDesktopSupport() {
  const btn = document.getElementById('chat-desktop-btn');
  if (!btn) return;
  const base = getHfBackendUrl();
  const tok = getHfBackendToken();
  if (!base) { btn.classList.remove('show'); return; }
  try {
    const r = await fetch(base + '/desktop?token=' + encodeURIComponent(tok), { method: 'GET' });
    // Possible responses:
    //   200   → noVNC already running inside sandbox, ready to show
    //   502   → endpoint exists, backend up, but noVNC not started yet (still means Dockerfile is good)
    //   401   → endpoint exists but token mismatch
    //   404   → old backend without /desktop, update needed
    //   500   → requests lib missing, update needed
    if (r.status === 200 || r.status === 502 || r.status === 401) {
      btn.classList.add('show');
      _desktopProbedOnce = true;
    } else {
      btn.classList.remove('show');
    }
  } catch {
    btn.classList.remove('show');
  }
}

// Start or restart a noVNC desktop inside the sandbox and show it in the preview
async function waitForHFReady(base, tok, maxSeconds) {
  maxSeconds = maxSeconds || 90;
  const start = Date.now();
  renderSystemLine('⏳ waking HF Space (first boot after sleep can take ~60s)');
  while ((Date.now() - start) / 1000 < maxSeconds) {
    try {
      const r = await fetch(base + '/', { method: 'GET' });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        if (d && d.ok) return true;
      }
    } catch {}
    await new Promise(res => setTimeout(res, 3000));
  }
  return false;
}

async function showAgentDesktop() {
  if (!agentSessionId || agentBackend !== 'hf') {
    showToast('Desktop needs the HF Agent Backend running');
    return;
  }
  showToast('Starting desktop…');
  // If the Space is asleep, poll until it wakes — iframe would otherwise
  // show HF's "Preparing Space" screen until the user manually reloads.
  const base = getHfBackendUrl();
  const tok = getHfBackendToken();
  await waitForHFReady(base, tok, 90);
  // Runs Xvfb + fluxbox + x11vnc + websockify if they're installed.
  // The Dockerfile below adds them. Desktop is served on port 6080.
  const bootCmd = `
set -e
command -v Xvfb || { echo "desktop stack not installed — please update agent-backend and redeploy"; exit 1; }
pgrep Xvfb >/dev/null || (Xvfb :0 -screen 0 1280x720x24 &) 2>/dev/null
sleep 1
pgrep fluxbox >/dev/null || (DISPLAY=:0 fluxbox &) 2>/dev/null
sleep 1
pgrep x11vnc >/dev/null || (x11vnc -display :0 -forever -nopw -shared -rfbport 5900 &) 2>/dev/null
sleep 1
pgrep websockify >/dev/null || (websockify --web=/usr/share/novnc 6080 localhost:5900 &) 2>/dev/null
sleep 1
echo ready
`;
  await agentRun(bootCmd, true, true);
  // HF Spaces only exposes port 7860 externally, so the sandbox's port 6080
  // isn't directly reachable. The backend needs a /desktop passthrough, or
  // the Space has to be configured to expose 6080. For now, hit a helper
  // endpoint if present, else show an instruction.
  const base = getHfBackendUrl();
  const tok = getHfBackendToken();
  const url = `${base}/desktop?token=${encodeURIComponent(tok)}`;
  // Probe
  try {
    const r = await fetch(url, { method: 'HEAD' });
    if (r.ok || r.status === 405) {
      chatPreviewShow(url, 'AI Desktop');
      return;
    }
  } catch {}
  renderSystemLine('⚠ desktop stack not exposed — redeploy the backend with the new Dockerfile (agent-backend/Dockerfile) that includes Xvfb + noVNC + a /desktop proxy.');
}

function renderSystemLine(text) {
  const msgs = document.getElementById('msgs');
  if (!msgs) return;
  const div = document.createElement('div');
  div.className = 'msg';
  div.style.cssText = 'font-size:11.5px;color:var(--text3);font-family:var(--mono);padding:4px 24px;max-width:780px;margin:0 auto;';
  div.textContent = text;
  msgs.appendChild(div);
  scrollToBottom();
}

function setAgentLoopUI(running) {
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  if (sendBtn) sendBtn.classList.toggle('hide', running);
  if (stopBtn) stopBtn.classList.toggle('show', running);
  // Change the input placeholder so the user knows they're injecting, not starting a new turn
  const input = document.getElementById('input-text');
  if (input) {
    input.placeholder = running
      ? 'Agent is working… type to inject a message into the loop'
      : 'Agent mode · ask the AI to run commands in a sandbox';
  }
}

function newChat() {
  messages = [];
  currentChatId = null;
  pendingAttachments = [];
  renderAttachPreview();
  document.getElementById('msgs').innerHTML = '';
  const home = document.getElementById('home-screen');
  if (home) home.classList.remove('hidden');
  if (window.termBootStart) window.termBootStart();
  closeDrawer();
}

// ===== Attachments =====
// Accept ANY file type. Images are passed to the AI as vision input.
// Non-image files (ISO, PDF, zip, txt, code, anything) are base64-read and
// attached to the message; in Agent mode they're uploaded to the sandbox
// filesystem so the AI can cat/unzip/mount/inspect them.
function addAttachment(file) {
  const isImage = file.type.startsWith('image/');
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result; // data:mime;base64,...
    pendingAttachments.push({
      dataUrl,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      isImage
    });
    renderAttachPreview();
    // In Agent mode, auto-upload to the sandbox so it's usable
    if (chatMode === 'agent' && agentReady && !isImage) {
      uploadAttachmentToSandbox(pendingAttachments[pendingAttachments.length - 1]);
    }
  };
  reader.readAsDataURL(file);
}

async function uploadAttachmentToSandbox(att) {
  if (agentBackend !== 'hf' || !agentSessionId) return;
  try {
    // Strip the "data:<mime>;base64," prefix
    const b64 = att.dataUrl.split(',')[1] || '';
    // Use a simple python one-liner to write the file by decoding the b64
    const py = `import base64; open('/home/agent/sessions/${agentSessionId}/${escapeShell(att.name)}','wb').write(base64.b64decode('${b64}'))`;
    // Actually just POST to /write with content — but content would be binary.
    // Easier: do it via the exec endpoint with a python one-liner.
    await hfFetch('/sessions/' + agentSessionId + '/exec', {
      method: 'POST',
      body: JSON.stringify({
        command: `python3 -c "import base64,sys; open('${escapeShell(att.name)}','wb').write(base64.b64decode(sys.stdin.read()))" <<'EOF_B64'\n${b64}\nEOF_B64`
      })
    });
    showToast('Uploaded ' + att.name + ' to sandbox');
  } catch (e) {
    showToast('Upload failed: ' + e.message);
  }
}
function escapeShell(s) { return String(s).replace(/['"\\`$]/g, '_'); }

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
function fileIcon(mime, name) {
  if (mime.startsWith('image/')) return '🖼';
  if (/\.iso$/i.test(name)) return '💿';
  if (/\.(zip|tar|gz|7z|rar|xz|bz2)$/i.test(name)) return '📦';
  if (/\.pdf$/i.test(name)) return '📕';
  if (/\.(mp4|mkv|mov|webm|avi)$/i.test(name)) return '🎬';
  if (/\.(mp3|wav|ogg|flac|m4a)$/i.test(name)) return '🎵';
  if (/\.(py|js|ts|rs|go|java|c|cpp|cs|rb|php|sh|html|css|json|md|txt|yaml|toml|xml)$/i.test(name)) return '📄';
  return '📎';
}
function removeAttachment(idx) {
  pendingAttachments.splice(idx, 1);
  renderAttachPreview();
}
function renderAttachPreview() {
  const el = document.getElementById('attach-preview');
  if (!el) return;
  el.innerHTML = pendingAttachments.map((a, i) => {
    if (a.isImage) {
      return `<div class="attach-wrap"><img class="attach-thumb" src="${a.dataUrl}"><button class="attach-x" onclick="removeAttachment(${i})">×</button></div>`;
    }
    return `<div class="attach-wrap attach-file"><div class="attach-file-inner"><div class="attach-icon">${fileIcon(a.mime, a.name)}</div><div class="attach-meta"><div class="attach-name">${escapeHTML(a.name)}</div><div class="attach-size">${formatBytes(a.size)}</div></div></div><button class="attach-x" onclick="removeAttachment(${i})">×</button></div>`;
  }).join('');
}
