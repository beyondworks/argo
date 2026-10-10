// argo office <영역> CLI·argo office mcp(유건 10/10 "Claude Code든 Codex든 아르고든 연결해서 오피스를 CRUD") — 본체 에이전트와 같은 도구 정의·처리기를 쓰고,
// 문맥은 cliContext(주인이 자기 터미널에서). 서버는 가짜 세션 클라이언트로 대신한다(라이브 DB 호출 0).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = join(await mkdtemp(join(tmpdir(), 'argo-office-cli-')), 'workspaces'); await mkdir(process.env.ARGO_ROOT, { recursive: true });
process.env.ARGO_MODEL_CATALOG = 'off';
delete process.env.ARGO_OFFICE_SOURCE;

const { parseFlags, cliSpecs, checkArgs, toolsMain, BLOCKED } = await import('../src/office-tools-cli.mjs');
const { officeMcp } = await import('../src/office-mcp.mjs');
const { officeToolSpecs } = await import('../src/gateway/office-tools.mjs');
const { cliContext, isCliCtx, audienceOf } = await import('../src/gateway/office-audience.mjs');
const { officeMain } = await import('../src/office-cli.mjs');
const { attachPathRefusal, inAgentTurn } = await import('../src/office-tools-cli.mjs');
const { ARGO_OFFICE_SHELL_RE } = await import('../src/permission-gate.mjs');
const { scrubServerSecrets } = await import('../src/runners/shared.mjs');
const { workDeps } = await import('../src/gateway/office-work.mjs');

const ME = 'owner-uid', ORG = '11111111-1111-4111-8111-111111111111', NEW = '33333333-3333-4333-8333-333333333333';
const realWork = { ...workDeps };
after(() => Object.assign(workDeps, realWork));
Object.assign(workDeps, { now: () => Date.parse('2026-10-10T03:00:00Z'), newId: () => NEW });

