// 손님 턴(크루 주인이 아닌 사람이 시킨 메신저 턴) — 실행 경로별 행동 잠금.
// 실제 chat()·권한 게이트·크루 도구·커넥터를 돌리고 벤더 턴(SDK query·네이티브 루프·CLI 실행)만 바꿔 끼운다.
// 규칙 7(주인의 몸은 주인만)·9(주인의 개인 기억은 공유한 것만). 허용 목록은 **실행 경로** 기준이다 — 러너 이름이 아니라.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-guest-turn-'));
const fixtureHome = join(root, 'home');
await mkdir(fixtureHome, { recursive: true });
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
process.env.ARGO_ROOT = join(root, 'workspaces');
process.env.ARGO_CACHE_DIR = join(root, 'cache');
process.env.ARGO_MODEL_CATALOG = 'off';
process.env.ARGO_NATIVE_RUNNERS = 'off';
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) process.env[key] = '';
const actualFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (new URL(String(url)).hostname !== '127.0.0.1') throw new Error('External network disabled in guest-turn test');
  return actualFetch(url, options);
};

let runner = 'claude'; let vendorTurn = async () => 'fixture finished';
globalThis.__guestRunner = () => runner;
globalThis.__guestTurn = (...args) => vendorTurn(...args);
const stubIterator = `const iterator = (async function* () {
    await globalThis.__guestTurn(opts.options ?? opts);
    yield {type:'assistant', message:{content:[{type:'text',text:'fixture finished'}]}};
    yield {type:'result', subtype:'success', session_id:'fixture', result:'fixture finished', usage:{input_tokens:1,output_tokens:1}, total_cost_usd:0};
  })(); iterator.interrupt = async () => {}; return iterator;`;
const wrappers = new Map();
for (const [specifier, replacements] of [
  ['./runners.mjs', `export const resolveRunner = async () => ({runner: globalThis.__guestRunner(), available:true, fellBack:false});
    export const runnerCredType = async () => 'host'; export const runnerCredEnv = async () => ({});
    export const sdkEnvFor = async () => ({}); export const isBilledRunner = async () => false;
    export const externalExec = (opts) => globalThis.__guestTurn(opts);`],
  ['./connectors.mjs', 'export const connectorBriefing = async () => [];'],
  ['./runners/catalog-remote.mjs', 'export const loadRemoteCatalog = async () => null;'],
  ['./engine/native-query.mjs', `export function nativeQuery(opts) { ${stubIterator} }`],
]) {
  const real = new URL(`../src/${specifier.slice(2)}`, import.meta.url).href;
  wrappers.set(specifier, `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)}; ${replacements}`)}`);
}
const sdk = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
wrappers.set('@anthropic-ai/claude-agent-sdk', `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(sdk)};
  export function query(opts) { ${stubIterator} }`)}`);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/chat.mjs') && wrappers.has(specifier)) return { url: wrappers.get(specifier), shortCircuit: true };
  return next(specifier, context);
} });

const { chat, makeCrewServer, guestCliRefusal, SDK_ALLOWED_TOOLS } = await import('../src/chat.mjs');
const { makePermissionGate } = await import('../src/permission-gate.mjs');
const { isGuestCtx, messengerOrigin, mirrorCtxFromOrigin } = await import('../src/gateway/msgr-handoff.mjs');
const { callConnectorTool } = await import('../src/connectors.mjs');
const { RUNNERS } = await import('../src/runners/catalog.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');
const { loadRoutines } = await import('../src/routines.mjs');
after(() => { hooks.deregister(); globalThis.fetch = actualFetch; delete globalThis.__guestRunner; delete globalThis.__guestTurn; delete RUNNERS.fakecli; });

const OWNER = 'owner-uid'; const GUEST = 'guest-uid';
let seq = 0;
async function setup(card = runner) {
  const ws = `guest-${++seq}`;
  await createCompany(ws, 'Guest QA', 'owner');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), `---\nname: Alpha\nrunner: ${card}\n---\nQA fixture`);
  return ws;
}
// 메신저 턴 맥락 — msgr.mjs run()이 만드는 모양(orgSlug 없음 = 조직 규칙 파일 읽기 생략)
const ctxOf = (ws, origin, extra = {}) => ({ kind: 'msgr', chatType: 'group', channelKind: 'public', orgId: 'org-1', channelId: 'ch-1', crewId: 'crew-1',
  threadRoot: 1, sourceMsgId: 1, uid: OWNER, wsId: ws, origin, rootAuthor: null, hop: 0, orgSlug: null, channelName: 'general', peers: [], handoffs: [], ...extra });

