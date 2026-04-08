// ========== KEMLLM API Layer ==========
'use strict';

function getKey(provider) {
  return profileGet('key-' + provider) || '';
}
function getRepKey() { return profileGet('rep-key') || ''; }

// Ring buffer of recent outgoing API requests for Settings → Debug.
// Not persisted — in-memory only, lost on reload.
const DEBUG_LOG = [];
const DEBUG_LOG_MAX = 50;
function logDebugRequest(entry) {
  DEBUG_LOG.unshift(entry);
  if (DEBUG_LOG.length > DEBUG_LOG_MAX) DEBUG_LOG.length = DEBUG_LOG_MAX;
  // Re-render the debug panel if it's currently open
  if (typeof renderDebugLog === 'function') renderDebugLog();
}
// Monkey-patch window.fetch to capture every request made by the page.
// Stores: ts, method, host+path, status, ms, ok.
(function installFetchLogger() {
  if (typeof window === 'undefined' || window.__kemllm_fetch_patched) return;
  window.__kemllm_fetch_patched = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const method = (init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET';
    // Coerce url to a safe string — input can be a string, a URL object,
    // a Request, or something exotic. Default to '(unknown)' so the
    // debug log renderer never hits `undefined.length`.
    let url;
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.href;
    else if (input && typeof input.url === 'string') url = input.url;
    else if (input && typeof input.toString === 'function') url = String(input);
    else url = '(unknown)';
    const t0 = Date.now();
    try {
      const res = await origFetch(input, init);
      logDebugRequest({
        ts: t0, method, url, status: res.status, ms: Date.now() - t0, ok: res.ok,
      });
      return res;
    } catch (e) {
      logDebugRequest({
        ts: t0, method, url, status: 0, ms: Date.now() - t0, ok: false,
        error: String(e && e.message || e),
      });
      throw e;
    }
  };
})();

// All worker traffic (OAuth, sync, Replicate proxy) goes through the single
// kemllmbackend worker. The source in cloudflare-worker/kemllmbackend.js
// has the /replicate/* proxy block — if Replicate calls return the worker's
// health JSON instead of predictions, the deployed worker is stale and
// needs to be re-pasted into the Cloudflare dashboard.
const REPLICATE_BASE = 'https://kemllmbackend.karimghannam2014.workers.dev/replicate';
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

