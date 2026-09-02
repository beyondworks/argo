// 사이드바 크루 상태 표지 배선 핀 (2026-09-02 유건 요청 — "크루 목록에서 상태별로 알아볼 수 있게") + 데크 카드 정합.
//
// 표지 셋은 **자리가 다르다**: 아바타를 두르는 링 = 답변 작성 중(은은한 점멸) · 아바타 모서리 점 = 텔레그램
// 직통 봇(연결/수신 중 아님) · 이름 옆 점 = 답변 도착(안읽음, 열어 보면 소거). 원천은 셋 다 서버 사실이다 —
// 작성 중은 크루별 chats/<slug>.status.json(2분 신선도, /tasks running), 텔레그램은 폴러 하트비트(alive),
// 안읽음은 chats/<slug>.json mtime(chatTs) vs 로컬 확인 기준선(seen).
//
// 잠그는 것(변이 red 실증 — 각 단언은 그 결함 하나를 잡는다):
//  ① 단일 폴 — /tasks 호출부는 파일에 **정확히 하나**, Shell 안. 독 구간엔 호출 자체가 없다(문자열 모양 무관 —
//     분리 검수 M-C: 경로를 이어 붙인 자체 폴 부활이 초록이던 구멍).
//  ② busy 배선 — running 목록 → busySet → 행의 busy → 링 렌더(busy && …) + 안읽음의 !busy 가드.
//  ③ 종료 즉시성 — running에서 빠진 크루가 있으면 light 재조회(이벤트발 호출은 생략 — 중복 2회→1회) + argo:refresh
//     연결 + 도는 턴이 있으면 3.5초 폴 + 정리(alive 게이트·리스너 해제·clearInterval — 검수 M-A/M-B 구멍).
//  ④ 링 CSS — 투명도만, ease-in-out 왕복, 숨쉬는 박자(1.2~2.4초), 바닥 0.3~0.6(꺼지지 않는 '은은'), 기하(음수 inset·
//     원형), 기본 상태에 opacity 선언 없음 + 동작 줄이기 블록의 명시 animation:none(불투명 링으로 정지), 활성 행 대비.
//  ⑤ 텔레그램 툴팁 — alive 여부로 문구가 갈린다.
//  ⑥ 데크 카드 — 셸의 tasks 컨텍스트(Provider 정확히 하나·running slug 키로 memo)로 작성 중 수를 그리고, 데크엔
//     'tasks' 토큰 자체가 없다(경로 조립형 자체 폴까지 차단), 훅은 어떤 return보다 앞.
//  ⑦ /tasks?light=1 — running만(이벤트 로그 전량 파싱 생략) — 라우트 실호출.
//  ⑧ 하트비트 — CLI·SDK 두 분기 모두 상태 파일을 2분 창 안에 붙들고(행동 테스트), 모든 clear·재귀 재시도 앞과
//     finally에서 멈춘다(chat.mjs 배선 핀). 없으면 CLI 턴은 2분 뒤 링이 꺼지고 거짓 '답변 도착' 점이 켜진다.
// 한계(정직 표기): 소스 핀은 실제 렌더·타이밍을 못 본다 — 그건 PR의 격리 서버 실측이 담당한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-marks-'));
for (const k of Object.keys(process.env)) if (/SUPABASE/i.test(k)) delete process.env[k]; // AUTH off — 라우트 실호출 게스트
const { setTurnStatus, clearTurnStatus, keepTurnStatusFresh, __statusChains } = await import('../src/turn-status.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { appendEvent } = await import('../src/events.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 주석 제거(줄 구조 보존) — topbar-phone-policy.test.mjs와 동일 방식. 주석 속 셀렉터·표현식이 단언에 잡히지 않게.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));
const read = (rel) => stripComments(readFileSync(join(ROOT, rel), 'utf8'));
const layout = read('app/c/[ws]/layout.jsx');
const css = read('app/globals.css');
const deck = read('app/c/[ws]/page.jsx');
const ctx = read('app/c/[ws]/tasks-context.js');
const chat = read('src/chat.mjs');
const routeSrc = read('app/api/companies/[ws]/tasks/route.js');

