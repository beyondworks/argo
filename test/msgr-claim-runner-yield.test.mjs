// 메신저 실행권 양보 — 러너 없는 프로세스는 실행권을 먼저 잡지 않는다(2026-10-07 운영 사고 뒤).
// 사고: 백업 폴더의 옛 앱(앱 전용 데이터 폴더, .secrets.json 없음)이 같은 계정·같은 회사 메신저 잡을 상주(:3001)보다 먼저
// msgr_execution_claim으로 가져가 143~246ms 만에 'AI 러너가 하나도 연결돼 있지 않습니다'로 실패 답을 올렸고, 상주는 '이미 답함'으로 건너뛰었다.
// 그 실패는 events.jsonl에 남지 않아 방의 '주인이 Argo 활동에서 원인을 확인할 수 있습니다'가 사실이 아니었다.
//
// 두 프로세스 = 같은 서버 상태(가짜 DB 하나)를 나눠 쓰는 두 핸들러. 러너 없는 쪽은 실제 chat()을 쓴다(이 회사엔 러너 자격이 없다).
// 네트워크·실 러너·실 Supabase 0, 임시 ARGO_ROOT·HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp, { mkdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-claim-home-'));
process.env.USERPROFILE = process.env.HOME;
// 이 컴퓨터 Claude 로그인 흔적(임시 HOME) — 감지가 claude를 로그인됨으로 본다. 회사 자격이 없는 회사는 그래도 러너 없음이다(명시 연결 원칙).
// 23번이 host 자격 판정이 감지를 실제로 쓰는지(forPick이 감지를 건너뛰면 결과가 갈린다) 가르는 데 쓴다. 첫 감지 전에 만들어 둔다(감지 10분 캐시).
await mkdir(join(process.env.HOME, '.claude'), { recursive: true });
await writeFile(join(process.env.HOME, '.claude', '.credentials.json'), '{}');
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-claim-'));
process.env.ARGO_ENC_VAULT = '0';
process.env.ARGO_MODEL_CATALOG = 'off';
for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GLM_API_KEY', 'KIMI_API_KEY', 'GEMINI_API_KEY']) delete process.env[k];

const { paths } = await import('../src/workspace.mjs');
const M = await import('../src/gateway/msgr.mjs');
const { DEFER } = await import('../src/gateway/queue.mjs');
const { YIELD_GRACE_MS } = await import('../src/sync.mjs');
const { saveRunnerCred } = await import('../src/runners/creds.mjs');
const C = await import('../src/chat.mjs');
const { classifyRunnerError, FAIL_CODES } = await import('../src/runners/error-class.mjs');
const { RUNNERS } = await import('../src/runners/catalog.mjs');
const { resolveRunner } = await import('../src/runners.mjs');
const { runFailureDigest, digestFailures } = await import('../src/failure-digest.mjs');

const OWNER = '11111111-1111-4111-8111-111111111111', MEMBER = '22222222-2222-4222-8222-222222222222';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001', CH = 'bbbbbbbb-0000-4000-8000-000000000001', CREW = 'cccccccc-0000-4000-8000-000000000001';
const CLAUDE_KEY = 'yield-test-claude-key-not-real'; // 가짜 값 — 연결 여부(.secrets.json에 자격이 있나)만 본다. 벤더 호출 없음

