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
//  이후 "인접 핀" 섹션들(페이지별 grid 열 잠금 sweep — 쪽지함 등)이 ①과 같은 수집+역방향 문법으로
//  파일 중간에 추가된다. 인라인 스타일 워커가 페이지별로 늘면 통합한다(3벌째 복사 금지).
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
// 문자열 리터럴을 상태로 추적해 리터럴 속 //·/*는 주석으로 오인하지 않는다(#338 재검수 LOW-D:
// 같은 줄 앞쪽 문자열 속 //가 뒤따르는 치수 선언째 지워 원인 안 보이는 하한 red를 만들었다).
//  - 라인 주석은 행 머리·공백 뒤 //만(종전 규칙 유지 — https:// 처럼 앞이 비공백이면 코드).
//  - '·"가 개행까지 안 닫히면 진짜 문자열이 아니다(정규식 속 따옴표·JSX 텍스트 아포스트로피가
//    여는 유령 상태) → 여는 따옴표를 일반 문자로 재해석하고 되감는다. 실측: 이 규칙까지 넣어야
//    ui.jsx의 replace(/"/g, …) 줄이 종전 출력과 일치한다.
//  - 백틱은 여러 줄 통째 보존. 보간 속 주석은 안 지워지지만, 남는 방향(under-strip)의 vh는
//    역방향 스캔이 파일:줄로 시끄럽게 잡는 fail-closed라 허용한다.
function stripComments(src) {
  const out = src.split('');
  let i = 0;
  let prev = '\n'; // 주석·문자열 밖 직전 문자 — 라인 주석의 "행 머리·공백 뒤" 판정용
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      for (let k = i; k < end; k++) if (out[k] !== '\n') out[k] = ' ';
      i = end; prev = ' ';
    } else if (c === '/' && src[i + 1] === '/' && /\s/.test(prev)) {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      for (let k = i; k < end; k++) out[k] = ' ';
      i = end;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1, closed = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; closed = true; break; }
        if (src[j] === '\n' && c !== '`') break;
        j++;
      }
      prev = c;
      i = closed ? j : i + 1; // 미종결이면 여는 따옴표 한 글자만 소비(일반 문자 취급)
    } else {
      prev = c;
      i++;
    }
  }
  return out.join('');
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
  assert.ok(decls.length >= 17, `치수 선언 ${decls.length}곳(현재 17) — 수집 정규식이 소스와 어긋났는지 확인. 같은 줄 앞쪽 리터럴 속 '//'를 stripComments가 주석으로 오인해(문자열 보존 스캐너가 못 보는 형태) 선언째 지웠을 가능성도 본다`);
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

/* ── 인접 핀: 상단바 배율 반응형 (검수 별건 — 미디어쿼리 배율 사각) ─────────────
   미디어쿼리(max-width:900px)는 실 뷰포트 기준이라 배율 2 × 1280(유효 640)에서 미발동, 시계·
   버전·search-pill이 넘쳤다(검수 실측: pill right 1490 > cw 1424). JS 판정(clientWidth ÷ zoom
   < 750)으로 배율 사각을 메워 시계·버전·스페이서 숨김 + pill flex:1 전환. */
