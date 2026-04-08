// ========== KEMLLM Code Runner ==========
'use strict';

// ========== Code Execution Runtime ==========
// Strategy:
//   python  → Pyodide (in-browser WebAssembly, no network for exec)
//   js/ts   → sandboxed <iframe> (in-browser, no network)
//   others  → public code-runner API fallbacks (CORS-enabled)

// --- Pyodide (Python in browser) ---
let _pyodidePromise = null;
async function getPyodide() {
  if (_pyodidePromise) return _pyodidePromise;
  _pyodidePromise = (async () => {
    if (!window.loadPyodide) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load Pyodide from jsdelivr CDN. Check your internet connection.'));
        document.head.appendChild(s);
      });
    }
    return window.loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/' });
  })();
  // If it fails, clear the cached promise so the next call retries
  _pyodidePromise.catch(() => { _pyodidePromise = null; });
  return _pyodidePromise;
}

async function runPython(code) {
  let stdout = '', stderr = '';
  try {
    const py = await getPyodide();
    py.setStdout({ batched: (s) => { stdout += s + '\n'; } });
    py.setStderr({ batched: (s) => { stderr += s + '\n'; } });
    await py.runPythonAsync(code);
    return { run: { stdout, stderr, code: 0 }, runtime: 'pyodide' };
  } catch (e) {
    return { run: { stdout, stderr: stderr || e.message || String(e), code: 1 }, runtime: 'pyodide' };
  }
}

// --- Sandboxed JavaScript in an iframe ---
async function runJavaScript(code) {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-scripts';
    iframe.style.display = 'none';
    let stdout = '', stderr = '', done = false;
    const finish = (errorFlag) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      if (iframe.parentNode) iframe.remove();
      resolve({ run: { stdout, stderr, code: errorFlag ? 1 : 0 }, runtime: 'iframe-js' });
    };
    const onMsg = (e) => {
      if (!e.data || e.data.__kemllm !== 1) return;
      if (e.data.type === 'log') stdout += e.data.msg + '\n';
      else if (e.data.type === 'err') stderr += e.data.msg + '\n';
      else if (e.data.type === 'done') finish(e.data.error);
    };
    window.addEventListener('message', onMsg);
    const html = `<!doctype html><html><body><script>
      const _ser = a => a.map(x => { try { return typeof x === 'object' ? JSON.stringify(x) : String(x); } catch { return String(x); } }).join(' ');
      const _post = (type, msg, error) => parent.postMessage({ __kemllm: 1, type, msg, error }, '*');
      console.log = (...a) => _post('log', _ser(a));
      console.info = (...a) => _post('log', _ser(a));
      console.warn = (...a) => _post('log', _ser(a));
      console.error = (...a) => _post('err', _ser(a));
      window.onerror = (m) => { _post('err', m); _post('done', '', true); };
      (async () => {
        try {
          ${code}
          _post('done', '', false);
        } catch (e) {
          _post('err', (e && e.message) || String(e));
          _post('done', '', true);
        }
      })();
    <\/script></body></html>`;
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
    setTimeout(() => {
      stderr += stderr ? '' : 'Timeout after 10s';
      finish(true);
    }, 10000);
  });
}

// --- Remote execution via the HF Agent backend ---
// emkc.org Piston is whitelist-only as of 2026-02; we no longer try it.
// If the user has an HF Agent Backend configured, route non-Python/non-JS
// languages through /sessions/{id}/exec on that backend.
const REMOTE_LANG_CMD = {
  c:      code => `cat > /tmp/m.c <<'KEMLLM_EOF'\n${code}\nKEMLLM_EOF\ncc /tmp/m.c -o /tmp/m && /tmp/m`,
  cpp:    code => `cat > /tmp/m.cpp <<'KEMLLM_EOF'\n${code}\nKEMLLM_EOF\ng++ /tmp/m.cpp -o /tmp/m && /tmp/m`,
  'c++':  code => `cat > /tmp/m.cpp <<'KEMLLM_EOF'\n${code}\nKEMLLM_EOF\ng++ /tmp/m.cpp -o /tmp/m && /tmp/m`,
  rust:   code => `cat > /tmp/m.rs <<'KEMLLM_EOF'\n${code}\nKEMLLM_EOF\nrustc /tmp/m.rs -o /tmp/m 2>&1 && /tmp/m`,
  rs:     code => `cat > /tmp/m.rs <<'KEMLLM_EOF'\n${code}\nKEMLLM_EOF\nrustc /tmp/m.rs -o /tmp/m 2>&1 && /tmp/m`,
  go:     code => `cat > /tmp/m.go <<'KEMLLM_EOF'\n${code}\nKEMLLM_EOF\ngo run /tmp/m.go`,
  java:   code => `cat > /tmp/Main.java <<'KEMLLM_EOF'\n${code}\nKEMLLM_EOF\ncd /tmp && javac Main.java && java Main`,
  csharp: code => `cat > /tmp/m.cs <<'KEMLLM_EOF'\n${code}\nKEMLLM_EOF\necho "C# needs dotnet installed"`,
  cs:     code => `cat > /tmp/m.cs <<'KEMLLM_EOF'\n${code}\nKEMLLM_EOF\necho "C# needs dotnet installed"`,
  bash:   code => code,
  sh:     code => code,
  lua:    code => `cat > /tmp/m.lua <<'KEMLLM_EOF'\n${code}\nKEMLLM_EOF\nlua /tmp/m.lua`,
};

