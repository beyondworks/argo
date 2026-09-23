// 크루 심박 쓰기 줄이기(2026-09-23 DB 점검: msgr_crews 분당 1,335행 갱신 — 15초 틱마다 모든 크루 행).
// 부재중 판정은 전부 90초(앱 AWAY_MS·work_runs·handoff) — 30초 넘은 행만 갱신하면 행 나이 최대 45초 + 앱 재조회 30초로 안쪽(검수 #689 M3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../src/gateway/msgr.mjs';

test('심박은 30초 넘게 지난(또는 없는) 행만 갱신한다', async () => {
  const seen = [];
  const chain = { update(v) { seen.push(['update', v]); return chain; }, in(k, v) { seen.push(['in', k, v]); return chain; }, or(f) { seen.push(['or', f]); return chain; }, then(res) { res({ data: null, error: null }); } };
  const db = makeDb({ from: (t) => { seen.push(['from', t]); return chain; } });
  const before = Date.now();
  await db.heartbeat(['c1', 'c2']);
  const or = seen.find((x) => x[0] === 'or');
  assert.ok(or, '조건 없이 전 행 갱신하면 red');
  const m = or[1].match(/^last_seen_at\.is\.null,last_seen_at\.lt\.(.+)$/);
  assert.ok(m, or[1]);
  const cutoff = Date.parse(m[1]);
  assert.ok(Math.abs(before - 30_000 - cutoff) < 2_000, '기준 30초(판정 90초 − 행 나이 45초 − 앱 재조회 30초 여유)');
  assert.deepEqual(seen.find((x) => x[0] === 'in'), ['in', 'id', ['c1', 'c2']]);
});
