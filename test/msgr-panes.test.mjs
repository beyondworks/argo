// 기억 페이지 창·탭 상태기계 행동 테스트 — 검수(2026-09-05) M-6: 소스 핀은 빈 창 폴백·중복 방지·활성 승계·포커스 승계 제거 변이에 초록이었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GRAPH_TAB, MAX_PANES, openTab, closeTab, closeOthers, closeAll, closeRight, setActive } from '../apps/messenger/src/panes.mjs';

const ent = (rel) => ({ id: rel, kind: 'entity', rel });
const start = () => ({ panes: [{ id: 1, tabs: [GRAPH_TAB, ent('org')], active: 'graph' }], focus: 1 });
const ids = (s, pane = 0) => s.panes[pane].tabs.map((t) => t.id);

test('열기: 같은 탭은 활성화만(중복 없음), split은 옆 창을 만들고 포커스를 옮긴다, 창은 MAX_PANES까지', () => {
  let s = start();
  s = openTab(s.panes, s.focus, ent('people/a'));
  s = openTab(s.panes, s.focus, ent('people/a'));
  assert.deepEqual(ids(s), ['graph', 'org', 'people/a']); assert.equal(s.panes[0].active, 'people/a');
  s = openTab(s.panes, s.focus, ent('crews/x'), { split: true });
  assert.equal(s.panes.length, 2); assert.equal(s.focus, 2); assert.deepEqual(ids(s, 1), ['crews/x']);
  s = openTab(s.panes, s.focus, ent('crews/y'), { split: true }); // 이미 둘이면 "옆 창" = 첫 창
  assert.equal(s.panes.length, MAX_PANES); assert.equal(s.focus, 1); assert.deepEqual(ids(s, 0), ['graph', 'org', 'people/a', 'crews/y']);
});

test('닫기: 활성 탭을 닫으면 이웃이 활성, 마지막 창이 비면 그래프 탭으로, 둘째 창이 비면 창이 사라지고 포커스가 남은 창으로', () => {
  let s = start(); s = openTab(s.panes, s.focus, ent('a')); s = openTab(s.panes, s.focus, ent('b'));
  s = closeTab(s.panes, s.focus, 1, 'b'); assert.equal(s.panes[0].active, 'a', '오른쪽 끝을 닫으면 왼쪽 이웃');
  s = closeTab(s.panes, s.focus, 1, 'graph'); assert.equal(s.panes[0].active, 'a', '비활성 탭을 닫아도 활성은 그대로');
  s = closeTab(s.panes, s.focus, 1, 'org'); s = closeTab(s.panes, s.focus, 1, 'a');
  assert.deepEqual(ids(s), ['graph']); assert.equal(s.panes[0].active, 'graph', '마지막 창은 비지 않는다');
  s = openTab(s.panes, s.focus, ent('z'), { split: true }); assert.equal(s.panes.length, 2); assert.equal(s.focus, 2);
  s = closeTab(s.panes, s.focus, 2, 'z');
  assert.equal(s.panes.length, 1); assert.equal(s.focus, 1, '둘째 창이 비면 사라지고 포커스는 남은 창');
  assert.deepEqual(closeTab(s.panes, s.focus, 9, 'graph'), { panes: s.panes, focus: s.focus }, '없는 창·탭은 무변경');
});

test('모두 닫기·다른 탭 닫기·오른쪽 탭 닫기 — 어느 경우에도 빈 창·없는 활성 탭이 남지 않는다(변이 M1·M5·M7·closeRight 가드)', () => {
  let s = start(); s = openTab(s.panes, s.focus, ent('a')); s = openTab(s.panes, s.focus, ent('b')); s = openTab(s.panes, s.focus, ent('c'));
  let r = closeAll(s.panes, s.focus, 1);
  assert.deepEqual(ids(r), ['graph']); assert.equal(r.panes[0].active, 'graph', '창 하나에서 모두 닫기 = 그래프만(빈 창 폴백)');
  r = closeOthers(s.panes, s.focus, 1, 'b'); assert.deepEqual(ids(r), ['b']); assert.equal(r.panes[0].active, 'b');
  r = closeRight(s.panes, s.focus, 1, 'a'); assert.deepEqual(ids(r), ['graph', 'org', 'a']); assert.equal(r.panes[0].active, 'a', '활성(c)이 잘리면 기준 탭이 활성');
  assert.deepEqual(closeRight(s.panes, s.focus, 1, 'nope'), { panes: s.panes, focus: s.focus }, '없는 기준 탭은 무변경(빈 배열 크래시 가드)');
  s = openTab(s.panes, s.focus, ent('z'), { split: true });
  r = closeAll(s.panes, s.focus, 2); assert.equal(r.panes.length, 1); assert.equal(r.focus, 1, '둘째 창 모두 닫기 = 창 제거+포커스 승계');
  for (const st of [r, closeOthers(s.panes, s.focus, 2, 'z'), closeRight(s.panes, s.focus, 2, 'z')]) for (const p of st.panes) { assert.ok(p.tabs.length > 0); assert.ok(p.tabs.some((t) => t.id === p.active), '활성 탭은 항상 존재'); }
  const a = setActive(s.panes, s.focus, 1, 'b'); assert.equal(a.panes[0].active, 'b'); assert.equal(a.panes[1].active, 'z');
});
