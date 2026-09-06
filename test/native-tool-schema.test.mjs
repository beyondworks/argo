// 도구 스키마 required 정규화 — xAI(Grok) Anthropic 호환 엔드포인트의 400(`/required: null is not of type "array"`) 제보(2026-09-06, v0.1.62) 대응. 실벤더 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStrictVendor } from './helpers/strict-vendor.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-schema-home-'));
process.env.USERPROFILE = process.env.HOME;
process.env.ARGO_ROOT = join(await mkdtemp(join(tmpdir(), 'argo-schema-')), 'workspaces'); await mkdir(process.env.ARGO_ROOT, { recursive: true });
process.env.ARGO_MODEL_CATALOG = 'off';

const { ensureRequired, nativeQuery } = await import('../src/engine/native-query.mjs');
const { BUILTIN_SPECS } = await import('../src/engine/builtin-tools.mjs');
const { BROWSER_SPECS } = await import('../src/engine/browser-tools.mjs');
const { COMPUTER_SPECS } = await import('../src/engine/computer-tools.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { makePermissionGate } = await import('../src/permission-gate.mjs');

/** object 노드 중 required 배열이 없는 경로 목록(순수 워커) */
const missing = (s, path = '$', out = []) => {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return out;
  if ((s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object'))) && !Array.isArray(s.required)) out.push(path);
  for (const [k, v] of Object.entries(s.properties ?? {})) missing(v, `${path}.${k}`, out);
  if (s.items) (Array.isArray(s.items) ? s.items : [s.items]).forEach((x, i) => missing(x, `${path}[${i}]`, out));
  for (const k of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) (s[k] ?? []).forEach((x, i) => missing(x, `${path}|${k}${i}`, out));
  for (const k of ['$defs', 'definitions', 'patternProperties', 'dependentSchemas']) for (const [n, v] of Object.entries(s[k] ?? {})) missing(v, `${path}#${k}.${n}`, out);
  for (const k of ['additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties']) if (s[k] && typeof s[k] === 'object') missing(s[k], `${path}<${k}>`, out);
  return out;
};

test('S1. ensureRequired(순수) — 최상위·중첩(properties·items·anyOf·$defs) object 노드에 required 배열 보장, 기존 배열 유지, null/true는 배열로, 입력 비파괴·멱등, 비object 무변경', () => {
  const input = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } }, list: { type: 'array', items: { type: 'object', properties: {} } }, u: { anyOf: [{ type: 'object' }, { type: 'null' }] }, s: { type: 'string' } }, $defs: { D: { type: 'object', required: ['x'], properties: { x: { type: 'integer' } } } } };
  const snap = JSON.stringify(input);
  const out = ensureRequired(input);
  assert.deepEqual(missing(out), [], `required 없는 object 노드 없음`); assert.deepEqual(out.required, []); assert.deepEqual(out.properties.a.required, []); assert.deepEqual(out.properties.list.items.required, []); assert.deepEqual(out.properties.u.anyOf[0].required, []);
  assert.deepEqual(out.$defs.D.required, ['x'], '기존 배열 유지'); assert.equal('required' in out.properties.s, false, '비object에는 안 붙인다');
  assert.equal(JSON.stringify(input), snap, '입력 비파괴'); assert.deepEqual(ensureRequired(out), out, '멱등');
  assert.deepEqual(ensureRequired({ type: 'object', required: null }).required, []); assert.deepEqual(ensureRequired({ type: 'object', required: true }).required, [], 'Swagger 2.0 관례 required:true도 배열로');
  assert.deepEqual(ensureRequired({ type: ['object', 'null'], properties: {} }).required, []);
  assert.equal(ensureRequired(null), null); assert.equal(ensureRequired('x'), 'x');
  // 적용자 키워드 전수(검수 C1·M1): $defs·allOf·additionalProperties·prefixItems·patternProperties·if/then/else·dependentSchemas·not·contains — 각 자리의 object에 required가 붙는다
  const app = ensureRequired({ type: 'object', $defs: { A: { type: 'object' } }, allOf: [{ type: 'object' }], additionalProperties: { type: 'object' }, patternProperties: { '^x': { type: 'object' } }, dependentSchemas: { a: { type: 'object' } },
    if: { type: 'object' }, then: { type: 'object' }, else: { type: 'object' }, not: { type: 'object' }, properties: { l: { type: 'array', prefixItems: [{ type: 'object' }], contains: { type: 'object' } } } });
  assert.deepEqual(missing(app), []);
  for (const [k, v] of [['$defs', app.$defs.A], ['allOf', app.allOf[0]], ['additionalProperties', app.additionalProperties], ['patternProperties', app.patternProperties['^x']], ['dependentSchemas', app.dependentSchemas.a], ['if', app.if], ['then', app.then], ['else', app.else], ['not', app.not], ['prefixItems', app.properties.l.prefixItems[0]], ['contains', app.properties.l.contains]]) assert.deepEqual(v.required, [], `${k} 아래 object`);
  // 깊이 20 중첩(검수 M2)·순환 참조
  let deep = { type: 'object' }; for (let i = 0; i < 20; i++) deep = { type: 'object', properties: { c: deep } };
  assert.deepEqual(missing(ensureRequired(deep)), [], '깊이 20까지 정규화');
  const cyc = { type: 'object', properties: {} }; cyc.properties.self = cyc; assert.doesNotThrow(() => ensureRequired(cyc), '순환 참조에 무한 재귀 없음');
  assert.deepEqual(missing({ type: 'object', properties: { max_chars: { type: 'number' } } }), ['$'], '워커 자체가 제보 모양을 잡는다(대조군)');
});

