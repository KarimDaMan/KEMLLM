// ========== KEMLLM API Layer ==========
'use strict';

function getKey(provider) {
  return profileGet('key-' + provider) || '';
}
function getRepKey() { return profileGet('rep-key') || ''; }

// Replicate is proxied through the Cloudflare worker to avoid CORS issues.
// The worker forwards any /replicate/* path to api.replicate.com/*
const REPLICATE_BASE = 'https://kemllmx.karimghannam2014.workers.dev/replicate';
async function replicateFetch(path, init) {
  const url = REPLICATE_BASE + path;
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error(
      'Network error reaching Replicate proxy at ' + url +
      '. Check your internet, disable any ad-blocker/VPN, and hard-refresh the page. Original: ' +
      (e.message || e)
    );
  }
}

function loadAllSettings() {
  ['anthropic', 'openai', 'google', 'xai'].forEach(p => {
    const v = profileGet('key-' + p) || '';
    const el = document.getElementById('key-' + p);
    if (el) el.value = v;
  });
  // Agent backend
  const hfu = document.getElementById('hf-backend-url');
  if (hfu) hfu.value = profileGet('hf-backend-url') || '';
  const hft = document.getElementById('hf-backend-token');
  if (hft) hft.value = profileGet('hf-backend-token') || '';
  const rk = document.getElementById('rep-key');
  if (rk) rk.value = getRepKey();
  const temp = profileGet('temp') || '0.7';
  const tempEl = document.getElementById('sp-temp');
  if (tempEl) tempEl.value = temp;
  // max-tokens defaults to EMPTY (= let the API decide the cap).
  // Users can set a value via Settings → Advanced if they want to
  // manually limit response length or reduce cost per call.
  const mt = profileGet('max-tokens') || '';
  const mtEl = document.getElementById('sp-max-tokens');
  if (mtEl) mtEl.value = mt;
  const persona = profileGet('persona') || '';
  const pEl = document.getElementById('sp-persona');
  if (pEl) pEl.value = persona;
  // Restore the user's previously-selected models so the topbar/dropdowns
  // remember their pick across sessions and devices.
  const savedChat = profileGet('selected_chat');
  if (savedChat && typeof selectedChat !== 'undefined') selectedChat = savedChat;
  const savedImage = profileGet('selected_image');
  if (savedImage && typeof selectedImage !== 'undefined') selectedImage = savedImage;
  const savedVideo = profileGet('selected_video');
  if (savedVideo && typeof selectedVideo !== 'undefined') selectedVideo = savedVideo;
  if (typeof renderModelDropdowns === 'function') renderModelDropdowns();
}
function saveKey(provider) {
  const el = document.getElementById('key-' + provider);
  if (!el) return;
  const newVal = el.value.trim();
  const existing = profileGet('key-' + provider) || '';
  // Don't silently wipe a saved key with an empty input. The user
  // has to explicitly confirm they want to clear it.
  if (!newVal && existing) {
    if (!confirm('Clear the saved ' + provider + ' API key?')) {
      el.value = existing;
      return;
    }
  }
  profileSet('key-' + provider, newVal);
  showToast('Saved');
  if (typeof renderModelDropdowns === 'function') renderModelDropdowns();
  if (typeof renderModelsPanel === 'function') renderModelsPanel();
}
function saveRepKey() {
  const el = document.getElementById('rep-key');
  if (!el) return;
  const newVal = el.value.trim();
  const existing = profileGet('rep-key') || '';
  if (!newVal && existing) {
    if (!confirm('Clear the saved Replicate API key?')) {
      el.value = existing;
      return;
    }
  }
  profileSet('rep-key', newVal);
  showToast('Saved');
  if (typeof renderModelDropdowns === 'function') renderModelDropdowns();
  if (typeof renderModelsPanel === 'function') renderModelsPanel();
}

