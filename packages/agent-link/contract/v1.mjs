// 본체↔메신저 약속 v1 — 봉투 모양·type 10종·상태 전이·오류 코드·버전 규칙의 정본(설계 2026-10-17 2절, D5).
// 본체 부품(packages/agent-link)·메신저 앱(apps/messenger/src/link)·서버 함수(msgr2_link_send) 시험이 모두 이 파일을 기준으로 맞춘다.
// 의존성 없음, Node·브라우저 공용(TextEncoder만 쓴다). 사람이 읽는 설명은 README.md, 다른 언어용 모양은 schema/envelope.v1.schema.json.
// 규칙: 같은 v 안에서는 필드·열린 값 추가만 한다. 모르는 필드는 무시하고(엄격 거부 금지), 모르는 type은 unsupported_type이다.

export const LINK_V = 1;
/** 이 판이 주고받을 수 있는 v 범위. 서버는 msgr_settings link_min_v·link_max_v로 따로 든다. */
export const SUPPORTED = Object.freeze({ min: 1, max: 1 });

export const LIMITS = Object.freeze({
  envelopeBytes: 131072, // 봉투 JSON 전체(UTF-8)
  contextBytes: 16384, // offer.context[] JSON(서버가 만든 최근 글)
  offerText: 20000,
  resultText: 20000,
  handoffText: 4000,
  handoffs: 8,
  files: 20,
  attachments: 20,
  contextItems: 200,
  agents: 500,
  note: 200,
  summary: 2000,
  action: 200,
  effectKey: 200,
  code: 64,
  name: 200,
  peers: 50, // offer.peers[] — 넘김할 수 있는 동료 에이전트
  role: 2000,
});

/** type → 보내는 쪽. server = 서버→본체(w:<uid> 방송·따라잡기), runner = 본체→서버. */
export const DIRECTION = Object.freeze({
  'work.offer': 'server',
  'work.cancel': 'server',
  'work.approval_decision': 'server',
  'work.accept': 'runner',
  'work.progress': 'runner',
  'work.approval_request': 'runner',
  'work.effect': 'runner',
  'work.result': 'runner',
  'work.error': 'runner',
  'agent.sync': 'runner',
});
export const TYPES = Object.freeze(Object.keys(DIRECTION));

/** type → 길. progress만 저장하지 않는 wk:<work> 방송이고, 본체가 보내는 나머지는 RPC msgr2_link_send 한 곳이다. */
export const CHANNEL = Object.freeze(Object.fromEntries(TYPES.map((t) => [t,
  t === 'work.progress' ? 'broadcast:wk' : DIRECTION[t] === 'server' ? 'broadcast:w' : 'rpc'])));

export const TIERS = Object.freeze(['owner', 'team', 'guest']);
export const STAGES = Object.freeze(['thinking', 'tool', 'writing']);
export const DECISIONS = Object.freeze(['approve', 'reject', 'expire']);
export const EFFECT_STATES = Object.freeze(['intent', 'done', 'failed']);
export const RISKS = Object.freeze(['low', 'medium', 'high']);
export const ACTOR_KINDS = Object.freeze(['user', 'agent', 'system']);

/** work.error data.code — 열린 값. 받는 쪽은 모르는 코드를 internal로 읽는다(normalizeWorkErrorCode). */
export const WORK_ERROR_CODES = Object.freeze([
  'limit', 'no_runner', 'login', 'timeout', 'cancelled', 'unsupported', 'tier_denied', 'budget', 'internal',
]);

/**
 * 서버가 msgr2_link_send(또는 등록·업로드 보조 호출)에서 봉투를 거부할 때의 코드.
 * retry=true만 본체가 간격·상한을 두고 같은 봉투(같은 id·seq)를 다시 보낸다. 나머지는 다시 보내지 않는다.
 */
