// 보낸 뒤 반응 없음(2026-10-05 운영 실측) — 서버 쪽 계약:
//  1) 핸들러가 잡을 받자마자(DB 왕복 전) 그 방 토픽으로 '받음' 입력 중 방송을 한 번 보낸다(phase: 'received').
//  2) 입력 중 방송은 답 게시(finishExecution)가 끝난 뒤에 멈춘다 — 링크 미리보기·게시 동안 표시가 끊기지 않는다.
//  3) 단계 로그(stdout 한 줄씩): 가져감·핸들러 시작·첫 방송·턴 시작·턴 끝·게시 완료. ISO 시각 + 글 id 앞 8자 + 원글 기준 경과 ms. DB 쓰기 없음.
// 가짜 db·가짜 Realtime 클라이언트 — 네트워크·실 Supabase 0. 임시 ARGO_ROOT — 실데이터 미접촉.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-send-feedback-'));
process.env.ARGO_ENC_VAULT = '0';
const M = await import('../src/gateway/msgr.mjs');
const { paths } = await import('../src/workspace.mjs');

const WS = 'send-fb';
const OWNER = '11111111-1111-4111-8111-111111111111';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001', CH = 'bbbbbbbb-0000-4000-8000-000000000001', CREW = 'cccccccc-0000-4000-8000-000000000001';
const p = paths(WS);
for (const d of [p.root, join(p.root, 'chats'), join(p.root, 'agents'), p.journal, p.files]) await mkdir(d, { recursive: true });
await writeFile(p.company, JSON.stringify({ id: WS, name: 'FB', lang: 'ko', created: '2026-10-05', ownerId: OWNER, msgr: { enabled: true } }));
await writeFile(join(p.root, 'agents', 'pepper.md'), '---\nname: 페퍼\nrole: 모더레이터\n---\n');

let nextId = 5000;
function world({ kind = 'private' } = {}) {
  const log = []; // 한 줄 시간표 — 방송·DB 호출·게시·해제를 일어난 순서대로
  const mk = (topic) => ({ topic, subscribe() { log.push(['subscribe', topic]); }, unsubscribe() { log.push(['remove', topic]); }, send(m) { log.push(['send', topic, m.event, m.payload]); return Promise.resolve('ok'); } });
  const client = { channel: (topic) => mk(topic), removeChannel: async (c) => { log.push(['remove', c.topic]); return 'ok'; } };
  const org = mk(`org:${ORG}`); org.__client = client;
  const db = new Proxy({
    async orgEntitled() { return true; },
    async orgConsentOk() { return true; },
    async crewBySlug(uid, ws, slug) { return slug === 'pepper' ? { id: CREW, org_id: ORG, slug, display_name: '페퍼' } : null; },
    async channel(id) { return { id, org_id: ORG, kind, name: 'test', crew_memory: true }; },
    async memberName() { return '유건'; },
    async contextOf() { return []; },
    async orgCrews() { return [{ id: CREW, slug: 'pepper', display_name: '페퍼', owner_user_id: OWNER, ws_id: WS }]; },
    async channelCrewMembers() { return new Set([CREW]); },
    async settled() { return false; },
    async message() { return null; },
    async org() { return { id: ORG, slug: 'fb', name: 'FB' }; },
    async attachmentsOf() { return []; },
    async instructCheck() { return 'ok'; },
    async executionStopInfo() { return null; },
    async insertMessage(row) { log.push(['insert', row.client_msg_id]); return { id: ++nextId }; },
    async claimExecution() { return { acquired: true, state: 'running', heartbeat_at: new Date().toISOString() }; },
    async finishExecution(key, row) { log.push(['finish', row.client_msg_id]); return { id: ++nextId }; },
    async heartbeatExecution() { return true; },
  }, { get(t, k) { const f = t[k]; if (typeof f !== 'function') return f; return (...a) => { log.push(['db', k]); return f.apply(t, a); }; } });
  return { log, org, db };
}
let seq = 2800; // 시험마다 다른 글 — 받음 방송은 잡(크루:글)당 한 번이라 같은 id를 쓰면 시험끼리 섞인다
const job = (over = {}) => { const id = ++seq; return { msgId: id, orgId: ORG, channelId: CH, crewId: CREW, slug: 'pepper', text: '@페퍼 테스트', authorId: OWNER, threadRoot: id, createdAt: new Date(Date.now() - 2000).toISOString(), channelKind: 'private', ...over }; };

