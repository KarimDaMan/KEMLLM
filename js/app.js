// ========== KEMLLM App Init / History / Boot Animation ==========
'use strict';

// ===== Chat history =====
function loadHistory() {
  return profileGetJSON('history', []);
}
// Strip attachment payloads before persisting to localStorage — data URLs
// for images/PDFs can be megabytes each and will blow the ~5MB quota.
// We keep lightweight metadata (name, size, mime) so the UI can show
// a chip on reload, but the actual bytes are dropped.
function stripAttachmentPayloads(msgs) {
  return msgs.map(m => {
    if (!m.attachments || !m.attachments.length) return m;
    return {
      ...m,
      attachments: m.attachments.map(a => ({
        name: a.name,
        size: a.size,
        mime: a.mime,
        isImage: a.isImage,
      }))
    };
  });
}

function saveCurrentChat() {
  if (!messages.length) return;
  let list = loadHistory();
  const slim = stripAttachmentPayloads(messages);
  if (!currentChatId) {
    currentChatId = 'c_' + Date.now();
    const rawTitle = messages[0]?.content;
    const title = (typeof rawTitle === 'string' ? rawTitle : 'New chat').slice(0, 50);
    list.unshift({ id: currentChatId, title, messages: slim, ts: Date.now() });
    if (list.length > 60) list = list.slice(0, 60);
  } else {
    const idx = list.findIndex(c => c.id === currentChatId);
    if (idx >= 0) list[idx].messages = slim;
  }
  try {
    profileSetJSON('history', list);
  } catch (e) {
    // Quota exceeded — drop oldest chats until it fits
    while (list.length > 1) {
      list.pop();
      try {
        profileSetJSON('history', list);
        showToast('Dropped oldest chats (storage full)');
        break;
      } catch {}
    }
  }
  renderHistory();
}
function renderHistory() {
  const list = loadHistory();
  // Sidebar: top 15 inline
  const sb = document.getElementById('sb-chats');
  if (sb) {
    if (!list.length) {
      sb.innerHTML = '<div class="sb-empty">No chats yet</div>';
    } else {
      sb.innerHTML = list.slice(0, 15).map(c => `<div class="sb-chat${c.id === currentChatId ? ' active' : ''}" onclick="loadChat('${c.id}')"><div class="sb-chat-txt">${escapeHTML(c.title)}</div><button class="sb-chat-del" onclick="event.stopPropagation();deleteChat('${c.id}')">×</button></div>`).join('');
    }
    const viewall = document.getElementById('sb-viewall');
    if (viewall) viewall.style.display = list.length > 15 ? 'block' : 'none';
  }
  // Modal: full list
  const el = document.getElementById('hist-list');
  if (el) {
    if (!list.length) {
      el.innerHTML = '<div style="font-size:11px;color:var(--text3);text-align:center;padding:14px 8px;">No chats yet</div>';
    } else {
      el.innerHTML = list.map(c => `<div class="hi${c.id === currentChatId ? ' active' : ''}" onclick="loadChat('${c.id}')"><div class="hi-txt">${escapeHTML(c.title)}</div><button class="hi-del" onclick="event.stopPropagation();deleteChat('${c.id}')">×</button></div>`).join('');
    }
  }
}
function loadChat(id) {
  const list = loadHistory();
  const c = list.find(x => x.id === id);
  if (!c) return;
  currentChatId = id;
  messages = c.messages.slice();
  document.getElementById('msgs').innerHTML = '';
  const home = document.getElementById('home-screen');
  if (home) home.classList.add('hidden');
  if (window.termBootStop) window.termBootStop();
  messages.forEach(m => {
    if (m.role === 'user') {
      renderUserMessage(typeof m.content === 'string' ? m.content : '', m.attachments);
    } else {
      // Use the message's saved modelName if it has one (image/video/edit
      // results carry the actual generator name), otherwise fall back to
      // the current chat model.
      const fallbackChatModel = findModel(selectedChat, 'chat') || { name: 'AI', provider: 'custom' };
      const model = m.modelName
        ? { name: m.modelName, provider: m.modelProvider || fallbackChatModel.provider }
        : fallbackChatModel;
      // Strip generation markers (GENERATE_IMAGE / EDIT_IMAGE / etc) so
      // they don't show as raw text on reload. saveCurrentChat persists
      // the full marker-containing text for replay purposes, but the
      // rendered view should match what the user originally saw.
      const raw = typeof m.content === 'string' ? m.content : '';
      const visible = (typeof stripAIMarkers === 'function') ? stripAIMarkers(raw) : raw;
      renderAIMessage(model, parseMarkdown(visible), raw);
    }
  });
  renderHistory();
  closeDrawer();
  siNav('chat');
}
function deleteChat(id) {
  let list = loadHistory();
  list = list.filter(c => c.id !== id);
  profileSetJSON('history', list);
  if (currentChatId === id) newChat();
  renderHistory();
}