export const REJECT_CODES = Object.freeze({
  invalid_envelope: { retry: false }, // 모양이 계약과 다르다
  too_large: { retry: false },
  unsupported_type: { retry: false }, // 모르는 type(버전 규칙 1)
  wrong_direction: { retry: false }, // 본체가 서버 전용 type을 보냄
  link_version_unsupported: { retry: false }, // v가 서버 범위 밖(버전 규칙 2) → 본체는 업데이트 안내
  device_unknown: { retry: false },
  device_revoked: { retry: false },
  device_expired: { retry: false },
  service_paused: { retry: false }, // v2 중단 스위치
  work_not_found: { retry: false },
  work_closed: { retry: false }, // 끝난(또는 만료된) 일에 새 봉투
  invalid_transition: { retry: false },
  lease_held: { retry: false }, // 다른 기기가 리스를 쥐고 있어 accept 실패
  not_lease_holder: { retry: false }, // 리스 주인이 아닌 기기의 accept 외 봉투, stalled 일에 다른 기기가 보낸 봉투
  seq_conflict: { retry: false }, // 같은 (work, 보낸 쪽, seq)에 다른 봉투
  effect_exists: { retry: false }, // 이미 있는 effect_key로 intent(다시 실행 금지)
  effect_unknown: { retry: false }, // intent 없이 done·failed
  tier_denied: { retry: false }, // guest 등급 밖 행동
  upload_slot_invalid: { retry: false },
  rate_limited: { retry: true },
  internal: { retry: true },
});

export const STATES = Object.freeze(['offered', 'accepted', 'running', 'awaiting_approval', 'done', 'failed', 'cancelled']);
/** 저장하지 않고 읽을 때 계산하는 상태(크론 없음, D7). */
export const DERIVED_STATES = Object.freeze(['expired', 'stalled']);
export const TERMINAL = Object.freeze(['done', 'failed', 'cancelled', 'expired']);
const LIVE = ['accepted', 'running', 'awaiting_approval'];

/**
 * 상태 전이표. [지금 상태][type] → 다음 상태. 'same' = 상태는 그대로 두고 사건만 기록(리스 연장·효과 기록 등).
 * 표에 없는 칸은 invalid_transition(끝난 상태면 work_closed). 세부 조건은 nextState가 본다.
 */
export const TRANSITIONS = Object.freeze({
  offered: { 'work.accept': 'accepted', 'work.cancel': 'cancelled', 'work.error': 'same' /* unsupported만 */ },
  accepted: {
    'work.accept': 'same', 'work.approval_request': 'awaiting_approval', 'work.effect': 'same',
    'work.result': 'done', 'work.error': 'failed', 'work.cancel': 'cancelled',
  },
  running: {
    'work.accept': 'same', 'work.approval_request': 'awaiting_approval', 'work.effect': 'same',
    'work.result': 'done', 'work.error': 'failed', 'work.cancel': 'cancelled',
  },
  awaiting_approval: {
    'work.accept': 'same', 'work.approval_decision': 'running', 'work.effect': 'same' /* done·failed만 */,
    'work.error': 'failed', 'work.cancel': 'cancelled',
  },
  done: { 'work.effect': 'same' /* done·failed만 */, 'work.cancel': 'same' },
  failed: { 'work.effect': 'same', 'work.cancel': 'same' },
  cancelled: { 'work.effect': 'same', 'work.cancel': 'same', 'work.error': 'same' },
  expired: { 'work.cancel': 'same' },
});

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const CODE = /^[a-z][a-z0-9_]*$/;
const enc = new TextEncoder();
export const jsonBytes = (x) => enc.encode(JSON.stringify(x)).length;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isUuid = (x) => typeof x === 'string' && UUID.test(x);
const isTs = (x) => typeof x === 'string' && TS.test(x) && Number.isFinite(Date.parse(x));
// 정수는 JSON 숫자로 정확히 오가는 안전 정수(≤ 2^53-1)만 — 서버(SQL)가 같은 상한으로 본다(seq·토큰 수 등).
const isInt = (x, min = 0) => Number.isSafeInteger(x) && x >= min;
const isStr = (x, max, min = 0) => typeof x === 'string' && x.length >= min && x.length <= max;