test('상단바 배율 반응형 배선 — narrowBar 판정이 시계·버전 숨김과 pill flex:1을 제어한다', () => {
  const layout = stripComments(readFileSync(join(ROOT, 'app/c/[ws]/layout.jsx'), 'utf8'));
  assert.match(layout, /setNarrowBar\(document\.documentElement\.clientWidth\s*\/\s*z\s*<\s*750\)/,
    'narrowBar 판정 — clientWidth ÷ zoom < 750(배율 인지 유효 폭)');
  assert.match(layout, /window\.addEventListener\('argo:zoom',\s*check\)/,
    'argo:zoom 리스너 — 배율 변경 시 재판정');
  assert.match(layout, /\{!narrowBar && <Clock \/>\}/,
    'narrowBar일 때 시계 숨김');
  assert.match(layout, /className="search-pill" style=\{narrowBar \? \{ flex: 1, width: 'auto' \} : undefined\}/,
    'narrowBar일 때 pill이 flex:1로 전환');
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

/* ── 인접 핀: 쪽지함(mail) 작성 폼 CC 행 가로 넘침(#350·#357 동종 선재 결함) ─────────
   배율 2(1280 창 = cw 1264)·en에서 크루 이름이 초장문(합성 60자 실측)이면 CC 칩(.chip nowrap)의
   min-content가 CC 그룹 → 작성 폼 → 페이지 열(전부 무템플릿 grid)을 사슬로 부풀려 문서
   sw 1832 > cw 1264 (실측 — DropUp 패널 닫힘 상태·패널 기여 0. 일반 길이 이름에서는 초록이라
   심각도는 초장문 이름 한정). microlabel 돌출은 원인이 아니라 부풀려진 트랙에 늘려진 결과
   (.microlabel은 nowrap 아님 — 트랙이 잠기면 스스로 줄바꿈).
   소스 수준 잠금 — 실동작 검증은 해당 PR의 라이브 측정(1280 × 배율 2 × en·ko, 60자/일반 이름
   A/B)이 담당. 수집기는 중괄호 깊이 워커 + 역방향 스캔(fail-closed) — #357 재검수(M-6·M-7)가
   세운 보강판과 같은 의미: 정규식 [^}]*는 값 속 스프레드의 }에서 끊기고, 탐지 홑따옴표 고정은
   display:"grid"가 지나가며, 뒤 선언 덮어쓰기는 마지막 승이라 앞 잠금이 초록인 채 무효가 된다.
   워커 이름은 대상 접두(mail)로 분리 — #357이 같은 파일 중간에 넣는 동명 워커와 합본 시
   ESM 중복 선언이 되지 않게(병합 순서 자유 전제, 양쪽 머지 후 통합 후보). */
function mailInlineStyles(src) {
  // style={{ … }} 전체 구간을 중괄호 깊이로 수집 — 값 속 ${…}·스프레드 {}는 짝이 맞아 그대로 통과.
  const out = [];
  let i = 0;
  while ((i = src.indexOf('style={{', i)) !== -1) {
    let depth = 2;
    let j = i + 8; // 'style={{'.length — 여는 중괄호 2개가 이미 열린 상태
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    out.push({ start: i, end: j, body: src.slice(i, j) });
    i = j;
  }
  return out;
}

test('mail grid 열 잠금 sweep — 모든 인라인 display:*grid*는 minmax(0,…) 열 1회 선언이어야 한다', () => {
  const src = sources.get('app/c/[ws]/mail/page.jsx');
  const styles = mailInlineStyles(src);
  // 탐지는 리터럴 3종·삼항 표기·inline-grid까지(값 자리 어디든 grid 토큰) — 리터럴 홑따옴표 고정은
  // display:"grid"·조건부 grid가 수집·역방향 양쪽을 지나가는 fail-open이었다(분리 검수 MEDIUM-2
  // 실측: 무잠금 inline-grid도 sw 1482 동일 넘침).
  const GRID_RE = /display:\s*[^,}]*grid/;
  const grids = styles.filter((s) => GRID_RE.test(s.body));
  assert.ok(grids.length >= 4, `grid 인라인 ${grids.length}곳(현재 4) — 수집 워커가 소스와 어긋났는지 확인(빈 수집 = 무효 게이트)`);
  for (const g of grids) {
    // 존재 검사가 아니라 값 검사 — 'gridTemplateColumns: 1fr'은 minmax(auto,1fr)이라 min 트랙이
    // auto로 되살아나 무템플릿과 완전 동일하게 부푼다(#350 검수 변이·브라우저 실측). 값 표기는
    // 따옴표 3종 수용, 선언은 정확히 1회 — 뒤 선언·스프레드 덮어쓰기(마지막 승) 우회 차단.
    // 고정 width 탈출구는 두지 않는다 — 분리 검수 MEDIUM-1 실측 반증: 무잠금 grid는 고정 width를
    // 줘도 트랙이 자식 min-content로 부푼다(width 300 실측 sw 1482 — 트랙은 컨테이너 폭에 안 잡힘).
    const colDecls = (g.body.match(/gridTemplateColumns/g) ?? []).length;
    assert.ok(colDecls === 1 && /gridTemplateColumns:\s*['"`][^'"`]*minmax\(0,/.test(g.body),
      `mail:${lineOf(src, g.start)} — 암묵/auto-min 열 grid: gridTemplateColumns는 정확히 1회 선언에 minmax(0,…)를 포함해야 한다(선언 ${colDecls}회 — 자식 min-content로 트랙이 부풀어 배율 2에서 문서 가로 넘침, 고정 width도 못 막는다)`);
  }
  // 역방향 스캔 — 소스의 모든 grid성 display 토큰은 수집된 style={{…}} 구간 안에 있어야 한다.
  // 워커가 못 보는 인라인 표기는 여기서 red. 한계(정직 표기): 상수 객체 간접(const s = {display:'grid'})
  // 은 style={{ 구간 밖이라 이 스캔이 red를 내며 워커 확장을 강제한다 — 단 grid 토큰 자체가 없는
  // 파생 표기(변수에 담긴 문자열 조립 등)까지는 못 본다.
  for (const m of src.matchAll(/display:\s*[^,}]*grid/g)) {
    const inside = styles.some((s) => m.index >= s.start && m.index < s.end);
    assert.ok(inside, `mail:${lineOf(src, m.index)} — 수집되지 않은 display:…grid (style={{…}} 인라인 밖이거나 워커가 모르는 표기)`);
  }
});

test('mail CC 칩 잠금 핀 — 내부 span ellipsis(하중) + 칩 maxWidth(이중 방어) + title 원문', () => {
  const src = sources.get('app/c/[ws]/mail/page.jsx');
  // 하중은 내부 span(minWidth 0 + ellipsis + nowrap 명시) — flex 컨테이너(버튼)에는 text-overflow가
  // 직접 안 걸린다(분리 검수 실측: span 무력화 시 ellipsis 없는 하드 클립). 버튼 maxWidth 100%는
  // 이중 방어(단독 롤백 무영향 실측), title은 잘린 원문 확인 통로(같은 파일 목록 표 관례).
  assert.match(src, /className="chip" title=\{a\.name\}\s+style=\{\{ cursor: 'pointer', maxWidth: '100%', minWidth: 0,/,
    'CC 칩 상한(이중 방어)·title 제거 변이는 여기서 red');
  assert.match(src, /<span style=\{\{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' \}\}>\{a\.name\}<\/span>/,
    '칩 라벨 맨몸 복원 변이({a.name} 직접 노출)는 여기서 red — 하중 지점(ellipsis + nowrap 명시)');
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

/* ── 인접 핀: 상단바 search-pill 축소 불변식(PR #340) ─────────────────────
   배율 2(유효 712px, 1열 폭)에서 pill의 자동 최소 폭(min-width:auto)이 input 고유
   기본 폭(size 기본값 20 → ~140px)에 걸려 문서 가로 넘침을 만든다(실측 1497>1424).
   min-width:0 선언이 리팩터에 조용히 지워지는 변이를 소스 수준에서 잠근다 —
   실동작 검증은 PR #340의 라이브 측정(2페이지×3배율)이 담당. */
test('search-pill 기본 규칙에 min-width: 0 — 좁은 유효폭 상단바 가로 넘침 핀', () => {
  const css = sources.get('app/globals.css');
  const blocks = [...css.matchAll(/(?:^|\n)\.search-pill\s*\{([^}]*)\}/g)];
  assert.equal(blocks.length, 1,
    '.search-pill 단독 기본 규칙은 정확히 1개여야 한다 — 규칙이 쪼개지면 이 핀의 수집 표면부터 넓힌다(fail-closed)');
  assert.match(blocks[0][1], /min-width:\s*0\s*;/,
    'min-width:0 제거 시 pill이 ~189px에서 축소 정지 → 배율 2에서 문서 가로 스크롤 재발(PR #340 실측)');
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
