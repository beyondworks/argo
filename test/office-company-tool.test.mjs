// 에이전트 회사 도구(office) — 트랙 C(2026-10-02): 인트라넷 에이전트 도구(company_list/add/update·employees_list·report_list/add)를 오피스로.
// DB 함수는 가짜 세션 클라이언트로 대신한다(라이브 DB 호출 0). 세션 모양 = msgr.mjs sessionClient()의 { client, uid }.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = join(await mkdtemp(join(tmpdir(), 'argo-co-tool-')), 'workspaces'); await mkdir(process.env.ARGO_ROOT, { recursive: true });
process.env.ARGO_MODEL_CATALOG = 'off';

const { makeCrewServer } = await import('../src/chat.mjs');
const { crewToolSpecs, ensureRequired } = await import('../src/engine/native-query.mjs');
const { companyTool, companyDeps, periodOf } = await import('../src/gateway/office-company.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const ME = 'owner-uid', ORG = 'org-1';
const real = { ...companyDeps };
after(() => Object.assign(companyDeps, real));
const msgrCtx = (extra = {}) => ({ kind: 'msgr', chatType: 'group', channelKind: 'public', orgId: ORG, channelId: 'ch-1', crewId: 'crew-1', uid: ME, wsId: 'w', origin: ME, ...extra });
const items = [{ id: 'i1', category: 'basic', label: '상호', value: '(주)A', key: 'name', notes: '', position: 0, redacted: false }, { id: 'i2', category: 'bank', label: '계좌', value: '국민 1', key: null, notes: '견적용', position: 0, redacted: true }];
function fake({ error = null, uid = ME } = {}) {
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (error) return { data: null, error: { message: error } };
    if (name === 'office_company_read') return { data: { role: 'manager', items, deleted: [] }, error: null };
    if (name === 'office_people_read') return { data: { role: 'manager', people: [{ id: 'p1', user_id: 'u1', name: '최민지', title: '디자이너', department: '제작', agent: 'Codex', status: 'active', account_role: 'member', notes: '연봉 메모' }, { id: 'p2', name: '이하은', status: 'left', notes: '' }] }, error: null };
    if (name === 'office_perf_eval_list') return { data: { role: 'manager', evals: [{ id: 'e1', scope: 'month', subject_name: '최민지', subject_type: 'staff', period_from: '2026-09-01', period_to: '2026-09-30', title: '월간', total: 81, performance: 80, author_name: '김유건', review: '좋음' }, { id: 'e0', replaced_by: 'e1', scope: 'month', subject_name: '최민지', title: '옛 판' }] }, error: null };
    if (name === 'office_company_write') return { data: { ok: true, item: args.p_data }, error: null };
    if (name === 'office_perf_eval_write') return { data: { ok: true, eval: { ...args.p_data, total: args.p_data.total ?? 85 } }, error: null };
    return { data: null, error: { message: 'unknown' } };
  } };
  Object.assign(companyDeps, { session: async () => ({ client, uid }), now: () => Date.parse('2026-10-02T03:00:00Z'), newId: () => 'new-id' });
  return calls;
}
const run = (args, opts = {}) => companyTool(args, { ctx: msgrCtx(), crew: 'pepper', lang: 'ko', ownerId: ME, ...opts });

test('O1. 메신저 조직 채널이 아니거나·위임 턴·주인 아닌 로그인이면 RPC 없이 한 줄로 거절', async () => {
  const calls = fake();
  assert.match(await run({ action: 'company' }, { ctx: null }), /조직 채널/);
  assert.match(await run({ action: 'company' }, { ctx: { kind: 'msgr-rules' } }), /위임 턴/);
  assert.match(await run({ action: 'company' }, { ownerId: 'someone' }), /주인의 계정이 아니라/);
  assert.match(await run({ action: 'company' }, { ctx: msgrCtx({ uid: 'other' }) }), /주인의 계정이 아니라/);
  assert.equal(calls.length, 0);
});

