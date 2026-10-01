// 점검 A·B #11 — 폰 맨 위의 빨간 사선 "연결된 서버 없음" 아이콘이 늘 보이고 일반 멤버에게도 보이던 결함.
// 기준: 서버를 연결·관리하는 사람만 본다 — 설정의 "에이전트와 서버" 안 서버 연결 카드(OrgCard part="node")가 조직 관리자(owner·admin)에게만 있다.
//  - 멤버·게스트·개인 공간·조직 없음: 표시 없음
//  - 관리자: 서버가 아직 없다/한 번도 안 붙었다 = 중립(경고 아님, 대화만 하는 데는 문제가 아니다), 연결됨 = on,
//    붙었다가 끊김 = 경고(에이전트가 응답하지 않는다 — 실제로 조치가 필요한 상태)
import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeIndicator } from '../src/node-indicator.mjs';

const NOW = Date.parse('2026-10-01T05:00:00Z'); const AWAY = 90_000;
const ind = (o) => nodeIndicator({ now: NOW, awayMs: AWAY, ...o });

test('일반 멤버·게스트에게는 표시하지 않는다', () => {
  for (const role of ['member', 'guest']) assert.equal(ind({ org: { role, service_user_id: null }, isPersonal: false }), null, role);
});

test('개인 공간·조직 없음에서는 표시하지 않는다', () => {
  assert.equal(ind({ org: { role: 'owner' }, isPersonal: true }), null);
  assert.equal(ind({ org: null, isPersonal: false }), null);
});

test('관리자 + 서버 없음 / 한 번도 안 붙음 = 중립(경고 아님)', () => {
  assert.deepEqual(ind({ org: { role: 'owner', service_user_id: null } }), { state: 'none' });
  assert.deepEqual(ind({ org: { role: 'admin', service_user_id: 'svc', node_seen_at: null } }), { state: 'none' });
});

test('관리자 + 연결됨 = on, 붙었다가 끊김 = down(경고)', () => {
  assert.deepEqual(ind({ org: { role: 'admin', service_user_id: 'svc', node_seen_at: new Date(NOW - 30_000).toISOString() } }), { state: 'on' });
  assert.deepEqual(ind({ org: { role: 'owner', service_user_id: 'svc', node_seen_at: new Date(NOW - 10 * 60_000).toISOString() } }), { state: 'down' });
});
