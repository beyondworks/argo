// 에이전트 '한 사람'(유건 결정 2026-10-08 ①·③) — 주인 혼자인 메신저 1:1에서 주인이 직접 보낸 턴은 데스크톱 대화와 같은 대화다.
// 실제 chat()과 게이트웨이 처리기(makeMsgrHandler)를 가짜 러너(외부 CLI 실행·SDK query)와 가짜 메신저 db로 돌린다. 실 Supabase·실 모델·네트워크 0.
// 가짜 러너는 받은 글에서 마지막으로 'N 기억해'라고 한 숫자를 찾아 '방금 숫자?'에 답한다 — 맥락이 실제로 넘어갔는지를 답으로 본다.
// 고정하는 것: ① 데스크톱 ↔ 주인 혼자 1:1 양방향(개인 공간·조직, CLI·SDK), 일지, 세션 미사용
//              ② 남의 글이 주인 맥락에 들어가지 않음(손님 낀 방·나간 손님 글·친구 방·그룹·채널·넘김·오피스·기억 안 남김)
//              ③ 주인 데스크톱 대화가 남 낀 방 답에 새지 않음 ④ 두 사본 병합 ⑤ 호칭 규칙이 공간별 이름 지시보다 우선(ko·en)
//              ⑥ 데스크톱 세션이 본 1:1 줄(세션과 짝 — 위치로 판정하지 않는다, 검수 HIGH) ⑦ 조직 1:1 일지·요약 회수(검수 MEDIUM) ⑧ 방 대화 겹침·순서(검수 LOW)
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
const { appendTurn, loadThread, setThreadSummary, noteSoloSeen, isOwnerSoloScope } = await import('../src/thread.mjs');
const { chat } = await import('../src/chat.mjs');
const M = await import('../src/gateway/msgr.mjs');
const { mergeThread } = await import('../src/sync.mjs');
const { relocateOrgJournals } = await import('../src/memory.mjs');
const { recallDeparted } = await import('../src/gateway/msgr-recall.mjs');

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
const CATCH_KO = /그 사이 메신저 1:1에서 나눈 대화/;
const tick = () => new Promise((r) => setTimeout(r, 5));
const chatFile = (ws) => join(paths(ws).chats, 'seoyun.json');
const mergeInto = async (a, b) => writeFile(chatFile(a), mergeThread(await readFile(chatFile(a)), await readFile(chatFile(b)))); // b(다른 사본)를 a로 동기화 병합
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
    if (r0 === 'claude') {
      assert.equal(seen[seen.length - 1].resume, 'sdk-session-1', '세션은 그대로 이어 쓴다(긴 도구 작업 세부를 잃지 않는다)');
      assert.match(lastPrompt(), CATCH_KO, '세션이 못 본 1:1 줄만 이번 글 앞에 건넨다');
    }
  });
}

