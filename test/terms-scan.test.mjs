// 용어 스캔 — 사용자에게 보이는 글자에 옛 낱말('크루'·'사장'·'선장', crew·captain·boss)과 조사 오류가 남았는지 센다.
// 계획: artifacts/rc-0195/terminology-plan.md 2-4절(패턴)·6-4절(검사 대상). 지금(T0)은 **남은 개수만 출력하고 실패시키지 않는다**.
// 마지막 단위(T6)에서 ENFORCE를 true로 바꿔 0건을 강제한다(허용 목록 밖 0건).
// 주석은 보지 않는다(acorn으로 문자열·템플릿·JSX 글자만 꺼낸다). src/legacy-terms.mjs(옛 표지 목록)는 검사에서 뺀다.
// acorn·acorn-jsx는 루트 node_modules에 있다(Next 의존). T6에서 devDependencies로 선언한다(계획 6-4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import jsx from 'acorn-jsx';

const ENFORCE = false; // T6에서 true — 그때부터 남은 개수가 0이 아니면 빨강
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const JSX_PARSER = acorn.Parser.extend(jsx());

/** 금지 패턴(계획 2-4). 이름 → 정규식 */
export const PATTERNS = {
  'ko 옛 낱말': /크루|사장|선장/,
  '조사 오류(사용자+은/을/과/으로)': /사용자(은|을|과|으로)(?![가-힣])/,
  '조사 오류(사용자이)': /사용자이(?=[\s,.)])/,
  'en 옛 낱말': /\b(crews?|captain|boss)\b/i,
  'en 관사(a agent)': /\ba agent/i,
  'en 관사(an user)': /\ban user\b/i,
  '겹침(에이전트(에이전트|크루))': /에이전트\((에이전트|크루)\)/,
};

/** 허용 목록 — 파일(ROOT 기준 경로, '/' 구분)과 문자열을 정확히 적고 항목마다 이유를 쓴다. 예:
    { file: 'src/memory.mjs', text: 'notes/사장-프로필.md', why: '기억 파일 경로 유지(계획 8절 질문 2)' } */
export const ALLOW = [];

const EXCLUDE = new Set(['src/legacy-terms.mjs']); // 옛 표지 목록 — 옛 낱말이 있는 것이 정상

// ── 검사 대상 ──
function walk(dir, ok) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ok)); else if (ok(p)) out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p).split(sep).join('/');
const isCode = (p) => /\.(mjs|js|jsx)$/.test(p) && !/\.test\.(mjs|js)$/.test(p);
function targets() {
  const code = [
    ...walk(join(ROOT, 'app'), isCode),
    ...walk(join(ROOT, 'src'), isCode),
    join(ROOT, 'bin', 'argo.mjs'),
    ...walk(join(ROOT, 'landing', 'app'), isCode), join(ROOT, 'landing', 'lib', 'i18n.jsx'),
    ...walk(join(ROOT, 'apps', 'office', 'src'), (p) => /-i18n\.js$|[\\/]i18n\.(js|jsx|mjs)$/.test(p)),
  ].filter((p) => existsSync(p) && !EXCLUDE.has(rel(p)));
  const docs = ['README.md', 'SECURITY.md', 'docs/selfhost.md', 'docs/privacy-sync.md', 'docs/routine-notifications.md',
    ...walk(join(ROOT, 'integrations'), (p) => p.endsWith('README.md')).map(rel)].map((f) => join(ROOT, f)).filter(existsSync);
  return { code, docs };
}

/** 작업 단위(계획 6-1 표) — 남은 개수를 누가 지울지 */
export function unitOf(file) {
  if (file.startsWith('app/')) return 'T1 본체 화면';
  if (/^src\/(gateway\.mjs|gateway\/|connectors\.mjs|permission-gate\.mjs|routines\.mjs|runners|runner-denial\.mjs|connections\.mjs|msgr-notify\.mjs)/.test(file)) return 'T2b 게이트웨이·연결';
  if (file.startsWith('src/') || file === 'bin/argo.mjs') return 'T2a 지시문·엔진';
  if (file.startsWith('landing/') || file.endsWith('.md')) return 'T4 랜딩·문서';
  if (file.startsWith('apps/office/')) return '오피스';
  return '기타';
}

// ── 글자 꺼내기 ──
const DICT_FILES = /^(app\/i18n\.jsx|app\/apimsg\.mjs|landing\/lib\/i18n\.jsx|apps\/office\/src\/.*i18n\.js)$/;
/** 코드 값(공백·한글이 없고 소문자로 시작하는 낱말 — 'crew'·'captain' 같은 키·역할 값)은 뺀다. 사전 파일은 값 전부가 화면 글자다 */
const visible = (s, dict) => dict ? s.trim() !== '' : /\s|[가-힣]|^[A-Z]/.test(s);

