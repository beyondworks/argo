// 팝오버 닫기(D18: 내 계정·정렬 메뉴가 Esc·바깥 누름으로 안 닫히고 겹쳐 열림, / 목록 Esc 무반응, 검색 결과 Esc)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dismissHandlers } from '../src/dismiss.mjs';

const el = (inside) => ({ closest: (sel) => (inside && sel === '.pop, .btn' ? {} : null) });
test('바깥 누름은 닫고 안(메뉴·연 버튼)은 두며, Escape는 닫고 연 버튼으로 초점을 돌린다', () => {
  let closed = 0, focused = 0, stopped = 0;
  const h = dismissHandlers({ inside: '.pop, .btn', close: () => { closed++; }, focusTrigger: () => { focused++; } });
  h.down({ target: el(true) }); assert.equal(closed, 0, '메뉴 안·연 버튼 누름은 그대로(버튼의 토글이 처리)');
  h.down({ target: el(false) }); assert.equal(closed, 1, '바깥 누름 — 다른 메뉴 버튼을 눌러도 바깥이라 먼저 닫힌다(겹침 없음)');
  h.key({ key: 'ArrowDown' }); assert.equal(closed, 1);
  h.key({ key: 'Escape', stopPropagation: () => { stopped++; } });
  assert.deepEqual([closed, focused, stopped], [2, 1, 1], 'Escape — 닫고 초점 복귀, 바깥 Esc 처리(검색 결과 나가기 등)로 새지 않는다');
  h.down({ target: null }); assert.equal(closed, 3, '대상 없는 누름도 바깥');
});

test('배선 — 세 메뉴가 같은 닫기를 쓰고, / 목록은 Esc로 닫히고, 검색 결과는 Esc로 대화로 돌아간다', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /useDismiss\(dmSortMenu, \(\) => setDmSortMenu\(false\), '\.msgr-dmsort', '\.msgr-dmsort > button'\);/);
  assert.match(src, /useDismiss\(sortMenu, \(\) => setSortMenu\(false\), '\.msgr-railsort', '\.msgr-railsort > button'\);/);
  assert.match(src, /useDismiss\(meMenu, \(\) => setMeMenu\(false\), 'button\.me:not\(\.item\), \.msgr-rowmenu\.me', 'button\.me:not\(\.item\)'\);/);
  assert.match(src, /className="msgr-sortwrap msgr-railsort"/, '레일 정렬 감싸개에 선택자');
  assert.match(src, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); setSlashOff\(text\); return; \}/, '/ 목록 Esc — 글은 그대로');
  assert.match(src, /rolePick \|\| text === slashOff \? null :/, '닫은 그 글자에서는 다시 안 뜬다');
  assert.match(src, /const leaveSearch = \(\) => \{ setSearchQ\(''\); setSearchRes\(null\); if \(page === 'search'\) setPage\('chat'\); \};/);
  assert.match(src, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); leaveSearch\(\); e\.currentTarget\.blur\(\); \}/, '검색 칸 Esc = 지우기 버튼');
  assert.match(src, /className="clear" onClick=\{leaveSearch\}/);
});
