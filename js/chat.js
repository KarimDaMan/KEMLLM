// ========== KEMLLM Chat System ==========
'use strict';

let messages = [];
let currentChatId = null;
let pendingAttachments = []; // {dataUrl, name}
let abortCtrl = null;
window.webSearchOn = false;
let chatMode = 'chat'; // 'chat' | 'code' | 'agent'
let agentUnlocked = false;
// Blocks the send button while an AI response is in progress — user must
// wait (or press stop) before sending the next message. Matches ChatGPT's
// interaction model.
let chatBusy = false;
function setChatBusy(busy) {
  chatBusy = busy;
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const input = document.getElementById('input-text');
  if (sendBtn) sendBtn.classList.toggle('hide', busy);
  if (stopBtn) stopBtn.classList.toggle('show', busy);
  if (input) input.disabled = false; // still allow typing ahead
}

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
    // The desktop button has no data-mode — skip the active toggle for it.
    if (b.id === 'chat-desktop-btn') return;
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
  // If switching to agent, make sure backend is primed (fire-and-forget,
  // but subsequent callers share the same agentStartPromise so nothing races)
  if (mode === 'agent' && !agentReady) {
    agentStart().catch(() => {});
  }
}

// NOTE: keyword-based IMG/VID/EDIT regex routing was REMOVED. Generation is
// now AI-triggered via [GENERATE_IMAGE]/[GENERATE_VIDEO]/[EDIT_IMAGE] markers
// only — see sendMessage() and processAIMarkers().

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
  // Images (must come before links — `![alt](url)` contains a `[...](...)`)
  // Clicking/tapping a generated image opens a fullscreen viewer with
  // download button + inline edit box (like ChatGPT). The viewer also
  // has a "use in chat" button that falls back to the old behavior of
  // attaching it to the regular chat input.
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
    const safeUrl = String(url).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    return `<img src="${safeUrl}" alt="${alt}" class="ai-img" onclick="openImageViewer('${safeUrl}')" title="Tap to open · edit · download">`;
  });
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
  // Agent panel was removed — switch to chat panel and flip to agent mode
  if (typeof setChatMode === 'function') setChatMode('agent');
  if (typeof siNav === 'function') siNav('chat');
  if (!agentReady) {
    agentLog('› Pending: starting sandbox first…', 'sys');
    agentStart().then(() => { if (agentReady) agentRun(cmd, true); });
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
  let attHtml = '';
  if (attachments && attachments.length) {
    // Small uniform 72×72 squares, ABOVE the text bubble, right-aligned
    const items = attachments.map(a => {
      const isImg = a.isImage || (a.mime || '').startsWith('image/');
      const src = a.dataUrl || a.url;
      if (isImg && src) {
        const safeUrl = String(src).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
        return `<div class="msg-att msg-att-img"><img src="${safeUrl}" onclick="openImageViewer('${safeUrl}')"></div>`;
      }
      const icon = typeof fileIcon === 'function' ? fileIcon(a.mime || '', a.name || '') : '📎';
      const name = escapeHTML((a.name || 'file').slice(0, 20));
      return `<div class="msg-att msg-att-file" title="${escapeHTML(a.name || 'file')}"><span class="msg-att-icon">${icon}</span><span class="msg-att-name">${name}</span></div>`;
    }).join('');
    attHtml = `<div class="msg-att-row">${items}</div>`;
  }
  div.innerHTML = attHtml + `<div class="bubble">${escapeHTML(text)}</div>`;
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
  // Render LaTeX math (lazy-loads KaTeX on first encounter)
  renderMathIn(div.querySelector('.ai-txt'));
  return div;
}

// ===== KaTeX math rendering (lazy) =====
let _katexPromise = null;
function loadKatex() {
  if (_katexPromise) return _katexPromise;
  _katexPromise = (async () => {
    if (window.katex && window.renderMathInElement) return;
    // Load core KaTeX
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.js';
      s.onload = res;
      s.onerror = () => rej(new Error('failed to load katex.min.js'));
      document.head.appendChild(s);
    });
    // Load auto-render extension
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/contrib/auto-render.min.js';
      s.onload = res;
      s.onerror = () => rej(new Error('failed to load auto-render.min.js'));
      document.head.appendChild(s);
    });
  })();
  _katexPromise.catch(() => { _katexPromise = null; });
  return _katexPromise;
}