const idx = (re, src = layout) => { const m = re.exec(src); assert.ok(m, `없음: ${re}`); return m.index; };
const SHELL = idx(/\nfunction Shell\(/);
const DOCK = idx(/\nfunction TasksDock\(/);
assert.ok(DOCK < SHELL, 'TasksDock이 Shell 앞에 정의된다는 전제(구간 판정 기준)');
const TASKS_CALL = /api\(`\/api\/companies\/\$\{ws\}\/tasks\$\{dockOpen \? '' : '\?light=1'\}`\)/g;

test('① /tasks 폴은 파일에 하나뿐이고 Shell 안 — 작업 독은 데이터·열림 상태를 props로만 받고 호출이 없다', () => {
  const calls = [...layout.matchAll(TASKS_CALL)].map((m) => m.index);
  assert.equal(calls.length, 1, '/tasks 호출부는 정확히 하나(둘이면 배지와 행 점멸이 다른 시점의 진실을 본다)');
  assert.ok(calls[0] > SHELL, '/tasks 폴은 Shell(사이드바를 그리는 쪽)이 쥔다');
  const dock = layout.slice(DOCK, SHELL);
  assert.doesNotMatch(dock, /\bapi\(|\bfetch\(|XMLHttpRequest|\/tasks/, '독 구간에 네트워크 호출·/tasks 경로 금지 — 문자열 모양과 무관(검수 M-C 구멍)');
  assert.match(layout, /\nfunction TasksDock\(\{ ws, data, open, setOpen \}\)/, '작업 독은 running/recent와 열림 상태를 부모에게 받는다');
  assert.match(layout, /<TasksDock ws=\{ws\} data=\{tasks\} open=\{dockOpen\} setOpen=\{setDockOpen\} \/>/, '작업 독 호출부가 같은 tasks 상태를 넘긴다');
});

test('② running → busySet → 행 busy → 링 렌더 + 안읽음 !busy 가드 (크루 행 구간 안)', () => {
  assert.match(layout, /const busySet = new Set\(\(tasks\?\.running \?\? \[\]\)\.map\(\(r\) => r\.slug\)\);/, 'busySet은 /tasks running의 slug 집합');
  const row = layout.slice(idx(/list\.map\(\(a\) => \{/), idx(/\{t\('nav\.hire'\)\}/));
  assert.match(row, /const busy = busySet\.has\(a\.slug\);/, '행의 busy는 busySet 조회');
  assert.match(row, /const unread = !active && !busy && a\.chatTs != null && seen\?\.\[a\.slug\] !== undefined && a\.chatTs > seen\[a\.slug\];/,
    '안읽음은 작성 중이면 숨긴다(그 사이 갱신은 방금 들어온 지시 — 답변 도착이 아니다)');
  assert.match(row, /\{busy && <span className="crew-writing" role="img" aria-label=\{t\('nav\.writing'\)\} \/>\}/, '링은 busy에만 렌더, 접근성 라벨은 사전 경유');
  assert.match(row, /<span title=\{busy \? t\('nav\.writing'\) : undefined\} style=\{\{ position: 'relative', display: 'inline-flex', flex: 'none' \}\}>/, '아바타 래퍼 툴팁 — 작성 중일 때만');
});

test('③ 폴 효과 — 종료 감지 refresh(이벤트발 제외)·argo:refresh 연결·3.5/10초·alive 게이트·정리 짝', () => {
  const eff = layout.slice(idx(/const runningRef = useRef\(new Set\(\)\);/), idx(/const busySet = new Set/));
  assert.match(eff, new RegExp(String.raw`const pull = \(fromEvent\) => ${TASKS_CALL.source}\.then\(\(d\) => \{\s*if \(!alive\) return;\s*const now = new Set\(\(d\.running \?\? \[\]\)\.map\(\(r\) => r\.slug\)\);\s*if \(fromEvent !== true && \[\.\.\.runningRef\.current\]\.some\(\(s\) => !now\.has\(s\)\)\) refresh\(\);\s*runningRef\.current = now;\s*setTasks\(\(prev\) => \(dockOpen \? d : \{ \.\.\.d, recent: prev\?\.recent \?\? \[\] \}\)\);\s*\}\)\.catch\(\(\) => \{\}\);`),
    'alive 게이트 → 이전 running에 있던 크루가 지금 없으면(이벤트발 아니면) refresh() → runningRef 갱신 → setTasks(light면 recent 유지 — 독 열림 팝 방지) 순서');
  assert.match(eff, /const onRefresh = \(\) => pull\(true\);\s*window\.addEventListener\('argo:refresh', onRefresh\);/, 'argo:refresh(크루 페이지 턴 종료 등)에 즉시 당긴다 — 이벤트발 표시');
  assert.match(eff, /const iv = setInterval\(\(\) => pull\(\), dockOpen \|\| anyRunning \? 3500 : 10000\);/, '도는 턴·독 열림이면 3.5초, 아니면 10초');
  assert.match(eff, /return \(\) => \{ alive = false; window\.removeEventListener\('argo:refresh', onRefresh\); clearInterval\(iv\); \};/, '정리 — alive 해제·리스너 해제·인터벌 해제 셋 다(검수 M-A/M-B 구멍)');
  assert.match(eff, /\}, \[ws, dockOpen, anyRunning, refresh\]\);/, '효과 deps — anyRunning·dockOpen 전환이 폴 주기·light를 바꾼다');
  assert.match(layout, /const anyRunning = \(tasks\?\.running\?\.length \?\? 0\) > 0;/, 'anyRunning은 running 개수에서');
});

// 기준 규칙은 동작 줄이기 블록 **밖**에서 찾는다(블록 안의 .crew-writing { animation: none }은 별도로 본다).
const RM_AT = css.indexOf('@media (prefers-reduced-motion: reduce)'); assert.ok(RM_AT > 0, 'prefers-reduced-motion 블록');
const cssBase = css.slice(0, RM_AT);
const ruleBody = (sel, src = cssBase) => {
  // 정확 일치 셀렉터의 선언 블록 — 부분 매칭은 fail-open(topbar-phone-policy 교훈).
  const rules = [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((r) => r[1].split(',').some((s) => s.replace(/\s+/g, ' ').trim() === sel));
  assert.equal(rules.length, 1, `규칙 ${sel}은 정확히 하나(실제 ${rules.length})`);
  return rules[0][2];
};
const decl = (body, prop) => { const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;}]+)`).exec(body); return m?.[1].trim(); };

test('④ 링 CSS — 투명도만 숨쉬는 ease-in-out 왕복, 은은한 바닥, 기하, 활성 행 대비, 동작 줄이기 시 불투명 정지', () => {
  const ring = ruleBody('.crew-writing');
  assert.equal(decl(ring, 'position'), 'absolute');
  assert.match(decl(ring, 'inset') ?? '', /^-\d/, '음수 inset — 링이 아바타 **바깥**을 두른다(검수 M-D: 양수면 아바타 속으로 붕괴)');
  assert.equal(decl(ring, 'border-radius'), '999px', '원형');
  assert.equal(decl(ring, 'pointer-events'), 'none', '링이 아바타 클릭·툴팁을 가로채지 않는다');
  assert.match(decl(ring, 'border') ?? '', /^2px solid var\(--accent\)$/, "'진행 중' 계열 토큰(작업 독 배지·스피너와 동일), 선폭 2px(라이트 대비 보강 — 검수 MEDIUM-3)");
  const anim = decl(ring, 'animation') ?? '';
  const m = /^crewPulse\s+(\d+(?:\.\d+)?)s\s+ease-in-out\s+infinite$/.exec(anim);
  assert.ok(m, `animation은 'crewPulse <초>s ease-in-out infinite' 형태여야 한다(실제: '${anim}') — ease-in/out 편도는 왕복 루프에서 툭툭 끊긴다`);
  assert.ok(Number(m[1]) >= 1.2 && Number(m[1]) <= 2.4, `숨쉬는 박자 1.2~2.4초(실제 ${m[1]}s) — 짧으면 깜빡임, 길면 죽은 표지`);
  assert.equal(decl(ring, 'opacity'), undefined, '기본 상태엔 opacity 선언이 없어야 동작 줄이기에서 불투명 링으로 정지한다');
  // 정거장은 값 불변식으로 — "0%/100%는 1, 50%는 0.3~0.6, 그 외 정거장·속성 없음". 서식(0%, 100% 합치기)엔 결합하지 않는다(검수 M-J).
  const kf = /@keyframes crewPulse\s*\{((?:\s*[^{}]+\{[^{}]*\})+)\s*\}/.exec(css);
  assert.ok(kf, '@keyframes crewPulse');
  const stops = {};
  for (const s of kf[1].matchAll(/([\d%,\s]+)\{([^{}]*)\}/g)) {
    const op = /^\s*opacity:\s*([\d.]+);?\s*$/.exec(s[2]); assert.ok(op, `정거장 '${s[1].trim()}'은 opacity 하나만 선언(실제 '${s[2].trim()}')`);
    for (const k of s[1].split(',').map((x) => x.trim()).filter(Boolean)) stops[k] = Number(op[1]);
  }
  assert.deepEqual(Object.keys(stops).sort(), ['0%', '100%', '50%'], '정거장은 0%·50%·100% 세 개');
  assert.equal(stops['0%'], 1); assert.equal(stops['100%'], 1, '양 끝은 불투명(기본 상태와 같아 루프 이음새가 없다)');
  assert.ok(stops['50%'] >= 0.3 && stops['50%'] <= 0.6, `바닥은 0.3~0.6(실제 ${stops['50%']}) — 0에 닿으면 점멸, 0.6 위면 안 보인다`);
  assert.equal(decl(ruleBody('.nav-item.active .crew-writing'), 'border-color'), 'var(--primary-fg)', '활성 행(프라이머리 배경) 대비 — 핀 버튼과 같은 규칙');
  // 동작 줄이기 — 전역 규칙이 반복 횟수를 1로 자르고(지속시간만 줄이면 스트로브), 이 시트 규약대로 animation:none을 명시한다.
  const rm = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(rm, 'prefers-reduced-motion 블록');
  assert.match(rm[1], /\*, \*::before, \*::after \{[^}]*animation-iteration-count: 1 !important/, '전역 반복 1회');
  assert.equal(decl(ruleBody('.crew-writing', rm[1]), 'animation'), 'none', '동작 줄이기 블록에 .crew-writing { animation: none } 명시(시트 규약 — 검수 LOW-4)');
});

test('⑤ 텔레그램 점 툴팁은 alive로 갈린다 — 경고색 점에 "연결됨"을 띄우지 않는다', () => {
  assert.match(layout, /<span role="img" title=\{tgAgents\[a\.slug\] \? t\('nav\.tgConnected'\) : t\('nav\.tgIdle'\)\} aria-label=\{tgAgents\[a\.slug\] \? t\('nav\.tgConnected'\) : t\('nav\.tgIdle'\)\}/);
  assert.match(layout, /background: tgAgents\[a\.slug\] \? 'var\(--ok\)' : 'var\(--warn\)'/, '색 분기와 같은 조건(alive)');
});

test('⑥ 데크 크루 카드는 셸의 tasks 컨텍스트로 작성 중 수를 그린다 — 자체 폴 없음, Provider 하나, memo 값', () => {
  assert.match(ctx, /export const TasksContext = createContext\(null\);/);
  assert.match(ctx, /export const useTasks = \(\) => useContext\(TasksContext\);/);
  assert.equal((layout.match(/<TasksContext\.Provider/g) ?? []).length, 1, 'Provider는 정확히 하나 — 중첩 Provider(null)가 자식을 가리는 변이(검수 N-1b)');
  const prov = idx(/<TasksContext\.Provider value=\{tasksCtx\}>/);
  const shellDiv = idx(/<div className="shell">/);
  const children = idx(/\) : children\}/);
  const provEnd = idx(/<\/TasksContext\.Provider>/);
  assert.ok(prov < shellDiv && shellDiv < children && children < provEnd, 'Provider가 셸(자식 포함)을 감싼다');
  assert.match(layout, /const runningKey = \(tasks\?\.running \?\? \[\]\)\.map\(\(r\) => r\.slug\)\.join\(','\);\s*const tasksCtx = useMemo\(\(\) => \(\{ running: tasks\?\.running \?\? \[\] \}\), \[runningKey\]\);/,
    '컨텍스트 값은 running slug 키로 memo — 매 폴 재렌더 방지(검수 LOW-5)');
  assert.match(deck, /const running = \(useTasks\(\)\?\.running \?\? \[\]\)\.length;/, 'running 수는 컨텍스트의 running 길이');
  const hookAt = deck.indexOf('const running = (useTasks()');
  assert.doesNotMatch(deck.slice(idx(/export default function Deck\(/, deck), hookAt), /\breturn\b/, '훅은 어떤 return보다 앞(조건부 훅 금지 — 검수 N-3)');
  assert.equal((deck.match(/useTasks\(\)/g) ?? []).length, 1, '컨텍스트 소비는 한 곳');
  assert.equal((deck.match(/(?<![A-Za-z.-])tasks(?![A-Za-z-])/g) ?? []).length, 0, "데크엔 'tasks' 토큰이 없다 — 경로를 이어 붙인 자체 폴(검수 N-2b)까지 차단");
  assert.match(deck, /<span className="chip" style=\{running > 0 \? \{ borderColor: 'var\(--accent\)' \} : undefined\}><span className="dot" \/>\{running > 0 \? t\('deck\.working'\) : t\('deck\.standby'\)\}<\/span>/,
    '칩: 작성 중이면 테두리만 액센트 — 글자색은 유지(액센트 글자는 라이트 대비 2.04:1 — 검수 2R MEDIUM-2)');
  assert.match(deck, /\{running === 0 \? t\('deck\.allStandby'\) : \(data\.agents\.length > 0 && running >= data\.agents\.length\) \? t\('deck\.allWriting'\) : t\('deck\.someWriting', \{ n: running \}\)\}/,
    '부제: 전원 대기 / 전원 작성 중(agents 비어 있으면 금지 — 검수 LOW-6) / N명 작성 중');
});

test('⑦ /tasks?light=1 — running만(이벤트 로그 전량 파싱 생략), 독이 열리면 recent까지 (라우트 실호출)', async () => {
  assert.match(routeSrc, /const light = new URL\(req\.url\)\.searchParams\.get\('light'\) === '1';/);
  assert.match(routeSrc, /const events = light \? \[\] : await readEvents\(ws, 200\)\.catch\(\(\) => \[\]\);/, 'light면 readEvents를 호출조차 않는다(검수 MEDIUM-2)');
  const { register } = await import('node:module');
  register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
  const route = await import(pathToFileURL(join(ROOT, 'app/api/companies/[ws]/tasks/route.js')).href);
  const ws = 'tk';
  await createCompany(ws, '표지', '사장', null, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'a1.md'), '---\nname: 에이\nrole: 기획\n---\n');
  await setTurnStatus(ws, 'a1', 'runner', 'X');
  await appendEvent(ws, { type: 'turn', slug: 'a1', ok: true, ms: 10 });
  const get = async (qs) => (await route.GET(new Request(`http://127.0.0.1/api/companies/${ws}/tasks${qs}`), { params: Promise.resolve({ ws }) })).json();
  const light = await get('?light=1');
  assert.deepEqual(light.running.map((r) => r.slug), ['a1'], 'light에도 running은 온다(링·배지·카드의 원천)');
  assert.deepEqual(light.recent, [], 'light는 recent 없음');
  const full = await get('');
  assert.deepEqual(full.running.map((r) => r.slug), ['a1']);
  assert.equal(full.recent.length, 1, '독이 열리면(비-light) recent가 채워진다');
  await clearTurnStatus(ws, 'a1');
});

const statusPath = (ws, slug) => join(paths(ws).chats, `${slug}.status.json`);
test('⑧ 하트비트 — ts를 창 안에 붙들고 현재 stage·detail·partial을 보존하며, stop(멱등) 뒤엔 부활하지 않는다', async () => {
  const ws = 'hb'; const slug = 'crew';
  const raw = async () => JSON.parse(await readFile(statusPath(ws, slug), 'utf8'));
  // 고정 대기가 아니라 조건 충족까지 폴링(상한 2초) — 백그라운드 빌드 같은 부하에서 5ms 틱이 60ms 안에 한 번도
  // 못 쓰던 거짓 red 실측(2026-09-02). 시간이 아니라 "틱이 한 번 이상 썼다"가 단언 대상이다.
  const tickedAfter = async (t) => { for (let i = 0; i < 100; i++) { const r = await raw(); if (r.ts > t) return r; await sleep(20); } return raw(); };
  await setTurnStatus(ws, slug, 'runner', 'Codex', '부분 답변');
  const t0 = (await raw()).ts;
  const hb = keepTurnStatusFresh(ws, slug, 'runner', 'Codex', { heartbeatMs: 5 });
  try {
    let r = await tickedAfter(t0);
    assert.ok(r.ts > t0, '틱이 ts를 올린다(2분 창 갱신)');
    assert.equal(r.stage, 'runner'); assert.equal(r.detail, 'Codex'); assert.equal(r.partial, '부분 답변', 'partial 보존');
    await setTurnStatus(ws, slug, 'shell', 'npm test'); // SDK 스트리밍이 단계를 바꾼 상황
    const t1 = (await raw()).ts;
    r = await tickedAfter(t1); // 단계 변경 **뒤에** 틱이 한 번 이상 쓴 상태
    assert.ok(r.ts > t1, '단계 변경 뒤에도 틱이 이어진다');
    assert.equal(r.stage, 'shell'); assert.equal(r.detail, 'npm test', '틱은 현재 단계를 그대로 다시 쓴다(초기 단계로 역행 금지 — 직렬화 없으면 5ms 틱에서 실측 역행)');
  } finally {
    await hb.stop(); await hb.stop(); // 멱등 — finally와 clear 앞에서 두 번 불린다. 실패해도 멈춰야 러너가 끝난다.
  }
  await clearTurnStatus(ws, slug); await sleep(40);
  assert.equal(existsSync(statusPath(ws, slug)), false, 'stop 뒤 clear — 부활 없음');
});

test('⑧ 해제 경합 — 진행 중 틱이 clear 뒤 상태를 되살리지 않는다(heartbeatMs 1 × 40회, room 마커와 같은 핀)', async () => {
  const ws = 'hb-race'; const slug = 'crew'; let revived = 0;
  for (let i = 0; i < 40; i++) {
    await setTurnStatus(ws, slug, 'runner', 'X');
    const hb = keepTurnStatusFresh(ws, slug, 'runner', 'X', { heartbeatMs: 1 });
    await sleep(3);
    await hb.stop(); await clearTurnStatus(ws, slug);
    await sleep(15);
    if (existsSync(statusPath(ws, slug))) { revived += 1; await clearTurnStatus(ws, slug); }
  }
  assert.equal(revived, 0, `부활 ${revived}/40 — 화면이 2분간 거짓 '작성 중'이 된다(stop이 진행 중 틱을 안 기다리면 생긴다)`);
  await sleep(10); // 정착 뒤 정리(tail.then)는 마이크로태스크 — 한 틱 양보
  assert.equal(__statusChains.size, 0, '직렬화 사슬은 정착 뒤 비워진다 — 정리를 지우면 (회사×크루)만큼 정착 promise가 프로세스 수명 동안 남는다(검수 2R Q-8 구멍)');
});

test('⑧ chat.mjs — CLI·SDK 두 분기 모두 하트비트를 시작하고, 모든 clear·재귀(await chat) 앞과 finally에서 멈춘다', () => {
  const sdkStart = idx(/await setTurnStatus\(wsId, agentSlug, 'boot'\);/, chat);
  const cli = chat.slice(idx(/if \(isCliRunner\(runner\)\) \{/, chat), sdkStart);
  const sdk = chat.slice(sdkStart);
  // CLI: try 밖 let 선언 + try 첫 문장에서 시작(생성과 try 사이 throw로 인터벌이 영구 누수되지 않게 — 검수 2R LOW-5)
  assert.match(cli, /await setTurnStatus\(wsId, agentSlug, 'runner', RUNNERS\[runner\]\.name\);[^\n]*\n\s*let hb = null;/, 'CLI: 상태 기록 직후 let 선언(try 밖)');
  assert.match(cli, /try \{\s*hb = keepTurnStatusFresh\(wsId, agentSlug, 'runner', RUNNERS\[runner\]\.name\);/, 'CLI: try 첫 문장에서 하트비트 시작');
  assert.equal((cli.match(/clearTurnStatus\(wsId, agentSlug\)/g) ?? []).length, 2, 'CLI 분기 clear 2곳(전제 — 바뀌면 stop 짝도 갱신)');
  assert.equal((cli.match(/await hb\?\.stop\(\);\s*await clearTurnStatus\(wsId, agentSlug\);/g) ?? []).length, 2, 'CLI: 모든 clear 직전에 stop');
  // 재귀는 형태를 가리지 않고 센다 — `return await chat(`만 세다가 자가치유의 `const healed = await chat(`을 놓쳤다(검수 2R MEDIUM-1)
  assert.equal((cli.match(/await chat\(/g) ?? []).length, 3, 'CLI 재귀(재시도 2 + 자가치유 1) 전제');
  assert.equal((cli.match(/await hb\?\.stop\(\);[^\n]*\n\s*(?:return |const healed = )await chat\(/g) ?? []).length, 3, 'CLI: 모든 재귀 직전 stop — 바깥 틱이 안쪽 턴의 clear 뒤 상태를 되살리지 않게');
  assert.match(cli, /\} finally \{\s*await hb\?\.stop\(\);[^\n]*\n\s*abortReg\.release\(\);/, 'CLI finally: 탈출 경로 누수 방지');
  assert.match(chat.slice(0, sdkStart), /\n *let hb = null;[^\n]*\n[\s\S]*\n *let hb = null;/, 'let hb 선언은 두 분기 각각(try 밖)');
  assert.match(chat, /await setTurnStatus\(wsId, agentSlug, 'boot'\);[^\n]*\n\s*hb = keepTurnStatusFresh\(wsId, agentSlug, 'boot'\);/, 'SDK: boot 기록 바로 다음 줄에서 시작');
  assert.equal((sdk.match(/clearTurnStatus\(wsId, agentSlug\)/g) ?? []).length, 2, 'SDK 분기 clear 2곳(전제)');
  assert.match(sdk, /await hb\?\.stop\(\);\s*await clearTurnStatus\(wsId, agentSlug\);/, 'SDK 실패 경로: clear 직전 stop');
  assert.equal((sdk.match(/await chat\(/g) ?? []).length, 3, 'SDK 재귀(재시도 2 + 자가치유 1) 전제');
  assert.equal((sdk.match(/await hb\?\.stop\(\);[^\n]*\n\s*(?:return |const healed = )await chat\(/g) ?? []).length, 3, 'SDK: 모든 재귀 직전 stop');
  assert.match(sdk, /\} finally \{\s*await hb\?\.stop\(\);[^\n]*\n\s*abortReg\?\.release\(\);\s*\}\s*await clearTurnStatus\(wsId, agentSlug\);/, 'SDK finally: stop 뒤에 성공 경로 clear');
  assert.equal((chat.match(/clearTurnStatus\(wsId, agentSlug\)/g) ?? []).length, 4, '새 clear 지점이 생기면 이 핀을 갱신하며 stop 짝을 붙인다');
});
