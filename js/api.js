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
  // Sync topbar Web button to match the sandbox-web profile setting
  const webIsOn = profileGet('sandbox-web') !== '0';
  const webBtn = document.getElementById('tb-web');
  if (webBtn) webBtn.classList.toggle('on', webIsOn);
  if (typeof window !== 'undefined') window.webSearchOn = webIsOn;
  // Background music settings (auto-on by default)
  const musicOnEl = document.getElementById('sp-music-on');
  const musicVolEl = document.getElementById('sp-music-vol');
  const musicVolLabelEl = document.getElementById('sp-music-vol-label');
  if (musicOnEl) musicOnEl.checked = profileGet('music-on') !== '0';
  if (musicVolEl) {
    const v = parseInt(profileGet('music-vol') || '50', 10);
    musicVolEl.value = String(v);
    if (musicVolLabelEl) musicVolLabelEl.textContent = v + '%';
  }
  if (typeof syncHomeMusic === 'function') syncHomeMusic();
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
    // Direct API has priority. But if the direct API returns 404
    // "model not found" (e.g. outdated Anthropic model id), fall back
    // to Replicate automatically instead of surfacing the 404.
    try {
      return await tryProvider();
    } catch (e) {
      const msg = String(e && e.message || e);
      const is404 = /404|not[_ ]?found|not found/i.test(msg);
      if (is404 && model.replicateId && getRepKey()) {
        showToast(model.name + ' not found on ' + provider + ' API, falling back to Replicate');
        return tryReplicate();
      }
      throw e;
    }
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
  lines.push('- HTML / CSS / WEB PAGES. When the user asks for a webpage, design, landing page, HTML/CSS/JS app, or interactive component — write the code DIRECTLY in a ```html fenced code block with the raw HTML/CSS/JS inside. NEVER wrap HTML in a Python string literal or build it by concatenation. NEVER write `html_content = """..."""` in Python. Just write ```html and paste the actual HTML. The frontend auto-opens ```html blocks in a live preview pane (Claude-artifact style). You can include <style> and <script> tags inside the same HTML block.');
  lines.push('- IMAGE GENERATION. Emit `[GENERATE_IMAGE prompt="..." aspect_ratio="16:9"]`. Write a rich visual description (subject, composition, lighting, style, colors). The aspect_ratio param is OPTIONAL — include it when the user asks for "wide", "tall", "portrait", "landscape", "16:9", "square", "1080p", "phone wallpaper", etc. Common values: "1:1", "16:9", "9:16", "4:3", "3:4", "21:9", "3:2", "2:3". Default is square if you omit it. NEVER emit GENERATE_IMAGE if the user has attached an image to this message — use EDIT_IMAGE instead.');
  lines.push('- VIDEO GENERATION. Emit `[GENERATE_VIDEO prompt="..." aspect_ratio="16:9"]`. Same aspect_ratio rules as image gen.');
  lines.push('- IMAGE EDITING. If the user has ATTACHED an image to their message and asks you to modify, change, recolor, restyle, remove, add, replace, or transform something in it — emit `[EDIT_IMAGE prompt="rewritten detailed instruction for the image editor" aspect_ratio="..."]`. Do this even for short requests like "make it blue" or "remove the background" — rewrite the prompt to be descriptive. This ALSO works on images you previously generated in the same conversation. CRITICAL: when there is an attached image, NEVER emit GENERATE_IMAGE — only EDIT_IMAGE. Emit at most ONE marker per response. Do NOT describe the edit in prose and refuse to do it — emit the marker.');
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
  // Web access defaults ON — only off if user explicitly set to '0'.
  //
  // UNIVERSAL WEB SEARCH: every model — Claude, GPT, Gemini, Grok, Llama,
  // Mistral, DeepSeek, anything on Replicate — gets web search via the
  // [WEB_SEARCH query="..."] marker. The frontend intercepts the marker,
  // runs the search through the KEMLLM Cloudflare worker (DuckDuckGo) with
  // a Wikipedia + DDG-instant-answer fallback, and feeds the results back
  // as a follow-up turn so the model can answer with live info. No API
  // key, no provider-specific tool wiring required.
  //
  // We ALSO tell the AI how to fetch URLs in code (Pyodide pyfetch, iframe
  // fetch, HF curl) for cases where it wants raw data instead of search.
  if (profileGet('sandbox-web') === '0') {
    lines.push('- NETWORK: OFF. Code execution has no internet access. Do not attempt HTTP requests in code.');
  } else {
    // STRONG instruction. Smaller / non-frontier models won\'t emit the
    // marker without explicit, repeated, unambiguous direction. We tell
    // the model exactly when to use it AND give a worked example.
    lines.push('- WEB SEARCH. YOU HAVE LIVE WEB SEARCH. To use it, emit this marker EXACTLY (on its own line) anywhere in your reply:');
    lines.push('    [WEB_SEARCH query="your search terms here"]');
    lines.push('  The KEMLLM frontend will intercept the marker, run a real search engine query (Jina Reader / DuckDuckGo / Wikipedia), and feed the results back to you as the NEXT user turn. You then answer the original question using those fresh results.');
    lines.push('  WHEN to use it (REQUIRED — do NOT skip this):');
    lines.push('    • The user asks about ANYTHING after your training cutoff date');
    lines.push('    • Current events, news, today\'s weather, sports scores, stock/crypto prices');
    lines.push('    • "Latest", "newest", "current", "recent", "right now", "today", "this week"');
    lines.push('    • Real people / companies / products you might be out of date on');
    lines.push('    • Specific facts you are not 100% sure about');
    lines.push('    • Anything where being wrong would be worse than admitting you searched');
    lines.push('  WHAT NEVER TO SAY (these are forbidden when web search is on):');
    lines.push('    • "I can\'t browse the internet"  → WRONG, you can, use the marker');
    lines.push('    • "My training data only goes up to..."  → WRONG, search instead');
    lines.push('    • "I don\'t have access to real-time information"  → WRONG, you do');
    lines.push('    • "You should check a search engine"  → WRONG, YOU are the search engine, emit the marker');
    lines.push('  HOW it works (worked example):');
    lines.push('    User: "what\'s the current price of Bitcoin"');
    lines.push('    You (turn 1): "Let me check the current price.\\n[WEB_SEARCH query="current Bitcoin price USD"]"');
    lines.push('    System feeds you the search results as a follow-up turn.');
    lines.push('    You (turn 2): "Bitcoin is currently trading at $X (source: ...)."');
    lines.push('  Rules: emit at most ONE marker per response. After receiving results, write a normal prose answer and cite source URLs when relevant. Do not emit a second marker unless the first results are truly insufficient.');
    lines.push('- WEB FETCH (raw): you can also fetch a specific URL directly via code execution when you need raw HTML/JSON instead of search results:');
    lines.push('  • Python (Pyodide, browser): `requests` and `urllib` do NOT work (no raw sockets). Use `pyodide.http.pyfetch` with top-level await:\n    ```python\n    from pyodide.http import pyfetch\n    r = await pyfetch("https://example.com/api.json")\n    data = await r.json()       # or: text = await r.string()\n    print(data)\n    ```');
    lines.push('  • JavaScript (sandboxed iframe): use `fetch()` with await:\n    ```javascript\n    const r = await fetch("https://example.com/api.json");\n    const data = await r.json();\n    console.log(data);\n    ```');
    lines.push('  • Bash / shell (only when an HF Agent backend is configured): use `curl -s` or `wget -qO-`.');
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

  // Style rules — no emojis, no "be helpful" / "I'd be happy to" filler.
  lines.push('');
  lines.push('STYLE:');
  lines.push('- Do not use emojis or emoticons in your responses. Ever.');
  lines.push('- No filler phrases like "Great question!", "Certainly!", "I\'d be happy to help", "Let me know if you need anything else".');
  lines.push('- No chirpy disclaimers. No meta-commentary about being an AI.');
  lines.push('- Use real Markdown tables, headings, code blocks when appropriate. Render data as tables when it has multiple columns.');
  lines.push('- Prefer concrete technical detail over generic advice.');
  lines.push('- When showing multiple items (models, options, comparisons), use a table.');

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
// Decide whether an attachment's mime/name looks like text we can decode
// inline (HTML, source code, JSON, plain text, markdown, CSV, etc).
function isTextualAttachment(a) {
  const mime = (a.mime || '').toLowerCase();
  const name = (a.name || '').toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (mime.includes('json') || mime.includes('xml') || mime.includes('yaml') ||
      mime.includes('javascript') || mime.includes('typescript') ||
      mime.includes('html') || mime.includes('css') || mime.includes('csv')) return true;
  // Common code extensions even if mime is application/octet-stream
  if (/\.(txt|md|json|jsonc|yml|yaml|toml|ini|cfg|conf|env|csv|tsv|log|html?|htm|xml|svg|css|scss|less|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|rb|go|rs|c|h|cpp|hpp|cs|java|kt|swift|php|sh|bash|zsh|fish|sql|graphql|gql|proto|dockerfile|makefile|cmake|gradle|gitignore|gitattributes|editorconfig|prettierrc|eslintrc|babelrc|lock|patch|diff)$/i.test(name)) return true;
  return false;
}

// Decode an attachment data URL to UTF-8 text. Returns '' on failure.
function decodeAttachmentText(a) {
  if (!a || !a.dataUrl) return '';
  const d = parseDataUrl(a.dataUrl);
  if (!d) return '';
  try {
    // base64 → bytes → utf-8 string
    const bin = atob(d.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch { return ''; }
}

// Build a text block describing one non-image attachment. Embeds the
// content inline in a fenced code block when it's text-like; otherwise
// just notes the filename + size + mime so the AI can reference it.
function attachmentToTextBlock(a) {
  const name = a.name || 'file';
  const mime = a.mime || 'application/octet-stream';
  const sizeKb = a.size ? ` · ${(a.size/1024).toFixed(1)} KB` : '';
  if (isTextualAttachment(a)) {
    const text = decodeAttachmentText(a);
    if (text) {
      // Cap at 200 KB of text per attachment to avoid blowing context window
      const MAX = 200 * 1024;
      const truncated = text.length > MAX ? text.slice(0, MAX) + `\n\n[... truncated, ${text.length - MAX} more chars ...]` : text;
      const ext = (name.split('.').pop() || '').toLowerCase();
      return `Attached file: \`${name}\` (${mime}${sizeKb})\n\n\`\`\`${ext}\n${truncated}\n\`\`\``;
    }
  }
  return `Attached file: \`${name}\` (${mime}${sizeKb}) — binary, not inlined.`;
}

function anthropicMessageFrom(m) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  const atts = m.attachments || [];
  if (!atts.length) return { role, content: m.content };

  const images = atts.filter(a => a.isImage || (a.mime || '').startsWith('image/'));
  const nonImages = atts.filter(a => !(a.isImage || (a.mime || '').startsWith('image/')));

  const parts = [];
  // Image content blocks first
  for (const a of images) {
    const d = parseDataUrl(a.dataUrl);
    if (!d) continue;
    parts.push({ type: 'image', source: { type: 'base64', media_type: d.mediaType, data: d.base64 } });
  }
  // Non-image attachments: decode text content inline
  const fileTexts = nonImages.map(attachmentToTextBlock).filter(Boolean);
  // Combine the user text with file content blocks
  const textChunks = [];
  if (m.content) textChunks.push(m.content);
  if (fileTexts.length) textChunks.push(fileTexts.join('\n\n'));
  if (textChunks.length) {
    parts.push({ type: 'text', text: textChunks.join('\n\n') });
  }
  return { role, content: parts.length ? parts : m.content };
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
  // Web search — Anthropic's native server-side tool. Enabled whenever the
  // user has the Web toggle on (sandbox-web !== '0'). It's a server-side
  // tool, so the model handles the loop internally and we still get back
  // a normal text response — no client-side tool plumbing needed.
  const useWebSearch = profileGet('sandbox-web') !== '0';
  const tools = [];
  if (useComputer) {
    tools.push({
      type: 'computer_20241022',
      name: 'computer',
      // Must match the Xvfb :0 resolution in start-desktop.sh (1920x1080 since v88)
      display_width_px: 1920,
      display_height_px: 1080,
      display_number: 0,
    });
  }
  if (useWebSearch) {
    tools.push({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
    });
  }
  const toolsParam = tools.length ? tools : undefined;

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
  // Web search is server-side so it works fine in this single-shot path.
  if (!useComputer) {
    const body = {
      model: model.apiId,
      max_tokens: anthropicMax,
      system: sys,
      messages: msgs,
    };
    if (toolsParam) body.tools = toolsParam;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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
        tools: toolsParam,
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
    const atts = m.attachments || [];
    if (!atts.length) return { role: m.role, content: m.content };
    const images = atts.filter(a => a.isImage || (a.mime || '').startsWith('image/'));
    const nonImages = atts.filter(a => !(a.isImage || (a.mime || '').startsWith('image/')));
    const fileTexts = nonImages.map(attachmentToTextBlock).filter(Boolean);
    const text = [m.content || '', fileTexts.join('\n\n')].filter(Boolean).join('\n\n');
    if (images.length) {
      const parts = [];
      if (text) parts.push({ type: 'text', text });
      images.forEach(a => parts.push({ type: 'image_url', image_url: { url: a.dataUrl } }));
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: text || m.content };
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

async function editImage(prompt, sourceUrl, aspectRatio) {
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
  // Also polls the prediction if Replicate's Prefer:wait timed out
  // server-side and returned status=processing.
  const tryOne = async (modelId, version) => {
    const input = addAspectRatioToInput(buildImageEditInput(modelId, prompt, imageUrl), aspectRatio, modelId);
    let res = await replicatePredict(modelId, input, apiKey, version);
    if (res.status === 422) {
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
    let data = await res.json();
    data = await awaitPrediction(data, apiKey);
    if (data.status === 'failed' || data.status === 'canceled') {
      const err = new Error('Model "' + modelId + '" ' + data.status + ': ' + (data.error || 'unknown'));
      err.canFallback = true;
      throw err;
    }
    const url = extractOutputUrl(data.output);
    if (!url) {
      const err = new Error('Model "' + modelId + '" succeeded but returned no URL');
      err.canFallback = true;
      throw err;
    }
    return url;
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

// Translate an aspect ratio string like "16:9" into pixel width/height for
// models that need width/height instead of (or in addition to) aspect_ratio.
// Returns null if the input doesn't parse.
function aspectRatioToWH(ar) {
  if (!ar || typeof ar !== 'string') return null;
  const m = ar.match(/^(\d+)\s*[:x\/]\s*(\d+)$/);
  if (!m) return null;
  const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
  if (!w || !h) return null;
  // Aim for ~1.0-1.3 megapixels (matches Flux/SDXL/Nano Banana defaults)
  const targetMP = 1.15;
  const scale = Math.sqrt(targetMP * 1_000_000 / (w * h));
  let pw = Math.round(w * scale), ph = Math.round(h * scale);
  // Round to nearest 8 (most diffusion models require it)
  pw = Math.round(pw / 8) * 8;
  ph = Math.round(ph / 8) * 8;
  return { width: pw, height: ph };
}

// Translate natural language aspect ratio terms → numeric string.
// Sora and some other models use words like "portrait" instead of numeric.
function normalizeAspectRatio(ar) {
  if (!ar) return null;
  const s = String(ar).trim().toLowerCase();
  const map = {
    'square': '1:1', '1:1': '1:1',
    'landscape': '16:9', 'wide': '16:9', 'widescreen': '16:9', '16:9': '16:9',
    'portrait': '9:16', 'tall': '9:16', 'phone': '9:16', '9:16': '9:16',
    'cinema': '21:9', 'cinematic': '21:9', 'ultrawide': '21:9', '21:9': '21:9',
    '4:3': '4:3', 'standard': '4:3',
    '3:4': '3:4',
    '3:2': '3:2', '2:3': '2:3',
  };
  if (map[s]) return map[s];
  if (/^\d+\s*[:x\/]\s*\d+$/.test(s)) return s;
  return s;
}

// Convert an aspect_ratio (numeric or word) into Sora's word form.
function aspectRatioToWord(ar) {
  const s = (ar || '').toLowerCase();
  if (s === 'portrait' || s === '9:16' || s === '3:4' || s === '2:3' || s === 'tall' || s === 'phone') return 'portrait';
  if (s === 'square' || s === '1:1') return 'square';
  return 'landscape';
}

// Some models REQUIRE word form for aspect_ratio (Sora), others REQUIRE
// numeric ("16:9") (most Flux/Nano/Kling variants). Detect by model id.
function modelNeedsWordAspectRatio(modelId) {
  return /sora|openai\//i.test(modelId || '');
}

// Add aspect_ratio + width/height to a Replicate input dict in-place if
// the caller passed an aspectRatio. Dispatches the right format based
// on the target model's requirements.
function addAspectRatioToInput(input, aspectRatio, modelId) {
  if (!aspectRatio) return input;
  const normalized = normalizeAspectRatio(aspectRatio);
  if (modelNeedsWordAspectRatio(modelId)) {
    // Sora-style: aspect_ratio must be "portrait" / "landscape" / "square"
    input.aspect_ratio = aspectRatioToWord(normalized);
  } else {
    // Numeric path (most models)
    input.aspect_ratio = normalized;
    // Also set orientation word as a secondary hint
    if (/^\d+:\d+$/.test(normalized)) {
      if (normalized === '9:16') input.orientation = 'portrait';
      else if (normalized === '16:9') input.orientation = 'landscape';
      else if (normalized === '1:1') input.orientation = 'square';
    } else {
      input.orientation = normalized;
    }
  }
  const wh = aspectRatioToWH(normalized);
  if (wh) {
    input.width = wh.width;
    input.height = wh.height;
  }
  return input;
}

// Drill into a Replicate prediction `output` field which can be:
//   - a string (single URL)                  → return as-is
//   - an array of strings                    → return first
//   - an object with a `url` property        → return .url (FileOutput shape)
//   - an array of FileOutput objects         → recurse into first
//   - null / undefined                       → return null
// Returns a usable URL string, or null if nothing valid was found.
function extractOutputUrl(out) {
  if (out == null) return null;
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) {
    for (const item of out) {
      const u = extractOutputUrl(item);
      if (u) return u;
    }
    return null;
  }
  if (typeof out === 'object') {
    if (typeof out.url === 'string') return out.url;
    if (typeof out.href === 'string') return out.href;
  }
  return null;
}

// Poll a Replicate prediction until it's done. The initial response from
// `replicatePredict` may be in `processing` status (Prefer:wait times out
// after 60s on the server). This function picks up the polling URL from
// `data.urls.get` and waits until status === 'succeeded' (or fails).
// Returns the final prediction data object.
async function awaitPrediction(initialData, apiKey, maxSeconds) {
  const max = maxSeconds || 300; // 5 min default
  let data = initialData;
  // Already done? Done.
  if (data.status === 'succeeded' || data.status === 'failed' || data.status === 'canceled') {
    return data;
  }
  const getUrl = data?.urls?.get;
  if (!getUrl) return data; // nothing we can do
  // Strip the Replicate origin so we go through the worker proxy
  const proxyPath = getUrl.replace(/^https?:\/\/api\.replicate\.com/, '');
  const start = Date.now();
  while (Date.now() - start < max * 1000) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const r = await replicateFetch(proxyPath, {
        headers: { 'Authorization': 'Bearer ' + apiKey },
      });
      if (!r.ok) continue;
      data = await r.json();
      if (data.status === 'succeeded' || data.status === 'failed' || data.status === 'canceled') {
        return data;
      }
    } catch {}
  }
  throw new Error('Prediction timed out after ' + max + 's');
}

async function generateImage(prompt, aspectRatio, extras) {
  const apiKey = getRepKey();
  if (!apiKey) throw new Error('Add your Replicate key in Settings to generate images');
  const m = findModel(selectedImage, 'image');
  if (!m) throw new Error('No image model selected');

  const idsToTry = [m.replicateId, ...IMAGE_FALLBACK_IDS.filter(id => id !== m.replicateId)];
  let lastErr = null;
  for (const id of idsToTry) {
    try {
      // Start with the user's chip extras, then layer the prompt + aspect
      // ratio defaults on top so they always win over stale values.
      const base = Object.assign({}, extras || {}, { prompt });
      const input = addAspectRatioToInput(base, aspectRatio, id);
      const res = await replicatePredict(id, input, apiKey);
      if (res.status === 404) {
        lastErr = new Error('Model "' + id + '" not found on Replicate');
        continue;
      }
      if (res.status === 422) {
        // Schema mismatch — either the model wants a different field
        // name, OR (more commonly) it's an edit-only model that refuses
        // to run without an `image` input. Either way we can't generate
        // from this model — skip and try the next fallback.
        const t = await res.text().catch(() => '');
        lastErr = new Error('Model "' + id + '" rejected: ' + t.slice(0, 200));
        continue;
      }
      if (!res.ok) {
        const t = await res.text();
        throw new Error('Image gen ' + res.status + ': ' + t.slice(0, 200));
      }
      let data = await res.json();
      // Poll past Replicate's 60s Prefer:wait timeout for slow models.
      data = await awaitPrediction(data, apiKey);
      if (data.status === 'failed' || data.status === 'canceled') {
        const errMsg = (data.error || 'unknown').toString();
        lastErr = new Error('Model "' + id + '" ' + data.status + ': ' + errMsg);
        // If it's an edit-only model or no-image error, skip to next
        if (/image|edit|required/i.test(errMsg)) continue;
        throw lastErr;
      }
      const url = extractOutputUrl(data.output);
      if (!url) {
        lastErr = new Error('Model "' + id + '" succeeded but returned no URL');
        continue;
      }
      if (id !== m.replicateId) showToast('Used fallback: ' + id);
      return url;
    } catch (e) {
      lastErr = e;
      // Only propagate non-recoverable errors; everything that looks
      // like a schema/edit-only/no-image rejection should try the next.
      if (!/not found|rejected|edit|image is required|422/i.test(String(e.message))) throw e;
    }
  }
  throw lastErr || new Error('All image models failed');
}

async function generateVideo(prompt, aspectRatio, extras) {
  const apiKey = getRepKey();
  if (!apiKey) throw new Error('Add your Replicate key in Settings to generate videos');
  const m = findModel(selectedVideo, 'video');
  if (!m) throw new Error('No video model selected');
  // Merge user-supplied chip extras into the input. The prompt + aspect
  // ratio always win over stale extras values.
  const baseVid = Object.assign({}, extras || {}, { prompt });
  const vidInput = addAspectRatioToInput(baseVid, aspectRatio, m.replicateId);
  let res = await replicateFetch(`/v1/models/${m.replicateId}/predictions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({ input: vidInput })
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

// ========== Replicate model schema ==========
// Lazy fetcher for a Replicate model's openapi_schema, used to drive
// the dynamic generator chip strip. Each model has different inputs:
// FLUX has aspect_ratio + num_inference_steps + guidance_scale, Kling
// has duration + cfg_scale + camera, Veo has aspect + duration + seed,
// etc. Rather than hardcoding a per-model UI we read the schema and
// render controls automatically.
const _replicateSchemaCache = {};
async function fetchModelSchema(modelId) {
  if (!modelId) return null;
  if (_replicateSchemaCache[modelId]) return _replicateSchemaCache[modelId];
  const apiKey = getRepKey();
  if (!apiKey) return null;
  try {
    const r = await replicateFetch(`/v1/models/${modelId}`, {
      headers: { 'Authorization': 'Bearer ' + apiKey },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const full = data?.latest_version?.openapi_schema;
    if (!full) return null;
    // Pull the Input schema (the top-level prediction-input shape) and
    // resolve any internal $refs to component schemas (Replicate puts
    // enums in components.schemas.<Name> with allOf: [{$ref: ...}]).
    const inputSchema = full?.components?.schemas?.Input;
    if (!inputSchema) return null;
    const resolved = resolveRefs(inputSchema, full);
    _replicateSchemaCache[modelId] = resolved;
    return resolved;
  } catch {
    return null;
  }
}

// Walk a JSON schema, replacing { $ref: '#/components/schemas/X' } with
// the actual referenced schema (merged into parent for allOf wrappers).
// Handles the common Replicate patterns:
//   { allOf: [{ $ref: '#/components/schemas/aspect_ratio' }] }
//   { $ref: '#/components/schemas/aspect_ratio' }
function resolveRefs(node, root, depth) {
  depth = depth || 0;
  if (depth > 10 || node == null) return node;
  if (Array.isArray(node)) return node.map(n => resolveRefs(n, root, depth + 1));
  if (typeof node !== 'object') return node;
  // Direct $ref
  if (node.$ref && typeof node.$ref === 'string') {
    const path = node.$ref.replace(/^#\//, '').split('/');
    let target = root;
    for (const p of path) {
      target = target?.[p];
      if (target == null) return node;
    }
    return resolveRefs(target, root, depth + 1);
  }
  // allOf wrapper — merge resolved children into a single object
  if (Array.isArray(node.allOf)) {
    let merged = {};
    for (const sub of node.allOf) {
      const r = resolveRefs(sub, root, depth + 1);
      if (r && typeof r === 'object') merged = Object.assign({}, merged, r);
    }
    // Preserve other sibling fields (default, title, description, etc.)
    const { allOf, ...rest } = node;
    return Object.assign({}, merged, rest);
  }
  // Recurse into every child
  const out = {};
  for (const k of Object.keys(node)) {
    out[k] = resolveRefs(node[k], root, depth + 1);
  }
  return out;
}

// ========== Universal Web Search ==========
// Provider-agnostic web search backend used by the [WEB_SEARCH query="..."]
// marker. ALL chat models (Claude, GPT, Gemini, Grok, Llama, Mistral,
// DeepSeek, etc.) call into this when they emit the marker — no per-provider
// tool wiring required.
//
// Multi-source strategy, tried in order:
//   1. KEMLLM Cloudflare worker /search endpoint, which proxies DuckDuckGo
//      HTML and parses out title/url/snippet for each hit. Best results.
//   2. DuckDuckGo Instant Answer API (CORS-enabled, no key). Limited to
//      "instant answers" — Wikipedia summaries, calculators, definitions —
//      but works directly from the browser without the worker.
//   3. Wikipedia opensearch + REST summaries (CORS-enabled, no key).
//      Always works for encyclopedic queries.
//
// Returns a markdown-formatted string ready to feed back to the model as a
// follow-up turn, OR throws if every source failed.
const SEARCH_BASE = REPLICATE_BASE.replace(/\/replicate$/, '') + '/search';

async function runWebSearch(query) {
  const q = (query || '').trim();
  if (!q) throw new Error('empty search query');

  const sources = [];

  // Source 1: Jina Reader search — `https://s.jina.ai/<query>` returns
  // real Google-style search results in plain text/markdown, with
  // permissive CORS (Access-Control-Allow-Origin: *) so it works
  // directly from the browser. No API key required for the free tier.
  // This is the PRIMARY source because it works for every user without
  // any setup (worker not deployed, no API keys, etc).
  try {
    const r = await fetch('https://s.jina.ai/' + encodeURIComponent(q), {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        // Ask Jina for the structured-JSON response so we can format it
        // ourselves rather than dumping a giant markdown blob into the
        // model's context.
        'X-Respond-With': 'no-content',
      },
    });
    if (r.ok) {
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const j = await r.json();
        const items = (j && (j.data || j.results)) || [];
        if (Array.isArray(items) && items.length) {
          const lines = [`Web search results for "${q}" (Jina Reader):`, ''];
          items.slice(0, 8).forEach((res, i) => {
            const title = (res.title || res.url || '').trim();
            const url = (res.url || '').trim();
            const snip = (res.description || res.snippet || res.content || '').toString().trim().slice(0, 400);
            lines.push(`${i + 1}. ${title}`);
            if (url) lines.push(`   ${url}`);
            if (snip) lines.push(`   ${snip}`);
            lines.push('');
          });
          return lines.join('\n').trim();
        }
      } else {
        // Plain text/markdown fallback — Jina returned a flat document.
        const txt = await r.text();
        if (txt && txt.trim().length > 40) {
          return `Web search results for "${q}" (Jina Reader):\n\n` + txt.trim().slice(0, 6000);
        }
      }
    }
  } catch (e) {
    sources.push('jina: ' + (e.message || String(e)));
  }

  // Source 2: KEMLLM worker /search → DuckDuckGo HTML proxy.
  // Used when Jina is rate-limited or down. Requires the user to have
  // deployed the updated cloudflare-worker/kemllmbackend.js.
  try {
    const r = await fetch(SEARCH_BASE + '?q=' + encodeURIComponent(q), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (r.ok) {
      const j = await r.json();
      if (j && Array.isArray(j.results) && j.results.length) {
        const lines = [`Web search results for "${q}" (DuckDuckGo via KEMLLM worker):`, ''];
        j.results.slice(0, 8).forEach((res, i) => {
          const title = (res.title || res.url || '').trim();
          const url = (res.url || '').trim();
          const snip = (res.snippet || '').trim();
          lines.push(`${i + 1}. ${title}`);
          if (url) lines.push(`   ${url}`);
          if (snip) lines.push(`   ${snip}`);
          lines.push('');
        });
        return lines.join('\n').trim();
      }
    }
  } catch (e) {
    sources.push('worker: ' + (e.message || String(e)));
  }

  // Source 2: DuckDuckGo Instant Answer (CORS-enabled, no key)
  let ddgBlock = '';
  try {
    const r = await fetch(
      'https://api.duckduckgo.com/?q=' + encodeURIComponent(q) +
      '&format=json&no_html=1&skip_disambig=1&t=kemllm'
    );
    if (r.ok) {
      const j = await r.json();
      const parts = [];
      if (j.AbstractText) parts.push(j.AbstractText);
      if (j.AbstractURL) parts.push('Source: ' + j.AbstractURL);
      if (j.Definition) parts.push('Definition: ' + j.Definition);
      if (j.Answer) parts.push('Answer: ' + j.Answer);
      if (Array.isArray(j.RelatedTopics) && j.RelatedTopics.length) {
        parts.push('');
        parts.push('Related:');
        j.RelatedTopics.slice(0, 6).forEach(rt => {
          if (rt.Text) parts.push('- ' + rt.Text + (rt.FirstURL ? ' (' + rt.FirstURL + ')' : ''));
        });
      }
      if (parts.length) ddgBlock = parts.join('\n');
    }
  } catch (e) {
    sources.push('ddg-ia: ' + (e.message || String(e)));
  }

  // Source 3: Wikipedia opensearch + summary (CORS-enabled, no key)
  let wikiBlock = '';
  try {
    const r = await fetch(
      'https://en.wikipedia.org/w/api.php?action=opensearch&limit=5&format=json&origin=*&search=' +
      encodeURIComponent(q)
    );
    if (r.ok) {
      const j = await r.json();
      // opensearch returns [query, [titles], [descriptions], [urls]]
      const titles = j[1] || [];
      const descs = j[2] || [];
      const urls = j[3] || [];
      if (titles.length) {
        const lines = ['Wikipedia matches:'];
        for (let i = 0; i < Math.min(titles.length, 5); i++) {
          lines.push(`- ${titles[i]}: ${descs[i] || '(no description)'}`);
          if (urls[i]) lines.push(`  ${urls[i]}`);
        }
        wikiBlock = lines.join('\n');
      }
    }
  } catch (e) {
    sources.push('wiki: ' + (e.message || String(e)));
  }

  if (ddgBlock || wikiBlock) {
    const out = [`Web search results for "${q}":`, ''];
    if (ddgBlock) { out.push(ddgBlock); out.push(''); }
    if (wikiBlock) { out.push(wikiBlock); }
    return out.join('\n').trim();
  }

  throw new Error(
    'Web search failed across all sources. Tried: ' +
    (sources.length ? sources.join('; ') : 'worker, ddg-ia, wikipedia') +
    '. The KEMLLM worker /search endpoint may not be deployed yet — see cloudflare-worker/kemllmbackend.js.'
  );
}
