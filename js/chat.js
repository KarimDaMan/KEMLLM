// ========== KEMLLM Chat System ==========
'use strict';

let messages = [];
let currentChatId = null;
let pendingAttachments = []; // {dataUrl, name}
let abortCtrl = null;
window.webSearchOn = false;
let chatMode = 'chat'; // 'chat' | 'code' | 'agent'
// Agent mode is always unlocked — the old lock was confusing and the
// backend auto-spawns on first use anyway.
let agentUnlocked = true;
// Blocks the send button while an AI response is in progress — user must
// wait (or press stop) before sending the next message. Matches ChatGPT's
// interaction model.
// Per-chat busy state. Each chat that currently has an in-flight AI
// response is in this set. The send/stop button reflects the CURRENT
// chat's state — so the user can navigate to a different chat (or new
// chat) while one is still responding and that other chat is NOT busy.
const busyChats = new Set();
// Magic key for the "draft" chat (no id yet, just typing in a fresh
// home screen). Lets us track busy state before the first save.
const PENDING_DRAFT = '__draft__';

function setChatBusy(chatId, busy) {
  if (!chatId) chatId = PENDING_DRAFT;
  if (busy) busyChats.add(chatId);
  else busyChats.delete(chatId);
  refreshBusyUI();
}

function refreshBusyUI() {
  const isBusy = busyChats.has(currentChatId || PENDING_DRAFT);
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const input = document.getElementById('input-text');
  if (sendBtn) sendBtn.classList.toggle('hide', isBusy);
  if (stopBtn) stopBtn.classList.toggle('show', isBusy);
  if (input) input.disabled = false;
}

// Backwards-compat shim — anything that still references the global
// `chatBusy` value reads the current chat's state via this getter.
Object.defineProperty(window, 'chatBusy', {
  get() { return busyChats.has(currentChatId || PENDING_DRAFT); },
});

// Agent loop state — lets the AI keep running autonomously until the task
// is done, while the user can inject additional instructions mid-loop.
let agentLoopRunning = false;
let agentLoopAbort = false;
let agentInjectQueue = []; // messages the user types while the loop is running
const AGENT_LOOP_MAX_ITERATIONS = 25;

