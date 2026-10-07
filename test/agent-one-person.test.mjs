// 에이전트 '한 사람'(유건 결정 2026-10-08 ①·③) — 주인 혼자인 메신저 1:1에서 주인이 직접 보낸 턴은 데스크톱 대화와 같은 대화다.
// 실제 chat()과 게이트웨이 처리기(makeMsgrHandler)를 가짜 러너(외부 CLI 실행·SDK query)와 가짜 메신저 db로 돌린다. 실 Supabase·실 모델·네트워크 0.
// 가짜 러너는 받은 글에서 마지막으로 'N 기억해'라고 한 숫자를 찾아 '방금 숫자?'에 답한다 — 맥락이 실제로 넘어갔는지를 답으로 본다.
// 고정하는 것: ① 데스크톱 ↔ 주인 혼자 1:1 양방향(개인 공간·조직, CLI·SDK), 일지, 세션 미사용
//              ② 남의 글이 주인 맥락에 들어가지 않음(손님 낀 방·나간 손님 글·친구 방·그룹·채널·넘김·오피스·기억 안 남김)
//              ③ 주인 데스크톱 대화가 남 낀 방 답에 새지 않음 ④ 두 사본 병합 ⑤ 호칭 규칙이 공간별 이름 지시보다 우선(ko·en)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-one-person-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-one-person-'));
process.env.ARGO_CACHE_DIR = join(process.env.ARGO_ROOT, 'cache');
process.env.ARGO_MODEL_CATALOG = process.env.ARGO_NATIVE_RUNNERS = 'off';
process.env.ARGO_ENC_VAULT = '0';
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGO_TENANT_OWNER']) delete process.env[key];
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network disabled in one-person test'); };

// ── 가짜 러너 — 러너 이름은 테스트가 고르고, 받은 글(프롬프트·시스템 글·이어 쓰기 세션)을 모은다 ──
let runner = 'codex';
const seen = []; // { runner, prompt, system, resume }
function answerFor(prompt) {
  if (!/방금 숫자|what number/i.test(prompt)) return '기억했어요';
  const hits = [...String(prompt).matchAll(/(\d+) 기억해/g)];
  return hits.length ? hits[hits.length - 1][1] : '모름';
}
globalThis.__opRunner = () => runner;
globalThis.__opCli = (args) => { seen.push({ runner, prompt: args.prompt, system: args.prompt, resume: null }); return answerFor(args.prompt); };
globalThis.__opSdk = (prompt, options) => { seen.push({ runner, prompt, system: String(options?.systemPrompt ?? ''), resume: options?.resume ?? null }); return answerFor(prompt); };
const wrappers = new Map();
for (const [relative, replacements] of [
  ['./runners.mjs', `export const resolveRunner = async () => ({runner:globalThis.__opRunner(),available:true,fellBack:false});
    export const runnerCredType = async () => 'host'; export const runnerCredEnv = async () => ({});
    export const sdkEnvFor = async () => ({}); export const isBilledRunner = async () => false;
    export const externalExec = async (args) => globalThis.__opCli(args);`],
  ['./connectors.mjs', 'export const connectorBriefing = async () => [];'],
]) {
  const real = new URL(`../src/${relative.slice(2)}`, import.meta.url).href;
  wrappers.set(relative, `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(real)}; ${replacements}`)}`);
}
const sdk = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
wrappers.set('@anthropic-ai/claude-agent-sdk', `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(sdk)};
  export function query(args) { const iterator = (async function* () {
    const first = typeof args.prompt === 'string' ? args.prompt : (await args.prompt.next()).value.message.content;
    const text = typeof first === 'string' ? first : first.map((b) => b.text ?? '').join('');
    const answer = globalThis.__opSdk(text, args.options);
    yield {type:'system',subtype:'init',session_id:'sdk-session-1',mcp_servers:[]};
    yield {type:'assistant',message:{content:[{type:'text',text:answer}]}};
    yield {type:'result',subtype:'success',session_id:'sdk-session-1',result:answer,usage:{input_tokens:1,output_tokens:1},total_cost_usd:0};
  })(); iterator.interrupt = async () => {}; return iterator; }`)}`);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/chat.mjs') && wrappers.has(specifier)) return { url: wrappers.get(specifier), shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hooks.deregister(); globalThis.fetch = fetchBefore; for (const k of ['__opRunner', '__opCli', '__opSdk']) delete globalThis[k]; });