function table(rows) {
  const q = { f: [], select() { return q; }, eq(k, v) { q.f.push((r) => r[k] === v); return q; }, is(k, v) { q.f.push((r) => (r[k] ?? null) === v); return q; }, in(k, vs) { q.f.push((r) => vs.includes(r[k])); return q; },
    then(ok, no) { return Promise.resolve({ data: rows.filter((r) => q.f.every((x) => x(r))), error: null }).then(ok, no); } };
  return q;
}
function fake() {
  const calls = [];
  const tasks = [{ id: 't1', title: '견적서 보내기', note: '', status: 'doing', priority: 1, category_id: null, category: null, starts_on: null, due_on: '2026-10-12', assignee: ME, created_by: ME, done_at: null, source: null }];
  const client = {
    from: (t) => {
      calls.push({ name: `from:${t}` });
      if (t === 'msgr_org_members') return table([{ user_id: ME, role: 'owner', removed_at: null, org: { id: ORG, name: 'Lean-AX', slug: 'lean-ax', deleted_at: null } }]);
      if (t === 'msgr_channel_members') return table([]);
      return table([]);
    },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'office_task_list') return { data: tasks.map((x) => ({ ...x })), error: null };
      if (name === 'office_task_write' && args.p_action === 'task.create') { const row = { assignee: ME, created_by: ME, done_at: null, ...args.p_data }; tasks.push(row); return { data: row, error: null }; }
      return { data: null, error: { message: 'unknown' } };
    },
  };
  const _fresh = async () => ({ access_token: 'tok', url: 'http://sb.invalid', anonKey: 'anon', user: { id: ME } });
  const _mkClient = () => client;
  return { calls, client, _fresh, _mkClient };
}
const run = async (argv, extra = {}) => {
  const out = [], err = [];
  const code = await officeMain(argv, { root: process.env.ARGO_ROOT, lang: 'ko', out: (s) => out.push(s), err: (s) => err.push(s), ...extra });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

// 이유: 에이전트(Claude Code 등)가 셸로 부를 때 옵션 이름은 kebab-case, 값은 글자 — 도구 형식(snake_case·숫자·불리언·JSON)으로 바꿔야 같은 처리기가 받는다
test('C1. 옵션 읽기: kebab→snake, 불리언 플래그, 숫자, JSON, 모르는 옵션·action은 오류', () => {
  const work = cliSpecs().find((s) => s.name === 'office_work');
  assert.deepEqual(parseFlags(['--due-on', '2026-10-12', '--overdue', '--title=견적 회신'], work.shape).args, { due_on: '2026-10-12', overdue: true, title: '견적 회신' });
  assert.deepEqual(parseFlags(['--overdue=false'], work.shape).args, { overdue: false });
  const deals = cliSpecs().find((s) => s.name === 'office_deals');
  const r = parseFlags(['--amount', '110000', '--lines', '[{"item":"촬영","unit_price":100000}]'], deals.shape);
  assert.deepEqual(r.args, { amount: 110000, lines: [{ item: '촬영', unit_price: 100000 }] });
  assert.ok(parseFlags(['--amount', 'many'], deals.shape).errors.length);
  assert.ok(parseFlags(['--nope', 'x'], work.shape).errors[0].includes('unknown'));
  assert.ok(parseFlags(['--action', 'tasks'], work.shape).errors[0].includes('unknown'), 'action은 자리 인자로만');
  assert.equal(checkArgs(work, { action: 'tasks', who: 'everyone' }).ok, false, '형식 밖 값은 처리기 전에 막는다');
});

// 이유(유건 10/10 결정 3): 되돌릴 수 없는 동작(일정 영구 삭제)은 CLI·MCP에 열지 않는다 — 형식에서도 빠져 에이전트가 시도하지 않는다. 본체 에이전트는 그대로
test('C2. 되돌릴 수 없는 동작은 CLI·MCP에서 빠진다(본체 정의는 그대로)', async () => {
  const cal = cliSpecs().find((s) => s.name === 'calendar');
  assert.deepEqual(BLOCKED.calendar, ['delete']);
  assert.ok(!cal.actions.includes('delete'));
  assert.ok(officeToolSpecs().find((s) => s.name === 'calendar').shape.action.options.includes('delete'), '본체 에이전트 정의에는 남는다');
  for (const s of cliSpecs()) if (s.name !== 'calendar') assert.deepEqual(s.actions, officeToolSpecs().find((x) => x.name === s.name).shape.action.options, `${s.name} 나머지 동작은 같다`);
  const f = fake();
  const r = await run(['calendar', 'delete', '--id', 'e1'], { _fresh: f._fresh, _mkClient: f._mkClient });
  assert.equal(r.code, 1);
  assert.match(r.err, /열지 않습니다/);
  assert.equal(f.calls.length, 0, '서버를 부르지 않는다');
  const { tools } = officeMcp({ root: process.env.ARGO_ROOT });
  assert.ok(!tools.find((t) => t.name === 'calendar').inputSchema.properties.action.enum.includes('delete'));
});

// 이유: CLI 문맥은 '주인 혼자 보는 자리'로 통과한다 — 메시지·메타 값(평범한 객체)이 같은 모양을 흉내 내도 그 판정을 받지 못해야 한다
test('C3. CLI 문맥은 이 모듈이 만든 것만 주인 자리 — 같은 모양의 객체는 아니다', async () => {
  const f = fake();
  const ctx = cliContext({ uid: ME, orgId: ORG });
  assert.equal(isCliCtx(ctx), true);
  assert.equal(await audienceOf(f.client, ctx, ME), 'owner');
  const copy = { ...ctx };
  assert.equal(isCliCtx(copy), false);
  assert.equal(await audienceOf(f.client, copy, ME), 'mixed', '흉내 낸 객체는 방 사람을 조회해 좁게 판정');
});

// 이유: CLI로 만든 일은 출처가 세션 — 업무 현황이 그 세션 카드에 묶는다(argo office hold와 같은 모양). 조직은 slug로도 고른다
test('C4. work tasks·task_add: 같은 처리기, 출처 = 세션 이름, --org slug', async () => {
  const f = fake();
  const opts = { _fresh: f._fresh, _mkClient: f._mkClient };
  const list = await run(['work', 'tasks', '--org', 'lean-ax'], opts);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /견적서 보내기/);
  const add = await run(['work', 'task_add', '--org', 'lean-ax', '--title', '견적 회신', '--due-on', '2026-10-12', '--source-name', 'Claude Code'], opts);
  assert.equal(add.code, 0, add.err);
  const w = f.calls.find((c) => c.name === 'office_task_write');
  assert.equal(w.args.p_org, ORG);
  assert.deepEqual(w.args.p_data.source, { kind: 'session', name: 'Claude Code' });
  assert.equal(w.args.p_data.due_on, '2026-10-12');
  const js = await run(['work', 'tasks', '--org', ORG, '--json'], opts);
  assert.deepEqual(Object.keys(JSON.parse(js.out)), ['area', 'tool', 'action', 'org', 'text']);
});