// ===== Provider routing =====
// Replicate is the PRIMARY backend for every model. Direct provider keys
// (Anthropic / OpenAI / Google / xAI) are OPTIONAL overrides — they get
// tried only if Replicate fails or has no route for the model.
// EXCEPTION: messages with image attachments MUST go through a direct
// provider API because Replicate's chat proxies flatten input to text
// and drop the images. In that case we flip the priority: provider first,
// Replicate only if the provider has no key.
// Optional `overrideSystem` param replaces the default system prompt (used by Agent Mode).
async function callChat(model, messages, onChunk, overrideSystem) {
  const provider = model.provider;
  const sysAddon = overrideSystem != null ? overrideSystem : getSystemPrompt(model);
  const fullMsgs = sysAddon ? [{ role: 'system', content: sysAddon }, ...messages] : messages;
  const hasVisionAttachments = messages.some(m =>
    m.attachments && m.attachments.some(a => a.isImage !== false && (a.isImage || (a.mime || '').startsWith('image/')))
  );

  const tryProvider = async () => {
    if (provider === 'anthropic') {
      const k = getKey('anthropic');
      if (!k) throw new Error('NO_PROVIDER_KEY');
      return callAnthropicDirect(model, fullMsgs, k, onChunk);
    }
    if (provider === 'openai') {
      const k = getKey('openai');
      if (!k) throw new Error('NO_PROVIDER_KEY');
      return callOpenAIStyle('https://api.openai.com/v1/chat/completions', model.apiId, fullMsgs, k, onChunk);
    }
    if (provider === 'google') {
      const k = getKey('google');
      if (!k) throw new Error('NO_PROVIDER_KEY');
      return callGoogleDirect(model, fullMsgs, k, onChunk);
    }
    if (provider === 'xai') {
      const k = getKey('xai');
      if (!k) throw new Error('NO_PROVIDER_KEY');
      return callOpenAIStyle('https://api.x.ai/v1/chat/completions', model.apiId, fullMsgs, k, onChunk);
    }
    throw new Error('NO_PROVIDER_KEY');
  };

  const tryReplicate = async () => {
    const rk = getRepKey();
    if (!rk) throw new Error('NO_REPLICATE_KEY');
    if (!model.replicateId) throw new Error('NO_REPLICATE_ID');
    return callReplicateChat(model, fullMsgs, rk, onChunk);
  };

  // ROUTING — direct provider API FIRST, Replicate only as a fallback.
  //
  // Rationale (from user): 'if the API key is there, use it; if there's
  // no API key, use Replicate'. This:
  //   - Ensures charges go to the direct provider when the user has
  //     that relationship (cheaper per-token, no Replicate middleman markup).
  //   - Avoids Replicate's weird version/schema issues for models that
  //     Anthropic/OpenAI/Google/xAI host natively.
  //   - Gives the user predictable billing — whichever key they pasted
  //     is the one that gets charged.
  //
  // Flow:
  //   1. Does the user have a direct provider key for this model's provider?
  //      → YES: use the direct API. On any error, surface that error.
  //      → NO:  try Replicate.
  //   2. Replicate only runs if no direct key, or if direct not available
  //      for this provider (e.g. meta/mistral/deepseek — no direct API).

  const hasDirectKey =
    (provider === 'anthropic' && !!getKey('anthropic')) ||
    (provider === 'openai'    && !!getKey('openai'))    ||
    (provider === 'google'    && !!getKey('google'))    ||
    (provider === 'xai'       && !!getKey('xai'));

  if (hasDirectKey && model.apiId) {
    // Direct API has priority. If it fails, surface the REAL error.
    return tryProvider();
  }

  // No direct key (or no apiId for this model) → Replicate path.
  if (!model.replicateId) {
    const provName = { anthropic:'Anthropic', openai:'OpenAI', google:'Google AI', xai:'xAI' }[provider] || provider;
    throw new Error(
      model.name + ' has no Replicate path. Add a ' + provName + ' API key in Settings → API Keys, ' +
      'or pick a different model that is on Replicate.'
    );
  }
  if (!getRepKey()) {
    throw new Error(
      'Using ' + model.name + ' needs either a Replicate key OR a direct ' + provider + ' API key. ' +
      'Add one in Settings → API Keys.'
    );
  }
  try {
    return await tryReplicate();
  } catch (repErr) {
    // Replicate actually threw — the message is the real error, not a sentinel
    throw repErr;
  }
}

