// 메신저 v2 U2 — 서버(SQL)가 약속 v1(packages/agent-link/contract/v1.mjs)과 같은 판정을 내리는지 칸마다 대조한다.
// ① 봉투 검사: 예제 전부(유효·무효) + 변형을 _msgr2_env_check와 validateEnvelope(from: runner)에 같이 넣어 코드가 같은지
// ② 상태 전이: 상태(9) × type(10) × data 변형 × 같은 기기 × 세대를 _msgr2_next_state와 nextState에 같이 넣어 결과가 같은지
// ③ 등급: _msgr2_tier_allows와 tierAllows
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-work-contract-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { validateEnvelope, nextState, tierAllows, TYPES, STATES, DERIVED_STATES, TIERS, SUPPORTED } from '../packages/agent-link/contract/v1.mjs';
import { setup } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-work-contract-pg.test.mjs';
const here = (p) => fileURLToPath(new URL(`../packages/agent-link/contract/${p}`, import.meta.url));
const load = (dir) => readdirSync(here(`examples/${dir}`)).filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, env: JSON.parse(readFileSync(here(`examples/${dir}/${f}`), 'utf8')) }));
const clone = (x) => structuredClone(x);

let db;
before(() => { if (DB) db = setup(DB); });

// 여러 칸을 한 질의로: 입력 배열(jsonb) → 결과 배열
const batch = (rows, expr) => JSON.parse(db.sql(`select coalesce(jsonb_agg(${expr} order by ord), '[]') from jsonb_array_elements(${db.lit(rows)}) with ordinality as r(x, ord)`));

test('봉투 검사 — 예제 전부와 변형에서 SQL 거부 코드 = v1 validateEnvelope(from: runner) 코드', { skip }, () => {
  const all = [...load('valid'), ...load('invalid')].map((x) => x.env);
  const base = all.find((e) => e.type === 'work.accept');
  const result = all.find((e) => e.type === 'work.result');
  const variants = [
    { ...clone(base), v: 0 }, { ...clone(base), v: 1.5 }, { ...clone(base), v: '1' }, { ...clone(base), type: 7 },
    { ...clone(base), seq: -1 }, { ...clone(base), seq: 2 ** 53 }, { ...clone(base), at: '2026-10-17' }, { ...clone(base), device: null },
    { ...clone(base), data: [] }, (() => { const e = clone(base); delete e.agent; return e; })(), { ...clone(base), data: { lease_gen: 0 } },
    { ...clone(base), data: { lease_gen: 3 } }, { ...clone(result), data: { ...result.data, files: ['x'] } },
    { ...clone(result), data: { ...result.data, handoffs: [{ agent: base.agent, text: '' }] } },
    { ...clone(result), data: { ...result.data, usage: { input_tokens: -1 } } }, { ...clone(result), data: { ...result.data, usage: null } },
    { ...clone(base), type: 'work.error', data: { code: 'Bad', runner: null } }, { ...clone(base), type: 'work.error', data: { code: 'timeout' } },
    { ...clone(base), type: 'work.error', data: { code: 'timeout', runner: 'claude', retry_at: null } },
    { ...clone(base), type: 'work.effect', data: { effect_key: 'k', state: 'done', kind: 'Mail' } },
    { ...clone(base), type: 'work.approval_request', data: { approval_id: base.id, action: 'a', risk: 'mid', summary: 's', effect_key: null, expires_at: base.at } },
    { ...clone(base), type: 'work.approval_request', data: { approval_id: base.id, action: 'a', risk: 'low', summary: 's', expires_at: base.at } },
    { ...clone(base), type: 'agent.sync', work: null, agent: null, data: { agents: [{ ws: 'w', slug: 's', name: 'n', role: '', face_hash: null }] } },
    { ...clone(base), type: 'agent.sync', work: null, agent: null, data: { agents: [{ ws: 'w', slug: 's', name: 'n', role: '' }] } },
    { ...clone(base), type: 'work.progress', data: { stage: 'tool', note: 'x'.repeat(201) } },
    'not-an-object', null, [1],
    // v1.1 변형(약속 덧붙임 — 20261019155000)
    { ...clone(result), data: { ...result.data, handoffs: [], posts: [{ agent: base.agent, round: 0, text: 'x' }] } },
    { ...clone(result), data: { ...result.data, handoffs: [], posts: [{ agent: base.agent, round: 3, text: 'x' }] } },
    { ...clone(result), data: { ...result.data, handoffs: [], posts: [{ agent: base.agent, round: 2, text: 'x'.repeat(3001) }] } },
    { ...clone(result), data: { ...result.data, handoffs: [], posts: [{ agent: 'nope', round: 1, text: 'x' }] } },
    { ...clone(result), data: { ...result.data, handoffs: [], posts: [{ agent: base.agent, round: 1, text: '' }] } },
    { ...clone(result), data: { ...result.data, handoffs: [], posts: 'x' } },
    { ...clone(result), data: { ...result.data, handoffs: [], posts: [] } },
    { ...clone(base), type: 'agent.sync', work: null, agent: null, data: { agents: [{ ws: 'w', slug: 's', name: 'n', role: '', face_hash: null, kind: 'Bot' }] } },
    { ...clone(base), type: 'agent.sync', work: null, agent: null, data: { agents: [{ ws: 'w', slug: 's', name: 'n', role: '', face_hash: null, kind: 'bot', bot: { profile: 'p' } }] } },
    { ...clone(base), type: 'agent.sync', work: null, agent: null, data: { agents: [{ ws: 'w', slug: 's', name: 'n', role: '', face_hash: null, kind: 'bot', bot: null }] } },
    { ...clone(base), type: 'agent.sync', work: null, agent: null, data: { agents: [], features: 'meeting' } },
    { ...clone(base), type: 'agent.sync', work: null, agent: null, data: { agents: [], features: ['Meeting'] } },
    { ...clone(base), type: 'agent.sync', work: null, agent: null, data: { agents: [], features: Array.from({ length: 17 }, (_, i) => `f${i}`) } },
  ];
  const cases = [...all, ...variants];
  const sqlCodes = batch(cases, `public._msgr2_env_check(x, ${SUPPORTED.min}, ${SUPPORTED.max})`);
  cases.forEach((env, i) => {
    const r = validateEnvelope(env, { from: 'runner' });
    assert.equal(sqlCodes[i], r.ok ? null : r.code, `칸 ${i} (${env?.type ?? typeof env}): SQL ${sqlCodes[i]} / v1 ${r.ok ? 'ok' : r.code}`);
  });
});