// ── 판정 ──────────────────────────────────────────────────────────────────────
test('isGuestCtx: 주인이 시키면 주인 턴, 남이 시키거나 모르면 손님(fail-closed)', () => {
  assert.equal(isGuestCtx(ctxOf('w', OWNER)), false, '주인이 직접');
  assert.equal(isGuestCtx(ctxOf('w', GUEST)), true, '남이 직접');
  assert.equal(isGuestCtx(ctxOf('w', null)), true, '시킨 사람을 모름');
  assert.equal(isGuestCtx(ctxOf('w', OWNER, { uid: null })), true, '주인을 모름');
  // 넘김: origin은 넘긴 크루의 주인(A)이고 뿌리 사람은 rootAuthor — "손님 B → A의 크루 X → A의 크루 Y"에서 Y는 손님이다
  assert.equal(isGuestCtx(ctxOf('w', OWNER, { rootAuthor: GUEST })), true, '뿌리가 남');
  assert.equal(isGuestCtx(ctxOf('w', OWNER, { rootAuthor: OWNER })), false, '뿌리도 주인');
  assert.equal(isGuestCtx(ctxOf('w', OWNER, { guest: true })), true, '한 번 손님이 된 사슬은 끝까지');
  assert.equal(isGuestCtx({ kind: 'deck' }), false, '메신저 밖 턴은 해당 없음');
  assert.equal(isGuestCtx(null), false);
});

test('fullAutoAllowed: 주인이 직접 시킨 턴만 — 손님·오피스에서 맡긴 턴은 풀 오토 제외(권한을 낮추기만 한다)', async () => {
  const { fullAutoAllowed } = await import('../src/gateway/msgr-handoff.mjs');
  assert.equal(fullAutoAllowed(ctxOf('w', OWNER)), true, '주인 직접');
  assert.equal(fullAutoAllowed(ctxOf('w', OWNER, { office: true })), false, '오피스에서 맡긴 턴(외부 자료)');
  assert.equal(fullAutoAllowed(ctxOf('w', GUEST)), false, '손님');
  assert.equal(fullAutoAllowed({ kind: 'deck' }), true, '메신저 밖 턴은 해당 없음');
  assert.equal(fullAutoAllowed(null), true);
  // 오피스 표지는 손님으로 만들지 않는다 — 주인의 몸(파일·셸·커넥터)은 쓰되 쓰기는 결재로
  const { isGuestCtx } = await import('../src/gateway/msgr-handoff.mjs');
  assert.equal(isGuestCtx(ctxOf('w', OWNER, { office: true })), false);
  // 쪽지로 옮겨 타도 표지가 남는다
  const rec = messengerOrigin(ctxOf('w', OWNER, { office: true }));
  assert.equal(rec.office, true, '기록이 오피스 표지를 싣는다');
  assert.equal(fullAutoAllowed(mirrorCtxFromOrigin(rec, { crewId: 'crew-z' })), false, '쪽지 수신 턴도 풀 오토 제외');
  assert.equal(messengerOrigin(ctxOf('w', OWNER)).office, undefined, '표지 없는 기록 모양은 그대로');
});

test('요청자 사슬이 쪽지로 옮겨 타도 유지된다 — messengerOrigin → mirrorCtxFromOrigin', () => {
  // 손님 B → A의 크루 X → (넘김) A의 크루 Y: Y 턴은 origin=A, rootAuthor=B → 손님. Y가 쪽지를 보내면 기록에는 rootAuthor·guest가 실려야 한다
  const y = ctxOf('w', OWNER, { rootAuthor: GUEST });
  const rec = messengerOrigin(y);
  assert.equal(rec.guest, true, '기록이 손님 표지를 싣는다');
  const z = mirrorCtxFromOrigin(rec, { crewId: 'crew-z' });
  assert.equal(isGuestCtx(z), true, '쪽지 수신 턴(Z)도 손님 — 여기서 주인 권한으로 되살아나면 승격');
  // 주인의 사슬은 쪽지를 거쳐도 주인이다(fail-closed가 주인 흐름을 손님으로 만들지 않는다)
  const own = mirrorCtxFromOrigin(messengerOrigin(ctxOf('w', OWNER)), { crewId: 'crew-z' });
  assert.equal(isGuestCtx(own), false, '주인의 쪽지는 주인 턴');
});

