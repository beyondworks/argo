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
import { dispZoom, clampPaneW, PANE_W_MIN, zoomedEvPos } from '../app/c/[ws]/zoom-math.mjs';

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
  assert.ok(grids.length >= 9, `grid 인라인 ${grids.length}곳(현재 9) — 수집 워커가 소스와 어긋났는지 확인(빈 수집 = 무효 게이트)`);
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

test('compete 레일 열 양보 클램프 핀 — 고정 216px 복원·레일 고정 width 변이는 red', () => {
  // 페이지 2분할의 레일 고정 216px는 배율 2의 좁은 유효 폭에서 본문 열을 60 CSS px까지 압살한다
  // (실측 1280×배율 2 — FAILED 칩 +17px 카드 밖 돌출). min(216px, 100% − 244px) = 본문 열 바닥
  // 226(시안 최소폭 180 + 카드 패딩 36 + 카드 테두리 2 + 커스텀 스크롤바 8) + gap 18을 지키는
  // 만큼만 레일이 양보(재검수 적발: 테두리·스크롤바를 빠뜨린 234는 시안에 170만 전달했다).
  // 두 형태 모두 위 sweep 값검사(minmax(0,) 포함)로는 초록이라 이 핀이 유일 게이트. 배율 축은
  // 미디어쿼리가 못 보므로 intrinsic. #356(.chat-cols)과는 공존 불가(인라인이 ≤560 밴드를 이겨
  // 레일 스택을 죽인다) — 편입 머지 시 이 표현식·핀을 .chat-cols 템플릿으로 반드시 이관.
  const src = sources.get('app/c/[ws]/compete/page.jsx');
  assert.match(src,
    /gridTemplateColumns: 'min\(216px, 100% - 244px\) minmax\(0, 1fr\)', gap: 18, alignItems: 'start', height: 'calc\(100vh \/ var\(--z, 1\) - 100px\)', marginBottom: -70 \}\}>/,
    '레일 열 양보 클램프 변이(표현식 전체 앵커·}} 폐합 — 정당한 리팩터면 이 핀을 함께 갱신)');
  // 레일 아이템은 고정 width 금지 — 트랙이 216 미만으로 양보할 때 고정 216이면 아이템이 트랙을
  // 넘어 본문 위로 얹힌다. 기본 stretch가 트랙 폭을 따르게 둔다.
  assert.match(src,
    /className="side-rail" style=\{\{ position: 'sticky', top: 72, display: 'grid', gridTemplateColumns: 'minmax\(0, 1fr\)', gap: 4 \}\}>/,
    '레일 고정 width 복원 변이(표현식 전체 앵커·}} 폐합 — width가 트랙 양보를 무효화한다)');
  // 같은 결함의 CSS 경로 봉쇄 — 인라인만 잠그면 globals의 .side-rail { width: … }가 트랙 106에
  // 아이템 216을 되살린다(재검수 실증: 주입 시 전 게이트 초록). #356이 .chat-cols > .side-rail
  // { width: 216px }를 도입하므로 가설이 아니라 예정된 경로 — 그 착지에서 이 단언이 red가 나면
  // 클램프·핀을 .chat-cols로 이관하고 레일 폭은 트랙(stretch)에 맡길 것.
  assert.doesNotMatch(sources.get('app/globals.css'), /\.side-rail[^{}]*\{[^}]*\bwidth\s*:/,
    '.side-rail CSS width 선언 — 레일 폭은 트랙이 정한다(양보 클램프 무효화 경로)');
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
