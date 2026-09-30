import test from 'node:test';
import assert from 'node:assert/strict';
import { NAV, readNav, writeNav, moveId, orderTabs } from '../src/core/nav-model.js';

// 이유(유건 9/30): "좌측 패널 메뉴가 하드코딩이면 모듈식이 아니다" — 사람마다 순서를 바꾸고 숨긴다(기기가 바뀌어도 같게 DB).
// 홈은 숨길 수 없고, 설정·휴지통은 아래 고정 칸이라 목록에 없다. 메뉴·페이지(위키)·에이전트 세 칸의 순서도 바꾼다.
test('저장값이 없으면 공간별 기본 메뉴 순서, 세 칸은 메뉴 → 페이지 → 에이전트', () => {
  const me = readNav([], 'me'), org = readNav([], 'org');
  assert.deepEqual(me.shown, NAV.me);
  assert.deepEqual(org.shown, NAV.org);
  assert.deepEqual(me.sections, ['menu', 'pages', 'crews']);
  assert.deepEqual(me.hidden, []);
});

test('순서·숨김은 한 목록으로 저장하고, 그 공간에 없는 메뉴는 건너뛴다(내 공간의 메일은 조직에 안 보임)', () => {
  let items = writeNav(readNav([], 'org'), { move: ['perf', 'home'] }); // 성과 기록을 맨 위로
  assert.deepEqual(readNav(items, 'org').shown.slice(0, 3), ['perf', 'home', 'calendar']);
  items = writeNav(readNav(items, 'org'), { hide: 'outputs' });
  assert.deepEqual(readNav(items, 'org').hidden, ['outputs']);
  assert.ok(!readNav(items, 'org').shown.includes('outputs'));
  assert.deepEqual(readNav(items, 'me').shown, NAV.me); // 내 공간 목록에는 영향 없음(성과 기록·산출물이 없다)
  items = writeNav(readNav(items, 'org'), { show: 'outputs' });
  assert.ok(readNav(items, 'org').shown.includes('outputs'));
});

// 이유(유건 9/30 일정 명세): 좌측 메뉴 '일정'은 개인·조직 모두 홈 바로 다음
test('일정 메뉴는 두 공간 모두 홈 바로 다음', () => {
  assert.deepEqual(NAV.me.slice(0, 2), ['home', 'calendar']);
  assert.deepEqual(NAV.org.slice(0, 2), ['home', 'calendar']);
  assert.deepEqual(readNav([], 'me').shown.slice(0, 2), ['home', 'calendar']);
});

test('홈은 숨길 수 없고, 모르는 id·중복은 버린다', () => {
  const items = writeNav(readNav([{ id: 'home', hidden: true }, { id: 'zzz' }, { id: 'perf' }, { id: 'perf' }], 'org'), { hide: 'home' });
  const r = readNav(items, 'org');
  assert.ok(r.shown.includes('home'));
  assert.deepEqual(r.shown.filter((x) => x === 'perf').length, 1);
  assert.ok(!items.some((x) => x.id === 'zzz'));
});

test('칸 순서: 에이전트 칸을 맨 위로', () => {
  const items = writeNav(readNav([], 'org'), { section: ['crews', 'menu'] });
  assert.deepEqual(readNav(items, 'org').sections, ['crews', 'menu', 'pages']);
});

test('moveId: a를 b 자리로, 같은 자리·없는 id면 그대로', () => {
  assert.deepEqual(moveId(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a']);
  assert.deepEqual(moveId(['a', 'b'], 'a', 'x'), ['a', 'b']);
});

test('업무 탭: 내 순서대로, 조직이 끈 탭은 빼고, 새로 켠 탭은 기본 순서대로 뒤에', () => {
  const modules = ['customers', 'catalog', 'orders', 'inventory', 'payments', 'analytics'];
  assert.deepEqual(orderTabs(modules, ['customers', 'orders', 'payments', 'analytics'], [{ id: 'analytics' }, { id: 'orders' }]), ['analytics', 'orders', 'customers', 'payments']);
  assert.deepEqual(orderTabs(modules, modules, []), modules);
});