async function seed(ws, { runner = null, cred = false } = {}) {
  const p = paths(ws);
  for (const d of [p.root, join(p.root, 'chats'), join(p.root, 'agents'), p.journal, p.files]) await mkdir(d, { recursive: true });
  await writeFile(p.company, JSON.stringify({ id: ws, name: '린', lang: 'ko', created: '2026-10-08' }));
  await writeFile(join(p.root, 'agents', 'seoyun.md'), `---\nname: 서윤\nrole: 마케터\n${runner ? `runner: ${runner}\n` : ''}---\n`);
  if (cred) await saveRunnerCred(ws, 'claude', 'apikey', CLAUDE_KEY);
  return ws;
}
const events = async (ws) => (await readFile(join(paths(ws).root, 'events.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** 서버(DB) 하나를 여러 프로세스가 나눠 쓴다 — 실행권 표(msgr_executions)·답글 행(client_msg_id unique)만 흉내 낸다.
    호출은 [프로세스, 메서드]로 기록한다(양보 중 DB 호출 0 확인용). */
function server() {
  const executions = new Map(); const messages = []; const calls = [];
  const forProc = (who) => {
    const rec = (k, ...a) => calls.push([who, k, ...a]);
    return {
      async settled(crewId, msgId, channelId) { rec('settled'); assert.ok(channelId); return messages.some((m) => m.client_msg_id === `reply:${crewId}:${msgId}`); },
      async channel(id) { rec('channel'); return { id, org_id: ORG, kind: 'public', name: 'general', crew_memory: true }; },
      async message() { rec('message'); return null; },
      async channelCrewMembers() { rec('channelCrewMembers'); return new Set([CREW]); },
      async orgCrews() { rec('orgCrews'); return [{ id: CREW, slug: 'seoyun', display_name: '서윤', owner_user_id: OWNER }]; },
      async memberName() { rec('memberName'); return '민수'; },
      async contextOf() { rec('contextOf'); return []; },
      async attachmentsOf() { rec('attachmentsOf'); return []; },
      async org() { rec('org'); return { id: ORG, slug: 'lean', name: '린' }; },
      async executionStopInfo() { rec('executionStopInfo'); return null; },
      async insertMessage(row) {
        rec('insertMessage', row);
        if (row.client_msg_id && messages.some((m) => m.client_msg_id === row.client_msg_id)) return null;
        const m = { id: 900 + messages.length, ...row }; messages.push(m); return m;
      },
      async claimExecution(key) {
        rec('claimExecution', key);
        const id = `${key.crewId}:${key.msgId}`; const prev = executions.get(id);
        if (prev) return { acquired: false, state: prev.row ? 'completed' : 'running', reply_id: prev.row?.id, heartbeat_at: new Date().toISOString() };
        executions.set(id, { attempt: key.attempt });
        return { acquired: true, state: 'running', heartbeat_at: new Date().toISOString() };
      },
      async finishExecution(key, row) {
        rec('finishExecution', key);
        const ex = executions.get(`${key.crewId}:${key.msgId}`);
        if (!ex || ex.attempt !== key.attempt) throw new Error('execution owner mismatch');
        if (!ex.row) ex.row = await this.insertMessage(row);
        return ex.row;
      },
      async heartbeatExecution() { return {}; },
    };
  };
  return { executions, messages, calls, forProc, callsOf: (who, k) => calls.filter((c) => c[0] === who && (!k || c[1] === k)) };
}
let nextMsg = 3570;
const jobAt = (t) => ({ msgId: nextMsg++, orgId: ORG, channelId: CH, crewId: CREW, slug: 'seoyun', text: '안녕', authorId: OWNER, threadRoot: null, createdAt: new Date(t).toISOString() });
const replyOf = (srv, job) => srv.messages.filter((m) => m.client_msg_id === `reply:${CREW}:${job.msgId}`);
const okTurn = (body) => async () => ({ reply: body, sessionId: null, artifacts: [] });
const noPreview = async () => null;

test('1. 두 프로세스 — 러너 없는 A가 먼저 집어도 실행권을 잡지 않고(DB 호출 0), 러너 있는 B가 답한다. A는 양보 기한 뒤 이미 답함을 보고 조용히 끝난다', async () => {
  const ws = await seed('yield-one-sided');
  const srv = server();
  let clock = Date.now(); const now = () => clock;
  const job = jobAt(clock);
  let aSessions = 0;
  const A = M.makeMsgrHandler(ws, { session: async () => { aSessions++; return { db: srv.forProc('A'), uid: OWNER }; }, now, linkPreview: noPreview }); // 실제 chat — 이 회사엔 러너가 없다(사고의 옛 앱)
  let bTurns = 0;
  const B = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('B'), uid: OWNER }), now, linkPreview: noPreview, runChat: async () => { bTurns++; return { reply: '상주가 답합니다', sessionId: null, artifacts: [] }; } });
  const jobA = structuredClone(job), jobB = structuredClone(job);

  assert.equal(await A(jobA), DEFER, '러너 없는 A는 실행권을 잡지 않고 미룬다');
  assert.deepEqual(srv.callsOf('A'), [], '양보 중에는 DB를 부르지 않는다');
  assert.equal(aSessions, 0, '기기 세션도 열지 않는다');
  clock += 3_000;
  assert.equal(await A(jobA), DEFER, '기한 안의 다음 집기도 미룬다');
  await B(jobB);
  assert.equal(bTurns, 1, '러너 있는 B가 실행한다');
  clock += YIELD_GRACE_MS;
  assert.notEqual(await A(jobA), DEFER, '기한이 지나면 더 미루지 않는다');
  assert.equal(srv.callsOf('A', 'claimExecution').length, 0, 'B가 이미 답했으니 A는 끝까지 실행권을 잡지 않는다');
  const replies = replyOf(srv, job);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].body, '상주가 답합니다');
  assert.equal(replies[0].meta?.failed, undefined, '실패 답이 아니다');
  assert.equal((await events(ws)).filter((e) => e.type === 'turn' && e.ok === false).length, 0, 'A는 턴을 돌리지 않았다');
});

test('2. 둘 다 러너 있음 — 종전대로 먼저 집은 쪽이 첫 집기에서 선점·실행하고, 다른 쪽은 이미 답함으로 생략한다', async () => {
  const ws = await seed('yield-both-runner', { cred: true });
  const srv = server();
  const job = jobAt(Date.now());
  let turns = 0; const runChat = async () => { turns++; return { reply: '답', sessionId: null, artifacts: [] }; };
  const A = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), runChat, runnerReady: C.turnRunnerAvailable, linkPreview: noPreview });
  const B = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('B'), uid: OWNER }), runChat, runnerReady: C.turnRunnerAvailable, linkPreview: noPreview });
  assert.notEqual(await A(structuredClone(job)), DEFER);
  assert.equal(srv.callsOf('A', 'claimExecution').length, 1, '첫 집기에서 선점');
  assert.notEqual(await B(structuredClone(job)), DEFER);
  assert.equal(turns, 1, '유료 턴은 한 번');
  assert.equal(srv.callsOf('B', 'claimExecution').length, 0, 'B는 이미 답함을 보고 선점하지 않는다');
  assert.equal(replyOf(srv, job).length, 1);
});

test('3. 둘 다 러너 없음 — 기한 동안 아무도 선점하지 않고, 기한 뒤 한 프로세스가 실패 답을 한 번 남기며 그 원인이 활동 기록에 있다', async () => {
  const ws = await seed('yield-none');
  const srv = server();
  let clock = Date.now(); const now = () => clock;
  const job = jobAt(clock);
  const A = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), now, linkPreview: noPreview });
  const B = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('B'), uid: OWNER }), now, linkPreview: noPreview });
  const jobA = structuredClone(job), jobB = structuredClone(job);
  assert.equal(await A(jobA), DEFER);
  assert.equal(await B(jobB), DEFER);
  assert.equal(srv.calls.length, 0, '기한 안에는 두 프로세스 모두 DB 호출 0');
  clock += YIELD_GRACE_MS + 1;
  await A(jobA);
  await B(jobB);
  const replies = replyOf(srv, job);
  assert.equal(replies.length, 1, '실패 답은 한 번');
  assert.equal(replies[0].meta?.failed, true);
  assert.match(replies[0].body, /^에이전트가 지금 답하지 못했습니다\. 주인이 Argo 활동에서 원인을 확인할 수 있습니다\.$/);
  assert.equal(srv.callsOf('B', 'claimExecution').length, 0, '뒤에 온 B는 이미 답함으로 끝난다');
  const fails = (await events(ws)).filter((e) => e.type === 'turn' && e.ok === false);
  assert.equal(fails.length, 1, '방 문구가 가리키는 활동 기록이 있다');
  assert.equal(fails[0].source, 'messenger');
  assert.equal(fails[0].slug, 'seoyun');
  assert.equal(fails[0].failCode, 'no_runner');
  assert.equal(fails[0].failOrigin, 'argo');
  assert.match(fails[0].error, /^AI 러너가 하나도 연결돼 있지 않습니다/);
});

