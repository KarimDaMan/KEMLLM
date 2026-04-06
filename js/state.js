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
}
function profileGetJSON(k, fallback) {
  try { const v = profileGet(k); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function profileSetJSON(k, v) { profileSet(k, JSON.stringify(v)); }

function getProfiles() {
  try { return JSON.parse(localStorage.getItem(KEY_PROFILES) || '[]'); }
  catch { return []; }
}
function saveProfiles(p) { localStorage.setItem(KEY_PROFILES, JSON.stringify(p)); }

function createProfile(name, github) {
  const id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const colors = ['#4a9eff', '#a78bfa', '#f472b6', '#4ade80', '#fb923c', '#f87171'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const p = { id, name, github: github || null, color, created: Date.now() };
  const list = getProfiles();
  list.push(p);
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

  // Avatar
  const ava = document.getElementById('si-ava');
  if (ava) {
    ava.style.background = p.color;
    ava.textContent = p.name[0].toUpperCase();
  }
  const avaName = document.getElementById('si-ava-name');
  if (avaName) avaName.textContent = p.name;
  const umAva = document.getElementById('um-ava');
  if (umAva) {
    umAva.style.background = p.color;
    umAva.textContent = p.name[0].toUpperCase();
  }
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
}

function demoLogin() {
  let demo = getProfiles().find(p => p.name === 'Demo User');
  if (!demo) demo = createProfile('Demo User', null);
  activateProfile(demo.id);
}

const GITHUB_CLIENT_ID = 'Ov23li20jlCBobnJjusT';
const GITHUB_REDIRECT = 'https://kemllmx.karimghannam2014.workers.dev/';
const GITHUB_EXCHANGE = 'https://kemllmx.karimghannam2014.workers.dev/api/github-exchange';

function githubLogin() {
  const state = 'kemllm_' + Math.random().toString(36).slice(2, 12);
  localStorage.setItem('gh_oauth_state', state);
  const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(GITHUB_REDIRECT)}&scope=read:user%20user:email&state=${state}`;
  window.location.href = url;
}

async function handleGithubCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code) return false;
  const savedState = localStorage.getItem('gh_oauth_state');
  if (state && savedState && state !== savedState) {
    showToast('OAuth state mismatch');
    return false;
  }
  localStorage.removeItem('gh_oauth_state');
  window.history.replaceState({}, document.title, window.location.pathname);
  try {
    const res = await fetch(GITHUB_EXCHANGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (!res.ok) throw new Error('Exchange failed: ' + res.status);
    const data = await res.json();
    // Expected: { login, name, email, avatar_url, access_token }
    let ghProfile = getProfiles().find(p => p.github === data.login);
    if (!ghProfile) {
      ghProfile = createProfile(data.name || data.login || 'GitHub User', data.login);
    }
    if (data.access_token) {
      localStorage.setItem(`p_${ghProfile.id}_gh_token`, data.access_token);
    }
    activateProfile(ghProfile.id);
    showToast('Signed in as ' + (data.login || 'GitHub user'));
    return true;
  } catch (e) {
    showToast('GitHub sign-in failed: ' + e.message);
    return false;
  }
}

function switchProfile() {
  closeUserModal();
  activeProfileId = null;
  localStorage.removeItem('kemllm_active');
  document.getElementById('app').classList.remove('show');
  document.getElementById('login').classList.add('show');
}

function signOut() { switchProfile(); }

function checkExistingProfile() {
  const id = localStorage.getItem('kemllm_active');
  if (id && getProfiles().find(p => p.id === id)) {
    activateProfile(id);
    return true;
  }
  return false;
}
