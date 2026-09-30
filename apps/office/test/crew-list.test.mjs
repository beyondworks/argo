import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCrews, moveIds, reslot } from '../src/core/crew-list.js';

// 좌측 크루 목록 정리(유건 9/30): 고정 → 내 크루 → 회사 크루 → 동료 크루(또는 부서별), 쓸 수 없는 크루는 맨 아래 따로.
const ME = 'me';
const c = (id, extra = {}) => ({ id, name: id, owner: 'other', ownerName: '김관리', company: false, access: 'ok', dept: '', pinned: false, pinPos: null, sortPos: null, status: 'idle', ...extra });
const names = (g) => g.crews.map((x) => x.id);

test('기본 묶음: 고정 → 내 크루 → 회사 크루 → 동료 크루, 빈 묶음은 빠진다', () => {
  const r = groupCrews([c('동료1'), c('회사1', { company: true }), c('내것', { owner: ME }), c('고정', { pinned: true, pinPos: 0 })], { me: ME });
  assert.deepEqual(r.groups.map((g) => [g.key, names(g)]), [['pinned', ['고정']], ['mine', ['내것']], ['company', ['회사1']], ['peer', ['동료1']]]);
  assert.deepEqual(r.blocked, []);
});

test('쓸 수 없는 크루(access ≠ ok)는 묶음에서 빠지고 blocked로 — 고정해 둔 크루라도', () => {
  const r = groupCrews([c('막힘', { access: 'crew_allow', pinned: true }), c('꺼짐', { access: 'inactive' }), c('됨')], { me: ME });
  assert.deepEqual(r.groups.map((g) => g.key), ['peer']);
  assert.deepEqual(r.blocked.map((x) => x.id), ['꺼짐', '막힘']);
});

test('순서: 내 크루는 직접 배치(sortPos) 순서, 없는 크루는 뒤에 이름순 — 고정 묶음은 pinPos, 회사·동료 크루는 이름순(끌어 옮기지 않는다)', () => {
  const mine = { owner: ME };
  const r = groupCrews([c('다', mine), c('가', { ...mine, sortPos: 1 }), c('나', { ...mine, sortPos: 0 }), c('라', mine), c('동료나', { sortPos: 0 }), c('동료가', { sortPos: 5 }), c('P2', { pinned: true, pinPos: 1 }), c('P1', { pinned: true, pinPos: 0 })], { me: ME });
  assert.deepEqual(names(r.groups[0]), ['P1', 'P2']);
  assert.deepEqual(names(r.groups[1]), ['나', '가', '다', '라']);
  assert.deepEqual(names(r.groups[2]), ['동료가', '동료나']);
  assert.deepEqual(r.groups.map((g) => g.movable), [true, true, false]);
});

test('부서별 묶음: 부서 이름순, 부서 없음은 맨 뒤 — 고정 묶음은 그대로 맨 위', () => {
  const r = groupCrews([c('a', { dept: '영업' }), c('b', { dept: '' }), c('d', { dept: '마케팅' }), c('p', { pinned: true, dept: '영업' })], { me: ME, by: 'dept' });
  assert.deepEqual(r.groups.map((g) => [g.key, g.label ?? null, names(g)]), [['pinned', null, ['p']], ['dept:마케팅', '마케팅', ['d']], ['dept:영업', '영업', ['a']], ['dept:', null, ['b']]]);
});

test('검색은 이름·주인·부서·직무에서, 일하는 중만 보기는 status가 work·ask인 크루만', () => {
  const list = [c('오길비', { dept: '마케팅', status: 'work' }), c('울프', { ownerName: '오세훈' }), c('비스트', { role: '광고 오퍼레이터' })];
  assert.deepEqual(groupCrews(list, { me: ME, query: '오길' }).groups.flatMap(names), ['오길비']);
  assert.deepEqual(groupCrews(list, { me: ME, query: '오세훈' }).groups.flatMap(names), ['울프']); // 주인 이름으로도
  assert.deepEqual(groupCrews(list, { me: ME, query: '광고' }).groups.flatMap(names), ['비스트']);
  assert.deepEqual(groupCrews(list, { me: ME, working: true }).groups.flatMap(names), ['오길비']);
});

test('예시 데이터(권한·주인 값 없음)는 쓸 수 있는 내 크루로 — 전부 "쓸 수 없는 크루"로 접히던 결함(검수 HIGH)', () => {
  const r = groupCrews([{ id: 'luna', name: '루나', role: '영업', status: 'work' }, { id: 'otto', name: '오토', role: '리서치', status: 'idle' }], { me: ME });
  assert.deepEqual(r.groups.map((g) => [g.key, names(g)]), [['mine', ['luna', 'otto']]]);
  assert.deepEqual(r.blocked, []);
});

test('끌어 옮긴 뒤 순서: moved를 target 자리로, 같은 자리면 null', () => {
  assert.deepEqual(moveIds(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveIds(['a', 'b', 'c'], 'a', 'c'), ['b', 'c', 'a']);
  assert.equal(moveIds(['a', 'b'], 'a', 'a'), null);
});

test('고정 순서는 크루들이 쓰던 번호 칸을 다시 나눈다 — 채널 즐겨찾기(메신저)와 섞인 번호는 그대로', () => {
  const crews = [c('x', { pinned: true, pinPos: 2 }), c('y', { pinned: true, pinPos: 5 }), c('z', { pinned: true, pinPos: 7 })];
  assert.deepEqual([...reslot(crews, ['z', 'x', 'y'])], [['z', 2], ['x', 5], ['y', 7]]);
});
