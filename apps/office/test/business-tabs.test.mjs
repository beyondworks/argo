import test from 'node:test';
import assert from 'node:assert/strict';
import { readTabs, writeTabs, canHide, pickTab, tabBar, afterHide } from '../src/business/tab-model.js';

const ALL = ['customers', 'catalog', 'orders', 'inventory', 'payments', 'analytics', 'marketing'];
const at = (saved, enabled = ALL) => readTabs(ALL, enabled, saved);

// 이유(유건 9/30): 업무 탭 순서는 사람마다 — 조직이 끈 탭은 빼고, 새로 켠 탭은 기본 순서대로 뒤에(예전 orderTabs 동작 유지)
test('업무 탭: 내 순서대로, 조직이 끈 탭은 빼고, 새로 켠 탭은 기본 순서대로 뒤에', () => {
  const modules = ['customers', 'catalog', 'orders', 'inventory', 'payments', 'analytics'];
  assert.deepEqual(readTabs(modules, ['customers', 'orders', 'payments', 'analytics'], [{ id: 'analytics' }, { id: 'orders' }]).shown, ['analytics', 'orders', 'customers', 'payments']);
  assert.deepEqual(readTabs(modules, modules, []).shown, modules);
  assert.deepEqual(readTabs(modules, modules, undefined).shown, modules);
});

// 이유(유건 9/30 5번): 좌측 메뉴처럼 우클릭으로 숨기고 '숨긴 탭 N'에서 다시 켠다 — 저장은 biztabs:me 한 목록
test('숨기기·다시 켜기: 숨긴 탭은 탭 줄에서 빠지고 숨긴 목록에 들어간다, 순서는 그대로', () => {
  let items = writeTabs(at([]), { hide: 'catalog' });
  assert.deepEqual(items.find((x) => x.id === 'catalog'), { id: 'catalog', hidden: true });
  assert.deepEqual(at(items).hidden, ['catalog']);
  assert.ok(!at(items).shown.includes('catalog'));
  items = writeTabs(at(items), { move: ['marketing', 'customers'] });
  assert.deepEqual(at(items).hidden, ['catalog'], '끌어서 순서를 바꿔도 숨김은 남는다');
  assert.equal(at(items).shown[0], 'marketing');
  items = writeTabs(at(items), { show: 'catalog' });
  assert.deepEqual(at(items).hidden, []);
  assert.deepEqual(at(items).shown.slice(0, 3), ['marketing', 'customers', 'catalog'], '다시 켜면 제자리로 돌아온다');
});

// 이유: 탭이 하나도 없으면 업무 화면으로 돌아올 길이 없다
test('마지막 남은 탭은 숨길 수 없다', () => {
  const two = ['customers', 'orders'];
  let s = at([], two);
  assert.ok(canHide(s, 'orders'));
  const items = writeTabs(s, { hide: 'orders' });
  s = at(items, two);
  assert.deepEqual(s.shown, ['customers']);
  assert.equal(canHide(s, 'customers'), false);
  assert.equal(writeTabs(s, { hide: 'customers' }), null);
});

// 이유: 조직이 남은 보이는 탭을 끄면 켜진 탭이 전부 숨긴 탭이 될 수 있다 — 탭 줄이 비지 않게 첫 탭은 보인다(저장값은 안 바꾼다)
test('켜진 탭이 전부 숨긴 탭이면 첫 탭은 보인다', () => {
  const items = [{ id: 'customers', hidden: true }, { id: 'orders', hidden: true }];
  const s = at(items, ['customers', 'orders']);
  assert.deepEqual(s.shown, ['customers']);
  assert.deepEqual(s.hidden, ['orders']);
  assert.deepEqual(writeTabs(s, { show: 'orders' }).filter((x) => x.hidden).map((x) => x.id), ['customers'], '다른 조작으로 저장해도 숨김 표시는 남는다');
});

// 이유: 조직이 탭을 껐다 다시 켜도 내 순서·숨김이 사라지지 않아야 한다
test('꺼진 탭도 내 자리·숨김을 기억한다', () => {
  let items = writeTabs(at([]), { move: ['inventory', 'customers'] }); // 재고를 맨 앞으로
  items = writeTabs(at(items), { hide: 'inventory' });
  items = writeTabs(at(items, ALL.filter((x) => x !== 'inventory')), { move: ['analytics', 'catalog'] }); // 재고를 끈 동안 다른 탭을 옮김
  assert.deepEqual(items[0], { id: 'inventory', hidden: true });
  assert.deepEqual(at(items).hidden, ['inventory']);
  assert.equal(at(writeTabs(at(items), { show: 'inventory' })).shown[0], 'inventory', '다시 켜면 맨 앞 제자리');
});

// 이유(유건 9/30 5번): 숨긴 탭 주소로 직접 들어오면(홈 카드·옛 링크) 링크가 깨지지 않게 그 탭을 보여 주고, 탭 줄에는 '숨긴 탭'으로 제자리에 표시
test('숨긴 탭 주소로 들어오면 그 탭을 보여 주고 탭 줄 제자리에 넣는다', () => {
  const s = at(writeTabs(at([]), { hide: 'orders' }));
  assert.equal(pickTab(s, 'orders'), 'orders');
  assert.deepEqual(tabBar(s, 'orders'), ALL);
  assert.deepEqual(tabBar(s, 'customers'), ALL.filter((x) => x !== 'orders'));
});

test('꺼진 탭·모르는 주소는 분석, 분석을 숨겼으면 보이는 첫 탭', () => {
  assert.equal(pickTab(at([], ['customers', 'analytics']), 'orders'), 'analytics');
  const s = at(writeTabs(at([]), { hide: 'analytics' }));
  assert.equal(pickTab(s, 'nope'), 'customers');
  assert.equal(pickTab(s, 'analytics'), 'analytics', '숨긴 분석 주소로 오면 그대로 분석');
});

// 이유(유건 9/30 5번): 지금 보고 있는 탭을 숨기면 빈 화면에 남지 않고 남은 첫 탭으로 간다
test('지금 보는 탭을 숨기면 남은 첫 탭으로, 다른 탭을 숨기면 그대로', () => {
  const s = at([]);
  assert.equal(afterHide(s, 'customers', 'customers'), 'catalog');
  assert.equal(afterHide(s, 'orders', 'customers'), null);
});

test('모르는 id·중복·깨진 저장값은 버린다', () => {
  const s = at([{ id: 'zzz', hidden: true }, null, { id: 'orders' }, { id: 'orders' }, 'x']);
  assert.deepEqual(s.shown.slice(0, 1), ['orders']);
  assert.ok(!s.order.includes('zzz'));
  assert.deepEqual(new Set(s.order).size, s.order.length);
});
