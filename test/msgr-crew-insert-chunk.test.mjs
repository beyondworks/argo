// 조직 파견 insert 조각(2026-10-15 운영 실측): 에이전트 534명 회사의 첫 미러 353행 한 묶음이 행당 약 28ms 트리거 비용으로
// authenticated statement_timeout 8초를 넘어 57014(PostgREST 500)를 2.2분마다 되풀이했다. → CREW_INSERT_CHUNK행씩 나눠 보내고,
// 같은 조각이 연달아 시간 초과일 때만 다음 시도를 늦춘다(첫 시간 초과·다른 일시 오류는 종전처럼 다음 틱에 다시).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-chunk-'));
const { mirrorInventory, CREW_INSERT_CHUNK } = await import('../src/gateway/msgr.mjs');
const UID = '11111111-1111-4111-8111-111111111111', O1 = 'aaaaaaaa-0000-4000-8000-000000000001', O2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const many = (n) => Array.from({ length: n }, (_, i) => ({ slug: `a${String(i).padStart(3, '0')}`, name: `에이전트 ${i}`, role: null }));
const err = (code, message) => Object.assign(new Error(`msgr db: ${message}`), { code });
const TIMEOUT = () => err('57014', 'canceling statement due to statement timeout');

/** 행을 실제로 들고 있는 가짜 DB — 다음 틱의 myCrewRows가 앞 틱의 insert를 본다(유휴 쓰기 0 확인용). fail(chunk, n) → 던질 오류 또는 null */
function db({ orgs = [O1], fail = () => null } = {}) {
  const rows = [], calls = [];
  let n = 0;
  return { rows, calls,
    async myOrgIds() { return orgs; },
    async myCrewRows() { return rows.map((r) => ({ ...r })); },
    async upsertAvailable(chunk) {
      n++; calls.push(chunk.map((r) => `${r.org_id === O1 ? 'O1' : 'O2'}/${r.slug}`));
      const e = fail(chunk, n); if (e) throw e;
      for (const r of chunk) rows.push({ id: `${r.org_id}/${r.slug}`, org_id: r.org_id, slug: r.slug, display_name: r.display_name, role_text: r.role_text, status: r.status });
    },
    async orgAllowDefaults(ids) { return Object.fromEntries(ids.map((id) => [id, 'owner'])); },
    async updateCrewInfo() {}, async deleteCrews() {},
  };
}
const fresh = () => ({ seen: new Map(), blocked: new Map(), timeouts: new Map(), revive: new Map() });
const run = (d, agents, st, now = () => 0) => mirrorInventory('ws1', { db: d, uid: UID, agents, now, ...st });

test('조각 크기는 50 — 8초 제한 ÷ 행당 약 28ms(운영 실측)의 1/5 안쪽', () => assert.equal(CREW_INSERT_CHUNK, 50));

test('C1 작은 묶음은 종전과 같은 한 요청 — 2명 × 조직 2개 = 4행 한 번', async () => {
  const d = db({ orgs: [O1, O2] }), st = fresh();
  await run(d, many(2), st);
  assert.deepEqual(d.calls, [['O1/a000', 'O1/a001', 'O2/a000', 'O2/a001']]);
});

test('C2 큰 첫 미러(353행) → 50행 조각 8번, 다 만든 뒤 다음 틱은 쓰기 0(유휴)', async () => {
  const d = db(), st = fresh();
  const r = await run(d, many(353), st);
  assert.equal(r.inserted, 353);
  assert.deepEqual(d.calls.map((c) => c.length), [50, 50, 50, 50, 50, 50, 50, 3]);
  assert.equal(new Set(d.rows.map((x) => x.slug)).size, 353);
  await run(d, many(353), st);
  await run(d, many(353), st);
  assert.equal(d.calls.length, 8, '빠진 행이 0이면 upsert 요청 0');
});

