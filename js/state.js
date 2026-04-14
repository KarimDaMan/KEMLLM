// ========== KEMLLM Profile / State System ==========
'use strict';

let activeProfileId = null;
let pendingProfileId = null;

const KEY_PROFILES = 'kemllm_profiles';

function profileKey(k) { return `p_${activeProfileId}_${k}`; }
function profileGet(k) {
  if (!activeProfileId) return null;
  return localStorage.getItem(profileKey(k));
}
function profileSet(k, v) {
  if (!activeProfileId) return;
  localStorage.setItem(profileKey(k), v);
  // Schedule a cloud sync push if this key is in the synced set
  if (typeof SYNC_KEYS !== 'undefined' && SYNC_KEYS.includes(k) && typeof pushSync === 'function') {
    pushSync();
  }
}
function profileGetJSON(k, fallback) {
  try { const v = profileGet(k); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function profileSetJSON(k, v) { profileSet(k, JSON.stringify(v)); }

// Single-profile architecture: there is always exactly ONE profile, with
// the fixed id 'main'. Demo mode and GitHub sign-in both operate on the
// same profile — they just flip cloud sync on or off. Any legacy random-id
// profiles are migrated to `main` on first load (see migrateToSingleProfile
// below).
const MAIN_ID = 'main';

function getProfiles() {
  try { return JSON.parse(localStorage.getItem(KEY_PROFILES) || '[]'); }
  catch { return []; }
}
function saveProfiles(p) { localStorage.setItem(KEY_PROFILES, JSON.stringify(p)); }

// Collapses the profile list to a single entry with id 'main' and
// migrates any per-profile localStorage keys (prefix `p_<oldId>_`) to
// the `p_main_` prefix. Preserves github/sync_token/avatar/name by
// preferring the most recent profile that has them set. Safe to call
// multiple times — after the first run everything lives under `main`.
function migrateToSingleProfile() {
  const list = getProfiles();
  // Already canonical single-profile layout → nothing to do.
  if (list.length === 1 && list[0].id === MAIN_ID) return;

  // Pick the "best" source profile to promote: prefer one with a github
  // account + sync_token, else the most recently used one, else create
  // a fresh empty profile.
  let src = list.find(p => p.github && p.sync_token);
  if (!src) src = list.sort((a, b) => (b.last_used || b.created || 0) - (a.last_used || a.created || 0))[0];
  const srcId = src ? src.id : null;

  // Move all `p_<srcId>_*` localStorage entries to `p_main_*`.
  if (srcId && srcId !== MAIN_ID) {
    const toMove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`p_${srcId}_`)) toMove.push(k);
    }
    toMove.forEach(k => {
      const tail = k.slice(`p_${srcId}_`.length);
      const newKey = `p_${MAIN_ID}_${tail}`;
      // Don't clobber an existing main value that was newer.
      if (localStorage.getItem(newKey) == null) {
        localStorage.setItem(newKey, localStorage.getItem(k));
      }
      localStorage.removeItem(k);
    });
  }

  // Clean up orphaned per-profile keys from OTHER old profiles.
  list.forEach(p => {
    if (!p.id || p.id === MAIN_ID || p.id === srcId) return;
    const prefix = `p_${p.id}_`;
    const toDel = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) toDel.push(k);
    }
    toDel.forEach(k => localStorage.removeItem(k));
  });

  // Write the canonical single-entry profiles array.
  const mainProfile = {
    id: MAIN_ID,
    name: (src && src.name) || 'You',
    github: (src && src.github) || null,
    sync_token: (src && src.sync_token) || null,
    avatar: (src && src.avatar) || '',
    color: (src && src.color) || '#4a9eff',
    created: (src && src.created) || Date.now(),
  };
  saveProfiles([mainProfile]);
  // Update the active-profile pointer if it was pointing at the old id.
  const activeRef = localStorage.getItem('kemllm_active');
  if (activeRef && activeRef !== MAIN_ID) {
    localStorage.setItem('kemllm_active', MAIN_ID);
  }
}

