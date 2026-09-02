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
import { stripComments } from './helpers/strip-comments.mjs'; // 정본 — 문자열 상태 추적 하드닝판

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
  assert.ok(decls.length >= 16, `치수 선언 ${decls.length}곳(현재 16) — 수집 정규식이 소스와 어긋났는지 확인`);
  const has = (f, n) => assert.ok(decls.filter((d) => d.file === f).length >= n, `${f}에 vh 치수 ${n}곳 이상이어야 한다`);
  // 크루·경쟁·회의실의 채팅 그리드 높이(100vh 계열)는 폰 폭 레일 스택을 위해 .chat-cols(globals)로 이동 —
  // JSX 쪽 하한을 그만큼 내린다(크루 2→1·경쟁 1→0 삭제·회의실 1→0 삭제, globals는 셋이 한 선언을
  // 공유하므로 10 그대로 — 총합 17→16은 정본 단일화로 인한 정당한 감소, 소실 아님)
  has('app/globals.css', 10); // body·.shell·.side·기억분할·팝오버·vault·.chat-cols(높이+레일 상한) 계열
  has('app/c/[ws]/crew/[slug]/page.jsx', 1); // 모달 86vh
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
test('상단바 배율 반응형 배선 — 적재 조절은 임계 폭이 아니라 넘침 측정으로 한다', () => {
  const layout = stripComments(readFileSync(join(ROOT, 'app/c/[ws]/layout.jsx'), 'utf8'));
  // 종전에는 유효 폭 임계(clientWidth ÷ zoom < 750/1100)로 접었는데, 임계는 라벨 길이·언어를 못
  // 따라가는 마법수라 영어 UI·긴 크루 이름에서 겹침이 임계 위로 올라갔다(#383 분리 검수 2R HIGH-2
  // 실측: 영어 1150에서 15px, 긴 라벨 1200에서 43px). scrollWidth/clientWidth는 배율이 적용된
  // 레이아웃 픽셀이라 유효 폭 환산 자체가 필요 없다.
  assert.match(layout, /bar\.scrollWidth > bar\.clientWidth/, '판정 = 상단바 실제 넘침');
  assert.doesNotMatch(layout, /clientWidth \/ z\b/, '유효 폭 임계 판정 잔존 금지(두 축이 갈라진다)');
  assert.match(layout, /window\.addEventListener\('argo:zoom', fitBar\)/,
    'argo:zoom 리스너 — 배율 변경 시 재판정');
  // 접기는 CSS가 실행한다 — React 조건부면 "가장 넓은 상태로 되돌린 뒤 측정"이 동기적으로 성립하지 않는다
  assert.doesNotMatch(layout, /narrowBar/, 'narrowBar 상태 잔존 금지');
  assert.match(layout, /<Clock \/>/, '시계는 무조건 렌더 — 접기는 :root[data-narrow-bar]가');
  assert.match(layout, /<label className="search-pill">/, 'pill 인라인 스타일 제거');
});
/* ── 인접 핀: 경쟁 시안(compete) 좁은 유효 폭 가로 넘침(회의실 동종 선재 결함) ─────────
   배율 2(실측 1424px 창 = 유효 712 CSS px)에서 compete 본문 열이 부풀어 문서 가로 스크롤을
   만들었다(실측 scrollWidth 1428 > clientWidth 1408 — 회의실 검수에서 발견). 뿌리는 회의실과
   동일: 무템플릿 grid의 암묵 auto 열 트랙은 자식 min-content(컴포저 textarea 고유폭·nowrap
   상태 칩)만큼 자라고, 아이템의 minWidth:0은 바깥 트랙만 지킬 뿐 자기 내부 트랙은 못 지킨다.
   소스 수준 잠금 — 실동작 검증은 해당 PR의 라이브 측정(1424·1280 창 × 배율 2 × 상태·언어별)이
   담당. 수집기는 중괄호 깊이 워커 — 종전 정규식 [^}]*는 값 속 템플릿 리터럴 ${…}·스프레드의
   }에서 끊겨 시안 나열·시안 카드 2곳이 무보호였다(분리 검수 M-3·M-4 실증: 잠금 삭제 변이 초록).
   수집 누락은 역방향 스캔이 fail-closed로 막는다(① vh 스캔과 동형 장치). */
