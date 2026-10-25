// 단일 dist/index.html 빌드. 외부 의존성·CDN 없음(node 내장 모듈만).
// ESM 소스를 모듈별 함수 스코프로 묶어 inline <script type="module">에 넣고,
// optimizer.worker.js가 있으면 같은 방식으로 묶어 문자열로 넣는다(ui.js가 Blob URL worker로 실행).
// 사용: node build.mjs   → dist/index.html, dist/snapshot.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src'), DIST = join(ROOT, 'dist');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const IMPORT_RE = /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"](\.{1,2}\/[^'"]+)['"];?[ \t]*$/gm;
const BARE_IMPORT_RE = /^[ \t]*import\s+['"](\.{1,2}\/[^'"]+)['"];?[ \t]*$/gm;
const REEXPORT_RE = /^[ \t]*export\s+\{([^}]*)\}\s+from\s+['"](\.{1,2}\/[^'"]+)['"];?[ \t]*$/gm;

/** import 절 → 구조분해 패턴. {a, b as c} / * as X / default 금지. */
function bindingFor(clause, id) {
  const ref = `__mods[${JSON.stringify(id)}]`;
  const ns = clause.match(/^\*\s+as\s+(\w+)$/);
  if (ns) return `const ${ns[1]} = ${ref};`;
  const named = clause.match(/^\{([\s\S]*)\}$/);
  if (!named) throw new Error(`지원하지 않는 import 형식(${id}): ${clause}`);
  const parts = named[1].split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const m = s.match(/^(\w+)(?:\s+as\s+(\w+))?$/); if (!m) throw new Error(`import 이름 오류: ${s}`); return m[2] ? `${m[1]}: ${m[2]}` : m[1]; });
  return `const { ${parts.join(', ')} } = ${ref};`;
}

/** 진입점부터 의존 순서대로 모듈을 모아 하나의 스크립트 본문을 만든다. */
export function bundle(entryAbs) {
  const order = [], seen = new Set(), stack = new Set();
  const idOf = (abs) => relative(SRC, abs).split('\\').join('/');
  const visit = (abs) => {
    if (seen.has(abs)) return;
    if (stack.has(abs)) throw new Error(`순환 import: ${idOf(abs)}`);
    if (!existsSync(abs)) throw new Error(`모듈 없음: ${idOf(abs)}`);
    stack.add(abs);
    const code = readFileSync(abs, 'utf8');
    const deps = [];
    for (const re of [IMPORT_RE, BARE_IMPORT_RE, REEXPORT_RE]) {
      re.lastIndex = 0;
      for (const m of code.matchAll(re)) deps.push(resolve(dirname(abs), re === IMPORT_RE || re === REEXPORT_RE ? m[2] : m[1]));
    }
    deps.forEach(visit);
    stack.delete(abs); seen.add(abs);
    order.push({ abs, id: idOf(abs), code });
  };
  visit(entryAbs);

  const parts = order.map(({ abs, id, code }) => {
    const exportsList = [];
    const rel = (spec) => idOf(resolve(dirname(abs), spec));
    if (/^\s*export\s+default\b/m.test(code)) throw new Error(`export default 미지원: ${id}`);
    let out = code
      .replace(REEXPORT_RE, (_, names, spec) => names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
        const [a, b = a] = s.split(/\s+as\s+/); exportsList.push(b);
        return `const ${b} = __mods[${JSON.stringify(rel(spec))}].${a};`;
      }).join(' '))
      .replace(IMPORT_RE, (_, clause, spec) => bindingFor(clause.trim(), rel(spec)))
      .replace(BARE_IMPORT_RE, '')
      .replace(/^([ \t]*)export\s+((?:async\s+)?function\*?|const|let|var|class)\s+(\w+)/gm, (_, ind, kw, name) => { exportsList.push(name); return `${ind}${kw} ${name}`; })
      .replace(/^[ \t]*export\s+\{([^}]*)\};?[ \t]*$/gm, (_, names) => { names.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => { const [a, b = a] = s.split(/\s+as\s+/); exportsList.push(b === a ? a : `${b}: ${a}`); }); return ''; });
    if (/^\s*export\s/m.test(out)) throw new Error(`변환하지 못한 export 구문: ${id}`);
    return `// ---- ${id} ----\n__mods[${JSON.stringify(id)}] = (() => {\n${out}\nreturn { ${exportsList.join(', ')} };\n})();`;
  });
  return { code: `const __mods = Object.create(null);\n${parts.join('\n')}\n`, modules: order.map((m) => m.id) };
}

const inlineSafe = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

export function build() {
  let html = readFileSync(join(SRC, 'index.html'), 'utf8');
  const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
  // Embed the approved official symbol for both header and favicon, preserving single-file portability.
  for (const [name, mime] of [['symbol-anubis.webp', 'image/webp']]) {
    const uri = `data:${mime};base64,${readFileSync(join(SRC, 'assets/brand', name)).toString('base64')}`;
    html = html.replaceAll(`./assets/brand/${name}`, uri);
  }
  const app = bundle(join(SRC, 'ui.js'));

  const workerPath = join(SRC, 'optimizer.worker.js');
  let workerSrc = null, workerModules = [];
  if (existsSync(workerPath)) {
    const w = bundle(workerPath);
    workerSrc = `(() => {\n${w.code}\n})();`;
    workerModules = w.modules;
  }

  const snapPath = join(ROOT, 'evidence', 'snapshot.json');
  const snapText = existsSync(snapPath) ? readFileSync(snapPath, 'utf8') : null;
  if (snapText) JSON.parse(snapText); // 형식 오류면 빌드 실패

  const cssTag = '<link rel="stylesheet" href="./styles.css">';
  const jsTag = '<script type="module" src="./ui.js"></script>';
  if (!html.includes(cssTag) || !html.includes(jsTag)) throw new Error('index.html의 styles.css/ui.js 태그를 찾지 못함');
  html = html.replace(cssTag, () => `<style>\n${css}</style>`);
  html = html.replace(jsTag, () => [
    snapText ? `<script type="application/json" id="snapshot-data">${snapText.replace(/<\//g, '<\\/')}</script>` : '',
    `<script>globalThis.__HELIX_WORKER_SRC__ = ${inlineSafe(JSON.stringify(workerSrc))};</script>`,
    `<script type="module">\n${inlineSafe(app.code)}</script>`,
  ].filter(Boolean).join('\n'));

  // 외부 리소스 금지 검사(CDN·원격 스크립트/스타일/폰트).
  const external = html.match(/<(script|link|img|iframe)\b[^>]*(src|href)=["']?(https?:)?\/\//gi) || html.match(/@import\s+url\(\s*['"]?https?:/gi);
  if (external) throw new Error(`외부 리소스 참조 발견: ${external[0]}`);

  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, 'index.html'), html);
  if (snapText) writeFileSync(join(DIST, 'snapshot.json'), snapText);
  return {
    modules: app.modules, workerModules, worker: workerSrc !== null,
    bytes: Buffer.byteLength(html), indexSha256: sha256(html), snapshotSha256: snapText ? sha256(snapText) : null,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = build();
  console.log(`dist/index.html ${r.bytes} bytes sha256 ${r.indexSha256}`);
  console.log(`modules: ${r.modules.join(', ')}`);
  console.log(r.worker ? `worker: ${r.workerModules.join(', ')}` : 'worker: 없음(optimizer.worker.js 미존재 → 최적화 버튼은 미포함 안내)');
  if (r.snapshotSha256) console.log(`snapshot.json sha256 ${r.snapshotSha256}`);
}
