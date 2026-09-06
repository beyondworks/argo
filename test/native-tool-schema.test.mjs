// 도구 스키마 required 정규화 — xAI(Grok) Anthropic 호환 엔드포인트의 400(`/required: null is not of type "array"`) 제보(2026-09-06, v0.1.62) 대응. 실벤더 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
  for (const k of ['anyOf', 'oneOf', 'allOf']) (s[k] ?? []).forEach((x, i) => missing(x, `${path}|${k}${i}`, out));
  for (const [k, v] of Object.entries(s.$defs ?? {})) missing(v, `${path}#${k}`, out);
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
  assert.deepEqual(missing({ type: 'object', properties: { max_chars: { type: 'number' } } }), ['$'], '워커 자체가 제보 모양을 잡는다(대조군)');
});

test('S2. 내장·브라우저·컴퓨터 스펙 전량 — 정규화 전에는 제보한 4종이 required 없음, 정규화 뒤에는 0', () => {
  const all = [...BUILTIN_SPECS, ...BROWSER_SPECS, ...COMPUTER_SPECS];
  const before = all.filter((t) => missing(t.input_schema).length).map((t) => t.name);
  assert.deepEqual(before.sort(), ['browser_back', 'browser_screenshot', 'browser_snapshot', 'computer_screenshot'], '제보(browser_snapshot·browser_back·browser_screenshot)와 일치 + computer_screenshot');
  assert.deepEqual(all.filter((t) => missing(ensureRequired(t.input_schema)).length).map((t) => t.name), []);
});

test('S3. 배선 — 네이티브 턴이 벤더(가짜 Anthropic /v1/messages)로 보내는 tools 전량에 required 배열이 있다(내장·크루 도구 포함), browser_snapshot은 required: []', async () => {
  const ws = 'sch1'; await createCompany(ws, '스키마', '사장'); const root = paths(ws).root;
  const bodies = [];
  const srv = createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { bodies.push(JSON.parse(d)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', model: 'grok-4', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    let last; for await (const ev of nativeQuery({ wsId: ws, slug: 's', prompt: '안녕', cwd: root, systemPrompt: 'SYS', model: 'grok-4', saveSession: false, computer: true,
      env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'fake-grok-token' }, crewTools: [{ name: 'ping', description: 'p', shape: {}, handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }) }],
      canUseTool: makePermissionGate(ws, 's', root, null, 'ko', []) })) last = ev;
    assert.equal(last.subtype, 'success'); assert.equal(bodies.length, 1);
    const tools = bodies[0].tools; assert.ok(tools.length >= 25, `도구 ${tools.length}개`);
    assert.deepEqual(tools.filter((t) => missing(t.input_schema).length).map((t) => t.name), [], 'required 없는 object 노드를 가진 도구 0');
    assert.deepEqual(tools.find((t) => t.name === 'browser_snapshot').input_schema.required, []); assert.ok(tools.find((t) => t.name === 'mcp__crew__ping')); assert.deepEqual(tools.find((t) => t.name === 'mcp__crew__ping').input_schema.required, []);
    assert.deepEqual(tools.find((t) => t.name === 'Read').input_schema.required, ['file_path'], '기존 required는 그대로');
  } finally { await new Promise((r) => srv.close(r)); }
});