test('쪽지 수신 턴(scheduler)의 맥락이 요청자 사슬을 잇는다 — 손님 사슬은 손님, 주인의 쪽지는 주인', async () => {
  const { crewmailMirrorCtx } = await import('../src/scheduler.mjs');
  // 손님 B → A의 크루 X → (넘김) A의 크루 Y → (쪽지) A의 크루 Z. 여기서 Z가 주인 턴이면 승격이다.
  const viaHandoff = crewmailMirrorCtx('w', 'zeta', { msgr: messengerOrigin(ctxOf('w', OWNER, { rootAuthor: GUEST })) });
  assert.equal(isGuestCtx(viaHandoff), true, '손님 사슬의 쪽지 수신 턴은 손님');
  const own = crewmailMirrorCtx('w', 'zeta', { msgr: messengerOrigin(ctxOf('w', OWNER)) });
  assert.equal(isGuestCtx(own), false, '주인의 쪽지 수신 턴은 주인 — 맥락을 옮기지 않으면 fail-closed가 주인까지 손님으로 만든다');
  assert.equal(own.kind, 'msgr'); assert.equal(own.channelId, 'ch-1'); assert.equal(own.channelName, '', '수신 쪽 사실은 기록에서');
  assert.equal(crewmailMirrorCtx('w', 'zeta', { msgr: null }), null, '메신저 밖 쪽지는 맥락 없음');
});

// ── 권한 게이트 ────────────────────────────────────────────────────────────────
test('권한 게이트 guest: TodoWrite·크루 도구만 허용, 파일·셸·웹·외부 MCP·브라우저·하위 에이전트는 거부', async () => {
  const ws = await setup('claude');
  const inside = join(paths(ws).root, 'vault', 'note.md');
  const guestGate = makePermissionGate(ws, 'alpha', paths(ws).root, null, 'ko', [], { guest: true });
  for (const [tool, input] of [['Read', { file_path: inside }], ['Glob', { pattern: '**/*' }], ['Grep', { pattern: 'x' }], ['Write', { file_path: inside, content: 'x' }],
    ['Edit', { file_path: inside }], ['NotebookEdit', { notebook_path: inside }], ['Bash', { command: 'ls' }], ['WebFetch', { url: 'https://example.com' }],
    ['WebSearch', { query: 'x' }], ['Task', { prompt: 'x' }], ['mcp__filesystem__write_file', { path: inside }], ['mcp__argo_browser__browser_navigate', { url: 'about:blank' }]]) {
    assert.equal((await guestGate(tool, input)).behavior, 'deny', `손님 턴 ${tool}`);
  }
  for (const tool of ['TodoWrite', 'mcp__crew', 'mcp__crew__request_approval']) assert.equal((await guestGate(tool, {})).behavior, 'allow', `손님 턴 ${tool}`);
  const denied = await guestGate('Write', { file_path: inside, content: 'x' });
  assert.match(denied.message, /주인이 아닌 사람/, '크루가 읽는 거부 사유');
  // 주인 턴은 그대로(회귀 앵커) — 워크스페이스 안 쓰기는 허용
  const ownerGate = makePermissionGate(ws, 'alpha', paths(ws).root, null, 'ko', []);
  assert.equal((await ownerGate('Write', { file_path: inside, content: 'x' })).behavior, 'allow', '주인 턴 쓰기');
});

