// ========== KEMLLM Chat System ==========
'use strict';

let messages = [];
let currentChatId = null;
let pendingAttachments = []; // {dataUrl, name}
let abortCtrl = null;
window.webSearchOn = false;
let chatMode = 'chat'; // 'chat' | 'code' | 'agent'
let agentUnlocked = false;

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

  // AGENT MODE: route through the agent flow instead
  if (chatMode === 'agent') {
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

  // Check image/video routing
  if (IMG_REGEX.test(text)) {
    return handleImageRequest(text);
  }
  if (VID_REGEX.test(text)) {
    return handleVideoRequest(text);
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

// Agent mode inline in chat — uses the agent backend/pyodide for command execution,
// renders output as an inline analysis block, then continues the AI response.
async function runAgentModeChat(userText) {
  if (!agentReady) {
    // Try to boot it (HF backend if configured, otherwise Pyodide)
    await agentStart();
    if (!agentReady) {
      const model = findModel(selectedChat, 'chat');
      renderAIMessage(model || { name: 'Agent', provider: 'custom' },
        '<p style="color:var(--red)">Could not start agent sandbox.</p>');
      return;
    }
  }
  const model = findModel(selectedChat, 'chat');
  if (!model) { showToast('No model selected'); return; }

  const agentSys = getAgentSystemPrompt();
  const typingEl = renderTyping(model);
  try {
    let full = '';
    await callChat(model, messages, (chunk) => { full += chunk; }, agentSys);
    typingEl.remove();
    renderAIMessage(model, parseMarkdown(full), full);
    messages.push({ role: 'assistant', content: full });

    // Execute any bash/python blocks the AI wrote, feed results back once
    const blocks = extractRunnableBlocks(full);
    if (blocks.length) {
      let combined = '';
      for (const b of blocks) {
        const r = await agentRun(b.content, true, true); // silent=true, we render inline
        const aiMsgEl = document.querySelector('#msgs .msg-a:last-child .ai-body');
        if (aiMsgEl) {
          const det = document.createElement('details');
          det.className = 'think-block';
          det.open = true;
          const stdout = r.stdout || '';
          const stderr = r.stderr || '';
          det.innerHTML = `<summary>▶ Ran ${escapeHTML(b.lang)} · exit ${r.exitCode}</summary><div class="think-inner">${stdout ? '<div>' + escapeHTML(stdout) + '</div>' : ''}${stderr ? '<div style="color:var(--red);margin-top:6px;">' + escapeHTML(stderr) + '</div>' : ''}${!stdout && !stderr ? '<div style="color:var(--text3);">(no output)</div>' : ''}</div>`;
          aiMsgEl.appendChild(det);
          setTimeout(() => { det.open = false; }, 1500);
        }
        combined += '\n$ ' + b.content + '\n' + stdout + (stderr ? '\n[stderr]\n' + stderr : '') + (r.exitCode ? `\n[exit ${r.exitCode}]` : '');
      }
      messages.push({ role: 'user', content: '[execution results]\n' + combined.trim() });
      const typing2 = renderTyping(model);
      try {
        let more = '';
        await callChat(model, messages, (chunk) => { more += chunk; }, agentSys);
        typing2.remove();
        renderAIMessage(model, parseMarkdown(more), more);
        messages.push({ role: 'assistant', content: more });
      } catch (e) {
        typing2.remove();
        renderAIMessage(model, `<p style="color:var(--red)">${escapeHTML(e.message)}</p>`);
      }
    }
  } catch (e) {
    typingEl.remove();
    renderAIMessage(model, `<p style="color:var(--red)">${escapeHTML(e.message)}</p>`);
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
function addAttachment(file) {
  if (!file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = e => {
    pendingAttachments.push({ dataUrl: e.target.result, name: file.name });
    renderAttachPreview();
  };
  reader.readAsDataURL(file);
}
function removeAttachment(idx) {
  pendingAttachments.splice(idx, 1);
  renderAttachPreview();
}
function renderAttachPreview() {
  const el = document.getElementById('attach-preview');
  if (!el) return;
  el.innerHTML = pendingAttachments.map((a, i) =>
    `<div class="attach-wrap"><img class="attach-thumb" src="${a.dataUrl}"><button class="attach-x" onclick="removeAttachment(${i})">×</button></div>`
  ).join('');
}