// System prompt = terse tool manifest. No personality, no "be helpful"
// boilerplate, no "you are a software engineer" framing. Just: you're a
// generative AI, here are your tools, here's how to invoke each one.
function getSystemPrompt(model) {
  const name = model?.name || 'an AI assistant';
  const lines = [];
  lines.push(`You are ${name}, a generative AI. You have the following tools:`);
  lines.push('');
  lines.push('- CODE EXECUTION. When a question needs computation, data processing, API calls, file operations, math you can\'t do in your head, or anything verifiable — WRITE A FENCED CODE BLOCK (```python, ```javascript, ```bash, ```c, ```rust, ```go, etc). It runs automatically in a sandbox and the output comes back to you as the next turn. Use this whenever it helps, not just when the user explicitly says "write code". Python runs in Pyodide (browser); JavaScript in a sandboxed iframe; bash/c/cpp/rust/go/java/lua run in a remote Linux sandbox. Do NOT ask permission to run code — just write the block. After execution, explain the result in plain prose.');
  lines.push('- IMAGE GENERATION. Emit `[GENERATE_IMAGE prompt="..."]`. Write a rich visual description (subject, composition, lighting, style, colors). The image is generated and shown inline.');
  lines.push('- VIDEO GENERATION. Emit `[GENERATE_VIDEO prompt="..."]`.');
  lines.push('- IMAGE EDITING. If the user has ATTACHED an image to their message and asks you to modify, change, recolor, restyle, remove, add, replace, or transform something in it — emit `[EDIT_IMAGE prompt="rewritten detailed instruction for the image editor"]`. Do this even for short requests like "make it blue" or "remove the background" — rewrite the prompt to be descriptive. This also works on images you previously generated in the same conversation. Do NOT describe the edit in words and refuse to do it — emit the marker. You can still discuss the image in prose too, but ALWAYS emit the marker when an edit is requested.');
  lines.push('- MATH. Use LaTeX inside `$...$` for inline and `$$...$$` for display. Rendered with KaTeX.');
  lines.push('- PERSISTENT MEMORY. When the user tells you something useful about themselves (name, preferences, projects, skills, goals, context, opinions, style, anything worth recalling later), emit `[REMEMBER fact="short declarative sentence"]`. One marker per fact. Emit as many markers as appropriate per reply — do not hold back. The user cannot see these markers in your reply (they are stripped).');
  // Computer Use — only when Claude 3.5+ is the model, HF backend is
  // configured, and user is in Agent mode. We can't easily detect the
  // last one at prompt-build time, so always mention it; the tool is
  // only injected into the API request when conditions are met.
  if (typeof chatMode !== 'undefined' && chatMode === 'agent' &&
      typeof getHfBackendUrl === 'function' && getHfBackendUrl()) {
    lines.push('- DESKTOP CONTROL (computer use tool). You have a `computer` tool that can screenshot, click, type, press keys, and drag on a real Linux desktop running in a remote sandbox (1920×1080). When the user asks you to do something visual — open an app, fill a form, navigate a webpage, click a button — USE THE TOOL. ALWAYS start with `{action: "screenshot"}` to see the current state before doing anything else. Describe what you see, then act. After each action, take another screenshot to verify. Think step-by-step about coordinates. Do NOT ask permission to use the tool — just use it.');
  }

  // Sandbox web access — a real constraint the AI needs to know about.
  if (profileGet('sandbox-web') !== '1') {
    lines.push('- NETWORK: OFF. Code execution has no internet access. Do not attempt HTTP requests in code.');
  } else {
    lines.push('- NETWORK: ON. Code execution can reach the internet.');
  }
  // HF Persistent Storage note. Files under ~/Documents, ~/Downloads,
  // ~/Desktop, ~/Pictures, ~/Videos, ~/Music, ~/Projects, the Firefox
  // profile, Thunderbird data and LibreOffice config are symlinked to
  // /data on the HF Space when Persistent Storage is enabled. Tell the
  // AI so it saves things in the right place.
  lines.push('- PERSISTENT FILES (Agent mode). If the user has HF Persistent Storage enabled on their Space, these directories survive restarts: ~/Documents, ~/Downloads, ~/Desktop, ~/Pictures, ~/Videos, ~/Music, ~/Projects, plus Firefox/Thunderbird profiles. Save user files there. Everything else (/tmp, ~/.cache, system dirs) is wiped on restart. If the user asks "does this save?" and the space has storage enabled, yes. If not, tell them to enable it in Space → Settings → Persistent Storage.');

  // Optional user persona.
  const persona = (profileGet('persona') || '').trim();
  if (persona) {
    lines.push('');
    lines.push('User instructions:');
    lines.push(persona);
  }

  // Persistent memories — user-added in Settings → Memory.
  try {
    const mems = JSON.parse(profileGet('memories') || '[]');
    if (Array.isArray(mems) && mems.length) {
      lines.push('');
      lines.push('Remembered facts (set by the user):');
      mems.forEach((m) => { lines.push('- ' + m); });
    }
  } catch {}

  // AI-written memory — things the AI itself chose to remember via
  // [REMEMBER fact="..."] markers. User can view but not edit these.
  try {
    const aiMems = JSON.parse(profileGet('ai-memory') || '[]');
    if (Array.isArray(aiMems) && aiMems.length) {
      lines.push('');
      lines.push('What you know about the user (from past conversations):');
      aiMems.forEach((m) => { lines.push('- ' + m); });
    }
  } catch {}

  return lines.join('\n');
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
// Helper: decide whether to wire Claude's Computer Use tool into the API
// call. We only enable it when (a) the model is Sonnet 3.5+ / Opus 4+
// (earlier Claudes aren't trained for it), (b) the HF Agent backend is
// configured and reachable, and (c) the user is in Agent mode. The
// display dimensions MUST match what the XFCE Xvfb is running at —
// the current Dockerfile.desktop uses 1600×900.
function shouldEnableComputerUse(model) {
  if (typeof chatMode === 'undefined' || chatMode !== 'agent') return false;
  if (typeof getHfBackendUrl !== 'function' || !getHfBackendUrl()) return false;
  const id = (model?.apiId || '').toLowerCase();
  // claude-3-5-sonnet-20241022+, claude-sonnet-4, claude-opus-4, claude-4-*
  if (/claude-(3-5|3\.5)-sonnet/.test(id)) return true;
  if (/claude-(sonnet|opus|haiku)-4/.test(id)) return true;
  if (/claude-4/.test(id)) return true;
  return false;
}

// Convert one of our messages[] entries into Claude's content-block form.
function anthropicMessageFrom(m) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
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
}