// ── 실행 경로별 chat() ─────────────────────────────────────────────────────────
test('SDK 경로(claude): 손님 턴은 웹 사전 승인이 빠지고 파일·셸·웹이 게이트에서 막힌다 — 주인 턴은 그대로', async () => {
  runner = 'claude'; process.env.ARGO_NATIVE_RUNNERS = 'off';
  const ws = await setup('claude');
  const inside = join(paths(ws).root, 'vault', 'note.md');
  let seen;
  vendorTurn = async (options) => { seen = options; return 'fixture finished'; };
  await chat(ws, 'alpha', 'hi', null, { mirrorCtx: ctxOf(ws, GUEST), source: 'messenger', journal: { off: true } });
  assert.ok(seen, 'SDK query가 실제로 불렸다');
  assert.deepEqual(seen.allowedTools, ['mcp__crew'], '손님 턴 사전 승인 = 크루 도구뿐(웹은 게이트로)');
  for (const tool of ['WebFetch', 'Write', 'Read', 'Bash', 'Task']) assert.equal((await seen.canUseTool(tool, { file_path: inside, url: 'https://example.com', command: 'ls', prompt: 'x' })).behavior, 'deny', `손님 ${tool}`);

  seen = null;
  await chat(ws, 'alpha', 'hi', null, { mirrorCtx: ctxOf(ws, OWNER), source: 'messenger', journal: { off: true } });
  assert.deepEqual(seen.allowedTools, [...SDK_ALLOWED_TOOLS], '주인 턴 사전 승인 목록 불변');
  assert.equal((await seen.canUseTool('Write', { file_path: inside, content: 'x' })).behavior, 'allow', '주인 턴 쓰기');
});

test('네이티브 경로(openrouter): 손님 턴의 게이트가 파일·셸·웹을 막는다 — 주인 턴은 그대로', async () => {
  runner = 'openrouter'; process.env.ARGO_NATIVE_RUNNERS = 'openrouter';
  try {
    const ws = await setup('openrouter');
    const inside = join(paths(ws).root, 'vault', 'note.md');
    let seen;
    vendorTurn = async (options) => { seen = options; return 'fixture finished'; };
    await chat(ws, 'alpha', 'hi', null, { mirrorCtx: ctxOf(ws, GUEST), source: 'messenger', journal: { off: true } });
    assert.ok(seen?.canUseTool, '네이티브 루프가 실제로 불렸다');
    for (const tool of ['WebFetch', 'Write', 'Read', 'Bash']) assert.equal((await seen.canUseTool(tool, { file_path: inside, url: 'https://example.com', command: 'ls' })).behavior, 'deny', `손님 ${tool}`);
    seen = null;
    await chat(ws, 'alpha', 'hi', null, { mirrorCtx: ctxOf(ws, OWNER), source: 'messenger', journal: { off: true } });
    assert.equal((await seen.canUseTool('Write', { file_path: inside, content: 'x' })).behavior, 'allow', '주인 턴 쓰기');
  } finally { process.env.ARGO_NATIVE_RUNNERS = 'off'; }
});

test('손님 턴 셸 경유 세션 탈취 차단 — 변수로 조합한 경로로 주인의 .device-session.json을 읽으려 해도 SDK·네이티브 게이트가 막는다', async () => {
  // 셸 방어는 명령 문자열에 파일 이름이 **리터럴로** 있을 때만 잡는다(permission-gate 머리 주석 "셸 한계"). 이 명령은 그 이름을 담지 않는다 —
  // 리터럴 방어를 지나가는 모양이다. 성립하면 남이 주인 명의로 결재 확정·allow 변경·(주인이 관리자면) 초대·설정 변경까지 한다.
  const attack = { command: 'd=.device; cat "$HOME/${d}-session.json" "$ARGO_ROOT/${d}-session.json"' };
  assert.ok(!attack.command.includes('.device-session.json'), '전제: 리터럴 방어를 우회하는 모양의 명령');
  for (const [name, native] of [['claude', 'off'], ['openrouter', 'openrouter']]) {
    runner = name; process.env.ARGO_NATIVE_RUNNERS = native;
    try {
      const ws = await setup(name);
      let seen; vendorTurn = async (options) => { seen = options; return 'fixture finished'; };
      await chat(ws, 'alpha', 'hi', null, { mirrorCtx: ctxOf(ws, GUEST), source: 'messenger', journal: { off: true } });
      assert.ok(seen?.canUseTool, `${name}: 실제 턴이 게이트를 만들었다`);
      assert.equal((await seen.canUseTool('Bash', attack)).behavior, 'deny', `${name}: 손님 턴의 셸 경유 세션 탈취는 막힌다`);
    } finally { process.env.ARGO_NATIVE_RUNNERS = 'off'; }
  }
});

