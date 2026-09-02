// 사이드바 크루 상태 표지 배선 핀 (2026-09-02 유건 요청 — "크루 목록에서 상태별로 알아볼 수 있게").
//
// 표지 셋은 **자리가 다르다**: 아바타를 두르는 링 = 답변 작성 중(은은한 점멸) · 아바타 모서리 점 = 텔레그램
// 직통 봇(연결/수신 중 아님) · 이름 옆 점 = 답변 도착(안읽음, 열어 보면 소거). 원천은 셋 다 서버 사실이다 —
// 작성 중은 크루별 chats/<slug>.status.json(2분 신선도, /tasks running), 텔레그램은 폴러 하트비트(alive),
// 안읽음은 chats/<slug>.json mtime(chatTs) vs 로컬 확인 기준선(seen).
//
// 잠그는 것(변이 red 실증 — 각 단언은 그 결함 하나를 잡는다):
//  ① 단일 폴 — /tasks 호출부는 파일에 **정확히 하나**, Shell 안(작업 독이 자체 폴을 되살리면 배지와 행 점멸이
//     서로 다른 시점의 진실을 보고 어긋난다 = 이 변경이 없애려는 결함).
//  ② busy 배선 — running 목록 → busySet → 행의 busy → 링 렌더(busy && …) + 안읽음의 !busy 가드.
//  ③ 턴 종료 즉시성 — running에서 빠진 크루가 있으면 light 재조회를 당긴다(30초 폴 대기 제거) + argo:refresh 연결
//     + 도는 턴이 있으면 3.5초 폴(끝난 뒤 최대 3.5초 안에 점멸이 꺼진다).
//  ④ 링 CSS — 투명도만(opacity), ease-in-out 왕복, 숨쉬는 박자(1.2~2.4초), 바닥 0.3~0.6(꺼지지 않는 '은은'),
//     기본 상태에 opacity 선언 없음(동작 줄이기에서 전역 규칙이 반복을 1로 자르면 **불투명 링으로 정지** — 표지는
//     남는다), 활성 행(프라이머리 배경)은 온-프라이머리 전경색으로 대비.
//  ⑤ 텔레그램 툴팁 — alive 여부로 문구가 갈린다(종전엔 경고색 점에도 "연결됨"을 띄웠다).
// 한계(정직 표기): 소스 수준 핀이라 실제 렌더·타이밍은 못 본다 — 그건 PR의 격리 서버 실측(상태 파일 손수 생성 →
// 라이트/다크 스크린샷·DOM 단언·전환 시간)이 담당한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// 주석 제거(줄 구조 보존) — topbar-phone-policy.test.mjs와 동일 방식. 주석 속 셀렉터·표현식이 단언에 잡히지 않게.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));
const layout = stripComments(readFileSync(join(ROOT, 'app/c/[ws]/layout.jsx'), 'utf8'));
const css = stripComments(readFileSync(join(ROOT, 'app/globals.css'), 'utf8'));

