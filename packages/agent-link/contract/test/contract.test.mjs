// 약속 v1 계약 시험 — 봉투 검사·예제·JSON Schema 일치·모르는 필드 무시·모르는 type·상태 전이·버전 협상.
// 루트 npm test는 test/agent-link-contract.test.mjs가 이 파일을 불러 돌린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  LATE_MARK, LINK_V, SUPPORTED, TYPES, DIRECTION, CHANNEL, DATA, REJECT_CODES, WORK_ERROR_CODES, STATES, TERMINAL, TRANSITIONS,
  validateEnvelope, nextState, effectiveState, negotiate, tierAllows, unsupportedReply, normalizeWorkErrorCode,
} from '../v1.mjs';
import { buildSchema } from '../schema.mjs';

const here = (p) => new URL(`../${p}`, import.meta.url);
const load = (dir) => readdirSync(here(`examples/${dir}`)).filter((f) => f.endsWith('.json'))
  .map((f) => ({ f, env: JSON.parse(readFileSync(here(`examples/${dir}/${f}`), 'utf8')) }));
const valid = load('valid');
const invalid = load('invalid');
const clone = (x) => JSON.parse(JSON.stringify(x));

// JSON Schema 쪽 검사기 — ajv는 @anthropic-ai/claude-agent-sdk(MCP SDK)가 끌어오는 8.x를 시험에서만 쓴다(런타임 의존성 아님).
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js').default;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaCheck = ajv.compile(buildSchema());
// JSON Schema로 못 적는 거부(바이트 상한). 이 예제들은 v1.mjs만 거부한다.
const JS_ONLY = new Set(['too_large--result-over-128kb.json', 'invalid_envelope--context-over-16kb.json']);

test('type은 10종이고 방향은 서버 3·본체 7(등록 포함), progress만 wk 방송', () => {
  assert.equal(TYPES.length, 10);
  assert.deepEqual(TYPES.filter((t) => DIRECTION[t] === 'server').sort(), ['work.approval_decision', 'work.cancel', 'work.offer']);
  assert.equal(TYPES.filter((t) => DIRECTION[t] === 'runner').length, 7);
  assert.equal(CHANNEL['work.progress'], 'broadcast:wk');
  assert.equal(CHANNEL['work.offer'], 'broadcast:w');
  assert.equal(CHANNEL['work.result'], 'rpc');
  assert.deepEqual(Object.keys(DATA).sort(), [...TYPES].sort());
});

test('정상 예제는 type마다 하나 이상 있고 v1.mjs와 JSON Schema가 모두 통과시킨다', () => {
  const seen = new Set(valid.map(({ env }) => env.type));
  for (const t of TYPES) assert.ok(seen.has(t), `예제 없음: ${t}`);
  for (const { f, env } of valid) {
    const r = validateEnvelope(env);
    assert.ok(r.ok, `${f}: ${r.code} ${r.errors}`);
    assert.ok(validateEnvelope(env, { from: DIRECTION[env.type] }).ok, `${f}: 방향`);
    assert.ok(schemaCheck(env), `${f}: schema ${JSON.stringify(schemaCheck.errors)}`);
  }
});

test('거부 예제는 파일 이름의 코드로 거부되고, JSON Schema도 거부한다(바이트 상한만 예외)', () => {
  assert.ok(invalid.length >= 10);
  for (const { f, env } of invalid) {
    const want = f.split('--')[0];
    assert.ok(Object.hasOwn(REJECT_CODES, want), `${f}: 모르는 기대 코드`);
    const r = validateEnvelope(env);
    assert.equal(r.ok, false, f);
    assert.equal(r.code, want, `${f}: ${r.errors}`);
    assert.equal(r.retry, false, f);
    if (JS_ONLY.has(f)) assert.ok(schemaCheck(env), `${f}: JS 전용 예외인데 schema가 거부함 — JS_ONLY 목록을 고칠 것`);
    else assert.equal(schemaCheck(env), false, `${f}: schema가 통과시킴`);
  }
});