function createProfile(name, github) {
  // Always return the single `main` profile. If it already exists, update
  // its name/github fields; otherwise create it fresh.
  const list = getProfiles();
  let p = list.find(x => x.id === MAIN_ID);
  if (!p) {
    p = {
      id: MAIN_ID,
      name: name || 'You',
      github: github || null,
      color: '#4a9eff',
      created: Date.now(),
    };
    list.length = 0;
    list.push(p);
  } else {
    if (name) p.name = name;
    if (github) p.github = github;
  }
  saveProfiles(list);
  return p;
}

function activateProfile(id) {
  activeProfileId = id;
  localStorage.setItem('kemllm_active', id);
  const p = getProfiles().find(x => x.id === id);
  if (!p) return;
  document.getElementById('login').classList.remove('show');
  document.getElementById('app').classList.add('show');

  // Avatar — use GitHub avatar_url if we have one, otherwise fall back
  // to the colored letter circle. GitHub's avatar_url works with ?s=N
  // query param for a specific pixel size.
  const setAva = (el, size) => {
    if (!el) return;
    if (p.avatar) {
      const src = p.avatar + (p.avatar.includes('?') ? '&' : '?') + 's=' + (size * 2);
      el.style.background = '';
      el.style.backgroundImage = `url("${src}")`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.textContent = '';
    } else {
      el.style.backgroundImage = '';
      el.style.background = p.color;
      el.textContent = (p.name || '?')[0].toUpperCase();
    }
  };
  setAva(document.getElementById('si-ava'), 30);
  setAva(document.getElementById('tb-ava'), 32);
  const avaName = document.getElementById('si-ava-name');
  if (avaName) avaName.textContent = p.name;
  setAva(document.getElementById('um-ava'), 48);
  const umName = document.getElementById('um-name');
  if (umName) umName.textContent = p.name;
  const umEmail = document.getElementById('um-email');
  if (umEmail) umEmail.textContent = p.github ? '@' + p.github : 'Local profile';

  // Load per-profile data
  loadAllSettings();
  loadHistory();
  renderHistory();
  renderCustomModels();
  injectCustomModels();
  loadMCPState();
  applyTheme(profileGet('theme') || 'dark');
  applyAccent(profileGet('accent') || '#4a9eff');
  if (typeof applySkin === 'function') applySkin(profileGet('skin') || 'kemllm');
  // Check if HF backend supports the desktop stack → reveal the floating button
  if (typeof probeDesktopSupport === 'function') probeDesktopSupport();
  // Pull synced data from the cloud (chats/settings/custom models from
  // any other device the user has signed in on with the same GitHub account)
  if (typeof pullSync === 'function') pullSync();
  // Start periodic auto-pull so changes from other devices show up within ~30s
  if (typeof startSyncPolling === 'function') startSyncPolling();
}

function demoLogin() {
  migrateToSingleProfile();
  let main = getProfiles().find(p => p.id === MAIN_ID);
  if (!main) main = createProfile('You', null);
  activateProfile(MAIN_ID);
}

const GITHUB_CLIENT_ID = 'Ov23li20jlCBobnJjusT';
const GITHUB_CALLBACK = 'https://kemllmbackend.karimghannam2014.workers.dev/github/callback';

