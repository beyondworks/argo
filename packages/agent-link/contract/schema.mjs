// v1.mjs의 필드 표(DATA)를 JSON Schema(2020-12)로 옮긴다. 결과는 schema/envelope.v1.schema.json에 커밋하고,
// 계약 시험이 "파일 = 지금 생성 결과"를 확인해 두 정본이 어긋나지 않게 잠근다.
// 다시 만들기: node packages/agent-link/contract/schema.mjs --write
// JSON Schema로 못 적는 검사(봉투 128KB·context 16KB 바이트 상한, 시각의 달력 유효성, v1.1 교차 검사 — meeting·kind 짝, S×R ≤ 10, hop ≤ max_hops, posts 있을 때 text·handoffs)는 v1.mjs validateEnvelope에만 있다.
// additionalProperties는 어디에도 두지 않는다 — 모르는 필드는 무시한다(버전 규칙 1).
import { DATA, DIRECTION, TYPES, LIMITS, SUPPORTED } from './v1.mjs';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const TS = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?(Z|[+-]\\d{2}:\\d{2})$';
const CODE = '^[a-z][a-z0-9_]*$';

function rule(r) {
  const [kind, opt = {}] = Array.isArray(r) ? r : [r];
  let s;
  switch (kind) {
    case 'uuid': s = { type: 'string', pattern: UUID }; break;
    case 'ts': s = { type: 'string', pattern: TS }; break;
    case 'int': s = { type: 'integer', minimum: opt.min ?? 0, maximum: opt.max ?? Number.MAX_SAFE_INTEGER }; break;
    case 'msgid': s = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }; break;
    case 'num': s = { type: 'number', minimum: 0 }; break;
    case 'bool': s = { type: 'boolean' }; break;
    case 'str': s = { type: 'string', minLength: opt.min ?? 0, maxLength: opt.max ?? LIMITS.name }; break;
    case 'code': s = { type: 'string', minLength: 1, maxLength: LIMITS.code, pattern: CODE }; break;
    case 'enum': s = { enum: [...opt.of] }; break;
    case 'obj': s = object(opt.fields || {}); break;
    case 'arr': s = { type: 'array', items: rule(opt.items), ...(opt.max != null ? { maxItems: opt.max } : {}) }; break;
    default: throw new Error(`unknown rule ${kind}`);
  }
  if (opt.nullable) s = s.enum ? { enum: [...s.enum, null] } : { anyOf: [s, { type: 'null' }] };
  return s;
}

function object(fields) {
  const properties = {}, required = [];
  for (const [k, r] of Object.entries(fields)) {
    properties[k] = rule(r);
    const opt = Array.isArray(r) ? r[1] || {} : {};
    if (!opt.optional) required.push(k);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

export function buildSchema() {
  const base = {
    v: { type: 'integer', minimum: SUPPORTED.min, maximum: SUPPORTED.max },
    id: rule('uuid'), seq: rule('int'), at: rule('ts'), type: { enum: [...TYPES] },
  };
  const branches = TYPES.map((t) => {
    const sync = t === 'agent.sync';
    return {
      if: { properties: { type: { const: t } } },
      then: {
        properties: {
          work: sync ? { type: 'null' } : rule('uuid'),
          agent: sync ? rule(['uuid', { nullable: true }]) : rule('uuid'),
          device: DIRECTION[t] === 'server' ? rule(['uuid', { nullable: true }]) : rule('uuid'),
          data: object(DATA[t]),
        },
      },
    };
  });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://argo.local/agent-link/envelope.v1.schema.json',
    title: 'Argo agent-link envelope v1',
    description: 'Generated from packages/agent-link/contract/v1.mjs (node packages/agent-link/contract/schema.mjs --write). Unknown fields are ignored; byte limits are enforced by validateEnvelope only.',
    type: 'object',
    required: ['v', 'id', 'work', 'seq', 'type', 'agent', 'device', 'at', 'data'],
    properties: base,
    allOf: branches,
  };
}

if (globalThis.process?.argv?.includes('--write')) {
  const { writeFileSync } = await import('node:fs');
  const out = new URL('./schema/envelope.v1.schema.json', import.meta.url);
  writeFileSync(out, JSON.stringify(buildSchema(), null, 2) + '\n');
  console.log('wrote', out.pathname);
}
