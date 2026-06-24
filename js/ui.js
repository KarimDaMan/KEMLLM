// ========== KEMLLM UI Controllers ==========
'use strict';

let currentPanel = 'chat';

// ===== Hash-based router =====
// Each panel AND each chat gets its own URL so browser back/forward/reload
// work and you can deep-link to a specific conversation.
// Routes:
//   #/chat              → home screen / new chat
//   #/chat/<chatId>     → a specific chat by id
//   #/code, #/models, #/settings → other panels
// Legacy (no hash) → defaults to chat.
const VALID_PANELS = ['chat', 'workspace', 'models', 'media', 'code', 'settings'];

function parseHash() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  const panel = VALID_PANELS.includes((parts[0] || '').toLowerCase()) ? parts[0].toLowerCase() : 'chat';
  const chatId = (panel === 'chat' && parts[1]) ? parts[1] : null;
  return { panel, chatId };
}

function panelFromHash() { return parseHash().panel; }
function chatIdFromHash() { return parseHash().chatId; }

function setHashForPanel(panel, chatId) {
  let want = '#/' + panel;
  if (panel === 'chat' && chatId) want += '/' + chatId;
  if (location.hash !== want) {
    history.pushState({ panel, chatId }, '', want);
  }
}

function siNav(panel, skipHash) {
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
  if (!skipHash) setHashForPanel(panel, panel === 'chat' ? currentChatId : null);
  // Update document title so it shows in browser history / tab bar
  const pretty = panel.charAt(0).toUpperCase() + panel.slice(1);
  document.title = 'KEMLLM · ' + pretty;
  if (panel === 'media' && typeof renderMediaGrid === 'function') renderMediaGrid();
  if (panel === 'workspace' && typeof renderWorkspace === 'function') renderWorkspace();
  if (panel === 'models' && typeof renderModelsPanel === 'function') renderModelsPanel();
}

// ===== Media panel =====
// Scans every chat in history for generated images + videos and renders
// them as a grid. Each item has a download button and opens fullscreen
// when clicked.
let _mediaFilter = 'all';
function collectAllMedia() {
  const list = typeof loadHistory === 'function' ? loadHistory() : [];
  const items = [];
  const imgRe = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  const vidRe = /<video[^>]*\ssrc=["']([^"']+)["'][^>]*>/g;
  for (const chat of list) {
    for (const m of (chat.messages || [])) {
      const c = typeof m.content === 'string' ? m.content : '';
      if (!c) continue;
      let match;
      imgRe.lastIndex = 0;
      while ((match = imgRe.exec(c)) !== null) {
        items.push({
          type: 'image',
          url: match[2],
          alt: match[1] || '',
          chatId: chat.id,
          chatTitle: chat.title || 'Chat',
          modelName: m.modelName || 'Image',
          ts: chat.ts || 0,
        });
      }
      vidRe.lastIndex = 0;
      while ((match = vidRe.exec(c)) !== null) {
        items.push({
          type: 'video',
          url: match[1],
          chatId: chat.id,
          chatTitle: chat.title || 'Chat',
          modelName: m.modelName || 'Video',
          ts: chat.ts || 0,
        });
      }
    }
  }
  // Newest first
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return items;
}