test('C3 조각 하나가 일시 오류(503) → 나머지 조각은 저장, 첫 오류는 올리고, 다음 틱은 빠진 그 조각만 다시', async () => {
  const d = db({ fail: (_c, n) => (n === 2 ? err('503', 'Service Unavailable') : null) }), st = fresh();
  await assert.rejects(run(d, many(120), st), /Service Unavailable/);
  assert.deepEqual(d.calls.map((c) => c.length), [50, 50, 20]);
  assert.equal(d.rows.length, 70, '1·3번째 조각은 저장됨');
  await run(d, many(120), st);
  assert.deepEqual(d.calls.slice(3).map((c) => c.length), [50], '저장된 행은 다시 보내지 않는다(멈춘 행을 active로 덮지 않게)');
  assert.deepEqual(d.calls[3], d.calls[1], '실패한 바로 그 조각');
  assert.equal(d.rows.length, 120);
});

test('C4 결정적 오류(42501)는 종전처럼 10분 보류 — 그동안 요청 0, 오류는 계속 드러냄, 10분 뒤 다시', async () => {
  let t = 0;
  const d = db({ fail: () => err('42501', 'msgr_ws_owned_by_other') }), st = fresh();
  await assert.rejects(run(d, many(3), st, () => t), /msgr_ws_owned_by_other/);
  assert.equal(d.calls.length, 1);
  t = 5 * 60_000; await assert.rejects(run(d, many(3), st, () => t), /msgr_ws_owned_by_other/);
  assert.equal(d.calls.length, 1, '보류 중 요청 0');
  t = 10 * 60_000 + 1; await assert.rejects(run(d, many(3), st, () => t), /msgr_ws_owned_by_other/);
  assert.equal(d.calls.length, 2);
});

test('C5 같은 조각이 연달아 시간 초과 → 첫 번째는 다음 틱에 바로 다시, 두 번째부터 1→2분 기다림, 성공하면 바로 풂', async () => {
  let t = 0, timeoutsLeft = 3;
  const d = db({ fail: () => (timeoutsLeft-- > 0 ? TIMEOUT() : null) }), st = fresh();
  const tick = async (at) => { t = at; return run(d, many(10), st, () => t).then(() => 'ok', (e) => e.code); };
  assert.equal(await tick(0), '57014'); // 1회
  assert.equal(await tick(1_000), '57014', '첫 시간 초과 뒤에는 기다리지 않는다(종전 회복 경로)'); // 2회 → 1분 보류
  assert.equal(d.calls.length, 2);
  assert.equal(await tick(30_000), '57014', '보류 중에는 보내지 않고 오류만');
  assert.equal(d.calls.length, 2);
  assert.equal(await tick(61_001), '57014'); // 3회 → 2분 보류
  assert.equal(d.calls.length, 3);
  assert.equal(await tick(61_001 + 119_000), '57014');
  assert.equal(d.calls.length, 3, '2분 보류');
  assert.equal(await tick(61_001 + 120_001), 'ok');
  assert.equal(d.calls.length, 4);
  assert.equal(st.timeouts.size, 0, '성공하면 기록을 지운다');
});

test('C5b 시간 초과 뒤 다른 일시 오류는 보류를 만들지 않는다 — 503은 늘 다음 틱에 다시', async () => {
  const d = db({ fail: () => err('503', 'Service Unavailable') }), st = fresh();
  for (let i = 0; i < 4; i++) await assert.rejects(run(d, many(5), st, () => i * 1_000));
  assert.equal(d.calls.length, 4);
  assert.equal(st.timeouts.size, 0);
});

test('C6 같은 slug가 두 번 든 카드 목록 → 같은 키 행은 한 번만(21000 방어)', async () => {
  const d = db(), st = fresh();
  await run(d, [...many(3), { slug: 'a001', name: '중복', role: null }], st);
  assert.deepEqual(d.calls, [['O1/a000', 'O1/a001', 'O1/a002']]);
});

test('C7 조직이 둘 섞인 조각이 실패 → 그 조각만 조직별로 다시(종전 규칙) — 멀쩡한 조직은 저장', async () => {
  const d = db({ orgs: [O1, O2], fail: (c) => (c.some((r) => r.org_id === O2) ? err('42501', 'msgr_ws_owned_by_other') : null) }), st = fresh();
  await assert.rejects(run(d, many(2), st), /msgr_ws_owned_by_other/);
  assert.deepEqual(d.calls, [['O1/a000', 'O1/a001', 'O2/a000', 'O2/a001'], ['O1/a000', 'O1/a001'], ['O2/a000', 'O2/a001']]);
  assert.deepEqual(d.rows.map((r) => r.slug), ['a000', 'a001']);
});