const { createCompany, paths } = await import('../src/workspace.mjs');
const { appendTurn, loadThread } = await import('../src/thread.mjs');
const { chat } = await import('../src/chat.mjs');
const M = await import('../src/gateway/msgr.mjs');
const { mergeThread } = await import('../src/sync.mjs');

const OWNER = '11111111-1111-4111-8111-111111111111';
const GUEST = '22222222-2222-4222-8222-222222222222';
const FRIEND = '33333333-3333-4333-8333-333333333333';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const CREW = 'cccccccc-0000-4000-8000-000000000001';
const OTHER_CREW = 'cccccccc-0000-4000-8000-000000000002';
const PCH = 'dddddddd-0000-4000-8000-000000000001'; // 개인 공간 — 내 에이전트와 1:1(personal_pair crew:)
const OCH = 'dddddddd-0000-4000-8000-000000000002'; // 조직 1:1
const GCH = 'dddddddd-0000-4000-8000-000000000003'; // 조직 채널

let seq = 0;
async function company({ lang = 'ko', card = '' } = {}) {
  const ws = `one-person-${++seq}`;
  await createCompany(ws, '린', '유건', OWNER, lang);
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'seoyun.md'), `---\nname: 서윤\nrole: 비서\n---\n${card || '# 서윤\n\n## 전문성\n- 일정\n\n## 일하는 방식\n- 결론부터 말한다\n\n## 톤\n- 담백하게\n'}`);
  return ws;
}
/** 데스크톱 턴 — 웹 채팅 라우트처럼 chat() 뒤 범위 없는 기록으로 남긴다 */
let mark = 0; // 마지막 desk·say 호출 직전의 seen 길이 — 러너를 부르지 않은 턴(거절 등)이 앞 턴의 글을 대신 보이지 않게
async function desk(ws, text, sessionId = null) {
  mark = seen.length;
  const r = await chat(ws, 'seoyun', text, sessionId, {});
  await appendTurn(ws, 'seoyun', { userMsg: text, reply: r.reply, handover: r.handover, sessionId: r.sessionId });
  return r;
}
/** 가짜 메신저 — 방 구성원(사람·에이전트), 최근 대화 행, 방 종류를 정한다. client는 구성원 조회 1건만 흉내 낸다(읽은 횟수를 센다). */
function room({ orgId = null, channelId = PCH, kind = 'dm', users = [OWNER], crews = [CREW], context = [], crewMemory = true, pair = undefined } = {}) {
  const calls = []; let n = 0; const executions = new Map();
  const members = [...users.map((id) => ({ member_kind: 'user', member_id: id })), ...crews.map((id) => ({ member_kind: 'crew', member_id: id }))];
  const client = { reads: 0, from(table) {
    const q = { select() { return q; }, eq() { return q; }, in() { return q; },
      then(res, rej) { client.reads += 1; return Promise.resolve(table === 'msgr_channel_members' ? { data: members, error: null } : { data: [], error: null }).then(res, rej); } };
    return q;
  } };
  let src = null;
  const db = {
    calls,
    setSource(s) { src = s; },
    async orgEntitled() { return true; },
    async orgConsentOk() { return true; },
    async crewBySlug() { return { id: CREW, org_id: orgId, slug: 'seoyun', display_name: '서윤', allow: 'all', allow_users: [], hosting: 'local' }; },
    async crewContext(_ws, crewId, msgId, chId) {
      const s = { id: msgId, author_kind: src.crewId ? 'crew' : 'user', author_user_id: src.crewId ? null : src.author, crew_id: src.crewId ?? null, body: src.body, reply_to: null, meta: src.meta ?? {} };
      return {
        source: s, root: { id: msgId, author_kind: s.author_kind, author_user_id: s.author_user_id }, delivery_role: 'to', actor: src.crewId ? OWNER : src.author,
        channel: { id: chId, org_id: orgId, kind, name: kind === 'dm' ? 'dm' : 'general', crew_memory: crewMemory, archived_at: null, excluded_crew_ids: [], ...(pair !== undefined ? { personal_pair: pair } : {}) },
        org: orgId ? { id: orgId, slug: 'lean', name: '린' } : null,
        peers: [{ id: crewId, slug: 'seoyun', display_name: '서윤', owner_user_id: OWNER, ws_id: 'x' }, { id: OTHER_CREW, slug: 'mina', display_name: '미나', owner_user_id: OWNER, ws_id: 'x' }],
        settled_predecessors: [], settled_source: false, context, attachments: [],
      };
    },
    async memberName(_org, uid) { return uid === OWNER ? '유건' : uid === GUEST ? '민수' : '지수'; },
    async executionStopInfo() { return null; },
    async insertMessage(row) { calls.push(['insertMessage', row]); n += 1; return { id: 900 + n }; },
    async claimExecution(key) { executions.set(`${key.crewId}:${key.msgId}`, { attempt: key.attempt }); return { acquired: true, state: 'running', heartbeat_at: new Date().toISOString() }; },
    async finishExecution(key, row) { const e = executions.get(`${key.crewId}:${key.msgId}`); if (!e.row) e.row = await db.insertMessage(row); return e.row; },
    async heartbeatExecution() { return true; },
    async crewSeen() { return null; },
  };
  const reply = (msgId) => calls.find((c) => c[0] === 'insertMessage' && c[1].client_msg_id === `reply:${CREW}:${msgId}`)?.[1]?.body ?? null;
  return { db, client, reply, orgId, channelId, kind };
}
let msgSeq = 5000;
/** 메신저 턴 하나 — 처리기가 실제 chat()을 돌리고 답을 방에 올린다. 반환 = 올린 답 본문 */
async function say(ws, r, body, { author = OWNER, hop = 0, crewId = null, meta = {}, uid = OWNER, office = false } = {}) {
  const msgId = ++msgSeq;
  mark = seen.length;
  r.db.setSource({ author, body, crewId, meta });
  const h = M.makeMsgrHandler(ws, { session: async () => ({ db: r.db, uid, client: r.client }), linkPreview: async () => null });
  await h({ msgId, orgId: r.orgId, channelId: r.channelId, crewId: CREW, slug: 'seoyun', text: body, authorId: author, threadRoot: msgId, hop, origin: author, createdAt: new Date().toISOString(), channelKind: r.kind, ...(office ? { office: true } : {}) }); // office = 드레인이 오피스 글에 붙이는 표지(msgr.mjs isOfficeSource)
  return r.reply(msgId);
}
const lastPrompt = () => seen.slice(mark).map((x) => x.prompt).join('\n'); // 마지막 호출이 러너에 보낸 글 전부(없으면 빈 글)
const lastSystem = () => { const s = seen.slice(mark).map((x) => x.system).join('\n'); assert.ok(s, '러너가 불리지 않았다'); return s; };
const journalText = async (ws) => {
  const dir = paths(ws).journal;
  const names = (await readdir(dir).catch(() => [])).filter((n) => /^\d{4}-\d{2}-\d{2}-seoyun/.test(n));
  return (await Promise.all(names.map((n) => readFile(join(dir, n), 'utf8')))).join('\n');
};

