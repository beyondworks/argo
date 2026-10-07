// 보관한 옛 조직 1:1이 목적지인 본체 루틴·알림(유건 결정 2026-10-08 1-②) — 같은 에이전트의 개인 1:1로 보낸다.
// 실사례: '바버샵 예약 30분 전 알림' 루틴의 msgr 목적지가 페퍼 옛 조직 1:1(보관 대상)이다. 보관 뒤 그대로면 실행 때
// restoreMessengerContext가 거절해(운영: msgr_crew_context가 보관 방을 42501로) 루틴이 실패한다. routines.json은 고치지 않고 실행 때 판정한다.
//  · 옛 방 판정 = 조직 DM·보관됨·사람은 나 하나·에이전트는 이 slug의 내 조직 행 하나(마이그레이션·앱 legacyAgentDm과 같다), 같은 에이전트의 개인 행이 있을 때만.
//  · 그 밖(남이 낀 방·보관 안 된 방·개인 행 없음)은 종전 오류 그대로 — 다른 방으로 새지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-legacy-redirect-'));
const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const { addRoutine, runRoutine } = await import('../src/routines.mjs');
const { msgrPush } = await import('../src/gateway/msgr.mjs');
const { onNotify } = await import('../src/notify.mjs');

const ORG = '10000000-0000-4000-8000-000000000001';
const LEGACY = '20000000-0000-4000-8000-000000000001';
const ORG_ROW = { id: 'o-alpha', org_id: ORG, owner_user_id: 'owner', slug: 'alpha', display_name: '알파', status: 'active' };
const PERSONAL = { id: 'p-alpha', org_id: null, owner_user_id: 'owner', slug: 'alpha', display_name: '알파', status: 'active' };
let n = 0;

async function setup({ members = [['user', 'owner'], ['crew', 'o-alpha']], archived = true, personal = true, crewId = 'o-alpha' } = {}) {
  const ws = `legacy-redirect-${++n}`;
  await createCompany(ws, '검수', 'alpha', 'owner');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), '---\nname: 알파\nslug: alpha\n---\n');
  await updateCompany(ws, { msgr: { enabled: true } });
  const origin = { orgId: ORG, channelId: LEGACY, crewId, threadRoot: 10, sourceMsgId: 10, uid: 'owner', wsId: ws, origin: 'owner', hop: 0 };
  const rows = []; const rpcs = []; const reads = []; const events = [];
  const db = {
    crewBySlug: async (uid, wsId, slug, orgId) => (uid === 'owner' && wsId === ws && slug === 'alpha' && orgId === ORG ? ORG_ROW : null),
    crewContext: async () => null, // 운영 그대로 — 보관 방은 msgr_delivery_allowed가 거짓이라 msgr_crew_context가 42501(null)
    channel: async (id) => { reads.push(['channel', id]); return id === LEGACY ? { id, org_id: ORG, kind: 'dm', name: 'dm:알파', crew_memory: true, archived_at: archived ? '2026-10-08T01:00:00Z' : null, excluded_crew_ids: [] } : null; },
    channelMembers: async (id) => { reads.push(['members', id]); return id === LEGACY ? members.map(([member_kind, member_id]) => ({ member_kind, member_id })) : []; },
    myCrews: async (uid, wsId) => (uid === 'owner' && wsId === ws ? [ORG_ROW, ...(personal ? [PERSONAL] : [])] : []),
    crewScope: async () => new Set(), // 명시 알림 선택지의 채널 범위 — 보관 방은 선택지에 없다
    insertMessage: async (row) => { rows.push(row); return { id: 100 + rows.length }; },
  };
  const client = {
    rpc: async (name, args) => { rpcs.push([name, args]); return name === 'msgr_dm_personal_crew' && args.crew === 'p-alpha' ? { data: 'proom-alpha', error: null } : { data: null, error: { message: 'unexpected rpc' } }; },
    from: (table) => { // 명시 알림 목적지 선택지(messengerNotificationChannels) — 조직 멤버십은 있고, 보관 방은 목록에 없다(archived_at IS NULL)
      let data = table === 'msgr_org_members' ? [{ org_id: ORG, expires_at: null, msgr_orgs: { id: ORG, name: 'Lean', deleted_at: null } }] : [];
      const api = { select: () => api, eq: () => api, in: () => api, is: () => api, then: (ok, bad) => Promise.resolve({ data, error: null }).then(ok, bad) };
      return api;
    },
  };
  const session = async () => ({ uid: 'owner', db, client });
  const stop = onNotify((e) => { if (e.wsId === ws) events.push(e); });
  const chats = [];
  const chatFn = async (_ws, slug, msg, sessionId, opts) => { chats.push({ slug, msg, sessionId, opts }); return { reply: '예약 30분 전입니다\nMSGR: done', sessionId: null, handover: null }; };
  return { ws, origin, rows, rpcs, reads, events, session, stop, chats, chatFn };
}

