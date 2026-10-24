// 한 목록 1:1 이름 고정(src/v2/stable-names.mjs) — 고른 방의 공간과 무관(유건 사용 검수 2026-10-24).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPeerNames, peerName, peerKey } from '../src/v2/stable-names.mjs';

const P = '__personal__';
const rows = [
  { room_kind: 'direct', room_name: '', space_kind: 'personal', space_id: 'p1', peer_kind: 'user', peer_id: 'mate' },
  { room_kind: 'direct', room_name: null, space_kind: 'team', space_id: 'T', peer_kind: 'user', peer_id: 'mate' },
  { room_kind: 'private', room_name: '', space_kind: 'personal', space_id: 'p1', peer_kind: 'agent', peer_id: 'ag' },
  { room_kind: 'private', room_name: '주말 모임', space_kind: 'personal', space_id: 'p1', peer_kind: 'user', peer_id: 'x' },
];
const resolver = () => { const calls = []; const fn = async (_sb, { orgId, ids }) => { calls.push([orgId, ids]); return Object.fromEntries(ids.map((id) => [id, orgId ? `${id}@${orgId}` : `${id}@profile`])); }; fn.calls = calls; return fn; };

test('행의 공간 기준: 개인 공간 1:1 = 프로필 이름, 팀 공간 1:1 = 그 팀 안 이름 — 에이전트 1:1·이름 붙은 방은 묻지 않는다', async () => {
  const resolve = resolver();
  const got = await loadPeerNames(null, rows, { personalKey: P, resolve });
  assert.deepEqual(got, { [`${P}:mate`]: 'mate@profile', 'T:mate': 'mate@T' });
  assert.deepEqual(resolve.calls, [[null, ['mate']], ['T', ['mate']]]);
});

test('아는 (공간, 사람)은 다시 묻지 않고, 모른다는 답(null)도 기억한다', async () => {
  const resolve = resolver();
  const got = await loadPeerNames(null, rows, { personalKey: P, known: { [`${P}:mate`]: 'x', 'T:mate': null }, resolve });
  assert.deepEqual(got, {}); assert.equal(resolve.calls.length, 0);
  const empty = async () => ({});
  assert.deepEqual(await loadPeerNames(null, rows.slice(0, 1), { personalKey: P, resolve: empty }), { [`${P}:mate`]: null });
});

test('이름 = 고정 이름 → 없으면 종전 함수(지금 공간 이름) — 고른 방이 바뀌어도 같은 값', () => {
  const names = { [`${P}:mate`]: 'cocoball0610' };
  const nowTeam = (id) => `${id}-팀이름`; const nowPersonal = (id) => `${id}-개인`;
  assert.equal(peerName(rows[0], names, P, nowTeam), 'cocoball0610');
  assert.equal(peerName(rows[0], names, P, nowPersonal), 'cocoball0610', '고른 공간이 바뀌어도 같다');
  assert.equal(peerName(rows[1], names, P, nowTeam), 'mate-팀이름', '아직 모르면 종전 값');
  assert.equal(peerKey(rows[1], P), 'T:mate');
});
