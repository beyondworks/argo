// 표시 배율(#334) 레이아웃·좌표계 보정 행동 테스트 — 부트(display-zoom.test.mjs) 이후의 절반.
// 재검수 실측: .side·채팅 그리드·모달 86vh·body min-height 롤백, graph2d evPos k 무력화,
// split-pane·vault 리사이저 dispZoom 무력화 전부 기존 스위트 초록(무게이트) → 이 파일이 잠근다.
//
// 방식 — 브라우저 없이 3층:
//  ① 치수 선언(CSS·JSX 인라인)의 vh 식을 **산술 평가** — 문자열 앵커가 아니라 값 불변식이라
//     동치 리팩터는 초록, 나눗셈 롤백은 산술로 red. 불변식: 배율 z에서 화면 크기(디바이스 px
//     = 평가값 × z) ≤ 뷰포트. vh는 zoom과 곱해지지 않으므로 /var(--z)가 빠지면 z배로 넘친다.
//     수집 누락은 역방향 스캔이 막는다 — 소스의 모든 vh 토큰은 수집된 선언 안에 있어야 한다
//     (분리 검수 실증: 템플릿 리터럴·CSS 변수 간접·대문자 단위가 수집만 빠져나가 초록이었다).
//  ② zoom-math.mjs(추출된 계산부)를 직접 임포트해 실호출 — 좌표 환산·폭 클램프의 행동 검증.
//  ③ 호출부 잠금 — 함수만 잠그면 호출부 우회 변이가 전부 초록이 되는 기왕의 실패 패턴 방지.
//     graph2d는 구간 불변식(생좌표 읽기는 evPos 한 곳뿐 — 핸들러 하나만 되돌리는 변이도 red,
//     분리 검수 실증), 리사이저 2곳(split-pane·vault)은 배선 핀.
//  한계(정직 표기): ③은 소스 수준 잠금이라 **신규** 컴포넌트가 자체 좌표 처리를 무보정으로
//  들여오는 것까지는 못 잡는다(신규 vh 치수는 ①의 역방향 스캔이 잡는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispZoom, clampPaneW, PANE_W_MIN, zoomedEvPos, dropUpClamp } from '../app/c/[ws]/zoom-math.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const V = 900; // 뷰포트 높이(px) — #334 실측 환경(사이드바 rect 1125 vs 뷰포트 900)과 동일
const ZOOMS = [1.25, 2]; // 대표 배율·수동 최대 — 식은 z에 선형이라 끝점이 구간을 덮는다(자동 단계가 바뀌어도 유효)

/* ── ① 치수 식 산술 평가 ───────────────────────────────────────────── */