async function runOnce({ kind = 'private', j = job({ channelKind: kind }), linkPreview } = {}) {
  const w = world({ kind });
  M._rtChannelsForTest.set(`${WS}:${ORG}`, w.org);
  const out = []; const orig = console.log; console.log = (...a) => { out.push(a.join(' ')); };
  try {
    const h = M.makeMsgrHandler(WS, {
      session: async () => { w.log.push(['session']); return { db: w.db, uid: OWNER }; },
      runChat: async () => { w.log.push(['runChat']); return { reply: '확인했습니다 https://example.com', handover: null, sessionId: null, artifacts: [] }; },
      linkPreview: linkPreview ?? ((body) => { w.log.push(['linkPreview']); return null; }),
    });
    await h(j);
  } finally { console.log = orig; M._rtChannelsForTest.delete(`${WS}:${ORG}`); }
  return { ...w, out };
}
const idx = (log, pred) => log.findIndex(pred);

test('비공개 방: 핸들러 시작 직후(세션·DB 왕복 전) 방 토픽 dm:<방>으로 받음 방송을 한 번 보낸다', async () => {
  const { log } = await runOnce();
  const first = idx(log, (e) => e[0] === 'send');
  assert.ok(first >= 0, JSON.stringify(log));
  assert.deepEqual(log[first].slice(1), [`dm:${CH}`, 'typing', { channel_id: CH, crew_id: CREW, phase: 'received' }]);
  const firstDb = idx(log, (e) => e[0] === 'session' || e[0] === 'db');
  assert.ok(first < firstDb, `첫 방송(${first})이 첫 세션·DB 호출(${firstDb})보다 앞이어야 한다: ${JSON.stringify(log.slice(0, 6))}`);
  assert.ok(!log.some((e) => e[0] === 'send' && e[1] === `org:${ORG}`), '비공개 방 활동이 조직 토픽으로 새면 안 된다');
});

test('공개 채널: 받음 방송은 조직 토픽으로, 방 채널은 열지 않는다', async () => {
  const { log } = await runOnce({ kind: 'public' });
  const first = log.find((e) => e[0] === 'send');
  assert.deepEqual(first.slice(1), [`org:${ORG}`, 'typing', { channel_id: CH, crew_id: CREW, phase: 'received' }]);
  assert.ok(!log.some((e) => e[0] === 'subscribe' && String(e[1]).startsWith('dm:')));
});

test('입력 중 방송은 답 게시(finish)와 링크 미리보기가 끝난 뒤에 멈춘다 — 게시 중에 표시가 끊기지 않는다', async () => {
  const { log } = await runOnce();
  const fin = idx(log, (e) => e[0] === 'finish');
  const lp = idx(log, (e) => e[0] === 'linkPreview');
  const rm = log.map((e, i) => (e[0] === 'remove' && e[1] === `dm:${CH}` ? i : -1)).filter((i) => i >= 0);
  assert.ok(fin >= 0 && lp >= 0, JSON.stringify(log));
  assert.ok(rm.length >= 1, '방 채널을 해제해야 한다');
  assert.ok(rm.every((i) => i > fin), `해제(${rm})는 게시(${fin}) 뒤여야 한다: ${JSON.stringify(log)}`);
  assert.ok(lp < rm[0]);
  // 받음 방송 뒤 턴 시작 방송(phase 없음)도 같은 방 토픽으로 이어진다 — 방 채널은 한 번만 연다
  assert.equal(log.filter((e) => e[0] === 'subscribe' && e[1] === `dm:${CH}`).length, 1, JSON.stringify(log));
  assert.ok(log.some((e) => e[0] === 'send' && e[1] === `dm:${CH}` && e[2] === 'typing' && !e[3].phase));
});

test('옛 큐 잡(channelKind 없음): 방 종류를 모르니 받음 방송은 건너뛰고 턴은 그대로 돈다', async () => {
  const j = job(); delete j.channelKind;
  const { log } = await runOnce({ j });
  assert.ok(!log.some((e) => e[0] === 'send' && e[3]?.phase === 'received'));
  assert.ok(log.some((e) => e[0] === 'finish'), '답은 게시된다');
});