test('4. 러너는 있는데 크루가 고른 러너만 없음 — pickRunner 대체로 가용, 양보 없이 첫 집기에서 선점한다', async () => {
  const fallbackWs = await seed('yield-fallback', { runner: 'codex', cred: true }); // claude만 연결, 크루는 codex 지정
  const noneWs = await seed('yield-none-direct', { runner: 'codex' });
  assert.equal(await C.turnRunnerAvailable(fallbackWs, 'seoyun'), true, '대체 러너가 있으면 가용');
  assert.equal(await C.turnRunnerAvailable(noneWs, 'seoyun'), false, '아무 러너도 없으면 미가용');
  assert.equal(await C.turnRunnerAvailable(fallbackWs, 'no-such-crew'), false, '카드가 없으면 이 프로세스는 그 턴을 돌릴 수 없다 — 카드가 있는 프로세스가 가져가게 양보(검수 LOW-3)');
  // 카드 러너를 본다 — 숨김 러너는 자동 선택에서 빠지지만 카드에 지정한 크루는 그대로 돈다(pickRunner 명시 지정 — gemini가 2026-09-03~06 실제로 숨김이었다).
  // 무선호로 판정하면 그런 크루는 러너가 있는데도 영영 양보한다. 카탈로그 숨김 표지를 이 테스트 동안만 켠다.
  const hiddenWs = await seed('yield-hidden-explicit', { runner: 'gemini' });
  const autoWs = await seed('yield-hidden-auto');
  for (const w of [hiddenWs, autoWs]) await saveRunnerCred(w, 'gemini', 'apikey', 'yield-test-gemini-key-not-real');
  const was = RUNNERS.gemini.hidden;
  RUNNERS.gemini.hidden = true;
  try {
    assert.equal(await C.turnRunnerAvailable(hiddenWs, 'seoyun'), true, '카드가 지정한 숨김 러너가 연결돼 있으면 가용');
    assert.equal(await C.turnRunnerAvailable(autoWs, 'seoyun'), false, '무선호 크루는 숨김 러너를 자동으로 받지 않는다(chat()과 같은 판정)');
  } finally { RUNNERS.gemini.hidden = was; }
  const srv = server();
  let turns = 0;
  const h = M.makeMsgrHandler(fallbackWs, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), runChat: async () => { turns++; return { reply: '대체 러너로 답', sessionId: null, artifacts: [] }; }, runnerReady: C.turnRunnerAvailable, linkPreview: noPreview });
  const job = jobAt(Date.now());
  assert.notEqual(await h(job), DEFER);
  assert.equal(turns, 1);
  assert.equal(srv.callsOf('A', 'claimExecution').length, 1);
});

test('5. 양보 중 이 프로세스에 러너가 연결되면 다음 집기에서 바로 선점한다', async () => {
  const ws = await seed('yield-connect-later');
  const srv = server();
  let ready = false; let turns = 0;
  const h = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), runChat: async () => { turns++; return { reply: '이제 답', sessionId: null, artifacts: [] }; }, runnerReady: async () => ready, linkPreview: noPreview });
  const job = jobAt(Date.now());
  assert.equal(await h(job), DEFER);
  assert.equal(srv.calls.length, 0);
  ready = true;
  assert.notEqual(await h(job), DEFER);
  assert.equal(turns, 1);
  assert.equal(replyOf(srv, job)[0].body, '이제 답');
});

test('6. 인접 핀 — 이 기기에서 돌던 턴이 끊긴 잡(running)은 러너가 없어도 양보 없이 중단 안내로 닫는다(D25)', async () => {
  const ws = await seed('yield-interrupted');
  const srv = server();
  const job = { ...jobAt(Date.now()), msgrExecution: { attempt: 'att-running-1', phase: 'running' } };
  srv.executions.set(`${CREW}:${job.msgId}`, { attempt: 'att-running-1' });
  const h = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), linkPreview: noPreview }); // 실제 chat(러너 없음) — 부르면 안 된다
  assert.notEqual(await h(job), DEFER);
  const r = replyOf(srv, job);
  assert.equal(r.length, 1);
  assert.equal(r[0].meta?.interrupted, true);
  assert.equal((await events(ws)).length, 0, '턴을 다시 돌리지 않는다');
});

test('7. 인접 핀 — 결과 게시 재시도(publishing) 잡은 러너가 없어도 양보 없이 저장된 답을 게시한다(유료 턴 재실행 없음)', async () => {
  const ws = await seed('yield-publishing');
  const srv = server();
  const base = jobAt(Date.now());
  const replyRow = { channel_id: CH, author_kind: 'crew', crew_id: CREW, kind: 'text', reply_to: base.msgId, thread_root: base.msgId, client_msg_id: `reply:${CREW}:${base.msgId}`, body: '저장해 둔 답', mentions: [], meta: { hop: 0 } };
  const job = { ...base, msgrExecution: { attempt: 'att-pub-1', phase: 'publishing', replyRow } };
  srv.executions.set(`${CREW}:${job.msgId}`, { attempt: 'att-pub-1' });
  const h = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), linkPreview: noPreview });
  assert.notEqual(await h(job), DEFER);
  assert.equal(replyOf(srv, job)[0]?.body, '저장해 둔 답');
  assert.equal((await events(ws)).length, 0);
});