// ===== Background response auto-resume =====
// If the user sent a message and then closed the tab / put the laptop
// to sleep / navigated away before the AI replied, the user message
// gets persisted to history with pending=true (set by sendMessage just
// before it calls callChat). On the next app load we scan every chat
// for pending messages and re-fire callChat to finish the response.
// The browser request that the original tab launched is dead, so this
// genuinely re-runs the model — not free, but the only way without a
// server-side queue.
async function resumePendingResponses() {
  if (typeof loadHistory !== 'function' || typeof callChat !== 'function') return;
  const list = loadHistory();
  if (!list || !list.length) return;

  // Find the (chatId, messageIndex) pairs that need a reply
  const pendingJobs = [];
  for (const c of list) {
    if (!c.messages) continue;
    for (let i = 0; i < c.messages.length; i++) {
      const m = c.messages[i];
      if (m.role === 'user' && m.pending) {
        // Skip if it's already been answered (next message is assistant)
        const next = c.messages[i + 1];
        if (next && next.role === 'assistant') continue;
        pendingJobs.push({ chatId: c.id, messageIndex: i });
      }
    }
  }
  if (!pendingJobs.length) return;

  showToast(`Resuming ${pendingJobs.length} background ${pendingJobs.length === 1 ? 'response' : 'responses'}…`);
  // Ask for notification permission so we can alert when each one finishes
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch {}
  }

  for (const job of pendingJobs) {
    try {
      // Reload the freshest version of the chat (in case another process
      // already finished it)
      const fresh = loadHistory().find(x => x.id === job.chatId);
      if (!fresh) continue;
      const userMsg = fresh.messages[job.messageIndex];
      if (!userMsg || !userMsg.pending) continue;
      const next = fresh.messages[job.messageIndex + 1];
      if (next && next.role === 'assistant') continue;

      // Use whatever chat model is currently selected. We don't save the
      // model with the user message (yet), so default to the active one.
      const model = findModel(selectedChat, 'chat');
      if (!model) continue;

      // Build the conversation up to and including the pending user msg
      const convo = fresh.messages.slice(0, job.messageIndex + 1).map(m => ({
        role: m.role,
        content: m.content,
        attachments: m.attachments,
      }));

      let full = '';
      await callChat(model, convo, (chunk) => { full += chunk; });

      // Append assistant response and persist
      const finalList = loadHistory();
      const idx = finalList.findIndex(x => x.id === job.chatId);
      if (idx < 0) continue;
      const finalChat = finalList[idx];
      // Re-find the user message in case indices changed
      const reIdx = finalChat.messages.findIndex((m, i) =>
        i === job.messageIndex && m.role === 'user' && m.pending
      );
      if (reIdx < 0) continue;
      delete finalChat.messages[reIdx].pending;
      // Insert the assistant reply right after
      finalChat.messages.splice(reIdx + 1, 0, { role: 'assistant', content: full });
      profileSetJSON('history', finalList);

      // Notify the user
      const preview = full.replace(/\s+/g, ' ').slice(0, 100);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification('KEMLLM · ' + (model.name || 'AI') + ' replied', {
            body: preview,
            icon: '/favicon.ico',
            tag: 'kemllm-bg-' + job.chatId,
          });
        } catch {}
      }

      // If this is the chat the user is currently looking at, refresh it
      if (currentChatId === job.chatId) {
        loadChat(job.chatId);
      }
    } catch (e) {
      console.warn('[KEMLLM] resume failed for', job, e);
    }
  }
  renderHistory();
}

