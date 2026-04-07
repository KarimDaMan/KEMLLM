// ========== KEMLLM Chat System ==========
'use strict';

let messages = [];
let currentChatId = null;
window.webSearchOn = false;

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
    return `<pre><div class="codewrap" data-lang="${escapeHTML(b.lang)}"><div class="code-head"><span class="code-lang">${escapeHTML(b.lang || 'text')}</span><div class="code-acts"><button class="code-act" onclick="copyCode('${id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy</button>${isRunnable(b.lang) ? `<button class="code-act" onclick="runCodeBlock('${id}','${escapeHTML(b.lang)}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>Run</button>` : ''}</div></div><code id="${id}">${escapeHTML(b.code)}</code></div></pre>`;
  });
  return html;
}

function copyCode(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent);
  showToast('Copied');
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

function renderUserMessage(text) {
  const msgs = document.getElementById('msgs');
  const div = document.createElement('div');
  div.className = 'msg msg-u';
  div.innerHTML = `<div class="bubble">${escapeHTML(text)}</div>`;
  msgs.appendChild(div);
  scrollToBottom();
}

function renderAIMessage(model, contentHTML) {
  const msgs = document.getElementById('msgs');
  const div = document.createElement('div');
  div.className = 'msg msg-a';
  const color = PROVIDER_COLORS[model.provider] || PROVIDER_COLORS.custom;
  div.innerHTML = `<div class="ai-dot" style="background:${color}"></div><div class="ai-body"><div class="ai-tag">${escapeHTML(model.name)}</div><div class="ai-txt">${contentHTML}</div></div>`;
  msgs.appendChild(div);
  scrollToBottom();
  return div;
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
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';

  // Hide terminal animation forever
  const home = document.getElementById('home-screen');
  if (home) home.classList.add('hidden');
  if (window.termBootStop) window.termBootStop();

  messages.push({ role: 'user', content: text });
  renderUserMessage(text);

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

function newChat() {
  messages = [];
  currentChatId = null;
  document.getElementById('msgs').innerHTML = '';
  const home = document.getElementById('home-screen');
  if (home) home.classList.remove('hidden');
  if (window.termBootStart) window.termBootStart();
  closeDrawer();
}