test('8. 선점 RPC 전후에 끊긴 잡(claiming)도 아직 실행권을 잡지 않은 잡으로 보고 러너가 없으면 양보한다', async () => {
  const ws = await seed('yield-claiming');
  const srv = server();
  let clock = Date.now(); const now = () => clock;
  const job = { ...jobAt(clock), msgrExecution: { attempt: 'att-claim-1', phase: 'claiming' } };
  const h = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), now, linkPreview: noPreview });
  assert.equal(await h(job), DEFER);
  assert.equal(srv.calls.length, 0);
});

test('9. chat() 러너 확인에서 끝난 턴도 활동 기록(ok:false·failCode)에 남는다 — 대화 기록용 오류 객체는 그대로(화면 종전), 재시도 프레임은 남기지 않는다', async () => {
  const ws = await seed('early-fail-event');
  await assert.rejects(C.chat(ws, 'seoyun', '메신저에서 온 지시', null, { source: 'messenger' }), (e) => {
    assert.match(e.message, /^AI 러너가 하나도 연결돼 있지 않습니다/);
    assert.equal(e.failCode, undefined, '대화 기록·화면 문구는 종전 그대로(실패 코드는 활동 기록에만)');
    return true;
  });
  await assert.rejects(C.chat(ws, 'seoyun', '데스크톱 지시', null, {}), /AI 러너가 하나도/);
  const ev = (await events(ws)).filter((e) => e.type === 'turn');
  assert.equal(ev.length, 2);
  assert.deepEqual(ev.map((e) => e.source), ['messenger', 'deck']);
  for (const e of ev) {
    assert.equal(e.ok, false); assert.equal(e.slug, 'seoyun'); assert.equal(e.failCode, 'no_runner'); assert.equal(e.failOrigin, 'argo');
    assert.equal('runner' in e, false, '러너 필드 없음 — 설정 연결 카드의 마지막 턴 판정(러너별)에 섞이지 않는다');
    assert.ok(e.gist);
    assert.equal(e.preRun, true, '러너를 고르기 전 실패 표지(다이제스트가 러너 오류로 묶지 않는다)');
  }
  assert.equal(ev[1].ownerDirect, true, '러너 확인 갈래는 종전대로 발신자 표지(evFrom)를 싣는다 — 사장 직접 턴');
  // 재시도 프레임(인증 자가치유가 러너를 다 뺀 끝) — 바깥 프레임이 최종 실패를 한 번 기록하므로 여기서는 남기지 않는다
  await assert.rejects(C.chat(ws, 'seoyun', '재시도', null, { __excludeRunners: ['claude'] }), /인증 오류로 이번 턴에서 제외/);
  assert.equal((await events(ws)).filter((e) => e.type === 'turn').length, 2, '재시도 프레임의 조기 실패는 이중 기록하지 않는다');
});

test('10. http 러너 크루의 조기 실패도 활동 기록에 남는다(분류표 기본 코드)', async () => {
  const ws = await seed('early-fail-http', { runner: 'http' });
  await assert.rejects(C.chat(ws, 'seoyun', '외부 연결 크루', null, { source: 'messenger' }), /외부 HTTP 연결/);
  const [e] = (await events(ws)).filter((x) => x.type === 'turn');
  assert.equal(e?.ok, false);
  assert.equal(e.failCode, 'unknown');
});

test('11. 실패 코드 표 — no_runner는 chat.mjs가 아는 표식(flags.noRunner)으로만 붙고 출처는 argo', () => {
  assert.ok(FAIL_CODES.includes('no_runner'));
  assert.deepEqual(classifyRunnerError('아무 문구', { flags: { noRunner: true } }), { code: 'no_runner', origin: 'argo' });
  assert.deepEqual(classifyRunnerError('AI 러너가 하나도 연결돼 있지 않습니다.'), { code: 'unknown', origin: 'probe' }, '문구로는 분류하지 않는다(표식 우선)');
});

test('12. 받음 방송은 러너 판정을 기다리지 않는다 — 판정의 첫 CLI 감지(10분 캐시)가 몇 초 걸려도 "전달됨" 신호는 잡을 받자마자 나간다', async () => {
  const ws = await seed('yield-broadcast-first');
  const srv = server();
  const sent = [];
  M._rtChannelsForTest.set(`${ws}:${ORG}`, { send: (m) => { sent.push(m); return Promise.resolve(); } });
  let release; const slowCheck = new Promise((r) => { release = r; });
  const h = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), runChat: okTurn('답'), runnerReady: async () => { await slowCheck; return true; }, linkPreview: noPreview });
  const job = { ...jobAt(Date.now()), channelKind: 'public' };
  try {
    const pending = h(job);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.filter((m) => m.payload?.phase === 'received').length, 1, '러너 판정이 끝나기 전에 받음 방송이 나갔다');
    assert.equal(srv.calls.length, 0, '판정 전에는 DB를 부르지 않는다');
    release();
    assert.notEqual(await pending, DEFER);
    assert.equal(replyOf(srv, job)[0]?.body, '답');
  } finally { M._rtChannelsForTest.delete(`${ws}:${ORG}`); }
});

// ── drain 단계 양보(검수 2차 HIGH·MEDIUM) ──────────────────────────────────────────────
// 서버 커서(msgr_crews.cursor_msg_id)는 같은 계정·회사의 모든 프로세스가 나눠 쓴다. 러너 없는 프로세스가 drain에서 적재와 함께 커서를 넘기면
// 러너 있는 프로세스는 그 글을 영영 보지 못해 핸들러의 양보가 넘겨받을 상대 없이 기한 뒤 실패 답으로 끝났다(검수 실험 R1·R2).
// 아래 가짜 서버는 커서·받은 글까지 나눠 쓴다. 두 프로세스는 데이터 폴더가 다르다(사고의 앱 전용 폴더 — 회사 폴더 이름으로 가른다).