// ── 1. 재현 — 본체에서 '1 기억해' → 메신저 개인 방 '방금 숫자?' ──
for (const r0 of ['codex', 'claude']) {
  test(`[${r0}] 개인 공간 주인 1:1 — 데스크톱에서 '1 기억해'라고 한 것을 메신저 1:1이 답한다`, async () => {
    runner = r0; const ws = await company();
    await desk(ws, '1 기억해');
    const r = room({ pair: `crew:${CREW}` });
    assert.equal(await say(ws, r, '방금 숫자?'), '1');
    assert.equal(r.client.reads, 1, '방 구성원 조회는 턴당 1건');
    assert.equal(r.db.calls.filter((c) => c[0] === 'insertMessage').length, 1, '메신저에는 답 1건만 — 데스크톱 대화를 방에 올리지 않는다');
  });
  test(`[${r0}] 조직 주인 1:1 — 메신저에서 '2 기억해' → 데스크톱 '방금 숫자?'가 2`, async () => {
    runner = r0; const ws = await company();
    const first = await desk(ws, '0 기억해');
    const r = room({ orgId: ORG, channelId: OCH });
    assert.equal(await say(ws, r, '2 기억해'), '기억했어요');
    const t = await loadThread(ws, 'seoyun');
    const line = t.messages.find((m) => m.who === 'user' && m.via === 'msgr');
    assert.equal(line.contextScope.kind, 'msgr-dm');
    assert.equal(line.contextScope.channelId, OCH, '기록은 그 방 id를 그대로 지닌다(채널 기억 회수 단위)');
    const again = await desk(ws, '방금 숫자?', first.sessionId);
    assert.equal(again.reply, '2');
    if (r0 === 'claude') assert.equal(seen[seen.length - 1].resume, null, '세션이 모르는 1:1 기록이 있으면 이어 쓰지 않고 새 세션 + 최근 대화');
  });
}

