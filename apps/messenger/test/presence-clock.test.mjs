// 주기 다시 읽기를 없앤 뒤(기능 점검 D2) 켜진 에이전트가 90초 뒤 꺼진 것으로 보이지 않게 — 받아 온 때의 상태를 다음에 받을 때까지 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { presenceNow, seenWithin, stampFetched, markSeen } from '../src/presence-clock.mjs';
import { crewAvailability } from '../src/crew-status.mjs';
import { crewFaceState } from '../src/crew-face.mjs';
import { crewAwayNotice } from '../src/crew-dm-notice.mjs';

const AWAY = 90_000; const T = Date.parse('2026-10-02T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('받아 온 때 켜져 있던 에이전트는 10분이 지나도 켜짐(다시 받기 전까지), 그때 꺼져 있던 에이전트는 꺼짐', () => {
  const [on, off] = stampFetched([{ id: 'a', last_seen_at: iso(T - 30_000) }, { id: 'b', last_seen_at: iso(T - 200_000) }], T);
  assert.equal(presenceNow(on, T + 600_000), T);
  assert.equal(seenWithin(on, AWAY, T + 600_000), true);
  assert.equal(seenWithin(off, AWAY, T + 600_000), false);
  assert.equal(seenWithin({ id: 'c', last_seen_at: iso(T - 30_000) }, AWAY, T + 600_000), false, '_at이 없으면 종전대로 지금 시각 기준');
});

test('입력 중·답글 방송은 그 행만 지금 본 것으로 고친다', () => {
  const rows = stampFetched([{ id: 'a', last_seen_at: iso(T - 500_000) }, { id: 'b', last_seen_at: null }], T);
  const next = markSeen(rows, 'a', T + 300_000);
  assert.equal(seenWithin(next[0], AWAY, T + 300_000), true);
  assert.equal(next[1], rows[1], '다른 행은 그대로');
  assert.equal(markSeen(rows, 'zz', T), rows, '없는 에이전트면 목록을 바꾸지 않는다');
});

test('세 판정(대화 가능 상태·얼굴·꺼짐 안내)이 같은 기준을 쓴다', () => {
  const [on] = stampFetched([{ id: 'a', status: 'active', last_seen_at: iso(T - 30_000), display_name: 'A', owner_user_id: 'u' }], T);
  const later = T + 600_000;
  assert.equal(crewAvailability(on, { now: later, awayMs: AWAY }).state, 'ready');
  assert.equal(crewFaceState({ crew: on, now: later }), 'idle');
  assert.equal(crewAwayNotice({ channel: { kind: 'dm' }, chCrews: [on], people: [{}], uid: 'u', now: later, awayMs: AWAY }), null);
});