// ===== Stars (removed) =====
function createStars() { /* stars disabled per spec */ }

// Build version — bumped on every commit. Shown in console + toast on load
// so you can tell at a glance whether you're on the latest JS.
const KEMLLM_BUILD = 'v96 · fix broken image + HTML download bug — generateImage and editImage now POLL the prediction past Replicate Prefer:wait timeout (was returning null URL for slow models like Nano Banana Pro). New extractOutputUrl handles all output shapes (string, array, FileOutput object). downloadImageFromViewer refuses to save non-image content-types so it never writes HTML.';

// ===== Terminal Boot Animation =====
let bootRunning = false;
let bootTimeouts = [];
function termBootStart() {
  const term = document.getElementById('term-boot');
  if (!term) return;
  bootRunning = true;
  runBootCycle();
}
window.termBootStart = termBootStart;

function termBootStop() {
  bootRunning = false;
  bootTimeouts.forEach(t => clearTimeout(t));
  bootTimeouts = [];
  const term = document.getElementById('term-boot');
  if (term) term.classList.add('fade');
}
window.termBootStop = termBootStop;

function bootSchedule(fn, delay) {
  const t = setTimeout(() => { if (bootRunning) fn(); }, delay);
  bootTimeouts.push(t);
}

const BOOT_LINES = [
  { text: '/– booting KEMLLM runtime v1.0.0', cls: 'tb-blue' },
  { text: '/– loading config from ~/.kemllm/config.toml', cls: 'tb-grey' },
  { text: '/– connecting to Replicate API', cls: 'tb-blue', spin: true },
  { text: '/– connecting to Piston sandbox', cls: 'tb-blue', spin: true },
  { text: '/– negotiating WebSocket transport     [OK]', cls: 'tb-green' },
  { text: '/– loading provider adapters', cls: 'tb-blue' },
  { text: '   → anthropic      (auto)', cls: 'tb-white', stagger: true },
  { text: '   → openai         (auto)', cls: 'tb-white', stagger: true },
  { text: '   → google.ai      (auto)', cls: 'tb-white', stagger: true },
  { text: '   → xai            (auto)', cls: 'tb-white', stagger: true },
  { text: '   → meta           (replicate)', cls: 'tb-white', stagger: true },
  { text: '   → mistral        (replicate)', cls: 'tb-white', stagger: true },
  { text: '   → deepseek       (replicate)', cls: 'tb-white', stagger: true },
  { text: '   → replicate      (fallback)', cls: 'tb-white', stagger: true },
  { text: '/– importing chat models', cls: 'tb-blue' },
  { text: '   Anthropic/Claude-Opus-4.6', cls: 'tb-white', stagger: true },
  { text: '   Anthropic/Claude-Sonnet-4.6', cls: 'tb-white', stagger: true },
  { text: '   Anthropic/Claude-Sonnet-4.5', cls: 'tb-white', stagger: true },
  { text: '   Anthropic/Claude-Haiku-4.5', cls: 'tb-white', stagger: true },
  { text: '   OpenAI/GPT-5.4', cls: 'tb-white', stagger: true },
  { text: '   OpenAI/GPT-5.4-Mini', cls: 'tb-white', stagger: true },
  { text: '   OpenAI/GPT-5.4-Nano', cls: 'tb-white', stagger: true },
  { text: '   OpenAI/GPT-5.3-Codex', cls: 'tb-white', stagger: true },
  { text: '   OpenAI/GPT-5.2', cls: 'tb-white', stagger: true },
  { text: '   OpenAI/GPT-5', cls: 'tb-white', stagger: true },
  { text: '   OpenAI/GPT-4.1', cls: 'tb-white', stagger: true },
  { text: '   OpenAI/GPT-4o', cls: 'tb-white', stagger: true },
  { text: '   Google/Gemini-3.1-Pro', cls: 'tb-white', stagger: true },
  { text: '   Google/Gemini-3-Flash', cls: 'tb-white', stagger: true },
  { text: '   Google/Gemini-3.1-Flash-Lite', cls: 'tb-white', stagger: true },
  { text: '   Google/Gemini-2.5-Pro', cls: 'tb-white', stagger: true },
  { text: '   Google/Gemini-2.5-Flash', cls: 'tb-white', stagger: true },
  { text: '   xAI/Grok-4.20', cls: 'tb-white', stagger: true },
  { text: '   xAI/Grok-4-Heavy', cls: 'tb-white', stagger: true },
  { text: '   xAI/Grok-4.1', cls: 'tb-white', stagger: true },
  { text: '   xAI/Grok-4.1-Fast', cls: 'tb-white', stagger: true },
  { text: '   xAI/Grok-4', cls: 'tb-white', stagger: true },
  { text: '   xAI/Grok-3', cls: 'tb-white', stagger: true },
  { text: '   xAI/Grok-3-Mini', cls: 'tb-white', stagger: true },
  { text: '   xAI/Grok-2', cls: 'tb-white', stagger: true },
  { text: '   Meta/Llama-3.3-70B', cls: 'tb-white', stagger: true },
  { text: '   Meta/Llama-3.1-405B', cls: 'tb-white', stagger: true },
  { text: '   Mistral/Mistral-7B-Instruct', cls: 'tb-white', stagger: true },
  { text: '   DeepSeek/R1', cls: 'tb-white', stagger: true },
  { text: '/– importing image models', cls: 'tb-blue' },
  { text: '   Google/NanoBanana-Pro', cls: 'tb-white', stagger: true },
  { text: '   Google/NanoBanana-2', cls: 'tb-white', stagger: true },
  { text: '   Google/NanoBanana', cls: 'tb-white', stagger: true },
  { text: '   Google/Imagen-4-Ultra', cls: 'tb-white', stagger: true },
  { text: '   Google/Imagen-4', cls: 'tb-white', stagger: true },
  { text: '   Google/Imagen-4-Fast', cls: 'tb-white', stagger: true },
  { text: '   Google/Imagen-3', cls: 'tb-white', stagger: true },
  { text: '   OpenAI/GPT-Image-1.5', cls: 'tb-white', stagger: true },
  { text: '   OpenAI/GPT-Image-1-Mini', cls: 'tb-white', stagger: true },
  { text: '   OpenAI/DALL-E-3', cls: 'tb-white', stagger: true },
  { text: '   OpenAI/DALL-E-2', cls: 'tb-white', stagger: true },
  { text: '   Stability/SD-3.5-Large', cls: 'tb-white', stagger: true },
  { text: '   Stability/SD-3.5-Turbo', cls: 'tb-white', stagger: true },
  { text: '   Stability/SD-3-Medium', cls: 'tb-white', stagger: true },
  { text: '   Stability/SDXL', cls: 'tb-white', stagger: true },
  { text: '   BlackForestLabs/FLUX-1.1-Pro-Ultra', cls: 'tb-white', stagger: true },
  { text: '   BlackForestLabs/FLUX-1.1-Pro', cls: 'tb-white', stagger: true },
  { text: '   BlackForestLabs/FLUX-Pro', cls: 'tb-white', stagger: true },
  { text: '   BlackForestLabs/FLUX-Dev', cls: 'tb-white', stagger: true },
  { text: '   BlackForestLabs/FLUX-Schnell', cls: 'tb-white', stagger: true },
  { text: '   Ideogram/V3', cls: 'tb-white', stagger: true },
  { text: '   Ideogram/V2-Turbo', cls: 'tb-white', stagger: true },
  { text: '/– importing video models', cls: 'tb-blue' },
  { text: '   Google/Veo-3', cls: 'tb-white', stagger: true },
  { text: '   Google/Veo-2', cls: 'tb-white', stagger: true },
  { text: '   Runway/Gen-4-Turbo', cls: 'tb-white', stagger: true },
  { text: '   Runway/Gen-4', cls: 'tb-white', stagger: true },
  { text: '   Runway/Gen-3-Alpha-Turbo', cls: 'tb-white', stagger: true },
  { text: '   Minimax/Video-01', cls: 'tb-white', stagger: true },
  { text: '   Kling/1.6-Pro', cls: 'tb-white', stagger: true },
  { text: '   Lightricks/LTX-Video', cls: 'tb-white', stagger: true },
  { text: '/– registering code runtimes', cls: 'tb-blue' },
  { text: '   python 3.12 · node 18 · typescript · c · c++ · rust · go · java · c# · bash · lua', cls: 'tb-grey', stagger: true },
  { text: '   github · gdrive · gmail · gcal · notion · slack · spotify · perplexity', cls: 'tb-grey', stagger: true },
  { text: '/– running self-checks', cls: 'tb-blue' },
  { text: '   latency        12ms    [OK]', cls: 'tb-green', stagger: true },
  { text: '   sandbox        ready   [OK]', cls: 'tb-green', stagger: true },
  { text: '   streaming      ready   [OK]', cls: 'tb-green', stagger: true },
  { text: '   context window 200k    [OK]', cls: 'tb-green', stagger: true },
  { text: '   rate limits    nominal [OK]', cls: 'tb-green', stagger: true },
  { text: '/– all systems nominal ✓', cls: 'tb-green' },
  { text: '/– type to chat _', cls: 'tb-blue' }
];

