// ========== KEMLLM UI Controllers ==========
'use strict';

let currentPanel = 'chat';

// ===== Hash-based router =====
// Each panel gets its own URL so browser back/forward/reload work.
// Routes: #/chat, #/code, #/models, #/settings
// Legacy (no hash) → defaults to chat.
const VALID_PANELS = ['chat', 'code', 'models', 'settings'];

function panelFromHash() {
  const h = (location.hash || '').replace(/^#\/?/, '').split('/')[0].toLowerCase();
  return VALID_PANELS.includes(h) ? h : 'chat';
}

function setHashForPanel(panel) {
  const want = '#/' + panel;
  if (location.hash !== want) {
    history.pushState({ panel }, '', want);
  }
}

function siNav(panel, skipHash) {
  // Agent panel no longer exists — agent is now a mode inside chat
  if (panel === 'agent') { panel = 'chat'; setChatMode('agent'); }
  if (!VALID_PANELS.includes(panel)) panel = 'chat';
  currentPanel = panel;
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(panel + '-panel');
  if (target) target.classList.add('active');
  document.querySelectorAll('.si').forEach(el => {
    el.classList.toggle('active', el.dataset.panel === panel);
  });
  const tabs = document.getElementById('tb-tabs');
  if (tabs) tabs.classList.toggle('hidden', !(panel === 'chat' || panel === 'code'));
  closeDrawer();
  if (isMobile()) closeSidebar();
  if (!skipHash) setHashForPanel(panel);
  // Update document title so it shows in browser history / tab bar
  const pretty = panel.charAt(0).toUpperCase() + panel.slice(1);
  document.title = 'KEMLLM · ' + pretty;
}

function initRouter() {
  // On initial page load, honor the URL hash
  siNav(panelFromHash(), true);
  // Back/forward button support
  window.addEventListener('popstate', () => {
    siNav(panelFromHash(), true);
  });
  // Deep-link changes typed into the URL bar
  window.addEventListener('hashchange', () => {
    siNav(panelFromHash(), true);
  });
}

function toggleDrawer() {
  const d = document.getElementById('drawer');
  if (d) d.classList.toggle('open');
}
function closeDrawer() {
  const d = document.getElementById('drawer');
  if (d) d.classList.remove('open');
}

function isMobile() { return window.matchMedia('(max-width:820px)').matches; }

function toggleSidebar() {
  const sb = document.getElementById('sb-icons');
  const bd = document.getElementById('sb-backdrop');
  if (!sb) return;
  const open = !sb.classList.contains('open');
  sb.classList.toggle('open', open);
  bd?.classList.toggle('show', open);
}
function closeSidebar() {
  document.getElementById('sb-icons')?.classList.remove('open');
  document.getElementById('sb-backdrop')?.classList.remove('show');
}

// ===== Dropdowns =====
function positionDrop(btn, drop) {
  const r = btn.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  // Show the drop briefly to measure it, then clamp to the viewport
  drop.style.visibility = 'hidden';
  drop.style.display = 'block';
  drop.style.top = '0';
  drop.style.left = '0';
  const dr = drop.getBoundingClientRect();
  drop.style.display = '';
  drop.style.visibility = '';
  const dropW = dr.width || 300;
  const dropH = dr.height || 400;
  let top = r.bottom + 6;
  let left = r.left;
  // Clamp horizontally: never overflow the right edge
  if (left + dropW > vw - 8) left = Math.max(8, vw - dropW - 8);
  // If the dropdown would fall below the viewport, flip above the button
  if (top + dropH > vh - 8) {
    const aboveTop = r.top - dropH - 6;
    if (aboveTop >= 8) top = aboveTop;
    else top = Math.max(8, vh - dropH - 8);
  }
  drop.style.top = top + 'px';
  drop.style.left = left + 'px';
}
function toggleChatDrop() {
  const drop = document.getElementById('mdrop');
  const btn = document.getElementById('tb-chat-model');
  if (drop.classList.contains('open')) {
    drop.classList.remove('open');
    return;
  }
  closeAllDrops();
  positionDrop(btn, drop);
  drop.classList.add('open');
}
function toggleImgDrop() {
  const drop = document.getElementById('img-drop');
  const btn = document.getElementById('tb-img-model');
  if (drop.style.display === 'block') {
    drop.style.display = 'none';
    return;
  }
  closeAllDrops();
  positionDrop(btn, drop);
  drop.style.display = 'block';
}
function toggleVidDrop() {
  const drop = document.getElementById('vid-drop');
  const btn = document.getElementById('tb-vid-model');
  if (drop.style.display === 'block') {
    drop.style.display = 'none';
    return;
  }
  closeAllDrops();
  positionDrop(btn, drop);
  drop.style.display = 'block';
}
function closeAllDrops() {
  document.getElementById('mdrop')?.classList.remove('open');
  const i = document.getElementById('img-drop');
  if (i) i.style.display = 'none';
  const v = document.getElementById('vid-drop');
  if (v) v.style.display = 'none';
}

function renderModelDropdowns() {
  // Chat dropdown
  const mdrop = document.getElementById('mdrop');
  if (mdrop) {
    const groups = {};
    CHAT_MODELS.forEach(m => {
      groups[m.provider] = groups[m.provider] || [];
      groups[m.provider].push(m);
    });
    const customs = getCustomModels().filter(m => m.type === 'chat');
    let html = '';
    for (const prov of ['anthropic', 'openai', 'google', 'xai', 'meta', 'mistral', 'deepseek']) {
      if (!groups[prov]) continue;
      html += `<div class="mds">${prov.toUpperCase()}</div>`;
      groups[prov].forEach(m => {
        html += `<div class="mdi${m.id === selectedChat ? ' sel' : ''}" onclick="selectChatModel('${m.id}')"><span class="mdot" style="background:${PROVIDER_COLORS[m.provider]}"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)}</div><div class="mdi-s">${escapeHTML(m.apiId || m.replicateId || '')}</div></div></div>`;
      });
    }
    if (customs.length) {
      html += `<div class="mdsep"></div><div class="mds">CUSTOM</div>`;
      customs.forEach(m => {
        html += `<div class="mdi${m.id === selectedChat ? ' sel' : ''}" onclick="selectChatModel('${m.id}')"><span class="mdot" style="background:${m.color || '#a78bfa'}"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)} <span class="mdi-tag">✦</span></div><div class="mdi-s">${escapeHTML(m.replicateId)}</div></div></div>`;
      });
    }
    mdrop.innerHTML = html;
  }
  // Image dropdown
  const imgDrop = document.getElementById('img-drop');
  if (imgDrop) {
    let html = `<div class="mds">IMAGE MODELS</div>`;
    IMAGE_MODELS.forEach(m => {
      html += `<div class="mdi${m.id === selectedImage ? ' sel' : ''}" onclick="selectImgModel('${m.id}')"><span class="mdot" style="background:#f472b6"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)}</div><div class="mdi-s">${escapeHTML(m.replicateId)}</div></div></div>`;
    });
    const customs = getCustomModels().filter(m => m.type === 'image');
    if (customs.length) {
      html += `<div class="mdsep"></div><div class="mds">CUSTOM</div>`;
      customs.forEach(m => {
        html += `<div class="mdi${m.id === selectedImage ? ' sel' : ''}" onclick="selectImgModel('${m.id}')"><span class="mdot" style="background:${m.color || '#f472b6'}"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)} <span class="mdi-tag">✦</span></div><div class="mdi-s">${escapeHTML(m.replicateId)}</div></div></div>`;
      });
    }
    imgDrop.innerHTML = html;
  }
  // Video dropdown
  const vidDrop = document.getElementById('vid-drop');
  if (vidDrop) {
    let html = `<div class="mds">VIDEO MODELS</div>`;
    VIDEO_MODELS.forEach(m => {
      html += `<div class="mdi${m.id === selectedVideo ? ' sel' : ''}" onclick="selectVidModel('${m.id}')"><span class="mdot" style="background:#4ade80"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)}</div><div class="mdi-s">${escapeHTML(m.replicateId)}</div></div></div>`;
    });
    const customs = getCustomModels().filter(m => m.type === 'video');
    if (customs.length) {
      html += `<div class="mdsep"></div><div class="mds">CUSTOM</div>`;
      customs.forEach(m => {
        html += `<div class="mdi${m.id === selectedVideo ? ' sel' : ''}" onclick="selectVidModel('${m.id}')"><span class="mdot" style="background:${m.color || '#4ade80'}"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)} <span class="mdi-tag">✦</span></div><div class="mdi-s">${escapeHTML(m.replicateId)}</div></div></div>`;
      });
    }
    vidDrop.innerHTML = html;
  }
  updateTopbarLabels();
}

function selectChatModel(id) {
  selectedChat = id;
  profileSet('selected_chat', id);
  closeAllDrops();
  renderModelDropdowns();
}
function selectImgModel(id) {
  selectedImage = id;
  profileSet('selected_image', id);
  closeAllDrops();
  renderModelDropdowns();
}
function selectVidModel(id) {
  selectedVideo = id;
  profileSet('selected_video', id);
  closeAllDrops();
  renderModelDropdowns();
}

function updateTopbarLabels() {
  const cm = findModel(selectedChat, 'chat');
  const im = findModel(selectedImage, 'image');
  const vm = findModel(selectedVideo, 'video');
  const cmEl = document.getElementById('tb-chat-model-label');
  if (cmEl && cm) {
    cmEl.innerHTML = `<span class="mdot" style="background:${PROVIDER_COLORS[cm.provider] || '#888'}"></span>${escapeHTML(cm.name)}`;
  }
  const imEl = document.getElementById('tb-img-model-label');
  if (imEl && im) imEl.innerHTML = `<span class="mdot" style="background:#f472b6"></span>${escapeHTML(im.name)}`;
  const vmEl = document.getElementById('tb-vid-model-label');
  if (vmEl && vm) vmEl.innerHTML = `<span class="mdot" style="background:#4ade80"></span>${escapeHTML(vm.name)}`;
}

// ===== Web search toggle =====
function toggleWebSearch() {
  window.webSearchOn = !window.webSearchOn;
  document.getElementById('tb-web')?.classList.toggle('on', window.webSearchOn);
}

// ===== MCP Connectors =====
const MCP_SERVICES = [
  { id: 'replicate', name: 'Replicate', desc: 'AI models · api.replicate.com', icon: 'R', url: null, always: true, mcp: 'https://mcp.replicate.com/sse' },
  { id: 'e2b', name: 'e2b Sandbox', desc: 'Linux VM for Agent Mode · e2b.dev', icon: '⬢', url: 'https://e2b.dev/dashboard', always: false },
  { id: 'github', name: 'GitHub', desc: 'Repos and gists', icon: 'G', url: 'https://github.com/settings/applications/new' },
  { id: 'gdrive', name: 'Google Drive', desc: 'File access', icon: 'D', url: 'https://accounts.google.com/o/oauth2/auth?scope=https://www.googleapis.com/auth/drive.readonly' },
  { id: 'gmail', name: 'Gmail', desc: 'Email access', icon: 'M', url: 'https://accounts.google.com/o/oauth2/auth?scope=https://www.googleapis.com/auth/gmail.readonly' },
  { id: 'gcal', name: 'Google Calendar', desc: 'Events', icon: 'C', url: 'https://accounts.google.com/o/oauth2/auth?scope=https://www.googleapis.com/auth/calendar' },
  { id: 'notion', name: 'Notion', desc: 'Pages and DBs', icon: 'N', url: 'https://api.notion.com/v1/oauth/authorize?client_id=kemllm&response_type=code' },
  { id: 'slack', name: 'Slack', desc: 'Messages', icon: 'S', url: 'https://slack.com/oauth/v2/authorize?scope=channels:read,chat:write' },
  { id: 'spotify', name: 'Spotify', desc: 'Playback', icon: 'S', url: 'https://accounts.spotify.com/authorize?scope=user-read-playback-state,user-modify-playback-state' },
  { id: 'perplexity', name: 'Perplexity', desc: 'Search', icon: 'P', url: 'https://www.perplexity.ai/settings/api' }
];
function openMCP() {
  document.getElementById('mcp-modal').classList.add('open');
  renderMCP();
}
function closeMCP() { document.getElementById('mcp-modal').classList.remove('open'); }

function getMCPState() { return profileGetJSON('mcp_connected', { replicate: true, piston: true }); }
function setMCPConnected(id, val) {
  const s = getMCPState();
  s[id] = val;
  profileSetJSON('mcp_connected', s);
  updateMCPBadge();
}
function loadMCPState() { updateMCPBadge(); }
function updateMCPBadge() {
  const s = getMCPState();
  const count = Object.values(s).filter(Boolean).length;
  const badge = document.getElementById('si-conn-badge');
  if (badge) badge.textContent = count;
}
function renderMCP() {
  const list = document.getElementById('mcp-list');
  if (!list) return;
  const state = getMCPState();
  list.innerHTML = MCP_SERVICES.map(s => {
    const connected = s.always || state[s.id];
    return `<div class="mcp-item"><div class="mcp-icon">${s.icon}</div><div class="mcp-info"><div class="mcp-name">${escapeHTML(s.name)}</div><div class="mcp-desc">${escapeHTML(s.desc)}</div></div><button class="mcp-btn${connected ? ' connected' : ''}" onclick="connectMCP('${s.id}')">${s.always ? 'Active' : connected ? 'Connected' : 'Connect'}</button></div>`;
  }).join('');
}
function connectMCP(id) {
  const svc = MCP_SERVICES.find(s => s.id === id);
  if (!svc || svc.always) return;
  if (svc.url) {
    window.open(svc.url, 'mcp_' + id, 'width=700,height=800');
  }
  setMCPConnected(id, true);
  renderMCP();
  showToast('Connecting to ' + svc.name);
}

// ===== User modal =====
function openUserModal() { document.getElementById('user-modal').classList.add('open'); }
function closeUserModal() { document.getElementById('user-modal').classList.remove('open'); }

// ===== Toast =====
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ===== Theme & Accent =====
function applyTheme(theme) {
  // Only dark for now
  document.body.dataset.theme = theme;
}
function applyAccent(color) {
  document.documentElement.style.setProperty('--accent', color);
}
function setAccent(color) {
  applyAccent(color);
  profileSet('accent', color);
  document.querySelectorAll('.sp-swatch').forEach(s => s.classList.toggle('sel', s.dataset.color === color));
}

// ===== Settings handlers =====
function saveSetting(key, value) {
  profileSet(key, value);
}
function saveTemp() {
  const v = document.getElementById('sp-temp').value;
  profileSet('temp', v);
  showToast('Saved');
}
function saveMaxTokens() {
  const v = document.getElementById('sp-max-tokens').value;
  profileSet('max-tokens', v);
  showToast('Saved');
}

// ===== Custom models =====
function addCustomModel() {
  const name = document.getElementById('cm-name').value.trim();
  const repId = document.getElementById('cm-id').value.trim();
  const type = document.getElementById('cm-type').value;
  const color = document.getElementById('cm-color').value;
  if (!name || !repId) { showToast('Name and Replicate ID required'); return; }
  const list = getCustomModels();
  list.push({ id: 'custom_' + Date.now(), name, replicateId: repId, type, color, provider: 'custom' });
  setCustomModels(list);
  document.getElementById('cm-name').value = '';
  document.getElementById('cm-id').value = '';
  renderCustomModels();
  injectCustomModels();
  showToast('Added');
}
function deleteCustomModel(id) {
  setCustomModels(getCustomModels().filter(m => m.id !== id));
  renderCustomModels();
  injectCustomModels();
}
function renderCustomModels() {
  const list = document.getElementById('sp-cm-list');
  if (!list) return;
  const customs = getCustomModels();
  if (!customs.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text3);">No custom models yet</div>';
    return;
  }
  list.innerHTML = customs.map(m => `<div class="sp-cm"><span class="mdot" style="background:${m.color || '#a78bfa'}"></span><div class="sp-cm-info"><div class="sp-cm-n">${escapeHTML(m.name)} <span class="mdi-tag">${m.type}</span></div><div class="sp-cm-s">${escapeHTML(m.replicateId)}</div></div><button class="sp-cm-del" onclick="deleteCustomModel('${m.id}')">×</button></div>`).join('');
}

function renderModelsPanel() {
  const grid = document.getElementById('mp-grid');
  if (!grid) return;
  grid.innerHTML = CHAT_MODELS.map(m => `<div class="mp-card"><div class="mp-card-top"><span class="mdot" style="background:${PROVIDER_COLORS[m.provider]}"></span><div class="mp-card-n">${escapeHTML(m.name)}</div></div><div class="mp-card-s">${escapeHTML(m.apiId || m.replicateId || '')}</div><div class="mp-card-prov">${m.provider}</div></div>`).join('');
}
