import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCrews, moveIds, reslot } from '../src/core/crew-list.js';

// 좌측 크루 목록 정리(유건 9/30): 고정 → 내 에이전트, 쓸 수 없는 크루는 따로(blocked).
const ME = 'me';
const c = (id, extra = {}) => ({ id, name: id, owner: 'other', ownerName: '김관리', company: false, access: 'ok', dept: '', pinned: false, pinPos: null, sortPos: null, status: 'idle', ...extra });
const names = (g) => g.crews.map((x) => x.id);

test('오피스에는 내 크루만 — 회사 크루·동료 크루는 쓸 수 있어도 빠진다(유건 9/30), 묶음은 고정 → 내 크루', () => {
  const r = groupCrews([c('동료1'), c('회사1', { company: true }), c('내것', { owner: ME }), c('고정', { owner: ME, pinned: true, pinPos: 0 }), c('남의고정', { pinned: true, pinPos: 1 })], { me: ME });
  assert.deepEqual(r.groups.map((g) => [g.key, names(g)]), [['pinned', ['고정']], ['mine', ['내것']]]);
  assert.deepEqual(r.blocked, []);
});

test('남의 크루는 꺼졌든 막혔든 없다 — 맨 아래 칸에는 꺼진 내 크루만', () => {
  const r = groupCrews([c('막힘', { access: 'crew_allow' }), c('남의꺼짐', { access: 'inactive' }), c('내꺼짐', { owner: ME, access: 'inactive' }), c('됨', { owner: ME })], { me: ME });
  assert.deepEqual(r.groups.map((g) => [g.key, names(g)]), [['mine', ['됨']]]);
  assert.deepEqual(r.blocked.map((x) => x.id), ['내꺼짐']);
});

test('순서: 내 크루는 직접 배치(sortPos) 순서, 없는 크루는 뒤에 이름순 — 고정 묶음은 pinPos, 둘 다 끌어 옮긴다', () => {
  const mine = { owner: ME };
  const r = groupCrews([c('다', mine), c('가', { ...mine, sortPos: 1 }), c('나', { ...mine, sortPos: 0 }), c('라', mine), c('P2', { ...mine, pinned: true, pinPos: 1 }), c('P1', { ...mine, pinned: true, pinPos: 0 })], { me: ME });
  assert.deepEqual(names(r.groups[0]), ['P1', 'P2']);
  assert.deepEqual(names(r.groups[1]), ['나', '가', '다', '라']);
  assert.deepEqual(r.groups.map((g) => g.movable), [true, true]);
});

// 이유(유건 9/30 #6): 필터 메뉴(주인별·부서별·일하는 중만)를 뺐다 — 옛 옵션을 넘겨도 묶음은 고정·내 에이전트 둘뿐, 고정한 크루는 내 에이전트에서 빠진다
test('묶음은 고정·내 에이전트 둘뿐 — 옛 부서별·일하는 중 옵션은 무시, 고정한 크루는 한 번만 보인다', () => {
  const list = [c('a', { owner: ME, dept: '영업', status: 'idle' }), c('p', { owner: ME, pinned: true, pinPos: 0, dept: '영업', status: 'work' })];
  const r = groupCrews(list, { me: ME, by: 'dept', working: true });
  assert.deepEqual(r.groups.map((g) => [g.key, names(g)]), [['pinned', ['p']], ['mine', ['a']]]);
});

test('검색은 이름·주인·부서·직무에서', () => {
  const list = [c('오길비', { owner: ME, dept: '마케팅', status: 'work' }), c('울프', { owner: ME, job: '영업 팀장' }), c('비스트', { owner: ME, role: '광고 오퍼레이터' })];
  assert.deepEqual(groupCrews(list, { me: ME, query: '오길' }).groups.flatMap(names), ['오길비']);
  assert.deepEqual(groupCrews(list, { me: ME, query: '팀장' }).groups.flatMap(names), ['울프']); // 직무로도
  assert.deepEqual(groupCrews(list, { me: ME, query: '광고' }).groups.flatMap(names), ['비스트']);
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