// Execute a Claude computer_use tool call via the HF agent backend.
// Returns the base64 screenshot that becomes the tool_result content.
async function runComputerAction(input) {
  const base = getHfBackendUrl();
  const tok = getHfBackendToken();
  if (!base) throw new Error('HF backend URL not configured');
  // Flask endpoint under /api/desktop/action thanks to the nginx front-door.
  const r = await fetch(`${base}/api/desktop/action?token=${encodeURIComponent(tok)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`desktop action failed: ${r.status} ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  if (!j.ok) throw new Error('desktop action error: ' + (j.error || 'unknown'));
  return { data: j.data, media_type: j.media_type || 'image/png', text: j.text };
}

async function callAnthropicDirect(model, messages, apiKey, onChunk) {
  const sys = messages.find(m => m.role === 'system')?.content || '';
  const msgs = messages.filter(m => m.role !== 'system').map(anthropicMessageFrom);
  const anthropicMax = getUserMaxTokens() || 8192;

  const useComputer = shouldEnableComputerUse(model);
  const tools = useComputer ? [{
    type: 'computer_20241022',
    name: 'computer',
    // Must match the Xvfb :0 resolution in start-desktop.sh (1920x1080 since v88)
    display_width_px: 1920,
    display_height_px: 1080,
    display_number: 0,
  }] : undefined;

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (useComputer) {
    headers['anthropic-beta'] = 'computer-use-2024-10-22';
  }

  // If computer-use is NOT enabled, do the simple single-shot call.
  if (!useComputer) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model.apiId,
        max_tokens: anthropicMax,
        system: sys,
        messages: msgs,
      }),
    });
    if (!res.ok) throw new Error('Anthropic API error: ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    onChunk(text, true);
    return text;
  }

  // Computer-use loop. Each iteration: call the API, handle any tool_use
  // blocks by running them on the HF backend, feed the screenshot(s) back
  // as a user-role tool_result message, and loop until stop_reason !=
  // 'tool_use'. Caps at 20 iterations as a safety net.
  let convo = msgs.slice();
  let finalText = '';
  for (let iter = 0; iter < 20; iter++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model.apiId,
        max_tokens: anthropicMax,
        system: sys,
        tools,
        messages: convo,
      }),
    });
    if (!res.ok) throw new Error('Anthropic API error: ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const data = await res.json();
    const content = data.content || [];

    // Append the assistant turn to the convo unchanged.
    convo.push({ role: 'assistant', content });

    // Stream text content to the caller.
    const textPieces = content.filter(b => b.type === 'text').map(b => b.text);
    const iterText = textPieces.join('');
    if (iterText) {
      finalText += (finalText ? '\n\n' : '') + iterText;
      onChunk(iterText, false);
    }

    if (data.stop_reason !== 'tool_use') {
      onChunk('', true);
      return finalText;
    }

    // Collect all tool_use blocks, run each one, assemble tool_result list.
    const toolUses = content.filter(b => b.type === 'tool_use');
    const results = [];
    for (const tu of toolUses) {
      try {
        const out = await runComputerAction(tu.input || {});
        const resultContent = [];
        if (out.data) {
          resultContent.push({
            type: 'image',
            source: { type: 'base64', media_type: out.media_type || 'image/png', data: out.data },
          });
        }
        if (out.text) {
          resultContent.push({ type: 'text', text: out.text });
        }
        if (!resultContent.length) {
          resultContent.push({ type: 'text', text: '(action completed)' });
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: resultContent });
      } catch (e) {
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: [{ type: 'text', text: 'ERROR: ' + (e.message || String(e)) }],
          is_error: true,
        });
      }
    }
    convo.push({ role: 'user', content: results });
  }
  onChunk('', true);
  return finalText;
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

