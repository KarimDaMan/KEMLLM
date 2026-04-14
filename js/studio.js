// ========== KEMLLM Studio ==========
// A whole new page (not a chat mode) with:
//   - A social Feed of the user's published posts
//   - A Composer for generating new images/videos and publishing them
//   - A Characters/Cameos manager with reference-image persistence
//   - Saved posts view
// Entirely reuses the existing Replicate pipeline in js/api.js
// (generateImage / generateVideo / editImage). Storage is profile-scoped
// via state.js so everything syncs across devices for signed-in users.
'use strict';

// ===== Storage keys =====
const STUDIO_CHARS_KEY = 'studio_characters';
const STUDIO_POSTS_KEY = 'studio_posts';
const STUDIO_SAVED_KEY = 'studio_saved';
const STUDIO_LIKED_KEY = 'studio_liked';

// ===== In-memory composer state (reset on nav away) =====
let studioKind = 'image';        // 'image' | 'video'
let studioCast = [];             // array of character ids selected
let studioPreview = null;        // {type, url, prompt, aspectRatio}
let studioCharKind = 'character';// 'character' | 'cameo'
let studioCharImage = null;      // data URL currently staged
let studioActiveTab = 'feed';

// ===== Data helpers (all keys are profile-scoped via state.js) =====
function studioLoadChars()  { return profileGetJSON(STUDIO_CHARS_KEY, []); }
function studioSaveChars(v) { profileSetJSON(STUDIO_CHARS_KEY, v); }
function studioLoadPosts()  { return profileGetJSON(STUDIO_POSTS_KEY, []); }
function studioSavePosts(v) { profileSetJSON(STUDIO_POSTS_KEY, v); }
function studioLoadSaved()  { return profileGetJSON(STUDIO_SAVED_KEY, []); }
function studioSaveSaved(v) { profileSetJSON(STUDIO_SAVED_KEY, v); }
function studioLoadLiked()  { return profileGetJSON(STUDIO_LIKED_KEY, []); }
function studioSaveLiked(v) { profileSetJSON(STUDIO_LIKED_KEY, v); }

function studioAuthorName() {
  try {
    const p = getProfiles().find(x => x.id === activeProfileId);
    return (p && p.name) || 'You';
  } catch { return 'You'; }
}
function studioAuthorAvatar() {
  try {
    const p = getProfiles().find(x => x.id === activeProfileId);
    return p && p.avatar ? p.avatar : null;
  } catch { return null; }
}

function studioRelTime(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h';
  const d = Math.floor(hr / 24);
  if (d < 7) return d + 'd';
  return new Date(ts).toLocaleDateString();
}

// ===== Tabs =====
function studioSwitchTab(name) {
  studioActiveTab = name;
  document.querySelectorAll('.studio-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.studioTab === name);
  });
  document.querySelectorAll('.studio-view').forEach(el => {
    el.classList.toggle('active', el.id === 'studio-view-' + name);
  });
  if (name === 'feed') studioRenderFeed();
  else if (name === 'create') { studioRenderCastRow(); studioRenderPreview(); }
  else if (name === 'characters') studioRenderCharList();
  else if (name === 'saved') studioRenderSaved();
}

// ===== Characters =====
function studioRenderCharList() {
  const list = studioLoadChars();
  const el = document.getElementById('studio-char-list');
  if (!el) return;
  if (!list.length) {
    el.innerHTML = '<div class="studio-empty">No characters yet. Upload a reference image or generate one above, give it a name, and it will appear here.</div>';
    return;
  }
  el.innerHTML = list.map(c => `
    <div class="studio-char-card" data-studio-cid="${c.id}">
      <div class="studio-char-img" style="background-image:url('${escapeHTML(c.imageUrl)}')"></div>
      <div class="studio-char-body">
        <div class="studio-char-top">
          <div class="studio-char-name">${escapeHTML(c.name)}</div>
          <span class="studio-char-badge ${c.kind === 'cameo' ? 'cameo' : ''}">${c.kind === 'cameo' ? 'Cameo' : 'Character'}</span>
        </div>
        <div class="studio-char-desc">${escapeHTML(c.description || '')}</div>
        <div class="studio-char-actrow">
          <button class="studio-char-use" data-act="use">Cast</button>
          <button class="studio-char-del" data-act="del" title="Delete">Delete</button>
        </div>
      </div>
    </div>
  `).join('');
}

