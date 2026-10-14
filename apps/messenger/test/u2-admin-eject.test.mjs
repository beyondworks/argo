// U2 G3·G4(2026-10-14): 방장 '내보내기' 메뉴와 주인 안내 판정. 서버 권한 판정은 test/msgr-crew-dispatch-log-pg.test.mjs가 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crewRowMenuKeys } from '../src/crew-row-menu.mjs';
import { adminRemovedNotice, readAdminRemoved } from '../src/dispatch-notice.mjs';

test('crewRowMenuKeys: 조직 채널 방장에게만 남의 개인 에이전트 내보내기 — 내 에이전트·회사 에이전트·개인 공간·대화방에는 없다', () => {
  const base = { isPersonal: false, isDm: false, canKickCrew: true, ownedByMe: false, canHide: true };
  assert.deepEqual(crewRowMenuKeys({ ...base, adminEject: true }), ['manage', 'call', 'eject', 'hide'], '조직 채널 방장 + 남의 개인 에이전트');
  assert.deepEqual(crewRowMenuKeys(base), ['manage', 'call', 'hide'], 'adminEject를 안 넘기면 종전 그대로(옛 판정 고정)');
  assert.ok(!crewRowMenuKeys({ ...base, adminEject: true, ownedByMe: true }).includes('eject'), '내 에이전트는 종전 빼기');
  assert.ok(!crewRowMenuKeys({ ...base, adminEject: true, company: true }).includes('eject'), '회사 에이전트는 종전 remove');
  assert.ok(!crewRowMenuKeys({ ...base, adminEject: true, isPersonal: true }).includes('eject'), '개인 공간(D8)');
  assert.ok(!crewRowMenuKeys({ ...base, adminEject: true, isDm: true }).includes('eject'), '대화방(D8)');
});

test('adminRemovedNotice: 관리자 내보냄만, 최근 7일만, 채널 이름이 없으면 이름 없는 문구', () => {
  const now = Date.parse('2026-10-14T09:00:00Z');
  const row = { event: 'removed_by_admin', at: '2026-10-13T09:00:00Z' };
  assert.deepEqual(adminRemovedNotice(row, { now, channelName: '#general' }), { key: 'crew.removedByAdmin', channel: '#general', at: row.at });
  assert.equal(adminRemovedNotice(row, { now }).key, 'crew.removedByAdmin.noName');
  assert.equal(adminRemovedNotice({ ...row, at: '2026-10-06T08:00:00Z' }, { now }), null, '7일 넘으면 없음');
  assert.equal(adminRemovedNotice({ ...row, event: 'released_by_owner' }, { now }), null, '주인이 스스로 뺀 것은 안내 없음');
  assert.equal(adminRemovedNotice(null, { now }), null);
});

const fake = (tables) => ({ from: (name) => { const r = tables[name]; const q = { select: () => q, eq: () => q, order: () => q, limit: async () => r }; return q; } });
test('readAdminRemoved: 표가 없는 옛 서버(PGRST205)·기록 없음은 null, 채널을 못 읽으면 이름 없이', async () => {
  assert.equal(await readAdminRemoved(fake({ msgr_crew_dispatch_log: { error: { code: 'PGRST205', message: 'not found' } } }), 'c1'), null);
  assert.equal(await readAdminRemoved(fake({ msgr_crew_dispatch_log: { data: [] } }), 'c1'), null);
  const row = { channel_id: 'ch1', event: 'removed_by_admin', at: '2026-10-14T00:00:00Z' };
  assert.deepEqual(await readAdminRemoved(fake({ msgr_crew_dispatch_log: { data: [row] }, msgr_channels: { data: [{ name: 'dev', kind: 'public' }] } }), 'c1'), { row, channelName: '#dev' });
  assert.deepEqual(await readAdminRemoved(fake({ msgr_crew_dispatch_log: { data: [row] }, msgr_channels: { data: [{ name: 'core', kind: 'private' }] } }), 'c1'), { row, channelName: 'core' });
  assert.deepEqual(await readAdminRemoved(fake({ msgr_crew_dispatch_log: { data: [row] }, msgr_channels: { data: [] } }), 'c1'), { row, channelName: null });
});