test('C5. 조직이 필요한 영역에 조직이 없으면 안내, 로그인이 없으면 종료 코드 2, 모르는 조직은 오류', async () => {
  const f = fake();
  const noOrg = await run(['work', 'tasks'], { _fresh: f._fresh, _mkClient: f._mkClient });
  assert.match(noOrg.out, /조직이 필요합니다/);
  assert.ok(!f.calls.some((c) => c.name === 'office_task_list'));
  const out = await run(['work', 'tasks', '--org', 'x'], { _fresh: async () => null, _mkClient: f._mkClient });
  assert.equal(out.code, 2);
  const bad = await run(['work', 'tasks', '--org', 'nowhere'], { _fresh: f._fresh, _mkClient: f._mkClient });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /no org/);
});

// 이유: Claude Code·Codex는 MCP로 붙는다 — 같은 도구에 org 인자, 조직 목록 도구, 붙은 클라이언트 이름이 출처
test('C6. MCP: 도구 목록(org 인자·office_orgs), 실행, 형식 오류는 isError, 출처 = 클라이언트 이름', async () => {
  const f = fake();
  const mcp = officeMcp({ root: process.env.ARGO_ROOT, clientName: () => 'claude-code', _fresh: f._fresh, _mkClient: f._mkClient });
  const names = mcp.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['calendar', 'office', 'office_briefing', 'office_deals', 'office_files', 'office_mail', 'office_orgs', 'office_work']);
  for (const t of mcp.tools.filter((x) => x.name !== 'office_orgs')) assert.ok(t.inputSchema.properties.org, `${t.name} org 인자`);
  const orgs = await mcp.call('office_orgs', {});
  assert.equal(JSON.parse(orgs.content[0].text)[0].slug, 'lean-ax');
  const bad = await mcp.call('office_work', { action: 'nope' });
  assert.equal(bad.isError, true);
  const ok = await mcp.call('office_work', { action: 'task_add', title: 'MCP로 만든 일', org: 'lean-ax' });
  assert.ok(!ok.isError, ok.content[0].text);
  assert.deepEqual(f.calls.find((c) => c.name === 'office_task_write').args.p_data.source, { kind: 'session', name: 'Claude Code' });
  const none = officeMcp({ root: process.env.ARGO_ROOT, _fresh: async () => null, _mkClient: f._mkClient });
  assert.equal((await none.call('office_work', { action: 'tasks' })).isError, true, '로그인 없음');
});

test('C7. 기존 명령(report·hold·tasks)은 그대로, 영역 명령은 로그인 없이 도움말·목록', async () => {
  const tools = await run(['tools']);
  assert.equal(tools.code, 0);
  assert.match(tools.out, /work\s+tasks/);
  const help = await run(['deals', '--help']);
  assert.match(help.out, /--customer-id/);
  const usage = await run(['help']);
  assert.match(usage.out, /argo office orgs/);
});

// 이유: 본체 에이전트 도구 정의를 옮겼다 — 이름·인자 형식·손님 거절 문구가 7종 그대로여야 본체 턴이 바뀌지 않는다
test('C8. 공용 정의 7종(본체와 같은 이름·동작) — CLI용 설명에는 문맥 안내만 덧붙는다', () => {
  const names = officeToolSpecs().map((s) => s.name);
  assert.deepEqual(names, ['calendar', 'office', 'office_files', 'office_work', 'office_deals', 'office_mail', 'office_briefing']);
  for (const s of officeToolSpecs()) { assert.ok(s.guest.ko && s.guest.en); assert.ok(s.shape.action); }
  const cli = cliSpecs().find((s) => s.name === 'office_work');
  assert.ok(cli.description.startsWith(officeToolSpecs().find((s) => s.name === 'office_work').description));
  assert.match(cli.description, /argo office CLI·MCP/);
});

// 이유(분리 검수 MEDIUM-1): 아르고 크루가 셸·MCP로 이 CLI를 거치면 '1:1에서만' 판정을 넘는다 — 에이전트 턴 표지가 있으면 CLI·MCP가 거절, 게이트도 막는다
test('C9. 에이전트 턴 안(ARGO_AGENT_TURN)에서는 CLI·MCP 거절, 러너 환경에 표지가 붙는다, 게이트가 셸 명령을 막는다', async () => {
  assert.equal(scrubServerSecrets({ PATH: '/bin' }).ARGO_AGENT_TURN, '1');
  const f = fake();
  process.env.ARGO_AGENT_TURN = '1';
  try {
    assert.equal(inAgentTurn(), true);
    const r = await run(['work', 'tasks', '--org', ORG], { _fresh: f._fresh, _mkClient: f._mkClient });
    assert.equal(r.code, 1);
    assert.match(r.err, /에이전트 턴 안/);
    const mcp = officeMcp({ root: process.env.ARGO_ROOT, _fresh: f._fresh, _mkClient: f._mkClient });
    assert.equal((await mcp.call('office_work', { action: 'tasks', org: ORG })).isError, true);
    assert.equal(f.calls.length, 0, '서버를 부르지 않는다');
  } finally { delete process.env.ARGO_AGENT_TURN; }
  for (const cmd of ['argo office mail mails', 'node bin/argo.mjs office work tasks', 'cd x && argo office tools', 'ARGO_AGENT_TURN= argo office deals customers', 'node /x/src/office-mcp.mjs']) assert.ok(ARGO_OFFICE_SHELL_RE.test(cmd), cmd);
  for (const cmd of ['grep -r "argo office" docs', 'echo argonaut office', 'ls office']) assert.ok(!ARGO_OFFICE_SHELL_RE.test(cmd), cmd);
});