// CSS 길이 식 평가기 — calc/min/max, vh/px, var(--z[, 폴백])만. 미지 구문은 조용히 통과가 아니라
// 화이트리스트 검사로 시끄럽게 실패한다(fail-closed — 새 단위가 들어오면 평가기를 넓혀야 함).
function evalSize(expr, { z } = {}) {
  let s = String(expr).trim();
  s = s.replace(/var\(\s*--z\s*(?:,\s*([^)]+))?\s*\)/g, (_, fb) => {
    if (z != null) return `(${z})`;
    if (fb != null) return `(${fb.trim()})`;
    // 폴백 없는 var(--z)는 변수 미설정(배율 1) 시 선언 전체가 무효 — 실브라우저와 같게 실패시킨다
    throw new Error(`var(--z) 폴백 없음 — 배율 1(변수 미설정)에서 선언이 무효가 된다: ${expr}`);
  });
  s = s.replace(/(\d*\.?\d+)vh/gi, (_, n) => `(${n}*${V}/100)`);
  s = s.replace(/(\d*\.?\d+)px/gi, '($1)');
  s = s.replace(/\bcalc\(/gi, '(').replace(/\bmin\(/gi, 'Math.min(').replace(/\bmax\(/gi, 'Math.max(');
  const residue = s.replace(/Math\.(min|max)/g, '').replace(/[\d\s+\-*/().,]/g, '');
  assert.equal(residue, '', `평가기가 모르는 구문 — 확장 필요: ${expr}`);
  return Function(`'use strict'; return (${s});`)();
}

// 주석 제거(줄 구조 보존 — 진단 줄번호 유지). vh 언급 주석이 수집·스캔에 잡히지 않게 한다.
// 라인 주석은 행头·공백 뒤 //만 — 문자열 속 URL(https://…)은 앞이 ':'라 다치지 않는다.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));
}

// 수집 — 소스에서 vh가 든 치수 선언(height·min/max-height)을 값 위치(range)와 함께 모은다.
// 셀렉터/컴포넌트 무관: 불변식은 "화면을 채우는 치수는 배율만큼 나눠야 한다"로 균일하게 성립한다.
// (작은 vh 값(X·z ≤ 100vh 구간)은 나누지 않아도 산술상 화면 안이라 불변식이 과차단하지 않는다.)
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
function collectCss(src, file) {
  const out = [];
  for (const m of src.matchAll(/(?:^|[;{])\s*((?:min-|max-)?height)\s*:\s*([^;}]+)/gi)) {
    if (!/vh/i.test(m[2])) continue;
    const start = m.index + m[0].indexOf(m[2]);
    out.push({ where: `${file}:${lineOf(src, m.index + m[0].indexOf(m[1]))}`, prop: m[1], expr: m[2].trim(), file, start, end: start + m[2].length });
  }
  return out;
}
function collectJsx(src, file) {
  const out = [];
  for (const m of src.matchAll(/\b(height|minHeight|maxHeight)\s*:\s*(['"`])([^'"`]*)\2/g)) {
    if (!/vh/i.test(m[3])) continue;
    const start = m.index + m[0].indexOf(m[2]) + 1; // 여는 따옴표 다음 = 값 시작
    out.push({ where: `${file}:${lineOf(src, m.index)}`, prop: m[1], expr: m[3], file, start, end: start + m[3].length });
  }
  return out;
}
function appJsxFiles() {
  return readdirSync(join(ROOT, 'app'), { recursive: true })
    .map(String).filter((f) => f.endsWith('.jsx'))
    .map((f) => join('app', f).split('\\').join('/')); // Windows 러너의 역슬래시 정규화
}

const sources = new Map(); // file → 주석 제거본
for (const f of ['app/globals.css', ...appJsxFiles()]) sources.set(f, stripComments(readFileSync(join(ROOT, f), 'utf8')));
const decls = [...sources.entries()].flatMap(([f, src]) => (f.endsWith('.css') ? collectCss(src, f) : collectJsx(src, f)));

test('수집 스위프가 비지 않는다 — 빈 목록 통과(무효 게이트) 방지', () => {
  // 하한 = 현재 개수 그대로(슬랙 0 — 분리 검수: 슬랙 2칸이 조용한 소실을 허용했다).
  // 정당하게 줄이는 리팩터라면 보정 경로가 실제로 준 것인지 확인하고 이 숫자를 함께 내린다.
  assert.ok(decls.length >= 17, `치수 선언 ${decls.length}곳(현재 17) — 수집 정규식이 소스와 어긋났는지 확인`);
  const has = (f, n) => assert.ok(decls.filter((d) => d.file === f).length >= n, `${f}에 vh 치수 ${n}곳 이상이어야 한다`);
  has('app/globals.css', 8); // body·.shell·.side·기억분할·팝오버·vault 계열
  has('app/c/[ws]/crew/[slug]/page.jsx', 2); // 채팅 그리드 + 모달 86vh
  has('app/c/[ws]/room/page.jsx', 1); // 회의실 채팅 그리드
  has('app/c/[ws]/compete/page.jsx', 1); // 경쟁 채팅 그리드
});

test('역방향 스캔 — 소스의 모든 vh 토큰이 수집된 치수 선언 안에 있다(수집 우회 = red)', () => {
  // 치수 계열 밖의 vh(다른 속성·CSS 변수 간접·새 표기)는 ①의 불변식 밖으로 새는 구멍이다.
  // 정당한 새 용법이면 수집기를 넓혀 불변식 아래로 들여온다 — 예외 허용목록은 두지 않는다.
  for (const [file, src] of sources) {
    const ranges = decls.filter((d) => d.file === file);
    for (const m of src.matchAll(/(\d*\.?\d+)[dsl]?vh\b/gi)) { // dvh·svh·lvh 변종도 토큰으로 — 간접 우회 방지(재검수 LOW-A)
      const inside = ranges.some((r) => m.index >= r.start && m.index < r.end);
      assert.ok(inside, `${file}:${lineOf(src, m.index)} — 수집되지 않은 vh 토큰 '${m[0]}' (치수 선언 밖이거나 수집기가 모르는 표기)`);
    }
  }
});

test('배율 1.25·2.0에서 모든 vh 치수가 화면 안 — 나눗셈 롤백은 z배 넘침으로 red', () => {
  for (const d of decls) {
    for (const z of ZOOMS) {
      const device = evalSize(d.expr, { z }) * z; // zoom이 곱해진 실제 화면 px
      assert.ok(device > 0, `${d.where} ${d.prop}: ${d.expr} — 0 이하(${device.toFixed(1)}px)`);
      assert.ok(device <= V + 1e-6,
        `${d.where} ${d.prop}: ${d.expr} — 배율 ${z}에서 ${device.toFixed(1)}px > 뷰포트 ${V}px (vh는 zoom과 안 곱해지므로 / var(--z, 1) 보정 필요)`);
    }
  }
});

test('배율 1(변수 미설정)은 --z=1 명시와 동일 — var 폴백(, 1)이 종전 레이아웃을 보존한다', () => {
  for (const d of decls) {
    assert.equal(evalSize(d.expr, {}), evalSize(d.expr, { z: 1 }), `${d.where}: ${d.expr}`);
  }
});

/* ── ② zoom-math 행동 (graph2d evPos · 리사이저 폭) ─────────────────── */

test('zoomedEvPos — 배율 1.25에서 뷰포트 px 이벤트를 CSS px 좌표로 환산한다', () => {
  // 배율 1.25: rect(뷰포트 px)는 clientWidth(CSS px)의 1.25배 → k = 0.8
  const rect = { left: 100, top: 50, width: 1000 };
  assert.deepEqual(zoomedEvPos(rect, 800, 600, 250), [400, 160]); // (600-100)*0.8, (250-50)*0.8
  // 무보정(k=1)이면 [500, 200] — 재검수 HIGH-2의 "최대 ~150px 어긋남"이 이 차이다
});

test('zoomedEvPos — 배율 1은 항등, rect 미레이아웃(width 0)은 k=1 관용', () => {
  assert.deepEqual(zoomedEvPos({ left: 100, top: 50, width: 800 }, 800, 600, 250), [500, 200]);
  assert.deepEqual(zoomedEvPos({ left: 100, top: 50, width: 0 }, 800, 600, 250), [500, 200]);
});

test('dispZoom — documentElement.style.zoom을 읽고, 미설정(배율 1)은 1', (t) => {
  const fake = (zoom) => { globalThis.document = { documentElement: { style: { zoom } } }; };
  t.after(() => { delete globalThis.document; });
  fake('1.25'); assert.equal(dispZoom(), 1.25);
  fake(''); assert.equal(dispZoom(), 1);
  fake(undefined); assert.equal(dispZoom(), 1);
});

test('clampPaneW — 상한이 뷰포트 폭의 60%를 배율로 나눈 CSS px, 하한 360', (t) => {
  const fake = (innerWidth, zoom) => {
    globalThis.window = { innerWidth };
    globalThis.document = { documentElement: { style: { zoom } } };
  };
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  fake(2250, '1.25');
  assert.equal(clampPaneW(5000), 1080, '상한 = round(2250 / 1.25 × 0.6) — 무보정이면 1350으로 뷰포트를 넘는다');
  assert.equal(clampPaneW(100), PANE_W_MIN);
  assert.equal(clampPaneW(700.4), 700, '반올림 유지(종전 동일)');
  fake(1440, ''); // 배율 1 — #334 이전 산식과 완전 동일
  assert.equal(clampPaneW(5000), 864, '상한 = round(1440 × 0.6)');
});

/* ── ③ 호출부 잠금 ─────────────────────────────────────────────── */

const graph2d = readFileSync(join(ROOT, 'app/c/[ws]/graph2d.jsx'), 'utf8');
const splitPane = readFileSync(join(ROOT, 'app/c/[ws]/split-pane.jsx'), 'utf8');
const vaultPage = readFileSync(join(ROOT, 'app/c/[ws]/vault/page.jsx'), 'utf8');

test('graph2d 구간 불변식 — 생좌표 읽기는 evPos(zoomedEvPos 위임) 한 곳뿐', () => {
  assert.match(graph2d, /import\s*\{[^}]*\bzoomedEvPos\b[^}]*\}\s*from\s*['"]\.\/zoom-math\.mjs['"]/);
  const evposLine = /const evPos = \(e\) =>\s*zoomedEvPos\(\s*canvas\.getBoundingClientRect\(\),\s*canvas\.clientWidth,\s*e\.clientX,\s*e\.clientY,?\s*\)/;
  assert.match(graph2d, evposLine, 'evPos가 zoomedEvPos로 위임해야 한다 — 수학 자체는 ② 단위 테스트가 잠근다');
  // 정의부를 제외한 나머지에 생좌표·rect 읽기가 없어야 한다 — 핸들러 하나만 #334 이전으로
  // 되돌리는 변이(분리 검수 실증: onDown 단독 롤백이 초록이었다)도 여기서 red가 된다.
  // 새 좌표 소비자는 evPos를 쓰거나, 환산이 필요 없는 값이면 이 단언을 근거와 함께 넓힌다.
  assert.doesNotMatch(graph2d.replace(evposLine, ''), /getBoundingClientRect|clientX|clientY|pageX|pageY|offsetLeft|offsetTop/,
    '이벤트 좌표는 evPos 경유로만 — 생좌표(동의어 포함)는 배율에서 최대 ~150px 어긋난다(재검수 HIGH-2)');
});

test('split-pane 배선 — 리사이즈 폭이 (innerWidth − clientX) ÷ dispZoom()으로 클램프에 들어간다', () => {
  // 임포트 핀은 두 이름 다 — dispZoom만 남기고 clampW를 로컬 재정의(배율 상한 소실)하는
  // 변이가 초록이었다(분리 검수 실증).
  assert.match(splitPane, /import\s*\{(?=[^}]*\bdispZoom\b)(?=[^}]*\bclampPaneW\b)[^}]*\}\s*from\s*['"]\.\/zoom-math\.mjs['"]/); // 이름 순서 무관(lookahead) — 재정렬 거짓 red 방지
  assert.match(splitPane, /clampW\(\s*\(window\.innerWidth - e\.clientX\)\s*\/\s*dispZoom\(\)\s*,?\s*\)/,
    '커서 좌표(뷰포트 px)→패널 폭(CSS px) 나눗셈 제거 변이는 여기서 잡는다');
});

test('vault 트리 리사이저 배선 — 커서 x를 dispZoom()으로 나눠 CSS px로(#334 보정 경로 7)', () => {
  assert.match(vaultPage, /import\s*\{[^}]*\bdispZoom\b[^}]*\}\s*from\s*['"]\.\.\/zoom-math\.mjs['"]/);
  assert.match(vaultPage, /e\.clientX[^\n]*\/\s*dispZoom\(\)/,
    '트리 폭 드래그의 배율 나눗셈 제거 변이는 여기서 잡는다 — dispZoom 자체 무력화는 ②가 잡는다');
});

/* ── 인접 핀: 손짠 listbox 패널 클램프 (#359 검수 별건 — 슬래시 커맨더·멘션) ──────
   공용 DropUp이 아닌 손으로 짠 팝오버 2곳이 배율 2 × 1280에서 뷰포트를 뚫었다(검수 실측:
   슬래시 [988,1628]·멘션 [988,1828] vs cw 1264). #359의 dropUpClamp를 재사용해 같은 패턴
   (useIsoLayoutEffect 측정 → shift/maxW → ref 적용 + 재측정 리스너)으로 잠근다. */
const crewPage = readFileSync(join(ROOT, 'app/c/[ws]/crew/[slug]/page.jsx'), 'utf8');
const roomPage = readFileSync(join(ROOT, 'app/c/[ws]/room/page.jsx'), 'utf8');

test('크루 슬래시 커맨더 — dropUpClamp 임포트·측정 구간·패널 적용이 배선돼 있다', () => {
  assert.match(crewPage, /import\s*\{[^}]*\bdropUpClamp\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/zoom-math\.mjs['"]/);
  assert.match(crewPage, /useIsoLayoutEffect\(\(\) => \{[\s\S]*?if \(!slashToken\)[\s\S]*?const measure = \(\) => \{[\s\S]*?setSlashClamp\(dropUpClamp\(/,
    '열림 시점 측정 구간 — dropUpClamp 배선 제거 변이는 여기서 red');
  // 첫 렌더(maxW 0)는 무제한(undefined)이어야 자연 폭을 측정할 수 있다 — 디자인 상한(480)이
  // 폴백으로 걸리면 naturalW가 그 값으로 캐시돼 실제 자연 폭과 어긋난다(실측: shift −290이지만
  // 패널 right 1507 > cw 1264). 측정 후에는 min(maxW, 디자인상한)으로 양쪽 상한을 적용한다.
  assert.match(crewPage, /left: slashClamp\.shift,[\s\S]*?maxWidth: slashClamp\.maxW \? Math\.min\(slashClamp\.maxW, \d+\) : undefined/,
    '패널 적용 — 첫 렌더 무제한(자연 폭 측정) + 이후 min(뷰포트, 디자인) 상한');
});

test('회의실 멘션 — dropUpClamp 임포트·측정 구간·패널 적용이 배선돼 있다', () => {
  assert.match(roomPage, /import\s*\{[^}]*\bdropUpClamp\b[^}]*\}\s*from\s*['"]\.\.\/zoom-math\.mjs['"]/);
  assert.match(roomPage, /useIsoLayoutEffect\(\(\) => \{[\s\S]*?if \(!mentionOpen\)[\s\S]*?const measure = \(\) => \{[\s\S]*?setMentionClamp\(dropUpClamp\(/,
    '열림 시점 측정 구간 — dropUpClamp 배선 제거 변이는 여기서 red');
  assert.match(roomPage, /left: mentionClamp\.shift,[\s\S]*?maxWidth: mentionClamp\.maxW \? Math\.min\(mentionClamp\.maxW, \d+\) : undefined/,
    '패널 적용 — 첫 렌더 무제한(자연 폭 측정) + 이후 min(뷰포트, 디자인) 상한');
});

/* ── ④ DropUp 열림 패널 좌우 클램프 (#357 검증 실측 이관 — 선재 결함) ──────────
   패널(트리거 래퍼 기준 absolute)은 폭이 아래로 minWidth(≥190), 위로 무상한(라벨 nowrap
   max-content — #357 검수 실측 404 CSS px)이라 좁은 열·우측 끝 트리거에서 트리거 왼쪽 끝부터
   뻗어 뷰포트를 뚫었다(실측 en·1280 창 배율 2: 패널 right 1415 > clientWidth 1264 → 문서 sw 1415).
   시프트가 패널 **실측** offsetWidth 기준이라 max-content 성장분까지 회수되고, 폭 상한(maxW)도
   같은 계산부가 clientWidth로 낸다(100vw 근사는 스크롤바 폭만큼 새는 것을 라이브 실측 1280 vs
   cw 1264로 확인 — CSS 상한 대신 JS 상한).
   계산부(dropUpClamp)는 ② 방식의 실호출로, ui.jsx의 배선·적용은 ③ 방식의 소스 핀으로 잠근다.
   실동작(소비자 9곳의 열림 상태)은 해당 PR의 라이브 측정이 담당. */

test('dropUpClamp — 배율 2·1280 창의 실측 우측 넘침(right 1415)을 안쪽 시프트로 회수한다', (t) => {
  const fake = (zoom) => { globalThis.document = { documentElement: { style: { zoom } } }; };
  t.after(() => { delete globalThis.document; });
  fake('2');
  // 트리거 left 1035(뷰포트 px) + 패널 190 CSS px × 2 = right 1415 > 1264 − 여백 16 → dx = −167 뷰포트 px.
  // 반환은 CSS px(÷2) — 나눗셈 제거 변이(뷰포트 px 그대로 반환)는 여기서 red. maxW = (1264−32)/2.
  assert.deepEqual(dropUpClamp({ left: 1035, right: 1247 }, 1264, 190), { shift: Math.round(-167 / 2), maxW: 616 });
  // 같은 배율에서 넘침이 없으면 0 — 일반 폭의 소비자 9곳은 종전 위치 그대로여야 한다.
  assert.equal(dropUpClamp({ left: 200, right: 412 }, 1264, 190).shift, 0);
  // 라벨 max-content 성장(자연 폭 700 CSS)이 상한(616)으로 잘리고, 잘린 유효 폭 기준으로
  // 왼쪽 여백(8 CSS = 16 뷰포트 px)까지 민다 — 라이브 실측 red(sw 1280>1264)를 잡은 케이스.
  assert.deepEqual(dropUpClamp({ left: 988, right: 1200 }, 1264, 700), { shift: -486, maxW: 616 });
});

test('dropUpClamp — 배율 1(미설정) 항등·우측 앵커·협폭 왼쪽 여백 우선 구제', (t) => {
  const fake = (zoom) => { globalThis.document = { documentElement: { style: { zoom } } }; };
  t.after(() => { delete globalThis.document; });
  fake('');
  assert.equal(dropUpClamp({ left: 100, right: 320 }, 1264, 190).shift, 0, '배율 1 무넘침 = 0(종전 불변)');
  assert.equal(dropUpClamp({ left: 1100, right: 1250 }, 1264, 190).shift, -34, '우측 넘침 1290 → 1256으로 회수');
  assert.equal(dropUpClamp({ left: 10, right: 150 }, 1264, 190, true).shift, 48, '우측 앵커의 왼쪽 뚫림(−40)을 여백 8까지 밀어낸다');
  // 뷰포트(180) < 패널(190): 상한 164로 잘리고 왼쪽 여백 8에 정렬 — 여백 제거 변이는 shift 0이 되어 red.
  // (maxW 상한 덕에 왼쪽 구제 후 오른쪽 여백이 자동 보장된다 — 좌·우 분기 동시 발화 입력은 구조적으로 없다.)
  assert.deepEqual(dropUpClamp({ left: 0, right: 100 }, 180, 190), { shift: 8, maxW: 164 });
});

test('DropUp 배선 — 그리기 전 실측·자연 폭 캐시·재측정 리스너가 구간째 잠겨 있다', () => {
  // 소스 핀 only의 한계(분리 검수 F3: 가드 무력화·deps [] 변이가 초록) 봉합 — 낱개 문자열이 아니라
  // 닫힘 리셋부터 클린업까지 배선의 하중 지점을 구간 불변식으로 잠근다. 행동 하네스(jsdom) 부재
  // 환경에서의 차선이며, 수학 자체는 위 실호출 테스트가 잠근다.
  const ui = stripComments(readFileSync(join(ROOT, 'app/ui.jsx'), 'utf8'));
  assert.match(ui, /import\s*\{[^}]*\bdropUpClamp\b[^}]*\}\s*from\s*['"]\.\/c\/\[ws\]\/zoom-math\.mjs['"]/);
  // 그리기 전 훅 + 닫힘 리셋(클램프·자연 폭 캐시) — useEffect 회귀(F1)·리셋 제거(F3a: 재열기 시
  // 상한 걸린 폭을 자연 폭으로 오측)가 여기서 red.
  assert.match(ui, /useIsoLayoutEffect\(\(\) => \{\s*if \(!open\) \{ setEntered\(false\); setClamp\(\{ shift: 0, maxW: 0 \}\); naturalW\.current = 0; return; \}/,
    '그리기 전 실측(useIsoLayoutEffect) + 닫힘 리셋 — 클램프 전 프레임이 문서 폭을 늘리지 않아야 한다');
  assert.match(ui, /const useIsoLayoutEffect = typeof window === 'undefined' \? useEffect : useLayoutEffect;/,
    'SSR 안전 별칭의 정의 — 별칭만 남기고 useEffect로 돌리는 변이는 위 호출부 핀이 잡는다');
  // 측정 구간 — 가드·자연 폭 1회 캐시·실인자·즉시 1회 호출까지 한 덩어리(F3b: if(false) 무력화 red).
  assert.match(ui, /const measure = \(\) => \{\s*if \(!boxRef\.current \|\| !panelRef\.current\) return;\s*if \(!naturalW\.current\) naturalW\.current = panelRef\.current\.offsetWidth;\s*setClamp\(dropUpClamp\(boxRef\.current\.getBoundingClientRect\(\),\s*document\.documentElement\.clientWidth,\s*naturalW\.current, align === 'right'\)\);\s*\};\s*measure\(\);/,
    '열림 시점 실측 → 클램프 계산 배선 — 수학 자체는 위 실호출 테스트가 잠근다');
  // 재측정 배선 + deps — 열린 채 배율·창 크기 변경의 낡은 클램프(F2), deps [] 전면 무력화(F3c)가 red.
  assert.match(ui, /window\.addEventListener\('resize', measure\);\s*window\.addEventListener\('argo:zoom', measure\);/,
    '열린 채 배율(cmd +/-)·리사이즈 재클램프 — 제거하면 F2 실측 결함(right 2253 > cw 1264)이 되돌아온다');
  assert.match(ui, /window\.removeEventListener\('argo:zoom', measure\);\s*\};\s*\}, \[open, align\]\);/,
    '클린업 대칭 + deps [open, align] — deps 비우기 변이는 여기서 red');
});

test('DropUp 적용 — 패널(listbox) ref·앵커쪽 시프트·min·max 동시 클램프가 걸려 있다', () => {
  const ui = stripComments(readFileSync(join(ROOT, 'app/ui.jsx'), 'utf8'));
  assert.match(ui, /<div ref=\{panelRef\} className="card card-float" role="listbox"/,
    '실측 ref는 listbox 패널 그 자체여야 한다(등록 앵커 = 발행처 교훈 — 래퍼로 옮기면 실폭이 아니다)');
  assert.match(ui, /\[align === 'right' \? 'right' : 'left'\]: align === 'right' \? -clamp\.shift : clamp\.shift/,
    '시프트가 앵커 쪽 오프셋으로 적용 — 오프셋 0 고정 복원 변이는 여기서 red');
  // min > max면 min이 이겨 클램프 무효(#350 회의실 교훈) — 실측 후엔 min도 maxW 아래로 동시 캡.
  assert.match(ui, /minWidth: clamp\.maxW \? Math\.min\(Math\.max\(width, 190\), clamp\.maxW\) : Math\.max\(width, 190\)/,
    '극단 협폭 바닥 — minWidth 단독 복원(고정 190) 변이는 여기서 red');
  assert.match(ui, /maxWidth: clamp\.maxW \|\| undefined/,
    '실측 전(0)엔 자연 폭 측정을 위해 상한 미적용, 실측 후 뷰포트 상한');
});