const idx = (re, src = layout) => { const m = re.exec(src); assert.ok(m, `없음: ${re}`); return m.index; };
const SHELL = idx(/\nfunction Shell\(/);
const DOCK = idx(/\nfunction TasksDock\(/);
assert.ok(DOCK < SHELL, 'TasksDock이 Shell 앞에 정의된다는 전제(구간 판정 기준)');

test('① /tasks 폴은 파일에 하나뿐이고 Shell 안에 있다 — 작업 독은 데이터·열림 상태를 props로 받는다', () => {
  const calls = [...layout.matchAll(/api\(`\/api\/companies\/\$\{ws\}\/tasks`\)/g)].map((m) => m.index);
  assert.equal(calls.length, 1, '/tasks 호출부는 정확히 하나(둘이면 배지와 행 점멸이 다른 시점의 진실을 본다)');
  assert.ok(calls[0] > SHELL, '/tasks 폴은 Shell(사이드바를 그리는 쪽)이 쥔다');
  assert.match(layout, /\nfunction TasksDock\(\{ ws, data, open, setOpen \}\)/, '작업 독은 running/recent와 열림 상태를 부모에게 받는다');
  assert.match(layout, /<TasksDock ws=\{ws\} data=\{tasks\} open=\{dockOpen\} setOpen=\{setDockOpen\} \/>/, '작업 독 호출부가 같은 tasks 상태를 넘긴다');
});

test('② running → busySet → 행 busy → 링 렌더 + 안읽음 !busy 가드 (크루 행 구간 안)', () => {
  assert.match(layout, /const busySet = new Set\(\(tasks\?\.running \?\? \[\]\)\.map\(\(r\) => r\.slug\)\);/, 'busySet은 /tasks running의 slug 집합');
  const rowStart = idx(/list\.map\(\(a\) => \{/);
  const rowEnd = idx(/\{t\('nav\.hire'\)\}/);
  const row = layout.slice(rowStart, rowEnd);
  assert.match(row, /const busy = busySet\.has\(a\.slug\);/, '행의 busy는 busySet 조회');
  assert.match(row, /const unread = !active && !busy && a\.chatTs != null && seen\?\.\[a\.slug\] !== undefined && a\.chatTs > seen\[a\.slug\];/,
    '안읽음은 작성 중이면 숨긴다(그 사이 갱신은 방금 들어온 지시 — 답변 도착이 아니다)');
  assert.match(row, /\{busy && <span className="crew-writing" role="img" aria-label=\{t\('nav\.writing'\)\} \/>\}/,
    '링은 busy에만 렌더, 접근성 라벨은 사전 경유');
  assert.match(row, /<span title=\{busy \? t\('nav\.writing'\) : undefined\} style=\{\{ position: 'relative', display: 'inline-flex', flex: 'none' \}\}>/,
    '아바타 래퍼 툴팁 — 작성 중일 때만');
});

test('③ 턴 종료 즉시성 — running에서 빠지면 light 재조회, argo:refresh 연결, 도는 턴 있으면 3.5초 폴', () => {
  const effStart = idx(/const runningRef = useRef\(new Set\(\)\);/);
  const effEnd = idx(/const busySet = new Set/);
  const eff = layout.slice(effStart, effEnd);
  assert.match(eff, /const now = new Set\(\(d\.running \?\? \[\]\)\.map\(\(r\) => r\.slug\)\);\s*if \(\[\.\.\.runningRef\.current\]\.some\(\(s\) => !now\.has\(s\)\)\) refresh\(\);\s*runningRef\.current = now;\s*setTasks\(d\);/,
    '이전 running에 있던 크루가 지금 없으면 refresh() — 그 다음 runningRef 갱신·setTasks 순서');
  assert.match(eff, /window\.addEventListener\('argo:refresh', pull\);/, 'argo:refresh(크루 페이지 턴 종료 등)에 즉시 당긴다');
  assert.match(eff, /window\.removeEventListener\('argo:refresh', pull\);/, '해제도 짝으로');
  assert.match(eff, /setInterval\(pull, dockOpen \|\| anyRunning \? 3500 : 10000\)/, '도는 턴·독 열림이면 3.5초, 아니면 10초');
  assert.match(layout, /const anyRunning = \(tasks\?\.running\?\.length \?\? 0\) > 0;/, 'anyRunning은 running 개수에서');
  assert.match(eff, /\}, \[ws, dockOpen, anyRunning, refresh\]\);/, '효과 deps — anyRunning 전환이 폴 주기를 바꾼다');
});

const ruleBody = (sel) => {
  // 정확 일치 셀렉터의 선언 블록 — 부분 매칭은 fail-open(topbar-phone-policy 교훈).
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((r) => r[1].split(',').some((s) => s.replace(/\s+/g, ' ').trim() === sel));
  assert.equal(rules.length, 1, `규칙 ${sel}은 정확히 하나`);
  return rules[0][2];
};
const decl = (body, prop) => { const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;}]+)`).exec(body); return m?.[1].trim(); };

test('④ 링 CSS — 투명도만 숨쉬는 ease-in-out 왕복, 은은한 바닥, 활성 행 대비, 동작 줄이기 시 불투명 정지', () => {
  const ring = ruleBody('.crew-writing');
  assert.equal(decl(ring, 'position'), 'absolute');
  assert.equal(decl(ring, 'pointer-events'), 'none', '링이 아바타 클릭·툴팁을 가로채지 않는다');
  assert.match(decl(ring, 'border') ?? '', /var\(--accent\)/, "'진행 중' 계열 토큰(작업 독 배지·스피너와 동일)");
  const anim = decl(ring, 'animation') ?? '';
  const m = /^crewPulse\s+(\d+(?:\.\d+)?)s\s+ease-in-out\s+infinite$/.exec(anim);
  assert.ok(m, `animation은 'crewPulse <초>s ease-in-out infinite' 형태여야 한다(실제: '${anim}') — ease-in/out 편도는 왕복 루프에서 툭툭 끊긴다`);
  assert.ok(Number(m[1]) >= 1.2 && Number(m[1]) <= 2.4, `숨쉬는 박자 1.2~2.4초(실제 ${m[1]}s) — 짧으면 깜빡임, 길면 죽은 표지`);
  assert.equal(decl(ring, 'opacity'), undefined, '기본 상태엔 opacity 선언이 없어야 동작 줄이기에서 불투명 링으로 정지한다');
  // 정거장 반복(`k { … }`)을 통째로 잡는다 — 게으른 [\s\S]*?는 마지막 정거장의 닫는 괄호를 삼켜 50%를 놓쳤다(1차 red 실측).
  const kf = /@keyframes crewPulse\s*\{((?:\s*[^{}]+\{[^{}]*\})+)\s*\}/.exec(css);
  assert.ok(kf, '@keyframes crewPulse');
  const stops = [...kf[1].matchAll(/([\d%, ]+)\{\s*opacity:\s*([\d.]+);?\s*\}/g)].map((s) => [s[1].replace(/\s/g, ''), Number(s[2])]);
  assert.deepEqual(stops.map(([k]) => k), ['0%,100%', '50%'], '양 끝(0/100%)과 중간(50%) 두 정거장 — opacity 외 속성 없음');
  assert.equal(stops[0][1], 1, '양 끝은 불투명(기본 상태와 같아 루프 이음새가 없다)');
  assert.ok(stops[1][1] >= 0.3 && stops[1][1] <= 0.6, `바닥은 0.3~0.6(실제 ${stops[1][1]}) — 0에 닿으면 점멸, 0.6 위면 안 보인다`);
  assert.equal(decl(ruleBody('.nav-item.active .crew-writing'), 'border-color'), 'var(--primary-fg)', '활성 행(프라이머리 배경) 대비 — 핀 버튼과 같은 규칙');
  // 동작 줄이기 — 전역 규칙이 반복 횟수를 1로 잘라야 무한 루프가 실제로 멈춘다(지속시간만 줄이면 스트로브).
  const rm = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(rm, 'prefers-reduced-motion 블록');
  assert.match(rm[1], /\*, \*::before, \*::after \{[^}]*animation-iteration-count: 1 !important/, '전역 반복 1회 — 링 점멸도 이 규칙으로 정지');
});

test('⑤ 텔레그램 점 툴팁은 alive로 갈린다 — 경고색 점에 "연결됨"을 띄우지 않는다', () => {
  assert.match(layout, /<span role="img" title=\{tgAgents\[a\.slug\] \? t\('nav\.tgConnected'\) : t\('nav\.tgIdle'\)\} aria-label=\{tgAgents\[a\.slug\] \? t\('nav\.tgConnected'\) : t\('nav\.tgIdle'\)\}/);
  assert.match(layout, /background: tgAgents\[a\.slug\] \? 'var\(--ok\)' : 'var\(--warn\)'/, '색 분기와 같은 조건(alive)');
});

// ⑥ 데크 크루 카드 정합 — 카드가 "전원 대기 중"을 항상 띄우는 동안 사이드바는 링이 켜지던 불일치(2026-09-02 실측).
// 셸이 쥔 tasks를 컨텍스트(app/c/[ws]/tasks-context.js)로 내려 데크가 같은 running 목록을 읽는다. 데크에 /tasks
// 자체 폴이 생기면 셋(링·배지·카드)이 다른 시점의 진실을 본다 — 호출부 0건을 잠근다.
const deck = stripComments(readFileSync(join(ROOT, 'app/c/[ws]/page.jsx'), 'utf8'));
const ctx = stripComments(readFileSync(join(ROOT, 'app/c/[ws]/tasks-context.js'), 'utf8'));
test('⑥ 데크 크루 카드는 셸의 tasks 컨텍스트로 작성 중 수를 그린다 — 자체 /tasks 폴 없음', () => {
  assert.match(ctx, /export const TasksContext = createContext\(null\);/);
  assert.match(ctx, /export const useTasks = \(\) => useContext\(TasksContext\);/);
  // 셸: Provider가 셸 전체(자식 페이지 + 분할 패널)를 감싸고 값은 같은 tasks 상태
  const prov = idx(/<TasksContext\.Provider value=\{tasks\}>/);
  const shellDiv = idx(/<div className="shell">/);
  const children = idx(/\) : children\}/);
  const provEnd = idx(/<\/TasksContext\.Provider>/);
  assert.ok(prov < shellDiv && shellDiv < children && children < provEnd, 'Provider가 셸(자식 포함)을 감싼다');
  // 데크: 훅으로 running 수를 읽고(조기 return 위), 카드 칩·부제가 그 수로 갈린다
  assert.match(deck, /const running = \(useTasks\(\)\?\.running \?\? \[\]\)\.length;/, 'running 수는 컨텍스트의 running 길이');
  assert.ok(deck.indexOf('const running = (useTasks()') < deck.indexOf('function load()'), '훅은 컴포넌트 최상단(조건·조기 return 앞)');
  assert.match(deck, /\{running > 0 \? t\('deck\.working'\) : t\('deck\.standby'\)\}/, '칩: 작성 중/대기');
  assert.match(deck, /\{running === 0 \? t\('deck\.allStandby'\) : running >= data\.agents\.length \? t\('deck\.allWriting'\) : t\('deck\.someWriting', \{ n: running \}\)\}/,
    '부제: 전원 대기 / 전원 작성 중 / N명 작성 중 · 나머지 대기');
  // 경로 끝 형태만 센다(따옴표·백틱·쿼리) — './tasks-context' 임포트의 '/tasks-'는 폴이 아니다(1차 red 실측)
  assert.equal((deck.match(/\/tasks(?=['"`?])/g) ?? []).length, 0, '데크에 /tasks 자체 폴 금지(셸 컨텍스트만)');
  assert.equal((deck.match(/useTasks\(\)/g) ?? []).length, 1, '컨텍스트 소비는 한 곳');
});
