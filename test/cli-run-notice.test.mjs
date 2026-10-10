// argo run 시작 안내 — 회사 동기화·실행 담당 판정 전에는 "불러오는 중·확인 중"으로, 판정 뒤에만 실제 결과로 말한다.
// VPS 0.1.100 제보(2026-10-10): 시작 줄이 "company - · 이 기기가 실행을 먼저 맡음"이라 했는데 25초 뒤 실제로는 맥에 양보했고, 사용자는 계정 문제로 착각했다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRoleState, roleChanged } from '../src/cli/run-notice.mjs';

const ME = 'vps-1';
const NOW = 1_000_000;
const check = (o = {}) => ({ syncOn: true, leader: true, ownedAt: 0, checkedAt: 0, holder: null, ...o });

test('기동 직후(리스를 아직 한 번도 읽지 않음) — leader 기본값이 참이어도 판정 전이라 아무 결과도 말하지 않는다', () => {
  assert.equal(runRoleState(check(), ME, NOW), null);
});
test('리스를 읽고 쓴 뒤 재확인 중(보유 확인 전) — 아직 모른다', () => {
  assert.equal(runRoleState(check({ checkedAt: NOW, holder: { deviceId: ME, ts: NOW } }), ME, NOW), null);
});
test('보유를 확인했으면 이 기기가 맡았다', () => {
  assert.deepEqual(runRoleState(check({ checkedAt: NOW, ownedAt: NOW, holder: { deviceId: ME, ts: NOW } }), ME, NOW), { kind: 'leader' });
});
test('보유 표시가 남아 있어도 실제 실행 판정(isCloudLeader)이 꺼져 있으면 맡았다고 하지 않는다(확인 기한 지남·깬 뒤 재확인 전)', () => {
  const c = check({ checkedAt: NOW, ownedAt: NOW - 60_000, holder: { deviceId: ME, ts: NOW - 60_000 }, active: false });
  assert.deepEqual(runRoleState(c, ME, NOW), { kind: 'waiting' });
  assert.deepEqual(runRoleState({ ...c, active: true }, ME, NOW), { kind: 'leader' });
});
test('다른 기기의 살아 있는 리스에 양보했으면 그 기기 이름으로 알린다(제보 상황: 맥에 양보)', () => {
  const c = check({ leader: false, checkedAt: NOW, holder: { deviceId: 'Geony-Mac-Pro', ts: NOW - 5_000 } });
  assert.deepEqual(runRoleState(c, ME, NOW), { kind: 'other', holder: 'Geony-Mac-Pro' });
});
test('담당이 아니고 살아 있는 다른 담당도 없으면(러너 없음 양보·예비 대기) 아직 정해지지 않음', () => {
  assert.deepEqual(runRoleState(check({ leader: false, checkedAt: NOW, holder: { deviceId: 'old-mac', ts: NOW - 200_000 } }), ME, NOW), { kind: 'waiting' });
  assert.deepEqual(runRoleState(check({ leader: false, checkedAt: NOW }), ME, NOW), { kind: 'waiting' });
});
test('동기화가 꺼져 있으면 리스 판정이 없으니 말하지 않는다', () => {
  assert.equal(runRoleState(check({ syncOn: false, checkedAt: NOW, ownedAt: NOW }), ME, NOW), null);
});
test('바뀐 경우에만 다시 알린다 — 같은 결과·판정 전(null)은 조용히, 담당 기기가 바뀌면 다시', () => {
  assert.equal(roleChanged(null, { kind: 'leader' }), true);
  assert.equal(roleChanged({ kind: 'leader' }, { kind: 'leader' }), false);
  assert.equal(roleChanged({ kind: 'leader' }, null), false, '갱신 중의 판정 전 순간은 알리지 않는다');
  assert.equal(roleChanged({ kind: 'other', holder: 'a' }, { kind: 'other', holder: 'b' }), true);
  assert.equal(roleChanged({ kind: 'other', holder: 'a' }, { kind: 'leader' }), true);
});
