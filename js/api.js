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
async function callChat(model, messages, onChunk) {
  const provider = model.provider;
  const sysAddon = getSystemPrompt();
  const fullMsgs = sysAddon ? [{ role: 'system', content: sysAddon }, ...messages] : messages;

  // Provider-specific keys take priority
  if (provider === 'anthropic') {
    const k = getKey('anthropic');
    if (k) return callAnthropicDirect(model, fullMsgs, k, onChunk);
    // Built-in fallback
    return callAnthropicBuiltin(model, fullMsgs, onChunk);
  }
  if (provider === 'openai') {
    const k = getKey('openai');
    if (k) return callOpenAIStyle('https://api.openai.com/v1/chat/completions', model.apiId, fullMsgs, k, onChunk);
  }
  if (provider === 'google') {
    const k = getKey('google');
    if (k) return callGoogleDirect(model, fullMsgs, k, onChunk);
  }
  if (provider === 'xai') {
    const k = getKey('xai');
    if (k) return callOpenAIStyle('https://api.x.ai/v1/chat/completions', model.apiId, fullMsgs, k, onChunk);
  }

  // Replicate fallback
  const rk = getRepKey();
  if (rk && model.replicateId) {
    return callReplicateChat(model, fullMsgs, rk, onChunk);
  }

  throw new Error(`Add your ${provider === 'anthropic' ? 'Anthropic' : provider === 'openai' ? 'OpenAI' : provider === 'google' ? 'Google AI' : provider === 'xai' ? 'xAI' : 'Replicate'} key in Settings to use ${model.name}.`);
}

function getSystemPrompt() {
  let s = 'You are KEMLLM, a helpful AI assistant. Be concise and clear.';
  s += ' You have the ability to execute code. When it would help answer a question, write a code block in a supported language and it will be automatically run. You will see the output and can use it in your response. Always use this for math, algorithms, data processing, and anything that benefits from running actual code.';
  if (window.webSearchOn) {
    s += ' You have access to current information. If asked about recent events, note what you know up to your training cutoff.';
  }
  return s;
}

// ===== Anthropic =====
async function callAnthropicDirect(model, messages, apiKey, onChunk) {
  const sys = messages.find(m => m.role === 'system')?.content || '';
  const msgs = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));
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
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: modelId,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
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
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
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