/** server()에 drain이 쓰는 조회와 공유 커서를 더한다. setCursor는 서버처럼 단조. */
function inboxServer(msgs) {
  const srv = server();
  srv.cursor = 10; srv.msgs = msgs;
  const base = srv.forProc;
  srv.forProc = (who) => {
    const rec = (k, ...a) => srv.calls.push([who, k, ...a]);
    return Object.assign(base(who), {
      async myCrews() { rec('myCrews'); return [{ id: CREW, org_id: ORG, slug: 'seoyun', display_name: '서윤', allow: 'all', allow_users: [], cursor_msg_id: srv.cursor, hosting: 'local' }]; },
      async crewChannels() { return []; },
      async crewScope() { return new Set([CH]); },
      async crewInbox(_ws, _crew, after) { rec('crewInbox', after); return srv.msgs.filter((m) => m.id > after); },
      async instructCheck() { rec('instructCheck'); return 'ok'; },
      async orgEntitled() { return true; },
      async orgConsentOk() { return true; },
      async setCursor(_id, n) { rec('setCursor', n); if (n > srv.cursor) srv.cursor = n; },
    });
  };
  return srv;
}
const inboxMsg = (id, created, { mention = true } = {}) => ({ id, channel_id: CH, author_kind: 'user', author_user_id: OWNER, crew_id: null, kind: 'text', body: `m${id}`,
  mentions: mention ? [{ kind: 'crew', id: CREW }] : [], reply_to: null, thread_root: null, created_at: new Date(created).toISOString(), meta: {} });
const collector = () => { const jobs = []; const fn = async (_ws, _k, _name, job) => { jobs.push(job); }; fn.jobs = jobs; return fn; };
const drainAs = (ws, srv, who, enqueue, now, runnerReady = C.turnRunnerAvailable) => M.drain(ws, { db: srv.forProc(who), uid: OWNER, enqueue, housekeeping: false, now, runnerReady });
const rpcKinds = (srv, who) => srv.callsOf(who).map((c) => c[1]).filter((k) => k !== 'myCrews' && k !== 'crewInbox');

test('13. 서버 커서 공유(검수 R1) — 러너 없는 A가 먼저 drain해도 그 글을 적재하지도 커서를 넘기지도 않는다. 러너 있는 B가 적재·답하고, A는 기한이 지나도 그 글을 보지 않는다', async () => {
  const wsA = await seed('cursor-a-norunner'); // 사고의 옛 앱 — 러너 자격 없음
  const wsB = await seed('cursor-b-runner', { cred: true }); // 상주 — 러너 있음
  let clock = Date.now(); const now = () => clock;
  const srv = inboxServer([inboxMsg(11, clock)]);
  const enqA = collector(), enqB = collector();
  await drainAs(wsA, srv, 'A', enqA, now);
  assert.equal(enqA.jobs.length, 0, '러너 없는 A는 적재하지 않는다');
  assert.equal(srv.cursor, 10, 'A는 서버 커서를 넘기지 않는다 — 넘기면 B가 그 글을 영영 못 본다');
  assert.deepEqual(rpcKinds(srv, 'A'), [], '보류한 글은 글별 조회·커서 쓰기 0(DB 호출을 늘리지 않는다)');
  await drainAs(wsB, srv, 'B', enqB, now);
  assert.deepEqual(enqB.jobs.map((j) => j.msgId), [11], '러너 있는 B가 적재한다');
  assert.equal(srv.cursor, 11);
  clock += YIELD_GRACE_MS + 1;
  await drainAs(wsA, srv, 'A', enqA, now);
  assert.equal(enqA.jobs.length, 0, '기한이 지나도 A는 B가 넘긴 커서 뒤라 그 글을 보지 않는다');
  const B = M.makeMsgrHandler(wsB, { session: async () => ({ db: srv.forProc('B'), uid: OWNER }), now, linkPreview: noPreview, runChat: okTurn('상주가 답합니다'), runnerReady: async () => true });
  await B(enqB.jobs[0]);
  const r = srv.messages.filter((m) => m.client_msg_id === `reply:${CREW}:11`);
  assert.equal(r.length, 1);
  assert.match(r[0].body, /상주가 답합니다$/); // 시계를 기한 넘게 돌려 '부재중 대기분' 머리가 붙는다(종전 동작)
  assert.equal(r[0].meta?.failed, undefined, '실패 답이 아니다');
  assert.equal(srv.callsOf('A', 'claimExecution').length, 0);
});

test('14. 같은 커서에서 B가 먼저 drain하면 종전대로 B가 적재·전진하고 A는 그 글을 보지 않는다(인접 핀)', async () => {
  const wsA = await seed('cursor-a2-norunner');
  const wsB = await seed('cursor-b2-runner', { cred: true });
  const clock = Date.now(); const now = () => clock;
  const srv = inboxServer([inboxMsg(11, clock)]);
  const enqA = collector(), enqB = collector();
  await drainAs(wsB, srv, 'B', enqB, now);
  await drainAs(wsA, srv, 'A', enqA, now);
  assert.deepEqual(enqB.jobs.map((j) => j.msgId), [11]);
  assert.equal(enqA.jobs.length, 0);
  assert.equal(srv.cursor, 11);
});