function getSystemPrompt(model) {
  const persona = (profileGet('persona') || '').trim();
  const name = model?.name || 'an AI assistant';
  let s = `You are ${name}, accessed through KEMLLM — a universal AI workspace. When asked what model you are, honestly say "${name}".`;
  s += ' Be direct, precise, and genuinely helpful. Do not be overly enthusiastic, do not use filler like "Great question!" or "Certainly!", and never end responses with a bullet-point summary unless explicitly asked. Match the length of your answer to what the question actually needs — short for short, detailed for detailed.';
  s += ' You can execute code inside the browser. Python runs in a WebAssembly interpreter (Pyodide); JavaScript/TypeScript runs in a sandboxed iframe; other languages run in a remote sandbox. When code would help answer the question, write a fenced code block (```python, ```javascript, etc.) and it will be executed automatically and the output shown to you. Use this for math, algorithms, data processing, and anything that benefits from running real code. Do NOT speculate about unavailable libraries — just call the standard library.';
  s += ' For mathematical expressions and equations, use LaTeX: $...$ for inline math (e.g. $x^2 + y^2 = r^2$) and $$...$$ for display math (e.g. $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$). The frontend renders these with KaTeX. Use proper LaTeX commands like \\frac, \\sqrt, \\sum, \\int, \\alpha, \\beta, etc. Never write equations as plain text or ASCII when LaTeX would look better.';
  if (window.webSearchOn) {
    s += ' The user has enabled web search context. Note your training cutoff if asked about recent events.';
  }
  if (persona) {
    s += '\n\nUser-defined persona/instructions:\n' + persona;
  }
  return s;
}

// Helper: convert a data URL to { mediaType, base64 }
function parseDataUrl(dataUrl) {
  const m = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!m) return null;
  return { mediaType: m[1], base64: m[2] };
}

// Returns a parsed max_tokens value ONLY if the user has explicitly set
// one via Settings → Advanced. Empty or non-positive means "use the
// provider's default max" which is what most users want — each API
// caps response length on its own. Returning null signals the caller
// to omit the field from the request body entirely.
function getUserMaxTokens() {
  const raw = profileGet('max-tokens');
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (!isFinite(n) || n <= 0) return null;
  // Cap at 200k so the user can't accidentally send a quadrillion
  // (which will always be rejected by the provider anyway).
  return Math.min(n, 200000);
}

// ===== Anthropic =====
async function callAnthropicDirect(model, messages, apiKey, onChunk) {
  const sys = messages.find(m => m.role === 'system')?.content || '';
  const msgs = messages.filter(m => m.role !== 'system').map(m => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    // Only pass image attachments to Claude — it doesn't accept arbitrary
    // file types. Non-image files are ignored here (the AI can still
    // reference them by name via the text prompt).
    const images = (m.attachments || []).filter(a => a.isImage || (a.mime || '').startsWith('image/'));
    if (images.length) {
      const parts = images.map(a => {
        const d = parseDataUrl(a.dataUrl);
        if (!d) return null;
        return { type: 'image', source: { type: 'base64', media_type: d.mediaType, data: d.base64 } };
      }).filter(Boolean);
      if (m.content) parts.push({ type: 'text', text: m.content });
      return { role, content: parts };
    }
    return { role, content: m.content };
  });
  // Anthropic's API REQUIRES max_tokens — we must send something even
  // if the user hasn't set one. Default to the model's reasonable cap
  // when unset. For Opus/Sonnet that's 8192, which is the API default
  // output limit anyway.
  const anthropicMax = getUserMaxTokens() || 8192;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: model.apiId,
      max_tokens: anthropicMax,
      system: sys,
      messages: msgs
    })
  });
  if (!res.ok) throw new Error('Anthropic API error: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  onChunk(text, true);
  return text;
}

async function callAnthropicBuiltin(model, messages, onChunk) {
  // Try built-in (works on claude.ai). Otherwise raise.
  try {
    return await callAnthropicDirect(model, messages, '', onChunk);
  } catch (e) {
    throw new Error('Add your Anthropic API key in Settings to use Claude models directly.');
  }
}