test('CLI 경로(codex): 손님 턴은 CLI를 띄우지 않고 정직하게 거절한다 — 주인 턴은 그대로 실행', async () => {
  runner = 'codex';
  const ws = await setup('codex');
  let calls = 0;
  vendorTurn = async () => { calls++; return 'fixture finished'; };
  const r = await chat(ws, 'alpha', 'hi', null, { mirrorCtx: ctxOf(ws, GUEST), source: 'messenger', journal: { off: true } });
  assert.equal(calls, 0, '손님 턴은 CLI(주인의 셸·파일을 게이트 없이 쓰는 경로)를 띄우지 않는다');
  assert.equal(r.reply, guestCliRefusal('Alpha', 'ko'), '거절은 던지지 않고 답으로(던지면 큐가 잡을 되살린다)');
  await chat(ws, 'alpha', 'hi', null, { mirrorCtx: ctxOf(ws, OWNER), source: 'messenger', journal: { off: true } });
  assert.equal(calls, 1, '주인 턴은 그대로 CLI 실행');
});

test('허용 목록은 실행 경로 기준 — 새로 추가된 CLI 러너도 손님 턴에서 막힌다', async () => {
  RUNNERS.fakecli = { name: 'FakeCLI', kind: 'cli', models: [{ id: '', label: '기본' }] };
  runner = 'fakecli';
  const ws = await setup('fakecli');
  let calls = 0;
  vendorTurn = async () => { calls++; return 'fixture finished'; };
  const r = await chat(ws, 'alpha', 'hi', null, { mirrorCtx: ctxOf(ws, GUEST), source: 'messenger', journal: { off: true } });
  assert.equal(calls, 0, '이름 목록이었다면 새 러너가 방어 없이 열린다');
  assert.equal(r.reply, guestCliRefusal('Alpha', 'ko'));
  delete RUNNERS.fakecli;
});

// ── 크루 도구(게이트를 건너뛰므로 처리기 안이 유일한 판정 자리) ─────────────────────
async function crewTools(ws, ctx) {
  const sink = [];
  makeCrewServer(ws, 'alpha', 'Alpha', [], 0, [], ctx, 'ko', [], '', sink, null);
  const by = Object.fromEntries(sink.map((t) => [t.name, t.handler]));
  return async (name, args) => (await by[name](args)).content[0].text;
}

test('크루 도구 손님: 도구 설치는 host 거절·catalog 주인 결재(즉시 설치 없음), 예약·목록·취소·장기 작업은 거절', async () => {
  const ws = await setup('claude');
  const call = await crewTools(ws, ctxOf(ws, GUEST));
  const mcpJson = join(paths(ws).root, 'mcp.json');

  assert.match(await call('request_tool_install', { source: 'host', id: 'github', why: 'x' }), /주인 컴퓨터의 도구 가져오기/);
  assert.equal((await loadApprovals(ws)).length, 0, 'host는 결재로도 올리지 않는다');

  assert.match(await call('request_tool_install', { source: 'catalog', id: 'notion', why: '회의록 정리' }), /주인 결재로 올렸다/);
  const aps = await loadApprovals(ws);
  assert.equal(aps.length, 1);
  assert.equal(aps[0].kind, 'mcp');
  assert.deepEqual(aps[0].payload, { source: 'catalog', id: 'notion' }, '완결 경로(approval-actions kind:mcp)가 받는 모양');
  assert.equal(existsSync(mcpJson), false, '승인 전에는 설치하지 않는다');

  for (const [name, args] of [['schedule_task', { title: 't', prompt: 'p', type: 'daily', time: '09:00' }], ['list_routines', {}],
    ['cancel_routine', { id: 'r1', action: 'delete' }], ['start_long_task', { title: 't', prompt: 'p' }]]) {
    assert.match(await call(name, args), /주인이 아닌 사람/, `${name} 거절`);
  }
  assert.equal((await loadRoutines(ws)).length, 0, '예약이 만들어지지 않았다');
});

