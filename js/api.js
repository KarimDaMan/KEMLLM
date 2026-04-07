// ========== KEMLLM API Layer ==========
'use strict';

function getKey(provider) {
  return profileGet('key-' + provider) || '';
}
function getRepKey() { return profileGet('rep-key') || ''; }

function loadAllSettings() {
  ['anthropic', 'openai', 'google', 'xai'].forEach(p => {
    const v = profileGet('key-' + p) || '';
    const el = document.getElementById('key-' + p);
    if (el) el.value = v;
  });
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
// Priority: user's own provider key > Replicate fallback (if rep key present).
// On any error, if Replicate is available and a different path was used, retry via Replicate.
async function callChat(model, messages, onChunk) {
  const provider = model.provider;
  const sysAddon = getSystemPrompt(model);
  const fullMsgs = sysAddon ? [{ role: 'system', content: sysAddon }, ...messages] : messages;

  const tryProvider = async () => {
    if (provider === 'anthropic') {
      const k = getKey('anthropic');
      if (k) return callAnthropicDirect(model, fullMsgs, k, onChunk);
      throw new Error('NO_PROVIDER_KEY');
    }
    if (provider === 'openai') {
      const k = getKey('openai');
      if (k) return callOpenAIStyle('https://api.openai.com/v1/chat/completions', model.apiId, fullMsgs, k, onChunk);
      throw new Error('NO_PROVIDER_KEY');
    }
    if (provider === 'google') {
      const k = getKey('google');
      if (k) return callGoogleDirect(model, fullMsgs, k, onChunk);
      throw new Error('NO_PROVIDER_KEY');
    }
    if (provider === 'xai') {
      const k = getKey('xai');
      if (k) return callOpenAIStyle('https://api.x.ai/v1/chat/completions', model.apiId, fullMsgs, k, onChunk);
      throw new Error('NO_PROVIDER_KEY');
    }
    throw new Error('NO_PROVIDER_KEY');
  };

  const tryReplicate = async () => {
    const rk = getRepKey();
    if (!rk) throw new Error('Add your Replicate key in Settings to use ' + model.name + '.');
    if (!model.replicateId) throw new Error(model.name + ' has no Replicate mapping. Add a direct provider key in Settings.');
    return callReplicateChat(model, fullMsgs, rk, onChunk);
  };

  // Default path: Replicate first (unless user has their own provider key)
  const hasProviderKey =
    (provider === 'anthropic' && getKey('anthropic')) ||
    (provider === 'openai' && getKey('openai')) ||
    (provider === 'google' && getKey('google')) ||
    (provider === 'xai' && getKey('xai'));

  if (hasProviderKey) {
    try { return await tryProvider(); }
    catch (e) {
      // Fall back to Replicate on provider error
      if (getRepKey() && model.replicateId) {
        try { return await tryReplicate(); }
        catch (e2) { throw e2; }
      }
      throw e;
    }
  }
  // No provider key → Replicate only
  return tryReplicate();
}

function getSystemPrompt(model) {
  const persona = (profileGet('persona') || '').trim();
  const name = model?.name || 'an AI assistant';
  let s = `You are ${name}, accessed through KEMLLM — a universal AI workspace. When asked what model you are, honestly say "${name}".`;
  s += ' Be direct, precise, and genuinely helpful. Do not be overly enthusiastic, do not use filler like "Great question!" or "Certainly!", and never end responses with a bullet-point summary unless explicitly asked. Match the length of your answer to what the question actually needs — short for short, detailed for detailed.';
  s += ' You can execute code: when it helps, write a fenced code block in python, javascript, c, c++, rust, go, java, bash, or similar, and it will be automatically run. Use this for math, algorithms, data processing, and any task that benefits from running real code.';
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

// ===== Replicate (chat fallback + image/video) =====
async function callReplicateChat(model, messages, apiKey, onChunk) {
  const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n') + '\n\nASSISTANT:';
  const res = await fetch(`https://api.replicate.com/v1/models/${model.replicateId}/predictions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'Prefer': 'wait'
    },
    body: JSON.stringify({ input: { prompt, max_tokens: parseInt(profileGet('max-tokens') || '4096') } })
  });
  if (!res.ok) throw new Error('Replicate error: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  let out = data.output;
  if (Array.isArray(out)) out = out.join('');
  out = out || '';
  onChunk(out, true);
  return out;
}

async function generateImage(prompt) {
  const apiKey = getRepKey();
  if (!apiKey) throw new Error('Add your Replicate key in Settings to generate images');
  const m = findModel(selectedImage, 'image');
  if (!m) throw new Error('No image model selected');
  const res = await fetch(`https://api.replicate.com/v1/models/${m.replicateId}/predictions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'Prefer': 'wait'
    },
    body: JSON.stringify({ input: { prompt } })
  });
  if (!res.ok) throw new Error('Image gen error: ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  let out = data.output;
  if (Array.isArray(out)) out = out[0];
  return out;
}

async function generateVideo(prompt) {
  const apiKey = getRepKey();
  if (!apiKey) throw new Error('Add your Replicate key in Settings to generate videos');
  const m = findModel(selectedVideo, 'video');
  if (!m) throw new Error('No video model selected');
  let res = await fetch(`https://api.replicate.com/v1/models/${m.replicateId}/predictions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({ input: { prompt } })
  });
  if (!res.ok) throw new Error('Video gen error: ' + (await res.text()).slice(0, 200));
  let data = await res.json();
  // Poll
  for (let i = 0; i < 80; i++) {
    if (data.status === 'succeeded') {
      let out = data.output;
      if (Array.isArray(out)) out = out[0];
      return out;
    }
    if (data.status === 'failed' || data.status === 'canceled') throw new Error('Video generation failed');
    await new Promise(r => setTimeout(r, 3000));
    res = await fetch(data.urls.get, { headers: { 'Authorization': 'Bearer ' + apiKey } });
    data = await res.json();
  }
  throw new Error('Video timed out');
}
