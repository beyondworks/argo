// 폰 폭 상단바 축소 정책 핀 — #340 분리 검수 칩(실 뷰포트 ≤~500px 과적재) 후속.
// 검수 실측: 360px에서 검색 pill 26px·내부 input 0px까지 붕괴(390px에서 31px/0px) — 상단바의
// 축소 불가(flex:none·min-content) 요소가 폭을 전부 소진했다. 정책 = 정보 가치 최저 요소를
// 폰 대역에서 숨기고(시계=폰 OS 상태바에 존재, 버전 도장=설정 앱 업데이트 카드에 존재),
// 스페이서를 접어 남는 폭 전부를 검색에 준다. 업데이트 칩(기능)·작업 도크는 유지한다.
//
// 잠금 방식 — 값 불변식(경계·플로어는 상수 핀이 아니라 구간) + 배선 핀(클래스 없으면 CSS가
// 죽은 규칙이 된다). 한계(정직 표기): 소스 수준 잠금이라 실제 렌더 폭은 못 본다 — 실동작은
// PR 라이브 측정(격리 서버 + 좁은 뷰포트 실측)이 담당한다.
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
  for (const m of src.matchAll(/@media\s*\(max-width:\s*(\d+(?:\.\d+)?)px\)\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    out.push({ px: Number(m[1]), body: src.slice(m.index + m[0].length, i - 1) });
  }
  return out;
}
// 블록 안의 "셀렉터 { 선언 }" 목록
const rulesOf = (body) => [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((r) => ({ sel: r[1].trim(), decls: r[2] }));

const HIDE = ['.topbar-clock', '.topbar-ver', '.topbar-spacer'];
const phoneBlocks = mediaBlocks(css).filter(
  (b) => rulesOf(b.body).some((r) => /display:\s*none/.test(r.decls) && HIDE.some((h) => r.sel.includes(h))),
);

test('폰 대역 상단바 축소 블록이 정확히 1개, 경계는 폰 구간(480~640px)', () => {
  assert.equal(phoneBlocks.length, 1,
    '상단바 요소를 숨기는 max-width 미디어 블록은 1곳이어야 한다 — 분산되면 경계 불일치로 요소별 소실 폭이 갈라진다');
  const px = phoneBlocks[0].px;
  assert.ok(px >= 480 && px <= 640,
    `경계 ${px}px — 폰 대역(480~640) 밖이다. 640 초과는 태블릿에서 시계·버전이 이유 없이 사라지고, 480 미만은 실측 붕괴 구간(≤500px)을 못 덮는다`);
});

test('숨김 대상 전수 = 시계·버전 도장·스페이서 (display: none)', () => {
  const rules = rulesOf(phoneBlocks[0].body);
  for (const h of HIDE) {
    assert.ok(rules.some((r) => /display:\s*none/.test(r.decls) && r.sel.includes(h)),
      `${h} 숨김 규칙이 폰 블록에 없다 — 고정폭 요소가 살아나면 360px에서 검색 input이 다시 0px로 붕괴한다(검수 실측)`);
  }
});

test('검색 pill 플로어 — 명시 min-width 80~200px (입력 가능 폭 보장, 과대 플로어 금지)', () => {
  const r = rulesOf(phoneBlocks[0].body).find((x) => x.sel.includes('.search-pill'));
  assert.ok(r, '폰 블록에 .search-pill 플로어 규칙이 없다 — 긴 크루 이름(제목은 사용자 지정)이 검색을 0px까지 민다');
  const mw = r.decls.match(/min-width:\s*(\d+(?:\.\d+)?)px/);
  assert.ok(mw, '.search-pill 폰 규칙에 px 단위 min-width가 없다');
  const v = Number(mw[1]);
  assert.ok(v >= 80 && v <= 200,
    `pill 플로어 ${v}px — 80 미만이면 input 사용 불가(아이콘+패딩만 ~46px), 200 초과면 320~360px 기기에서 플로어 합이 뷰포트를 넘어 가로 스크롤이 재발한다`);
});

test('제목 말줄임 — nowrap+ellipsis+플로어(24~96px): 긴 크루 이름은 제목이 양보한다', () => {
  const r = rulesOf(phoneBlocks[0].body).find((x) => x.sel.includes('.topbar-title'));
  assert.ok(r, '폰 블록에 .topbar-title 규칙이 없다 — 사용자 지정 크루 이름이 상단바를 여러 줄로 감거나 검색을 민다');
  assert.match(r.decls, /white-space:\s*nowrap/);
  assert.match(r.decls, /overflow:\s*hidden/);
  assert.match(r.decls, /text-overflow:\s*ellipsis/);
  const mw = r.decls.match(/min-width:\s*(\d+(?:\.\d+)?)px/);
  assert.ok(mw, '.topbar-title에 명시 min-width가 없다 — nowrap의 auto 플로어(문자열 전체 폭)가 남아 말줄임이 성립하지 않는다');
  const v = Number(mw[1]);
  assert.ok(v >= 24 && v <= 96, `제목 플로어 ${v}px — 24 미만이면 제목이 소실되고, 96 초과면 pill 플로어와 합쳐 좁은 기기에서 넘친다`);
});

test('폰 블록 밖에서는 아무도 이 요소들을 숨기지 않는다 — ≥경계 폭(데스크톱·태블릿) 인접 행동 보존', () => {
  // 폰 블록 본문을 도려낸 나머지 전체에서, 대상 셀렉터가 든 규칙에 display:none이 없어야 한다.
  const rest = css.replace(phoneBlocks[0].body, '');
  for (const r of [...rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)]) {
    if (!HIDE.some((h) => r[1].includes(h))) continue;
    assert.ok(!/display:\s*none/.test(r[2]),
      `폰 블록 밖에서 ${r[1].trim()}에 display:none — 데스크톱에서 시계·버전·스페이서가 사라진다`);
  }
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