// ===== OpenAI / xAI (compatible) =====
async function callOpenAIStyle(url, modelId, messages, apiKey, onChunk) {
  const oaiMsgs = messages.map(m => {
    const images = (m.attachments || []).filter(a => a.isImage || (a.mime || '').startsWith('image/'));
    if (images.length) {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      images.forEach(a => parts.push({ type: 'image_url', image_url: { url: a.dataUrl } }));
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });
  // Only include max_tokens if the user set one in Settings → Advanced.
  // Otherwise let OpenAI/xAI pick the model's native cap.
  const body = {
    model: modelId,
    messages: oaiMsgs,
    temperature: parseFloat(profileGet('temp') || '0.7'),
  };
  const userMax = getUserMaxTokens();
  if (userMax != null) body.max_tokens = userMax;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('API error: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  onChunk(text, true);
  return text;
}

// ===== Google Gemini =====
async function callGoogleDirect(model, messages, apiKey, onChunk) {
  const sys = messages.find(m => m.role === 'system')?.content || '';
  const contents = messages.filter(m => m.role !== 'system').map(m => {
    const parts = [];
    if (m.content) parts.push({ text: m.content });
    // Gemini supports images, audio, video, PDF inline. Pass images
    // explicitly (most common case); for other types, try inlineData
    // with the real mime so Gemini decides whether to accept it.
    (m.attachments || []).forEach(a => {
      const d = parseDataUrl(a.dataUrl);
      if (!d) return;
      // Skip non-media attachments (e.g. code files) to avoid Gemini rejecting the whole request
      const isMedia = (a.mime || '').startsWith('image/') ||
                      (a.mime || '').startsWith('audio/') ||
                      (a.mime || '').startsWith('video/') ||
                      (a.mime || '') === 'application/pdf';
      if (!isMedia) return;
      parts.push({ inlineData: { mimeType: d.mediaType, data: d.base64 } });
    });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.apiId}:generateContent?key=${apiKey}`;
  const genCfg = { temperature: parseFloat(profileGet('temp') || '0.7') };
  const gUserMax = getUserMaxTokens();
  if (gUserMax != null) genCfg.maxOutputTokens = gUserMax;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
      generationConfig: genCfg,
    })
  });
  if (!res.ok) throw new Error('Google API error: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  onChunk(text, true);
  return text;
}

// ===== Replicate (chat fallback + image/video) — goes through worker proxy =====

// Cache: modelId → latest version SHA. Avoids re-fetching the version
// list on every call to the same model.
const _replicateVersionCache = {};

// Three-tier fallback for Replicate's prediction API. In order:
//   1. POST /v1/models/<owner>/<name>/predictions   (official models)
//   2. POST /v1/predictions  { model, input }       (newer community models)
//   3. GET  /v1/models/<owner>/<name>/versions      → grab latest version
//      POST /v1/predictions  { version, input }    (legacy community models)
// Almost every chat/image/video model on Replicate falls into one of
// these three buckets. Eliminates the "correct slug but 422" failure
// where the universal endpoint says "version is required, model not allowed".
async function replicatePredict(modelId, input, apiKey, knownVersion) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + apiKey,
    'Prefer': 'wait',
  };

  // 0. If caller provided a specific version SHA, use it directly via /v1/predictions
  if (knownVersion) {
    return replicateFetch('/v1/predictions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: knownVersion, input }),
    });
  }

  // 1. Official-models endpoint
  let res = await replicateFetch(`/v1/models/${modelId}/predictions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input }),
  });
  if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 422)) {
    return res;
  }

  // 2. Universal /v1/predictions with `model` field
  res = await replicateFetch('/v1/predictions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: modelId, input }),
  });
  if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 422)) {
    return res;
  }

  // 3. Legacy version-pinned: fetch the latest version SHA from two
  //    possible sources and post with `version`. Needed for community
  //    models (first source) AND for anthropic official-style models
  //    that still require a version field (second source).
  let version = _replicateVersionCache[modelId];
  if (!version) {
    // 3a. /v1/models/<id>/versions — works for community models
    try {
      const vRes = await replicateFetch(`/v1/models/${modelId}/versions`, {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + apiKey },
      });
      if (vRes.ok) {
        const vData = await vRes.json();
        version = vData?.results?.[0]?.id;
      }
    } catch {}
    // 3b. /v1/models/<id> → latest_version.id — works for official
    //     and anthropic-style models that return an empty versions list
    if (!version) {
      try {
        const mRes = await replicateFetch(`/v1/models/${modelId}`, {
          method: 'GET',
          headers: { 'Authorization': 'Bearer ' + apiKey },
        });
        if (mRes.ok) {
          const mData = await mRes.json();
          version = mData?.latest_version?.id;
        }
      } catch {}
    }
    if (version) _replicateVersionCache[modelId] = version;
  }
  if (version) {
    res = await replicateFetch('/v1/predictions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ version, input }),
    });
  }
  return res;
}