function setChatMode(mode) {
  chatMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => {
    // The desktop button has no data-mode and is allowed to be active
    // ALONGSIDE the agent button — handled separately below.
    if (b.id === 'chat-desktop-btn') return;
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  // Desktop button is a sub-button of Agent: only visible while in agent
  // mode (and only if the /desktop probe has succeeded). It can be visually
  // ACTIVE simultaneously with Agent — clicking it never deselects agent.
  const dBtn = document.getElementById('chat-desktop-btn');
  if (dBtn) {
    const ready = dBtn.dataset.desktopReady === '1';
    dBtn.classList.toggle('show', mode === 'agent' && ready);
    // If we just left agent mode, drop the desktop active highlight too.
    if (mode !== 'agent') dBtn.classList.remove('active');
  }
  const input = document.getElementById('input-text');
  if (input) {
    input.placeholder = mode === 'agent'
      ? 'Agent mode · ask the AI to run commands in a sandbox'
      : mode === 'code'
      ? 'Code mode · ask for code, auto-runs in browser'
      : 'Ask anything, generate images, run code...';
  }
  // NOTE: agent backend is no longer spawned just because the user
  // clicked Agent. It spawns lazily on the first send in agent mode
  // (see runAgentModeChat in sendMessage). This way clicking Agent
  // never uses resources until the user actually starts chatting.
}

// NOTE: keyword-based IMG/VID/EDIT regex routing was REMOVED. Generation is
// now AI-triggered via [GENERATE_IMAGE]/[GENERATE_VIDEO]/[EDIT_IMAGE] markers
// only — see sendMessage() and processAIMarkers().

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function parseMarkdown(md) {
  if (!md) return '';
  // Normalize line endings + fullwidth pipes (U+FF5C) that some models emit
  let html = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\uff5c/g, '|');
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
  // GFM tables — line-by-line scanner. Way more forgiving than the
  // previous regex which missed tables with any kind of whitespace.
  {
    const isTableRow = (l) => {
      const t = (l || '').trim();
      return t.length >= 3 && t.startsWith('|') && t.endsWith('|');
    };
    const isSeparator = (l) => {
      const t = (l || '').trim();
      if (!isTableRow(t)) return false;
      const inner = t.slice(1, -1);
      // Every cell must be dashes/colons/spaces
      return inner.split('|').every(c => /^\s*:?-{2,}:?\s*$/.test(c));
    };
    const parseRow = (l) => l.trim().slice(1, -1).split('|').map(c => c.trim());
    const lines = html.split('\n');
    const outLines = [];
    let i = 0;
    while (i < lines.length) {
      if (isTableRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
        const heads = parseRow(lines[i]);
        const aligns = parseRow(lines[i + 1]).map(s => {
          const t = s.trim();
          if (/^:-+:$/.test(t)) return 'center';
          if (/-+:$/.test(t)) return 'right';
          if (/^:-+/.test(t)) return 'left';
          return '';
        });
        let j = i + 2;
        const rows = [];
        while (j < lines.length && isTableRow(lines[j]) && !isSeparator(lines[j])) {
          rows.push(parseRow(lines[j]));
          j++;
        }
        let tbl = '<table class="md-table"><thead><tr>';
        heads.forEach((h, k) => {
          const a = aligns[k] ? ` style="text-align:${aligns[k]}"` : '';
          tbl += `<th${a}>${h}</th>`;
        });
        tbl += '</tr></thead><tbody>';
        rows.forEach(r => {
          tbl += '<tr>';
          // Pad short rows with empty cells, trim long ones
          for (let k = 0; k < heads.length; k++) {
            const a = aligns[k] ? ` style="text-align:${aligns[k]}"` : '';
            tbl += `<td${a}>${r[k] || ''}</td>`;
          }
          tbl += '</tr>';
        });
        tbl += '</tbody></table>';
        outLines.push(tbl);
        i = j;
      } else {
        outLines.push(lines[i]);
        i++;
      }
    }
    html = outLines.join('\n');
  }
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
    if (/^<(h\d|ul|ol|blockquote|pre|table)/.test(p.trim())) return p;
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
  // message IN THIS CHAT — same pattern as ChatGPT. Other chats with
  // their own in-flight responses are unaffected. Agent-loop mode has
  // its own injection queue so we let those pass through.
  if (busyChats.has(currentChatId || PENDING_DRAFT) && chatMode !== 'agent') {
    showToast('Wait for this chat to finish, or open a new chat');
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
    ? { role: 'user', content: text, attachments: atts, pending: true, ts: Date.now() }
    : { role: 'user', content: text, pending: true, ts: Date.now() };
  messages.push(userMsg);
  renderUserMessage(text, atts);
  // Persist IMMEDIATELY so the user message survives tab-close before
  // the AI response arrives. The pending=true flag is what tells the
  // background-resume logic on next load that this message needs an
  // answer. saveCurrentChat also assigns currentChatId if it was null.
  saveCurrentChat();
  // Now that we definitely have a chat id, push the per-chat URL so
  // this conversation has its own page from the very first message.
  if (currentChatId && typeof setHashForPanel === 'function' && currentPanel === 'chat') {
    setHashForPanel('chat', currentChatId);
  }

  // CHAT SCOPING: capture the chat id this message belongs to BEFORE the
  // fetch starts. If the user navigates to a different chat (or to the
  // home screen) while we're waiting, the response gets saved to the
  // originating chat's history but NOT rendered into the current view.
  const originatingChatId = currentChatId;
  // Snapshot of the conversation we send to the model — frozen at the
  // moment of send, so chat switches don't poison the request payload.
  const convoSnapshot = messages.slice();

  const model = findModel(selectedChat, 'chat');
  if (!model) { showToast('No model selected'); return; }

  const typingEl = renderTyping(model);
  setChatBusy(originatingChatId, true);

  // Helper: append assistant content to the originating chat's saved
  // history. Returns true if it could find the chat. Independent of the
  // global `messages` array (which may have been replaced by a chat
  // switch in the meantime).
  const appendAssistantToOriginatingChat = (content, modelName, modelProvider) => {
    if (!originatingChatId) return false;
    const list = loadHistory();
    const idx = list.findIndex(c => c.id === originatingChatId);
    if (idx < 0) return false;
    const chat = list[idx];
    // Clear pending flag on the matching user message
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'user' && chat.messages[i].pending) {
        delete chat.messages[i].pending;
        break;
      }
    }
    const msg = { role: 'assistant', content };
    if (modelName) msg.modelName = modelName;
    if (modelProvider) msg.modelProvider = modelProvider;
    chat.messages.push(msg);
    profileSetJSON('history', list);
    return true;
  };

  try {
    let full = '';
    await callChat(model, convoSnapshot, (chunk, done) => {
      full += chunk;
    });

    // SAVE FIRST, RENDER SECOND. History is the authoritative store —
    // never trust the global `messages` array across async boundaries
    // because a chat switch may have replaced it mid-fetch. Always
    // persist the response to the originating chat's history, THEN
    // decide whether to render into the current view.
    const saved = appendAssistantToOriginatingChat(full, model.name, model.provider);
    const stillHere = (currentChatId === originatingChatId);

    if (stillHere) {
      // Re-sync the live messages array from the freshly-saved history
      // so it's guaranteed to include the new assistant reply and have
      // the pending flag cleared on the user msg.
      try {
        const fresh = loadHistory().find(c => c.id === originatingChatId);
        if (fresh) messages = fresh.messages.slice();
      } catch {}

      typingEl.remove();
      const visibleText = stripAIMarkers(full);
      const runnable = extractFirstRunnableBlock(visibleText);
      if (runnable) {
        // Remove the runnable code block from the visible text so it
        // doesn't also render as inline <pre> in the message bubble —
        // ALL executed code lives ONLY in the dropdown strip below the
        // message. Any prose before/after the code block is preserved.
        // Handle \r\n line endings and missing closing fence.
        const withoutCode = visibleText
          .replace(/\r\n/g, '\n')
          .replace(/```(\w+)?\n[\s\S]*?(?:\n```|$)/, '')
          .trim();
        const aiEl = renderAIMessage(model, parseMarkdown(withoutCode || ' '));
        const analysisEl = await runAnalysisBlock(aiEl, runnable);
        // HTML artifacts are terminal — no follow-up. The rendered card
        // IS the result. Don't ask Claude to "explain the empty output"
        // because HTML doesn't run in Piston.
        if (analysisEl && !analysisEl.isHtmlArtifact && currentChatId === originatingChatId) {
          const typing2 = renderTyping(model);
          try {
            const followup = [...messages, {
              role: 'user',
              content: `[code execution result]\n\nStdout:\n${analysisEl.stdout || '(empty)'}${analysisEl.stderr ? `\n\nStderr:\n${analysisEl.stderr}` : ''}\n\nPlease use this result in your explanation. Do not rewrite the same code unless there was an error.`
            }];
            let more = '';
            await callChat(model, followup, (chunk) => { more += chunk; });
            typing2.remove();
            appendAssistantToOriginatingChat(more, model.name, model.provider);
            if (currentChatId === originatingChatId) {
              try {
                const fresh2 = loadHistory().find(c => c.id === originatingChatId);
                if (fresh2) messages = fresh2.messages.slice();
              } catch {}
              renderAIMessage(model, parseMarkdown(stripAIMarkers(more)));
            }
          } catch (e) {
            typing2.remove();
          }
        }
      } else {
        renderAIMessage(model, parseMarkdown(visibleText));
      }
      processAIMarkers(full);
    } else {
      // User navigated away mid-fetch. History already has the reply
      // (saved above). Just notify.
      typingEl.remove();
      const list = loadHistory();
      const origChat = list.find(c => c.id === originatingChatId);
      const title = origChat?.title || 'a previous chat';
      showToast(`Reply ready in "${title.slice(0, 40)}"`);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification('KEMLLM · ' + (model.name || 'AI') + ' replied', {
            body: stripAIMarkers(full).slice(0, 120),
            tag: 'kemllm-bg-' + originatingChatId,
          });
        } catch {}
      }
      renderHistory();
    }
  } catch (e) {
    typingEl.remove();
    if (currentChatId === originatingChatId) {
      renderAIMessage(model, `<p style="color:var(--red)">${escapeHTML(e.message)}</p>`);
    } else {
      console.warn('[KEMLLM] background fetch error in chat', originatingChatId, e);
    }
  } finally {
    setChatBusy(originatingChatId, false);
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
  if (!md) return null;
  // Normalize CRLF so the regex's \n actually matches Claude's output
  md = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Match closed fence OR fence that runs to end of string (partial
  // / still-streaming responses should still be detected as HTML).
  const re = /```(\w+)?\n([\s\S]*?)(?:\n```|$)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const lang = (m[1] || '').toLowerCase();
    const code = m[2] || '';
    if (isRunnable(lang) || lang === 'html' ||
        /^\s*(?:<!doctype\s+html|<html|<body|<head)/i.test(code)) {
      return { lang: lang || (/<html|<body|<!doctype/i.test(code) ? 'html' : ''), code };
    }
  }
  // Raw HTML without any fence at all — treat the whole thing as an HTML artifact.
  if (/^\s*(?:<!doctype\s+html|<html)/i.test(md)) {
    return { lang: 'html', code: md };
  }
  return null;
}