// 작은 검사기 — 필드 표를 보고 어긋난 경로를 errors에 모은다. 표에 없는 필드는 보지 않는다(모르는 필드 무시).
function check(errors, path, val, rule) {
  const [kind, opt = {}] = Array.isArray(rule) ? rule : [rule];
  if (val === undefined) { if (!opt.optional) errors.push(`${path}: required`); return; }
  if (val === null) { if (!opt.nullable) errors.push(`${path}: null`); return; }
  const bad = (why) => errors.push(`${path}: ${why}`);
  switch (kind) {
    case 'uuid': if (!isUuid(val)) bad('uuid'); break;
    case 'ts': if (!isTs(val)) bad('timestamp'); break;
    case 'int': if (!isInt(val, opt.min ?? 0)) bad('integer'); break;
    // 글·첨부 id(msgr2_messages.id·msgr2_attachments.id — 옛 글 id 보존이라 bigint). JSON 숫자로 정확히 오가는 안전 정수(≤ 2^53-1)만 받는다
    case 'msgid': if (!Number.isSafeInteger(val) || val < 1) bad('message id(safe integer >= 1)'); break;
    case 'num': if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) bad('number'); break;
    case 'bool': if (typeof val !== 'boolean') bad('boolean'); break;
    case 'str': if (!isStr(val, opt.max ?? LIMITS.name, opt.min ?? 0)) bad(`string(${opt.min ?? 0}..${opt.max ?? LIMITS.name})`); break;
    case 'code': if (!isStr(val, LIMITS.code, 1) || !CODE.test(val)) bad('code'); break;
    case 'enum': if (!opt.of.includes(val)) bad(`one of ${opt.of.join('|')}`); break;
    case 'obj':
      if (!isObj(val)) { bad('object'); break; }
      for (const [k, r] of Object.entries(opt.fields || {})) check(errors, `${path}.${k}`, val[k], r);
      break;
    case 'arr':
      if (!Array.isArray(val)) { bad('array'); break; }
      if (opt.max != null && val.length > opt.max) bad(`at most ${opt.max} items`);
      val.forEach((v, i) => check(errors, `${path}[${i}]`, v, opt.items));
      break;
    default: bad(`unknown rule ${kind}`);
  }
}

const actor = (kinds = ACTOR_KINDS) => ['obj', { fields: {
  kind: ['enum', { of: kinds }], id: ['uuid', { nullable: true }], name: ['str', { optional: true }],
} }];