test('15. 러너 있는 B가 같은 크루의 긴 턴 중(검수 R2) — A가 먼저 drain해도 B가 적재·전진해 두고, 앞 턴이 160초를 넘겨도 A는 실패 답을 올리지 않는다. B가 앞 턴 뒤에 답한다', async () => {
  const wsA = await seed('busy-a-norunner');
  const wsB = await seed('busy-b-runner', { cred: true });
  let clock = Date.now(); const now = () => clock;
  const srv = inboxServer([inboxMsg(20, clock)]);
  const enqA = collector(), enqB = collector();
  let release; const longTurn = new Promise((r) => { release = r; });
  let bTurns = 0;
  const B = M.makeMsgrHandler(wsB, { session: async () => ({ db: srv.forProc('B'), uid: OWNER }), now, linkPreview: noPreview, runnerReady: async () => true,
    runChat: async () => { bTurns++; if (bTurns === 1) await longTurn; return { reply: `B 답 ${bTurns}`, sessionId: null, artifacts: [] }; } });
  const A = M.makeMsgrHandler(wsA, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), now, linkPreview: noPreview }); // 실제 chat — 러너 없음
  await drainAs(wsB, srv, 'B', enqB, now);
  const first = B(enqB.jobs[0]); // 긴 턴 시작
  await new Promise((r) => setTimeout(r, 30));
  srv.msgs.push(inboxMsg(21, clock + 1000)); // 앞 턴 중에 온 후속 지시
  await drainAs(wsA, srv, 'A', enqA, now); // 한가한 A가 먼저 drain
  await drainAs(wsB, srv, 'B', enqB, now);
  const j21 = enqB.jobs.find((j) => j.msgId === 21);
  assert.ok(j21, 'B의 drain은 앞 턴과 무관하게 21을 적재한다');
  assert.equal(await B(j21), DEFER, 'B는 같은 크루가 바빠 선점 전에 미룬다');
  clock += YIELD_GRACE_MS + 2000; // 앞 턴이 160초를 넘김
  await drainAs(wsA, srv, 'A', enqA, now);
  for (const j of enqA.jobs) await A(j); // 옛 코드에선 A가 21을 적재해 두었다가 여기서 실패 답을 올렸다
  release(); await first;
  await B(j21);
  const r = srv.messages.filter((m) => m.client_msg_id === `reply:${CREW}:21`);
  assert.equal(r.length, 1);
  assert.equal(r[0].meta?.failed, undefined, '러너 있는 B가 있는데 A의 실패 답이 올라가지 않는다');
  assert.match(r[0].body, /B 답 2$/); // 앞 턴이 160초를 넘겨 '부재중 대기분' 머리가 붙는다(종전 동작)
  assert.equal(srv.callsOf('A', 'claimExecution').length, 0);
});

test('16. 어느 프로세스에도 러너가 없으면 글 나이 160초까지 아무도 적재하지 않고, 그 뒤 적재한 잡은 다시 양보하지 않고 실패 답 한 번 + 활동 기록', async () => {
  const ws = await seed('nobody-runner');
  let clock = Date.now(); const now = () => clock;
  const born = clock;
  const srv = inboxServer([inboxMsg(11, born)]);
  const enq = collector();
  await drainAs(ws, srv, 'A', enq, now);
  clock = born + YIELD_GRACE_MS - 1000;
  await drainAs(ws, srv, 'A', enq, now);
  assert.equal(enq.jobs.length, 0, '기한 안에는 적재하지 않는다');
  assert.equal(srv.cursor, 10);
  clock = born + YIELD_GRACE_MS + 1;
  await drainAs(ws, srv, 'A', enq, now);
  assert.deepEqual(enq.jobs.map((j) => j.msgId), [11], '기한이 지나면 종전대로 적재한다(무응답보다 실패 안내)');
  assert.equal(srv.cursor, 11);
  const A = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), now, linkPreview: noPreview });
  assert.notEqual(await A(enq.jobs[0]), DEFER, 'drain에서 이미 기다렸다 — 핸들러가 160초를 더 기다리지 않는다(기한은 글 나이)');
  const r = srv.messages.filter((m) => m.client_msg_id === `reply:${CREW}:11`);
  assert.equal(r.length, 1);
  assert.equal(r[0].meta?.failed, true);
  const fails = (await events(ws)).filter((e) => e.type === 'turn' && e.ok === false);
  assert.equal(fails.length, 1);
  assert.equal(fails[0].failCode, 'no_runner');
});

test('17. 대상 아닌 글은 보류하지 않는다 — 잡담은 처리·전진(러너 판정도 안 함), 잡담 뒤 대상 글부터 보류. 그 사이 러너가 연결되면 다음 drain에서 바로 적재', async () => {
  const ws = await seed('chatter');
  const clock = Date.now(); const now = () => clock;
  let checks = 0; let ready = false;
  const runnerReady = async () => { checks++; return ready; };
  const srv = inboxServer([inboxMsg(11, clock, { mention: false })]);
  const enq = collector();
  await drainAs(ws, srv, 'A', enq, now, runnerReady);
  assert.equal(srv.cursor, 11, '대상 아닌 글은 종전대로 지나간다(커서를 붙잡지 않는다)');
  assert.equal(checks, 0, '대상 후보가 없으면 러너 판정도 하지 않는다');
  srv.msgs.push(inboxMsg(12, clock, { mention: false }), inboxMsg(13, clock), inboxMsg(14, clock, { mention: false }));
  await drainAs(ws, srv, 'A', enq, now, runnerReady);
  assert.equal(srv.cursor, 12, '잡담(12)까지 전진하고 대상 글(13)부터 보류');
  assert.equal(enq.jobs.length, 0);
  assert.equal(checks, 1, '크루당 한 번만 판정');
  ready = true;
  await drainAs(ws, srv, 'A', enq, now, runnerReady);
  assert.deepEqual(enq.jobs.map((j) => j.msgId), [13], '러너가 생기면 다음 drain에서 바로 적재');
  assert.equal(srv.cursor, 14);
});