test('[claude] 세션이 1:1 기록을 이미 본 뒤에는 데스크톱 세션을 그대로 이어 쓴다', async () => {
  runner = 'claude'; const ws = await company();
  const a = await desk(ws, '0 기억해');
  await say(ws, room({ pair: `crew:${CREW}` }), '3 기억해');
  const b = await desk(ws, '방금 숫자?', a.sessionId); // 새 세션으로 1:1 기록을 받음
  assert.equal(b.reply, '3');
  await desk(ws, '다른 이야기', b.sessionId);
  assert.equal(seen[seen.length - 1].resume, 'sdk-session-1', '그 뒤로는 종전처럼 이어 쓴다');
});

test('주인 혼자 1:1 턴은 일지를 쓰고(주인 글만), 세션은 남기지 않는다', async () => {
  runner = 'codex'; const ws = await company();
  const before = await desk(ws, '9 기억해');
  const r = room({ orgId: ORG, channelId: OCH, context: [{ id: 1, author_kind: 'user', author_user_id: OWNER, body: '어제 회의 정리', crew_id: null }] });
  await say(ws, r, '내일 일정 알려줘');
  const j = await journalText(ws);
  assert.match(j, /지시: 내일 일정 알려줘/);
  assert.doesNotMatch(j, /팀 메신저 #|어제 회의 정리/, '일지에는 주인이 이번에 쓴 글만(방 머리말·지난 대화 줄은 싣지 않는다)');
  const t = await loadThread(ws, 'seoyun');
  assert.equal(t.sessionId, before.sessionId ?? null, '1:1 턴은 데스크톱 세션을 바꾸지 않는다');
});

// ── 2. 남의 글이 주인 맥락에 들어가지 않음 ──
const leaks = [
  ['조직 1:1에 손님이 들어온 뒤(사람 둘)', () => room({ orgId: ORG, channelId: OCH, users: [OWNER, GUEST] })],
  ['손님이 나갔지만 최근 대화에 손님 글이 남은 방', () => room({ orgId: ORG, channelId: OCH, context: [{ id: 1, author_kind: 'user', author_user_id: GUEST, body: 'LEFT_GUEST_WORDS', crew_id: null }] })],
  ['친구 방(개인 공간 사람 둘)', () => room({ users: [OWNER, FRIEND], pair: `${OWNER}:${FRIEND}` })],
  ['그룹 대화(조직 dm 사람 셋)', () => room({ orgId: ORG, channelId: OCH, users: [OWNER, GUEST, FRIEND] })],
  ['주인 하나 + 에이전트 둘인 방(1:1 아님)', () => room({ orgId: ORG, channelId: OCH, crews: [CREW, OTHER_CREW] })],
  ['조직 채널 멘션', () => room({ orgId: ORG, channelId: GCH, kind: 'public', users: [OWNER, GUEST] })],
  ['기억 안 남김으로 둔 1:1', () => room({ orgId: ORG, channelId: OCH, crewMemory: false })],
];
for (const [name, make] of leaks) {
  test(`남 낀 방 경계 — ${name}: 데스크톱 대화가 답에 새지 않고, 그 방 글도 데스크톱 맥락에 들어가지 않는다`, async () => {
    runner = 'codex'; const ws = await company();
    await desk(ws, '7 기억해 DESK_SECRET');
    const r = make();
    assert.equal(await say(ws, r, '방금 숫자? ROOM_WORDS'), '모름');
    assert.doesNotMatch(lastPrompt(), /DESK_SECRET/);
    await desk(ws, '방금 숫자?');
    assert.doesNotMatch(lastPrompt(), /ROOM_WORDS|LEFT_GUEST_WORDS/);
    assert.doesNotMatch(await journalText(ws), /ROOM_WORDS/);
  });
}
test('남 낀 방 경계 — 손님 턴(1:1에서 주인이 아닌 사람이 시킴)', async () => {
  runner = 'claude'; const ws = await company();
  await desk(ws, '7 기억해 DESK_SECRET');
  const r = room({ orgId: ORG, channelId: OCH, users: [OWNER, GUEST] });
  await say(ws, r, '방금 숫자? GUEST_ASK', { author: GUEST });
  assert.doesNotMatch(lastPrompt(), /DESK_SECRET/);
  await desk(ws, '방금 숫자?');
  assert.doesNotMatch(lastPrompt(), /GUEST_ASK/);
});
test('남 낀 방 경계 — 에이전트끼리 넘긴 턴·오피스에서 맡긴 글은 주인 혼자 방이어도 데스크톱 대화가 아니다', async () => {
  runner = 'codex'; const ws = await company();
  await desk(ws, '7 기억해 DESK_SECRET');
  const r = room({ orgId: ORG, channelId: OCH });
  await say(ws, r, '방금 숫자? HANDED', { crewId: OTHER_CREW, hop: 1 });
  assert.doesNotMatch(lastPrompt(), /DESK_SECRET/, '넘김(hop 1)');
  await say(ws, r, '방금 숫자? OFFICE', { meta: { source: 'office_mail' }, office: true });
  assert.doesNotMatch(lastPrompt(), /DESK_SECRET/, '오피스에서 맡긴 글');
  await desk(ws, '방금 숫자?');
  assert.doesNotMatch(lastPrompt(), /HANDED|OFFICE/);
});
test('남 낀 방 경계 — 손님이 글을 남기고 나간 뒤 그 글을 처리하는 턴(방엔 주인 혼자)', async () => {
  runner = 'claude'; const ws = await company();
  await desk(ws, '7 기억해 DESK_SECRET');
  const r = room({ orgId: ORG, channelId: OCH }); // 구성원은 이미 주인·이 에이전트뿐
  await say(ws, r, '방금 숫자? GUEST_GONE', { author: GUEST });
  assert.doesNotMatch(lastPrompt(), /DESK_SECRET/);
  await desk(ws, '방금 숫자?');
  assert.doesNotMatch(lastPrompt(), /GUEST_GONE/, '손님 글이 주인 1:1 기록으로 표시되지 않는다');
  assert.doesNotMatch(await journalText(ws), /GUEST_GONE/);
});
test('동시성 — 데스크톱 턴과 주인 1:1 턴이 같은 스레드에 동시에 써도 네 줄이 다 남는다(스레드 잠금)', async () => {
  runner = 'codex'; const ws = await company();
  await Promise.all([desk(ws, 'CONCUR_DESK'), say(ws, room({ pair: `crew:${CREW}` }), 'CONCUR_SOLO')]);
  const t = await loadThread(ws, 'seoyun');
  assert.equal(t.messages.filter((m) => m.who === 'user').length, 2);
  assert.equal(t.messages.filter((m) => m.who === 'crew').length, 2);
  assert.ok(t.messages.some((m) => m.text === 'CONCUR_DESK' && !m.contextScope));
  assert.ok(t.messages.some((m) => /CONCUR_SOLO/.test(m.text) && m.contextScope?.ownerSolo === true));
});
test('주인 혼자 1:1의 기록은 다른(남 낀) 방 답에도 새지 않는다', async () => {
  runner = 'codex'; const ws = await company();
  await say(ws, room({ pair: `crew:${CREW}` }), '5 기억해 SOLO_SECRET');
  assert.equal(await say(ws, room({ orgId: ORG, channelId: OCH, users: [OWNER, GUEST] }), '방금 숫자?'), '모름');
  assert.doesNotMatch(lastPrompt(), /SOLO_SECRET/);
});

// ── 3. 두 Argo 프로세스가 다른 사본을 가진 경우 ──
test('두 사본 — 한쪽은 데스크톱, 한쪽은 주인 1:1을 기록해도 동기화 병합 뒤 양쪽 맥락에 다 실린다', async () => {
  runner = 'codex';
  const a = await company(); const b = await company(); // a = 앱(데스크톱), b = 상주(메신저 턴)
  await desk(a, '4 기억해 FROM_DESK');
  await say(b, room({ pair: `crew:${CREW}` }), '6 기억해 FROM_SOLO');
  const file = (ws) => join(paths(ws).chats, 'seoyun.json');
  const merged = mergeThread(await readFile(file(a)), await readFile(file(b)));
  await writeFile(file(a), merged);
  await desk(a, '방금 숫자?');
  assert.match(lastPrompt(), /FROM_DESK/);
  assert.match(lastPrompt(), /FROM_SOLO/, '병합이 1:1 기록의 표지를 지킨다');
});
test('두 사본 — 표지 없이 남은 옛 버전의 1:1 기록은 데스크톱 맥락에 넣지 않는다(보수적)', async () => {
  runner = 'codex'; const ws = await company();
  await appendTurn(ws, 'seoyun', { userMsg: 'OLD_VERSION_DM', reply: '옛 답', contextScope: { kind: 'msgr-dm', channelId: PCH, threadRoot: 1 }, via: 'msgr', actor: { uid: OWNER, name: '유건', relay: false } });
  await desk(ws, '방금 숫자?');
  assert.doesNotMatch(lastPrompt(), /OLD_VERSION_DM/);
});

// ── 4. 호칭 — 사용자가 정한 규칙이 공간별 표시 이름 지시보다 우선 ──
const NAMED_KO = /사용자\(이 에이전트의 주인\)의 이름은/;
const NAMED_EN = /The user's \(your owner's\) name is/;
for (const r0 of ['codex', 'claude']) {
  test(`[${r0}] 호칭 — 카드 '일하는 방식'에 호칭 규칙이 있으면 메신저 표시 이름 지시를 넣지 않는다`, async () => {
    runner = r0;
    const ws = await company({ card: '# 서윤\n\n## 일하는 방식\n- 나를 "대표님"이라고 불러라\n- 결론부터\n' });
    await say(ws, room({ pair: `crew:${CREW}` }), '안녕');
    const sys = lastSystem();
    assert.doesNotMatch(sys, NAMED_KO);
    assert.match(sys, /대표님/);
  });
  test(`[${r0}] 호칭 — 확정 규칙(captain-rules.md)에 호칭 규칙이 있어도 같다`, async () => {
    runner = r0; const ws = await company();
    await mkdir(join(paths(ws).root, 'skills'), { recursive: true });
    await writeFile(join(paths(ws).root, 'skills', 'captain-rules.md'), '# 사용자 규칙\n\n- 사용자를 "형"이라고 부른다 (2026-10-01 채택)\n');
    await say(ws, room({ pair: `crew:${CREW}` }), '안녕');
    assert.doesNotMatch(lastSystem(), NAMED_KO);
  });
  test(`[${r0}] 호칭 — 규칙이 없으면 종전대로 이름 지시가 실린다`, async () => {
    runner = r0; const ws = await company();
    await say(ws, room({ pair: `crew:${CREW}` }), '안녕');
    assert.match(lastSystem(), NAMED_KO);
  });
}
test('[en] 호칭 규칙이 있으면 영어 지시문에도 이름 지시를 넣지 않는다', async () => {
  runner = 'claude';
  const ws = await company({ lang: 'en', card: '# Seoyun\n\n## 일하는 방식\n- Call me "Chief".\n' });
  await say(ws, room({ pair: `crew:${CREW}` }), 'hello');
  assert.doesNotMatch(lastSystem(), NAMED_EN);
});
for (const r0 of ['codex', 'claude']) {
  test(`[en][${r0}] 주인 혼자 1:1 — 영어 회사도 데스크톱 대화가 1:1에 실린다`, async () => {
    runner = r0; const ws = await company({ lang: 'en' });
    await desk(ws, '8 기억해');
    assert.equal(await say(ws, room({ pair: `crew:${CREW}` }), 'what number did I say?'), '8');
    if (r0 === 'claude') assert.match(lastPrompt(), /desktop and your 1:1 messenger chat with the user are one conversation/);
  });
}
