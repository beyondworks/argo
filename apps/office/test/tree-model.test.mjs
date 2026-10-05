// 페이지 트리 '옮기기'(src/pages/tree-model.js, 16차 — PARITY-tasks D6). 서버 office_page_move가 거절할 곳은 처음부터 보이지 않아야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveTargets, filterTargets, hiddenOf } from '../src/pages/tree-model.js';

const pg = (id, parent = null, extra = {}) => ({ id, parent, space: 'org1', title: id.toUpperCase(), position: id, access: 'edit', ...extra });
const PAGES = [
  pg('a'), pg('a1', 'a'), pg('a11', 'a1'), pg('b'), pg('b1', 'b'), pg('c', null, { access: 'view' }), pg('c1', 'c'),
  pg('s', null, { restricted: true }), pg('s1', 's'),
  pg('t', null, { template: true }), { ...pg('m'), space: 'me' },
];
const ids = (list) => list.map((x) => x.id);

test('자기 자신·하위는 빠지고, 다른 공간·템플릿도 빠진다 — 트리 순서와 깊이', () => {
  const list = moveTargets(PAGES, PAGES[1], { admin: true }); // a1 옮기기
  assert.deepEqual(ids(list), [null, 'a', 'b', 'b1', 'c1', 's', 's1']);
  assert.equal(list.find((x) => x.id === 'a').current, true, '지금 상위는 표시만(고를 수 없다)');
  assert.equal(list.find((x) => x.id === 'b1').depth, 1);
  assert.ok(!ids(list).includes('a11') && !ids(list).includes('a1'), '자기와 하위');
  assert.ok(!ids(list).includes('t') && !ids(list).includes('m'), '템플릿·다른 공간');
});

test('고칠 수 없는 페이지 아래로는 못 간다(보기만 공유된 c) — 그 아래 고칠 수 있는 c1은 된다', () => {
  const list = moveTargets(PAGES, PAGES[3], { admin: true });
  assert.ok(!ids(list).includes('c'));
  assert.ok(ids(list).includes('c1'));
});

test('맨 위로: 조직 위키는 관리자만, 내 공간은 누구나 — 서버와 같은 기준', () => {
  assert.equal(moveTargets(PAGES, PAGES[1], { admin: false })[0]?.id === null, false, '조직 멤버는 맨 위로 못 옮긴다');
  const me = [{ ...pg('x'), space: 'me', access: 'full' }, { ...pg('y', 'x'), space: 'me', access: 'full' }];
  assert.equal(moveTargets(me, me[1], {})[0].id, null);
});

test('조직 위키 일반 멤버는 비공개 영역을 넘나들 수 없다(서버 검수 M2) — 관리자는 된다', () => {
  assert.equal(hiddenOf(PAGES, PAGES.find((x) => x.id === 's1')), true);
  const member = moveTargets(PAGES, PAGES[1], { admin: false });
  assert.ok(!ids(member).includes('s') && !ids(member).includes('s1'), '공개 페이지를 비공개 아래로 옮기면 숨김이 생긴다');
  const out = moveTargets(PAGES, PAGES.find((x) => x.id === 's1'), { admin: false });
  assert.ok(!ids(out).includes('a') && !ids(out).includes('b'), '비공개 아래 페이지를 밖으로 옮기면 숨김이 풀린다');
  assert.ok(ids(moveTargets(PAGES, PAGES[1], { admin: true })).includes('s'));
});

test('예시 데이터 모드: 권한 칸이 없는 예시 페이지도 고를 수 있다(공유받은 남의 페이지는 빼고)', () => {
  const sample = [{ id: 'x', parent: null, space: 'me', title: 'X', position: 'a' }, { id: 'y', parent: null, space: 'me', title: 'Y', position: 'b' }];
  assert.deepEqual(ids(moveTargets(sample, sample[1], { sample: true })), [null, 'x']);
  assert.deepEqual(ids(moveTargets(sample, sample[1], { sample: false })), [null], '권한을 모르면 고르지 않는다(로그인 상태)');
});

test('찾기: 이름에 글자가 든 곳만(대소문자 무시), 비우면 전부', () => {
  const list = moveTargets(PAGES, PAGES[1], { admin: true });
  assert.deepEqual(ids(filterTargets(list, 'b')), ['b', 'b1']);
  assert.equal(filterTargets(list, '  ').length, list.length);
});