async function renderMathIn(el) {
  if (!el) return;
  // Quick scan: only load KaTeX if the element actually contains math delimiters
  const text = el.innerText || '';
  const hasMath =
    /\$\$[\s\S]+?\$\$/.test(text) ||
    /\$[^$\n]+\$/.test(text) ||
    /\\\([\s\S]+?\\\)/.test(text) ||
    /\\\[[\s\S]+?\\\]/.test(text);
  if (!hasMath) return;
  try {
    await loadKatex();
    if (typeof window.renderMathInElement !== 'function') return;
    window.renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$',  right: '$',  display: false },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    });
  } catch (e) {
    console.warn('[KEMLLM] math render failed:', e);
  }
}

function copyAIMessage(btn) {
  const msgEl = btn.closest('.msg-a');
  const text = msgEl?.dataset.raw || msgEl?.querySelector('.ai-txt')?.innerText || '';
  navigator.clipboard.writeText(text);
  showToast('Copied');
}

function regenerateMessage() {
  // Remove last assistant DOM + state
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { messages.splice(i, 1); break; }
  }
  const lastAI = document.querySelector('#msgs .msg-a:last-child');
  if (lastAI) lastAI.remove();
  // Remove the last user message + its DOM
  const last = messages[messages.length - 1];
  if (last?.role === 'user') {
    messages.pop();
    document.querySelectorAll('#msgs .msg-u').forEach((el, i, arr) => {
      if (i === arr.length - 1) el.remove();
    });
    // Restore attachments (best-effort — dataUrls may have been stripped
    // after a chat reload, in which case we only have the metadata)
    if (last.attachments && last.attachments.length) {
      pendingAttachments = last.attachments.filter(a => a.dataUrl).slice();
      renderAttachPreview();
    }
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
  // Block a new send while the current response is still streaming in.
  // User must wait (or press the stop button) before sending the next
  // message — same pattern as ChatGPT. Agent-loop mode has its own
  // injection queue so we let those pass through.
  if (chatBusy && chatMode !== 'agent') {
    showToast('Wait for the current response to finish');
    return;
  }
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
    // Preserve attachments so vision + agent mode works
    const agentUserMsg = atts.length
      ? { role: 'user', content: text, attachments: atts }
      : { role: 'user', content: text };
    messages.push(agentUserMsg);
    await runAgentModeChat(text);
    saveCurrentChat();
    return;
  }

  const userMsg = atts.length
    ? { role: 'user', content: text, attachments: atts }
    : { role: 'user', content: text };
  messages.push(userMsg);
  renderUserMessage(text, atts);

  // NO MORE keyword routing. Every message goes to the AI chat model first.
  // The AI decides whether image/video generation is needed and emits the
  // appropriate marker ([GENERATE_IMAGE prompt="..."], etc) with a properly
  // crafted prompt. The frontend's processAIMarkers then dispatches to
  // handleImageRequest / handleVideoRequest / handleEditImageRequest with
  // the GOOD prompt the AI wrote, not the user's raw request.

  const model = findModel(selectedChat, 'chat');
  if (!model) { showToast('No model selected'); return; }

  const typingEl = renderTyping(model);
  setChatBusy(true);

  try {
    let full = '';
    await callChat(model, messages, (chunk, done) => {
      full += chunk;
    });
    typingEl.remove();
    messages.push({ role: 'assistant', content: full });

    // Strip generation markers from the visible text so the user doesn't
    // see [GENERATE_IMAGE prompt="..."] as literal text. The AI's prose
    // (if any) around the marker is preserved.
    const visibleText = stripAIMarkers(full);

    // Claude.ai-style autonomous code execution: if the AI wrote a runnable
    // code block, auto-run it, show the analysis, then let the AI respond
    // once with the result in mind.
    const runnable = extractFirstRunnableBlock(visibleText);
    if (runnable) {
      const aiEl = renderAIMessage(model, parseMarkdown(visibleText));
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
          renderAIMessage(model, parseMarkdown(stripAIMarkers(more)));
          messages.push({ role: 'assistant', content: more });
        } catch (e) {
          typing2.remove();
        }
      }
    } else {
      renderAIMessage(model, parseMarkdown(visibleText));
    }

    // Process any generation markers the AI emitted. This triggers
    // image/video/edit generation with the AI's CRAFTED prompt.
    processAIMarkers(full);

    saveCurrentChat();
  } catch (e) {
    typingEl.remove();
    renderAIMessage(model, `<p style="color:var(--red)">${escapeHTML(e.message)}</p>`);
  } finally {
    setChatBusy(false);
  }
}