// ── 커넥터(주인의 계정 — 읽기 도구는 결재 없이 통과하던 자리) ───────────────────────
test('커넥터 손님: 결재 게이트보다 앞에서 막는다 — 주인 턴은 이 판정에 걸리지 않는다', async () => {
  const ws = await setup('claude');
  const guestR = await callConnectorTool(ws, 'gmail', 'search_threads', { query: 'x' }, { mirrorCtx: ctxOf(ws, GUEST) });
  assert.equal(guestR.ok, false);
  assert.equal(guestR.error, 'guest_blocked');
  const ownerR = await callConnectorTool(ws, 'gmail', 'search_threads', { query: 'x' }, { mirrorCtx: ctxOf(ws, OWNER) });
  assert.notEqual(ownerR.error, 'guest_blocked', '주인 턴은 기존 판정(미연결 등)으로 간다');
});

// ── 메신저 v2 일(agent-link 범위 턴, U4b): team·guest 등급 = 위 조직 채널 손님 턴과 같은 도구 묶음, owner = 주인 턴 ──
const linkCtx = (owner) => ({ kind: 'scope', scope: { kind: 'link', work: 'w-1', room: 'r-1', owner } });
test('v2 link 범위: owner 표지가 없으면 SDK·네이티브·CLI 모두 조직 채널 손님 턴과 같은 제한, owner면 주인 턴과 같다', async () => {
  for (const [name, native] of [['claude', 'off'], ['openrouter', 'openrouter']]) {
    runner = name; process.env.ARGO_NATIVE_RUNNERS = native;
    try {
      const ws = await setup(name);
      const inside = join(paths(ws).root, 'vault', 'note.md');
      const probe = async (mirrorCtx) => {
        let seen; vendorTurn = async (options) => { seen = options; return 'fixture finished'; };
        await chat(ws, 'alpha', 'hi', null, { mirrorCtx, source: 'messenger', journal: { off: true } });
        const out = { allowed: seen.allowedTools ?? null };
        for (const tool of ['WebFetch', 'Write', 'Read', 'Bash']) out[tool] = (await seen.canUseTool(tool, { file_path: inside, url: 'https://example.com', command: 'ls', content: 'x' })).behavior;
        return out;
      };
      const legacyGuest = await probe(ctxOf(ws, GUEST));
      const legacyOwner = await probe(ctxOf(ws, OWNER));
      assert.deepEqual(await probe(linkCtx(false)), legacyGuest, `${name}: team·guest = 조직 채널 손님 턴`);
      assert.deepEqual(await probe(linkCtx(undefined)), legacyGuest, `${name}: 표지 없음 = 손님(fail-closed)`);
      assert.equal((await probe(linkCtx(true))).Write, legacyOwner.Write, `${name}: owner = 주인 턴 쓰기`);
    } finally { process.env.ARGO_NATIVE_RUNNERS = 'off'; }
  }
  runner = 'codex';
  const ws = await setup('codex');
  let calls = 0; vendorTurn = async () => { calls++; return 'fixture finished'; };
  const r = await chat(ws, 'alpha', 'hi', null, { mirrorCtx: linkCtx(false), source: 'messenger', journal: { off: true } });
  assert.equal(calls, 0, 'team·guest CLI 턴은 CLI를 띄우지 않는다');
  assert.equal(r.reply, guestCliRefusal('Alpha', 'ko'));
  await chat(ws, 'alpha', 'hi', null, { mirrorCtx: linkCtx(true), source: 'messenger', journal: { off: true } });
  assert.equal(calls, 1, 'owner CLI 턴은 실행');
});

