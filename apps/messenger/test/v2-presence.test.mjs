// 메신저 v2 접속 표시 받기(2026-10-25 0.1.65 결함 2 근본 수정) — v2/presence.mjs(상태 → 켜진 에이전트, 들을 주인) + machine.watchPresence(채널 나눠 쓰기·보일 때만·DB 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { presenceAgents, presenceOwners, PRESENCE_OWNERS_MAX } from '../src/v2/presence.mjs';

test('presenceAgents: 기기 여럿을 합치고, 모양이 다른 값은 버린다', () => {
  const s = { 'dev-1': [{ v: 1, agents: ['a1', 'a2'], presence_ref: 'x' }], 'dev-2': [{ v: 1, agents: ['a3'] }], old: [{ online: true }], bad: [{ v: 2, agents: ['zz'] }], junk: 'x' };
  assert.deepEqual([...presenceAgents(s)].sort(), ['a1', 'a2', 'a3']);
  assert.equal(presenceAgents(null).size, 0);
  assert.equal(presenceAgents({}).size, 0, '옛 본체(track 없음) — 빈 채널');
});

test('presenceOwners: v2 행의 주인만, 나 먼저, 중복 없이, 상한', () => {
  const rows = [{ _v2: true, owner_user_id: 'b' }, { _v2: true, owner_user_id: 'me' }, { _v2: true, owner_user_id: 'b' }, { owner_user_id: 'v1-only' }];
  assert.deepEqual(presenceOwners(rows, 'me'), ['me', 'b']);
  const many = Array.from({ length: 40 }, (_, i) => ({ _v2: true, owner_user_id: `o${i}` }));
  assert.equal(presenceOwners(many, 'me').length, PRESENCE_OWNERS_MAX);
  assert.deepEqual(presenceOwners([], 'me'), []);
});