function renderMediaGrid() {
  const grid = document.getElementById('media-grid');
  if (!grid) return;
  let items = collectAllMedia();
  if (_mediaFilter !== 'all') items = items.filter(i => i.type === _mediaFilter);
  document.querySelectorAll('.media-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.mediaTab === _mediaFilter);
  });
  if (!items.length) {
    grid.innerHTML = `<div class="media-empty">No ${_mediaFilter === 'all' ? '' : _mediaFilter + ' '}media yet. Generate some in a chat and it will show up here.</div>`;
    return;
  }
  grid.innerHTML = items.map((it, idx) => {
    const safeName = escapeHTML(it.modelName);
    const safeUrl = escapeHTML(it.url);
    const media = it.type === 'image'
      ? `<img src="${safeUrl}" loading="lazy" onclick="openMediaViewer(${idx})">`
      : `<video src="${safeUrl}" muted loop onmouseover="this.play()" onmouseout="this.pause()" onclick="openMediaViewer(${idx})"></video>`;
    return `<div class="media-item" data-media-idx="${idx}">
      ${media}
      <div class="media-badge">${it.type}</div>
      <div class="media-meta">
        <div class="media-name">${safeName}</div>
        <button class="media-dl" onclick="event.stopPropagation();downloadMediaUrl('${safeUrl.replace(/'/g, "\\'")}','${it.type}')" title="Download">↓</button>
      </div>
    </div>`;
  }).join('');
  // Cache items globally for the viewer callback
  window._mediaCache = items;
}

function openMediaViewer(idx) {
  const items = window._mediaCache || [];
  const it = items[idx];
  if (!it) return;
  if (it.type === 'image') {
    if (typeof openImageViewer === 'function') openImageViewer(it.url);
  } else {
    // Open video in a new tab for now
    window.open(it.url, '_blank');
  }
}

async function downloadMediaUrl(url, type) {
  try {
    showToast('Downloading…');
    const r = await fetch(url);
    if (!r.ok) { showToast('Download failed: HTTP ' + r.status); return; }
    const blob = await r.blob();
    const ext = (blob.type.split('/')[1] || (type === 'video' ? 'mp4' : 'png')).split(';')[0];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kemllm-' + Date.now() + '.' + ext;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 1000);
  } catch (e) { showToast('Download failed: ' + (e.message || e)); }
}

// Wire filter tabs once the DOM is ready
document.addEventListener('click', (e) => {
  const t = e.target.closest('.media-tab');
  if (!t) return;
  _mediaFilter = t.dataset.mediaTab || 'all';
  renderMediaGrid();
});

// ===== Workspace =====
let _owActiveTab = 'knowledge';
const OW_TOOL_DEFAULTS = [
  { id: 'web', name: 'Web Search', desc: 'Search the web from chat and cite sources.', key: 'sandbox-web' },
  { id: 'url', name: 'URL Fetch', desc: 'Pull page text into a prompt with the # URL pattern.' },
  { id: 'code', name: 'Code Interpreter', desc: 'Run Python and JavaScript from chat.' },
  { id: 'image', name: 'Image Generation', desc: 'Create and edit images from the composer.' },
  { id: 'knowledge', name: 'Knowledge Retrieval', desc: 'Use local workspace documents as context.' },
  { id: 'memory', name: 'Memory', desc: 'Inject saved preferences into new chats.' },
];

