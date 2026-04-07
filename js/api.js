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
  const mt = profileGet('max-tokens') || '4096';
  const mtEl = document.getElementById('sp-max-tokens');
  if (mtEl) mtEl.value = mt;
  const persona = profileGet('persona') || '';
  const pEl = document.getElementById('sp-persona');
  if (pEl) pEl.value = persona;
}
function saveKey(provider) {
  const el = document.getElementById('key-' + provider);
  if (el) {
    profileSet('key-' + provider, el.value.trim());
    showToast('Saved');
  }
}
function saveRepKey() {
  const el = document.getElementById('rep-key');
  if (el) {
    profileSet('rep-key', el.value.trim());
    showToast('Saved');
  }
}

// ===== Provider routing =====
// Replicate is the PRIMARY backend for every model. Direct provider keys
// (Anthropic / OpenAI / Google / xAI) are OPTIONAL overrides — they get
// tried only if Replicate fails or has no route for the model.
// Optional `overrideSystem` param replaces the default system prompt (used by Agent Mode).
async function callChat(model, messages, onChunk, overrideSystem) {
  const provider = model.provider;
  const sysAddon = overrideSystem != null ? overrideSystem : getSystemPrompt(model);
  const fullMsgs = sysAddon ? [{ role: 'system', content: sysAddon }, ...messages] : messages;

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

  // PRIMARY: Replicate
  try {
    return await tryReplicate();
  } catch (repErr) {
    // Fall back to direct provider key if configured
    try {
      return await tryProvider();
    } catch (provErr) {
      // Neither worked — give a clear message
      const rk = getRepKey();
      if (!rk && provErr.message === 'NO_PROVIDER_KEY') {
        throw new Error('Add your Replicate key in Settings → API Keys to use ' + model.name + '. Get one at https://replicate.com/account/api-tokens');
      }
      if (repErr.message === 'NO_REPLICATE_ID' && provErr.message === 'NO_PROVIDER_KEY') {
        const provName = { anthropic:'Anthropic', openai:'OpenAI', google:'Google AI', xai:'xAI' }[provider] || provider;
        throw new Error(model.name + ' has no Replicate path. Add a ' + provName + ' API key in Settings.');
      }
      // Replicate was the primary attempt — surface its error
      throw repErr;
    }
  }
}

function getSystemPrompt(model) {
  const persona = (profileGet('persona') || '').trim();
  const name = model?.name || 'an AI assistant';
  let s = `You are ${name}, accessed through KEMLLM — a universal AI workspace. When asked what model you are, honestly say "${name}".`;
  s += ' Be direct, precise, and genuinely helpful. Do not be overly enthusiastic, do not use filler like "Great question!" or "Certainly!", and never end responses with a bullet-point summary unless explicitly asked. Match the length of your answer to what the question actually needs — short for short, detailed for detailed.';
  s += ' You can execute code inside the browser. Python runs in a WebAssembly interpreter (Pyodide); JavaScript/TypeScript runs in a sandboxed iframe; other languages run in a remote sandbox. When code would help answer the question, write a fenced code block (```python, ```javascript, etc.) and it will be executed automatically and the output shown to you. Use this for math, algorithms, data processing, and anything that benefits from running real code. Do NOT speculate about unavailable libraries — just call the standard library.';
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

// ===== Anthropic =====
async function callAnthropicDirect(model, messages, apiKey, onChunk) {
  const sys = messages.find(m => m.role === 'system')?.content || '';
  const msgs = messages.filter(m => m.role !== 'system').map(m => {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (m.attachments && m.attachments.length) {
      const parts = m.attachments.map(a => {
        const d = parseDataUrl(a.dataUrl);
        if (!d) return null;
        return { type: 'image', source: { type: 'base64', media_type: d.mediaType, data: d.base64 } };
      }).filter(Boolean);
      if (m.content) parts.push({ type: 'text', text: m.content });
      return { role, content: parts };
    }
    return { role, content: m.content };
  });
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
      max_tokens: parseInt(profileGet('max-tokens') || '4096'),
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
    if (m.attachments && m.attachments.length) {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      m.attachments.forEach(a => parts.push({ type: 'image_url', image_url: { url: a.dataUrl } }));
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: modelId,
      messages: oaiMsgs,
      temperature: parseFloat(profileGet('temp') || '0.7'),
      max_tokens: parseInt(profileGet('max-tokens') || '4096')
    })
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
    if (m.attachments && m.attachments.length) {
      m.attachments.forEach(a => {
        const d = parseDataUrl(a.dataUrl);
        if (d) parts.push({ inlineData: { mimeType: d.mediaType, data: d.base64 } });
      });
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.apiId}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
      generationConfig: {
        temperature: parseFloat(profileGet('temp') || '0.7'),
        maxOutputTokens: parseInt(profileGet('max-tokens') || '4096')
      }
    })
  });
  if (!res.ok) throw new Error('Google API error: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  onChunk(text, true);
  return text;
}

// ===== Replicate (chat fallback + image/video) — goes through worker proxy =====
async function callReplicateChat(model, messages, apiKey, onChunk) {
  const prompt = messages.map(m => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : ''}`).join('\n\n') + '\n\nASSISTANT:';
  const res = await replicateFetch(`/v1/models/${model.replicateId}/predictions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'Prefer': 'wait'
    },
    body: JSON.stringify({ input: { prompt, max_tokens: parseInt(profileGet('max-tokens') || '4096') } })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Replicate ' + res.status + ': ' + t.slice(0, 200));
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

async function generateImage(prompt) {
  const apiKey = getRepKey();
  if (!apiKey) throw new Error('Add your Replicate key in Settings to generate images');
  const m = findModel(selectedImage, 'image');
  if (!m) throw new Error('No image model selected');

  const idsToTry = [m.replicateId, ...IMAGE_FALLBACK_IDS.filter(id => id !== m.replicateId)];
  let lastErr = null;
  for (const id of idsToTry) {
    try {
      const res = await replicateFetch(`/v1/models/${id}/predictions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'Prefer': 'wait'
        },
        body: JSON.stringify({ input: { prompt } })
      });
      if (res.status === 404) {
        lastErr = new Error('Model "' + id + '" not found on Replicate');
        continue; // try next fallback
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