test('커밋된 schema/envelope.v1.schema.json = v1.mjs에서 지금 만든 결과(어긋나면 schema.mjs --write)', () => {
  const file = JSON.parse(readFileSync(here('schema/envelope.v1.schema.json'), 'utf8'));
  assert.deepEqual(file, buildSchema());
});

test('모르는 필드는 무시한다 — 모든 객체에 낯선 필드를 넣어도 두 검사기 모두 통과', () => {
  const sprinkle = (x) => {
    if (Array.isArray(x)) return x.map(sprinkle);
    if (x && typeof x === 'object') {
      const o = Object.fromEntries(Object.entries(x).map(([k, v]) => [k, sprinkle(v)]));
      o.zz_future = { nested: [1, 'two', null] };
      return o;
    }
    return x;
  };
  for (const { f, env } of valid) {
    const e = sprinkle(env);
    assert.ok(validateEnvelope(e).ok, f);
    assert.ok(schemaCheck(e), `${f}: ${JSON.stringify(schemaCheck.errors)}`);
  }
});

test('필수 필드를 하나씩 빼면 invalid_envelope(봉투 필드·data 1단계 필드 전부)', () => {
  const envKeys = ['id', 'work', 'seq', 'agent', 'device', 'at', 'data'];
  let n = 0;
  for (const { f, env } of valid) {
    for (const k of envKeys) {
      const e = clone(env); delete e[k];
      const r = validateEnvelope(e);
      assert.equal(r.code, 'invalid_envelope', `${f} -${k}`); n++;
      assert.equal(schemaCheck(e), false, `${f} -${k} schema`);
    }
    for (const [k, rule] of Object.entries(DATA[env.type])) {
      if (Array.isArray(rule) && rule[1]?.optional) continue;
      const e = clone(env); delete e.data[k];
      assert.equal(validateEnvelope(e).code, 'invalid_envelope', `${f} -data.${k}`); n++;
      assert.equal(schemaCheck(e), false, `${f} -data.${k} schema`);
    }
  }
  assert.ok(n > 100, `검사 수 ${n}`);
});

test('모르는 type → unsupported_type, 본체 답은 work.error{unsupported}(올바른 봉투), 일이 없으면 답 없음', () => {
  const env = { ...clone(valid.find((x) => x.env.type === 'work.cancel').env), type: 'work.summarize', data: { anything: 1 } };
  const r = validateEnvelope(env);
  assert.equal(r.code, 'unsupported_type');
  assert.equal(r.retry, false);
  const reply = unsupportedReply(env, { id: '9a9a9a9a-0000-4000-8000-000000000001', seq: 7, device: 'c4d5e6f7-8091-4a2b-9c3d-4e5f6a7b8c03' });
  assert.equal(reply.type, 'work.error');
  assert.equal(reply.data.code, 'unsupported');
  assert.equal(reply.work, env.work);
  assert.ok(validateEnvelope(reply, { from: 'runner' }).ok);
  assert.equal(unsupportedReply({ ...env, work: null }, { id: reply.id, seq: 1, device: reply.device }), null);
});

test('버전: 범위 밖 v는 link_version_unsupported(type 판정보다 먼저), 받는 쪽 범위를 넓히면 통과', () => {
  const e = { ...clone(valid.find((x) => x.env.type === 'work.accept').env), v: 2 };
  assert.equal(validateEnvelope(e).code, 'link_version_unsupported');
  assert.equal(validateEnvelope({ ...e, type: 'work.v2only' }).code, 'link_version_unsupported');
  assert.ok(validateEnvelope(e, { supported: { min: 1, max: 2 } }).ok);
  assert.equal(validateEnvelope({ ...e, v: 0 }).code, 'invalid_envelope');
  assert.equal(validateEnvelope({ ...e, v: '1' }).code, 'invalid_envelope');
  assert.equal(LINK_V, 1);
  assert.deepEqual(SUPPORTED, { min: 1, max: 1 });
  assert.equal(negotiate({ min: 1, max: 1 }, { min: 1, max: 2 }), 1); // 경우 표 2: 본체 v1, 서버 max 2 → v1
  assert.equal(negotiate({ min: 1, max: 3 }, { min: 2, max: 2 }), 2);
  assert.equal(negotiate({ min: 1, max: 1 }, { min: 2, max: 3 }), null); // 경우 표 3: 범위 밖
});