test('18. 러너 있는 프로세스의 drain은 종전대로 바로 적재한다(대체 러너 포함 — 크루가 고른 러너만 없음)', async () => {
  const ws = await seed('drain-fallback', { runner: 'codex', cred: true }); // claude만 연결, 크루는 codex 지정
  const clock = Date.now(); const now = () => clock;
  const srv = inboxServer([inboxMsg(11, clock)]);
  const enq = collector();
  await drainAs(ws, srv, 'A', enq, now);
  assert.deepEqual(enq.jobs.map((j) => j.msgId), [11]);
  assert.equal(srv.cursor, 11);
});

test('19. 운영 배선 — startMsgrBridge가 drain에 러너 판정을 넘긴다: 러너 없는 회사는 새 대상 글에 커서를 쓰지 않고, 기한이 지난 글은 종전대로 넘긴다', async () => {
  const run = async (ws, created) => {
    await seed(ws);
    await writeFile(paths(ws).company, JSON.stringify({ id: ws, name: '린', lang: 'ko', created: '2026-10-08', ownerId: OWNER })); // 브리지는 소유자 계정일 때만 연다
    const cursorWrites = []; let inboxReads = 0;
    const known = {
      async myCrews() { return [{ id: CREW, org_id: ORG, slug: 'seoyun', display_name: '서윤', allow: 'all', allow_users: [], cursor_msg_id: 10, hosting: 'local' }]; },
      async crewInbox() { inboxReads++; return [inboxMsg(11, created)]; },
      async crewScope() { return new Set([CH]); },
      async channel(id) { return { id, org_id: ORG, kind: 'public', name: 'general', crew_memory: true }; },
      async instructCheck() { return 'ok'; },
      async orgEntitled() { return true; },
      async orgConsentOk() { return true; },
      async message() { return null; },
      async setCursor(_id, n) { cursorWrites.push(n); },
      crewContext: undefined, // 봉투 RPC 없는 서버(옛 경로) — 나머지 조회는 빈 값
    };
    const db = new Proxy(known, { get: (t, k) => (k in t ? t[k] : async () => []) });
    const client = { channel: () => { const ch = { on() { return ch; }, subscribe() { return ch; }, unsubscribe() {} }; return ch; } };
    const stop = M.startMsgrBridge(ws, { session: async () => ({ uid: OWNER, db, client }), pollMs: 60_000 });
    try {
      for (let i = 0; i < 200 && !(inboxReads && (cursorWrites.length || i > 40)); i++) await new Promise((r) => setTimeout(r, 25));
    } finally { stop(); }
    return { cursorWrites, inboxReads };
  };
  const fresh = await run('bridge-fresh', Date.now());
  assert.ok(fresh.inboxReads >= 1, '전제: 브리지가 drain했다');
  assert.deepEqual(fresh.cursorWrites, [], '러너 없는 회사의 새 대상 글 — 커서를 넘기지 않는다(러너 있는 프로세스 몫)');
  const old = await run('bridge-old', Date.now() - YIELD_GRACE_MS - 5000);
  assert.deepEqual(old.cursorWrites, [11], '기한이 지난 글은 종전대로 적재·전진');
});

test('20. 핸들러 양보 기한은 글 나이 — 재시작한 프로세스도 다시 160초를 기다리지 않고, 시각을 모르는 옛 잡은 양보하지 않는다', async () => {
  const ws = await seed('yield-restart');
  const srv = server();
  let clock = Date.now(); const now = () => clock;
  const job = jobAt(clock);
  const A1 = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), now, linkPreview: noPreview });
  assert.equal(await A1(structuredClone(job)), DEFER);
  clock += YIELD_GRACE_MS + 1;
  const A2 = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), now, linkPreview: noPreview }); // 재시작 — 프로세스 메모리 없음
  assert.notEqual(await A2(structuredClone(job)), DEFER, '재시작해도 기한은 글 나이 기준이라 다시 160초를 기다리지 않는다');
  assert.equal(replyOf(srv, job)[0]?.meta?.failed, true);
  const legacy = { ...jobAt(clock) }; delete legacy.createdAt;
  const A3 = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), now, linkPreview: noPreview });
  assert.notEqual(await A3(legacy), DEFER, '시각 없는 잡은 양보하지 않는다(무기한 양보 금지 — 종전 동작)');
});

test('21. 카드 없음(검수 LOW-3) — 그 턴을 돌릴 수 없는 프로세스라 양보하고, 기한 뒤 실패도 활동 기록에 남는다(러너를 고르기 전 실패 표지)', async () => {
  const ws = await seed('ghost-card', { cred: true }); // 러너는 있다 — 카드만 없다(앱 전용 데이터 폴더·동기화 지연)
  const srv = server();
  let clock = Date.now(); const now = () => clock;
  const job = { ...jobAt(clock), slug: 'ghost' };
  const h = M.makeMsgrHandler(ws, { session: async () => ({ db: srv.forProc('A'), uid: OWNER }), now, linkPreview: noPreview });
  assert.equal(await h(structuredClone(job)), DEFER, '카드가 없으면 카드 있는 프로세스가 가져가게 양보');
  assert.equal(srv.calls.length, 0);
  await assert.rejects(C.chat(ws, 'ghost', '카드 없는 에이전트에게', null, { source: 'messenger' }), /에이전트를 찾을 수 없습니다: ghost/);
  const [e] = (await events(ws)).filter((x) => x.type === 'turn');
  assert.equal(e?.ok, false, '카드 읽기 실패도 활동에 남는다 — 방 문구 "Argo 활동에서 원인을 확인"이 사실이 되게');
  assert.equal(e.slug, 'ghost');
  assert.equal(e.source, 'messenger');
  assert.equal(e.preRun, true);
  assert.match(e.error, /에이전트를 찾을 수 없습니다: ghost/);
});

