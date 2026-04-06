// ========== KEMLLM App Init / History / Boot Animation ==========
'use strict';

// ===== Chat history =====
function loadHistory() {
  return profileGetJSON('history', []);
}
function saveCurrentChat() {
  if (!messages.length) return;
  let list = loadHistory();
  if (!currentChatId) {
    currentChatId = 'c_' + Date.now();
    const title = (messages[0]?.content || 'New chat').slice(0, 50);
    list.unshift({ id: currentChatId, title, messages, ts: Date.now() });
    if (list.length > 60) list = list.slice(0, 60);
  } else {
    const idx = list.findIndex(c => c.id === currentChatId);
    if (idx >= 0) list[idx].messages = messages;
  }
  profileSetJSON('history', list);
  renderHistory();
}
function renderHistory() {
  const el = document.getElementById('hist-list');
  if (!el) return;
  const list = loadHistory();
  if (!list.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--text3);text-align:center;padding:14px 8px;">No chats yet</div>';
    return;
  }
  el.innerHTML = list.map(c => `<div class="hi${c.id === currentChatId ? ' active' : ''}" onclick="loadChat('${c.id}')"><div class="hi-txt">${escapeHTML(c.title)}</div><button class="hi-del" onclick="event.stopPropagation();deleteChat('${c.id}')">×</button></div>`).join('');
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
    if (m.role === 'user') renderUserMessage(m.content);
    else {
      const model = findModel(selectedChat, 'chat') || { name: 'AI', provider: 'custom' };
      renderAIMessage(model, parseMarkdown(m.content));
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

// ===== Stars =====
function createStars() {
  const bg = document.getElementById('stars-bg');
  if (!bg) return;
  if (profileGet('stars_off') === '1') { bg.innerHTML = ''; return; }
  bg.innerHTML = '';
  for (let i = 0; i < 120; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    const sz = Math.random() * 2 + 0.5;
    s.style.width = sz + 'px';
    s.style.height = sz + 'px';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 100 + '%';
    s.style.setProperty('--d', (Math.random() * 4 + 2) + 's');
    s.style.animationDelay = (Math.random() * 4) + 's';
    bg.appendChild(s);
  }
}

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
  { text: '/– initializing KEMLLM runtime...', cls: 'tb-blue' },
  { text: '/– connecting to Replicate API...', cls: 'tb-blue', spin: true },
  { text: '/– importing models', cls: 'tb-blue' },
  { text: '   OpenAI/GPT-5.4', cls: 'tb-white', stagger: true },
  { text: '   Google/Gemini-3.1-Pro', cls: 'tb-white', stagger: true },
  { text: '   Anthropic/Claude-Opus-4.6', cls: 'tb-white', stagger: true },
  { text: '   xAI/Grok-4.20', cls: 'tb-white', stagger: true },
  { text: '   Black-Forest-Labs/FLUX-1.1-Pro-Ultra', cls: 'tb-white', stagger: true },
  { text: '   Google/Veo-3', cls: 'tb-white', stagger: true },
  { text: '/– all models loaded ✓', cls: 'tb-green' },
  { text: '/– type to chat', cls: 'tb-blue' }
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
      typewriter(div, line.text, 28, line.spin);
    }, delay);
    delay += line.stagger ? 180 : (line.text.length * 28 + 380);
  });
  bootSchedule(() => {
    term.classList.add('fade');
    bootSchedule(() => {
      if (bootRunning) runBootCycle();
    }, 1000);
  }, delay + 1500);
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
          if (!bootRunning || count > 8) return;
          el.textContent = text + ' ' + spinChars[spinIdx++ % 4];
          count++;
          bootSchedule(spin, 110);
        };
        spin();
      }
    }
  };
  tick();
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  // Login screen handlers
  document.getElementById('btn-github')?.addEventListener('click', githubLogin);
  document.getElementById('btn-demo')?.addEventListener('click', demoLogin);

  // Sidebar nav
  document.querySelectorAll('.si').forEach(el => {
    el.addEventListener('click', () => {
      const p = el.dataset.panel;
      if (p === 'connectors') { openMCP(); return; }
      if (p) siNav(p);
    });
  });
  document.getElementById('si-logo')?.addEventListener('click', toggleDrawer);
  document.getElementById('dr-close')?.addEventListener('click', closeDrawer);
  document.getElementById('dr-new')?.addEventListener('click', newChat);

  // Topbar
  document.getElementById('tb-chat-model')?.addEventListener('click', toggleChatDrop);
  document.getElementById('tb-img-model')?.addEventListener('click', toggleImgDrop);
  document.getElementById('tb-vid-model')?.addEventListener('click', toggleVidDrop);
  document.getElementById('tb-web')?.addEventListener('click', toggleWebSearch);
  document.getElementById('tb-conn')?.addEventListener('click', openMCP);
  document.getElementById('tb-settings')?.addEventListener('click', () => siNav('settings'));

  // Topbar tabs
  document.getElementById('tab-chat')?.addEventListener('click', () => siNav('chat'));
  document.getElementById('tab-code')?.addEventListener('click', () => siNav('code'));

  // Avatar
  document.getElementById('si-ava')?.addEventListener('click', openUserModal);

  // User modal
  document.getElementById('um-switch')?.addEventListener('click', switchProfile);
  document.getElementById('um-signout')?.addEventListener('click', signOut);
  document.getElementById('um-close')?.addEventListener('click', closeUserModal);
  document.getElementById('um-settings')?.addEventListener('click', () => { closeUserModal(); siNav('settings'); });
  document.getElementById('um-code')?.addEventListener('click', () => { closeUserModal(); siNav('code'); });
  document.getElementById('um-models')?.addEventListener('click', () => { closeUserModal(); siNav('models'); });

  // MCP modal close
  document.getElementById('mcp-close')?.addEventListener('click', closeMCP);

  // Input
  const input = document.getElementById('input-text');
  if (input) {
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }
  document.getElementById('send-btn')?.addEventListener('click', sendMessage);

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
  document.getElementById('sp-stars')?.addEventListener('click', () => {
    const off = profileGet('stars_off') === '1';
    profileSet('stars_off', off ? '0' : '1');
    document.getElementById('sp-stars').classList.toggle('on', off);
    createStars();
  });

  // Render initial state
  renderModelDropdowns();
  renderModelsPanel();
  createStars();
  termBootStart();

  // Auto-login if profile exists
  if (!checkExistingProfile()) {
    document.getElementById('login').classList.add('show');
  }
});