test('방향: 본체가 서버 전용 type을 보내면 wrong_direction', () => {
  const offer = valid.find((x) => x.env.type === 'work.offer').env;
  assert.equal(validateEnvelope(offer, { from: 'runner' }).code, 'wrong_direction');
  const accept = valid.find((x) => x.env.type === 'work.accept').env;
  assert.equal(validateEnvelope(accept, { from: 'server' }).code, 'wrong_direction');
});

test('봉투 모양: 객체가 아니거나 시각·uuid가 틀리면 invalid_envelope', () => {
  for (const bad of [null, [], 'x', 1]) assert.equal(validateEnvelope(bad).code, 'invalid_envelope');
  const base = valid.find((x) => x.env.type === 'work.accept').env;
  assert.equal(validateEnvelope({ ...base, at: '2026-13-45T99:00:00Z' }).code, 'invalid_envelope');
  assert.equal(validateEnvelope({ ...base, at: '2026-10-17 06:00:00' }).code, 'invalid_envelope');
  assert.ok(validateEnvelope({ ...base, at: '2026-10-17T15:00:00.123456+09:00' }).ok); // Postgres timestamptz 출력
  assert.equal(validateEnvelope({ ...base, seq: -1 }).code, 'invalid_envelope');
  assert.equal(validateEnvelope({ ...base, seq: 1.5 }).code, 'invalid_envelope');
  assert.equal(validateEnvelope({ ...base, type: 7 }).code, 'invalid_envelope');
});

test('거부 코드: 다시 보낼 것은 rate_limited·internal뿐', () => {
  assert.deepEqual(Object.entries(REJECT_CODES).filter(([, v]) => v.retry).map(([k]) => k).sort(), ['internal', 'rate_limited']);
  assert.equal(normalizeWorkErrorCode('login'), 'login');
  assert.equal(normalizeWorkErrorCode('quota_v2'), 'internal'); // 열린 값: 모르는 코드는 internal로 읽는다
  assert.equal(WORK_ERROR_CODES.length, 9);
});

test('상태 전이: 승인 없는 일·승인 있는 일·취소·끝난 일', () => {
  const holder = { sameDevice: true, leaseGen: 1 };
  const run = (from, steps) => steps.reduce((s, [type, data, opts]) => {
    const r = nextState(s, type, data, opts);
    assert.ok(r.ok, `${s} --${type}--> ${r.code}`);
    return r.to;
  }, from);
  assert.equal(run('offered', [['work.accept'], ['work.effect', { state: 'intent' }], ['work.effect', { state: 'done' }], ['work.result']]), 'done');
  assert.equal(run('offered', [['work.accept'], ['work.approval_request'], ['work.accept', { lease_gen: 1 }, holder] /* 리스 연장 */, ['work.approval_decision', { decision: 'approve' }],
    ['work.effect', { state: 'intent' }], ['work.result']]), 'done');
  assert.equal(run('offered', [['work.accept'], ['work.error', { code: 'login' }]]), 'failed');
  for (const s of ['offered', 'accepted', 'running', 'awaiting_approval', 'stalled']) assert.equal(nextState(s, 'work.cancel').to, 'cancelled', s);
  // 끝난 일: 새 행동은 work_closed, 취소는 그대로, 이미 시작한 효과의 결과(done·failed)는 기록한다
  for (const s of TERMINAL) {
    assert.equal(nextState(s, 'work.result').code, 'work_closed', s);
    assert.equal(nextState(s, 'work.accept').code, 'work_closed', s);
    assert.equal(nextState(s, 'work.effect', { state: 'intent' }).code, 'work_closed', s);
    assert.equal(nextState(s, 'work.cancel').to, s, s);
  }
  for (const s of ['done', 'failed', 'cancelled']) assert.equal(nextState(s, 'work.effect', { state: 'done' }).to, s);
});