function studioDeleteChar(id) {
  const list = studioLoadChars().filter(c => c.id !== id);
  studioSaveChars(list);
  studioCast = studioCast.filter(x => x !== id);
  studioRenderCharList();
  studioRenderCastRow();
  showToast('Deleted');
}

function studioStageCharImage(dataUrl) {
  studioCharImage = dataUrl;
  const drop = document.getElementById('studio-char-drop');
  if (drop) {
    drop.style.backgroundImage = `url("${dataUrl}")`;
    drop.classList.add('has-image');
  }
  studioUpdateCharSaveState();
}

function studioUpdateCharSaveState() {
  const nameEl = document.getElementById('studio-char-name');
  const btn = document.getElementById('studio-char-save');
  if (!nameEl || !btn) return;
  btn.disabled = !(studioCharImage && nameEl.value.trim());
}

async function studioSaveCharFromForm() {
  const nameEl = document.getElementById('studio-char-name');
  const descEl = document.getElementById('studio-char-desc');
  const name = (nameEl?.value || '').trim();
  if (!name) { showToast('Name required'); return; }
  if (!studioCharImage) { showToast('Upload or generate an image first'); return; }
  const list = studioLoadChars();
  list.unshift({
    id: 's_c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: studioCharKind,
    name,
    description: (descEl?.value || '').trim(),
    imageUrl: studioCharImage,
    created: Date.now(),
  });
  studioSaveChars(list);
  // Reset form
  studioCharImage = null;
  if (nameEl) nameEl.value = '';
  if (descEl) descEl.value = '';
  const dropEl = document.getElementById('studio-char-drop');
  if (dropEl) { dropEl.style.backgroundImage = ''; dropEl.classList.remove('has-image'); }
  studioUpdateCharSaveState();
  studioRenderCharList();
  studioRenderCastRow();
  showToast((studioCharKind === 'cameo' ? 'Cameo' : 'Character') + ' saved');
}