/** type별 data 모양. 필드 추가는 같은 v 안에서 허용(받는 쪽은 모르는 필드를 무시한다). */
export const DATA = Object.freeze({
  'work.offer': {
    room: 'uuid',
    topic: 'uuid',
    from: actor(['user', 'agent']),
    text: ['str', { max: LIMITS.offerText }],
    context: ['arr', { max: LIMITS.contextItems, items: ['obj', { fields: {
      id: 'msgid', author: actor(), text: ['str', { max: LIMITS.offerText }], at: 'ts',
    } }] }],
    attachments: ['arr', { max: LIMITS.attachments, items: ['obj', { fields: {
      // 서명 URL 대신 Storage 위치(2026-10-17 총괄 결정, 출시 전이라 v1 안에서 의미 변경). 본체는 자기 runner 세션으로 Storage API를 불러 받는다
      // (버킷 정책: 그 방에 진행 중인 일의 리스를 쥔 runner 기기만). path는 버킷 안 경로(<공간>/<방>/…).
      id: 'msgid', name: ['str', { min: 1 }], mime: ['str', { max: 200 }], bytes: 'int', bucket: ['str', { min: 1, max: 64 }], path: ['str', { min: 1, max: 1024 }],
    } }] }],
    memory: 'bool',
    limits: ['obj', { fields: {
      tier: ['enum', { of: TIERS }],
      max_turn_s: ['int', { min: 1 }],
      budget: ['obj', { nullable: true, fields: { max_tokens: ['int', { optional: true, min: 1 }], max_usd: ['num', { optional: true }] } }],
    } }],
    expires_at: 'ts',
    // 이 방에서 이 에이전트가 넘김(result.handoffs[])할 수 있는 동료 에이전트. 서버가 등급·파견 허용으로 거른다(guest는 빈 배열).
    // 서버는 넘김을 받을 때 같은 규칙으로 다시 본다 — 목록 밖 에이전트로의 넘김은 새 일이 되지 않는다.
    peers: ['arr', { optional: true, max: LIMITS.peers, items: ['obj', { fields: {
      agent: 'uuid', name: ['str', { min: 1 }], role: ['str', { max: LIMITS.role }],
    } }] }],
  },
  'work.cancel': { by: actor(), reason: 'code' },
  'work.approval_decision': { approval_id: 'uuid', decision: ['enum', { of: DECISIONS }], by: actor(['user', 'system']) },
  // lease_gen: 서버가 accept 성공 답으로 준 리스 세대. 처음 accept에는 없고, 연장·이어 하기 accept에 그 값을 싣는다(실행 중 메모리에만 둔다).
  'work.accept': { lease_gen: ['int', { optional: true, min: 1 }] },
  'work.progress': { stage: ['enum', { of: STAGES }], note: ['str', { optional: true, max: LIMITS.note }] },
  'work.approval_request': {
    approval_id: 'uuid', action: ['str', { min: 1, max: LIMITS.action }], risk: ['enum', { of: RISKS }],
    summary: ['str', { min: 1, max: LIMITS.summary }], effect_key: ['str', { nullable: true, min: 1, max: LIMITS.effectKey }], expires_at: 'ts',
  },
  'work.effect': {
    effect_key: ['str', { min: 1, max: LIMITS.effectKey }], state: ['enum', { of: EFFECT_STATES }], kind: ['code', { optional: true }],
  },
  'work.result': {
    text: ['str', { max: LIMITS.resultText }],
    files: ['arr', { max: LIMITS.files, items: 'uuid' }],
    handoffs: ['arr', { max: LIMITS.handoffs, items: ['obj', { fields: { agent: 'uuid', text: ['str', { min: 1, max: LIMITS.handoffText }] } }] }],
    usage: ['obj', { nullable: true, optional: true, fields: {
      input_tokens: ['int', { optional: true }], output_tokens: ['int', { optional: true }], cost_usd: ['num', { optional: true }],
      runner: ['str', { optional: true, max: 64 }], model: ['str', { optional: true, max: 200 }],
    } }],
  },
  'work.error': { code: 'code', runner: ['str', { nullable: true, max: 64 }], retry_at: ['ts', { optional: true, nullable: true }] },
  'agent.sync': {
    agents: ['arr', { max: LIMITS.agents, items: ['obj', { fields: {
      ws: ['str', { min: 1 }], slug: ['str', { min: 1 }], name: ['str', { min: 1 }], role: ['str', { max: 2000 }], face_hash: ['str', { nullable: true, max: 128 }],
    } }] }],
  },
});

const fail = (code, errors = []) => ({ ok: false, code, retry: REJECT_CODES[code]?.retry ?? false, errors });

/**
 * 봉투 검사. 판정 순서: 모양(객체) → v 범위 → type → 크기 → 방향 → 봉투 필드 → data.
 * 반환: { ok:true } | { ok:false, code(REJECT_CODES 키), retry, errors[] }.
 * opts.from = 'server'|'runner'면 그 쪽이 보낼 수 있는 type인지도 본다. opts.supported로 받는 쪽 v 범위를 바꾼다.
 */