function collectInlineStyles(src) {
  // style={{ … }} 전체 구간을 중괄호 깊이로 수집 — 값 속 ${…}·스프레드 {}는 짝이 맞아 그대로 통과.
  // 한계: 따옴표 문자열 안의 홑중괄호는 짝을 깨뜨린다(현 소스에 없음 — 생기면 아래 개수 핀과
  // 역방향 스캔이 시끄럽게 실패해 워커 확장을 강제한다).
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

test('compete grid 열 잠금 sweep — 모든 인라인 display:grid는 minmax(0,…) 열 또는 고정 폭이어야 한다', () => {
  const src = sources.get('app/c/[ws]/compete/page.jsx');
  const styles = collectInlineStyles(src);
  // 탐지는 따옴표 3종 — 값 표기만 3종 받고 탐지기를 홑따옴표로 두면 display:"grid"가 수집·역방향
  // 스캔 양쪽을 지나가는 비대칭 사각이 생긴다(재검수 M-7 실증).
  const GRID_RE = /display:\s*['"`]grid['"`]/g;
  const grids = styles.filter((s) => { GRID_RE.lastIndex = 0; return GRID_RE.test(s.body); });
  // 하한 9→8 — 페이지 2분할 grid(레일+본문)가 .chat-cols(globals 정본)로 이관된 정당 감소(#366 재상륙), 소실 아님
  assert.ok(grids.length >= 8, `grid 인라인 ${grids.length}곳(현재 8) — 수집 워커가 소스와 어긋났는지 확인(빈 수집 = 무효 게이트)`);
  for (const g of grids) {
    // 존재 검사가 아니라 값 검사 — 'gridTemplateColumns: 1fr'은 minmax(auto,1fr)이라 min 트랙이
    // auto로 되살아나 무템플릿과 완전 동일하게 부푼다(회의실 검수 변이·브라우저 실측). 값 표기는
    // 홑따옴표·백틱(repeat 템플릿 리터럴)·쌍따옴표 모두 수용(검수 L-2).
    // 선언은 정확히 1회 — 뒤 선언·스프레드 덮어쓰기는 마지막 승이라 앞 잠금이 초록인 채 무효가
    // 된다(재검수 M-6 실증: 끝에 ...{ gridTemplateColumns: '1fr' } 주입이 통과했었다).
    const colDecls = (g.body.match(/gridTemplateColumns/g) ?? []).length;
    // 허용 2형: ①minmax(0,…) ②minmax(min(Npx, 100%),…) — ②는 min이 컨테이너를 못 넘는
    // 클램프형(시안 나열 grid의 협폭 가독 최소폭, #358). 맨 px min(minmax(180px,…))은
    // 컨테이너보다 넓어질 수 있어 계속 red — 100% 캡 완화 변이를 이 스위프가 잡는다.
    const lockedCols = /gridTemplateColumns:\s*['"`][^'"`]*minmax\(0,/.test(g.body)
      || /gridTemplateColumns:\s*['"`][^'"`]*minmax\(min\(\d+px, 100%\),/.test(g.body);
    const locked = colDecls === 1 && lockedCols;
    assert.ok(locked || (colDecls === 0 && /\bwidth:\s*\d/.test(g.body)),
      `compete:${lineOf(src, g.start)} — 암묵/auto-min 열 grid: gridTemplateColumns는 정확히 1회 선언에 minmax(0,…) 또는 minmax(min(Npx, 100%),…)를 포함하거나(고정 px와 혼용 가능), 열 선언 없이 고정 소폭 width(아이콘 버튼류)여야 한다(자식 min-content로 트랙이 부풀어 배율 2에서 문서 가로 넘침 — 덮어쓰기 ${colDecls}회 선언도 여기서 red)`);
  }
  // 역방향 스캔 — 소스의 모든 display:grid 토큰은 수집된 style={{…}} 구간 안에 있어야 한다.
  // 워커가 못 보는 표기로 grid가 들어오면 여기서 red(수집 우회 = 무보호 grid, 검수 M-4 봉합).
  // 정당한 새 표기면 예외 목록이 아니라 워커를 넓혀 값 검사 아래로 들여온다.
  for (const m of src.matchAll(/display:\s*['"`]grid['"`]/g)) {
    const inside = styles.some((s) => m.index >= s.start && m.index < s.end);
    assert.ok(inside, `compete:${lineOf(src, m.index)} — 수집되지 않은 display:grid (style={{…}} 인라인 밖이거나 워커가 모르는 표기)`);
  }
});

test('compete 시안 나열·카드 협폭 가독 핀 — auto-fit 적층·헤더 wrap·채택 버튼 세트 복원 변이는 red', () => {
  // 고정 N열(repeat(entrants.length, minmax(0,1fr)))은 배율 2 협폭에서 시안 카드를 37 CSS px까지
  // 눌러 채택 버튼·상태 칩이 이웃 카드 위로 겹친다(비교 불가 — 카드 overflow가 가둬 문서 넘침은
  // 아니라 위 sweep 값검사(minmax(0,)로는 초록인 별개 결함 — 이 핀이 유일 게이트). auto-fit은
  // 들어가는 만큼만 나란히 놓고 나머지를 아랫줄로 보낸다. 최소폭 180 = 종전 3열이 컨테이너
  // 564 CSS px(뷰포트 ≈1126)에서 갖던 카드 폭 — 그 위는 종전과 동일(재검수: 240은 1152·1280의
  // 멀쩡하던 3열을 2+1로 바꿨다). min(…,100%) 캡이 빠지면 180px 미만 컨테이너에서 트랙 min이
  // 컨테이너를 뚫는다(DropUp 클램프와 동형 이유). 앵커는 }}까지 폐합 — 접두 앵커는 후행 스프레드
  // 덮어쓰기 변이에 초록(분리 검수 M-1과 동족 — 이 파일의 다른 핀들과 같은 규율).
  const src = sources.get('app/c/[ws]/compete/page.jsx');
  assert.match(src,
    /gridTemplateColumns: 'repeat\(auto-fit, minmax\(min\(180px, 100%\), 1fr\)\)', gap: 12, alignItems: 'start' \}\}>/,
    '시안 나열 grid 템플릿 변이(표현식 전체 앵커 — 정당한 리팩터면 이 핀을 함께 갱신)');
  // 시안 카드 헤더 wrap — 아바타 24+gap 24+상태 칩(nowrap) 고정 합이 100% 클램프 1열 카드
  // (실측 132 CSS px) 내용 폭을 넘으면 칩이 카드 밖으로 샌다(실측 +3px). 앵커는 Avatar 문맥 포함
  // 표현식 전체 — 동형 형제 flex 행 오타겟 방지.
  assert.match(src,
    /display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 \}\}>\s*<Avatar name=\{e\.name\}/,
    '시안 카드 헤더 wrap 제거 변이 — 협폭에서 상태 칩이 카드 밖으로 되살아난다');
  // 채택 버튼 줄바꿈·세로 자람 — .btn 전역 nowrap이 유일한 비축소 요소라 극단 협폭(실측 en·1280
  // 창 × 배율 2: 카드 58에 버튼 126)에서 카드 밖으로 샌다. 하단 바 새 경쟁 버튼과 동일 세트.
  assert.match(src,
    /style=\{\{ justifySelf: 'start', whiteSpace: 'normal', height: 'auto', minHeight: 28, padding: '4px 12px' \}\}>\s*\{t\('compete\.adopt'\)\}/,
    '채택 버튼 축소 세트 변이(표현식 전체 앵커 — 정당한 리팩터면 이 핀을 함께 갱신)');
});

test('레일 열 양보 클램프 핀(.chat-cols 정본) — 고정 216px 복원·레일 고정 width 변이는 red', () => {
  // #366 재상륙으로 예정대로 이관 완료: 클램프의 정본은 globals .chat-cols다(구 핀 주석 "편입 머지 시
  // 이 표현식·핀을 .chat-cols 템플릿으로 반드시 이관"의 이행). min(216px, 100% - 244px) = 본문 열 바닥
  // 226(시안 최소폭 180 + 카드 패딩 36 + 테두리 2 + 커스텀 스크롤바 8) + gap 18을 지키는 만큼만 레일이
  // 양보(#365 산식 그대로). 배율 축은 미디어쿼리가 못 보므로 intrinsic 클램프가 유일 게이트.
  const css = sources.get('app/globals.css');
  assert.match(css,
    /\.chat-cols \{\n  display: grid; grid-template-columns: min\(216px, 100% - 244px\) minmax\(0, 1fr\);/,
    '.chat-cols 열 템플릿 변이(선언 머리 폐합 앵커 — 정당한 리팩터면 이 핀을 함께 갱신)');
  // 소비처 배선 — 크루·회의실·경쟁 세 페이지가 정본을 실제로 쓴다(클래스 병기 인라인이 이기면 무효 —
  // 인라인 gridTemplateColumns 재선언은 아래 negative가 잡는다).
  for (const f of ['app/c/[ws]/room/page.jsx', 'app/c/[ws]/compete/page.jsx']) {
    assert.match(sources.get(f), /className="chat-cols"/, `${f} — .chat-cols 소비`);
    assert.doesNotMatch(sources.get(f), /className="chat-cols"[^>]*gridTemplateColumns/, `${f} — 병기 인라인 열 재선언 금지(인라인이 정본을 이긴다)`);
  }
  // 크루는 조건식 소비 — 주 화면만 chat-cols, embedded(보조 패널)는 레일 없는 단일 열 인라인이 정당
  assert.match(sources.get('app/c/[ws]/crew/[slug]/page.jsx'),
    /className=\{embedded \? undefined : 'chat-cols'\}/, 'crew — 주 화면 .chat-cols 소비(embedded 제외)');
  // 레일 고정 px width 금지 — 트랙이 216 미만으로 양보할 때 고정 216이면 아이템이 트랙을 넘어 본문
  // 위로 얹힌다(#365 검수 MEDIUM-3 실증). width: auto(≤560 밴드 스택)는 무해라 px만 잠근다.
  assert.doesNotMatch(css, /\.side-rail[^{}]*\{[^}]*\bwidth\s*:\s*\d/,
    '.side-rail CSS 고정 width — 레일 폭은 트랙이 정한다(양보 클램프 무효화 경로)');
  assert.doesNotMatch(sources.get('app/c/[ws]/compete/page.jsx'), /side-rail" style=\{\{[^}]*\bwidth: \d/,
    'compete 레일 인라인 고정 width 금지');
});
test('compete 헤더·카드 축소 규칙 핀 — wrap·ellipsis·overflowWrap 복원 변이는 red', () => {
  const src = sources.get('app/c/[ws]/compete/page.jsx');
  // 헤더 앵커는 compete.header 구간 자체 — 낱개 프로퍼티 앵커는 동형 형제(컴포저 픽커 행 등
  // flexWrap 행 2곳)가 대신 만족시켜 결함 부활 변이에 초록이 된다(회의실 검수 변이 실측과 동족).
  // 라벨은 한 줄 ellipsis(단어별 세로 쌓임 방지), 상태 칩(nowrap)은 wrap으로 아랫줄에.
  assert.match(src,
    /<div style=\{\{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 \}\}>\s*<span className="microlabel" style=\{\{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' \}\}>\{t\('compete\.header'\)\}/,
    '경쟁 헤더 wrap 행 + microlabel ellipsis 구간 변이(표현식 전체 앵커 — 정당한 리팩터면 이 핀을 함께 갱신)');
  // 카드 overflowWrap anywhere — 긴 무공백 토큰(URL·코드 조각)의 카드 내부 가로 스크롤 보정.
  // 넘침은 카드(overflowY:auto)가 가두지만 보정이 조용히 사라지는 것을 막는다. 앵커는 표현식 전체.
  assert.match(src, /className="card" style=\{\{ padding: '16px 18px', overflowY: 'auto', minHeight: 0, overflowWrap: 'anywhere' \}\}/,
    '경쟁 본문 카드 overflowWrap anywhere 제거 변이');
  // 하단 바(열람 중) — 버튼(.btn 전역 nowrap)이 유일한 비축소 요소라 바 wrap + 버튼 줄바꿈·세로
  // 자람 세트가 없으면 en·1280 창 × 배율 2에서 문서 가로 넘침(실측 1335>1264 → 1264=1264).
  // 앵커는 }}까지 폐합 — 접두 앵커는 뒤에 스프레드(...{ flexWrap: 'nowrap' })를 덧붙여 wrap을
  // 죽이는 변이에 초록이었다(분리 검수 M-1 실증).
  assert.match(src, /className="card" style=\{\{ padding: '10px 14px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, fontSize: 12\.5, color: 'var\(--fg-2\)' \}\}/,
    '경쟁 하단 바 wrap 제거·후행 덮어쓰기 변이(표현식 전체 앵커 — 정당한 리팩터면 이 핀을 함께 갱신)');
  assert.match(src, /className="btn btn-primary sm" style=\{\{ whiteSpace: 'normal', height: 'auto', minHeight: 28, padding: '4px 12px' \}\} onClick=\{\(\) => openComp\(null\)\}/,
    '새 경쟁 버튼 축소 세트 변이(표현식 전체 앵커 — 정당한 리팩터면 이 핀을 함께 갱신)');
});

test('compete 픽커 그룹·DropUp 축소 규칙 핀 — flex 자동 최소치 바닥 복원 변이는 red', () => {
  // 열 잠금만으로는 안 닫히는 잔여 결함(실측 1280 창 × 배율 2: 1283>1264): flex 아이템의 자동
  // 최소치(내용 min-content)는 min-width:0으로 층마다 풀어야 하고, 바닥이 있는 모든 층
  // (픽커 그룹 → DropUp 래퍼 → 트리거 버튼)에 각각 필요하다(트랙 잠금 교훈의 flex판).
  // 트리거 상한은 확정 길이 maxWidth: width — min(width, 100%)처럼 %를 섞으면 shrink-to-fit
  // 래퍼 상대라 intrinsic 기여를 못 잡아, 긴 라벨에서 래퍼만 자라는 죽은 폭 156.5px + 바깥클릭
  // 닫기 오동작이 생긴다(분리 검수 H-1 실측 — 그 형태 복원 변이는 이 핀이 red로 잡는다).
  // 그룹 앵커는 }}까지 폐합 — 접두 앵커는 후행 스프레드 덮어쓰기 변이에 초록(분리 검수 M-2).
  const compete = sources.get('app/c/[ws]/compete/page.jsx');
  const groups = compete.match(/display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 \}\}>/g) ?? [];
  assert.equal(groups.length, 2, '픽커 그룹(크루·모델) minWidth:0 폐합 앵커 — 하나라도 빠지거나 뒤에 덮어쓰기가 붙으면 그 그룹의 DropUp 바닥이 문서 넘침으로 되살아난다');
  const ui = sources.get('app/ui.jsx');
  assert.match(ui, /<div ref=\{boxRef\} style=\{\{ position: 'relative', display: 'inline-flex', minWidth: 0 \}\}>/,
    'DropUp 래퍼 minWidth:0 제거 변이(표현식 전체 앵커 — 정당한 리팩터면 이 핀을 함께 갱신)');
  assert.match(ui, /display: 'inline-flex', alignItems: 'center', gap: 7, maxWidth: width, minWidth: 0, opacity: disabled \? 0\.55 : 1 \}\}/,
    'DropUp 트리거 축소 세트 변이 — minWidth:0 제거(좁은 폭 넘침 재발) 또는 % 상한(min(width,100%)) 복원(죽은 폭 H-1 재발) 모두 red');
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

/* ── 인접 핀: 상단바 search-pill 축소 불변식(PR #340 → #383 3R 재기준) ─────
   #340: pill의 자동 최소 폭(min-width:auto)이 input 고유 기본 폭(size 기본값 20 → ~140px)에
   걸려 ~189px에서 축소가 정지, 배율 2에서 문서 가로 넘침(실측 1497>1424). 명시 min-width가
   그 자동 최소 폭을 대체해야 한다.
   #383 3R: 값은 0이 아니라 96px — 0이면 pill이 부족분을 전부 흡수해 접기 트리거(넘침)가 침묵,
   접기 문턱 바로 위 대역에서 입력이 0px로 죽는다(HIGH-1 순환). 96px 정지가 곧 fitBar의 넘침
   신호가 되어 접기가 제때 켜지고, #340의 넘침은 접기 기구가 흡수한다(1440→540 전 구간 실측 0). */
test('search-pill 기본 규칙에 명시 min-width: 96px — 자동 최소 폭 대체 + 접기 트리거 신호', () => {
  const css = sources.get('app/globals.css');
  const blocks = [...css.matchAll(/(?:^|\n)\.search-pill\s*\{([^}]*)\}/g)];
  assert.equal(blocks.length, 1,
    '.search-pill 단독 기본 규칙은 정확히 1개여야 한다 — 규칙이 쪼개지면 이 핀의 수집 표면부터 넓힌다(fail-closed)');
  assert.match(blocks[0][1], /min-width:\s*96px\s*;/,
    '선언 제거 → 자동 최소 폭 ~189px 부활(#340 재발) · 0으로 되돌림 → 접기 트리거 침묵으로 입력 0px(#383 3R HIGH-1 재발)');
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

/* ── 인접 핀: 회의실 좁은 유효 폭 가로 넘침(선재 결함 — #340 분리 검수에서 발견) ─────────
   배율 2(실측 1424px 창 = 유효 712 CSS px)에서 회의실 본문 열이 259.5px로 부풀어 문서 가로
   스크롤을 만들었다(실측 scrollWidth 1507 > 1408). 뿌리: 무템플릿 grid의 암묵 auto 열 트랙은
   자식 min-content(컴포저 textarea 고유폭·메시지 행·nowrap 라벨)만큼 자라고, 아이템의
   minWidth:0은 바깥 트랙만 지킬 뿐 자기 내부 트랙은 못 지킨다. 레일에는 이미 있던
   'minmax(0,1fr)' 관용구가 본문 계열(본문 열·메시지 래퍼·메시지 그리드·컴포저 스택)에 빠져
   있었다. 소스 수준 잠금 — 실동작 검증은 해당 PR의 라이브 측정(1424·1280 창 × 배율 2 ×
   상태 4종: 빈 방·메시지·멘션 패널·보관 열람)이 담당. */
test('room grid 열 잠금 sweep — 인라인 display:grid는 minmax(0,…) 열 또는 고정 폭이어야 한다', () => {
  const src = sources.get('app/c/[ws]/room/page.jsx');
  const grids = [...src.matchAll(/style=\{\{([^}]*display:\s*'grid'[^}]*)\}\}/g)];
  // 하한 9→8 — 바깥 2분할(레일+본문)이 .chat-cols(globals 정본)로 이관된 정당 감소(#376), 소실 아님
  assert.ok(grids.length >= 8, `grid 인라인 ${grids.length}곳(현재 8) — 수집 정규식이 소스와 어긋났는지 확인(빈 수집 = 무효 게이트)`);
  for (const g of grids) {
    // 존재 검사가 아니라 값 검사 — 'gridTemplateColumns: 1fr'은 minmax(auto,1fr)이라 min 트랙이
    // auto로 되살아나 무템플릿과 완전 동일하게 부푼다(검수 변이 실측: '1fr'·'auto' 둘 다
    // 존재 검사에 초록 + 브라우저에서 결함 부활). 열 선언은 minmax(0,…)를 포함해야 한다.
    const cols = g[1].match(/gridTemplateColumns:\s*'([^']*)'/);
    assert.ok((cols && cols[1].includes('minmax(0,')) || /\bwidth:\s*\d/.test(g[1]),
      `room:${lineOf(src, g.index)} — 암묵/auto-min 열 grid: gridTemplateColumns에 minmax(0,…)를 포함하거나(레일처럼 고정 px와 혼용 가능) 고정 width가 필요하다(자식 min-content로 트랙이 부풀어 배율 2에서 문서 가로 넘침)`);
  }
});

test('room 멘션 패널·컴포저 축소 규칙 핀 — 고정 폭·기준 박스 복원 변이는 red', () => {
  const src = sources.get('app/c/[ws]/room/page.jsx');
  // 멘션 패널 클램프의 정본은 #367 측정형(dropUpClamp 이식 — mentionClamp)이다. #350의
  // min/max 100% 처방은 shrink-to-fit 기준 박스에서 퇴행이라 기각(검수 확정 — DropUp 선례).
  // 여기서는 측정형 배선이 조용히 지워지는 변이만 문다(측정형 자체 핀은 #367 인접 핀이 담당).
  assert.match(src, /minWidth: mentionClamp\.maxW \? Math\.min\(280, mentionClamp\.maxW\) : 280/, '멘션 패널 측정형 min 클램프 제거 변이');
  assert.match(src, /maxWidth: mentionClamp\.maxW \? Math\.min\(mentionClamp\.maxW, 420\) : undefined/, '멘션 패널 측정형 max 클램프 제거 변이');
  // 100% 클램프의 기준 박스 — position:relative 래퍼가 사라지면 containing block이 위로 올라가
  // 클램프가 무력화된다(검수 변이 실측: relative 제거가 기존 핀 전부에 초록).
  assert.match(src, /<div ref=\{mentionWrapRef\} style=\{\{ position: 'relative' \}\}>\s*\{mentionOpen &&/,
    '멘션 패널 기준 박스(relative 래퍼 — #367 측정 ref 부착형) 제거 변이');
  // 카드 overflowWrap anywhere — 긴 무공백 토큰의 카드 내부 가로 스크롤 보정(실측 511>168 → 168=168).
  // 넘침은 카드가 가두지만 보정이 조용히 사라지는 것을 막는다(검수 LOW). 앵커는 표현식 전체.
  assert.match(src, /className="card" style=\{\{ padding: '16px 18px', overflowY: 'auto', minHeight: 0, overflowWrap: 'anywhere' \}\}/,
    '회의실 카드 overflowWrap anywhere 제거 변이');
});

test('room 헤더 축소 규칙 핀 — wrap·ellipsis·버튼 세로 자람이 헤더 구간에 붙어 있어야 한다', () => {
  const src = sources.get('app/c/[ws]/room/page.jsx');
  // 헤더의 '회의 마치기' 버튼은 유일한 비축소 요소(.btn 전역 nowrap) — wrap 줄내림 + 라벨 줄바꿈
  // 허용이 없으면 1280px 창 × 배율 2에서 문서 가로 넘침(실측 scrollWidth 1399 > 1264).
  // 앵커는 room.header 구간 자체 — 낱개 프로퍼티 앵커는 첨부 칩 행(flexWrap)·보관 열람 바(동형
  // flex 행)가 대신 만족시켜 초록이었다(검수 변이 실측). 이 regex는 wrap 행과 microlabel
  // 한 줄 ellipsis 세트가 room.header 라벨에 직접 붙어 있는지를 본다.
  assert.match(src,
    /<div style=\{\{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 \}\}>\s*<span className="microlabel" style=\{\{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' \}\}>\{t\('room\.header'\)\}/,
    '회의실 헤더 wrap 행 + microlabel ellipsis 구간 변이(표현식 전체 앵커 — 정당한 리팩터면 이 핀을 함께 갱신)');
  // 버튼은 라벨 2줄에서 세로로 자라야 한다 — .btn.sm 고정 height 28로 되돌리면 en 라벨
  // ('End meeting — file the minutes')이 알약 밖으로 삐져나온다(검수 실측 clientH 26 < scrollH 31).
  assert.match(src, /className="btn sm" style=\{\{ whiteSpace: 'normal', height: 'auto', minHeight: 28, padding: '4px 12px' \}\}/,
    '회의 마치기 버튼 축소 세트 변이(표현식 전체 앵커 — 정당한 리팩터면 이 핀을 함께 갱신)');
});

test('att-chip 폭 클램프 핀 — nowrap 칩의 고정 220px 상한 복원 변이는 red', () => {
  const css = sources.get('app/globals.css');
  const blocks = [...css.matchAll(/(?:^|\n)\.att-chip \{([^}]*)\}/g)];
  assert.equal(blocks.length, 1, '.att-chip 기본 규칙은 정확히 1개여야 한다 — 쪼개지면 이 핀의 수집 표면부터 넓힌다(fail-closed)');
  assert.match(blocks[0][1], /max-width:\s*min\(220px, 100%\)/,
    'min(220px, 100%) 복원 변이 — nowrap 칩이 좁은 유효 폭(배율 2, 열 186px)에서 행 밖으로 넘친다(검수 실측: 긴 파일명 칩이 문서 가로 스크롤)');
});

/* ── 인접 핀: 데크 배율 2 협폭 2열 겹침(선재 결함 — Dial 회전 중심 수정 검증 중 발견 2026-09-02) ─────
   1400px 창 × 배율 2(유효 700 CSS px)에서 .deck-grid가 2열(1fr + 316px)을 유지한 채 왼쪽 열이 68px로
   눌리고, 그 안의 지표 auto-fit(min 180px)이 트랙을 넘쳐 오른쪽 열 위로 겹쳐 그려졌다(크롬·WebKit 동일).
   뿌리 둘: ① 접힘 규칙이 미디어쿼리(실 뷰포트 px)뿐이라 배율을 모른다 → 컨테이너 쿼리(.deck-page,
   CSS px 폭)로 같은 임계를 한 번 더 건다. ② 맨 px min auto-fit·무템플릿 grid의 auto 열은 트랙보다
   넓어질 수 있다 → 회의실·경쟁 정본(minmax(0,…)·min(Npx,100%))으로 잠근다. 실동작 검증은 해당 PR의
   라이브 측정(크롬·WebKit × 배율 1·1.5·2, 배율 1 픽셀 무변경)이 담당. */
test('deck grid 열 잠금 sweep — 모든 인라인 display:grid는 minmax(0,…) 열 또는 클램프형 auto-fit이어야 한다', () => {
  const src = sources.get('app/c/[ws]/page.jsx');
  const styles = collectInlineStyles(src);
  // 탐지는 쪽지함 sweep 정본(:410)과 같은 느슨한 형태 — 리터럴 'grid' 고정은 inline-grid·삼항 조건부
  // grid가 수집·역방향 양쪽을 지나가는 fail-open(분리 검수 M-1 실측: 무잠금 inline-grid·x ? 'grid' : 'flex' 추가가 전건 초록).
  const GRID_RE = /display:\s*[^,}]*grid/;
  const grids = styles.filter((s) => GRID_RE.test(s.body));
  assert.ok(grids.length >= 11, `grid 인라인 ${grids.length}곳(현재 11) — 수집 워커가 소스와 어긋났는지 확인(빈 수집 = 무효 게이트)`);
  for (const g of grids) {
    const colDecls = (g.body.match(/gridTemplateColumns/g) ?? []).length;
    const lockedCols = /gridTemplateColumns:\s*['"`][^'"`]*minmax\(0,/.test(g.body)
      || /gridTemplateColumns:\s*['"`][^'"`]*minmax\(min\(\d+px, 100%\),/.test(g.body);
    assert.ok(colDecls === 1 && lockedCols,
      `deck:${lineOf(src, g.start)} — 암묵/auto-min 열 grid: gridTemplateColumns는 정확히 1회 선언에 minmax(0,…) 또는 minmax(min(Npx, 100%),…)를 포함해야 한다(자식 min-content로 트랙이 부풀어 배율 2에서 이웃 열 위로 겹침 — 덮어쓰기 ${colDecls}회 선언도 여기서 red)`);
  }
  for (const m of src.matchAll(/display:\s*[^,}]*grid/g)) {
    assert.ok(styles.some((s) => m.index >= s.start && m.index < s.end), `deck:${lineOf(src, m.index)} — 수집되지 않은 display:grid (style={{…}} 인라인 밖이거나 워커가 모르는 표기)`);
  }
});

test('deck 2열 접힘 — 컨테이너 쿼리(배율 반영 CSS px)가 미디어쿼리(실 뷰포트)와 같은 창 폭에서 전환된다', () => {
  const css = sources.get('app/globals.css');
  const page = sources.get('app/c/[ws]/page.jsx');
  assert.match(page, /<div className="deck-page"/, '데크 래퍼에 컨테이너 클래스 deck-page가 있어야 한다');
  assert.match(css, /\.deck-page\s*\{[^}]*container:\s*deck\s*\/\s*inline-size/, '.deck-page가 이름 있는(deck) inline-size 컨테이너여야 한다 — 무명이면 다른 컨테이너가 생길 때 .deck-grid가 엉뚱한 조상에 붙는다(검수 L-2)');
  // rem 고정 — px면 WebKit이 auto 폭 컨테이너를 배율 곱한 폭으로 비교해 배율 2에서 안 접힌다(실측, globals 주석).
  // 값은 16px 루트 기준 px로 환산해 아래 산식과 대조한다(rem 상수는 정규식이 잡는 유일한 단위 — px 복원은 여기서 red).
  const cqRem = css.match(/@container\s+deck\s*\(max-width:\s*(\d+(?:\.\d+)?)rem\)\s*\{\s*\.deck-grid\s*\{\s*grid-template-columns:\s*1fr;?\s*\}\s*\}/);
  const cq = cqRem && [cqRem[0], String(Number(cqRem[1]) * 16)];
  const mq = css.match(/@media\s*\(max-width:\s*(\d+)px\)\s*\{\s*\.deck-grid\s*\{\s*grid-template-columns:\s*1fr;?\s*\}\s*\}/);
  assert.ok(cq && mq, `.deck-grid 접힘 규칙 — 컨테이너 쿼리(rem 임계) ${!!cq}, 미디어쿼리 ${!!mq} 둘 다 있어야 한다(미디어쿼리 제거는 배율 1 종전 동작 변경, px 임계는 WebKit 배율 2 미매칭)`);
  // 값 불변식 — 컨테이너 임계 = 2열이 겹침 없이 들어가는 최소 본문 폭 = 지표 auto-fit 최소폭 + gap + 레일 폭.
  // 미디어 임계(1100 = 본문 808)보다 낮아야 배율 1·1.5의 종전 2열이 그대로다(높이면 1.5×1440에서 접혀 회귀).
  const minCard = Number(page.match(/repeat\(auto-fit, minmax\(min\((\d+)px, 100%\), 1fr\)\)/)[1]);
  const deck = css.match(/\.deck-grid\s*\{[^}]*grid-template-columns:\s*1fr\s+minmax\(0,\s*(\d+)px\)[^}]*gap:\s*(\d+)px/);
  assert.ok(deck, '.deck-grid 2열 규칙(1fr + minmax(0, Npx) 레일, gap)이 있어야 한다');
  const expect = minCard + Number(deck[2]) + Number(deck[1]);
  assert.equal(Number(cq[1]), expect, `컨테이너 임계 ${cq[1]} ≠ 지표 최소 ${minCard} + gap ${deck[2]} + 레일 ${deck[1]} = ${expect}`);
  const side = Number(css.match(/\.shell\s*\{[^}]*grid-template-columns:\s*(\d+)px/)[1]);
  const pad = Number(css.match(/\.content\s*\{\s*padding:\s*\d+px\s+(\d+)px/)[1]);
  assert.ok(Number(cq[1]) < Number(mq[1]) - side - 2 * pad, `컨테이너 임계 ${cq[1]}는 미디어 임계의 본문 폭 ${Number(mq[1]) - side - 2 * pad}보다 낮아야 배율 1·1.5 종전 레이아웃이 보존된다`);

/* ── 인접 핀: 데크 계기판(Dial) 바늘 — svg 내부 요소의 px transform-origin 금지 ─────────
   유건 제보(2026-09-02 스크린샷): 표시 배율에서 바늘의 회전 중심이 중앙 점을 벗어난다. 재현
   (독립 페이지, 시스템 WKWebView = Tauri 웹뷰 엔진): 배율 1.5에서 꼬리가 중심에서 (−11.2, +40.1),
   배율 2에서 (−22.4, +80.2) CSS px — 원점 (60,60)이 배율만큼 한 번 더 곱해져 (120,120)이 됐다는
   계산과 소수점까지 일치. 크롬은 0(엔진 차이라 Aside만으론 못 본다). 처방: 중심 이동은 SVG 속성
   translate(사용자 좌표계 — 배율 무관), 회전 원점은 로컬 0 0(몇 배를 곱해도 0). CSS transition 유지.
   왜 ①의 스위프가 못 잡았나: ①은 vh 치수(높이) 선언만 수집한다 — transform-origin은 치수도 vh도
   아니라 수집 대상 밖. 규칙 확장: svg 구간 안의 인라인 transformOrigin은 길이(px·숫자)를 쓰면 red.
   한계(정직 표기): 인라인 style={{…}}만 본다 — CSS 클래스는 어느 요소에 붙는지 정적으로 모른다
   (globals.css의 transform-origin은 현재 keyword(center) 1곳뿐). <svg> 리터럴 밖에서 svg 조각(<g>·<line>)만
   반환하는 컴포넌트도 구간 밖이라 못 본다(분리 검수 M-2b — 현 소스에 없음, 생기면 그 컴포넌트를 svg 구간에
   편입하는 수집 확장이 필요). */
function collectSvgRanges(src) {
  // 깊이 카운트 — 중첩 <svg>에서 첫 </svg>로 끊으면 바깥 svg의 나머지 구간이 미수집(분리 검수 M-2c).
  const out = [];
  const tok = /<svg\b|<\/svg>/g;
  let depth = 0, start = -1, m;
  while ((m = tok.exec(src))) {
    if (m[0] === '<svg') { if (depth === 0) start = m.index; depth += 1; }
    else if (depth > 0) { depth -= 1; if (depth === 0) { out.push({ start, end: m.index + 6 }); start = -1; } }
  }
  if (depth > 0) out.push({ start, end: src.length });
  return out;
}
// 인라인 원점 키 — camelCase와 하이픈 문자열 키 둘 다(React는 'transform-origin' 키도 실제 적용한다 — 분리 검수 M-2a).
const ORIGIN_KEY = String.raw`(?:transformOrigin|['"]transform-origin['"])`;
// svg 안 허용 원점 = 0 계열(0·0px — 몇 배를 곱해도 0)만. %·키워드(center…)는 배율에는 불변이지만 참조 박스
// (view-box) 기준으로 풀려 translate 그룹 아래 자식(Dial 패턴)에서는 중심을 벗어난다(분리 검수 M-1 실측:
// '50% 50%' → 배율 1에서도 (−22, +38) 편차). 0이 아닌 길이·숫자·보간(${…})·%·키워드 전부 red.
const ZOOM_SAFE_ORIGIN = /^\s*0(?:px)?(?:\s+0(?:px)?)?\s*$/;

test('svg 내부 인라인 transformOrigin 스위프 — px·숫자·보간 원점은 red(WebKit이 배율만큼 한 번 더 곱한다)', () => {
  let seen = 0;
  for (const [file, src] of sources) {
    if (!file.endsWith('.jsx')) continue;
    const svgs = collectSvgRanges(src);
    for (const m of src.matchAll(new RegExp(ORIGIN_KEY + String.raw`\s*:\s*(['"\x60])([^'"\x60]*)\1`, 'g'))) {
      const inSvg = svgs.some((r) => m.index >= r.start && m.index < r.end);
      if (!inSvg) continue;
      seen += 1;
      assert.ok(ZOOM_SAFE_ORIGIN.test(m[2]), `${file}:${lineOf(src, m.index)} — svg 안 transform-origin '${m[2]}': 0이 아닌 길이는 WebKit이 표시 배율만큼 한 번 더 곱해 회전 중심이 어긋나고, %·키워드는 view-box 기준이라 translate 그룹 아래에서 어긋난다(허용은 0·0 0뿐, 위치는 SVG 속성 translate로)`);
    }
    // 역방향 스캔 — svg 구간 안의 모든 transformOrigin 토큰은 위 정규식(따옴표 값)으로 수집돼야 한다.
    // 변수·식으로 원점을 넣으면 값 검사가 불가하니 여기서 red(수집 우회 = 무보호).
    for (const m of src.matchAll(new RegExp(ORIGIN_KEY, 'g'))) {
      if (!svgs.some((r) => m.index >= r.start && m.index < r.end)) continue;
      assert.ok(new RegExp('^' + ORIGIN_KEY + String.raw`\s*:\s*(['"\x60])[^'"\x60]*\1`).test(src.slice(m.index, m.index + 200)), `${file}:${lineOf(src, m.index)} — svg 안 transform-origin이 따옴표 값이 아니라 값 검사가 불가(수집 우회)`);
    }
  }
  assert.ok(seen >= 1, `svg 안 transformOrigin ${seen}곳(현재 1 — Dial 바늘) — 수집기가 소스와 어긋났는지 확인(빈 수집 = 무효 게이트)`);
});

test('Dial 바늘 핀 — translate(사용자 좌표계) 그룹 안에서 로컬 원점 0 0 기준 회전, 바늘은 (0,0)에서 시작', () => {
  const src = sources.get('app/ui.jsx');
  const s = src.indexOf('export function Dial(');
  const e = src.indexOf('\nexport function', s + 1);
  const body = src.slice(s, e);
  const iT = body.indexOf('<g transform={`translate(${cx} ${cy})`}>');
  const iO = body.indexOf("transformOrigin: '0 0'");
  const iL = body.search(/<line x1=\{0\} y1=\{0\} x2=\{r - 14\} y2=\{0\}/);
  const iEnd = body.indexOf('</g>');
  assert.ok(iT !== -1 && iO !== -1 && iL !== -1, `Dial 바늘 구조 소실 — translate 그룹 ${iT}, 원점 0 0 ${iO}, 바늘 (0,0) 시작 ${iL}`);
  assert.ok(iT < iO && iO < iL && iL < iEnd, 'Dial 바늘 순서 — translate 그룹 › 회전 그룹(원점 0 0) › 바늘 line 이 중첩돼 있어야 한다');
  assert.ok(/transition:\s*'transform 1s/.test(body.slice(iT, iEnd)), 'Dial 바늘 스윕 전환(transform 1s)이 회전 그룹에 남아 있어야 한다(키 순서 무관 — 분리 검수 L-2)');
});