async function studioGenerateCharImage() {
  const prEl = document.getElementById('studio-char-genprompt');
  const prompt = (prEl?.value || '').trim();
  if (!prompt) { showToast('Describe the character first'); return; }
  const btn = document.getElementById('studio-char-genbtn');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Generating...';
  try {
    // Portrait aspect ratio suits character references best.
    const url = await generateImage(prompt, '1:1');
    studioStageCharImage(url);
    // Pre-populate description if empty
    const descEl = document.getElementById('studio-char-desc');
    if (descEl && !descEl.value.trim()) descEl.value = prompt;
    showToast('Reference image ready');
  } catch (e) {
    showToast('Generation failed: ' + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ===== Cast row (in the composer) =====
function studioRenderCastRow() {
  const row = document.getElementById('studio-cast-row');
  if (!row) return;
  const chars = studioLoadChars();
  if (!chars.length) {
    row.innerHTML = '<div class="studio-cast-empty">No characters yet. <a href="#" data-studio-goto="characters">Create one</a> to cast them in your posts.</div>';
    return;
  }
  row.innerHTML = chars.map(c => `
    <button type="button" class="studio-cast-chip ${studioCast.includes(c.id) ? 'on' : ''}" data-studio-cid="${c.id}">
      <span class="studio-cast-ava" style="background-image:url('${escapeHTML(c.imageUrl)}')"></span>
      <span class="studio-cast-name">${escapeHTML(c.name)}</span>
      ${c.kind === 'cameo' ? '<span class="studio-cast-tag">cameo</span>' : ''}
    </button>
  `).join('');
}

function studioToggleCast(id) {
  const i = studioCast.indexOf(id);
  if (i >= 0) studioCast.splice(i, 1);
  else studioCast.push(id);
  studioRenderCastRow();
}

// ===== Composer: generate + publish =====
function studioBuildPromptWithCast(basePrompt) {
  if (!studioCast.length) return basePrompt;
  const chars = studioLoadChars();
  const picked = studioCast.map(id => chars.find(c => c.id === id)).filter(Boolean);
  if (!picked.length) return basePrompt;
  const roster = picked.map(c => {
    const tag = c.kind === 'cameo' ? 'CAMEO' : 'CHARACTER';
    return `${tag} "${c.name}"${c.description ? ' - ' + c.description : ''}`;
  }).join('. ');
  return basePrompt + '\n\nFeaturing: ' + roster + '.\nKeep every featured character visually consistent with their reference image.';
}

async function studioGenerate() {
  const prEl = document.getElementById('studio-prompt');
  const arEl = document.getElementById('studio-aspect');
  const prompt = (prEl?.value || '').trim();
  const aspectRatio = arEl?.value || '16:9';
  if (!prompt) { showToast('Write a prompt first'); return; }
  const btn = document.getElementById('studio-generate-btn');
  const pub = document.getElementById('studio-publish-btn');
  const status = document.getElementById('studio-gen-status');
  btn.disabled = true;
  if (pub) pub.disabled = true;
  if (status) status.textContent = studioKind === 'video' ? 'Rendering video... (this can take a minute)' : 'Generating image...';
  const preview = document.getElementById('studio-preview');
  if (preview) preview.innerHTML = '<div class="studio-preview-loading"><div class="studio-spinner"></div></div>';

  const finalPrompt = studioBuildPromptWithCast(prompt);
  // If a cameo/character is cast, use its reference image for edit-based
  // composition (keeps the face consistent). Otherwise pure text-to-image.
  let refUrl = null;
  if (studioCast.length) {
    const chars = studioLoadChars();
    const first = chars.find(c => c.id === studioCast[0]);
    if (first && first.imageUrl) refUrl = first.imageUrl;
  }

  try {
    let url;
    if (studioKind === 'image') {
      if (refUrl) {
        try {
          url = await editImage(finalPrompt, refUrl, aspectRatio);
        } catch (e) {
          // Edit path can fail if the model doesn't accept images.
          // Fall back to text-to-image generation.
          console.warn('[studio] edit failed, falling back to text-to-image', e);
          url = await generateImage(finalPrompt, aspectRatio);
        }
      } else {
        url = await generateImage(finalPrompt, aspectRatio);
      }
    } else {
      // Video: pass the ref image through extras for models that accept it.
      const extras = refUrl ? { image: refUrl, first_frame_image: refUrl, image_reference: refUrl } : {};
      url = await generateVideo(finalPrompt, aspectRatio, extras);
    }
    studioPreview = { type: studioKind, url, prompt, aspectRatio, cast: studioCast.slice() };
    studioRenderPreview();
    if (status) status.textContent = 'Ready. Tap Publish to share it.';
    if (pub) pub.disabled = false;
  } catch (e) {
    if (status) status.textContent = 'Failed: ' + (e.message || e);
    showToast('Generation failed: ' + (e.message || e));
    if (preview) preview.innerHTML = '';
  } finally {
    btn.disabled = false;
  }
}

function studioRenderPreview() {
  const el = document.getElementById('studio-preview');
  if (!el) return;
  if (!studioPreview) { el.innerHTML = ''; return; }
  if (studioPreview.type === 'image') {
    el.innerHTML = `<img src="${escapeHTML(studioPreview.url)}" alt="preview">`;
  } else {
    el.innerHTML = `<video src="${escapeHTML(studioPreview.url)}" controls autoplay muted loop playsinline></video>`;
  }
}

function studioPublish() {
  if (!studioPreview) { showToast('Generate something first'); return; }
  const captionEl = document.getElementById('studio-caption');
  const caption = (captionEl?.value || '').trim();
  const posts = studioLoadPosts();
  const post = {
    id: 's_p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    author: studioAuthorName(),
    avatar: studioAuthorAvatar(),
    type: studioPreview.type,
    url: studioPreview.url,
    prompt: studioPreview.prompt,
    aspectRatio: studioPreview.aspectRatio,
    cast: studioPreview.cast || [],
    caption,
    likes: 0,
    comments: [],
    created: Date.now(),
  };
  posts.unshift(post);
  studioSavePosts(posts);
  // Reset composer
  studioPreview = null;
  studioCast = [];
  if (captionEl) captionEl.value = '';
  const prEl = document.getElementById('studio-prompt');
  if (prEl) prEl.value = '';
  const pub = document.getElementById('studio-publish-btn');
  if (pub) pub.disabled = true;
  const status = document.getElementById('studio-gen-status');
  if (status) status.textContent = '';
  studioRenderPreview();
  studioRenderCastRow();
  showToast('Published to feed');
  studioSwitchTab('feed');
}

// ===== Feed rendering =====
function studioFormatCast(castIds) {
  if (!castIds || !castIds.length) return '';
  const chars = studioLoadChars();
  const names = castIds.map(id => chars.find(c => c.id === id)).filter(Boolean).map(c => c.name);
  if (!names.length) return '';
  return `<div class="studio-post-cast">Featuring: ${escapeHTML(names.join(', '))}</div>`;
}

function studioRenderPostCard(post, liked, saved) {
  const media = post.type === 'image'
    ? `<img src="${escapeHTML(post.url)}" alt="post" onclick="studioOpenMedia('${post.id}')">`
    : `<video src="${escapeHTML(post.url)}" controls playsinline onclick="event.stopPropagation();"></video>`;
  const ava = post.avatar
    ? `<span class="studio-post-ava" style="background-image:url('${escapeHTML(post.avatar)}')"></span>`
    : `<span class="studio-post-ava">${escapeHTML((post.author || '?')[0].toUpperCase())}</span>`;
  return `
    <div class="studio-post" data-studio-pid="${post.id}">
      <div class="studio-post-head">
        ${ava}
        <div class="studio-post-who">
          <div class="studio-post-author">${escapeHTML(post.author || 'You')}</div>
          <div class="studio-post-time">${studioRelTime(post.created)} - ${post.type}</div>
        </div>
        <button class="studio-post-del" data-act="delete" title="Delete post">&times;</button>
      </div>
      <div class="studio-post-media">${media}</div>
      <div class="studio-post-actions">
        <button class="studio-post-act ${liked ? 'on' : ''}" data-act="like" title="Like">
          <svg viewBox="0 0 24 24" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          <span>${post.likes || 0}</span>
        </button>
        <button class="studio-post-act" data-act="comment" title="Comment">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span>${(post.comments || []).length}</span>
        </button>
        <button class="studio-post-act" data-act="share" title="Share">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        </button>
        <button class="studio-post-act ${saved ? 'on' : ''}" data-act="save" title="${saved ? 'Unsave' : 'Save'}">
          <svg viewBox="0 0 24 24" fill="${saved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="studio-post-act" data-act="download" title="Download">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
      </div>
      <div class="studio-post-body">
        ${post.caption ? `<div class="studio-post-caption">${escapeHTML(post.caption)}</div>` : ''}
        <div class="studio-post-prompt"><span class="studio-post-promptlbl">prompt</span> ${escapeHTML(post.prompt || '')}</div>
        ${studioFormatCast(post.cast)}
      </div>
      <div class="studio-post-comments">
        ${(post.comments || []).map(c => `
          <div class="studio-comment">
            <span class="studio-comment-who">${escapeHTML(c.author || 'you')}</span>
            <span class="studio-comment-text">${escapeHTML(c.text)}</span>
            <span class="studio-comment-time">${studioRelTime(c.ts)}</span>
          </div>
        `).join('')}
        <form class="studio-comment-form" data-studio-pid="${post.id}">
          <input class="studio-comment-input" placeholder="Add a comment..." autocomplete="off">
          <button type="submit" class="studio-comment-send">Post</button>
        </form>
      </div>
    </div>
  `;
}

function studioRenderFeed() {
  const el = document.getElementById('studio-feed');
  if (!el) return;
  const posts = studioLoadPosts();
  const liked = studioLoadLiked();
  const saved = studioLoadSaved();
  if (!posts.length) {
    el.innerHTML = `<div class="studio-empty studio-empty-lg">
      <div class="studio-empty-title">Your feed is empty</div>
      <div class="studio-empty-sub">Head to <a href="#" data-studio-goto="create">Create</a> to make your first post - an image or a short video featuring your characters and cameos.</div>
    </div>`;
    return;
  }
  el.innerHTML = posts.map(p => studioRenderPostCard(p, liked.includes(p.id), saved.includes(p.id))).join('');
}

function studioRenderSaved() {
  const el = document.getElementById('studio-saved-feed');
  if (!el) return;
  const posts = studioLoadPosts();
  const saved = studioLoadSaved();
  const liked = studioLoadLiked();
  const list = posts.filter(p => saved.includes(p.id));
  if (!list.length) {
    el.innerHTML = '<div class="studio-empty studio-empty-lg"><div class="studio-empty-title">No saved posts</div><div class="studio-empty-sub">Tap the bookmark on any post to save it here.</div></div>';
    return;
  }
  el.innerHTML = list.map(p => studioRenderPostCard(p, liked.includes(p.id), true)).join('');
}

// ===== Post actions (dispatched from click delegation) =====
function studioToggleLike(pid) {
  const posts = studioLoadPosts();
  const p = posts.find(x => x.id === pid);
  if (!p) return;
  const liked = studioLoadLiked();
  const i = liked.indexOf(pid);
  if (i >= 0) { liked.splice(i, 1); p.likes = Math.max(0, (p.likes || 1) - 1); }
  else { liked.push(pid); p.likes = (p.likes || 0) + 1; }
  studioSaveLiked(liked);
  studioSavePosts(posts);
  if (studioActiveTab === 'feed') studioRenderFeed();
  else if (studioActiveTab === 'saved') studioRenderSaved();
}

function studioToggleSave(pid) {
  const saved = studioLoadSaved();
  const i = saved.indexOf(pid);
  if (i >= 0) { saved.splice(i, 1); showToast('Removed from saved'); }
  else { saved.push(pid); showToast('Saved'); }
  studioSaveSaved(saved);
  if (studioActiveTab === 'feed') studioRenderFeed();
  else if (studioActiveTab === 'saved') studioRenderSaved();
}

async function studioSharePost(pid) {
  const posts = studioLoadPosts();
  const p = posts.find(x => x.id === pid);
  if (!p) return;
  const shareUrl = p.url;
  const text = (p.caption || p.prompt || 'Made with KEMLLM Studio');
  try {
    if (navigator.share) {
      await navigator.share({ title: 'KEMLLM Studio', text, url: shareUrl });
      return;
    }
  } catch {}
  try {
    await navigator.clipboard.writeText(shareUrl);
    showToast('Link copied to clipboard');
  } catch {
    showToast('Copy failed: ' + shareUrl);
  }
}

async function studioDownloadPost(pid) {
  const posts = studioLoadPosts();
  const p = posts.find(x => x.id === pid);
  if (!p) return;
  if (typeof downloadMediaUrl === 'function') {
    downloadMediaUrl(p.url, p.type);
  } else {
    window.open(p.url, '_blank');
  }
}

function studioDeletePost(pid) {
  if (!confirm('Delete this post?')) return;
  const posts = studioLoadPosts().filter(p => p.id !== pid);
  studioSavePosts(posts);
  studioSaveSaved(studioLoadSaved().filter(x => x !== pid));
  studioSaveLiked(studioLoadLiked().filter(x => x !== pid));
  if (studioActiveTab === 'feed') studioRenderFeed();
  else if (studioActiveTab === 'saved') studioRenderSaved();
  showToast('Post deleted');
}

function studioAddComment(pid, text) {
  const t = (text || '').trim();
  if (!t) return;
  const posts = studioLoadPosts();
  const p = posts.find(x => x.id === pid);
  if (!p) return;
  p.comments = p.comments || [];
  p.comments.push({
    id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    author: studioAuthorName(),
    text: t,
    ts: Date.now(),
  });
  studioSavePosts(posts);
  if (studioActiveTab === 'feed') studioRenderFeed();
  else if (studioActiveTab === 'saved') studioRenderSaved();
}

function studioOpenMedia(pid) {
  const posts = studioLoadPosts();
  const p = posts.find(x => x.id === pid);
  if (!p) return;
  if (p.type === 'image' && typeof openImageViewer === 'function') {
    openImageViewer(p.url);
  } else {
    window.open(p.url, '_blank');
  }
}
window.studioOpenMedia = studioOpenMedia;

// ===== Wiring =====
function studioInitOnce() {
  if (window._studioInited) return;
  window._studioInited = true;

  // Tab switching
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.studio-tab');
    if (tab && tab.dataset.studioTab) {
      studioSwitchTab(tab.dataset.studioTab);
    }
    // "Create your first post" link + similar inline links
    const goto = e.target.closest('[data-studio-goto]');
    if (goto) {
      e.preventDefault();
      studioSwitchTab(goto.dataset.studioGoto);
    }
  });

  // Create shortcut button in the header
  document.getElementById('studio-compose-btn')?.addEventListener('click', () => {
    studioSwitchTab('create');
  });

  // Composer: image/video toggle
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-studio-kind]');
    if (!btn) return;
    studioKind = btn.dataset.studioKind;
    document.querySelectorAll('[data-studio-kind]').forEach(el => {
      el.classList.toggle('active', el.dataset.studioKind === studioKind);
    });
  });

  // Composer: generate + publish
  document.getElementById('studio-generate-btn')?.addEventListener('click', studioGenerate);
  document.getElementById('studio-publish-btn')?.addEventListener('click', studioPublish);

  // Cast chip clicks
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.studio-cast-chip');
    if (chip && chip.dataset.studioCid) studioToggleCast(chip.dataset.studioCid);
  });

  // Characters tab — character/cameo toggle
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-studio-charkind]');
    if (!btn) return;
    studioCharKind = btn.dataset.studioCharkind;
    document.querySelectorAll('[data-studio-charkind]').forEach(el => {
      el.classList.toggle('active', el.dataset.studioCharkind === studioCharKind);
    });
  });

  // Upload reference image
  const drop = document.getElementById('studio-char-drop');
  const fileInput = document.getElementById('studio-char-file');
  if (drop && fileInput) {
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('dragging');
      const f = e.dataTransfer.files?.[0];
      if (f && f.type.startsWith('image/')) studioReadFileAsDataURL(f).then(studioStageCharImage);
    });
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) studioReadFileAsDataURL(f).then(studioStageCharImage);
      e.target.value = '';
    });
  }
  document.getElementById('studio-char-name')?.addEventListener('input', studioUpdateCharSaveState);
  document.getElementById('studio-char-save')?.addEventListener('click', studioSaveCharFromForm);
  document.getElementById('studio-char-genbtn')?.addEventListener('click', studioGenerateCharImage);

  // Character card actions (use / delete)
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.studio-char-card');
    if (!card) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    const id = card.dataset.studioCid;
    if (act === 'use') { studioToggleCast(id); studioSwitchTab('create'); }
    else if (act === 'del') { studioDeleteChar(id); }
  });

  // Post actions (like/comment/share/save/download/delete)
  document.addEventListener('click', (e) => {
    const post = e.target.closest('.studio-post');
    if (!post) return;
    const actEl = e.target.closest('[data-act]');
    if (!actEl) return;
    const pid = post.dataset.studioPid;
    const act = actEl.dataset.act;
    if (act === 'like') studioToggleLike(pid);
    else if (act === 'save') studioToggleSave(pid);
    else if (act === 'share') studioSharePost(pid);
    else if (act === 'download') studioDownloadPost(pid);
    else if (act === 'delete') studioDeletePost(pid);
    else if (act === 'comment') {
      const input = post.querySelector('.studio-comment-input');
      if (input) input.focus();
    }
  });

  // Comment form submit (delegation)
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('.studio-comment-form');
    if (!f) return;
    e.preventDefault();
    const input = f.querySelector('.studio-comment-input');
    const pid = f.dataset.studioPid;
    studioAddComment(pid, input.value);
    input.value = '';
  });
}

function studioReadFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ===== Public: called by siNav when the studio panel becomes active =====
function studioOnPanelShow() {
  studioInitOnce();
  studioSwitchTab(studioActiveTab || 'feed');
}
window.studioOnPanelShow = studioOnPanelShow;

// Also auto-init as soon as DOM is ready so tab-panel state is correct
// even before the user navigates to studio for the first time.
document.addEventListener('DOMContentLoaded', () => {
  studioInitOnce();
});
