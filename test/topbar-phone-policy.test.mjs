// 폰 폭 상단바 축소 정책 핀 — #340 분리 검수 칩(실 뷰포트 ≤~500px 과적재) 후속.
// 검수 실측: 360px에서 검색 pill 26px·내부 input 0px까지 붕괴(390px에서 31px/0px) — 상단바의
// 축소 불가(flex:none·min-content) 요소가 폭을 전부 소진했다. 정책 = 정보 가치 최저 요소를
// 폰 대역에서 숨기고(시계=폰 OS 상태바에 존재, 버전 도장=설정 앱 업데이트 카드에 존재),
// 스페이서를 접어 남는 폭 전부를 검색에 준다. 업데이트 칩(기능)·작업 도크는 유지한다.
//
// 잠금 방식 — **대표 뷰포트에서 캐스케이드 최종 승자 값 평가** + 배선 핀(클래스 없으면 CSS가
// 죽은 규칙이 된다). "규칙이 존재한다" 단언은 fail-open이었다(#348 분리 검수 실증: 같은 블록
// 뒤에 min-width:0 중복, 더 좁은 후속 블록 오버라이드, 블록을 기본 규칙 앞으로 이동 — 전부
// 초록인 채 라이브에서 pill 96→26px·input 0px 결함이 부활했다). 그래서 각 속성을 소스 순서로
// 걸어 "이 뷰포트에서 마지막에 이기는 선언"을 판정한다(동일 특이도·!important 미사용 가정 —
// 이 시트의 해당 셀렉터들에서 성립). 한계(정직 표기): 소스 수준 평가라 실제 렌더 폭은 못 본다
// — 실동작은 PR 라이브 측정(격리 서버 + 뷰포트 에뮬레이션)이 담당한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// 주석 제거(줄 구조 보존) — display-zoom-layout.test.mjs와 동일 방식. 주석 속 셀렉터·클래스
// 언급이 수집·개수 단언에 잡히지 않게 한다.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));
}

const css = stripComments(readFileSync(join(ROOT, 'app/globals.css'), 'utf8'));
const layout = stripComments(readFileSync(join(ROOT, 'app/c/[ws]/layout.jsx'), 'utf8'));
const ui = stripComments(readFileSync(join(ROOT, 'app/ui.jsx'), 'utf8'));