async function callReplicateChat(model, messages, apiKey, onChunk) {
  const prompt = messages.map(m => {
    const content = typeof m.content === 'string' ? m.content : '';
    return `${m.role.toUpperCase()}: ${content}`;
  }).join('\n\n') + '\n\nASSISTANT:';

  // Collect image attachments from any message — some Replicate chat
  // model proxies accept an `image` or `image_input` field for vision.
  // Send the first image under multiple likely keys so whichever schema
  // the model uses, it picks it up.
  const firstImage = messages
    .flatMap(m => m.attachments || [])
    .find(a => a && (a.isImage || (a.mime || '').startsWith('image/')));

  const input = { prompt };
  const repUserMax = getUserMaxTokens();
  if (repUserMax != null) input.max_tokens = repUserMax;
  if (firstImage && firstImage.dataUrl) {
    input.image = firstImage.dataUrl;
    input.image_input = firstImage.dataUrl;
    input.input_image = firstImage.dataUrl;
  }

  const res = await replicatePredict(model.replicateId, input, apiKey, model.version);
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 404) {
      throw new Error(
        `Replicate 404 — model "${model.replicateId}" not found at either /v1/models/<id>/predictions or /v1/predictions. ` +
        `Check the model slug. Or add a direct ${model.provider} API key in Settings.`
      );
    }
    throw new Error('Replicate ' + res.status + ' on ' + model.replicateId + ': ' + t.slice(0, 200));
  }
  const data = await res.json();
  let out = data.output;
  if (Array.isArray(out)) out = out.join('');
  out = out || '';
  onChunk(out, true);
  return out;
}

// Known-working fallback image models on Replicate.
// If the user-selected model 404s, we try these in order so the user
// still gets an image instead of a cryptic error.
const IMAGE_FALLBACK_IDS = [
  'black-forest-labs/flux-schnell',
  'black-forest-labs/flux-1.1-pro',
  'stability-ai/stable-diffusion-3-medium',
  'ideogram-ai/ideogram-v3-turbo',
];

// Image-editing fallback chain — only used if the user's currently-selected
// image model fails or can't do img2img.
const IMAGE_EDIT_FALLBACK_IDS = [
  'black-forest-labs/flux-kontext-pro',
  'black-forest-labs/flux-kontext-dev',
  'google/nano-banana',
  'black-forest-labs/flux-dev',
];

// Upload a data URL (base64) to Replicate's file storage and return the
// https URL that can be passed as input to any model. Some models reject
// raw base64 data URLs but accept https URLs. This is the officially
// documented way to pass user-uploaded images to Replicate models.
async function replicateUploadFile(dataUrl, apiKey) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const form = new FormData();
  form.append('content', blob, 'upload.' + (blob.type.split('/')[1] || 'png'));
  const upRes = await replicateFetch('/v1/files', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    body: form,
  });
  if (!upRes.ok) {
    const t = await upRes.text();
    throw new Error('Replicate file upload failed: ' + upRes.status + ' ' + t.slice(0, 200));
  }
  const data = await upRes.json();
  // Replicate returns { urls: { get: 'https://...' }, ... }
  return data?.urls?.get || data?.url;
}