function runBootCycle() {
  const term = document.getElementById('term-boot');
  if (!term || !bootRunning) return;
  term.classList.remove('fade');
  term.innerHTML = '';
  let delay = 0;
  BOOT_LINES.forEach((line, idx) => {
    bootSchedule(() => {
      const div = document.createElement('div');
      div.className = 'tb-line ' + line.cls;
      term.appendChild(div);
      typewriter(div, line.text, 14, line.spin);
    }, delay);
    delay += line.stagger ? 90 : (line.text.length * 14 + 160);
  });
  bootSchedule(() => {
    term.classList.add('fade');
    bootSchedule(() => {
      if (bootRunning) runBootCycle();
    }, 1200);
  }, delay + 1800);
}

function typewriter(el, text, speed, withSpinner) {
  let i = 0;
  const spinChars = ['|', '/', '-', '\\'];
  let spinIdx = 0;
  const tick = () => {
    if (!bootRunning) return;
    if (i < text.length) {
      el.textContent = text.slice(0, i + 1);
      i++;
      bootSchedule(tick, speed);
    } else {
      if (withSpinner) {
        let count = 0;
        const spin = () => {
          if (!bootRunning || count > 5) return;
          el.textContent = text + ' ' + spinChars[spinIdx++ % 4];
          count++;
          bootSchedule(spin, 80);
        };
        spin();
      }
    }
  };
  tick();
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  console.log('%cKEMLLM ' + KEMLLM_BUILD, 'background:#f87171;color:#fff;padding:4px 10px;border-radius:4px;font-weight:bold');
  // Login screen handlers
  document.getElementById('btn-github')?.addEventListener('click', githubLogin);
  document.getElementById('btn-demo')?.addEventListener('click', demoLogin);

  // Sidebar nav — use event delegation so dynamically-added items also work
  // and so we don't depend on the elements existing at DOMContentLoaded time.
  // We listen on the document so even if a parent has weird CSS, the click
  // event still bubbles up here.
  function handleSidebarNavClick(e) {
    // Close the sidebar if tapping the logo header (which now has ✕ on mobile)
    const logoEl = e.target.closest('#si-logo');
    if (logoEl) {
      e.preventDefault();
      e.stopPropagation();
      console.log('[KEMLLM] sidebar logo tap → close');
      if (typeof closeSidebar === 'function') closeSidebar();
      siNav('chat');
      return;
    }
    const el = e.target.closest('.si');
    if (!el || !document.getElementById('sb-icons')?.contains(el)) return;
    console.log('[KEMLLM] sidebar item tap →', el.dataset.action || el.dataset.panel);
    e.preventDefault();
    e.stopPropagation();
    const action = el.dataset.action;
    if (action === 'new-chat') {
      newChat();
      siNav('chat');
      return;
    }
    const p = el.dataset.panel;
    if (p) siNav(p);
  }
  document.addEventListener('click', handleSidebarNavClick, true);
  // iOS sometimes drops synthetic click events on the sidebar; touchend as backup
  document.addEventListener('touchend', (e) => {
    const el = e.target.closest('.si');
    if (!el || !document.getElementById('sb-icons')?.contains(el)) return;
    // Only handle if it was a real tap (not a scroll/long-press)
    if (e.changedTouches && e.changedTouches.length === 1) {
      e.preventDefault();
      handleSidebarNavClick(e);
    }
  }, { passive: false });
  document.getElementById('si-logo')?.addEventListener('click', () => siNav('chat'));
  document.getElementById('sb-viewall')?.addEventListener('click', toggleDrawer);
  document.getElementById('sb-new-chat')?.addEventListener('click', newChat);
  document.getElementById('tb-new-chat')?.addEventListener('click', newChat);
  document.getElementById('dr-close')?.addEventListener('click', closeDrawer);
  document.getElementById('dr-new')?.addEventListener('click', newChat);

  // Mobile sidebar toggle
  document.getElementById('sb-toggle')?.addEventListener('click', toggleSidebar);
  document.getElementById('sb-backdrop')?.addEventListener('click', closeSidebar);

  // Attach button
  document.getElementById('attach-btn')?.addEventListener('click', () => {
    document.getElementById('attach-input').click();
  });
  document.getElementById('attach-input')?.addEventListener('change', (e) => {
    Array.from(e.target.files || []).forEach(addAttachment);
    e.target.value = '';
  });
  // Paste image support
  document.getElementById('input-text')?.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) addAttachment(f);
      }
    }
  });
  // Persona save
  document.getElementById('save-persona')?.addEventListener('click', () => {
    const val = document.getElementById('sp-persona').value;
    profileSet('persona', val);
    showToast('Persona saved');
  });

  // Topbar
  document.getElementById('tb-chat-model')?.addEventListener('click', toggleChatDrop);
  document.getElementById('tb-img-model')?.addEventListener('click', toggleImgDrop);
  document.getElementById('tb-vid-model')?.addEventListener('click', toggleVidDrop);
  document.getElementById('tb-web')?.addEventListener('click', toggleWebSearch);
  document.getElementById('tb-settings')?.addEventListener('click', () => siNav('settings'));

  // Topbar tabs
  document.getElementById('tab-chat')?.addEventListener('click', () => siNav('chat'));
  document.getElementById('tab-code')?.addEventListener('click', () => siNav('code'));

  // Avatar row
  document.getElementById('si-ava-row')?.addEventListener('click', openUserModal);

  // User modal
  document.getElementById('um-switch')?.addEventListener('click', switchProfile);
  document.getElementById('um-signout')?.addEventListener('click', signOut);
  document.getElementById('um-close')?.addEventListener('click', closeUserModal);
  document.getElementById('um-settings')?.addEventListener('click', () => { closeUserModal(); siNav('settings'); });
  document.getElementById('um-code')?.addEventListener('click', () => { closeUserModal(); siNav('code'); });
  document.getElementById('um-models')?.addEventListener('click', () => { closeUserModal(); siNav('models'); });

  // MCP modal close

  // Input
  const input = document.getElementById('input-text');
  if (input) {
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      // Cap growth at 35% of the viewport so the textarea never pushes the
      // whole input box off-screen on mobile/small windows. Content past
      // the cap scrolls inside the textarea (overflow-y:auto in CSS).
      const cap = Math.min(200, Math.floor(window.innerHeight * 0.35));
      input.style.height = Math.min(input.scrollHeight, cap) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }
  document.getElementById('send-btn')?.addEventListener('click', sendMessage);
  document.getElementById('stop-btn')?.addEventListener('click', () => {
    // Stop the agent loop if running, OR clear the busy flag for a normal chat
    if (typeof agentLoopRunning !== 'undefined' && agentLoopRunning) {
      stopAgentLoop();
    } else if (typeof chatBusy !== 'undefined' && chatBusy) {
      setChatBusy(false);
      showToast('Cancelled (response may still finish in the background)');
    }
  });

  // Desktop button — sub-button of Agent. Visible only in agent mode (the
  // probe + setChatMode handle that). Clicking it does NOT switch modes;
  // Agent stays selected. The desktop button itself just gets the active
  // class while the preview pane is open.
  document.getElementById('chat-desktop-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('chat-desktop-btn');
    if (!btn) return;
    btn.classList.add('loading');
    btn.classList.add('active');
    try {
      // If state is stuck (ready but wrong backend, or ready with no
      // session), nuke it so agentStart starts fresh — but stay in agent
      // mode the whole time.
      if (agentReady && (agentBackend !== 'hf' || !agentSessionId) && getHfBackendUrl()) {
        agentReset();
      }
      await agentStart();
      await showAgentDesktop();
    } finally {
      btn.classList.remove('loading');
    }
  });
  // When the preview pane is closed, drop the desktop active highlight.
  document.getElementById('chat-preview-close')?.addEventListener('click', () => {
    document.getElementById('chat-desktop-btn')?.classList.remove('active');
  });

  // Chat preview pane controls
  document.getElementById('chat-preview-close')?.addEventListener('click', chatPreviewClose);
  document.getElementById('chat-preview-audio')?.addEventListener('click', togglePreviewAudio);

  // Fullscreen image viewer
  document.getElementById('img-viewer-close')?.addEventListener('click', closeImageViewer);
  document.getElementById('img-viewer-download')?.addEventListener('click', downloadImageFromViewer);
  document.getElementById('img-viewer-reuse')?.addEventListener('click', useViewerImageInChat);
  document.getElementById('img-viewer-ocr')?.addEventListener('click', ocrFromImageViewer);

  // Memory CRUD
  document.getElementById('sp-mem-add')?.addEventListener('click', addMemoryFromInput);
  document.getElementById('sp-mem-new')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addMemoryFromInput(); }
  });

  // AI-written memory (read-only view + reset button)
  document.getElementById('sp-aimem-reset')?.addEventListener('click', resetAIMemory);

  // Sandbox web access toggle
  const sandboxWebEl = document.getElementById('sp-sandbox-web');
  if (sandboxWebEl) {
    sandboxWebEl.checked = profileGet('sandbox-web') === '1';
    sandboxWebEl.addEventListener('change', () => {
      profileSet('sandbox-web', sandboxWebEl.checked ? '1' : '0');
      showToast(sandboxWebEl.checked ? 'Sandbox web access enabled' : 'Sandbox web access disabled');
    });
  }

  // Debug log
  document.getElementById('sp-debug-clear')?.addEventListener('click', clearDebugLog);
  // Render debug log when Settings panel becomes active (lazy)
  const observer = new MutationObserver(() => {
    const panel = document.getElementById('settings-panel');
    if (panel && panel.classList.contains('active') && typeof renderDebugLog === 'function') {
      renderDebugLog();
      if (typeof renderMemories === 'function') renderMemories();
      if (typeof renderAIMemory === 'function') renderAIMemory();
    }
  });
  const settingsPanel = document.getElementById('settings-panel');
  if (settingsPanel) observer.observe(settingsPanel, { attributes: true, attributeFilter: ['class'] });

  // Export all chats as JSON
  document.getElementById('dr-export')?.addEventListener('click', exportAllChats);
  document.getElementById('img-viewer-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('img-viewer-input');
    const txt = (input?.value || '').trim();
    if (txt) editFromImageViewer(txt);
  });
  // Esc closes the viewer
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('img-viewer')?.classList.contains('open')) {
      closeImageViewer();
    }
  });
  // Tap background (outside the stage) to close on mobile
  document.getElementById('img-viewer')?.addEventListener('click', (e) => {
    if (e.target.id === 'img-viewer' || e.target.id === 'img-viewer-stage') closeImageViewer();
  });
  document.getElementById('chat-preview-reload')?.addEventListener('click', chatPreviewReload);
  document.getElementById('chat-preview-fs')?.addEventListener('click', chatPreviewFullscreen);

  // Click outside to close dropdowns
  document.addEventListener('click', (e) => {
    if (e.target.closest('.tb-model') || e.target.closest('.drop')) return;
    closeAllDrops();
  });

  // Modal overlay click-outside
  document.querySelectorAll('.modal-overlay').forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.remove('open');
    });
  });

  // Code panel
  document.getElementById('code-run-btn')?.addEventListener('click', runCurrentCode);
  document.getElementById('code-ai-btn')?.addEventListener('click', askAIAboutCode);
  document.getElementById('code-lang-sel')?.addEventListener('change', () => {
    const sel = document.getElementById('code-lang-sel').value;
    CODE_FILES[currentFile].lang = sel;
  });
  document.querySelectorAll('.code-file').forEach(el => {
    el.addEventListener('click', () => loadFile(el.dataset.file));
  });
  setupCodeEditor();

  // Mode pills under chat input. The Desktop button has its own handler
  // and no data-mode attribute — skip it here so we don't clobber state
  // with setChatMode(undefined).
  document.querySelectorAll('.mode-btn').forEach(b => {
    if (!b.dataset.mode) return;
    b.addEventListener('click', () => setChatMode(b.dataset.mode));
  });

  // Agent backend (HF Space)
  document.getElementById('save-hf-url')?.addEventListener('click', () => {
    const v = document.getElementById('hf-backend-url').value.trim().replace(/\/$/, '');
    profileSet('hf-backend-url', v);
    showToast('Backend URL saved');
    probeDesktopSupport();
  });
  document.getElementById('save-hf-token')?.addEventListener('click', () => {
    const v = document.getElementById('hf-backend-token').value.trim();
    profileSet('hf-backend-token', v);
    showToast('Backend token saved');
  });
  document.getElementById('test-hf-url')?.addEventListener('click', async () => {
    const url = document.getElementById('hf-backend-url').value.trim().replace(/\/$/, '');
    const tok = document.getElementById('hf-backend-token').value.trim();
    if (!url) { showToast('Enter a URL first'); return; }
    showToast('Testing backend…');
    try {
      const r = await fetch(url + '/', { headers: tok ? { 'Authorization': 'Bearer ' + tok } : {} });
      if (!r.ok) { showToast('✗ ' + r.status); return; }
      const d = await r.json();
      showToast(d.ok ? '✓ backend up · auth=' + (d.auth_required ? 'on' : 'off') : '✗ unknown response');
    } catch (e) {
      showToast('✗ ' + (e.message || 'failed'));
    }
  });
  // Replicate key test
  document.getElementById('test-rep-key')?.addEventListener('click', async () => {
    const k = document.getElementById('rep-key').value.trim() || getRepKey();
    if (!k) { showToast('Enter a key first'); return; }
    showToast('Testing Replicate…');
    try {
      const res = await fetch('https://kemllmbackend.karimghannam2014.workers.dev/replicate/v1/account', {
        headers: { 'Authorization': 'Bearer ' + k }
      });
      if (res.ok) {
        const d = await res.json();
        showToast('✓ Replicate OK: ' + (d.username || 'authenticated'));
      } else {
        showToast('✗ Replicate ' + res.status);
      }
    } catch (e) {
      showToast('✗ ' + e.message);
    }
  });

  // Settings handlers
  ['anthropic', 'openai', 'google', 'xai'].forEach(p => {
    document.getElementById('save-key-' + p)?.addEventListener('click', () => saveKey(p));
  });
  document.getElementById('save-rep-key')?.addEventListener('click', saveRepKey);
  document.getElementById('sp-temp')?.addEventListener('change', saveTemp);
  document.getElementById('sp-max-tokens')?.addEventListener('change', saveMaxTokens);
  document.getElementById('cm-add')?.addEventListener('click', addCustomModel);
  document.querySelectorAll('.sp-swatch').forEach(s => {
    s.addEventListener('click', () => setAccent(s.dataset.color));
  });

  // Render initial state
  renderModelDropdowns();
  renderModelsPanel();
  createStars();
  termBootStart();
  // Wire hash router so URLs update on nav and deep-links work
  if (typeof initRouter === 'function') initRouter();
  // Refresh sync from cloud when the tab becomes visible (e.g. after
  // switching back from another app or another device)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && typeof pullSync === 'function') {
      pullSync({ silent: true });
    }
  });

  // Handle GitHub OAuth callback if present
  if (!handleGithubCallback() && !checkExistingProfile()) {
    document.getElementById('login').classList.add('show');
  }

  // Resume any pending background AI responses left over from a previous
  // tab session (tab was closed mid-response, laptop slept, etc). Runs
  // after a short delay so the UI is fully loaded first.
  setTimeout(() => {
    if (typeof resumePendingResponses === 'function') {
      resumePendingResponses().catch(e => console.warn('[KEMLLM] resume error', e));
    }
  }, 1500);
});
