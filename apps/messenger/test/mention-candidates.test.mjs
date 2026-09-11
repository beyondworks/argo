import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionCandidates } from '../src/mention-candidates.mjs';

const crews = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, display_name: `크루${i}`, role_text: '역할' }));
const members = [{ user_id: 'me', display_name: '나', role: 'owner' }, { user_id: 'u2', display_name: 'lean8kim', role: 'member' }];

test('크루가 상한(8)보다 많아도 채널의 사람이 먼저 뜬다; 나 자신은 빠진다', () => {
  const list = mentionCandidates({ q: '', crews, members, uid: 'me' });
  assert.equal(list.length, 8);
  assert.deepEqual(list[0], { kind: 'user', id: 'u2', name: 'lean8kim', sub: 'member' });
  assert.ok(!list.some((x) => x.id === 'me'));
  assert.equal(list.filter((x) => x.kind === 'crew').length, 7);
});

test('검색어는 사람·크루 이름에 대소문자 없이 부분 일치한다', () => {
  assert.deepEqual(mentionCandidates({ q: 'LEAN', crews, members, uid: 'me' }).map((x) => x.id), ['u2']);
  assert.deepEqual(mentionCandidates({ q: '크루1', crews, members, uid: 'me' }).map((x) => x.id), ['c1', 'c10', 'c11', 'c12']);
});
