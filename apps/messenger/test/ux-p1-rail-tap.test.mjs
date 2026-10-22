// UX 정리 P1(2026-10-22) — 데스크톱 레일 에이전트 행: 누르면 공간과 상관없이 그 에이전트와 1:1, 카드는 우클릭·길게 누르기 메뉴로.
// 행동 확인은 픽스처(test/v2-shell.fixture.html, 조직·개인 공간)에서 눌러 봤다(PR 본문). 이 시험은 그 배선이 되돌아가지 않게 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const railRow = app.slice(app.indexOf('const railRow = (c) =>'), app.indexOf("// 평평한 목록(유건 결정 2026-09-09)"));

test('레일 에이전트 행: 누르면 1:1(조직 공간도) — 시트로 가는 분기가 없다', () => {
  assert.ok(railRow.length > 100, '레일 행 정의를 찾는다');
  assert.match(railRow, /className="item" onClick=\{\(\) => \{ dmWithCrew\(c\.id\); setRail\(false\); \}\}/);
  assert.doesNotMatch(railRow, /setSheet\(c\.id\)/, '행 누르기에서 카드를 열지 않는다');
});

test('옆 기능 그대로: 우클릭·길게 누르기 메뉴(조직 공간)에 에이전트 카드·1:1·즐겨찾기, 드래그 정렬', () => {
  assert.ok(railRow.includes('openCtx(e, items, c.id)'), '우클릭 메뉴');
  assert.match(railRow, /rowLongPress\(c, items/);
  assert.match(railRow, /draggable=\{!isPhone && mine && railSort === 'custom'\}/);
  const ctx = app.slice(app.indexOf('const crewCtx = (c) =>'), app.indexOf('// 폰 줄 밀기(유건 승인 2026-09-29)'));
  for (const k of ["'ctx.crew.card'", 'setSheet(c.id)', 'dmWithCrew(c.id)', "'ctx.fav'"]) assert.ok(ctx.includes(k), k);
});