async function runViaRemote(lang, code) {
  const key = (lang || '').toLowerCase();
  const builder = REMOTE_LANG_CMD[key];
  if (!builder) {
    throw new Error('Language "' + lang + '" needs the HF Agent Backend. Set it up in Settings → Agent Backend (see agent-backend/SETUP.md).');
  }
  // Route through the agent backend if configured and running
  if (typeof hfFetch === 'function' && typeof getHfBackendUrl === 'function' && getHfBackendUrl()) {
    // Boot the session if we don't have one
    if (typeof agentSessionId !== 'undefined' && !agentSessionId && typeof agentStart === 'function') {
      await agentStart();
    }
    if (typeof agentSessionId !== 'undefined' && agentSessionId) {
      const tryExec = async () => hfFetch('/sessions/' + agentSessionId + '/exec', {
        method: 'POST',
        body: JSON.stringify({ command: builder(code) })
      });
      let r = await tryExec();
      // If the session went stale (container restarted, sleep-wake, etc.)
      // the backend returns 404 { code: 'no_session' }. Create a fresh
      // session and retry once — users shouldn't have to care.
      if (r.status === 404) {
        try {
          const txt = await r.clone().text();
          if (/no_session|session not found/i.test(txt)) {
            if (typeof window !== 'undefined') window.agentSessionId = '';
            if (typeof agentStart === 'function') await agentStart();
            if (typeof agentSessionId !== 'undefined' && agentSessionId) {
              r = await tryExec();
            }
          }
        } catch {}
      }
      if (!r.ok) throw new Error('Agent backend ' + r.status);
      const d = await r.json();
      return {
        run: { stdout: d.stdout || '', stderr: d.stderr || '', code: d.exit_code || 0 },
        runtime: 'agent-backend'
      };
    }
  }
  throw new Error('Running ' + lang + ' needs the HF Agent Backend. Go to Settings → Agent Backend URL and deploy it (5 min, see agent-backend/SETUP.md).');
}

// Unified entry point — replaces the old runViaPiston
async function runViaPiston(lang, code) { return runCode(lang, code); }
async function runCode(lang, code) {
  const l = (lang || '').toLowerCase();
  if (l === 'python' || l === 'py') return runPython(code);
  if (l === 'javascript' || l === 'js') return runJavaScript(code);
  if (l === 'typescript' || l === 'ts') {
    // Quick TS→JS transpile: strip type annotations with a naive regex (good enough for demos)
    const stripped = code
      .replace(/:\s*[A-Za-z_<>|&\[\],\s]+(?=\s*[=,)])/g, '')
      .replace(/\basinterface\s+\w+\s*\{[^}]*\}/g, '')
      .replace(/\btype\s+\w+\s*=[^;]+;/g, '');
    return runJavaScript(stripped);
  }
  return runViaRemote(l, code);
}

// ===== Code Panel =====
const CODE_FILES = {
  'main.py': { lang: 'python', content: '# Welcome to KEMLLM Code Runner\nprint("Hello, world!")\n\nfor i in range(5):\n    print(f"i = {i}")\n' },
  'app.js': { lang: 'javascript', content: '// JavaScript example\nconst nums = [1, 2, 3, 4, 5];\nconst sum = nums.reduce((a, b) => a + b, 0);\nconsole.log("Sum:", sum);\n' },
  'main.c': { lang: 'c', content: '#include <stdio.h>\n\nint main() {\n    printf("Hello from C!\\n");\n    return 0;\n}\n' },
  'main.rs': { lang: 'rust', content: 'fn main() {\n    println!("Hello from Rust!");\n}\n' }
};
let currentFile = 'main.py';

function loadFile(name) {
  currentFile = name;
  const f = CODE_FILES[name];
  const editor = document.getElementById('code-editor');
  if (editor) editor.textContent = f.content;
  const sel = document.getElementById('code-lang-sel');
  if (sel) sel.value = f.lang;
  document.querySelectorAll('.code-file').forEach(el => {
    el.classList.toggle('active', el.dataset.file === name);
  });
  updateLineNumbers();
}

function updateLineNumbers() {
  const editor = document.getElementById('code-editor');
  const lns = document.getElementById('code-lns');
  if (!editor || !lns) return;
  const lines = (editor.textContent || '').split('\n').length;
  let html = '';
  for (let i = 1; i <= lines; i++) html += i + '\n';
  lns.textContent = html;
}

async function runCurrentCode() {
  const editor = document.getElementById('code-editor');
  const sel = document.getElementById('code-lang-sel');
  const out = document.getElementById('code-out-body');
  const info = document.getElementById('code-out-info');
  if (!editor || !out) return;
  out.textContent = 'Running...';
  out.classList.remove('err');
  info.textContent = '';
  try {
    const start = Date.now();
    const result = await runViaPiston(sel.value, editor.textContent);
    const ms = Date.now() - start;
    const stdout = result.run?.stdout || '';
    const stderr = result.run?.stderr || '';
    const code = result.run?.code;
    if (stderr) {
      out.classList.add('err');
      out.textContent = stderr + (stdout ? '\n' + stdout : '');
    } else {
      out.textContent = stdout || '(no output)';
    }
    info.textContent = `exit ${code} · ${ms}ms`;
  } catch (e) {
    out.classList.add('err');
    out.textContent = e.message;
  }
}

function askAIAboutCode() {
  const editor = document.getElementById('code-editor');
  const sel = document.getElementById('code-lang-sel');
  if (!editor) return;
  const prompt = `Please review this ${sel.value} code:\n\n\`\`\`${sel.value}\n${editor.textContent}\n\`\`\``;
  siNav('chat');
  const input = document.getElementById('input-text');
  input.value = prompt;
  input.focus();
}

function setupCodeEditor() {
  const editor = document.getElementById('code-editor');
  if (!editor) return;
  editor.contentEditable = 'true';
  editor.addEventListener('input', updateLineNumbers);
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '    ');
    }
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      runCurrentCode();
    }
  });
  loadFile('main.py');
}