test('보관한 옛 1:1이 메신저 출처인 루틴: 실행은 그 방 문맥 없이 돌고, 결과는 같은 에이전트의 개인 1:1에 한 번 올라간다', async () => {
  const f = await setup();
  try {
    const r = await addRoutine(f.ws, { agentSlug: 'alpha', title: '바버샵 예약 30분 전 알림', prompt: '예약 30분 전에 알려 줘', schedule: { type: 'daily', time: '09:00' }, msgr: f.origin });
    const out = await runRoutine(f.ws, r.id, { session: f.session, chatFn: f.chatFn });
    assert.equal(out.ok, true, '보관했다고 루틴이 실패하지 않는다');
    assert.equal(out.reply, '예약 30분 전입니다', '루틴 결과(마지막 결과 요약·알림)에도 넘김 표지를 남기지 않는다 — 종전 이어 실행(messengerReply)과 같다');
    assert.equal(f.chats.length, 1);
    assert.equal(f.chats[0].opts.mirrorCtx, undefined, '보관한 방의 문맥(스레드·동료)을 싣지 않는다');
    assert.equal(f.chats[0].opts.source, 'messenger', '결과가 메신저로 간다 — 파일 첨부 규약 안내 그대로');
    assert.equal(f.chats[0].sessionId, null);
    assert.match(f.chats[0].msg, /예약 30분 전에 알려 줘/);
    const ev = f.events.filter((e) => e.type === 'routine');
    assert.equal(ev.length, 1);
    assert.equal(await msgrPush(ev[0], { session: f.session }), true);
    assert.equal(await msgrPush(ev[0], { session: f.session }), true, '같은 결과를 다시 밀어도');
    assert.equal(f.rows.length, 2);
    const [row, again] = f.rows;
    assert.equal(row.channel_id, 'proom-alpha', '개인 1:1');
    assert.equal(row.crew_id, 'p-alpha', '개인 행 이름으로(개인 방에는 개인 행만 쓴다)');
    assert.equal(row.reply_to, null); assert.equal(row.thread_root, null);
    assert.deepEqual(row.mentions, []); assert.equal(row.meta.disposition, 'done');
    assert.match(row.body, /바버샵 예약 30분 전 알림/); assert.match(row.body, /예약 30분 전입니다/);
    assert.doesNotMatch(row.body, /MSGR:/, '넘김 표지는 본문에서 뗀다');
    assert.equal(row.client_msg_id, again.client_msg_id, '재배달은 같은 멱등 키(서버가 한 번만 넣는다)');
    assert.ok(f.rows.every((x) => x.channel_id !== LEGACY), '보관한 방에는 쓰지 않는다');
    assert.ok(f.rpcs.every(([name, args]) => name === 'msgr_dm_personal_crew' && args.crew === 'p-alpha'));
  } finally { f.stop(); }
});

test('명시 알림 목적지가 보관한 옛 1:1이면 그 에이전트의 개인 1:1로 — 실패로 남기지 않는다', async () => {
  const f = await setup();
  try {
    const e = { type: 'routine', wsId: f.ws, routine: { id: 'r1', title: '아침 보고', agentSlug: 'alpha', lastRun: '2026-10-08T00:00:00Z', notifications: { channels: ['msgr'], msgr: { orgId: ORG, channelId: LEGACY } } }, ok: true, reply: '오늘 일정' };
    assert.equal(await msgrPush(e, { session: f.session }), true);
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0].channel_id, 'proom-alpha'); assert.equal(f.rows[0].crew_id, 'p-alpha');
    assert.match(f.rows[0].body, /^\[루틴\] 아침 보고/); assert.match(f.rows[0].body, /오늘 일정/);
  } finally { f.stop(); }
});

for (const [name, o] of [
  ['남이 낀 방(사람 둘)', { members: [['user', 'owner'], ['user', 'someone'], ['crew', 'o-alpha']] }],
  ['다른 에이전트와의 방', { members: [['user', 'owner'], ['crew', 'o-beta']] }],
  ['남과 내 에이전트만 있는 방(내가 구성원이 아님)', { members: [['user', 'someone'], ['crew', 'o-alpha']] }],
  ['출처 에이전트가 이 루틴 에이전트(slug)의 조직 행이 아님', { members: [['user', 'owner'], ['crew', 'o-beta']], crewId: 'o-beta' }],
  ['보관 안 된 방(다른 이유로 거절)', { archived: false }],
  ['같은 에이전트의 개인 행이 없음(옛 본체)', { personal: false }],
]) {
  test(`옛 방이 아니면 종전 오류 그대로 — ${name}: 다른 방에 쓰지 않는다`, async () => {
    const f = await setup(o);
    try {
      const r = await addRoutine(f.ws, { agentSlug: 'alpha', title: '바버샵', prompt: '알려 줘', schedule: { type: 'daily', time: '09:00' }, msgr: f.origin });
      await assert.rejects(runRoutine(f.ws, r.id, { session: f.session, chatFn: f.chatFn }), /메신저 원래 지시의 실행 권한이 없습니다/);
      assert.equal(f.chats.length, 0, '실행하지 않는다');
      const e = { type: 'routine', wsId: f.ws, routine: { id: 'r1', title: '아침', agentSlug: 'alpha', lastRun: '2026-10-08T00:00:00Z', notifications: { channels: ['msgr'], msgr: { orgId: ORG, channelId: LEGACY } } }, ok: true, reply: '오늘 일정' };
      await assert.rejects(msgrPush(e, { session: f.session }), /unavailable/);
      assert.deepEqual(f.rows, []);
      assert.equal(f.rpcs.length, 0, '개인 방을 만들거나 찾지 않는다');
    } finally { f.stop(); }
  });
}
