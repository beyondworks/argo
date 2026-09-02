// 회의실 발언자 → 개별 스레드를 옆 패널로(유건 요청 2026-09-02, 회의실 개선 5/6) + 분할 패널 가용 축 단일화.
//
// 실측(2026-09-02, 격리 :3117 · 인앱 브라우저 resize_window): 배율 2 × 1280(유효 640 CSS px)·1424(712)에서
// ?side=crew:를 열면 패널 480이 그대로 들어와 본문 열 0px·문서 가로 넘침 280px(1544 > 1264). 뿌리는 CSS
// @media(max-width:899px)가 **실뷰포트**만 보는 것 — 배율 축은 순수 판정 splitAliveAt(zoom-math)로 옮기고,
// 소비자 셋(SplitPane 렌더·크루 채팅 진입로·회의실 진입로)이 한 훅(useSplitAlive)만 쓰게 잠근다.
// 배율 1 × 920(패널 480): 본문 212 → 그리드 148 → 레일 0·본문 열 130 압살 → 패널 양보 클램프(100% − 308).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPLIT_DEAD_MQ, splitAliveAt } from '../app/c/[ws]/zoom-math.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
// 주석 제거(줄주석 먼저 — 블록 우선이면 줄주석 속 글롭 /*가 유령 블록을 만든다: #346 교훈). 문자열 속 '//'는
// 이 파일들의 검사 구간(JSX·import)에 없다.
const strip = (s) => s.replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const room = strip(read('app/c/[ws]/room/page.jsx'));
const crew = strip(read('app/c/[ws]/crew/[slug]/page.jsx'));
const pane = strip(read('app/c/[ws]/split-pane.jsx'));
const hook = strip(read('app/c/[ws]/split-alive.jsx'));
const css = read('app/globals.css');

// ── 순수 판정 ──
test('splitAliveAt — 실뷰포트 축: mq가 죽음이면 배율·폭과 무관하게 죽음(CSS가 이미 숨긴 패널로 보내지 않는다)', () => {
  for (const [w, z] of [[2000, 1], [2000, 2], [2000, 0.8], [899, 1]]) assert.equal(splitAliveAt(true, w, z), false, `${w}/${z}`);
});
test('splitAliveAt — 배율 1은 mq만 본다(innerWidth 정수 반올림 vs 미디어쿼리 소수점의 1px 사각 금지, #356 2R LOW-1)', () => {
  // 실뷰포트 899.4: mq(max-width:899)는 거짓=삶, innerWidth는 899로 반올림 — 폭을 보면 거짓 죽음이 된다
  for (const w of [899, 900, 100, 5000]) assert.equal(splitAliveAt(false, w, 1), true, `z1 innerWidth ${w}`);
});
test('splitAliveAt — 배율 ≠ 1은 유효 폭(innerWidth ÷ z)에 같은 경계(>899)를 적용한다', () => {
  assert.equal(splitAliveAt(false, 1280, 2), false, '실측 결함 조건 — 유효 640');
  assert.equal(splitAliveAt(false, 1424, 2), false, '실측 결함 조건 — 유효 712');
  assert.equal(splitAliveAt(false, 1798, 2), false, '유효 899 — 경계 포함(CSS max-width:899와 같은 선)');
  assert.equal(splitAliveAt(false, 1800, 2), true, '유효 900 — 사이드바 228 + 본문 바닥 308 + 패널 360 = 896 ≤ 900');
  assert.equal(splitAliveAt(false, 1348, 1.5), false, '유효 898.67');
  assert.equal(splitAliveAt(false, 1349, 1.5), true, '유효 899.33 — 소수점 경계는 CSS와 같은 방향(>899 = 삶)');
  assert.equal(splitAliveAt(false, 720, 0.8), true, '축소 배율은 유효 폭을 넓힌다(실뷰포트 축은 mq 인자가 지배)');
});