/** JS/JSX 원문 → 보이는 글자 목록 [{ text, line }] (주석·import 경로·객체 키·정규식은 뺀다) */
export function stringsOf(src, file = '') {
  const dict = DICT_FILES.test(file);
  const ast = JSX_PARSER.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  const out = [];
  const add = (text, node) => { if (typeof text === 'string' && visible(text, dict)) out.push({ text, line: node.loc.start.line }); };
  (function visit(node, parent, key) {
    if (!node || typeof node.type !== 'string') return;
    if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) { visit(node.declaration, node, 'declaration'); for (const s of node.specifiers ?? []) visit(s, node, 'specifiers'); return; }
    if (node.type === 'ImportExpression') return;
    if (node.type === 'Literal') {
      if (node.regex) return;
      if (parent?.type === 'Property' && key === 'key' && !parent.computed) return; // 객체 키
      if (parent?.type === 'MemberExpression' && key === 'property') return;
      if (parent?.type === 'JSXAttribute' && key === 'name') return;
      add(node.value, node); return;
    }
    if (node.type === 'TemplateElement') { add(node.value.cooked, node); return; }
    if (node.type === 'JSXText') { const t = node.value.replace(/\s+/g, ' ').trim(); if (t) out.push({ text: t, line: node.loc.start.line }); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      if (Array.isArray(v)) for (const c of v) visit(c, node, k); else if (v && typeof v === 'object') visit(v, node, k);
    }
  })(ast, null, null);
  return out;
}

/** 마크다운 → 코드 구간(``` 블록·`인라인`)을 뺀 줄 [{ text, line }] */
export function mdLinesOf(src) {
  const out = []; let fence = false;
  src.split('\n').forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (!fence) out.push({ text: l.replace(/`[^`]*`/g, ''), line: i + 1 });
  });
  return out;
}

/** 한 파일의 걸린 글자 → [{ file, line, pattern, text }] */
export function hitsOf(file, items) {
  const hits = [];
  for (const { text, line } of items) {
    if (ALLOW.some((a) => a.file === file && text.includes(a.text))) continue;
    const bare = text.replace(/\{\w+\}/g, '').replace(/\S*\/\S*/g, ''); // 자리표시({crew})·경로(agents/<slug>.md, tabs/crew-ko.mp4)는 코드 이름이라 뺀다(계획 7절)
    for (const [pattern, re] of Object.entries(PATTERNS)) if (re.test(bare)) hits.push({ file, line, pattern, text: text.length > 90 ? `${text.slice(0, 90)}…` : text });
  }
  return hits;
}

test('스캐너 자체 — 문자열·템플릿·JSX 글자는 잡고, 주석·키·import 경로·코드 값은 뺀다', () => {
  const src = `// 크루 주석은 안 본다\nimport x from './크루.mjs';\nconst a = { 크루: 1, role: 'crew' };\nconst b = '크루가 답합니다';\nconst c = \`\${n} crew members\`;\nconst d = () => <p title="Captain">사장 화면</p>;\nconst e = /크루/;\nconst f = '사용자을 부른다';\n`;
  const items = stringsOf(src, 'app/x.jsx');
  const hits = hitsOf('app/x.jsx', items).map((h) => `${h.line}:${h.pattern}`);
  assert.deepEqual(hits.sort(), ['4:ko 옛 낱말', '5:en 옛 낱말', '6:en 옛 낱말', '6:ko 옛 낱말', '8:조사 오류(사용자+은/을/과/으로)'].sort());
  assert.deepEqual(mdLinesOf('크루 글\n```\n크루 코드\n```\n`crew` 인라인과 captain').map((l) => l.text), ['크루 글', ' 인라인과 captain']);
  assert.equal(unitOf('src/gateway/msgr.mjs'), 'T2b 게이트웨이·연결');
  assert.equal(unitOf('src/chat.mjs'), 'T2a 지시문·엔진');
});

test('용어 스캔 — 남은 옛 낱말 개수(단위별). T0에서는 출력만 하고, T6에서 0건 강제', () => {
  const { code, docs } = targets();
  const hits = [];
  for (const p of code) {
    const file = rel(p);
    let items;
    try { items = stringsOf(readFileSync(p, 'utf8'), file); } catch (e) { assert.fail(`${file}: 파싱 실패 — ${e.message}`); }
    hits.push(...hitsOf(file, items));
  }
  for (const p of docs) hits.push(...hitsOf(rel(p), mdLinesOf(readFileSync(p, 'utf8'))));
  const byUnit = {}; const byPattern = {}; const byFile = {};
  for (const h of hits) {
    const u = unitOf(h.file);
    byUnit[u] = (byUnit[u] ?? 0) + 1; byPattern[h.pattern] = (byPattern[h.pattern] ?? 0) + 1; byFile[h.file] = (byFile[h.file] ?? 0) + 1;
  }
  const lines = [`[terms-scan] 검사 파일 ${code.length + docs.length}개 · 남은 글자 ${hits.length}건`,
    ...Object.entries(byUnit).sort((a, b) => b[1] - a[1]).map(([u, n]) => `  단위 ${u}: ${n}`),
    ...Object.entries(byPattern).sort((a, b) => b[1] - a[1]).map(([p, n]) => `  패턴 ${p}: ${n}`),
    '  파일 상위 15:', ...Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, n]) => `    ${String(n).padStart(4)}  ${f}`)];
  console.log(lines.join('\n'));
  if (ENFORCE) assert.deepEqual(hits, [], '허용 목록 밖 옛 낱말이 남았다');
});