// Strip all AI generation markers from a text so the user doesn't see
// them as literal text in the rendered response. Whitespace is cleaned
// up so there's no awkward blank line where the marker was.
function stripAIMarkers(text) {
  if (!text) return '';
  return text
    .replace(/\[SHOW_PREVIEW\s+[^\]]+\]/gi, '')
    .replace(/\[SHOW_DESKTOP\]/gi, '')
    .replace(/\[GENERATE_IMAGE\s+prompt=(?:"[^"]+"|'[^']+'|[^\]]+)\]/gi, '')
    .replace(/\[GENERATE_VIDEO\s+prompt=(?:"[^"]+"|'[^']+'|[^\]]+)\]/gi, '')
    .replace(/\[EDIT_IMAGE\s+prompt=(?:"[^"]+"|'[^']+'|[^\]]+)\]/gi, '')
    .replace(/\[REMEMBER\s+fact=(?:"[^"]+"|'[^']+'|[^\]]+)\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

// Render a slim "code execution strip" directly after the AI message bubble.
// It's collapsed by default — just a thin bar saying "▶ Ran python · 120ms".
// Click opens a centered modal popup with the full output, the code itself,
// and (if the code is HTML) a Preview button that renders it in an iframe.
async function runAnalysisBlock(aiEl, block) {
  if (!aiEl || !aiEl.parentNode) return null;
  const strip = document.createElement('div');
  strip.className = 'code-strip running';
  strip.innerHTML = `<button type="button" class="code-strip-bar"><span class="code-strip-dot"></span><span class="code-strip-label">Running ${escapeHTML(block.lang)}…</span></button>`;
  aiEl.parentNode.insertBefore(strip, aiEl.nextSibling);
  scrollToBottom();
  try {
    const start = Date.now();
    const out = await runViaPiston(block.lang, block.code);
    const ms = Date.now() - start;
    const stdout = out.run?.stdout || '';
    const stderr = out.run?.stderr || '';
    const exit = out.run?.code;
    const isHtml = block.lang === 'html' ||
      /^\s*(?:<!doctype\s+html|<html|<body|<head)/i.test(block.code);
    strip.classList.remove('running');
    strip.classList.add(stderr ? 'err' : 'ok');
    const label = `Ran ${block.lang} · ${ms}ms · exit ${exit}${isHtml ? ' · HTML' : ''}`;
    strip.querySelector('.code-strip-label').textContent = label;
    strip.querySelector('.code-strip-bar').addEventListener('click', () => {
      openCodeRunModal({ lang: block.lang, code: block.code, stdout, stderr, exit, ms, isHtml });
    });
    return { stdout, stderr, exit };
  } catch (e) {
    strip.classList.remove('running');
    strip.classList.add('err');
    strip.querySelector('.code-strip-label').textContent = 'Execution error · tap for details';
    strip.querySelector('.code-strip-bar').addEventListener('click', () => {
      openCodeRunModal({ lang: block.lang, code: block.code, stdout: '', stderr: e.message, exit: -1, ms: 0, isHtml: false });
    });
    return { stdout: '', stderr: e.message, exit: -1 };
  }
}

// Opens a modal popup with the full code execution details. Works on mobile
// and desktop. Includes a Preview button that spins up a sandboxed iframe
// when the code was HTML.
function openCodeRunModal(info) {
  let modal = document.getElementById('code-run-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'code-run-modal';
    modal.className = 'code-run-modal';
    modal.innerHTML = `
      <div class="code-run-backdrop"></div>
      <div class="code-run-sheet">
        <div class="code-run-head">
          <div class="code-run-title"></div>
          <button type="button" class="code-run-close" aria-label="Close">×</button>
        </div>
        <div class="code-run-body"></div>
        <div class="code-run-foot">
          <button type="button" class="code-run-preview" hidden>Preview</button>
          <button type="button" class="code-run-copy">Copy output</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = () => { modal.classList.remove('open'); document.body.style.overflow = ''; };
    modal.querySelector('.code-run-close').addEventListener('click', close);
    modal.querySelector('.code-run-backdrop').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  const title = modal.querySelector('.code-run-title');
  const body = modal.querySelector('.code-run-body');
  const previewBtn = modal.querySelector('.code-run-preview');
  const copyBtn = modal.querySelector('.code-run-copy');
  title.textContent = `${info.lang} · ${info.ms}ms · exit ${info.exit}`;
  body.innerHTML = `
    <div class="code-run-section">
      <div class="code-run-section-h">Code</div>
      <pre class="code-run-pre code-run-code">${escapeHTML(info.code)}</pre>
    </div>
    ${info.stdout ? `<div class="code-run-section"><div class="code-run-section-h">Stdout</div><pre class="code-run-pre code-run-out">${escapeHTML(info.stdout)}</pre></div>` : ''}
    ${info.stderr ? `<div class="code-run-section"><div class="code-run-section-h">Stderr</div><pre class="code-run-pre code-run-err">${escapeHTML(info.stderr)}</pre></div>` : ''}
    ${!info.stdout && !info.stderr ? `<div class="code-run-section" style="color:var(--text3);font-size:12px;">No output.</div>` : ''}
  `;
  previewBtn.hidden = !info.isHtml;
  previewBtn.onclick = () => {
    const section = document.createElement('div');
    section.className = 'code-run-section';
    section.innerHTML = `<div class="code-run-section-h">Preview</div><iframe class="code-run-iframe" sandbox="allow-scripts" srcdoc=""></iframe>`;
    body.appendChild(section);
    const iframe = section.querySelector('iframe');
    iframe.srcdoc = info.code;
    previewBtn.hidden = true;
    iframe.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  copyBtn.onclick = async () => {
    const txt = (info.stdout || '') + (info.stderr ? '\n---\n' + info.stderr : '');
    try { await navigator.clipboard.writeText(txt); showToast('Copied'); } catch {}
  };
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

// ===== Fullscreen image viewer =====
// Opens on tap of any AI-generated image. Supports:
//   - Close (X)
//   - Download (saves to the user's device)
//   - Use in chat (adds to pendingAttachments, closes viewer)
//   - Inline edit box (types an edit prompt and calls editImage directly
//     from inside the viewer so the user never has to leave)
let _imgViewerUrl = '';

function openImageViewer(url) {
  if (!url) return;
  url = String(url).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  _imgViewerUrl = url;
  const viewer = document.getElementById('img-viewer');
  const img = document.getElementById('img-viewer-img');
  const title = document.getElementById('img-viewer-title');
  if (!viewer || !img) return;
  img.src = url;
  if (title) {
    // Show the filename/path part of the URL as the title
    try {
      const u = new URL(url);
      title.textContent = u.pathname.split('/').pop() || url;
    } catch { title.textContent = url; }
  }
  viewer.classList.add('open');
  document.body.style.overflow = 'hidden';
  const input = document.getElementById('img-viewer-input');
  if (input) { input.value = ''; setTimeout(() => input.focus(), 150); }
}

function closeImageViewer() {
  const viewer = document.getElementById('img-viewer');
  if (viewer) viewer.classList.remove('open');
  document.body.style.overflow = '';
  _imgViewerUrl = '';
}

async function downloadImageFromViewer() {
  if (!_imgViewerUrl) return;
  try {
    showToast('Downloading…');
    // Fetch as blob so the Save-As dialog works cross-origin
    const res = await fetch(_imgViewerUrl);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    const ext = (blob.type.split('/')[1] || 'png').split(';')[0];
    a.download = 'kemllm-' + Date.now() + '.' + ext;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(blobUrl);
    }, 1000);
  } catch (e) {
    showToast('Download failed: ' + (e.message || e));
  }
}

function useViewerImageInChat() {
  if (!_imgViewerUrl) return;
  reuseImageAsAttachment(_imgViewerUrl);
  closeImageViewer();
}

// OCR via the currently-selected vision-capable chat model. Sends the
// viewer's image to the model with an "extract all text" prompt and
// displays the result inside the viewer overlay.
async function ocrFromImageViewer() {
  if (!_imgViewerUrl) return;
  const model = findModel(selectedChat, 'chat');
  if (!model) { showToast('No chat model selected'); return; }
  showToast('Extracting text…');
  try {
    // Fetch the image → data URL so we can pass it as an attachment.
    const res = await fetch(_imgViewerUrl);
    const blob = await res.blob();
    const dataUrl = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.readAsDataURL(blob);
    });
    const attachment = {
      dataUrl,
      name: 'ocr-target.png',
      size: blob.size,
      mime: blob.type || 'image/png',
      isImage: true,
    };
    const msgs = [{
      role: 'user',
      content: 'Extract ALL visible text from this image. Return only the text, preserving line breaks and structure. If there is no text, say "[no text found]".',
      attachments: [attachment],
    }];
    let full = '';
    await callChat(model, msgs, (chunk) => { full += chunk; });
    // Render the extracted text into the chat timeline as a proper
    // AI message so it's part of history and copyable.
    const out = (full || '').trim() || '[no text found]';
    const md = `Text extracted from image:\n\n\`\`\`\n${out}\n\`\`\``;
    renderAIMessage(model, parseMarkdown(md), md);
    messages.push({ role: 'assistant', content: md });
    saveCurrentChat();
    closeImageViewer();
  } catch (e) {
    showToast('OCR failed: ' + (e.message || e));
  }
}

async function editFromImageViewer(promptText) {
  if (!_imgViewerUrl || !promptText) return;
  const viewer = document.getElementById('img-viewer');
  const edit = document.getElementById('img-viewer-form');
  const img = document.getElementById('img-viewer-img');
  if (edit) edit.classList.add('busy');
  showToast('Editing…');
  try {
    const newUrl = await editImage(promptText, _imgViewerUrl);
    if (!newUrl) throw new Error('No output');
    // Swap the viewer's image to the new edit
    _imgViewerUrl = newUrl;
    if (img) img.src = newUrl;
    // Also render the edit into the chat timeline so it's part of history
    const fakeModel = { name: 'Image Edit', provider: 'google' };
    const md = `Edited:\n\n![edited](${newUrl})`;
    renderAIMessage(fakeModel, parseMarkdown(md), md);
    messages.push({ role: 'assistant', content: md });
    saveCurrentChat();
    // Clear the input and let the user chain more edits
    const input = document.getElementById('img-viewer-input');
    if (input) { input.value = ''; input.focus(); }
  } catch (e) {
    showToast('Edit failed: ' + (e.message || e));
  } finally {
    if (edit) edit.classList.remove('busy');
  }
}

// Called when the user taps a generated/edited image in a chat bubble.
// Treats that image as the next pending attachment so the next message
// can reference it (e.g. "now make it blue", "add a person"). If the
// user's next message matches EDIT_REGEX, it routes to handleEditImageRequest
// automatically — so tap, type, go.
function reuseImageAsAttachment(url) {
  if (!url) return;
  // Strip HTML entity encoding that might have been added during render
  url = url.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  pendingAttachments.push({
    url,              // plain https URL (not a data URL)
    name: 'image.png',
    size: 0,
    mime: 'image/png',
    isImage: true,
  });
  renderAttachPreview();
  const input = document.getElementById('input-text');
  if (input) {
    input.focus();
    if (!input.value) input.placeholder = 'Describe the edit (e.g. "make it blue", "remove the background")';
  }
  if (typeof showToast === 'function') showToast('Image attached — describe the edit');
}

async function handleImageRequest(prompt) {
  const m = findModel(selectedImage, 'image');
  const fakeModel = { name: m?.name || 'Image', provider: 'google' };
  const typingEl = renderTyping(fakeModel);
  try {
    const url = await generateImage(prompt);
    typingEl.remove();
    // Save as markdown so parseMarkdown renders the image on both the
    // initial display AND when the chat is reloaded from history.
    const md = `Generated with ${m.name}:\n\n![generated](${url})`;
    renderAIMessage(fakeModel, parseMarkdown(md), md);
    messages.push({ role: 'assistant', content: md });
    saveCurrentChat();
  } catch (e) {
    typingEl.remove();
    renderAIMessage(fakeModel, `<p style="color:var(--red)">${escapeHTML(e.message)}</p>`);
  }
}
async function handleEditImageRequest(prompt, imageAttachment) {
  const fakeModel = { name: 'Image Edit (FLUX Kontext)', provider: 'google' };
  const typingEl = renderTyping(fakeModel);
  try {
    // editImage now accepts either a data URL or a plain https URL
    const sourceUrl = imageAttachment.dataUrl || imageAttachment.url;
    const url = await editImage(prompt, sourceUrl);
    typingEl.remove();
    const md = `Edited with FLUX Kontext:\n\n![edited](${url})`;
    renderAIMessage(fakeModel, parseMarkdown(md), md);
    messages.push({ role: 'assistant', content: md });
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
    const md = `Generated with ${m.name}:\n\n<video controls loop src="${url}" style="max-width:520px;border-radius:10px;"></video>`;
    renderAIMessage(fakeModel, md, md);
    messages.push({ role: 'assistant', content: md });
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

// Parse AI-emitted markers from a response and act on them. Supported:
//   [SHOW_PREVIEW path=foo.html title="My page"]
//   [SHOW_PREVIEW url=https://...]
//   [SHOW_DESKTOP]
//   [GENERATE_IMAGE prompt="sunset over a mountain lake"]
//   [GENERATE_VIDEO prompt="slow pan across a rainforest"]
//   [EDIT_IMAGE prompt="make the house white"]  (uses last generated image)
// The image/video markers let the AI call generation itself without the
// user having to switch modes or retry. The AI just writes the marker in
// its response and the frontend dispatches the call.
function processAIMarkers(text) {
  // [SHOW_PREVIEW ...]
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
  // [SHOW_DESKTOP]
  if (/\[SHOW_DESKTOP\]/i.test(text)) {
    showAgentDesktop();
  }
  // [GENERATE_IMAGE prompt="..."] — AI-triggered image gen
  const genImgRe = /\[GENERATE_IMAGE\s+prompt=(?:"([^"]+)"|'([^']+)'|([^\]]+))\]/i;
  const gi = text.match(genImgRe);
  if (gi) {
    const prompt = (gi[1] || gi[2] || gi[3] || '').trim();
    if (prompt) handleImageRequest(prompt);
  }
  // [GENERATE_VIDEO prompt="..."]
  const genVidRe = /\[GENERATE_VIDEO\s+prompt=(?:"([^"]+)"|'([^']+)'|([^\]]+))\]/i;
  const gv = text.match(genVidRe);
  if (gv) {
    const prompt = (gv[1] || gv[2] || gv[3] || '').trim();
    if (prompt) handleVideoRequest(prompt);
  }
  // [EDIT_IMAGE prompt="..."] — re-edit the most recent image in history
  const editImgRe = /\[EDIT_IMAGE\s+prompt=(?:"([^"]+)"|'([^']+)'|([^\]]+))\]/i;
  const ei = text.match(editImgRe);
  if (ei) {
    const prompt = (ei[1] || ei[2] || ei[3] || '').trim();
    // Find the most recent image URL in the message history
    let lastImg = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const c = messages[i].content;
      if (typeof c === 'string') {
        const im = c.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
        if (im) { lastImg = im[1]; break; }
      }
    }
    if (prompt && lastImg) {
      handleEditImageRequest(prompt, { url: lastImg, isImage: true });
    }
  }
  // [REMEMBER fact="..."] — AI writes to its own persistent memory about
  // the user. User can VIEW this in Settings → AI Memory but cannot edit
  // individual entries. Multiple markers per response are allowed.
  const rememberRe = /\[REMEMBER\s+fact=(?:"([^"]+)"|'([^']+)'|([^\]]+))\]/gi;
  let rm;
  while ((rm = rememberRe.exec(text)) !== null) {
    const fact = (rm[1] || rm[2] || rm[3] || '').trim();
    if (fact && typeof appendAIMemory === 'function') {
      appendAIMemory(fact);
    }
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
  const hide = () => {
    btn.dataset.desktopReady = '0';
    btn.classList.remove('show');
  };
  if (!base) return hide();
  try {
    const r = await fetch(base + '/desktop/?token=' + encodeURIComponent(tok), { method: 'GET' });
    // 200 = noVNC running · 502 = stack present but not started yet · 401 = token mismatch
    if (r.status === 200 || r.status === 502 || r.status === 401) {
      btn.dataset.desktopReady = '1';
      _desktopProbedOnce = true;
      btn.classList.add('show');
    } else {
      hide();
    }
  } catch { hide(); }
}

// Start or restart a noVNC desktop inside the sandbox and show it in the preview
// Live progress line that updates in-place instead of adding new lines
function renderProgressLine(initialText) {
  const msgs = document.getElementById('msgs');
  if (!msgs) return { update: () => {}, done: () => {} };
  const div = document.createElement('div');
  div.className = 'msg';
  div.style.cssText = 'font-size:12px;color:var(--text2);font-family:var(--mono);padding:6px 24px;max-width:780px;margin:0 auto;display:flex;align-items:center;gap:8px;';
  div.innerHTML = `<span class="progress-spinner" style="width:12px;height:12px;border:2px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spinBounce 0.8s linear infinite;"></span><span class="progress-text">${escapeHTML(initialText)}</span>`;
  msgs.appendChild(div);
  scrollToBottom();
  return {
    update: (text) => {
      const t = div.querySelector('.progress-text');
      if (t) t.textContent = text;
      scrollToBottom();
    },
    done: (text, emoji) => {
      div.innerHTML = `<span>${emoji || '✓'}</span><span>${escapeHTML(text)}</span>`;
    },
    fail: (text) => {
      div.innerHTML = `<span style="color:var(--red);">✗</span><span style="color:var(--red);">${escapeHTML(text)}</span>`;
    }
  };
}

async function waitForHFReady(base, tok, maxSeconds, progress) {
  maxSeconds = maxSeconds || 90;
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxSeconds) {
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (progress) progress.update(`waking HF Space… ${elapsed}s`);
    try {
      const r = await fetch(base + '/', { method: 'GET' });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        if (d && d.ok) return true;
      }
    } catch {}
    await new Promise(res => setTimeout(res, 2000));
  }
  return false;
}

async function showAgentDesktop() {
  // Hide the home screen so the progress lines are actually visible
  const home = document.getElementById('home-screen');
  if (home) home.classList.add('hidden');
  if (typeof termBootStop === 'function') termBootStop();

  if (agentBackend !== 'hf' && !getHfBackendUrl()) {
    showToast('Desktop needs the HF Agent Backend configured in Settings');
    return;
  }
  const base = getHfBackendUrl();
  const tok = getHfBackendToken();
  if (!base) { showToast('Set the HF backend URL in Settings first'); return; }

  // Step 1: make sure the Space is awake. Quick check first — if it responds
  // in under 2s we skip the polling loop entirely.
  const p = renderProgressLine('checking HF Space…');
  let ready = false;
  try {
    const quick = await Promise.race([
      fetch(base + '/').then(r => r.ok),
      new Promise(res => setTimeout(() => res(false), 2500)),
    ]);
    ready = quick === true;
  } catch { ready = false; }
  if (!ready) {
    ready = await waitForHFReady(base, tok, 90, p);
    if (!ready) {
      p.fail('HF Space did not come online after 90s. Check the Logs tab on your Space — it may still be rebuilding or the build may have failed.');
      return;
    }
  }
  p.done('HF Space is up', '✓');

  // Step 2: hit /desktop directly. With the new Dockerfile.desktop the
  // noVNC stack is auto-started at container boot, so this should return
  // the noVNC HTML straight away — no session or agentRun needed.
  const pc = renderProgressLine('checking /desktop endpoint…');
  let needsManualBoot = false;
  try {
    const r = await fetch(base + '/desktop/?token=' + encodeURIComponent(tok));
    if (r.status === 404) {
      pc.fail('Your HF Space has the OLD app.py. Upload the current app.py to the Space, commit, wait for rebuild.');
      return;
    }
    if (r.status === 401) {
      pc.fail('/desktop returned 401 — the token in Settings does not match AGENT_TOKEN on the Space.');
      return;
    }
    if (r.status === 502) {
      // Old slim Dockerfile, or desktop variant that didn't auto-start.
      // Fall through to the manual-boot path.
      needsManualBoot = true;
      pc.done('/desktop endpoint present (noVNC not up yet)', '⋯');
    } else if (r.ok) {
      pc.done('/desktop endpoint present', '✓');
    } else {
      const txt = await r.text().catch(() => '');
      if (txt.includes('requests')) {
        pc.fail('Your HF Space has the OLD Dockerfile (missing python-requests). Update the Dockerfile, commit, wait for rebuild.');
        return;
      }
      pc.fail('/desktop returned ' + r.status + ': ' + txt.slice(0, 180));
      return;
    }
  } catch (e) {
    pc.fail('Cannot reach /desktop: ' + e.message);
    return;
  }

  // Step 3 (only if noVNC isn't already running): create a session and
  // spawn Xvfb/fluxbox/x11vnc/websockify via agentRun. This is the legacy
  // path for the slim Dockerfile — the new Dockerfile.desktop skips it.
  if (needsManualBoot) {
    if (!agentSessionId) {
      const ps = renderProgressLine('creating sandbox session…');
      try { await agentStart(); }
      catch (e) { ps.fail('agentStart threw: ' + (e.message || e)); return; }
      if (!agentSessionId) {
        ps.fail('agentStart finished but no session_id. agentBackend=' + agentBackend);
        return;
      }
      ps.done('sandbox session ready', '✓');
    }
    const pn = renderProgressLine('starting Xvfb + fluxbox + x11vnc + noVNC…');
    const bootCmd = `set -e
command -v Xvfb >/dev/null || { echo MISSING_XVFB; exit 1; }
command -v websockify >/dev/null || { echo MISSING_WEBSOCKIFY; exit 1; }
pgrep -f "Xvfb :0" >/dev/null || (nohup Xvfb :0 -screen 0 1280x720x24 >/tmp/xvfb.log 2>&1 &)
sleep 1
pgrep -f fluxbox >/dev/null || (DISPLAY=:0 nohup fluxbox >/tmp/fluxbox.log 2>&1 &)
sleep 1
pgrep -f x11vnc >/dev/null || (nohup x11vnc -display :0 -forever -nopw -shared -rfbport 5900 -quiet >/tmp/x11vnc.log 2>&1 &)
sleep 1
pgrep -f websockify >/dev/null || (nohup websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &)
sleep 2
ss -tlnp 2>/dev/null | grep -q 6080 && echo READY || echo NOT_LISTENING
`;
    let rr;
    try {
      rr = await agentRun(bootCmd, true, true);
    } catch (e) {
      // Most likely agentSessionId went stale (container restarted). Retry once
      // with a fresh session before giving up.
      agentSessionId = '';
      try { await agentStart(); }
      catch (e2) { pn.fail('session refresh failed: ' + (e2.message || e2)); return; }
      try { rr = await agentRun(bootCmd, true, true); }
      catch (e3) { pn.fail('agentRun failed even after session refresh: ' + (e3.message || e3)); return; }
    }
    const output = (rr.stdout || '') + (rr.stderr || '');
    if (output.includes('MISSING_XVFB') || output.includes('MISSING_WEBSOCKIFY')) {
      pn.fail('Desktop tools not installed — your Space is running the SLIM Dockerfile. Upload Dockerfile.desktop (renamed to Dockerfile) and rebuild.');
      return;
    }
    if (!output.includes('READY')) {
      pn.fail('noVNC did not start listening on port 6080. Output: ' + output.slice(0, 180));
      return;
    }
    pn.done('noVNC listening on :6080', '✓');
  }

  // Step 4: load the preview. Use vnc_lite.html (minimal UI, no side toolbar
  // with the junk power buttons) and pass path=desktop/websockify so noVNC
  // opens its WebSocket against the nginx-proxied path, not the root.
  const url = `${base}/desktop/vnc_lite.html?path=desktop/websockify&autoconnect=1&resize=scale&token=${encodeURIComponent(tok)}`;
  chatPreviewShow(url, 'AI Desktop');
  renderSystemLine('🖥 desktop loaded — tap and drag in the preview to interact');
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
  // If an agent loop is running, stop it cleanly first
  if (agentLoopRunning) {
    agentLoopAbort = true;
  }
  messages = [];
  currentChatId = null;
  pendingAttachments = [];
  agentInjectQueue = [];
  renderAttachPreview();
  document.getElementById('msgs').innerHTML = '';
  const home = document.getElementById('home-screen');
  if (home) home.classList.remove('hidden');
  if (window.termBootStart) window.termBootStart();
  closeDrawer();
  // Close any open preview pane from a previous chat
  if (typeof chatPreviewClose === 'function') chatPreviewClose();
  // Clear any stuck highlight on the old chat in the sidebar / history list
  if (typeof renderHistory === 'function') renderHistory();
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
      // Thumbnail source can be either a data: URL (fresh upload) or a
      // plain https URL (reused from a previous generation)
      const src = a.dataUrl || a.url;
      return `<div class="attach-wrap"><img class="attach-thumb" src="${src}"><button class="attach-x" onclick="removeAttachment(${i})">×</button></div>`;
    }
    return `<div class="attach-wrap attach-file"><div class="attach-file-inner"><div class="attach-icon">${fileIcon(a.mime, a.name)}</div><div class="attach-meta"><div class="attach-name">${escapeHTML(a.name)}</div><div class="attach-size">${formatBytes(a.size)}</div></div></div><button class="attach-x" onclick="removeAttachment(${i})">×</button></div>`;
  }).join('');
}
