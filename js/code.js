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
        s.onerror = () => reject(new Error('Failed to load Pyodide'));
        document.head.appendChild(s);
      });
    }
    return window.loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/' });
  })();
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

// --- Fallback HTTP runner for languages Pyodide/iframe can't handle ---
const PISTON_LANGS = {
  c: { language: 'c', version: '10.2.0', ext: 'c' },
  cpp: { language: 'c++', version: '10.2.0', ext: 'cpp' },
  'c++': { language: 'c++', version: '10.2.0', ext: 'cpp' },
  rust: { language: 'rust', version: '1.68.2', ext: 'rs' },
  rs: { language: 'rust', version: '1.68.2', ext: 'rs' },
  go: { language: 'go', version: '1.16.2', ext: 'go' },
  java: { language: 'java', version: '15.0.2', ext: 'java' },
  csharp: { language: 'csharp', version: '6.12.0', ext: 'cs' },
  cs: { language: 'csharp', version: '6.12.0', ext: 'cs' },
  bash: { language: 'bash', version: '5.2.0', ext: 'sh' },
  sh: { language: 'bash', version: '5.2.0', ext: 'sh' },
  lua: { language: 'lua', version: '5.4.4', ext: 'lua' }
};
const RUNNER_ENDPOINTS = [
  'https://emkc.org/api/v2/piston/execute'
];
async function runViaRemote(lang, code) {
  const cfg = PISTON_LANGS[(lang || '').toLowerCase()];
  if (!cfg) throw new Error('Language not supported: ' + lang);
  const body = JSON.stringify({
    language: cfg.language,
    version: cfg.version,
    files: [{ name: 'main.' + cfg.ext, content: code }]
  });
  let lastErr = null;
  for (const url of RUNNER_ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (res.ok) { const data = await res.json(); data.runtime = 'remote'; return data; }
      lastErr = new Error('Runner ' + res.status);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('No remote runner available');
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