test('단계 로그 — 가져감·시작·첫 방송·턴 시작·턴 끝·게시 완료가 순서대로, ISO 시각 + 글 id 앞 8자 + 경과 ms', async () => {
  const { out } = await runOnce({ j: job({ msgId: 1234567890123 }) });
  const lines = out.filter((l) => l.startsWith('[argo] msgr 단계'));
  const stages = lines.map((l) => l.split(' ')[3]);
  assert.deepEqual(stages, ['picked', 'start', 'broadcast', 'turn-start', 'turn-end', 'posted'], lines.join('\n'));
  for (const l of lines) assert.match(l, /^\[argo\] msgr 단계 \S+ \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z 12345678 \+\d+ms pepper$/, l);
  const ms = lines.map((l) => Number(l.match(/\+(\d+)ms/)[1]));
  assert.ok(ms[0] >= 2000 - 50, `원글 created_at 기준 경과(약 2초 전 글): ${ms[0]}`);
  assert.ok(ms.every((v, i) => i === 0 || v >= ms[i - 1]), '경과는 줄지 않는다');
});

test('drain이 적재하는 잡에 방 종류(channelKind)를 싣는다 — 핸들러가 DB 없이 방 토픽을 고를 수 있게', async () => {
  const queued = [];
  const crew = { id: CREW, org_id: ORG, slug: 'pepper', display_name: '페퍼', cursor_msg_id: 0, owner_user_id: OWNER };
  const msg = { id: 77, channel_id: CH, author_kind: 'user', author_user_id: OWNER, kind: 'text', body: '@페퍼 hi', mentions: [{ kind: 'crew', id: CREW }], created_at: new Date().toISOString(), meta: null };
  const db = {
    async myCrews() { return [crew]; },
    async crewChannels() { return []; }, async crewScope() { return new Set([CH]); },
    async messagesAfter() { return [msg]; }, async channel() { return { id: CH, org_id: ORG, kind: 'private', name: 'test' }; },
    async instructCheck() { return 'ok'; }, async orgConsentOk() { return true; }, async orgEntitled() { return true; },
    async setCursor() {}, async advanceCursor() {},
  };
  const out = await M.drain(WS, { db, uid: OWNER, enqueue: async (ws, key, name, payload) => { queued.push(payload); }, housekeeping: false, inventory: null, commandsFor: null }).catch((e) => ({ error: e }));
  assert.ok(!out?.error, String(out?.error?.stack ?? ''));
  assert.equal(queued.length, 1, JSON.stringify(out));
  assert.equal(queued[0].channelKind, 'private');
});

test('순서 대기(DEFER)로 3초마다 다시 집혀도 받음 방송은 잡당 한 번 — 방 채널을 매번 열고 닫지 않는다', async () => {
  const w = world();
  M._rtChannelsForTest.set(`${WS}:${ORG}`, w.org);
  const orig = console.log; console.log = () => {};
  try {
    const h = M.makeMsgrHandler(WS, { session: async () => ({ db: w.db, uid: OWNER }), runChat: async () => { throw new Error('차례 전에는 턴을 돌리면 안 된다'); }, linkPreview: () => null });
    const j = job({ msgId: 3001, threadRoot: 3001, after: ['dddddddd-0000-4000-8000-000000000001'] }); // 앞 크루 답을 기다리는 릴레이 잡(settled=false → DEFER)
    const r1 = await h(j); const r2 = await h(j); const r3 = await h(j);
    assert.ok([r1, r2, r3].every((r) => typeof r === 'symbol'), '세 번 다 DEFER');
  } finally { console.log = orig; M._rtChannelsForTest.delete(`${WS}:${ORG}`); }
  const received = w.log.filter((e) => e[0] === 'send' && e[3]?.phase === 'received');
  assert.equal(received.length, 1, JSON.stringify(w.log));
  assert.equal(w.log.filter((e) => e[0] === 'subscribe').length, 1, '방 채널은 첫 시도에만 연다');
  assert.equal(w.log.filter((e) => e[0] === 'remove').length, 1, '연 채널은 그 시도가 끝나면 닫는다');
});