async function editImage(prompt, sourceUrl) {
  const apiKey = getRepKey();
  if (!apiKey) throw new Error('Add your Replicate key in Settings to edit images');
  if (!sourceUrl) throw new Error('No input image');

  // Convert data URLs to https URLs via Replicate file upload. Plain
  // http/https URLs (e.g. a previously-generated image) pass through unchanged.
  let imageUrl = sourceUrl;
  if (sourceUrl.startsWith('data:')) {
    if (typeof showToast === 'function') showToast('Uploading image to Replicate…');
    imageUrl = await replicateUploadFile(sourceUrl, apiKey);
    if (!imageUrl) throw new Error('Replicate upload returned no URL');
  }

  // Try the user's CURRENTLY-SELECTED image model first. If it fails or
  // doesn't accept img2img, walk the fallback list.
  const selected = findModel(selectedImage, 'image');
  const idsToTry = [];
  if (selected?.replicateId) idsToTry.push(selected.replicateId);
  for (const id of IMAGE_EDIT_FALLBACK_IDS) {
    if (id !== selected?.replicateId) idsToTry.push(id);
  }

  let lastErr = null;
  for (const id of idsToTry) {
    try {
      // Different models use different input keys — flux-kontext wants
      // `input_image`, most img2img uses `image`, nano-banana uses `image_input`.
      // Send all three; the model picks the one it recognizes.
      const input = {
        prompt,
        image: imageUrl,
        input_image: imageUrl,
        image_input: imageUrl,
      };
      const res = await replicatePredict(id, input, apiKey, selected?.version);
      if (res.status === 404) {
        lastErr = new Error('Model "' + id + '" not found on Replicate');
        continue;
      }
      if (!res.ok) {
        const t = await res.text();
        lastErr = new Error('Edit ' + res.status + ' on ' + id + ': ' + t.slice(0, 200));
        if (res.status === 422) continue;
        throw lastErr;
      }
      const data = await res.json();
      let out = data.output;
      if (Array.isArray(out)) out = out[0];
      if (!out) { lastErr = new Error('Model "' + id + '" returned no output'); continue; }
      if (id !== selected?.replicateId && typeof showToast === 'function') {
        showToast('Edited with fallback ' + id);
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (!String(e.message || '').match(/not found|422/)) throw e;
    }
  }
  throw lastErr || new Error('All image-edit models failed');
}

async function generateImage(prompt) {
  const apiKey = getRepKey();
  if (!apiKey) throw new Error('Add your Replicate key in Settings to generate images');
  const m = findModel(selectedImage, 'image');
  if (!m) throw new Error('No image model selected');

  const idsToTry = [m.replicateId, ...IMAGE_FALLBACK_IDS.filter(id => id !== m.replicateId)];
  let lastErr = null;
  for (const id of idsToTry) {
    try {
      const res = await replicatePredict(id, { prompt }, apiKey);
      if (res.status === 404) {
        lastErr = new Error('Model "' + id + '" not found on Replicate');
        continue;
      }
      if (!res.ok) {
        const t = await res.text();
        throw new Error('Image gen ' + res.status + ': ' + t.slice(0, 200));
      }
      const data = await res.json();
      let out = data.output;
      if (Array.isArray(out)) out = out[0];
      if (id !== m.replicateId) showToast('Used fallback: ' + id);
      return out;
    } catch (e) {
      lastErr = e;
      if (!String(e.message).includes('not found')) throw e;
    }
  }
  throw lastErr || new Error('All image models failed');
}

async function generateVideo(prompt) {
  const apiKey = getRepKey();
  if (!apiKey) throw new Error('Add your Replicate key in Settings to generate videos');
  const m = findModel(selectedVideo, 'video');
  if (!m) throw new Error('No video model selected');
  let res = await replicateFetch(`/v1/models/${m.replicateId}/predictions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({ input: { prompt } })
  });
  if (!res.ok) throw new Error('Video gen ' + res.status + ': ' + (await res.text()).slice(0, 200));
  let data = await res.json();
  for (let i = 0; i < 80; i++) {
    if (data.status === 'succeeded') {
      let out = data.output;
      if (Array.isArray(out)) out = out[0];
      return out;
    }
    if (data.status === 'failed' || data.status === 'canceled') throw new Error('Video generation failed');
    await new Promise(r => setTimeout(r, 3000));
    // Pass the direct URL through the worker proxy too when possible
    const getUrl = data.urls.get.replace('https://api.replicate.com', '');
    res = await replicateFetch(getUrl, { headers: { 'Authorization': 'Bearer ' + apiKey } });
    data = await res.json();
  }
  throw new Error('Video timed out');
}