test('22. 실패 다이제스트(검수 LOW-2) — 러너를 고르기 전에 끝난 턴(러너 없음·http·카드 없음)은 반복돼도 "반복 실패"로 묶지 않는다. 러너 실패는 종전대로 묶는다', async () => {
  const ws = await seed('digest-prerun');
  for (const source of ['deck', 'routine', 'messenger']) await assert.rejects(C.chat(ws, 'seoyun', `${source} 지시`, null, { source }), /AI 러너가 하나도/);
  await writeFile(join(paths(ws).root, 'agents', 'ext.md'), '---\nname: 외부\nrunner: http\n---\n');
  for (let i = 0; i < 3; i++) await assert.rejects(C.chat(ws, 'ext', '외부', null, { source: 'routine' }), /외부 HTTP 연결/);
  for (let i = 0; i < 3; i++) await assert.rejects(C.chat(ws, 'ghost', '없는 카드', null, { source: 'routine' }), /에이전트를 찾을 수 없습니다/);
  assert.equal((await events(ws)).filter((e) => e.type === 'turn' && e.ok === false).length, 9, '전제: 조기 실패 9줄이 활동에 있다');
  assert.deepEqual(await runFailureDigest(ws), [], '조기 실패는 러너 오류가 아니다 — 다이제스트 0(설정 화면·활동 행이 이미 원인을 보인다)');
  assert.equal((await events(ws)).filter((e) => e.type === 'failure-digest').length, 0, '"unknown" 라벨·제보 안내 행이 생기지 않는다');
  const ts = new Date().toISOString();
  const runnerFails = [1, 2, 3].map(() => ({ type: 'turn', ok: false, ts, runner: 'claude', slug: 'seoyun', error: 'API Error: 500 internal' }));
  assert.equal(digestFailures(runnerFails).length, 1, '러너 실패의 반복은 종전대로 묶는다(인접 핀)');
});

test('23. 러너 판정 비용(검수 LOW-1) — 월 사용량 파일을 읽지 않고, 판정 결과는 chat()의 resolveRunner와 같다', async () => {
  const ws = await seed('judge-cost', { cred: true });
  await writeFile(paths(ws).usage, Array.from({ length: 200 }, (_, i) => JSON.stringify({ ts: new Date().toISOString(), kind: 'chat', slug: 'seoyun', runner: 'claude', costUsd: 0.01 * i })).join('\n') + '\n');
  const reads = []; const orig = fsp.readFile;
  fsp.readFile = function (p, ...a) { reads.push(String(p)); return orig.call(this, p, ...a); };
  syncBuiltinESMExports();
  let ready;
  try { ready = await C.turnRunnerAvailable(ws, 'seoyun'); } finally { fsp.readFile = orig; syncBuiltinESMExports(); }
  assert.equal(ready, true);
  assert.ok(reads.length > 0, '전제: 읽기 기록이 잡힌다');
  assert.deepEqual(reads.filter((p) => p === paths(ws).usage), [], '가용 판정은 표시용 월 사용량(회전 없는 usage.jsonl 전체)을 읽지 않는다');
  // 판정 결과 대조 — 자격 없음·API 키·카드 지정 러너 미연결·이 컴퓨터 로그인(host) 자격(감지 필요)
  const none = await seed('judge-none');
  const hostWs = await seed('judge-host', { runner: 'codex' });
  await saveRunnerCred(hostWs, 'codex', 'host', 'host');
  const claudeHost = await seed('judge-claude-host');
  await saveRunnerCred(claudeHost, 'claude', 'host', 'host'); // 이 컴퓨터 로그인 옵트인 — 유효성은 감지(임시 HOME의 로그인 흔적)로만 안다
  assert.equal(await C.turnRunnerAvailable(claudeHost, 'seoyun'), true, 'host 자격은 감지로 판정한다(건너뛰면 미가용으로 갈린다)');
  for (const [w, want] of [[none, null], [ws, null], [ws, 'codex'], [hostWs, 'codex'], [hostWs, null], [claudeHost, null]]) {
    assert.deepEqual(await resolveRunner(w, want, { forPick: true }), await resolveRunner(w, want), `forPick 판정 = 턴 판정 (${w}, ${want})`);
  }
});

test('24. 멘션 없이 이 에이전트 글에 단 답글도 대상 후보로 보류한다 — 부모 조회 없이(답글 규칙 D38b, 부모가 이 에이전트일 수 있다)', async () => {
  const ws = await seed('reply-target');
  const clock = Date.now(); const now = () => clock;
  const reply = { ...inboxMsg(31, clock, { mention: false }), reply_to: 900, thread_root: 900 };
  const srv = inboxServer([reply]);
  const parentReads = [];
  const enq = collector();
  const db = Object.assign(srv.forProc('A'), { async message(id) { parentReads.push(id); return { id: 900, channel_id: CH, author_kind: 'crew', crew_id: CREW, deleted_at: null }; } });
  await M.drain(ws, { db, uid: OWNER, enqueue: enq, housekeeping: false, now, runnerReady: C.turnRunnerAvailable });
  assert.equal(enq.jobs.length, 0, '러너 없는 프로세스는 이 답글을 적재하지 않는다');
  assert.equal(srv.cursor, 10);
  assert.deepEqual(parentReads, [], '부모 조회(RPC)도 하지 않는다');
  const wsB = await seed('reply-target-b', { cred: true });
  const dbB = Object.assign(srv.forProc('B'), { async message() { return { id: 900, channel_id: CH, author_kind: 'crew', crew_id: CREW, deleted_at: null }; } });
  const enqB = collector();
  await M.drain(wsB, { db: dbB, uid: OWNER, enqueue: enqB, housekeeping: false, now, runnerReady: C.turnRunnerAvailable });
  assert.deepEqual(enqB.jobs.map((j) => j.msgId), [31], '전제: 부모가 이 에이전트 글이라 실제 대상이다(러너 있는 쪽이 적재)');
});