test('O2. company는 그 조직 회사 정보를 id와 함께, company_set은 id로 고치거나 새로 추가(서식 칸·분류 검사)', async () => {
  const calls = fake();
  const out = await run({ action: 'company' });
  assert.match(out, /상호 = \(주\)A · key=name · id=i1/); assert.equal(calls[0].args.p_org, ORG);
  const upd = await run({ action: 'company_set', id: 'i2', value: '신한 2' });
  assert.match(upd, /고쳤다/);
  const w = calls.find((c) => c.name === 'office_company_write').args.p_data;
  assert.deepEqual([w.id, w.label, w.value, w.category, w.notes, w.redacted], ['i2', '계좌', '신한 2', 'bank', '견적용', true], '안 준 칸은 기존 값 유지');
  assert.match(await run({ action: 'company_set', label: '팩스', value: '02', category: 'contact', key: 'fax' }), /추가했다.*id=new-id/);
  assert.match(await run({ action: 'company_set', label: 'x', category: 'weird' }), /category는/);
  assert.match(await run({ action: 'company_set', id: 'nope' }), /항목이 없다/);
});

test('O3. people은 메모를 싣지 않고, 기본은 재직자만', async () => {
  fake();
  const out = await run({ action: 'people' });
  assert.match(out, /최민지 · 디자이너 · 제작 · Codex · active/); assert.doesNotMatch(out, /연봉 메모/); assert.doesNotMatch(out, /이하은/);
  assert.match(await run({ action: 'people', status: 'all' }), /이하은/);
});

test('O4. evals는 지금 판만, eval_add는 정해진 기간 모양·crew 표시로 쓴다', async () => {
  const calls = fake();
  const list = await run({ action: 'evals', scope: 'month' });
  assert.match(list, /월간 · 종합 81/); assert.doesNotMatch(list, /옛 판/);
  assert.match(await run({ action: 'eval_add', scope: 'month', subject_kind: 'person' }), /subject_user/);
  const ok = await run({ action: 'eval_add', scope: 'week', period_day: '2026-09-10', subject_kind: 'person', subject_user: 'u1', title: '주간', performance: 90 });
  assert.match(ok, /2026-09-07~2026-09-13/);
  const d = calls.find((c) => c.name === 'office_perf_eval_write').args.p_data;
  assert.deepEqual([d.from, d.to, d.crew, d.subject_kind, d.performance, d.quality], ['2026-09-07', '2026-09-13', 'pepper', 'person', 90, null]);
  assert.deepEqual(periodOf('month', '2026-02-10'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(periodOf('year', '2026-02-10'), { from: '2026-01-01', to: '2026-12-31' });
});

test('O5. 서버 거절은 원인을 한 줄로(삼키지 않는다)', async () => {
  fake({ error: 'company_forbidden' });
  assert.match(await run({ action: 'company_set', label: '팩스' }), /조직 관리자만/);
  fake({ error: 'perf_period' });
  assert.match(await run({ action: 'eval_add', scope: 'year', subject_kind: 'crew', subject_name: '루나', title: 't' }), /기간 모양/);
});

const WS = 'co-wire';
await createCompany(WS, '회사도구사', 'owner', ME);
test('O6. office 도구는 메신저 조직 턴에만 보이고(네이티브 sink 포함), 손님 턴은 세션을 부르지 않으며, 벤더 스키마에 required가 있다', async () => {
  const none = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], null, 'ko', [], '', none);
  assert.ok(!none.some((d) => d.name === 'office'), '메신저 밖 턴에는 없다');
  let called = 0; Object.assign(companyDeps, { session: async () => { called++; return null; } });
  const guest = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], msgrCtx({ origin: 'guest-uid' }), 'ko', [], '', guest);
  assert.match((await guest.find((d) => d.name === 'office').handler({ action: 'company' })).content[0].text, /주인이 아닌 사람/);
  assert.equal(called, 0);
  fake();
  const owner = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], msgrCtx(), 'en', [], '', owner);
  const def = owner.find((d) => d.name === 'office');
  assert.match(def.description, /Argo Office company records/);
  assert.deepEqual(ensureRequired(crewToolSpecs([def])[0].input_schema).required, ['action']);
  assert.match((await def.handler({ action: 'company' })).content[0].text, /\(주\)A/);
});
