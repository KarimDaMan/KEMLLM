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

// Decide whether a chat model is usable given the keys the user currently has.
// A model is usable if EITHER:
//   - it has a replicateId AND the user has a Replicate key, OR
//   - it has an apiId AND the user has the matching provider key
// requiresDirectKey: true forces the second condition (no Replicate fallback).
function isChatModelUsable(m) {
  const hasRep = !!profileGet('rep-key');
  const hasProv = !!profileGet('key-' + m.provider);
  if (m.requiresDirectKey) return hasProv;
  if (m.replicateId && hasRep) return true;
  if (m.apiId && hasProv) return true;
  return false;
}

// The subtitle shown under each model name in the dropdown.
// Prefers the actual Replicate slug; falls back to the apiId if no Replicate
// path; shows '(needs <provider> key)' when the model is direct-API only.
function modelSubtitle(m) {
  if (m.requiresDirectKey) return `direct ${m.provider} api · needs key`;
  if (m.replicateId) return m.replicateId;
  if (m.apiId) return `${m.provider} · ${m.apiId}`;
  return '';
}

function renderModelDropdowns() {
  // Chat dropdown
  const mdrop = document.getElementById('mdrop');
  if (mdrop) {
    // Filter to only models the user can actually use right now
    const usable = CHAT_MODELS.filter(isChatModelUsable);
    const groups = {};
    usable.forEach(m => {
      groups[m.provider] = groups[m.provider] || [];
      groups[m.provider].push(m);
    });
    const customs = getCustomModels().filter(m => m.type === 'chat');
    let html = '';
    if (!usable.length && !customs.length) {
      html = `<div class="mds">NO MODELS AVAILABLE</div><div class="mdi"><div class="mdi-info"><div class="mdi-n">Add a key in Settings</div><div class="mdi-s">Replicate or any direct provider key unlocks models</div></div></div>`;
    }
    for (const prov of ['anthropic', 'openai', 'google', 'xai', 'meta', 'mistral', 'deepseek']) {
      if (!groups[prov]) continue;
      html += `<div class="mds">${prov.toUpperCase()}</div>`;
      groups[prov].forEach(m => {
        html += `<div class="mdi${m.id === selectedChat ? ' sel' : ''}" onclick="selectChatModel('${m.id}')"><span class="mdot" style="background:${PROVIDER_COLORS[m.provider]}"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)}</div><div class="mdi-s">${escapeHTML(modelSubtitle(m))}</div></div></div>`;
      });
    }
    if (customs.length) {
      html += `<div class="mdsep"></div><div class="mds">CUSTOM</div>`;
      customs.forEach(m => {
        html += `<div class="mdi${m.id === selectedChat ? ' sel' : ''}" onclick="selectChatModel('${m.id}')"><span class="mdot" style="background:${m.color || '#a78bfa'}"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)} <span class="mdi-tag">✦</span></div><div class="mdi-s">${escapeHTML(m.replicateId || '')}</div></div></div>`;
      });
    }
    mdrop.innerHTML = html;
  }
  // Image dropdown — all image models live on Replicate
  const imgDrop = document.getElementById('img-drop');
  if (imgDrop) {
    const hasRep = !!profileGet('rep-key');
    let html = '';
    if (!hasRep) {
      html = `<div class="mds">NO IMAGE MODELS</div><div class="mdi"><div class="mdi-info"><div class="mdi-n">Add your Replicate key</div><div class="mdi-s">Settings → Replicate</div></div></div>`;
    } else {
      html = `<div class="mds">IMAGE MODELS</div>`;
      IMAGE_MODELS.forEach(m => {
        html += `<div class="mdi${m.id === selectedImage ? ' sel' : ''}" onclick="selectImgModel('${m.id}')"><span class="mdot" style="background:#f472b6"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)}</div><div class="mdi-s">${escapeHTML(m.replicateId)}</div></div></div>`;
      });
    }
    const customs = getCustomModels().filter(m => m.type === 'image');
    if (customs.length) {
      html += `<div class="mdsep"></div><div class="mds">CUSTOM</div>`;
      customs.forEach(m => {
        html += `<div class="mdi${m.id === selectedImage ? ' sel' : ''}" onclick="selectImgModel('${m.id}')"><span class="mdot" style="background:${m.color || '#f472b6'}"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)} <span class="mdi-tag">✦</span></div><div class="mdi-s">${escapeHTML(m.replicateId)}</div></div></div>`;
      });
    }
    imgDrop.innerHTML = html;
  }
  // Video dropdown — all video models live on Replicate
  const vidDrop = document.getElementById('vid-drop');
  if (vidDrop) {
    const hasRep = !!profileGet('rep-key');
    let html = '';
    if (!hasRep) {
      html = `<div class="mds">NO VIDEO MODELS</div><div class="mdi"><div class="mdi-info"><div class="mdi-n">Add your Replicate key</div><div class="mdi-s">Settings → Replicate</div></div></div>`;
    } else {
      html = `<div class="mds">VIDEO MODELS</div>`;
      VIDEO_MODELS.forEach(m => {
        html += `<div class="mdi${m.id === selectedVideo ? ' sel' : ''}" onclick="selectVidModel('${m.id}')"><span class="mdot" style="background:#4ade80"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)}</div><div class="mdi-s">${escapeHTML(m.replicateId)}</div></div></div>`;
      });
    }
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
  const version = document.getElementById('cm-version')?.value.trim() || '';
  const type = document.getElementById('cm-type').value;
  const color = document.getElementById('cm-color').value;
  if (!name || !repId) { showToast('Name and Replicate ID required'); return; }
  const list = getCustomModels();
  list.push({
    id: 'custom_' + Date.now(),
    name,
    replicateId: repId,
    version: version || undefined,
    type,
    color,
    provider: 'custom',
  });
  setCustomModels(list);
  document.getElementById('cm-name').value = '';
  document.getElementById('cm-id').value = '';
  if (document.getElementById('cm-version')) document.getElementById('cm-version').value = '';
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

// ===== Memory CRUD =====
function getMemories() {
  try { return JSON.parse(profileGet('memories') || '[]'); } catch { return []; }
}
function setMemories(mems) {
  profileSet('memories', JSON.stringify(mems));
  renderMemories();
}
function renderMemories() {
  const list = document.getElementById('sp-mem-list');
  if (!list) return;
  const mems = getMemories();
  if (!mems.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:4px 0;">No memories yet</div>';
    return;
  }
  list.innerHTML = mems.map((m, i) =>
    `<div class="sp-mem"><div class="sp-mem-text">${escapeHTML(m)}</div><button class="sp-mem-del" onclick="deleteMemory(${i})" title="Delete">×</button></div>`
  ).join('');
}
function addMemoryFromInput() {
  const el = document.getElementById('sp-mem-new');
  if (!el) return;
  const v = el.value.trim();
  if (!v) return;
  const mems = getMemories();
  mems.push(v);
  setMemories(mems);
  el.value = '';
  showToast('Memory added');
}
function deleteMemory(i) {
  const mems = getMemories();
  if (i < 0 || i >= mems.length) return;
  mems.splice(i, 1);
  setMemories(mems);
}

// ===== AI-written memory (read-only for the user) =====
// The AI emits [REMEMBER fact="..."] markers during conversation. Those
// facts are appended here and injected into every future system prompt.
// The user can VIEW this list but not edit individual entries — only the
// AI can add to it. A "Reset" button clears the whole list as an escape
// hatch in case the AI has learned something wrong.
function getAIMemory() {
  try { return JSON.parse(profileGet('ai-memory') || '[]'); } catch { return []; }
}
function setAIMemory(mems) {
  // No cap — the user explicitly wants unlimited memory. Only constraint
  // is localStorage / KV payload size, which will complain on its own if
  // it ever matters.
  profileSet('ai-memory', JSON.stringify(mems));
  renderAIMemory();
}
function appendAIMemory(fact) {
  fact = String(fact || '').trim();
  if (!fact) return;
  const mems = getAIMemory();
  // Avoid exact duplicates.
  if (mems.includes(fact)) return;
  mems.push(fact);
  setAIMemory(mems);
}
function renderAIMemory() {
  const list = document.getElementById('sp-aimem-list');
  if (!list) return;
  const mems = getAIMemory();
  if (!mems.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:4px 0;">Nothing yet. As you chat, the AI will remember facts about you here.</div>';
    return;
  }
  list.innerHTML = mems.map((m) =>
    `<div class="sp-mem sp-mem-ai"><div class="sp-mem-text">${escapeHTML(m)}</div></div>`
  ).join('');
}
function resetAIMemory() {
  if (!confirm('Clear everything the AI has remembered about you? This cannot be undone.')) return;
  setAIMemory([]);
  showToast('AI memory cleared');
}

// ===== Debug log render =====
function renderDebugLog() {
  const el = document.getElementById('sp-debug-log');
  if (!el) return;
  if (typeof DEBUG_LOG === 'undefined' || !DEBUG_LOG.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:6px 0;">No requests logged yet</div>';
    return;
  }
  el.innerHTML = DEBUG_LOG.map(e => {
    const statusClass = e.ok ? 'dbg-ok' : 'dbg-err';
    const time = new Date(e.ts).toLocaleTimeString();
    const short = e.url.length > 70 ? e.url.slice(0, 70) + '…' : e.url;
    return `<div class="dbg-row"><span class="dbg-ts">${time}</span><span class="dbg-method">${e.method}</span><span class="dbg-status ${statusClass}">${e.status || '∅'}</span><span class="dbg-ms">${e.ms}ms</span><span class="dbg-url" title="${escapeHTML(e.url)}">${escapeHTML(short)}</span></div>`;
  }).join('');
}
function clearDebugLog() {
  if (typeof DEBUG_LOG !== 'undefined') DEBUG_LOG.length = 0;
  renderDebugLog();
}

// ===== Export chat history as JSON =====
function exportAllChats() {
  const data = {
    exported_at: new Date().toISOString(),
    profile_id: activeProfileId,
    chats: (typeof loadHistory === 'function' ? loadHistory() : []),
    persona: profileGet('persona') || '',
    memories: getMemories(),
    ai_memory: getAIMemory(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kemllm-export-' + Date.now() + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
  showToast('Exported ' + data.chats.length + ' chats');
}

function renderModelsPanel() {
  const grid = document.getElementById('mp-grid');
  if (!grid) return;
  // Build a card for any model entry, showing the actual Replicate slug or
  // direct-API id under the name. Cards for API-only models that can't be
  // used yet are dimmed.
  const card = (m, kind) => {
    const usable = kind === 'chat'
      ? isChatModelUsable(m)
      : !!profileGet('rep-key'); // image/video → just need Replicate
    const sub = m.replicateId || (m.apiId ? `${m.provider} · ${m.apiId}` : '');
    const dimmed = usable ? '' : ' style="opacity:.4;"';
    const dot = kind === 'chat' ? PROVIDER_COLORS[m.provider] : (kind === 'image' ? '#f472b6' : '#4ade80');
    const tag = m.requiresDirectKey ? '<span class="mdi-tag" style="margin-left:4px;">api</span>' : '';
    return `<div class="mp-card"${dimmed}>
      <div class="mp-card-top">
        <span class="mdot" style="background:${dot}"></span>
        <div class="mp-card-n">${escapeHTML(m.name)}${tag}</div>
      </div>
      <div class="mp-card-s">${escapeHTML(sub)}</div>
      <div class="mp-card-prov">${kind}${m.provider ? ' · ' + m.provider : ''}</div>
    </div>`;
  };
  let html = '<div class="mp-section-h">CHAT</div><div class="mp-grid">';
  html += CHAT_MODELS.map(m => card(m, 'chat')).join('');
  html += '</div><div class="mp-section-h">IMAGE</div><div class="mp-grid">';
  html += IMAGE_MODELS.map(m => card(m, 'image')).join('');
  html += '</div><div class="mp-section-h">VIDEO</div><div class="mp-grid">';
  html += VIDEO_MODELS.map(m => card(m, 'video')).join('');
  html += '</div>';
  grid.innerHTML = html;
  return;
}