// The ONLY image-edit fallback. If the user's selected image model can't
// do editing (404 / 422 / no output), we fall back to this and nothing
// else. Per user requirement: "use what's selected, if no editing then
// Nano Banana Pro".
const NANO_BANANA_PRO_ID = 'google/nano-banana-pro';

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

// Per-model input builders. Different Replicate image models require
// different field names/types for the source image. Generic fallback at
// the end uses the union of common keys — works for most off-brand models.
function buildImageEditInput(modelId, prompt, imageUrl) {
  const id = (modelId || '').toLowerCase();

  // Google Nano Banana — takes `image_input` as an ARRAY of URLs
  if (id.includes('nano-banana')) {
    return { prompt, image_input: [imageUrl] };
  }
  // FLUX Kontext — takes `input_image` as a SINGLE URL
  if (id.includes('flux-kontext')) {
    return { prompt, input_image: imageUrl };
  }
  // FLUX Fill — takes `image` + `mask`
  if (id.includes('flux-fill')) {
    return { prompt, image: imageUrl };
  }
  // Generic FLUX Dev / Schnell img2img
  if (id.includes('black-forest-labs/flux')) {
    return { prompt, image: imageUrl };
  }
  // Ideogram V3 Edit variants
  if (id.includes('ideogram') && id.includes('edit')) {
    return { prompt, image: imageUrl };
  }
  // Stability img2img / inpainting
  if (id.includes('stability-ai/stable-diffusion-img2img') ||
      id.includes('stability-ai/stable-diffusion-inpainting')) {
    return { prompt, image: imageUrl };
  }
  // Default: send the most common keys, the model will pick what it knows.
  // NOTE: image_input is a STRING here (not array) because most non-nano
  // models that accept it want a string.
  return {
    prompt,
    image: imageUrl,
    input_image: imageUrl,
    source_image: imageUrl,
  };
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

  // Helper to actually call one model. Returns the output URL on success,
  // or throws with a structured error on failure. Handles 422 schema
  // mismatches by retrying once with the generic union-of-keys body.
  const tryOne = async (modelId, version) => {
    const input = buildImageEditInput(modelId, prompt, imageUrl);
    let res = await replicatePredict(modelId, input, apiKey, version);
    if (res.status === 422) {
      // Schema mismatch — retry with the union body in case the per-model
      // builder guessed wrong about the field name.
      const genericInput = {
        prompt,
        image: imageUrl,
        input_image: imageUrl,
        image_input: [imageUrl],
        source_image: imageUrl,
      };
      res = await replicatePredict(modelId, genericInput, apiKey, version);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const err = new Error('Edit ' + res.status + ' on ' + modelId + ': ' + t.slice(0, 200));
      err.canFallback = (res.status === 404 || res.status === 422 || res.status === 400);
      throw err;
    }
    const data = await res.json();
    let out = data.output;
    if (Array.isArray(out)) out = out[0];
    if (!out) {
      const err = new Error('Model "' + modelId + '" returned no output');
      err.canFallback = true;
      throw err;
    }
    return out;
  };

  // STEP 1: try the user's currently-selected image model. ANY model
  // (including custom models with no preset). This is the primary path.
  const selected = findModel(selectedImage, 'image');
  const selectedId = selected?.replicateId;
  if (selectedId) {
    try {
      return await tryOne(selectedId, selected.version);
    } catch (e) {
      // Only fall back if the model genuinely can't do edits — 404 (no
      // such model), 422 (no image input), 400 (bad request). For any
      // other error (network, auth, rate-limit), surface it instead of
      // silently swapping to a different model.
      if (!e.canFallback) throw e;
      if (typeof showToast === 'function') {
        showToast(`${selected.name || selectedId} can't edit — falling back to Nano Banana Pro`);
      }
    }
  }

  // STEP 2: fall back to Nano Banana Pro. ONLY this. No other fallbacks.
  if (selectedId === NANO_BANANA_PRO_ID) {
    // Already tried it as the selected model and it failed — give up.
    throw new Error('Nano Banana Pro failed and there is no further fallback');
  }
  try {
    return await tryOne(NANO_BANANA_PRO_ID, null);
  } catch (e) {
    throw new Error('Both ' + (selectedId || 'selected model') + ' and Nano Banana Pro failed: ' + e.message);
  }
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