test('상태 전이 — 모든 상태 × type × data 변형 × 같은 기기 × 세대에서 _msgr2_next_state = v1 nextState', { skip }, () => {
  const datas = {
    'work.accept': [{}, { lease_gen: 1 }, { lease_gen: 2 }],
    'work.effect': [{ effect_key: 'k', state: 'intent' }, { effect_key: 'k', state: 'done' }, { effect_key: 'k', state: 'failed' }],
    'work.error': [{ code: 'unsupported', runner: null }, { code: 'timeout', runner: 'claude' }],
  };
  const rows = [];
  for (const state of [...STATES, ...DERIVED_STATES]) for (const type of TYPES) for (const data of datas[type] ?? [{}])
    for (const sameDevice of [false, true]) for (const leaseGen of [null, 1]) rows.push({ state, type, data, sameDevice, leaseGen });
  const out = batch(rows, `(select jsonb_build_object('ok', n.ok, 'to', n.to_state, 'mark', n.mark, 'code', n.code)
    from public._msgr2_next_state(x->>'state', x->>'type', x->'data', (x->>'sameDevice')::boolean, (x->>'leaseGen')::int) n)`);
  assert.equal(out.length, rows.length);
  rows.forEach((c, i) => {
    const js = nextState(c.state, c.type, c.data, { sameDevice: c.sameDevice, leaseGen: c.leaseGen });
    const want = js.ok ? { ok: true, to: js.to, mark: js.mark ?? null, code: null } : { ok: false, to: null, mark: null, code: js.code };
    assert.deepEqual(out[i], want, `${JSON.stringify(c)}`);
  });
  assert.ok(rows.length > 400, `칸 수 ${rows.length}`);
});

test('등급 — guest는 승인 요청·효과·파일 결과를 못 보낸다(_msgr2_tier_allows = v1 tierAllows)', { skip }, () => {
  const rows = [];
  for (const tier of TIERS) for (const type of TYPES) for (const data of [{}, { files: [] }, { files: ['00000000-0000-4000-8000-000000000001'] }]) rows.push({ tier, type, data });
  const out = batch(rows, `public._msgr2_tier_allows(x->>'tier', x->>'type', x->'data')`);
  rows.forEach((c, i) => assert.equal(out[i], tierAllows(c.tier, c.type, c.data), JSON.stringify(c)));
});

// v1.1 SQL 검사(20261019155000)가 v1.0 봉투를 종전과 똑같이 판정하는지 — 옛 정의(되돌림 파일의 본문)를 다른 이름으로 올려 나란히 본다
test('봉투 검사 v1.1 — v1.0 예제·변형 전부에서 새 SQL 검사 = 옛 SQL 검사(설치된 본체 봉투는 그대로 통과·거부)', { skip }, () => {
  const down = readFileSync(fileURLToPath(new URL('../scripts/rollback/20261019155000_msgr2_link_v1_1_check.down.sql', import.meta.url)), 'utf8');
  const oldFn = down.slice(down.indexOf('create or replace function public._msgr2_env_check'), down.lastIndexOf('commit;')).replace('public._msgr2_env_check(', 'pg_temp.env_check_v10(');
  const v11 = (f) => /meeting|bot|posts/.test(f);
  const v10 = [...load('valid'), ...load('invalid')].filter((x) => !v11(x.f)).map((x) => x.env);
  assert.ok(v10.length >= 20, `v1.0 예제 ${v10.length}개`);
  const r = JSON.parse(db.psql(['-A', '-t', '-c', `${oldFn}
    select coalesce(jsonb_agg(jsonb_build_array(public._msgr2_env_check(x, 1, 1), pg_temp.env_check_v10(x, 1, 1)) order by ord), '[]') from jsonb_array_elements(${db.lit(v10)}) with ordinality as r(x, ord);`]).trim().split('\n').at(-1));
  r.forEach(([now, old], i) => assert.equal(now, old, `v1.0 예제 ${i} (${v10[i].type}): 새 ${now} / 옛 ${old}`));
  assert.ok(r.filter(([x]) => x === null).length >= 6, '본체가 보내는 정상 v1.0 봉투(accept·progress·approval_request·effect·result·error·agent.sync 등)가 통과한다');
});