export function validateEnvelope(env, { from, supported = SUPPORTED } = {}) {
  if (!isObj(env)) return fail('invalid_envelope', ['envelope: object']);
  if (!isInt(env.v, 1)) return fail('invalid_envelope', ['v: integer >= 1']);
  if (env.v < supported.min || env.v > supported.max) return fail('link_version_unsupported', [`v: ${env.v} not in ${supported.min}..${supported.max}`]);
  if (typeof env.type !== 'string') return fail('invalid_envelope', ['type: string']);
  if (!Object.hasOwn(DIRECTION, env.type)) return fail('unsupported_type', [`type: ${env.type}`]);
  if (jsonBytes(env) > LIMITS.envelopeBytes) return fail('too_large', [`envelope: > ${LIMITS.envelopeBytes} bytes`]);
  if (from && DIRECTION[env.type] !== from) return fail('wrong_direction', [`type: ${env.type} is ${DIRECTION[env.type]}-sent`]);

  const errors = [];
  const sync = env.type === 'agent.sync';
  check(errors, 'id', env.id, 'uuid');
  check(errors, 'work', env.work, sync ? ['uuid', { nullable: true }] : 'uuid');
  if (sync && env.work !== null && env.work !== undefined) errors.push('work: must be null for agent.sync');
  check(errors, 'seq', env.seq, 'int');
  check(errors, 'agent', env.agent, sync ? ['uuid', { nullable: true }] : 'uuid');
  // device: 본체가 보낼 때는 보낸 기기, 서버가 보낼 때는 받을 기기(리스가 없으면 null = 주인의 runner 기기 아무나)
  check(errors, 'device', env.device, DIRECTION[env.type] === 'server' ? ['uuid', { nullable: true }] : 'uuid');
  check(errors, 'at', env.at, 'ts');
  check(errors, 'data', env.data, ['obj', { fields: DATA[env.type] }]);
  if (!errors.length && env.type === 'work.offer' && jsonBytes(env.data.context) > LIMITS.contextBytes) {
    errors.push(`data.context: > ${LIMITS.contextBytes} bytes`);
  }
  return errors.length ? fail('invalid_envelope', errors) : { ok: true };
}

/** 모르는 work.error 코드는 internal로 읽는다(열린 값). */
export const normalizeWorkErrorCode = (code) => (WORK_ERROR_CODES.includes(code) ? code : 'internal');

/** 버전 협상: 두 범위가 겹치는 가장 높은 v, 없으면 null(버전 규칙 3). */
export function negotiate(a, b) {
  const lo = Math.max(a.min, b.min), hi = Math.min(a.max, b.max);
  return lo <= hi ? hi : null;
}

/**
 * 읽을 때 계산하는 상태(D7). work = { state, expires_at, lease_until, has_result }.
 * offered가 expires_at을 넘기면 expired, 일하는 중인데 리스가 끝났고 결과가 없으면 stalled(자동 재실행 없음).
 */
export function effectiveState(work, now = Date.now()) {
  const t = (x) => (x ? Date.parse(x) : NaN);
  if (work.state === 'offered' && t(work.expires_at) <= now) return 'expired';
  if (LIVE.includes(work.state) && !work.has_result && !(t(work.lease_until) > now)) return 'stalled';
  return work.state;
}

/** stalled 일에 같은 기기의 늦은 result·error가 왔을 때 방 글(시스템 글 meta)에 붙이는 표시 코드. 화면이 "늦게 도착"으로 그린다(D15). */
export const LATE_MARK = 'work.late';

/**
 * 서버가 봉투 하나를 일에 적용할 때의 다음 상태. state는 effectiveState 결과를 넣는다.
 * opts.sameDevice = 봉투의 device가 이 일의 리스를 마지막으로 잡았던 기기인가, opts.leaseGen = 그 리스의 세대(stalled 판정에만 쓴다, 모르면 거부 쪽).
 * 반환: { ok:true, to, mark? } | { ok:false, code }. to === state면 사건만 기록한다. mark가 있으면 방 글에 붙인다.
 */