test('S2. 내장·브라우저·컴퓨터 스펙 전량 — 정규화 전에는 제보한 4종이 required 없음, 정규화 뒤에는 0', () => {
  const all = [...BUILTIN_SPECS, ...BROWSER_SPECS, ...COMPUTER_SPECS];
  const before = all.filter((t) => missing(t.input_schema).length).map((t) => t.name);
  const known = new Set(['browser_back', 'browser_screenshot', 'browser_snapshot', 'computer_screenshot', 'use_connector']); // 제보 3종 + 감사로 찾은 2종(중첩 args 포함)
  assert.ok(before.every((n) => known.has(n)), `정의 자체의 누락은 알려진 집합 안에서만(새 도구가 required 없이 추가되면 여기서 잡는다): ${before.join(', ')}`); // 정의를 고쳐 누락이 줄어드는 방향은 허용(검수 L1)
  assert.deepEqual(all.filter((t) => missing(ensureRequired(t.input_schema)).length).map((t) => t.name), [], '정규화 뒤 0');
});

test('S3. 배선 — 네이티브 턴이 벤더로 보내는 tools 전량에 required 배열이 있다(내장·크루 도구 포함) — **엄격 xAI 가짜 벤더**(제보 규칙: required 없는 object 스키마는 400)가 턴을 받아 준다, browser_snapshot은 required: []', async () => {
  const ws = 'sch1'; await createCompany(ws, '스키마', '사장'); const root = paths(ws).root;
  const strict = await startStrictVendor({ vendor: 'xai', reply: (body) => ({ id: 'm1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) });
  const bodies = strict.calls.map((c) => c.body); const base = strict.base; const srv = { close: strict.close };
  try {
    let last; for await (const ev of nativeQuery({ wsId: ws, slug: 's', prompt: '안녕', cwd: root, systemPrompt: 'SYS', model: 'grok-4', saveSession: false, computer: true,
      env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'fake-grok-token' }, crewTools: [{ name: 'ping', description: 'p', shape: {}, handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }) }],
      canUseTool: makePermissionGate(ws, 's', root, null, 'ko', []) })) last = ev;
    assert.equal(last.subtype, 'success', `엄격 벤더가 거절하지 않는다: ${JSON.stringify(last.errors ?? null)}`); assert.equal(strict.calls.length, 1);
    bodies.push(...strict.calls.map((c) => c.body));
    assert.deepEqual(Object.keys(bodies[0]).sort(), ['max_tokens', 'messages', 'model', 'system', 'tools'], '실제 턴 본문 최상위 키 — runner-health 테스트의 TURN_BODY_KEYS(프로브 본문)와 같은 집합(2R N-HIGH-1)');
    const tools = bodies[0].tools; assert.ok(tools.length >= 25, `도구 ${tools.length}개`);
    assert.deepEqual(tools.filter((t) => missing(t.input_schema).length).map((t) => t.name), [], 'required 없는 object 노드를 가진 도구 0');
    assert.deepEqual(tools.find((t) => t.name === 'browser_snapshot').input_schema.required, []); assert.ok(tools.find((t) => t.name === 'mcp__crew__ping')); assert.deepEqual(tools.find((t) => t.name === 'mcp__crew__ping').input_schema.required, []);
    assert.deepEqual(tools.find((t) => t.name === 'Read').input_schema.required, ['file_path'], '기존 required는 그대로');
  } finally { await srv.close(); }
});
