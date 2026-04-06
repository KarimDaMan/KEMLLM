// ========== KEMLLM Code Runner ==========
'use strict';

const PISTON_LANGS = {
  python: { language: 'python', version: '3.12.0' },
  py: { language: 'python', version: '3.12.0' },
  javascript: { language: 'javascript', version: '18.15.0' },
  js: { language: 'javascript', version: '18.15.0' },
  typescript: { language: 'typescript', version: '5.0.3' },
  ts: { language: 'typescript', version: '5.0.3' },
  c: { language: 'c', version: '10.2.0' },
  cpp: { language: 'c++', version: '10.2.0' },
  'c++': { language: 'c++', version: '10.2.0' },
  rust: { language: 'rust', version: '1.68.2' },
  rs: { language: 'rust', version: '1.68.2' },
  go: { language: 'go', version: '1.16.2' },
  java: { language: 'java', version: '15.0.2' },
  csharp: { language: 'csharp', version: '6.12.0' },
  cs: { language: 'csharp', version: '6.12.0' },
  bash: { language: 'bash', version: '5.2.0' },
  sh: { language: 'bash', version: '5.2.0' },
  lua: { language: 'lua', version: '5.4.4' }
};

const FILE_EXT = {
  python: 'py', javascript: 'js', typescript: 'ts', c: 'c', 'c++': 'cpp',
  rust: 'rs', go: 'go', java: 'java', csharp: 'cs', bash: 'sh', lua: 'lua'
};

async function runViaPiston(lang, code) {
  const cfg = PISTON_LANGS[(lang || '').toLowerCase()] || PISTON_LANGS.python;
  const ext = FILE_EXT[cfg.language] || 'txt';
  const res = await fetch('https://emkc.org/api/v2/piston/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      language: cfg.language,
      version: cfg.version,
      files: [{ name: 'main.' + ext, content: code }]
    })
  });
  if (!res.ok) throw new Error('Piston error: ' + res.status);
  return res.json();
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
