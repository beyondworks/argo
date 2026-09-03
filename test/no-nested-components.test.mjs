// 컴포넌트 안에서 정의한 컴포넌트 금지 — 렌더마다 새 타입이 되어 React가 하위 DOM을 통째로 재마운트한다
// (실사고 2026-09-03: 설정 회사 정보 카드의 휴대폰 구획 래퍼 `const Wrap = embedded ? ({children}) => <div…` → 주소
// 드롭다운이 닫히고 드래그 선택이 풀림 — 빌드·lint·육안 어디에도 안 걸린다).
// 판정은 AST(espree)로 한다 — 줄 정규식은 원본 결함의 여러 줄 삼항을 통과시켰다(분리 검수 HIGH-1, 21형태 중 11 미탐).
// 규칙: 함수 본문 안(스코프 깊이 ≥1)에서 선언된 대문자 이름이 ① JSX를 반환하는 함수/화살표/삼항/호출 인자를 초기값으로 갖거나
//      ② 클래스이거나 ③ 같은 파일에서 JSX 태그(<Name …>)로 쓰이면(팩토리 호출 `const Wrap = make(x)` 포함) red.
//      문자열 헬퍼(`const L = (href) => withSide(...)`)·모듈 수준 정의·상수 선택(`const Wrap = a ? A : B`, A·B 식별자)은 통과.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';

const APP = fileURLToPath(new URL('../app', import.meta.url));
const walkDir = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walkDir(p) : [p]; });
const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function* nodes(n) { // 전 노드 순회(부모→자식)
  if (!n || typeof n.type !== 'string') return;
  yield n;
  for (const k of Object.keys(n)) {
    if (k === 'parent' || k === 'loc' || k === 'range') continue;
    const v = n[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') yield* nodes(c); }
    else if (v && typeof v.type === 'string') yield* nodes(v);
  }
}
const hasJsx = (n) => { for (const x of nodes(n)) if (x.type === 'JSXElement' || x.type === 'JSXFragment') return true; return false; };
const jsxTags = (ast) => { const s = new Set(); for (const x of nodes(ast)) if (x.type === 'JSXOpeningElement' && x.name.type === 'JSXIdentifier') s.add(x.name.name); return s; };
/** 초기화식이 "컴포넌트를 만든다"고 볼 수 있는가 — JSX를 품은 함수, 그런 함수를 고르는 삼항, 그런 함수를 인자로 받는 호출(memo·forwardRef…), 클래스 */
function makesComponent(init) {
  if (!init) return false;
  if (FN.has(init.type)) return hasJsx(init);
  if (init.type === 'ClassExpression') return true;
  if (init.type === 'ConditionalExpression') return makesComponent(init.consequent) || makesComponent(init.alternate);
  if (init.type === 'LogicalExpression') return makesComponent(init.left) || makesComponent(init.right);
  // 호출은 HOC 화이트리스트만 — 일반 호출(items.map(x => <li/>) 등)까지 보면 대문자 배열 변수가 오탐(검수 권고)
  if (init.type === 'CallExpression' && isHoc(init.callee)) return init.arguments.some((a) => makesComponent(a));
  return false;
}
const HOC = new Set(['memo', 'forwardRef', 'lazy']);
const isHoc = (c) => (c.type === 'Identifier' && HOC.has(c.name)) || (c.type === 'MemberExpression' && c.property.type === 'Identifier' && HOC.has(c.property.name));
/** 파일의 위반 목록 — [{name, line}] */
export function nestedComponents(src) {
  const ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, loc: true });
  const tags = jsxTags(ast);
  const hits = [];
  const visit = (n, depth) => {
    if (!n || typeof n.type !== 'string') return;
    if (depth >= 1) {
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && /^[A-Z]/.test(n.id.name)) {
        const byInit = makesComponent(n.init);
        // 초기값이 호출(팩토리)·함수(헬퍼 위임, JSX 없음)라도 같은 파일에서 <Name>으로 쓰이면 컴포넌트다
        const byUsedAsTag = (n.init?.type === 'CallExpression' || FN.has(n.init?.type)) && tags.has(n.id.name);
        if (byInit || byUsedAsTag || (n.init?.type === 'ClassExpression')) hits.push({ name: n.id.name, line: n.loc.start.line });
      }
      if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id && /^[A-Z]/.test(n.id.name) && (n.type === 'ClassDeclaration' || hasJsx(n) || tags.has(n.id.name))) {
        hits.push({ name: n.id.name, line: n.loc.start.line });
      }
      // 재할당 형태(`let Wrap; if (e) Wrap = ({c}) => <div/>`) — 원본 결함의 if 버전(검수 권고)
      if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && /^[A-Z]/.test(n.left.name)
        && (makesComponent(n.right) || ((n.right.type === 'CallExpression' || FN.has(n.right.type)) && tags.has(n.left.name)))) {
        hits.push({ name: n.left.name, line: n.loc.start.line });
      }
    }
    const inner = FN.has(n.type) ? depth + 1 : depth;
    for (const k of Object.keys(n)) {
      if (k === 'parent' || k === 'loc' || k === 'range') continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c, inner); }
      else if (v && typeof v.type === 'string') visit(v, inner);
    }
  };
  visit(ast, 0);
  return hits;
}