// ── #1078 검수 반영: team·guest link 턴 → send_to_crew → 쪽지 배달 턴도 같은 등급(높음), owner link 턴의 고위험 셸 결재(D28, 중간) ──
const { deliverCrewMail } = await import('../src/crewmail.mjs');
const { crewmailTurn } = await import('../src/scheduler.mjs');
const { resolveApproval } = await import('../src/approvals.mjs');
async function withBeta(ws, card = runner) { await writeFile(join(paths(ws).agents, 'beta.md'), `---\nname: Beta\nrunner: ${card}\n---\nQA fixture`); }
async function deliveredGate(ws, ctx) {
  // 실제 makeCrewServer의 send_to_crew → 실제 쪽지함 → 실제 deliverCrewMail·crewmailTurn → 실제 chat()·권한 게이트
  const sink = [];
  makeCrewServer(ws, 'alpha', 'Alpha', [{ slug: 'beta', name: 'Beta' }], 0, [], ctx, 'ko', [], '', sink, null);
  const send = sink.find((t) => t.name === 'send_to_crew');
  assert.match((await send.handler({ to: 'beta', message: '이 파일 고쳐 줘' })).content[0].text, /쪽지를 보냈다/);
  let seen; vendorTurn = async (options) => { seen = options; return 'fixture finished'; };
  await deliverCrewMail(ws, (slug, msg, opts) => crewmailTurn(ws, slug, msg, opts));
  assert.ok(seen?.canUseTool, '배달 턴이 실제로 돌았다');
  return seen;
}
test('v2 link 턴의 쪽지(send_to_crew) → 배달 턴도 같은 등급: team·guest는 손님 도구(Bash·Write·Read·WebFetch 거부), owner는 주인 도구', async () => {
  runner = 'claude'; process.env.ARGO_NATIVE_RUNNERS = 'off';
  const inside = (ws) => join(paths(ws).root, 'vault', 'note.md');
  for (const owner of [false, true]) {
    const ws = await setup('claude'); await withBeta(ws, 'claude');
    const seen = await deliveredGate(ws, linkCtx(owner));
    for (const tool of ['Bash', 'Write', 'Read', 'WebFetch']) {
      const b = (await seen.canUseTool(tool, { file_path: inside(ws), url: 'https://example.com', command: 'ls', content: 'x' })).behavior;
      assert.equal(b, owner ? 'allow' : 'deny', `${owner ? 'owner' : 'team·guest'} 배달 턴 ${tool}`);
    }
    assert.deepEqual(seen.allowedTools, owner ? [...SDK_ALLOWED_TOOLS] : ['mcp__crew'], '배달 턴 사전 승인 목록');
  }
});

test('D28: v2 owner link 턴의 고위험 셸(rm -rf ~/Documents/x)은 옛 메신저 주인 턴처럼 결재로 막히고, 결재는 그 일의 범위를 단다(옛 msgr 목적지 없음) — 승인되면 같은 명령을 한 번 허용', async () => {
  runner = 'claude'; process.env.ARGO_NATIVE_RUNNERS = 'off';
  const cmd = { command: 'rm -rf ~/Documents/x' };
  const ws = await setup('claude');
  let seen; vendorTurn = async (options) => { seen = options; return 'fixture finished'; };
  await chat(ws, 'alpha', 'hi', null, { mirrorCtx: ctxOf(ws, OWNER), source: 'messenger', journal: { off: true } });
  assert.equal((await seen.canUseTool('Bash', cmd, { toolUseID: 'legacy-1' })).behavior, 'deny', '배포본 메신저 주인 턴: 결재');
  const ws2 = await setup('claude');
  const ctx = linkCtx(true); ctx.scope.work = 'w-d28';
  await chat(ws2, 'alpha', 'hi', null, { mirrorCtx: ctx, source: 'messenger', journal: { off: true } });
  const r = await seen.canUseTool('Bash', cmd, { toolUseID: 'v2-1' });
  assert.equal(r.behavior, 'deny', 'v2 owner 턴도 결재(배포본 대비 회귀 없음)');
  const aps = (await loadApprovals(ws2)).filter((a) => a.payload?.shell);
  assert.equal(aps.length, 1);
  assert.deepEqual(aps[0].scope, { kind: 'link', work: 'w-d28', room: 'r-1', owner: true }, '그 일의 범위');
  assert.equal(aps[0].msgr, undefined, '옛 메신저 목적지로 미러하지 않는다');
  // 같은 명령을 다시 시도하면 새 카드 없이 같은 결재를 가리킨다
  assert.equal((await seen.canUseTool('Bash', cmd, { toolUseID: 'v2-2' })).behavior, 'deny');
  assert.equal((await loadApprovals(ws2)).filter((a) => a.payload?.shell).length, 1);
  // 승인 → 후속 턴(같은 범위)이 같은 명령을 한 번 실행할 수 있다
  await resolveApproval(ws2, aps[0].id, true);
  await chat(ws2, 'alpha', 'go', null, { mirrorCtx: ctx, source: 'messenger', journal: { off: true } });
  assert.equal((await seen.canUseTool('Bash', cmd, { toolUseID: 'v2-3' })).behavior, 'allow', '승인된 같은 명령 한 번');
  assert.equal((await seen.canUseTool('Bash', cmd, { toolUseID: 'v2-4' })).behavior, 'deny', '두 번째는 다시 결재');
});

