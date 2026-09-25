// 사이드바 크루 상태 표지 배선 핀 (2026-09-02 유건 요청 원 설계 d2a9d78 재적용 — 2026-09-24 재검수 반영).
//
// 표지 셋은 **자리가 다르다**: 아바타를 두르는 링 = 답변 작성 중(은은한 점멸) · 아바타 모서리 점 = 텔레그램
// 직통 봇 · 이름 옆 점 = 답변 도착(안읽음). 원천은 /tasks running(크루별 chats/<slug>.status.json)이며,
// 작업 독 배지·패널과 사이드바 링이 Shell 안 단일 폴을 나눠 쓴다.
//
// 잠그는 것(변이 red 실증 — 각 단언은 그 결함 하나를 잡는다):
//  ① 단일 폴 — /tasks 호출부는 파일에 **정확히 하나**, Shell 안(작업 독이 자체 폴을 되살리면 배지와 행
//     점멸이 서로 다른 시점의 진실을 본다 = 이 변경이 없애려는 결함).
//  ② busy 배선 — running 목록 → busySet → 행의 busy → 링 렌더(busy && …) + 안읽음의 !busy 가드.
//  ③ 유휴 폴 빈도 — 독이 닫혀 있으면 **항상 10초**(재검수 LOW: 도는 턴이 있어도 요청 수를 늘리지 않는다),
//     열려 있으면 3.5초. 턴 종료 즉시성(light 재조회 당김)·argo:refresh 연결은 유지.
//  ④ 링 CSS — 투명도만(opacity), ease-in-out 왕복, 숨쉬는 박자(1.2~2.4초), 바닥 0.3~0.6, 기본 상태에
//     opacity 선언 없음(동작 줄이기 전역 규칙이 반복을 1로 자르면 불투명 링으로 정지), 활성 행 대비.
//  ⑤ 텔레그램 점 툴팁은 alive로 갈린다(경고색 점에 "연결됨"을 띄우지 않는다).
// 한계(정직 표기): 소스 수준 핀이라 실제 렌더·타이밍은 못 본다 — 그건 격리 서버 실측(상태 파일 손수
// 생성 → 라이트/다크 스크린샷·DOM 단언·전환 시간)이 담당한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
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

test('③ 유휴 폴 빈도 10초 고정(재검수 LOW) + 턴 종료 즉시성 + argo:refresh 연결', () => {
  const effStart = idx(/const runningRef = useRef\(new Set\(\)\);/);
  const effEnd = idx(/const busySet = new Set/);
  const eff = layout.slice(effStart, effEnd);
  assert.match(eff, /const now = new Set\(\(d\.running \?\? \[\]\)\.map\(\(r\) => r\.slug\)\);\s*if \(\[\.\.\.runningRef\.current\]\.some\(\(s\) => !now\.has\(s\)\)\) refresh\(\);\s*runningRef\.current = now;\s*setTasks\(d\);/,
    '이전 running에 있던 크루가 지금 없으면 refresh() — 그 다음 runningRef 갱신·setTasks 순서');
  assert.match(eff, /window\.addEventListener\('argo:refresh', pull\);/, 'argo:refresh(크루 페이지 턴 종료 등)에 즉시 당긴다');
  assert.match(eff, /window\.removeEventListener\('argo:refresh', pull\);/, '해제도 짝으로');
  assert.match(eff, /setInterval\(pull, dockOpen \? 3500 : 10000\)/, '독 열림만 3.5초 — 도는 턴 유무는 간격에 관여하지 않는다(유휴 요청 수 고정)');
  assert.doesNotMatch(layout, /anyRunning/, '도는 턴 유무로 폴 간격을 당기던 축을 제거했다(재검수 LOW) — 되살아나면 유휴 상태에서도 요청이 늘어난다');
  assert.match(eff, /\}, \[ws, dockOpen, refresh\]\);/, '효과 deps에 anyRunning이 없다');
});

const ruleBody = (sel) => {
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
  assert.ok(m, `animation은 'crewPulse <초>s ease-in-out infinite' 형태여야 한다(실제: '${anim}')`);
  assert.ok(Number(m[1]) >= 1.2 && Number(m[1]) <= 2.4, `숨쉬는 박자 1.2~2.4초(실제 ${m[1]}s)`);
  assert.equal(decl(ring, 'opacity'), undefined, '기본 상태엔 opacity 선언이 없어야 동작 줄이기에서 불투명 링으로 정지한다');
  const kf = /@keyframes crewPulse\s*\{((?:\s*[^{}]+\{[^{}]*\})+)\s*\}/.exec(css);
  assert.ok(kf, '@keyframes crewPulse');
  const stops = [...kf[1].matchAll(/([\d%, ]+)\{\s*opacity:\s*([\d.]+);?\s*\}/g)].map((s) => [s[1].replace(/\s/g, ''), Number(s[2])]);
  assert.deepEqual(stops.map(([k]) => k), ['0%,100%', '50%'], '양 끝(0/100%)과 중간(50%) 두 정거장');
  assert.equal(stops[0][1], 1, '양 끝은 불투명');
  assert.ok(stops[1][1] >= 0.3 && stops[1][1] <= 0.6, `바닥은 0.3~0.6(실제 ${stops[1][1]})`);
  assert.equal(decl(ruleBody('.nav-item.active .crew-writing'), 'border-color'), 'var(--primary-fg)', '활성 행 대비 — 핀 버튼과 같은 규칙');
  const rm = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(rm, 'prefers-reduced-motion 블록');
  assert.match(rm[1], /\*, \*::before, \*::after \{[^}]*animation-iteration-count: 1 !important/, '전역 반복 1회 — 링 점멸도 이 규칙으로 정지');
});

test('⑤ 텔레그램 점 툴팁은 alive로 갈린다', () => {
  assert.match(layout, /tgAgents\[a\.slug\]\.alive \? t\('nav\.tgConnected'\)/, '연결·수신 중일 때 문구');
  assert.match(layout, /background: tgAgents\[a\.slug\]\.alive \? 'var\(--ok\)'/, '색 분기도 alive 기준');
});

test('고정 핀 대비 — 사이드바 크루 행에 active 클래스가 얹혀 graphite/linen 스코프의 --primary-fg 재정의가 형제(핀·옆에 열기 버튼)까지 닿는다(재검수 2026-09-24)', () => {
  assert.match(layout, /className=\{`crew-row\$\{active \? ' active' : ''\}`\}/, '.crew-row에 active 클래스가 조건부로 붙는다');
  for (const theme of ['graphite', 'graphite-light', 'graphite-dark', 'linen', 'linen-light', 'linen-dark']) {
    assert.match(css, new RegExp(`:root\\[data-theme='${theme}'\\] \\.crew-row\\.active`), `${theme} 테마가 .crew-row.active를 --primary-fg 재정의 스코프에 포함한다`);
  }
});