test('[claude] 세션이 1:1 줄을 받은 뒤에는 다시 건네지 않고 그대로 이어 쓴다 — 건넨 줄은 세션과 짝으로 남는다', async () => {
  runner = 'claude'; const ws = await company();
  const a = await desk(ws, '0 기억해');
  await say(ws, room({ pair: `crew:${CREW}` }), '3 기억해');
  const b = await desk(ws, '방금 숫자?', a.sessionId);
  assert.equal(b.reply, '3');
  assert.equal(seen.at(-1).resume, 'sdk-session-1');
  const t = await loadThread(ws, 'seoyun');
  assert.equal(t.soloSeen?.session, 'sdk-session-1');
  assert.equal(t.soloSeen.keys.length, 2, '건넨 1:1 줄 — 지시와 답');
  await desk(ws, '다른 이야기', b.sessionId);
  assert.equal(seen.at(-1).resume, 'sdk-session-1', '그 뒤로도 이어 쓴다');
  assert.doesNotMatch(lastPrompt(), /3 기억해|그 사이 메신저/, '이미 받은 줄은 다시 건네지 않는다');
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

// ── 5. 데스크톱 세션이 본 1:1 줄(검수 HIGH 2026-10-08) — '마지막 데스크톱 답 뒤'라는 위치가 아니라 세션과 짝으로 남긴 "건넨 줄"로 판정한다 ──
for (const r0 of ['claude', 'codex']) {
  test(`[${r0}] 두 사본 — 1:1이 앱의 데스크톱 턴보다 먼저 끝났지만 늦게 병합돼도 다음 데스크톱 턴이 1:1을 안다(검수 R1)`, async () => {
    runner = r0;
    const a = await company(); const b = await company(); // a = 앱(데스크톱), b = 상주(메신저 턴)
    const s1 = await desk(a, '0 기억해'); await tick();
    await say(b, room({ pair: `crew:${CREW}` }), '6 기억해 FROM_SOLO'); await tick(); // 상주에서 1:1(시각이 앱의 다음 데스크톱 답보다 앞)
    const s2 = await desk(a, '다른 이야기', s1.sessionId); // 앱은 아직 1:1 줄을 못 받았다
    await mergeInto(a, b);
    const r = await desk(a, '방금 숫자?', s2.sessionId);
    assert.equal(r.reply, '6');
    if (r0 === 'claude') assert.equal(seen.at(-1).resume, 'sdk-session-1', '세션은 이어 쓰고 못 본 줄만 건넨다');
  });
}
test('[claude] 데스크톱 턴이 도는 동안 1:1 턴이 끝나도(턴 끝에 기록하는 경로) 다음 데스크톱 턴이 1:1을 안다(검수 R2)', async () => {
  runner = 'claude'; const ws = await company();
  const s1 = await desk(ws, '0 기억해');
  let release; const gate = new Promise((r) => { release = r; });
  // 텔레그램 1:1(gateway.mjs)처럼 턴이 끝난 뒤에야 지시·답 두 줄을 붙이는 경로 — 그 사이 1:1 줄이 앞에 놓인다
  const deskP = (async () => { const r = await chat(ws, 'seoyun', '긴 작업', s1.sessionId, {}); await gate; await appendTurn(ws, 'seoyun', { userMsg: '긴 작업', reply: r.reply, sessionId: r.sessionId }); return r; })();
  await tick();
  await say(ws, room({ pair: `crew:${CREW}` }), '6 기억해 FROM_SOLO');
  release(); const s2 = await deskP;
  const r = await desk(ws, '방금 숫자?', s2.sessionId);
  assert.equal(r.reply, '6');
  assert.equal(seen.at(-1).resume, 'sdk-session-1');
});
for (const via of ['routine', 'delegate', 'crewmail']) {
  test(`[claude] 1:1 뒤 세션과 무관한 자동 턴(${via}) 줄이 끼어도 다음 데스크톱 턴이 1:1을 안다(검수 R3)`, async () => {
    runner = 'claude'; const ws = await company();
    const s1 = await desk(ws, '0 기억해');
    await say(ws, room({ pair: `crew:${CREW}` }), '6 기억해 FROM_SOLO');
    await appendTurn(ws, 'seoyun', { userMsg: `[${via}] 아침 메일 확인`, reply: '새 메일 없음', handover: null, sessionId: null, via }); // routines.mjs·chat.mjs 위임·scheduler.mjs 쪽지와 같은 모양(범위 없음, 세션 없음)
    const r = await desk(ws, '방금 숫자?', s1.sessionId);
    assert.equal(r.reply, '6');
    assert.equal(seen.at(-1).resume, 'sdk-session-1');
  });
}
test('[claude] 못 본 1:1 줄이 맥락 예산(CTX_BUDGET_TOKENS)을 넘으면 세션을 잇지 않고 새 세션 + 최근 대화로 연다', async () => {
  runner = 'claude'; const ws = await company();
  const a = await desk(ws, '0 기억해');
  const long = '가'.repeat(480);
  for (let i = 0; i < 26; i++) await appendTurn(ws, 'seoyun', { userMsg: long, reply: long, contextScope: { kind: 'msgr-dm', channelId: PCH, threadRoot: i, ownerSolo: true, msgId: 100 + i }, via: 'msgr', actor: { uid: OWNER, name: '유건', relay: false } });
  await say(ws, room({ pair: `crew:${CREW}` }), '7 기억해');
  const r = await desk(ws, '방금 숫자?', a.sessionId);
  assert.equal(r.reply, '7');
  assert.equal(seen.at(-1).resume, null, '이어 쓰지 않는다');
  assert.match(lastPrompt(), /데스크톱과 메신저 1:1은 한 대화다/);
  assert.doesNotMatch(lastPrompt(), CATCH_KO);
});

// ── 6. 병합 — 세션이 본 1:1 기록은 세션 id와 짝 ──
test('병합 — 세션이 본 1:1 기록은 고른 세션 id와 짝만 남고, 양쪽이 같은 세션이면 합친다', () => {
  const m = (L, R) => JSON.parse(mergeThread(Buffer.from(JSON.stringify({ messages: [], ...L })), Buffer.from(JSON.stringify({ messages: [], ...R }))).toString());
  assert.deepEqual(m({ sessionId: 'S', soloSeen: { session: 'S', keys: ['a'] } }, { sessionId: 'S', soloSeen: { session: 'S', keys: ['b'] } }).soloSeen, { session: 'S', keys: ['b', 'a'] });
  assert.deepEqual(m({ sessionId: 'S', soloSeen: { session: 'S', keys: ['a'] } }, { sessionId: 'T', soloSeen: { session: 'T', keys: ['c'] } }).soloSeen, { session: 'T', keys: ['c'] }, '고른 세션(T)의 기록만');
  assert.equal(m({ sessionId: 'S', soloSeen: { session: 'S', keys: ['a'] } }, { sessionId: 'T' }).soloSeen, undefined, '고른 세션의 기록이 없으면 남기지 않는다 — 다른 세션이 본 줄을 이 세션이 본 것으로 읽지 않게');
  assert.deepEqual(m({ sessionId: 'S', soloSeen: { session: 'S', keys: ['a'] } }, { sessionId: null }).soloSeen, { session: 'S', keys: ['a'] }, '세션을 가진 쪽의 기록');
});

// ── 7. 조직 1:1 기록 회수(검수 MEDIUM) — 조직 기록은 조직 단위로 거둔다 ──
test('일지 — 개인 공간 1:1은 데스크톱 일지, 조직 1:1은 그 방 태그 파일. 화면 칩은 볼트 상대 경로(조직 태그 일지는 칩 없음), 절대 경로를 스레드에 남기지 않는다', async () => {
  runner = 'codex'; const ws = await company();
  await say(ws, room({ pair: `crew:${CREW}` }), 'PERSONAL_NOTE');
  await say(ws, room({ orgId: ORG, channelId: OCH }), 'ORG_NOTE');
  const names = await readdir(paths(ws).journal);
  const day = names.find((n) => /^\d{4}-\d{2}-\d{2}-seoyun\.md$/.test(n));
  const tagged = names.find((n) => n.includes(`.org-${ORG}-ch-${OCH}`));
  assert.ok(day && tagged, names.join(','));
  const read = (n) => readFile(join(paths(ws).journal, n), 'utf8');
  assert.match(await read(day), /PERSONAL_NOTE/);
  assert.doesNotMatch(await read(day), /ORG_NOTE/, '조직 1:1은 태그 없는 일지(기억 정리·회상에 섞이는 파일)에 쓰지 않는다');
  assert.match(await read(tagged), /ORG_NOTE/);
  const t = await loadThread(ws, 'seoyun');
  const crewIn = (ch) => t.messages.find((m) => m.who === 'crew' && m.contextScope?.channelId === ch);
  assert.deepEqual(crewIn(PCH).handover, { rel: `journal/${day}`, linked: [] }, '데스크톱 라우트와 같은 모양 — 화면 칩이 rel로 연다');
  assert.equal(crewIn(OCH).handover, null);
  assert.ok(!JSON.stringify(t).includes(paths(ws).vault), '로컬 절대 경로(OS 사용자 이름 포함)가 동기화되는 스레드 파일에 없다');
});
test('조직에서 빠지면 — 조직 1:1 줄·그 줄을 덮은 데스크톱 요약·조직 태그 일지가 회수되고, 개인 공간 1:1·데스크톱 대화는 남는다', async () => {
  runner = 'codex'; const ws = await company();
  await desk(ws, 'DESK_KEEP');
  await say(ws, room({ pair: `crew:${CREW}` }), 'PERSONAL_KEEP');
  await say(ws, room({ orgId: ORG, channelId: OCH }), 'ORG_SECRET');
  await desk(ws, 'DESK_AFTER');
  const t0 = await loadThread(ws, 'seoyun');
  assert.ok(await setThreadSummary(ws, 'seoyun', null, { text: 'SUMMARY_HAS_ORG_SECRET', upto: t0.messages.at(-1).ts }));
  await relocateOrgJournals(ws); // 게이트웨이 정리 틱과 같은 자리 — 조직 태그 일지는 .msgr-journal로
  const r = await recallDeparted(ws, ['seoyun'], async (pairs) => new Map(pairs.map((p) => [`${p.slug}:${p.id}`, p.id !== OCH])), { configDirs: [] });
  assert.equal(r.channels, 1); assert.equal(r.journals, 1);
  const t = await loadThread(ws, 'seoyun');
  const text = JSON.stringify(t);
  assert.doesNotMatch(text, /ORG_SECRET/, '조직 1:1 줄과 그 줄을 덮은 요약이 없다');
  for (const k of ['DESK_KEEP', 'PERSONAL_KEEP', 'DESK_AFTER']) assert.match(text, new RegExp(k));
  assert.equal(t.summary, undefined);
  assert.deepEqual((await readdir(join(paths(ws).root, '.msgr-journal')).catch(() => [])), [], '조직 태그 일지 파일째 회수');
  assert.match(await journalText(ws), /PERSONAL_KEEP/, '개인 공간 1:1 일지는 남는다');
});
test('이전 버전이 만든 범위 없는 요약(1:1 줄 모름)은 그 기준점 앞에 1:1 줄이 있으면 쓰지 않는다 — 1:1 줄이 맥락에서 빠지지 않게(검수 LOW d)', async () => {
  runner = 'codex'; const ws = await company();
  await say(ws, room({ pair: `crew:${CREW}` }), '6 기억해 SOLO_BEFORE_ANCHOR');
  await desk(ws, '다른 이야기');
  const t = JSON.parse(await readFile(chatFile(ws), 'utf8'));
  t.summary = { text: 'OLD_VERSION_SUMMARY', upto: t.messages.at(-1).ts, at: Date.now() }; // 이전 버전 — withSolo 없음
  await writeFile(chatFile(ws), JSON.stringify(t));
  await desk(ws, '방금 숫자?');
  assert.match(lastPrompt(), /SOLO_BEFORE_ANCHOR/);
  assert.doesNotMatch(lastPrompt(), /OLD_VERSION_SUMMARY/);
  await setThreadSummary(ws, 'seoyun', null, { text: 'NEW_VERSION_SUMMARY', upto: (await loadThread(ws, 'seoyun')).messages.at(-1).ts });
  await desk(ws, '방금 숫자?');
  assert.match(lastPrompt(), /NEW_VERSION_SUMMARY/, '이번 버전 요약(1:1 줄까지 접음)은 그대로 쓴다');
});

// ── 8. 방 대화 겹침·순서(검수 LOW c) — 이 방의 지난 대화는 스레드(데스크톱과 시간순 한 줄기)로, 봉투는 이 기기 스레드에 없는 턴만 ──
test('주인 혼자 1:1 — 데스크톱에서 나중에 한 말이 마지막으로 읽히고, 같은 1:1 줄이 두 번 들어가지 않는다', async () => {
  runner = 'codex'; const ws = await company();
  await desk(ws, '1 기억해');
  await say(ws, room({ pair: `crew:${CREW}` }), '2 기억해');
  const m2 = msgSeq;
  await desk(ws, '3 기억해');
  const rows = [{ id: m2, author_kind: 'user', author_user_id: OWNER, crew_id: null, body: '2 기억해', meta: {} },
    { id: m2 + 900, author_kind: 'crew', author_user_id: null, crew_id: CREW, body: '기억했어요', client_msg_id: `reply:${CREW}:${m2}`, reply_to: m2, meta: {} }];
  assert.equal(await say(ws, room({ pair: `crew:${CREW}`, context: rows }), '방금 숫자?'), '3');
  assert.equal(lastPrompt().match(/2 기억해/g)?.length, 1);
});
test('주인 혼자 1:1 — 다른 기기가 처리해 이 기기 스레드에 아직 없는 방 대화는 봉투로 받는다(두 사본)', async () => {
  runner = 'codex'; const ws = await company();
  const rows = [{ id: 4242, author_kind: 'user', author_user_id: OWNER, crew_id: null, body: '5 기억해', meta: {} },
    { id: 4243, author_kind: 'crew', author_user_id: null, crew_id: CREW, body: '기억했어요', client_msg_id: `reply:${CREW}:4242`, reply_to: 4242, meta: {} }];
  assert.equal(await say(ws, room({ pair: `crew:${CREW}`, context: rows }), '방금 숫자?'), '5');
});
test('msgrRowTurn — 사람 글은 그 글 id, 이 크루 답은 reply 표지의 원본 id, 그 밖(거절·안내)은 null', () => {
  assert.equal(M.msgrRowTurn({ author_kind: 'user', id: 7 }), 7);
  assert.equal(M.msgrRowTurn({ author_kind: 'crew', client_msg_id: `reply:${CREW}:7` }), '7');
  assert.equal(M.msgrRowTurn({ author_kind: 'crew', client_msg_id: `deny:${CREW}:7` }), null);
  assert.equal(M.msgrRowTurn({ author_kind: 'crew' }), null);
});
test('건넨 1:1 기록 쓰기 — 같은 세션이면 더하고(동시에 끝난 턴이 서로 덮지 않게), 다른 세션이면 바꾸고, 스레드에 없는 줄은 남기지 않고, 바뀐 게 없으면 쓰지 않는다', async () => {
  runner = 'codex'; const ws = await company();
  await say(ws, room({ pair: `crew:${CREW}` }), 'A 줄');
  await say(ws, room({ pair: `crew:${CREW}` }), 'B 줄');
  const solo = (m) => isOwnerSoloScope(m.contextScope);
  const keys = (await loadThread(ws, 'seoyun')).messages.filter(solo).map((m) => `${m.ts}|${m.who}|${m.contextScope.channelId}`);
  assert.equal(keys.length, 4);
  assert.equal(await noteSoloSeen(ws, 'seoyun', 'S', [keys[0], keys[1]], solo), true);
  assert.equal(await noteSoloSeen(ws, 'seoyun', 'S', [keys[2], 'gone|user|x'], solo), true);
  assert.deepEqual((await loadThread(ws, 'seoyun')).soloSeen, { session: 'S', keys: [keys[0], keys[1], keys[2]] }, '같은 세션 — 더한다, 스레드에 없는 키는 버린다');
  assert.equal(await noteSoloSeen(ws, 'seoyun', 'S', [keys[1]], solo), false, '바뀐 게 없으면 쓰지 않는다');
  assert.equal(await noteSoloSeen(ws, 'seoyun', 'T', [keys[3]], solo), true);
  assert.deepEqual((await loadThread(ws, 'seoyun')).soloSeen, { session: 'T', keys: [keys[3]] }, '다른 세션 — 그 세션이 본 줄로 바꾼다');
  assert.equal(await noteSoloSeen(ws, 'seoyun', null, keys, solo), false, '세션이 없으면 남기지 않는다');
});
