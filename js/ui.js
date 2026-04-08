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
const VALID_PANELS = ['chat', 'code', 'settings'];

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
  if (!skipHash) setHashForPanel(panel, panel === 'chat' ? currentChatId : null);
  // Update document title so it shows in browser history / tab bar
  const pretty = panel.charAt(0).toUpperCase() + panel.slice(1);
  document.title = 'KEMLLM · ' + pretty;
  if (typeof syncHomeMusic === 'function') syncHomeMusic();
}

// Apply whatever the URL hash currently says: switch panel + load chat
// if a chatId is present. Used by initRouter, popstate, and hashchange.
function applyHashRoute() {
  const { panel, chatId } = parseHash();
  // Switch panel first (don't push the hash again — we're reading from it)
  siNav(panel, true);
  if (panel === 'chat') {
    if (chatId) {
      // Load the chat only if it's not already the active one
      if (chatId !== currentChatId && typeof loadHistory === 'function') {
        const exists = loadHistory().some(c => c.id === chatId);
        if (exists && typeof loadChat === 'function') {
          loadChat(chatId, true);
        }
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

// ===== Background music =====
// Two backends: <audio> for direct audio URLs, YT IFrame Player for
// YouTube links. Plays only when home screen is visible AND the toggle
// is enabled in Settings. Browser autoplay restrictions still apply —
// the first user click anywhere unlocks playback.
let _ytPlayer = null;
let _ytApiReady = false;
let _ytPendingId = null;

// Hardcoded music URL — the user's chosen link. This is the ONLY track
// that can play; there's no URL field in Settings. To change it, edit
// this constant.
const HOME_MUSIC_URL = 'https://www.youtube.com/watch?v=7cMp97PPzxc';

function youtubeIdFromUrl(url) {
  if (!url) return null;
  // youtube.com/watch?v=ID, youtube.com/watch?...&v=ID, youtu.be/ID,
  // youtube.com/embed/ID, music.youtube.com/watch?v=ID
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function ensureYTApi() {
  if (window.YT && window.YT.Player) { _ytApiReady = true; return; }
  if (document.getElementById('yt-iframe-api-script')) return;
  // The YT IFrame API calls window.onYouTubeIframeAPIReady when loaded
  window.onYouTubeIframeAPIReady = function() {
    _ytApiReady = true;
    // Re-sync now that we have the API
    if (typeof syncHomeMusic === 'function') syncHomeMusic();
  };
  const s = document.createElement('script');
  s.id = 'yt-iframe-api-script';
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
}

function syncHomeMusic() {
  const url = HOME_MUSIC_URL;
  // Music is AUTO-ON by default. Only off if the user explicitly set music-on to '0'.
  const musicOnPref = typeof profileGet === 'function' ? profileGet('music-on') : null;
  const on = musicOnPref !== '0';
  const vol = parseInt((typeof profileGet === 'function' && profileGet('music-vol')) || '50', 10);
  const homeEl = document.getElementById('home-screen');
  const homeVisible = homeEl && !homeEl.classList.contains('hidden') && currentPanel === 'chat';
  const ytId = youtubeIdFromUrl(url);
  const audioEl = document.getElementById('home-music');

  // Stop everything if disabled, no URL, or home screen not visible
  if (!on || !url || !homeVisible) {
    if (_ytPlayer) { try { _ytPlayer.pauseVideo(); } catch {} }
    if (audioEl && !audioEl.paused) { try { audioEl.pause(); } catch {} }
    return;
  }

  if (ytId) {
    // YouTube path
    if (audioEl && !audioEl.paused) { try { audioEl.pause(); } catch {} }
    ensureYTApi();
    if (!_ytApiReady) { _ytPendingId = ytId; return; }
    if (!_ytPlayer) {
      try {
        _ytPlayer = new YT.Player('home-music-yt', {
          height: '1',
          width: '1',
          videoId: ytId,
          playerVars: {
            autoplay: 1,
            controls: 0,
            disablekb: 1,
            fs: 0,
            modestbranding: 1,
            rel: 0,
            loop: 1,
            playlist: ytId, // required for loop=1 to actually loop
          },
          events: {
            onReady: function(e) {
              try {
                e.target.setVolume(vol);
                e.target.playVideo();
              } catch {}
            },
            onStateChange: function(e) {
              // Restart on end (extra safety on top of loop=1)
              if (e.data === YT.PlayerState.ENDED) {
                try { e.target.playVideo(); } catch {}
              }
            },
          },
        });
      } catch (err) { console.warn('[KEMLLM] YT player init failed', err); }
    } else {
      try {
        _ytPlayer.setVolume(vol);
        const cur = _ytPlayer.getVideoData && _ytPlayer.getVideoData();
        if (cur && cur.video_id !== ytId) {
          _ytPlayer.loadVideoById(ytId);
        }
        _ytPlayer.playVideo();
      } catch {}
    }
  } else {
    // Direct audio URL path
    if (_ytPlayer) { try { _ytPlayer.pauseVideo(); } catch {} }
    if (!audioEl) return;
    if (audioEl.src !== url) audioEl.src = url;
    audioEl.volume = Math.max(0, Math.min(1, vol / 100));
    audioEl.loop = true;
    audioEl.play().catch(() => {/* autoplay blocked, will retry on user click */});
  }
}

// First-click unlock — browsers won't autoplay audio until the user
// interacts with the page. Re-sync the music on the first pointer event.
let _musicUnlocked = false;
function _musicUnlockOnce() {
  if (_musicUnlocked) return;
  _musicUnlocked = true;
  syncHomeMusic();
}
document.addEventListener('click', _musicUnlockOnce, { once: false, capture: true });
document.addEventListener('keydown', _musicUnlockOnce, { once: false, capture: true });

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