test('app/**/*.jsx — 함수 본문 안에서 JSX 컴포넌트를 정의하지 않는다(재마운트 결함, AST 판정)', () => {
  const hits = [];
  for (const f of walkDir(APP).filter((x) => /\.jsx?$/.test(x))) { // Next는 .js에도 JSX 허용
    for (const h of nestedComponents(readFileSync(f, 'utf8'))) hits.push(`${f.slice(APP.length + 1)}:${h.line} ${h.name}`);
  }
  assert.deepEqual(hits, [], '컴포넌트 안 컴포넌트 정의 — 모듈 수준으로 올릴 것');
});

// 판정기 자체의 게이트 — 원본 결함(1112f1d의 여러 줄 삼항) + 검수가 제시한 회피 11형태는 red, 정상 3형태는 green.
test('판정기 — 원본 결함·회피 형태 red, 정상 형태 green', () => {
  const wrap = (body) => `export function Card({ embedded }) {\n${body}\n  return <Wrap><div /></Wrap>;\n}`;
  const RED = {
    '원본 여러 줄 삼항(1112f1d)': `  const Wrap = embedded\n    ? ({ children }) => <div style={{ display: 'flex' }}>{children}</div>\n    : ({ children }) => <div className="card">{children}</div>;`,
    '한 줄 화살표': `  const Wrap = ({ children }) => <div>{children}</div>;`,
    '블록 본문 return': `  const Wrap = ({ children }) => { return <div>{children}</div>; };`,
    '기본값 매개변수': `  const Wrap = ({ children, gap = 12 }) => <div style={{ gap }}>{children}</div>;`,
    '개행 후 JSX': `  const Wrap = ({ children }) =>\n    <div>{children}</div>;`,
    '익명 function 표현식': `  const Wrap = function () { return <div />; };`,
    'memo + 기본값': `  const Wrap = memo(({ children, gap = 0 }) => <div style={{ gap }}>{children}</div>);`,
    'forwardRef': `  const Wrap = forwardRef((p, ref) => <div ref={ref} />);`,
    '클래스 표현식': `  const Wrap = class extends Component { render() { return <div />; } };`,
    '팩토리 호출을 태그로': `  const Wrap = makeWrap(embedded);`,
    '중첩 function 선언': `  function Wrap({ children }) { return <div>{children}</div>; }`,
    '헬퍼 위임 화살표(JSX 태그로 씀)': `  const Wrap = ({ children }) => renderWrap(children);`,
    'if 재할당(원본의 사촌)': `  let Wrap; if (embedded) Wrap = ({ children }) => <div>{children}</div>; else Wrap = CardWrap;`,
  };
  for (const [name, body] of Object.entries(RED)) assert.ok(nestedComponents(wrap(body)).length > 0, `red 기대: ${name}`);
  const GREEN = {
    '문자열 헬퍼(태그로 안 씀)': `export function Shell() {\n  const L = (href) => withSide(href, 'x');\n  return <a href={L('/a')} />;\n}`,
    '모듈 수준 정의': `const Wrap = ({ children }) => <div>{children}</div>;\nexport function Card() { return <Wrap><div /></Wrap>; }`,
    '상수 선택(식별자 삼항)': `const A = () => <div />; const B = () => <span />;\nexport function Card({ e }) {\n  const Wrap = e ? A : B;\n  return <Wrap />;\n}`,
    '훅 호출 결과(태그 아님)': `export function Card() {\n  const State = useState(0);\n  return <div>{State[0]}</div>;\n}`,
    '대문자 배열 변수 map(JSX 목록, 태그 아님)': `export function List({ items }) {\n  const Rows = items.map((x) => <li key={x}>{x}</li>);\n  return <ul>{Rows}</ul>;\n}`,
  };
  for (const [name, src] of Object.entries(GREEN)) assert.deepEqual(nestedComponents(src), [], `green 기대: ${name}`);
});