// Detect HTML + interactive-JS apps that should render as a live
// preview (Claude-artifact style) instead of being sent to Piston.
function isInteractiveApp(block) {
  const lang = (block.lang || '').toLowerCase();
  const code = block.code || '';
  if (lang === 'html') return true;
  if (lang === 'javascript' || lang === 'js') {
    // JS that touches the DOM → needs a preview, not a stdout dump
    if (/document\.|window\.|\.innerHTML|getElementById|querySelector|addEventListener|canvas/i.test(code)) return true;
  }
  // Raw HTML without a fence (doctype, <html>, <body>, <head>)
  if (/^\s*(?:<!doctype\s+html|<html|<body|<head)/i.test(code)) return true;
  return false;
}

// Render a slim "code execution strip" directly after the AI message bubble.
// It's collapsed by default — just a thin bar saying "▶ Ran python · 120ms".
// For HTML (and interactive JS apps) we don't run it through Piston —
// we treat it as a Claude-style artifact, show a "Preview ready" strip,
// and open it in the chat-preview pane on click.
async function runAnalysisBlock(aiEl, block) {
  if (!aiEl || !aiEl.parentNode) return null;

  // HTML artifact path — no Piston, just render a Claude-style artifact
  // card in the chat flow and open the preview pane.
  if (block.lang === 'html' || isInteractiveApp(block)) {
    const htmlCode = block.lang === 'html' ? block.code : `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview</title></head><body><script>${block.code}<\/script></body></html>`;
    // Extract title: prefer <title>, then first <h1>, then a default
    let title = 'HTML Artifact';
    const titleMatch = htmlCode.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim();
    else {
      const h1Match = htmlCode.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (h1Match) title = h1Match[1].replace(/&[^;]+;/g, '').trim();
    }
    // Derive a filename from the title
    const filename = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) + '.html';
    // Store the raw source on a hidden attribute so the card can reopen
    // the preview without regenerating the blob every time.
    const cardId = 'art_' + Math.random().toString(36).slice(2, 9);
    window._kemllmArtifacts = window._kemllmArtifacts || {};
    window._kemllmArtifacts[cardId] = { html: htmlCode, title, filename };

    const card = document.createElement('div');
    card.className = 'artifact-card';
    card.dataset.artId = cardId;
    card.innerHTML = `
      <div class="artifact-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
      </div>
      <div class="artifact-body">
        <div class="artifact-title">${escapeHTML(title)}</div>
        <div class="artifact-meta"><span class="artifact-filename">${escapeHTML(filename)}</span><span class="artifact-badge">HTML</span></div>
      </div>
      <button class="artifact-dl" title="Download" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span>Download</span>
      </button>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.artifact-dl')) return;
      openArtifactPreview(cardId);
    });
    card.querySelector('.artifact-dl').addEventListener('click', (e) => {
      e.stopPropagation();
      downloadArtifact(cardId);
    });
    aiEl.parentNode.insertBefore(card, aiEl.nextSibling);
    scrollToBottom();
    // Auto-open the preview the first time
    setTimeout(() => openArtifactPreview(cardId), 200);
    return { stdout: '', stderr: '', exit: 0, isHtmlArtifact: true };
  }

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
  if (!_imgViewerUrl || _imgViewerUrl === 'null' || _imgViewerUrl === 'undefined') {
    showToast('No image to download (the generation may have failed)');
    return;
  }
  try {
    showToast('Downloading…');
    const res = await fetch(_imgViewerUrl);
    if (!res.ok) {
      showToast('Download failed: HTTP ' + res.status);
      return;
    }
    const ct = (res.headers.get('Content-Type') || '').toLowerCase();
    // Refuse to save anything that isn't actually an image — prevents
    // saving the current page's HTML when the URL was bad/null.
    if (!ct.startsWith('image/') && !ct.startsWith('application/octet-stream')) {
      showToast('Download failed: server returned ' + (ct || 'unknown') + ' (not an image)');
      return;
    }
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

// Scoped append: same pattern as sendMessage. If the user is no longer
// looking at the chat where the gen was started, save to history without
// touching the DOM and notify.
function _appendImageResultScoped(originatingChatId, fakeModel, md, modelName, errorIsHtml) {
  if (currentChatId === originatingChatId) {
    renderAIMessage(fakeModel, errorIsHtml ? md : parseMarkdown(md), errorIsHtml ? '' : md);
    if (!errorIsHtml) {
      messages.push({ role: 'assistant', content: md, modelName, modelProvider: 'google' });
      saveCurrentChat();
    }
    return;
  }
  if (errorIsHtml) return; // don't save errors
  const list = loadHistory();
  const idx = list.findIndex(c => c.id === originatingChatId);
  if (idx >= 0) {
    list[idx].messages.push({ role: 'assistant', content: md, modelName, modelProvider: 'google' });
    profileSetJSON('history', list);
    const title = list[idx].title || 'a previous chat';
    showToast(`Image ready in "${title.slice(0, 40)}"`);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('KEMLLM · ' + modelName + ' result', { tag: 'kemllm-bg-' + originatingChatId });
      } catch {}
    }
    if (typeof renderHistory === 'function') renderHistory();
  }
}

async function handleImageRequest(prompt, aspectRatio) {
  const m = findModel(selectedImage, 'image');
  const modelName = m?.name || 'Image';
  const fakeModel = { name: modelName, provider: 'google' };
  const originatingChatId = currentChatId;
  const typingEl = renderTyping(fakeModel);
  try {
    const url = await generateImage(prompt, aspectRatio);
    typingEl.remove();
    const md = `Generated with ${modelName}:\n\n![generated](${url})`;
    _appendImageResultScoped(originatingChatId, fakeModel, md, modelName, false);
  } catch (e) {
    typingEl.remove();
    if (currentChatId === originatingChatId) {
      renderAIMessage(fakeModel, `<p style="color:var(--red)">${escapeHTML(e.message)}</p>`);
    }
  }
}
async function handleEditImageRequest(prompt, imageAttachment, aspectRatio) {
  const sel = (typeof findModel === 'function') ? findModel(selectedImage, 'image') : null;
  const editorName = sel?.name || 'Nano Banana Pro';
  const displayName = 'Image Edit (' + editorName + ')';
  const fakeModel = { name: displayName, provider: 'google' };
  const originatingChatId = currentChatId;
  const typingEl = renderTyping(fakeModel);
  try {
    const sourceUrl = imageAttachment.dataUrl || imageAttachment.url;
    const url = await editImage(prompt, sourceUrl, aspectRatio);
    typingEl.remove();
    const md = `Edited with ${editorName}:\n\n![edited](${url})`;
    _appendImageResultScoped(originatingChatId, fakeModel, md, displayName, false);
  } catch (e) {
    typingEl.remove();
    if (currentChatId === originatingChatId) {
      renderAIMessage(fakeModel, `<p style="color:var(--red)">${escapeHTML(e.message)}</p>`);
    }
  }
}

async function handleVideoRequest(prompt, aspectRatio) {
  const m = findModel(selectedVideo, 'video');
  const modelName = m?.name || 'Video';
  const fakeModel = { name: modelName, provider: 'google' };
  const originatingChatId = currentChatId;
  const typingEl = renderTyping(fakeModel);
  try {
    const url = await generateVideo(prompt, aspectRatio);
    typingEl.remove();
    const md = `Generated with ${modelName}:\n\n<video controls loop src="${url}" style="max-width:520px;border-radius:10px;"></video>`;
    _appendImageResultScoped(originatingChatId, fakeModel, md, modelName, false);
  } catch (e) {
    typingEl.remove();
    if (currentChatId === originatingChatId) {
      renderAIMessage(fakeModel, `<p style="color:var(--red)">${escapeHTML(e.message)}</p>`);
    }
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
  pane.classList.remove('mode-code');
  // Hide the raw-code view by default when loading a new URL
  const codeView = document.getElementById('chat-preview-code');
  if (codeView) codeView.style.display = 'none';
  // Desktop mode: bigger pane (75% of screen instead of 50%). Detect by
  // title (exact match) or by URL containing 'vnc' — both mean noVNC.
  const isDesktop = title === 'AI Desktop' || /vnc(\.html|_lite)/.test(url || '');
  pane.classList.toggle('mode-desktop', isDesktop);
  const audioBtn = document.getElementById('chat-preview-audio');
  if (audioBtn) audioBtn.style.display = isDesktop ? 'inline-block' : 'none';
}

// Open an HTML artifact card's preview in the chat-preview pane.
// Uses the cached raw HTML so we can also switch to "Code" view.
function openArtifactPreview(cardId) {
  const art = (window._kemllmArtifacts || {})[cardId];
  if (!art) return;
  const blob = new Blob([art.html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  chatPreviewShow(url, art.title || 'HTML Preview');
  const pane = document.getElementById('chat-preview');
  if (pane) pane.dataset.artId = cardId;
  // Populate the raw code view too (hidden until user toggles to Code)
  const codeView = document.getElementById('chat-preview-code');
  if (codeView) {
    codeView.innerHTML = '';
    const pre = document.createElement('pre');
    pre.textContent = art.html;
    codeView.appendChild(pre);
  }
}

function downloadArtifact(cardId) {
  const art = (window._kemllmArtifacts || {})[cardId];
  if (!art) return;
  const blob = new Blob([art.html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = art.filename || 'artifact.html';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 500);
}

// Toggle the chat-preview pane between View (iframe) and Code (<pre>)
function chatPreviewToggleMode() {
  const pane = document.getElementById('chat-preview');
  const frame = document.getElementById('chat-preview-frame');
  const codeView = document.getElementById('chat-preview-code');
  const toggleBtn = document.getElementById('chat-preview-toggle');
  if (!pane || !frame || !codeView) return;
  const showCode = !pane.classList.contains('mode-code');
  pane.classList.toggle('mode-code', showCode);
  frame.style.display = showCode ? 'none' : '';
  codeView.style.display = showCode ? 'block' : 'none';
  if (toggleBtn) toggleBtn.textContent = showCode ? 'View' : 'Code';
}

function chatPreviewCopyArtifact() {
  const pane = document.getElementById('chat-preview');
  const cardId = pane?.dataset?.artId;
  const art = cardId ? (window._kemllmArtifacts || {})[cardId] : null;
  if (!art) { showToast('Nothing to copy'); return; }
  navigator.clipboard.writeText(art.html).then(() => showToast('HTML copied'));
}

function chatPreviewDownloadArtifact() {
  const pane = document.getElementById('chat-preview');
  const cardId = pane?.dataset?.artId;
  if (cardId) downloadArtifact(cardId);
}
function chatPreviewClose() {
  const pane = document.getElementById('chat-preview');
  const frame = document.getElementById('chat-preview-frame');
  if (pane) { pane.classList.remove('show'); pane.classList.remove('fullscreen'); }
  if (frame) frame.src = 'about:blank';
  // Tear down any running audio stream so ffmpeg on the backend can exit.
  const audioEl = document.getElementById('chat-preview-audio-el');
  const audioBtn = document.getElementById('chat-preview-audio');
  if (audioEl) { audioEl.pause(); audioEl.src = ''; audioEl.removeAttribute('src'); }
  if (audioBtn) { audioBtn.textContent = '🔇'; audioBtn.dataset.on = '0'; audioBtn.style.display = 'none'; }
}

// Toggle desktop audio streaming. First click starts an <audio> element
// pointed at /api/audio (ffmpeg → mp3) which plays through the browser.
function togglePreviewAudio() {
  const btn = document.getElementById('chat-preview-audio');
  const el = document.getElementById('chat-preview-audio-el');
  if (!btn || !el) return;
  const base = typeof getHfBackendUrl === 'function' ? getHfBackendUrl() : '';
  const tok = typeof getHfBackendToken === 'function' ? getHfBackendToken() : '';
  if (!base) { showToast('No HF backend configured'); return; }
  if (btn.dataset.on === '1') {
    el.pause();
    el.src = '';
    el.removeAttribute('src');
    btn.textContent = '🔇 Audio';
    btn.dataset.on = '0';
    btn.title = 'Enable desktop audio';
  } else {
    el.src = `${base}/api/audio?token=${encodeURIComponent(tok)}`;
    el.play().then(() => {
      btn.textContent = '🔊 Audio';
      btn.dataset.on = '1';
      btn.title = 'Disable desktop audio';
    }).catch((e) => {
      showToast('Audio failed: ' + (e.message || e));
    });
  }
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
  // If the AI emitted BOTH a GENERATE_IMAGE and an EDIT_IMAGE marker in
  // the same response, EDIT_IMAGE wins. The model is confused and we
  // don't want to fire two image jobs (the GENERATE attempt almost always
  // fails when there's an attached image to edit).
  const hasEditMarker = /\[EDIT_IMAGE\s+/i.test(text);

  // [GENERATE_IMAGE prompt="..." aspect_ratio="16:9"] — AI-triggered image gen.
  // aspect_ratio is optional. Supported values: 1:1, 16:9, 9:16, 4:3, 3:4,
  // 21:9, 3:2, 2:3 (and anything else the underlying model accepts).
  const genImgRe = /\[GENERATE_IMAGE\s+([^\]]+)\]/i;
  const gi = !hasEditMarker ? text.match(genImgRe) : null;
  if (gi) {
    const args = gi[1];
    const promptMatch = args.match(/prompt=(?:"([^"]+)"|'([^']+)')/i);
    const arMatch = args.match(/aspect_ratio=(?:"([^"]+)"|'([^']+)'|([^\s\]]+))/i);
    const prompt = (promptMatch?.[1] || promptMatch?.[2] || '').trim();
    const aspectRatio = (arMatch?.[1] || arMatch?.[2] || arMatch?.[3] || '').trim() || null;
    if (prompt) handleImageRequest(prompt, aspectRatio);
  }
  // [GENERATE_VIDEO prompt="..." aspect_ratio="16:9"]
  const genVidRe = /\[GENERATE_VIDEO\s+([^\]]+)\]/i;
  const gv = text.match(genVidRe);
  if (gv) {
    const args = gv[1];
    const promptMatch = args.match(/prompt=(?:"([^"]+)"|'([^']+)')/i);
    const arMatch = args.match(/aspect_ratio=(?:"([^"]+)"|'([^']+)'|([^\s\]]+))/i);
    const prompt = (promptMatch?.[1] || promptMatch?.[2] || '').trim();
    const aspectRatio = (arMatch?.[1] || arMatch?.[2] || arMatch?.[3] || '').trim() || null;
    if (prompt) handleVideoRequest(prompt, aspectRatio);
  }
  // [EDIT_IMAGE prompt="..." aspect_ratio="..."] — edit the most recent image.
  // Looks in BOTH directions: (1) any image attachment on the most recent user
  // message (this is how "attach a photo, say 'make it blue'" works),
  // and (2) any generated/edited image embedded as markdown in the
  // chat history (how "now change the sky" on a previously-generated
  // image works). Attachments win — they're more recent.
  const editImgRe = /\[EDIT_IMAGE\s+([^\]]+)\]/i;
  const ei = text.match(editImgRe);
  if (ei) {
    const args = ei[1];
    const promptMatch = args.match(/prompt=(?:"([^"]+)"|'([^']+)')/i);
    const arMatch = args.match(/aspect_ratio=(?:"([^"]+)"|'([^']+)'|([^\s\]]+))/i);
    const prompt = (promptMatch?.[1] || promptMatch?.[2] || '').trim();
    const aspectRatio = (arMatch?.[1] || arMatch?.[2] || arMatch?.[3] || '').trim() || null;
    let source = null;
    // 1) Most recent attachment (data URL from a user upload)
    for (let i = messages.length - 1; i >= 0; i--) {
      const atts = messages[i].attachments || [];
      const imgAtt = atts.find(a => a && (a.isImage || (a.mime || '').startsWith('image/')));
      if (imgAtt && imgAtt.dataUrl) {
        source = { dataUrl: imgAtt.dataUrl, isImage: true };
        break;
      }
    }
    // 2) Fallback: markdown image URL anywhere in the conversation
    if (!source) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const c = messages[i].content;
        if (typeof c === 'string') {
          const im = c.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
          if (im) { source = { url: im[1], isImage: true }; break; }
        }
      }
    }
    if (prompt && source) {
      handleEditImageRequest(prompt, source, aspectRatio);
    } else if (prompt && !source) {
      showToast('Edit requested but no image in the conversation to edit');
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
// Two-layout desktop detection:
//   NEW layout  = nginx front door, noVNC at /vnc.html, Flask at /api/*
//   OLD layout  = Flask at root, noVNC (if any) proxied via /desktop/*
// Returns { path, layout } where path is the iframe URL to load.
async function detectDesktopLayout(base) {
  // quality=6 compression=2 = tightly-compressed JPEG, visually identical
  // to quality=9 but ~3-4x smaller frames (huge bandwidth win). resize=scale
  // fits iframe; reconnect=1 auto-reconnects. On HF Pro with 1920x1080 the
  // default quality=9 was saturating the network; quality=6 is the sweet
  // spot between visual quality and smoothness.
  const NEW_PARAMS = 'autoconnect=1&resize=scale&reconnect=1&quality=6&compression=2';
  const OLD_PARAMS = 'path=desktop/websockify&autoconnect=1&resize=scale&quality=6&compression=2';
  // Try NEW layout first — noVNC at the root.
  try {
    const r = await fetch(base + '/vnc.html', { method: 'GET' });
    if (r.ok) {
      const body = await r.text().catch(() => '');
      if (body.includes('noVNC') || body.includes('novnc') || body.includes('vnc_canvas')) {
        return { layout: 'new', path: '/vnc.html?' + NEW_PARAMS };
      }
    }
  } catch {}
  // Fall back to OLD layout — Flask proxy at /desktop/.
  try {
    const r = await fetch(base + '/desktop/vnc.html', { method: 'GET' });
    if (r.ok) {
      const body = await r.text().catch(() => '');
      if (body.includes('noVNC') || body.includes('novnc') || body.includes('vnc_canvas')) {
        return { layout: 'old', path: '/desktop/vnc.html?' + OLD_PARAMS };
      }
    }
  } catch {}
  return null;
}

async function probeDesktopSupport() {
  const btn = document.getElementById('chat-desktop-btn');
  if (!btn) return;
  const base = getHfBackendUrl();
  const hide = () => {
    btn.dataset.desktopReady = '0';
    btn.classList.remove('show');
    btn.classList.remove('active');
  };
  if (!base) return hide();
  const detected = await detectDesktopLayout(base);
  if (detected) {
    btn.dataset.desktopReady = '1';
    btn.dataset.desktopLayout = detected.layout;
    btn.dataset.desktopPath = detected.path;
    _desktopProbedOnce = true;
    if (chatMode === 'agent') btn.classList.add('show');
  } else {
    hide();
  }
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
      // Try the Flask health endpoint at /api/ first (new nginx layout),
      // then fall back to / (old slim Dockerfile with Flask at root).
      const r = await fetch(base + '/api/', { method: 'GET' });
      if (r.ok) {
        const d = await r.json().catch(() => null);
        if (d && d.ok) return true;
      }
      const r2 = await fetch(base + '/', { method: 'GET' });
      if (r2.ok) {
        const ct = r2.headers.get('Content-Type') || '';
        // Either the old Flask health JSON, OR noVNC HTML from the new
        // layout — both mean the Space is up.
        if (ct.includes('application/json')) {
          const d = await r2.json().catch(() => null);
          if (d && d.ok) return true;
        } else if (ct.includes('text/html')) {
          return true;
        }
      }
    } catch {}
    await new Promise(res => setTimeout(res, 2000));
  }
  return false;
}

async function showAgentDesktop() {
  const home = document.getElementById('home-screen');
  if (home) home.classList.add('hidden');
  if (typeof termBootStop === 'function') termBootStop();

  const base = getHfBackendUrl();
  if (!base) { showToast('Set the HF backend URL in Settings first'); return; }

  // Step 1: make sure the Space is awake.
  const p = renderProgressLine('checking HF Space…');
  let ready = false;
  try {
    const quick = await Promise.race([
      fetch(base + '/vnc.html').then(r => r.ok),
      new Promise(res => setTimeout(() => res(false), 2500)),
    ]);
    ready = quick === true;
  } catch {}
  if (!ready) {
    ready = await waitForHFReady(base, getHfBackendToken(), 90, p);
    if (!ready) {
      p.fail('HF Space did not come online after 90s. Check the Logs tab on your Space — it may still be rebuilding or the build may have failed.');
      return;
    }
  }
  p.done('HF Space is up', '✓');

  // Step 2: auto-detect which container layout we're talking to.
  const pc = renderProgressLine('detecting noVNC layout…');
  const detected = await detectDesktopLayout(base);
  if (!detected) {
    pc.fail('noVNC not reachable at / or /desktop/. Your HF Space is either still rebuilding, running the SLIM Dockerfile (no desktop), or the build failed — check the Logs tab on the Space.');
    return;
  }
  pc.done(`noVNC layout: ${detected.layout}`, '✓');

  // Step 3: load the iframe with whichever path the detection found.
  const url = base + detected.path;
  chatPreviewShow(url, 'AI Desktop');
  renderSystemLine('🖥 desktop loaded — tap and drag in the preview to interact. If it stays blank, open the URL in a new tab to debug: ' + url);
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

function newChat(skipHash) {
  // If an agent loop is running, stop it cleanly first
  if (agentLoopRunning) {
    agentLoopAbort = true;
  }
  messages = [];
  currentChatId = null;
  pendingAttachments = [];
  agentInjectQueue = [];
  renderAttachPreview();
  const msgsEl = document.getElementById('msgs');
  if (msgsEl) {
    msgsEl.innerHTML = '';
    // Also purge any stray agent-log lines that leaked in from a
    // previous sandbox start. Defense in depth on top of the agentLog
    // guard in agent.js.
    msgsEl.querySelectorAll('.agent-log').forEach(el => el.remove());
  }
  const home = document.getElementById('home-screen');
  if (home) home.classList.remove('hidden');
  if (window.termBootStart) window.termBootStart();
  closeDrawer();
  // Make sure we're on the chat panel (so the home screen is visible and
  // the music plays — music only runs when currentPanel === 'chat').
  if (typeof siNav === 'function' && currentPanel !== 'chat') {
    siNav('chat', !!skipHash);
  }
  // Close any open preview pane from a previous chat
  if (typeof chatPreviewClose === 'function') chatPreviewClose();
  // Clear any stuck highlight on the old chat in the sidebar / history list
  if (typeof renderHistory === 'function') renderHistory();
  // Push URL #/chat (no chat id) so back button returns to "new chat"
  if (!skipHash && typeof setHashForPanel === 'function') {
    setHashForPanel('chat', null);
  }
  document.title = 'KEMLLM · Chat';
  if (typeof refreshBusyUI === 'function') refreshBusyUI();
  if (typeof syncHomeMusic === 'function') syncHomeMusic();
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