test('상태 전이: 막는 칸 — 승인 대기 중 결과·새 intent, offer 상태의 error(unsupported만 기록)', () => {
  assert.equal(nextState('awaiting_approval', 'work.result').code, 'invalid_transition');
  assert.equal(nextState('awaiting_approval', 'work.effect', { state: 'intent' }).code, 'invalid_transition');
  assert.equal(nextState('awaiting_approval', 'work.effect', { state: 'failed' }).to, 'awaiting_approval');
  assert.equal(nextState('offered', 'work.result').code, 'invalid_transition');
  assert.equal(nextState('offered', 'work.error', { code: 'login' }).code, 'invalid_transition');
  assert.equal(nextState('offered', 'work.error', { code: 'unsupported' }).to, 'offered');
  assert.equal(nextState('accepted', 'work.approval_decision').code, 'invalid_transition');
  assert.equal(nextState('stalled', 'work.effect', { state: 'intent' }, { sameDevice: true }).code, 'invalid_transition');
  assert.equal(nextState('stalled', 'work.approval_request', {}, { sameDevice: true }).code, 'invalid_transition');
  assert.equal(nextState('nope', 'work.accept').code, 'invalid_transition');
  // 표의 모든 상태가 STATES 또는 계산 상태다
  for (const s of Object.keys(TRANSITIONS)) assert.ok(STATES.includes(s) || s === 'expired', s);
});

test('읽을 때 계산하는 상태: expired·stalled', () => {
  const now = Date.parse('2026-10-17T06:40:00Z');
  assert.equal(effectiveState({ state: 'offered', expires_at: '2026-10-17T06:30:00Z' }, now), 'expired');
  assert.equal(effectiveState({ state: 'offered', expires_at: '2026-10-17T07:00:00Z' }, now), 'offered');
  assert.equal(effectiveState({ state: 'running', lease_until: '2026-10-17T06:35:00Z', has_result: false }, now), 'stalled');
  assert.equal(effectiveState({ state: 'awaiting_approval', lease_until: null, has_result: false }, now), 'stalled');
  assert.equal(effectiveState({ state: 'running', lease_until: '2026-10-17T06:45:00Z', has_result: false }, now), 'running');
  assert.equal(effectiveState({ state: 'done', lease_until: null, has_result: true }, now), 'done');
  // 결과는 이미 받았는데 상태 갱신 전에 리스가 끝난 칸 — 결과가 있으면 stalled("결과 모름")로 보이지 않는다
  assert.equal(effectiveState({ state: 'running', lease_until: '2026-10-17T06:35:00Z', has_result: true }, now), 'running');
});

test('등급: guest는 승인 요청·효과·파일 결과를 못 보낸다(D12)', () => {
  assert.equal(tierAllows('guest', 'work.approval_request'), false);
  assert.equal(tierAllows('guest', 'work.effect', { state: 'intent' }), false);
  assert.equal(tierAllows('guest', 'work.result', { files: ['x'] }), false);
  assert.equal(tierAllows('guest', 'work.result', { files: [] }), true);
  assert.equal(tierAllows('team', 'work.effect'), true);
  assert.equal(tierAllows('owner', 'work.approval_request'), true);
});