export function nextState(state, type, data = {}, { sameDevice = false, leaseGen = null } = {}) {
  if (state === 'stalled') {
    // 리스가 끝났고 결과가 없는 일(저장하지 않는 계산 상태). 리스를 잡았던 같은 기기만 받는다(다른 기기는 not_lease_holder).
    // accept는 "이어 하기"만 받는다: 같은 기기 + 직전 리스 세대(data.lease_gen === leaseGen). 재시작한 본체는 세대를 모르므로
    // (메모리에만 둔다) 같은 기기라도 거부된다 — 처음부터 다시 돌려 되돌릴 수 없는 일이 다른 effect_key로 두 번 나가는 것을 막는다(경우 8).
    // 같은 기기: 이어 하기 accept로 리스를 다시 잡거나, 효과 결과(done·failed)를 알리거나, 늦은 result·error로 일을 끝낸다
    // (실제로 끝난 일이 "결과 모름"으로 남지 않게, 방 글에 LATE_MARK). 새 intent는 받지 않는다. 자동 재실행은 없다 —
    // 사람이 "다시 시키기"로 만든 새 일과 별개로, 늦은 결과는 옛 일(옛 토픽)에만 붙는다.
    if (type === 'work.cancel') return { ok: true, to: 'cancelled' };
    if (!sameDevice) return { ok: false, code: 'not_lease_holder' };
    if (type === 'work.accept') {
      return leaseGen != null && data.lease_gen === leaseGen ? { ok: true, to: 'running' } : { ok: false, code: 'not_lease_holder' };
    }
    if (type === 'work.effect' && data.state !== 'intent') return { ok: true, to: state };
    if (type === 'work.result') return { ok: true, to: 'done', mark: LATE_MARK };
    if (type === 'work.error') return { ok: true, to: 'failed', mark: LATE_MARK };
    return { ok: false, code: 'invalid_transition' };
  }
  // 일하는 중의 accept = 리스 연장. 같은 기기 + 현재 리스 세대일 때만이다. 재시작한 본체(세대 모름)나 다른 기기는 lease_held —
  // 살아 있는 리스를 "연장"으로 가로채 같은 일을 처음부터 다시 돌리지 못하게 한다.
  if (type === 'work.accept' && LIVE.includes(state) && !(sameDevice && leaseGen != null && data.lease_gen === leaseGen)) {
    return { ok: false, code: 'lease_held' };
  }
  const row = TRANSITIONS[state];
  if (!row) return { ok: false, code: 'invalid_transition' };
  const to = row[type];
  if (!to) return { ok: false, code: TERMINAL.includes(state) ? 'work_closed' : 'invalid_transition' };
  if (type === 'work.error' && state === 'offered' && data.code !== 'unsupported') return { ok: false, code: 'invalid_transition' };
  if (type === 'work.effect' && data.state === 'intent' && !['accepted', 'running'].includes(state)) {
    return { ok: false, code: TERMINAL.includes(state) ? 'work_closed' : 'invalid_transition' };
  }
  return { ok: true, to: to === 'same' ? state : to };
}

/** guest 등급이 할 수 없는 봉투(D12): 승인 요청·효과·파일 첨부 결과. 서버가 tier_denied로 거부한다. */
export function tierAllows(tier, type, data = {}) {
  if (tier !== 'guest') return true;
  if (type === 'work.approval_request' || type === 'work.effect') return false;
  if (type === 'work.result' && Array.isArray(data.files) && data.files.length) return false;
  return true;
}

/** 본체가 모르는 type을 받았을 때 보내는 답(버전 규칙 1). 같은 일·같은 에이전트로 work.error{unsupported}. */
export function unsupportedReply(env, { id, seq, device, at = new Date().toISOString() }) {
  if (!isUuid(env?.work) || !isUuid(env?.agent)) return null; // 일이 없는 봉투에는 답할 곳이 없다
  return { v: LINK_V, id, work: env.work ?? null, seq, type: 'work.error', agent: env.agent, device, at,
    data: { code: 'unsupported', runner: null } };
}