// @media (max-width: Npx) 블록을 중괄호 짝 맞추기로 추출 — 정규식 한 방은 중첩 규칙에서 조기 종료한다.
function mediaBlocks(src) {
  const out = [];
  for (const m of src.matchAll(/@media\s*[^{]*max-width:\s*(\d+(?:\.\d+)?)px[^{]*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    out.push({ px: Number(m[1]), body: src.slice(m.index + m[0].length, i - 1), start: m.index, end: i });
  }
  return out;
}
// 블록 안의 "셀렉터 { 선언 }" 목록
const rulesOf = (body) => [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((r) => ({ sel: r[1].trim(), decls: r[2] }));

const BLOCKS = mediaBlocks(css);

// 뷰포트 W에서의 캐스케이드 최종 승자 값 — 기본 구간(모든 W에 적용)과 max-width:px ≥ W 블록을
// 소스 순서대로 걸어, cls를 포함한 셀렉터의 prop 선언 중 **마지막** 값을 돌려준다.
// (min-width 미디어·특이도·!important는 이 시트의 대상 셀렉터들에 없다 — 새로 들어오면 이 평가기를 넓힌다.)
function effective(cls, prop, W) {
  const segs = [];
  let cursor = 0;
  for (const b of BLOCKS) {
    if (b.start > cursor) segs.push({ applies: true, body: css.slice(cursor, b.start) });
    segs.push({ applies: W <= b.px, body: b.body });
    cursor = b.end;
  }
  segs.push({ applies: true, body: css.slice(cursor) });
  let winner;
  const propRe = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`, 'g');
  for (const seg of segs) {
    if (!seg.applies) continue;
    for (const r of rulesOf(seg.body)) {
      if (!r.sel.split(',').some((s) => s.includes(cls))) continue;
      for (const d of r.decls.matchAll(propRe)) winner = d[1].trim();
    }
  }
  return winner; // 선언 없음 = undefined (초기값/상속 — 호출부에서 의미 판정)
}
const pxOf = (v) => (v == null ? null : Number((String(v).match(/(-?\d+(?:\.\d+)?)px/) ?? [])[1] ?? NaN));

const HIDE = ['.topbar-clock', '.topbar-ver', '.topbar-spacer'];
const phoneBlocks = BLOCKS.filter(
  (b) => rulesOf(b.body).some((r) => /display:\s*none/.test(r.decls) && HIDE.some((h) => r.sel.includes(h))),
);

test('폰 대역 상단바 축소 블록이 정확히 1개, 경계는 폰 구간(480~640px)', () => {
  assert.equal(phoneBlocks.length, 1,
    '상단바 요소를 숨기는 max-width 미디어 블록은 1곳이어야 한다 — 분산되면 경계 불일치로 요소별 소실 폭이 갈라진다');
  const px = phoneBlocks[0].px;
  assert.ok(px >= 480 && px <= 640,
    `경계 ${px}px — 폰 대역(480~640) 밖이다. 640 초과는 태블릿에서 시계·버전이 이유 없이 사라지고, 480 미만은 실측 붕괴 구간(≤500px)을 못 덮는다`);
});

// 대표 뷰포트: 폰 안(360 — 검수 실측 붕괴 지점) / 경계 바로 밖(px+1) — 이하 전부 캐스케이드 승자 기준.
const PHONE_W = 360;
const ABOVE_W = () => phoneBlocks[0].px + 1;

test('숨김 전수 = 시계·버전 도장·스페이서 — 360px에서 display 승자가 none, 경계 밖에선 none 아님', () => {
  for (const h of HIDE) {
    assert.equal(effective(h, 'display', PHONE_W), 'none',
      `${h}: 360px 캐스케이드 승자가 display:none이 아니다 — 고정폭 요소가 살아나면 검색 input이 다시 0px로 붕괴한다(검수 실측). 뒤쪽 규칙 오버라이드·블록 삭제 모두 여기서 잡힌다`);
    const above = effective(h, 'display', ABOVE_W());
    assert.notEqual(above, 'none',
      `${h}: 경계 밖(${ABOVE_W()}px)에서 display 승자가 none — 데스크톱·태블릿에서 요소가 사라진다(인접 행동 침범)`);
  }
});

test('검색 pill 플로어 — 360px min-width 승자 80~200px (입력 폭 보장, 과대 플로어 금지)', () => {
  const v = pxOf(effective('.search-pill', 'min-width', PHONE_W));
  assert.ok(v != null && !Number.isNaN(v),
    '360px에서 .search-pill min-width 승자(px)가 없다 — 긴 크루 이름(제목은 사용자 지정)이 검색을 0px까지 민다');
  assert.ok(v >= 80 && v <= 200,
    `pill 플로어 승자 ${v}px — 80 미만이면 input 사용 불가(#348 검수 실증: 뒤 규칙 min-width:0 주입 시 pill 96→26px 부활), 200 초과면 320~360px 기기에서 플로어 합이 뷰포트를 넘어 가로 스크롤이 재발한다`);
});

test('플로어는 폰 대역 밖으로 새지 않는다 — 경계 밖 min-width 승자는 80px 미만(무선언·0 허용)', () => {
  const v = pxOf(effective('.search-pill', 'min-width', ABOVE_W()));
  assert.ok(v == null || Number.isNaN(v) || v < 80,
    `경계 밖(${ABOVE_W()}px)에서 pill min-width 승자 ${v}px — 데스크톱 플로어는 좁은 유효 뷰포트(표시 배율) 가로 넘침을 재발시킨다(#340의 min-width:0가 잡은 결함)`);
});

test('제목 말줄임 — 360px에서 nowrap·hidden·ellipsis·플로어(24~96px) 승자', () => {
  assert.equal(effective('.topbar-title', 'white-space', PHONE_W), 'nowrap',
    '제목 nowrap 승자가 아니다 — 사용자 지정 크루 이름이 상단바를 여러 줄로 감는다');
  assert.equal(effective('.topbar-title', 'overflow', PHONE_W), 'hidden');
  assert.equal(effective('.topbar-title', 'text-overflow', PHONE_W), 'ellipsis');
  const v = pxOf(effective('.topbar-title', 'min-width', PHONE_W));
  assert.ok(v != null && v >= 24 && v <= 96,
    `제목 min-width 승자 ${v}px — 명시 플로어가 없으면 nowrap의 auto 플로어(문자열 전체 폭)가 남아 말줄임이 성립하지 않고, 96 초과면 pill 플로어와 합쳐 좁은 기기에서 넘친다`);
});

test('상단바 패딩 — 360px 승자는 폰 블록 값(14px 계열), 경계 밖 승자는 기본 22px', () => {
  // #348 검수 실증(fail-open M4·M7): 블록을 기본 규칙 앞으로 옮기거나 패딩 선언을 지워도
  // "존재" 단언은 초록이었다 — 승자 값 판정이라야 순서·삭제 변이가 red가 된다.
  assert.match(String(effective('.topbar', 'padding', PHONE_W)), /\b14px\b/,
    '360px 패딩 승자가 폰 값이 아니다 — 블록이 기본 규칙보다 앞이거나 선언이 빠졌다');
  assert.match(String(effective('.topbar', 'padding', ABOVE_W())), /\b22px\b/,
    '경계 밖 패딩 승자가 기본(22px)이 아니다 — 데스크톱 상단바 여백이 변했다');
});

/* ── 배선 핀 — 클래스가 JSX에 실제로 달려 있어야 CSS가 산다 ───────────────── */

test('스페이서 배선 — 표현식 전체 앵커(클래스+flex:1 동시)', () => {
  assert.match(layout, /<div className="topbar-spacer" style=\{\{ flex: 1 \}\} \/>/,
    '스페이서 div에 topbar-spacer가 없으면 폰 블록의 숨김이 죽은 규칙이 되고, 검색이 남는 폭의 절반(스페이서 몫)을 잃는다');
});

test('버전 도장 배선 — 정보성 칩에만 topbar-ver, 기능성 업데이트 칩엔 금지', () => {
  assert.match(layout, /className="chip mono topbar-ver" title=\{t\('topbar\.version'\)\}/,
    '정보성 버전 칩(topbar.version 툴팁이 달린 span)에 topbar-ver가 없다 — 폰에서 안 숨는다');
  const n = (layout.match(/topbar-ver/g) ?? []).length;
  assert.equal(n, 1,
    `layout.jsx의 topbar-ver는 정확히 1곳(정보성 도장)이어야 한다 — ${n}곳: 업데이트 칩(설치 버튼·릴리스 링크)에 붙으면 폰에서 기능이 숨는다`);
});

test('시계 배선 — Clock이 .topbar-clock을 출력하고 상단바에 실제로 얹혀 있다', () => {
  assert.match(ui, /className="topbar-clock"/);
  assert.match(layout, /<Clock \/>/);
});