// ── 질의 상수 = CSS 규칙 (한 축) ──
test('SPLIT_DEAD_MQ는 .split-pane을 죽이는 @media 블록과 같은 질의다', () => {
  assert.equal(SPLIT_DEAD_MQ, '(max-width: 899px)');
  const m = css.match(/@media\s*(\([^)]*\))\s*\{\s*\.split-pane\s*\{\s*display:\s*none;?\s*\}\s*\}/);
  assert.ok(m, 'globals에 .split-pane 사망 미디어 블록');
  assert.equal(m[1].replace(/\s+/g, ' '), SPLIT_DEAD_MQ, '질의가 갈라지면 JS와 CSS의 죽음 경계가 달라진다');
});
test('단일 축 스위프 — 사망 질의 리터럴은 zoom-math 상수 한 곳뿐, matchMedia 판정은 훅 한 곳뿐', () => {
  const files = readdirSync(join(ROOT, 'app'), { recursive: true }).map(String).filter((f) => /\.(jsx|js|mjs)$/.test(f));
  const lit = files.filter((f) => read(join('app', f)).includes('(max-width: 899px)')).map((f) => f.split('\\').join('/'));
  assert.deepEqual(lit, ['c/[ws]/zoom-math.mjs'], '리터럴 재등장 = 소비자가 자체 판정을 되살렸다(축 분기)');
  const mm = files.filter((f) => strip(read(join('app', f))).includes('matchMedia(')).map((f) => f.split('\\').join('/'));
  assert.deepEqual(mm, ['c/[ws]/split-alive.jsx'], 'matchMedia 호출은 공용 훅 밖에 있으면 안 된다');
  const users = files.filter((f) => strip(read(join('app', f))).includes('useSplitAlive(')).map((f) => f.split('\\').join('/')).sort();
  assert.deepEqual(users, ['c/[ws]/crew/[slug]/page.jsx', 'c/[ws]/layout.jsx', 'c/[ws]/room/page.jsx', 'c/[ws]/split-alive.jsx', 'c/[ws]/split-pane.jsx'],
    '소비자 = SplitPane(렌더)·크루(진입로 2곳)·회의실(진입로)·레이아웃(크루 행 진입로 2곳) 정확히 넷 — 하나가 빠지면 그 표면만 축이 갈라진다');
});