// 이유(분리 검수 MEDIUM-2): 본체 판정은 회사 폴더 전제라 작업 폴더 아래 깊은 .env·홈 폴더의 키체인을 막지 못했다
test('C10. 문서함 첨부 경로: 작업 폴더 안 보통 파일만, 홈·그 위 거절, 어느 자리든 점 이름·비밀 파일 거절', async () => {
  const home = '/Users/u', proj = '/Users/u/work/proj';
  for (const p of ['.env.local', 'apps/messenger/.env', 'sub/.env.local', 'config/credentials.json', '.git/config', 'keys/id_rsa', 'certs/server.pem', '../other/file.pdf', '/etc/passwd'])
    assert.ok(await attachPathRefusal(p, proj, home), `${p} 거절`);
  assert.equal(await attachPathRefusal('docs/명함.png', proj, home), null);
  assert.ok(await attachPathRefusal('lean-projects/saas/argo/.env.local', home, home), '홈에서는 거절');
  assert.ok(await attachPathRefusal('x.pdf', '/Users', home), '홈 위에서도 거절');
  const f = fake();
  const r = await run(['files', 'attach', '--org', ORG, '--path', 'sub/.env.local'], { _fresh: f._fresh, _mkClient: f._mkClient, cwd: proj });
  assert.match(r.out, /올리지 않습니다/);
  assert.ok(!f.calls.some((c) => c.name.startsWith('office_file')), '서버를 부르지 않는다');
});

test('C11. 옵션 경계: 빈 숫자·0x·다음 옵션을 값으로 삼키기·끝에 둔 --org·-h', async () => {
  const deals = cliSpecs().find((s) => s.name === 'office_deals'), work = cliSpecs().find((s) => s.name === 'office_work');
  for (const t of [['--amount='], ['--amount', ''], ['--amount', ' '], ['--amount', '0x10']]) assert.ok(parseFlags(t, deals.shape).errors.length, JSON.stringify(t));
  const r = parseFlags(['--q', '--overdue'], work.shape);
  assert.ok(r.errors.length && r.args.q === undefined, '--overdue를 q 값으로 삼키지 않는다');
  assert.ok(parseFlags(['--constructor', 'x'], work.shape).errors[0].includes('unknown'));
  const f = fake();
  const noVal = await run(['work', 'task_add', '--title', 'x', '--org'], { _fresh: f._fresh, _mkClient: f._mkClient });
  assert.equal(noVal.code, 1);
  assert.ok(!f.calls.some((c) => c.name === 'office_task_write'), '기본 조직으로 새지 않는다');
  assert.match((await run(['work', '-h'])).out, /--due-on/);
  const bare = await run(['work'], { _fresh: async () => null });
  assert.equal(bare.code, 1, '동작 없으면 로그인 전에 사용법');
  assert.match((await run(['mcp', '--help'])).out, /claude mcp add/);
});

test('C12. MCP 형식 검사는 엄격(모르는 인자 거절), Claude Code MCP 가져오기는 오피스 MCP를 거절', async () => {
  const f = fake();
  const mcp = officeMcp({ root: process.env.ARGO_ROOT, _fresh: f._fresh, _mkClient: f._mkClient });
  assert.equal((await mcp.call('office_work', { action: 'tasks', org: ORG, sneaky: 1 })).isError, true);
  const { writeFile } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'argo-office-home-')), keep = process.env.HOME;
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'argo-office': { command: 'node', args: ['/x/bin/argo.mjs', 'office', 'mcp'] }, other: { command: 'argo', args: ['office', 'mcp'] } } }));
  process.env.HOME = home;
  try {
    const { importHostMcp } = await import('../src/market.mjs');
    await assert.rejects(importHostMcp('w-test', 'argo-office'), /오피스 MCP는 가져오지 않습니다/);
    await assert.rejects(importHostMcp('w-test', 'other'), /오피스 MCP는 가져오지 않습니다/);
  } finally { process.env.HOME = keep; }
});