function owGet(key, fallback) { return profileGetJSON('ow_' + key, fallback); }
function owSet(key, value) { profileSetJSON('ow_' + key, value); }
function owUid(prefix) { return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
function owRenderEmpty(text) { return `<div class="ow-empty">${escapeHTML(text)}</div>`; }

function owSetTab(tab) {
  _owActiveTab = tab || 'knowledge';
  document.querySelectorAll('.ow-tab').forEach(t => t.classList.toggle('active', t.dataset.owTab === _owActiveTab));
  document.querySelectorAll('.ow-panel').forEach(p => p.classList.toggle('active', p.dataset.owPanel === _owActiveTab));
  renderWorkspace();
}

async function owAddKnowledge() {
  const nameEl = document.getElementById('ow-kb-name');
  const descEl = document.getElementById('ow-kb-desc');
  const modeEl = document.getElementById('ow-kb-mode');
  const filesEl = document.getElementById('ow-kb-files');
  const files = Array.from(filesEl?.files || []);
  const name = (nameEl?.value || '').trim() || (files[0]?.name ? files[0].name.replace(/\.[^.]+$/, '') : '');
  if (!name && !files.length) { showToast('Add a name or file'); return; }
  const readFiles = [];
  for (const f of files) {
    let text = '';
    try { text = await f.text(); } catch {}
    readFiles.push({ id: owUid('file'), name: f.name, size: f.size, type: f.type || 'text/plain', text: text.slice(0, 180000), ts: Date.now() });
  }
  const list = owGet('knowledge', []);
  list.unshift({ id: owUid('kb'), name: name || 'Untitled knowledge', desc: (descEl?.value || '').trim(), mode: modeEl?.value || 'focused', files: readFiles, ts: Date.now() });
  owSet('knowledge', list);
  if (nameEl) nameEl.value = '';
  if (descEl) descEl.value = '';
  if (filesEl) filesEl.value = '';
  renderWorkspace();
  showToast('Knowledge added');
}
function owDeleteKnowledge(id) { owSet('knowledge', owGet('knowledge', []).filter(k => k.id !== id)); renderWorkspace(); }
function owUseKnowledge(id) {
  const kb = owGet('knowledge', []).find(k => k.id === id);
  if (!kb) return;
  const input = document.getElementById('input-text');
  const fileText = (kb.files || []).map(f => `### ${f.name}\n${f.text || ''}`).join('\n\n').slice(0, 24000);
  const prompt = kb.mode === 'full'
    ? `Use this knowledge base as full context:\n\n# ${kb.name}\n${kb.desc || ''}\n\n${fileText}\n\nTask: `
    : `Search the knowledge base "${kb.name}" for relevant context before answering. Summary: ${kb.desc || 'No description'}\n\nTask: `;
  if (input) {
    input.value = prompt;
    input.dispatchEvent(new Event('input'));
    input.focus();
  }
  siNav('chat');
}
function owSearchKnowledge() {
  const q = (document.getElementById('ow-kb-query')?.value || '').trim().toLowerCase();
  const host = document.getElementById('ow-kb-results');
  if (!host) return;
  if (!q) { host.innerHTML = owRenderEmpty('Type to search local knowledge'); return; }
  const hits = [];
  owGet('knowledge', []).forEach(kb => {
    (kb.files || []).forEach(file => {
      const hay = `${kb.name}\n${file.name}\n${file.text || ''}`.toLowerCase();
      const at = hay.indexOf(q);
      if (at >= 0) {
        const raw = file.text || '';
        const start = Math.max(0, raw.toLowerCase().indexOf(q) - 90);
        hits.push({ kb, file, excerpt: raw.slice(start, start + 220) || file.name });
      }
    });
  });
  host.innerHTML = hits.length ? hits.slice(0, 8).map(h => `
    <div class="ow-item">
      <div class="ow-item-main">
        <div class="ow-item-title">${escapeHTML(h.file.name)}</div>
        <div class="ow-item-sub">${escapeHTML(h.kb.name)} - ${escapeHTML(h.excerpt)}</div>
      </div>
      <button class="ow-mini" onclick="owUseKnowledge('${h.kb.id}')">Use</button>
    </div>`).join('') : owRenderEmpty('No matches');
}
function renderKnowledge() {
  const list = document.getElementById('ow-kb-list');
  if (!list) return;
  const data = owGet('knowledge', []);
  owSearchKnowledge();
  if (!data.length) { list.innerHTML = owRenderEmpty('No knowledge bases yet'); return; }
  list.innerHTML = data.map(k => {
    const files = (k.files || []).map(f => `<span class="ow-pill">${escapeHTML(f.name)}</span>`).join('');
    return `<div class="ow-item">
      <div class="ow-item-main">
        <div class="ow-item-title">${escapeHTML(k.name)} <span class="ow-tag">${k.mode === 'full' ? 'full context' : 'focused retrieval'}</span></div>
        <div class="ow-item-sub">${escapeHTML(k.desc || 'No description')}</div>
        <div class="ow-pills">${files || '<span class="ow-pill">no files</span>'}</div>
      </div>
      <button class="ow-mini" onclick="owUseKnowledge('${k.id}')">Use</button>
      <button class="ow-mini danger" onclick="owDeleteKnowledge('${k.id}')">Delete</button>
    </div>`;
  }).join('');
}

function owAddPrompt() {
  const title = (document.getElementById('ow-prompt-title')?.value || '').trim();
  const body = (document.getElementById('ow-prompt-body')?.value || '').trim();
  if (!title || !body) { showToast('Prompt title and body required'); return; }
  const list = owGet('prompts', []);
  list.unshift({ id: owUid('prompt'), title, body, ts: Date.now() });
  owSet('prompts', list);
  document.getElementById('ow-prompt-title').value = '';
  document.getElementById('ow-prompt-body').value = '';
  renderWorkspace();
}
function owDeletePrompt(id) { owSet('prompts', owGet('prompts', []).filter(p => p.id !== id)); renderWorkspace(); }
function owUsePrompt(id) {
  const p = owGet('prompts', []).find(x => x.id === id);
  if (!p) return;
  const input = document.getElementById('input-text');
  if (input) {
    input.value = p.body
      .replace(/\{\{\s*date\s*\}\}/gi, new Date().toLocaleDateString())
      .replace(/\{\{\s*model\s*\}\}/gi, findModel(selectedChat, 'chat')?.name || 'selected model');
    input.dispatchEvent(new Event('input'));
    input.focus();
  }
  siNav('chat');
}
function renderPrompts() {
  const host = document.getElementById('ow-prompt-list');
  if (!host) return;
  const list = owGet('prompts', []);
  host.innerHTML = list.length ? list.map(p => `<div class="ow-item">
    <div class="ow-item-main"><div class="ow-item-title">${escapeHTML(p.title)}</div><div class="ow-item-sub">${escapeHTML(p.body.slice(0, 180))}</div></div>
    <button class="ow-mini" onclick="owUsePrompt('${p.id}')">Use</button>
    <button class="ow-mini danger" onclick="owDeletePrompt('${p.id}')">Delete</button>
  </div>`).join('') : owRenderEmpty('No saved prompts');
}

function owToolsState() {
  const saved = owGet('tools', {});
  const state = {};
  OW_TOOL_DEFAULTS.forEach(t => {
    if (t.key === 'sandbox-web') state[t.id] = profileGet(t.key) !== '0';
    else state[t.id] = saved[t.id] !== false;
  });
  return state;
}
function owToggleTool(id) {
  const state = owToolsState();
  state[id] = !state[id];
  if (id === 'web') {
    profileSet('sandbox-web', state[id] ? '1' : '0');
    window.webSearchOn = state[id];
    if (typeof updateWebButton === 'function') updateWebButton();
  }
  owSet('tools', state);
  renderTools();
}
function renderTools() {
  const host = document.getElementById('ow-tool-list');
  if (!host) return;
  const state = owToolsState();
  host.innerHTML = OW_TOOL_DEFAULTS.map(t => `<button class="ow-tool ${state[t.id] ? 'on' : ''}" onclick="owToggleTool('${t.id}')">
    <span class="ow-tool-dot"></span>
    <span><strong>${escapeHTML(t.name)}</strong><small>${escapeHTML(t.desc)}</small></span>
  </button>`).join('');
}

function owAddNote() {
  const title = (document.getElementById('ow-note-title')?.value || '').trim();
  const body = (document.getElementById('ow-note-body')?.value || '').trim();
  if (!title && !body) return;
  const list = owGet('notes', []);
  list.unshift({ id: owUid('note'), title: title || 'Untitled note', body, ts: Date.now() });
  owSet('notes', list);
  document.getElementById('ow-note-title').value = '';
  document.getElementById('ow-note-body').value = '';
  renderWorkspace();
}
function owDeleteNote(id) { owSet('notes', owGet('notes', []).filter(n => n.id !== id)); renderWorkspace(); }
function owUseNote(id) {
  const n = owGet('notes', []).find(x => x.id === id);
  if (!n) return;
  const input = document.getElementById('input-text');
  if (input) {
    input.value = `Use this note as context:\n\n# ${n.title}\n${n.body}\n\nTask: `;
    input.dispatchEvent(new Event('input'));
  }
  siNav('chat');
}
function renderNotes() {
  const host = document.getElementById('ow-note-list');
  if (!host) return;
  const list = owGet('notes', []);
  host.innerHTML = list.length ? list.map(n => `<div class="ow-item">
    <div class="ow-item-main"><div class="ow-item-title">${escapeHTML(n.title)}</div><div class="ow-item-sub">${escapeHTML(n.body.slice(0, 220))}</div></div>
    <button class="ow-mini" onclick="owUseNote('${n.id}')">Use</button>
    <button class="ow-mini danger" onclick="owDeleteNote('${n.id}')">Delete</button>
  </div>`).join('') : owRenderEmpty('No notes yet');
}

function owAddAutomation() {
  const name = (document.getElementById('ow-auto-name')?.value || '').trim();
  const when = (document.getElementById('ow-auto-when')?.value || '').trim();
  const prompt = (document.getElementById('ow-auto-prompt')?.value || '').trim();
  if (!name || !prompt) { showToast('Automation name and prompt required'); return; }
  const list = owGet('automations', []);
  list.unshift({ id: owUid('auto'), name, when: when || 'manual', prompt, enabled: true, ts: Date.now() });
  owSet('automations', list);
  ['ow-auto-name', 'ow-auto-when', 'ow-auto-prompt'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  renderWorkspace();
}
function owDeleteAutomation(id) { owSet('automations', owGet('automations', []).filter(a => a.id !== id)); renderWorkspace(); }
function owRunAutomation(id) {
  const a = owGet('automations', []).find(x => x.id === id);
  if (!a) return;
  const input = document.getElementById('input-text');
  if (input) {
    input.value = a.prompt;
    input.dispatchEvent(new Event('input'));
  }
  siNav('chat');
}
function renderAutomations() {
  const host = document.getElementById('ow-auto-list');
  if (!host) return;
  const list = owGet('automations', []);
  host.innerHTML = list.length ? list.map(a => `<div class="ow-item">
    <div class="ow-item-main"><div class="ow-item-title">${escapeHTML(a.name)} <span class="ow-tag">${escapeHTML(a.when)}</span></div><div class="ow-item-sub">${escapeHTML(a.prompt.slice(0, 220))}</div></div>
    <button class="ow-mini" onclick="owRunAutomation('${a.id}')">Run</button>
    <button class="ow-mini danger" onclick="owDeleteAutomation('${a.id}')">Delete</button>
  </div>`).join('') : owRenderEmpty('No automations yet');
}

function owAddChannel() {
  const name = (document.getElementById('ow-channel-name')?.value || '').trim();
  const models = (document.getElementById('ow-channel-models')?.value || '').trim();
  if (!name) return;
  const list = owGet('channels', []);
  list.unshift({ id: owUid('channel'), name, models, ts: Date.now() });
  owSet('channels', list);
  document.getElementById('ow-channel-name').value = '';
  document.getElementById('ow-channel-models').value = '';
  renderWorkspace();
}
function owDeleteChannel(id) { owSet('channels', owGet('channels', []).filter(c => c.id !== id)); renderWorkspace(); }
function owOpenChannel(id) {
  const c = owGet('channels', []).find(x => x.id === id);
  if (!c) return;
  const input = document.getElementById('input-text');
  if (input) {
    input.value = `Channel: ${c.name}\nModels: ${c.models || 'selected model'}\n\n`;
    input.dispatchEvent(new Event('input'));
  }
  siNav('chat');
}
function renderChannels() {
  const host = document.getElementById('ow-channel-list');
  if (!host) return;
  const list = owGet('channels', []);
  host.innerHTML = list.length ? list.map(c => `<div class="ow-item">
    <div class="ow-item-main"><div class="ow-item-title"># ${escapeHTML(c.name)}</div><div class="ow-item-sub">${escapeHTML(c.models || 'No model mentions')}</div></div>
    <button class="ow-mini" onclick="owOpenChannel('${c.id}')">Open</button>
    <button class="ow-mini danger" onclick="owDeleteChannel('${c.id}')">Delete</button>
  </div>`).join('') : owRenderEmpty('No channels yet');
}

function renderAdmin() {
  const providers = document.getElementById('ow-admin-providers');
  if (providers) {
    const rows = [
      ['Replicate', !!profileGet('rep-key')],
      ['OpenAI', !!profileGet('key-openai')],
      ['Anthropic', !!profileGet('key-anthropic')],
      ['Google AI', !!profileGet('key-google')],
      ['xAI', !!profileGet('key-xai')],
    ];
    providers.innerHTML = rows.map(([name, ok]) => `<div class="ow-status"><span>${name}</span><b class="${ok ? 'ok' : ''}">${ok ? 'connected' : 'needs key'}</b></div>`).join('');
  }
  const perms = document.getElementById('ow-admin-permissions');
  if (perms) perms.innerHTML = ['Chat', 'Workspace', 'Tools', 'Media', 'Settings'].map(x => `<div class="ow-status"><span>${x}</span><b class="ok">owner</b></div>`).join('');
  const runtime = document.getElementById('ow-admin-runtime');
  if (runtime) {
    runtime.innerHTML = [
      ['PWA shell', 'ready'],
      ['Code runner', 'browser'],
      ['Sync', activeProfileId ? 'profile' : 'local'],
    ].map(([a, b]) => `<div class="ow-status"><span>${a}</span><b class="ok">${b}</b></div>`).join('');
  }
}

function renderWorkspace() {
  document.querySelectorAll('.ow-tab').forEach(t => t.classList.toggle('active', t.dataset.owTab === _owActiveTab));
  document.querySelectorAll('.ow-panel').forEach(p => p.classList.toggle('active', p.dataset.owPanel === _owActiveTab));
  renderKnowledge();
  renderPrompts();
  renderTools();
  renderNotes();
  renderAutomations();
  renderChannels();
  renderAdmin();
}

function owExportWorkspace() {
  const data = {
    exported_at: new Date().toISOString(),
    knowledge: owGet('knowledge', []),
    prompts: owGet('prompts', []),
    tools: owToolsState(),
    notes: owGet('notes', []),
    automations: owGet('automations', []),
    channels: owGet('channels', []),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kemllm-workspace-' + Date.now() + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

// Apply whatever the URL hash currently says: switch panel + load chat
// if a chatId is present. Used by initRouter, popstate, and hashchange.
function applyHashRoute() {
  const { panel, chatId } = parseHash();
  // Switch panel first (don't push the hash again — we're reading from it)
  siNav(panel, true);
  if (panel === 'chat') {
    if (chatId) {
      // Load the chat only if it's not already the active one. If the
      // chat id isn't in history yet (profile not loaded, sync race,
      // etc), retry briefly so a page reload on #/chat/<id> restores
      // the chat instead of bouncing to the home screen.
      if (chatId !== currentChatId) {
        const tryLoad = (attempt) => {
          const list = typeof loadHistory === 'function' ? loadHistory() : [];
          if (list.some(c => c.id === chatId)) {
            if (typeof loadChat === 'function') loadChat(chatId, true);
          } else if (attempt < 8) {
            setTimeout(() => tryLoad(attempt + 1), 150);
          }
        };
        tryLoad(0);
      }
    } else {
      // Hash says #/chat with no id → home screen / new chat
      if (currentChatId !== null && typeof newChat === 'function') {
        newChat(true);
      }
    }
  }
}

function initRouter() {
  applyHashRoute();
  window.addEventListener('popstate', applyHashRoute);
  window.addEventListener('hashchange', applyHashRoute);
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
      // Sort by creator prefix (the part before '/' in replicateId),
      // then by name within each creator group.
      const sortedImg = [...IMAGE_MODELS].sort((a, b) => {
        const ca = (a.replicateId || '').split('/')[0];
        const cb = (b.replicateId || '').split('/')[0];
        return ca.localeCompare(cb) || a.name.localeCompare(b.name);
      });
      let lastCreator = null;
      sortedImg.forEach(m => {
        const creator = (m.replicateId || '').split('/')[0];
        if (creator !== lastCreator) {
          html += `<div class="mds mds-creator">${escapeHTML(creator.toUpperCase())}</div>`;
          lastCreator = creator;
        }
        // Tag models that need an image input (edit-only) so the user
        // knows to pair them with an attachment.
        const needsImage = /kontext|edit|inpaint|img2img|variat/i.test(m.replicateId || '');
        const tag = needsImage ? ' <span class="mdi-tag mdi-tag-img">IMG INPUT</span>' : '';
        html += `<div class="mdi${m.id === selectedImage ? ' sel' : ''}" onclick="selectImgModel('${m.id}')"><span class="mdot" style="background:#f472b6"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)}${tag}</div><div class="mdi-s">${escapeHTML(m.replicateId)}</div></div></div>`;
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
      const sortedVid = [...VIDEO_MODELS].sort((a, b) => {
        const ca = (a.replicateId || '').split('/')[0];
        const cb = (b.replicateId || '').split('/')[0];
        return ca.localeCompare(cb) || a.name.localeCompare(b.name);
      });
      let lastVidCreator = null;
      sortedVid.forEach(m => {
        const creator = (m.replicateId || '').split('/')[0];
        if (creator !== lastVidCreator) {
          html += `<div class="mds mds-creator">${escapeHTML(creator.toUpperCase())}</div>`;
          lastVidCreator = creator;
        }
        const needsImage = /i2v|img2vid|image-to|kontext/i.test(m.replicateId || '');
        const tag = needsImage ? ' <span class="mdi-tag mdi-tag-img">IMG INPUT</span>' : '';
        html += `<div class="mdi${m.id === selectedVideo ? ' sel' : ''}" onclick="selectVidModel('${m.id}')"><span class="mdot" style="background:#4ade80"></span><div class="mdi-info"><div class="mdi-n">${escapeHTML(m.name)}${tag}</div><div class="mdi-s">${escapeHTML(m.replicateId)}</div></div></div>`;
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
  // Refresh the gen-chip strip if the user is currently in image mode
  if (typeof renderGenChips === 'function' && chatMode === 'image') renderGenChips();
}
function selectVidModel(id) {
  selectedVideo = id;
  profileSet('selected_video', id);
  closeAllDrops();
  renderModelDropdowns();
  if (typeof renderGenChips === 'function' && chatMode === 'video') renderGenChips();
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
  // Real setting: sandbox-web (also controls whether code execution
  // can hit the network). Mirrored into the Settings toggle.
  const isOn = profileGet('sandbox-web') !== '0';
  const next = !isOn;
  profileSet('sandbox-web', next ? '1' : '0');
  window.webSearchOn = next;
  const btn = document.getElementById('tb-web');
  if (btn) btn.classList.toggle('on', next);
  const sandboxEl = document.getElementById('sp-sandbox-web');
  if (sandboxEl) sandboxEl.checked = next;
  showToast('Web access ' + (next ? 'enabled' : 'disabled'));
  return;
}

// ===== MCP Connectors =====
// REMOVED. The old "Connectors" modal was placebo — it just opened an OAuth
// popup and marked the service as "connected" without actually doing any
// token exchange or MCP handshake. Anything that calls loadMCPState /
// updateMCPBadge keeps working as a no-op so there are no ReferenceErrors.
function loadMCPState() {}
function updateMCPBadge() {}

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

// ===== Skins =====
// A skin is a palette + typography theme layered over the KEMLLM identity.
// The KEMLLM name and triangle logo stay on every skin — the logo just
// gets recolored to match the skin's accent via CSS. Tile labels reference
// the AI product each palette is inspired by; no logos or UIs are copied.
// Picked skin persists per-profile and syncs across devices.
const KEMLLM_SKINS = [
  { id: 'kemllm',     name: 'KEMLLM',     swA: '#f87171', swB: '#000'    },
  { id: 'chatgpt',    name: 'ChatGPT',    swA: '#10a37f', swB: '#212121' },
  { id: 'claude',     name: 'Claude',     swA: '#c96442', swB: '#f5f4ee' },
  { id: 'gemini',     name: 'Gemini',     swA: '#4285f4', swB: '#d96570' },
  { id: 'grok',       name: 'Grok',       swA: '#fff',    swB: '#000'    },
  { id: 'meta',       name: 'Meta AI',    swA: '#0866ff', swB: '#ff3d96' },
  { id: 'deepseek',   name: 'DeepSeek',   swA: '#4d6bfe', swB: '#0f172a' },
  { id: 'qwen',       name: 'Qwen',       swA: '#a855f7', swB: '#ec4899' },
  { id: 'llama',      name: 'Llama',      swA: '#ff7a3c', swB: '#050e1a' },
  { id: 'perplexity', name: 'Perplexity', swA: '#20b8cd', swB: '#202222' },
];

function applySkin(id) {
  const skin = KEMLLM_SKINS.find(s => s.id === id) || KEMLLM_SKINS[0];
  const prev = document.body.dataset.skin;
  document.body.dataset.skin = skin.id;
  // Start/stop the KEMLLM background boot-code effect to match. CSS hides
  // the node under non-KEMLLM skins, but we also stop the timers so it
  // doesn't waste CPU, and restart them on the way back.
  if (skin.id === 'kemllm' && prev !== 'kemllm' && typeof window.termBootStart === 'function') {
    window.termBootStart();
  } else if (skin.id !== 'kemllm' && typeof window.termBootStop === 'function') {
    window.termBootStop();
  }
  // Sync the picker tiles' selected state
  document.querySelectorAll('.sp-skin').forEach(t => t.classList.toggle('sel', t.dataset.skin === skin.id));
}

function setSkin(id) {
  applySkin(id);
  profileSet('skin', id);
}

function renderSkinPicker() {
  const host = document.getElementById('sp-skins');
  if (!host) return;
  const active = (profileGet && profileGet('skin')) || 'kemllm';
  host.innerHTML = KEMLLM_SKINS.map(s => `
    <button class="sp-skin ${s.id === active ? 'sel' : ''}" data-skin="${s.id}" title="${escapeHTML(s.name)}">
      <span class="sp-skin-sw" style="--sw-a:${s.swA};--sw-b:${s.swB};"></span>
      <span class="sp-skin-name">${escapeHTML(s.name)}</span>
    </button>
  `).join('');
  host.onclick = (e) => {
    const btn = e.target.closest('.sp-skin');
    if (btn && btn.dataset.skin) setSkin(btn.dataset.skin);
  };
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
    const u = typeof e.url === 'string' ? e.url : String(e.url || '');
    const short = u.length > 70 ? u.slice(0, 70) + '…' : u;
    return `<div class="dbg-row"><span class="dbg-ts">${time}</span><span class="dbg-method">${e.method || '?'}</span><span class="dbg-status ${statusClass}">${e.status || '∅'}</span><span class="dbg-ms">${e.ms}ms</span><span class="dbg-url" title="${escapeHTML(u)}">${escapeHTML(short)}</span></div>`;
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