// ── #1078 후속: 기억 안 남김 방의 쪽지 배달·결재 후속 턴은 일지 없음(a), 승인된 셸 명령은 그 일에서만(b) ──
const { readdir } = await import('node:fs/promises');
const { _followUpForTest } = await import('../src/approval-actions.mjs');
const journalFiles = async (ws, slug) => (await readdir(paths(ws).journal).catch(() => [])).filter((f) => f.endsWith(`-${slug}.md`));
test('기억 안 남김 방(memoryOff)의 link 쪽지 → 배달 턴은 PC 일지를 쓰지 않는다 — 기억 남김 방은 종전대로 쓴다', async () => {
  runner = 'claude'; process.env.ARGO_NATIVE_RUNNERS = 'off';
  for (const memoryOff of [false, true]) {
    const ws = await setup('claude'); await withBeta(ws, 'claude');
    const ctx = linkCtx(true); if (memoryOff) ctx.scope.memoryOff = true;
    await deliveredGate(ws, ctx);
    assert.equal((await journalFiles(ws, 'beta')).length, memoryOff ? 0 : 1, memoryOff ? '기억 안 남김: 일지 없음' : '기억 남김: 일지 있음');
  }
});

test('기억 안 남김 방의 결재 후속 턴은 journal.off로 돈다(범위의 memoryOff) — 다른 결재는 종전대로', async () => {
  const ws = await setup('claude');
  for (const [scope, off] of [[{ kind: 'link', work: 'w', room: 'r', owner: true, memoryOff: true }, true], [{ kind: 'link', work: 'w', room: 'r', owner: true }, false], [null, false]]) {
    let opts;
    await _followUpForTest(ws, { id: 'ap-f', slug: 'alpha', kind: 'action', action: '발송', ...(scope ? { scope } : {}) }, true, { runChat: async (w, s, m, sid, o) => { opts = o; return { reply: 'ok' }; } });
    assert.equal(opts.journal?.off === true, off, JSON.stringify(scope));
  }
});

test('승인된 고위험 셸 명령은 그 일에서만 한 번 — 같은 주인의 다른 v2 일은 다시 결재(b)', async () => {
  runner = 'claude'; process.env.ARGO_NATIVE_RUNNERS = 'off';
  const cmd = { command: 'rm -rf ~/Documents/y' };
  const ws = await setup('claude');
  const A = linkCtx(true); A.scope.work = 'w-A';
  const B = linkCtx(true); B.scope.work = 'w-B';
  let seen; vendorTurn = async (options) => { seen = options; return 'fixture finished'; };
  await chat(ws, 'alpha', 'hi', null, { mirrorCtx: A, source: 'messenger', journal: { off: true } });
  assert.equal((await seen.canUseTool('Bash', cmd, { toolUseID: 'a-1' })).behavior, 'deny');
  const ap = (await loadApprovals(ws)).find((a) => a.payload?.shell && a.scope?.work === 'w-A');
  await resolveApproval(ws, ap.id, true);
  await chat(ws, 'alpha', 'hi', null, { mirrorCtx: B, source: 'messenger', journal: { off: true } });
  assert.equal((await seen.canUseTool('Bash', cmd, { toolUseID: 'b-1' })).behavior, 'deny', '다른 일은 A의 승인을 쓰지 못한다');
  assert.ok((await loadApprovals(ws)).some((a) => a.payload?.shell && a.scope?.work === 'w-B' && a.status === 'pending'), 'B는 자기 결재를 올린다');
  await chat(ws, 'alpha', 'go', null, { mirrorCtx: A, source: 'messenger', journal: { off: true } });
  assert.equal((await seen.canUseTool('Bash', cmd, { toolUseID: 'a-2' })).behavior, 'allow', 'A는 자기 승인으로 한 번');
});
