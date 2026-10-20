// 본체가 v2:w: 방송을 실제 모양 그대로 받는다(2026-10-18 U9 조사에서 찾은 결함의 잠금).
// 서버 _msgr2_send_w(20261020200300)는 realtime.send(payload = {envelope: 봉투}, event = 봉투 type, 'v2:w:<uid>')로 보낸다.
// 종전 본체(src/agent-link-host.mjs)는 event 'envelope'만 받고 payload를 봉투로 썼다 → offer·cancel·approval_decision이 즉시 오지 않고 재접속 따라잡기로만 왔다.
// 이 시험은 PG에서 서버가 실제로 남긴 방송 행(realtime.sent = realtime.send 대역)을 꺼내, realtime-js가 넘기는 모양({type, event, payload})으로
// 실제 전송부(supabaseTransport)의 구독 핸들러에 흘려 넣는다.
// 실행: bash scripts/billing-pg-drill.sh test/agent-link-w-shape-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvelope } from '../packages/agent-link/contract/v1.mjs';
import { supabaseTransport } from '../src/agent-link-host.mjs';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/agent-link-w-shape-pg.test.mjs';
const O = '41000000-0000-4000-8000-000000000001';

// supabase-js 클라이언트 대역: channel().on('broadcast', {event}, cb)를 모아 두고, deliver가 realtime-js처럼 event가 같거나 '*'인 핸들러에 {type, event, payload}를 넘긴다
function fakeClient() {
  const chans = [];
  return {
    chans,
    channel(topic) {
      const ch = { topic, handlers: [], removed: false,
        on(type, filter, cb) { this.handlers.push({ type, event: filter?.event, cb }); return this; },
        subscribe(cb) { cb?.('SUBSCRIBED'); return this; }, async send() { return 'ok'; } };
      chans.push(ch); return ch;
    },
    removeChannel(ch) { ch.removed = true; },
  };
}
const deliver = (client, topic, event, payload) => {
  for (const ch of client.chans) if (ch.topic === topic && !ch.removed) for (const h of ch.handlers) if (h.type === 'broadcast' && (h.event === '*' || h.event === event)) h.cb({ type: 'broadcast', event, payload });
};

let db, app, PS, DM, AG;
before(() => {
  if (!DB) return;
  db = setup(DB);
  app = seedDevice(db, O, 'app'); seedDevice(db, O, 'runner');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${O}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${O}', 'owner')`);
  AG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${O}', 'w', 'a', '에이') returning id`);
  DM = db.sql(`insert into public.msgr2_rooms (space_id, kind, pair_key) values ('${PS}', 'direct', 'o-a') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${DM}', 'user', '${O}'), ('${DM}', 'agent', '${AG}')`);
});

test('서버가 실제로 보낸 v2:w: 방송(offer·cancel)을 본체 전송부가 봉투로 받고, 그 봉투가 약속 v1에 맞는다', { skip }, () => {
  db.as(O, app.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${DM}', 'user', '${O}', '이거 해줘')`);
  const work = db.sql(`select id from public.msgr2_works where room_id = '${DM}' order by created_at desc limit 1`);
  assert.ok(work, '사람 글 → offer');
  db.as(O, app.sid, `select public.msgr2_work_cancel('${work}')`);
  const rows = db.sql(`select coalesce(json_agg(json_build_object('event', event, 'payload', payload) order by id), '[]') from realtime.sent where topic = 'v2:w:${O}'`);
  const sent = JSON.parse(rows);
  assert.deepEqual(sent.map((r) => r.event), ['work.offer', 'work.cancel'], '서버 모양: event = 봉투 type');
  assert.ok(sent.every((r) => r.payload?.envelope?.type === r.event), '서버 모양: payload = {envelope}');

  const client = fakeClient();
  const got = [];
  const t = supabaseTransport(client);
  t.subscribe(`v2:w:${O}`, (env) => got.push(env), () => {});
  for (const r of sent) deliver(client, `v2:w:${O}`, r.event, r.payload);
  assert.deepEqual(got.map((e) => e.type), ['work.offer', 'work.cancel'], '본체가 둘 다 받는다');
  for (const e of got) {
    assert.equal(e.work, work);
    const v = validateEnvelope(e, { from: 'server' });
    assert.ok(v.ok, JSON.stringify(v));
  }
});

test('본체 진행 방송(event envelope, payload = 봉투)은 그대로 받는다(앱 v2:wk:와 같은 모양) · 봉투가 아닌 payload는 버린다', { skip }, () => {
  const client = fakeClient(); const got = [];
  supabaseTransport(client).subscribe('v2:w:x', (env) => got.push(env), () => {});
  deliver(client, 'v2:w:x', 'envelope', { v: 1, type: 'work.progress', work: 'w' });
  deliver(client, 'v2:w:x', 'msg', { message: { id: 1 } });
  deliver(client, 'v2:w:x', 'junk', null);
  assert.deepEqual(got.map((e) => e.type), ['work.progress']);
});