test('stalled(결과 모름): 같은 기기의 늦은 result·error는 받아 끝내고 표시를 붙이고, 다른 기기는 거부한다(총괄 결정 2026-10-17)', () => {
  const same = { sameDevice: true }, other = { sameDevice: false };
  assert.deepEqual(nextState('stalled', 'work.result', {}, same), { ok: true, to: 'done', mark: LATE_MARK });
  assert.deepEqual(nextState('stalled', 'work.error', { code: 'timeout' }, same), { ok: true, to: 'failed', mark: LATE_MARK });
  // accept는 이어 하기만: 같은 기기 + 직전 리스 세대. 재시작한 본체(세대 모름)·옛 세대·다른 기기는 거부(검수 2 2026-10-17)
  assert.equal(nextState('stalled', 'work.accept', { lease_gen: 4 }, { sameDevice: true, leaseGen: 4 }).to, 'running');
  assert.equal(nextState('stalled', 'work.accept', {}, { sameDevice: true, leaseGen: 4 }).code, 'not_lease_holder');
  assert.equal(nextState('stalled', 'work.accept', { lease_gen: 3 }, { sameDevice: true, leaseGen: 4 }).code, 'not_lease_holder');
  assert.equal(nextState('stalled', 'work.accept', { lease_gen: 4 }, { sameDevice: false, leaseGen: 4 }).code, 'not_lease_holder');
  assert.equal(nextState('stalled', 'work.accept', { lease_gen: 4 }, { sameDevice: true }).code, 'not_lease_holder');
  assert.equal(nextState('stalled', 'work.effect', { state: 'done' }, same).to, 'stalled');
  for (const [type, data] of [['work.result', {}], ['work.error', { code: 'timeout' }], ['work.accept', {}], ['work.effect', { state: 'done' }]]) {
    assert.equal(nextState('stalled', type, data, other).code, 'not_lease_holder', type);
    assert.equal(nextState('stalled', type, data).code, 'not_lease_holder', `${type}: 기기를 모르면 거부`);
  }
  assert.equal(nextState('stalled', 'work.cancel', {}, other).to, 'cancelled'); // 사람의 취소는 기기와 무관
  // 리스가 살아 있는 보통 상태의 result에는 표시가 없다
  assert.equal(nextState('running', 'work.result').mark, undefined);
  // 늦은 결과로 끝난 일은 다시 끝난 일 규칙을 따른다
  assert.equal(nextState('done', 'work.result', {}, same).code, 'work_closed');
});

test('일하는 중의 accept(리스 연장)는 같은 기기 + 현재 세대만 — 재시작한 본체·다른 기기는 lease_held(검수 2 2026-10-17)', () => {
  for (const st of ['accepted', 'running', 'awaiting_approval']) {
    assert.equal(nextState(st, 'work.accept', { lease_gen: 2 }, { sameDevice: true, leaseGen: 2 }).to, st, `${st} 연장`);
    assert.equal(nextState(st, 'work.accept', {}, { sameDevice: true, leaseGen: 2 }).code, 'lease_held', `${st} 재시작(세대 없음)`);
    assert.equal(nextState(st, 'work.accept', { lease_gen: 1 }, { sameDevice: true, leaseGen: 2 }).code, 'lease_held', `${st} 옛 세대`);
    assert.equal(nextState(st, 'work.accept', { lease_gen: 2 }, { sameDevice: false, leaseGen: 2 }).code, 'lease_held', `${st} 다른 기기`);
  }
  assert.equal(nextState('offered', 'work.accept').to, 'accepted'); // 처음 accept에는 세대가 없다
});

