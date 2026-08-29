// 표시 배율(#334) 레이아웃·좌표계 보정 행동 테스트 — 부트(display-zoom.test.mjs) 이후의 절반.
// 재검수 실측: .side·채팅 그리드·모달 86vh·body min-height 롤백, graph2d evPos k 무력화,
// split-pane dispZoom 무력화 전부 기존 스위트 초록(무게이트) → 이 파일이 그 6경로를 잠근다.
//
// 방식 — 브라우저 없이 3층:
//  ① 치수 선언(CSS·JSX 인라인)의 vh 식을 **산술 평가** — 문자열 앵커가 아니라 값 불변식이라
//     동치 리팩터는 초록, 나눗셈 롤백은 산술로 red. 불변식: 배율 z에서 화면 크기(디바이스 px
//     = 평가값 × z) ≤ 뷰포트. vh는 zoom과 곱해지지 않으므로 /var(--z)가 빠지면 z배로 넘친다.
//  ② zoom-math.mjs(추출된 계산부)를 직접 임포트해 실호출 — 좌표 환산·폭 클램프의 행동 검증.
//  ③ 호출부 배선 핀 — 함수만 잠그면 호출부 우회 변이가 전부 초록이 되는 기왕의 실패 패턴
//     (v0.1.49 전수검수 교훈) 방지. 핀은 ②의 보조층: 수학은 ②가, 배선은 ③이 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispZoom, clampPaneW, PANE_W_MIN, zoomedEvPos } from '../app/c/[ws]/zoom-math.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const V = 900; // 뷰포트 높이(px) — #334 실측 환경(사이드바 rect 1125 vs 뷰포트 900)과 동일
const ZOOMS = [1.25, 2]; // 자동 최대(1.25)·수동 최대(2.0)

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
  s = s.replace(/(\d*\.?\d+)vh/g, (_, n) => `(${n}*${V}/100)`);
  s = s.replace(/(\d*\.?\d+)px/g, '($1)');
  s = s.replace(/\bcalc\(/g, '(').replace(/\bmin\(/g, 'Math.min(').replace(/\bmax\(/g, 'Math.max(');
  const residue = s.replace(/Math\.(min|max)/g, '').replace(/[\d\s+\-*/().,]/g, '');
  assert.equal(residue, '', `평가기가 모르는 구문 — 확장 필요: ${expr}`);
  return Function(`'use strict'; return (${s});`)();
}

// 수집 — 소스에서 vh가 든 치수 선언(height·min/max-height)을 전부 모은다. 셀렉터/컴포넌트 무관:
// 불변식은 "화면을 채우는 치수는 배율만큼 나눠야 한다"로 선언 자체에 균일하게 성립한다.
// (45vh처럼 작은 값은 나누지 않아도 산술상 화면 안 — 무해 판정과 불변식이 자연히 일치한다.)
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
function collectCss(file) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const out = [];
  for (const m of src.matchAll(/(?:^|[;{])\s*(min-height|max-height|height)\s*:\s*([^;}]+)/g)) {
    // 줄번호는 속성명 위치 기준 — 매치 자체는 앞 선언의 ';'에서 시작해 한 줄 이르게 찍힌다
    if (m[2].includes('vh')) out.push({ where: `${file}:${lineOf(src, m.index + m[0].indexOf(m[1]))}`, prop: m[1], expr: m[2].trim() });
  }
  return out;
}
function collectJsx(file) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const out = [];
  for (const m of src.matchAll(/\b(height|minHeight|maxHeight)\s*:\s*(['"])([^'"]*vh[^'"]*)\2/g)) {
    out.push({ where: `${file}:${lineOf(src, m.index)}`, prop: m[1], expr: m[3] });
  }
  return out;
}
function appJsxFiles() {
  return readdirSync(join(ROOT, 'app'), { recursive: true })
    .map(String).filter((f) => f.endsWith('.jsx'))
    .map((f) => join('app', f).split('\\').join('/')); // Windows 러너의 역슬래시 정규화
}

const decls = [...collectCss('app/globals.css'), ...appJsxFiles().flatMap(collectJsx)];

test('수집 스위프가 비지 않는다 — 빈 목록 통과(무효 게이트) 방지', () => {
  // 하한은 개수 고정이 아니라 공동(空洞) 방지 — 현재 CSS 8곳 + JSX 9곳. 줄어드는 리팩터가 있으면
  // 보정 경로가 실제로 준 것인지 확인하고 내린다.
  assert.ok(decls.length >= 15, `치수 선언 ${decls.length}곳 — 수집 정규식이 소스와 어긋났는지 확인`);
  const has = (f, n) => assert.ok(decls.filter((d) => d.where.startsWith(f)).length >= n, `${f}에 vh 치수 ${n}곳 이상이어야 한다`);
  has('app/globals.css', 6); // .side·.shell·body·기억분할·팝오버·vault 계열
  has('app/c/[ws]/crew/[slug]/page.jsx', 2); // 채팅 그리드 + 모달 86vh
  has('app/c/[ws]/room/page.jsx', 1); // 회의실 채팅 그리드
  has('app/c/[ws]/compete/page.jsx', 1); // 경쟁 채팅 그리드
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

/* ── ② zoom-math 행동 (graph2d evPos · split-pane 폭) ─────────────────── */

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

/* ── ③ 호출부 배선 핀 ─────────────────────────────────────────────── */

const graph2d = readFileSync(join(ROOT, 'app/c/[ws]/graph2d.jsx'), 'utf8');
const splitPane = readFileSync(join(ROOT, 'app/c/[ws]/split-pane.jsx'), 'utf8');

test('graph2d 배선 — evPos가 zoomedEvPos(rect, clientWidth, …)로 위임한다', () => {
  assert.match(graph2d, /import\s*\{[^}]*\bzoomedEvPos\b[^}]*\}\s*from\s*'\.\/zoom-math\.mjs'/);
  assert.match(graph2d,
    /const evPos = \(e\) =>\s*zoomedEvPos\(\s*canvas\.getBoundingClientRect\(\),\s*canvas\.clientWidth,\s*e\.clientX,\s*e\.clientY\s*\)/,
    'evPos 인라인 재구현(무보정 롤백)은 여기서 잡는다 — 수학 자체는 ② 단위 테스트가 잠근다');
});

test('split-pane 배선 — 리사이즈 폭이 (innerWidth − clientX) ÷ dispZoom()으로 클램프에 들어간다', () => {
  assert.match(splitPane, /import\s*\{[^}]*\bdispZoom\b[^}]*\}\s*from\s*'\.\/zoom-math\.mjs'/);
  assert.match(splitPane, /clampW\(\s*\(window\.innerWidth - e\.clientX\)\s*\/\s*dispZoom\(\)\s*\)/,
    '커서 좌표(뷰포트 px)→패널 폭(CSS px) 나눗셈 제거 변이는 여기서 잡는다');
});
