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
  assert.match(src, /useDismiss\(dmSortMenu, \(\) => setDmSortMenu\(false\), '\.msgr-dmsort', '\.msgr-dmsort > button', isPhone\);/);
  assert.match(src, /useDismiss\(sortMenu, \(\) => setSortMenu\(false\), '\.msgr-railsort', '\.msgr-railsort > button', isPhone\);/);
  assert.match(src, /useDismiss\(meMenu, \(\) => setMeMenu\(false\), 'button\.me:not\(\.item\), \.msgr-rowmenu\.me', 'button\.me:not\(\.item\)'\);/);
  assert.match(src, /className="msgr-sortwrap msgr-railsort"/, '레일 정렬 감싸개에 선택자');
  assert.match(src, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); setSlashOff\(text\); return; \}/, '/ 목록 Esc — 글은 그대로');
  assert.match(src, /rolePick \|\| text === slashOff \? null :/, '닫은 그 글자에서는 다시 안 뜬다');
  assert.match(src, /const leaveSearch = \(\) => \{ setSearchQ\(''\); setSearchRes\(null\); setSearchBusy\(false\); searchSeq\.current\+\+; if \(page === 'search'\) setPage\('chat'\); \};/);
  assert.match(src, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); leaveSearch\(\); e\.currentTarget\.blur\(\); \}/, '검색 칸 Esc = 지우기 버튼');
  assert.match(src, /className="clear" onClick=\{leaveSearch\}/);
});

// 폰에서 메뉴·새 채널 칸이 열린 채 바깥(대화 행)을 누르면 대화로 들어가던 제보(유건 2026-09-29) — 그 누름은 닫기만 하고 뒤따르는 click을 삼킨다
test('swallow — 바깥 누름으로 닫은 그 손가락의 click 한 번만 삼키고, 안쪽 누름·그다음 누름은 그대로', () => {
  const listeners = []; const doc = { addEventListener: (t, f, o) => listeners.push({ t, f, o }), removeEventListener: (t, f) => { const i = listeners.findIndex((l) => l.t === t && l.f === f); if (i >= 0) listeners.splice(i, 1); } };
  const h = dismissHandlers({ inside: '.pop, .btn', close: () => {}, swallow: true, doc });
  h.down({ target: el(true) }); assert.equal(listeners.length, 0, '안쪽 누름은 삼키지 않는다');
  h.down({ target: el(false) }); assert.equal(listeners.length, 1, '바깥 누름 → click 삼킴 대기');
  assert.equal(listeners[0].t, 'click'); assert.equal(listeners[0].o.capture, true);
  let stopped = 0; listeners[0].f({ preventDefault: () => { stopped++; }, stopPropagation: () => { stopped++; } });
  assert.equal(stopped, 2, '대화 행으로 가던 click을 막는다');
  assert.equal(listeners.length, 0, '한 번 삼키면 풀린다 — 다음 탭은 그대로');
  const plain = dismissHandlers({ inside: '.pop', close: () => {}, doc });
  plain.down({ target: el(false) }); assert.equal(listeners.length, 0, 'swallow 없으면(데스크톱) 그대로 — 대기 추가 없음');
});