// 글·첨부 id = JSON 안전 정수(서버 msgr2_messages.id·msgr2_attachments.id는 옛 글 id 보존이라 bigint, 2026-10-17 총괄 승인 — v1 안에서 uuid → 정수)
test('offer의 글·첨부 id는 1 이상 안전 정수 — uuid 문자열·0·2^53·소수는 invalid_envelope, JSON Schema도 같다', () => {
  const base = valid.find((x) => x.f === 'work_offer.json').env;
  assert.equal(validateEnvelope(base, { from: 'server' }).ok, true, '예제는 정수 id');
  const bad = [];
  for (const [path, v] of [['context', '55555555-6666-4777-8888-999999999908'], ['context', 0], ['context', 2 ** 53], ['context', 1.5],
    ['attachments', '77777777-8888-4999-8aaa-bbbbbbbbbb10'], ['attachments', -1]]) {
    const e = clone(base); e.data[path][0].id = v;
    const r = validateEnvelope(e, { from: 'server' });
    if (r.ok || r.code !== 'invalid_envelope') bad.push(`${path}=${v}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(bad, []);
  const e = clone(base); e.data.context[0].id = Number.MAX_SAFE_INTEGER;
  assert.equal(validateEnvelope(e, { from: 'server' }).ok, true, '2^53-1은 받는다');
  const s = JSON.stringify(buildSchema());
  assert.match(s, /"maximum":9007199254740991/, 'JSON Schema에도 안전 정수 상한');
});

// 다른 정수 필드(seq·lease_gen·토큰 수)도 안전 정수 — 서버 SQL이 같은 상한으로 본다(test/msgr2-work-contract-pg가 대조)
test('정수 필드는 안전 정수만 — seq 2^53은 invalid_envelope, 2^53-1은 받는다', () => {
  const base = valid.find((x) => x.env.type === 'work.accept').env;
  assert.equal(validateEnvelope({ ...clone(base), seq: 2 ** 53 }, { from: 'runner' }).code, 'invalid_envelope');
  assert.equal(validateEnvelope({ ...clone(base), seq: Number.MAX_SAFE_INTEGER }, { from: 'runner' }).ok, true);
  assert.equal(validateEnvelope({ ...clone(base), data: { lease_gen: 2 ** 53 } }, { from: 'runner' }).code, 'invalid_envelope');
});

// offer.peers[] — 넘김할 수 있는 동료(선택 필드, 총괄 지시 2026-10-17). 없으면 통과, 있으면 모양을 본다.
test('offer.peers는 선택 — 없어도 되고, 있으면 {agent uuid, name 1자 이상, role}이며 50개까지', () => {
  const base = valid.find((x) => x.f === 'work_offer.json').env;
  assert.equal(validateEnvelope(base, { from: 'server' }).ok, true);
  const none = clone(base); delete none.data.peers; assert.equal(validateEnvelope(none, { from: 'server' }).ok, true, '옛 서버(peers 없음)');
  for (const peers of [[{ agent: 'x', name: 'n', role: '' }], [{ agent: base.agent, name: '', role: '' }], [{ agent: base.agent, name: 'n' }], 'no',
    Array.from({ length: 51 }, () => ({ agent: base.agent, name: 'n', role: '' }))]) {
    const e = clone(base); e.data.peers = peers;
    assert.equal(validateEnvelope(e, { from: 'server' }).code, 'invalid_envelope', JSON.stringify(peers).slice(0, 60));
  }
  const offerData = buildSchema().allOf.find((x) => x.if?.properties?.type?.const === 'work.offer')?.then.properties.data;
  assert.ok(offerData?.properties.peers, 'JSON Schema에 peers'); assert.ok(!offerData.required.includes('peers'), 'peers는 선택');
});

// offer.attachments는 서명 URL이 아니라 Storage 위치(bucket·path) — 2026-10-17 총괄 결정(U2b)
test('offer.attachments는 {id, name, mime, bytes, bucket, path} — 옛 url 모양(bucket·path 없음)은 invalid_envelope', () => {
  const base = valid.find((x) => x.f === 'work_offer.json').env;
  assert.equal(validateEnvelope(base, { from: 'server' }).ok, true);
  const a = base.data.attachments[0];
  for (const bad of [{ ...a, bucket: undefined }, { ...a, path: '' }, (() => { const { bucket, path, ...rest } = a; return { ...rest, url: 'https://x', url_expires_at: '2026-10-17T06:00:00Z' }; })()]) {
    const e = clone(base); e.data.attachments = [bad];
    assert.equal(validateEnvelope(e, { from: 'server' }).code, 'invalid_envelope', JSON.stringify(bad));
  }
});

// 토픽 이름은 v2: 접두사(옛 u:·org:·dm: 정책과 겹치지 않게 — 검수 #1076)
test('TOPICS — v2:u·v2:w·v2:s·v2:wk, 옛 토픽 모양과 겹치지 않는다', async () => {
  const { TOPICS } = await import('../v1.mjs');
  const id = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual([TOPICS.user(id), TOPICS.runner(id), TOPICS.space(id), TOPICS.work(id), TOPICS.presence(id)], [`v2:u:${id}`, `v2:w:${id}`, `v2:s:${id}`, `v2:wk:${id}`, `v2:pr:${id}`]);
  for (const t of Object.values(TOPICS)) assert.doesNotMatch(t(id), /^(u|org|dm|w|s|wk|pr):/);
});