// ── 훅 배선 ──
test('useSplitAlive — 판정 호출·세 리스너(mq change·resize·argo:zoom)·초기 true', () => {
  assert.match(hook, /import \{ SPLIT_DEAD_MQ, dispZoom, splitAliveAt \} from '\.\/zoom-math\.mjs';/);
  assert.match(hook, /const \[alive, setAlive\] = useState\(true\);/, '초기 true — false면 넓은 폭 첫 프레임에 진입로가 없다');
  assert.match(hook, /const mq = window\.matchMedia\(SPLIT_DEAD_MQ\);\s*\n\s*const on = \(\) => setAlive\(splitAliveAt\(mq\.matches, window\.innerWidth, dispZoom\(\)\)\);\s*\n\s*on\(\);/,
    '판정 = 순수 함수에 (mq.matches, innerWidth, 배율) 그대로 — 인자 하나를 상수로 굳히면 그 축이 죽는다');
  for (const reg of [/mq\.addEventListener\('change', on\)/, /window\.addEventListener\('resize', on\)/, /window\.addEventListener\('argo:zoom', on\)/]) assert.match(hook, reg, `등록 ${reg}`);
  for (const reg of [/mq\.removeEventListener\('change', on\)/, /window\.removeEventListener\('resize', on\)/, /window\.removeEventListener\('argo:zoom', on\)/]) assert.match(hook, reg, `해제 ${reg}`);
});
test('SplitPane — 훅은 다른 훅보다 먼저, null 반환은 마지막 훅(useMemo) 뒤·JSX 앞', () => {
  const iHook = pane.indexOf('const alive = useSplitAlive();');
  const iW = pane.indexOf('const [w, setW] = useState(W_DEFAULT);');
  const iMemo = pane.indexOf('const crewParams = useMemo(');
  const iNull = pane.indexOf('if (!alive) return null;');
  const iJsx = pane.indexOf('return (\n    <aside className="split-pane"');
  assert.ok(iHook > 0 && iW > iHook, '훅 호출이 상태 훅보다 앞');
  assert.ok(iNull > iMemo && iMemo > 0, '조기 반환이 useMemo 앞에 오면 훅 순서가 렌더마다 달라진다');
  assert.ok(iJsx > iNull, 'null 반환이 JSX 앞');
});
test('크루 채팅 — 자체 판정 없이 공용 훅, 진입로(슬롯·밴드) 2곳 모두 splitAlive 게이트', () => {
  assert.match(crew, /import \{ useSplitAlive \} from '\.\.\/\.\.\/split-alive';/);
  assert.match(crew, /const splitAlive = useSplitAlive\(\);/);
  assert.doesNotMatch(crew, /setSplitAlive|matchMedia\(/, '인라인 판정이 돌아오면 패널(훅)과 진입로의 축이 갈라진다');
  // 상단바 슬롯의 '옆에 열기'는 종전 무게이트 — 배율 축이 더해지며 넓은 셸(슬롯 생존)에서도 패널이 죽을 수 있게 됐다
  const uses = [...crew.matchAll(/<SideOpenMenu/g)].map((m) => m.index);
  assert.equal(uses.length, 2, '진입로 2곳(슬롯·밴드) — 늘거나 줄면 계약 변경');
  for (const i of uses) assert.match(crew.slice(Math.max(0, i - 60), i), /splitAlive && \(\s*$/, `crew:${i} — 진입로 앞에 splitAlive 게이트`);
});
test('레이아웃 — 사이드바 크루 행 진입로(hover 버튼·cmd+클릭)도 같은 훅으로 게이트', () => {
  const layout = strip(read('app/c/[ws]/layout.jsx'));
  assert.match(layout, /import \{ useSplitAlive \} from '\.\/split-alive';/);
  assert.match(layout, /const splitAlive = useSplitAlive\(\);/);
  assert.match(layout, /if \(splitAlive && \(e\.metaKey \|\| e\.ctrlKey\) && !e\.shiftKey && e\.button === 0\) \{ e\.preventDefault\(\); if \(!active\) openSide\(\{ type: 'crew', key: a\.slug \}\); return; \}/,
    'cmd+클릭 — 죽은 축이면 가로채지 않고 브라우저 기본(새 탭)으로 흘려보낸다');
  assert.match(layout, /<button type="button" className="crew-side" disabled=\{active \|\| !splitAlive\}/,
    "행 '옆에 열기' — disabled면 CSS(.crew-side:disabled)가 숨긴다(안 될 버튼 노출 금지)");
});

// ── 회의실 진입로 ──
test('회의실 — 발언자 아바타·이름이 canOpenSide(패널 삶 + 크루 실존)일 때만 버튼, 클릭 = ?side=crew:<slug>', () => {
  assert.match(room, /import \{ useRouter \} from 'next\/navigation';/);
  assert.match(room, /import \{ sideParam, withSide \} from '\.\.\/split\.mjs';/);
  assert.match(room, /import \{ useSplitAlive \} from '\.\.\/split-alive';/);
  assert.match(room, /const splitAlive = useSplitAlive\(\);/);
  assert.doesNotMatch(room, /setSplitAlive|matchMedia\(/, '인라인 판정 금지');
  // 열기 = 주 화면 URL 유지 + side 쿼리만(크루 SideOpenMenu.onPick과 같은 호출) — push면 뒤로가기가 패널 닫기가 된다
  assert.match(room, /const openSide = \(slug\) => router\.replace\(withSide\(`\$\{window\.location\.pathname\}\$\{window\.location\.search\}`, sideParam\(\{ type: 'crew', key: slug \}\)\)\);/);
  // 진입로 조건 = 두 항 모두 — 크루 실존을 빼면 해고된 크루의 옛 발언이 빈 패널로 보낸다
  assert.match(room, /const canOpenSide = \(slug\) => splitAlive && agents\.some\(\(a\) => a\.slug === slug\);/);
  // 아바타 갈래(여는 태그 전체 앵커 — 낱개 프로퍼티 앵커는 형제 행이 대신 만족시킨다)
  assert.match(room,
    /<div key=\{i\} style=\{\{ display: 'flex', gap: 10, maxWidth: '86%' \}\}>\s*\n\s*(?:\{\s*\}\s*\n\s*)?\{canOpenSide\(m\.who\) \? \(\s*\n\s*<button type="button" className="room-speaker" onClick=\{\(\) => openSide\(m\.who\)\} title=\{t\('room\.openSide', \{ name: nameOf\(m\.who\) \}\)\} aria-label=\{t\('room\.openSide', \{ name: nameOf\(m\.who\) \}\)\}>\s*\n\s*<Avatar name=\{nameOf\(m\.who\)\} \/>\s*\n\s*<\/button>\s*\n\s*\) : <Avatar name=\{nameOf\(m\.who\)\} \/>\}/,
    '아바타 진입로 — 게이트·핸들러·평문 폴백 세트');
  // 이름 갈래
  assert.match(room,
    /\{canOpenSide\(m\.who\) \? \(\s*\n\s*<button type="button" className="room-speaker name" onClick=\{\(\) => openSide\(m\.who\)\} title=\{t\('room\.openSide', \{ name: nameOf\(m\.who\) \}\)\}>\{nameOf\(m\.who\)\}<\/button>\s*\n\s*\) : nameOf\(m\.who\)\}/,
    '이름 진입로 — 게이트·핸들러·평문 폴백 세트');
  assert.equal((room.match(/openSide\(m\.who\)/g) ?? []).length, 2, '진입로 2곳(아바타·이름) — 늘거나 줄면 계약 변경');
});
test('회의실 진입로 CSS — 버튼 리셋·이름 hover 밑줄·아바타 hover 링', () => {
  assert.match(css, /^\.room-speaker \{ background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; display: inline-flex; align-items: center; border-radius: 999px; \}$/m);
  assert.match(css, /^\.room-speaker\.name:hover, \.room-speaker\.name:focus-visible \{ text-decoration: underline; text-underline-offset: 2px; \}$/m);
  assert.match(css, /^\.room-speaker:hover > \.avatar, \.room-speaker:focus-visible > \.avatar \{ box-shadow: 0 0 0 2px var\(--primary-soft\); \}$/m);
});
test('i18n — room.openSide ko/en 둘 다 {name} 보간', () => {
  const m = read('app/i18n.jsx').match(/^\s*'room\.openSide': \[(.*)\],$/m);
  assert.ok(m, '사전 항목');
  assert.equal((m[1].match(/\{name\}/g) ?? []).length, 2, 'ko·en 각각 {name}');
});

// ── 레일 클립(양보 0 구간에서 본문 위 겹침 차단) ──
test('.chat-cols > .side-rail — overflow clip + 안쪽 포커스 링: 트랙 0 구간에서 레일 내용이 본문 위로 흐르지 않는다', () => {
  assert.match(css, /^\.chat-cols > \.side-rail \{ position: sticky; top: 72px; overflow: clip; \}$/m,
    '실측(유효 920, 패널 열림): 레일 트랙 0px에 "회의 기록"·"현재 회의"가 본문 헤더 위로 겹쳤다 — clip 제거 변이는 red');
  assert.match(css, /^\.chat-cols > \.side-rail :focus-visible \{ outline-offset: -2px; \}$/m,
    '클립이 박스 밖 기본 포커스 링(2px)을 잘라내므로 레일 안 포커스 링은 안쪽으로 — 없으면 키보드 포커스 표시가 좌우 변을 잃는다');
});

// ── 패널 양보 클램프 ──
test('.split-pane 양보 클램프 100% − 308 — 308은 산식(.chat-cols 바닥 244 + .content 좌우 패딩 64)에서 나온다', () => {
  assert.match(css, /\.split-pane \{\n  flex: none; width: var\(--split-w, 480px\); min-width: 360px; max-width: min\(60vw, 100% - 308px\);/,
    '선언 머리 폐합 앵커 — 60vw 단독으로 롤백되면 배율 1 × 920에서 본문 열이 130px로 압살된다(실측)');
  const floor = Number(css.match(/\.chat-cols \{\n  display: grid; grid-template-columns: min\(216px, 100% - (\d+)px\)/)[1]);
  const pad = css.match(/^\.content \{ padding: \d+px (\d+)px \d+px;/m);
  assert.ok(pad, '.content 패딩 선언');
  assert.equal(floor + 2 * Number(pad[1]), 308, `산식 대조: chat-cols 바닥 ${floor} + 패딩 ${pad[1]}×2 ≠ 308 — 한쪽이 바뀌면 상수를 함께 갱신`);
});