function githubLogin() {
  const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(GITHUB_CALLBACK)}&scope=read:user%20user:email`;
  window.location.href = url;
}

function handleGithubCallback() {
  const params = new URLSearchParams(window.location.search);
  const err = params.get('gh_error');
  if (err) {
    window.history.replaceState({}, document.title, window.location.pathname);
    showToast('GitHub sign-in failed: ' + err);
    return false;
  }
  const login = params.get('gh_user');
  if (!login) return false;
  const name = params.get('gh_name') || login;
  const avatar = params.get('gh_avatar') || '';
  const syncToken = params.get('sync_token') || '';
  window.history.replaceState({}, document.title, window.location.pathname);
  // Single-profile architecture: promote the existing main profile in
  // place. All previously-used data (chats, API keys, memories) stays
  // under `p_main_*` and is untouched — signing in just enables sync.
  migrateToSingleProfile();
  let main = getProfiles().find(p => p.id === MAIN_ID);
  if (!main) main = createProfile(name, login);
  const list = getProfiles();
  const idx = list.findIndex(p => p.id === MAIN_ID);
  if (idx >= 0) {
    list[idx].github = login;
    list[idx].name = name || list[idx].name;
    if (avatar) list[idx].avatar = avatar;
    if (syncToken) list[idx].sync_token = syncToken;
    saveProfiles(list);
  }
  activateProfile(MAIN_ID);
  showToast('Signed in as ' + login);
  return true;
}

// ===== Cloud sync via kemllmbackend Cloudflare worker =====
const SYNC_BASE = 'https://kemllmbackend.karimghannam2014.workers.dev/sync';
// Everything per-profile syncs across devices when signed in with GitHub.
// API keys included by user request — they live in the same KV blob, only
// readable with the user's per-account sync token (which never leaves the
// browser except as an Authorization-style URL param to our worker).
const SYNC_KEYS = [
  // Chat data
  'history',
  // User customization
  'persona',
  'custom_models',
  'mcp_connected',
  'theme',
  'accent',
  'skin',
  // Model defaults
  'temp',
  'max-tokens',
  'selected_chat',
  'selected_image',
  'selected_video',
  // API keys (sync enabled per user request)
  'rep-key',
  'key-anthropic',
  'key-openai',
  'key-google',
  'key-xai',
  // Agent backend
  'hf-backend-url',
  'hf-backend-token',
  // Memory (user-editable) and AI-written memory
  'memories',
  'ai-memory',
  // Sandbox toggle
  'sandbox-web',
  // Background music
  'music-on',
  'music-url',
  'music-vol',
];
const SYNC_POLL_INTERVAL_MS = 30 * 1000; // re-pull every 30s while open
let _syncPollTimer = null;

function getSyncProfile() {
  const p = getProfiles().find(x => x.id === activeProfileId);
  if (!p || !p.github || !p.sync_token) return null;
  return p;
}

// Track what we last pulled so we can detect actual changes and only re-render
// the UI when something is different (avoids re-rendering every 30s).
let _lastPulledHash = null;
function _hashSyncData(data) {
  try { return JSON.stringify(data); } catch { return ''; }
}

// Keys where an empty remote value must NOT overwrite a non-empty local value.
// Protects API keys from being wiped by an accidentally-blank push from
// another device (or from the first push before the user has filled them in).
const SENSITIVE_KEYS = [
  'rep-key',
  'key-anthropic',
  'key-openai',
  'key-google',
  'key-xai',
  'hf-backend-url',
  'hf-backend-token',
];

async function pullSync(opts) {
  const silent = opts && opts.silent;
  const p = getSyncProfile();
  if (!p) return;
  try {
    const r = await fetch(`${SYNC_BASE}?user=${encodeURIComponent(p.github)}&token=${encodeURIComponent(p.sync_token)}`);
    if (!r.ok) {
      if (!silent) console.warn('[KEMLLM] sync pull failed:', r.status);
      return;
    }
    const body = await r.json();
    if (!body.ok || !body.data) return;
    const newHash = _hashSyncData(body.data);
    if (newHash === _lastPulledHash) return; // nothing changed
    _lastPulledHash = newHash;
    // Merge each key into local profile storage WITHOUT re-triggering pushSync.
    // For SENSITIVE_KEYS (api keys), an empty remote value never overwrites
    // a non-empty local value — this protects against a blank sync blob
    // wiping out good keys.
    Object.keys(body.data).forEach(k => {
      if (!SYNC_KEYS.includes(k)) return;
      const remote = body.data[k];
      if (remote == null) return;
      if (SENSITIVE_KEYS.includes(k) && !remote) {
        const local = activeProfileId ? localStorage.getItem(`p_${activeProfileId}_${k}`) : null;
        if (local) return; // keep the good local value
      }
      if (activeProfileId) {
        localStorage.setItem(`p_${activeProfileId}_${k}`, remote);
      }
    });
    // Recovery: if the remote blob is missing a sensitive key but the local
    // value exists, re-push to heal the KV blob. This undoes any prior
    // accidental wipe.
    let needsHeal = false;
    for (const k of SENSITIVE_KEYS) {
      if (!body.data[k]) {
        const local = activeProfileId ? localStorage.getItem(`p_${activeProfileId}_${k}`) : null;
        if (local) { needsHeal = true; break; }
      }
    }
    if (needsHeal) {
      console.log('[KEMLLM] healing KV blob — pushing local keys up');
      pushSync();
    }
    if (!silent) showToast('Synced from cloud');
    // Re-render UI elements that read from these keys
    if (typeof loadHistory === 'function') loadHistory();
    if (typeof renderHistory === 'function') renderHistory();
    if (typeof renderCustomModels === 'function') renderCustomModels();
    if (typeof injectCustomModels === 'function') injectCustomModels();
    if (typeof loadAllSettings === 'function') loadAllSettings();
    if (typeof renderMemories === 'function') renderMemories();
    if (typeof renderAIMemory === 'function') renderAIMemory();
    const accent = profileGet('accent');
    if (accent && typeof applyAccent === 'function') applyAccent(accent);
    const skin = profileGet('skin');
    if (skin && typeof applySkin === 'function') applySkin(skin);
  } catch (e) {
    if (!silent) console.warn('[KEMLLM] sync pull error:', e);
  }
}

function startSyncPolling() {
  stopSyncPolling();
  _syncPollTimer = setInterval(() => {
    if (document.hidden) return; // skip when tab not focused
    pullSync({ silent: true });
  }, SYNC_POLL_INTERVAL_MS);
}
function stopSyncPolling() {
  if (_syncPollTimer) { clearInterval(_syncPollTimer); _syncPollTimer = null; }
}

let _pushTimer = null;
function pushSync() {
  const p = getSyncProfile();
  if (!p) return;
  // Debounce — collect rapid saves into one POST
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(async () => {
    const data = {};
    SYNC_KEYS.forEach(k => {
      const v = profileGet(k);
      if (v == null) return;
      // Never push empty strings for sensitive keys — an empty push
      // would clobber good values on other devices on the next pull.
      if (SENSITIVE_KEYS.includes(k) && !v) return;
      data[k] = v;
    });
    try {
      const r = await fetch(SYNC_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: p.github, token: p.sync_token, data }),
      });
      if (!r.ok) console.warn('[KEMLLM] sync push failed:', r.status);
    } catch (e) {
      console.warn('[KEMLLM] sync push error:', e);
    }
  }, 800);
}


function switchProfile() {
  closeUserModal();
  if (typeof stopSyncPolling === 'function') stopSyncPolling();
  activeProfileId = null;
  localStorage.removeItem('kemllm_active');
  document.getElementById('app').classList.remove('show');
  document.getElementById('login').classList.add('show');
}

function signOut() { switchProfile(); }

function checkExistingProfile() {
  migrateToSingleProfile();
  const list = getProfiles();
  // If there's a main profile and it has EITHER been used before OR been
  // linked to GitHub, auto-activate it — no login screen needed.
  const main = list.find(p => p.id === MAIN_ID);
  if (main && (localStorage.getItem('kemllm_active') === MAIN_ID || main.github)) {
    activateProfile(MAIN_ID);
    return true;
  }
  return false;
}
