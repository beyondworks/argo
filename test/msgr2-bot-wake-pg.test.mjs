// 메신저 v2 봇 깨움(20261025100000) — 새 일이 봇 에이전트에게 생길 때만 방송 1회, 토픽 = JS wakeTopic(토큰), 방송 실패·표 없음은 일 만들기를 막지 않음,
// 쉬는 동안 쓰기 0(xmin), 받기 정책(anon은 깨움 토픽만), 되돌림 → 다시 적용.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-bot-wake-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';
import { wakeTopic } from '../supabase/functions/msgr-bot/wake.js';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-bot-wake-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261025100000_msgr2_bot_wake.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261025100000_msgr2_bot_wake.down.sql', import.meta.url));
const id = (n) => `da000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = id(1);
const TOK = `argo_bot_v2${'ef'.repeat(24)}`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
let db, PS, BOT_AG, ARGO_AG, R1, BOT;

const sent = () => Number(db.sql("select count(*) from realtime.sent where event = 'wake'"));
const offer = (agent) => db.sql(`insert into public.msgr2_works (room_id, agent_id, owner_user_id, from_kind, from_id, root_user_id, tier, expires_at)
  values ('${R1}', '${agent}', '${P}', 'user', '${P}', '${P}', 'owner', now() + interval '30 minutes') returning id`);

before(() => {
  if (!DB) return;
  db = setup(DB);
  seedDevice(db, P, 'app');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${P}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${P}', 'owner')`);
  BOT_AG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name, hosting) values ('${P}', 'vps:a', '~bot.hermes.default', 'Hermes', 'bot') returning id`);
  ARGO_AG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${P}', 'w', 'a1', 'a1') returning id`);
  BOT = db.sql(`insert into public.msgr2_bots (agent_id, owner_user_id, kind, host, ext_id, token_hash, token_hint) values ('${BOT_AG}', '${P}', 'hermes', 'vps-a', 'default', '${sha(TOK)}', 'argo_bot_v2ef') returning id`);
  R1 = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${PS}', 'private', '') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${R1}', 'user', '${P}'), ('${R1}', 'agent', '${BOT_AG}'), ('${R1}', 'agent', '${ARGO_AG}')`);
});

test('봇 에이전트에게 새 일(offered)이 생기면 방송 1회 — 토픽 = 엣지 wakeTopic(토큰), 본문 {} , 비공개', { skip }, async () => {
  const n0 = sent();
  offer(BOT_AG);
  assert.equal(sent(), n0 + 1);
  const row = JSON.parse(db.sql("select row_to_json(x) from (select topic, payload from realtime.sent where event = 'wake' order by id desc limit 1) x"));
  assert.equal(row.topic, await wakeTopic(TOK), 'DB 토픽 식 = 엣지 토픽 식');
  assert.deepEqual(row.payload, {}, '일 내용·방 id를 싣지 않는다');
  assert.equal(db.sql(`select public._msgr2_bot_wake_topic('${sha(TOK)}')`), row.topic);
});

test('본체(봇 아님) 에이전트의 일·폐기한 봇·offered가 아닌 일은 방송하지 않는다', { skip }, () => {
  const n0 = sent();
  offer(ARGO_AG);
  assert.equal(sent(), n0, '본체 에이전트');
  db.sql(`insert into public.msgr2_works (room_id, agent_id, owner_user_id, from_kind, from_id, root_user_id, tier, expires_at, state)
    values ('${R1}', '${BOT_AG}', '${P}', 'user', '${P}', '${P}', 'owner', now() + interval '30 minutes', 'done')`);
  assert.equal(sent(), n0, 'offered가 아닌 행');
  db.sql(`update public.msgr2_bots set revoked_at = now() where id = '${BOT}'`);
  try { offer(BOT_AG); assert.equal(sent(), n0, '폐기한 봇'); } finally { db.sql(`update public.msgr2_bots set revoked_at = null where id = '${BOT}'`); }
});

test('방송이 실패해도(realtime.send 오류) 일은 만들어진다', { skip }, () => {
  db.sql(`alter function realtime.send(jsonb, text, text, boolean) rename to send_ok;
    create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language plpgsql as $$ begin raise exception 'realtime down'; end $$`);
  try {
    const w = offer(BOT_AG);
    assert.equal(db.sql(`select state from public.msgr2_works where id = '${w}'`), 'offered');
  } finally { db.sql('drop function realtime.send(jsonb, text, text, boolean); alter function realtime.send_ok(jsonb, text, text, boolean) rename to send'); }
});

test('쉬는 동안 쓰기 0 — 일이 없는 롱폴 RPC(msgr2_bot_updates)는 표·방송 어디에도 쓰지 않는다', { skip }, () => {
  db.sql(`update public.msgr2_works set state = 'cancelled' where agent_id = '${BOT_AG}' and state in ('offered', 'accepted', 'running')`);
  db.sql(`select public.msgr2_bot_updates('${TOK}', 0, 1)`); // 접속 시각(10분 단위) 쓰기를 먼저 끝낸다
  const snap = () => [db.xmins('msgr2_bots'), db.xmins('msgr2_works'), sent()].join('|');
  const s = snap();
  for (let i = 0; i < 5; i++) assert.equal(db.sql(`select public.msgr2_bot_updates('${TOK}', 0, 1)::text`), '[]');
  assert.equal(snap(), s, '유휴 xmin 불변·방송 0');
});

test('받기 정책: anon은 깨움 토픽(botw:+64 hex) 방송만 본다 — 다른 v2 토픽·모양이 다른 토픽은 못 본다', { skip }, async () => {
  const good = await wakeTopic(TOK);
  for (const t of [good, 'v2:u:x', 'botw:short']) db.sql(`insert into realtime.messages (topic, extension, payload) values ('${t}', 'broadcast', '{}')`);
  const canAnon = (topic) => db.sql(`set role anon; select set_config('realtime.topic', '${topic}', false); select count(*) from realtime.messages where topic = '${topic}'`).split('\n').pop();
  db.sql('grant usage on schema realtime to anon; grant select on realtime.messages to anon');
  assert.equal(canAnon(good), '1');
  assert.equal(canAnon('v2:u:x'), '0', '본체·앱 토픽');
  assert.equal(canAnon('botw:short'), '0', '모양이 다른 토픽');
});

test('되돌림 → 트리거·함수·정책 없음(일은 그대로 만들어진다) → 다시 적용하면 방송', { skip }, () => {
  db.psql(['-v', 'ON_ERROR_STOP=1', '-f', DOWN]);
  assert.equal(db.sql(`select not exists (select 1 from pg_trigger where tgname = 'msgr2_bot_wake') and to_regprocedure('public._msgr2_bot_wake()') is null
    and not exists (select 1 from pg_policies where policyname = 'msgr2_bot_wake_recv')`), 't');
  const n0 = sent(); offer(BOT_AG); assert.equal(sent(), n0, '되돌린 판은 방송 없음');
  db.psql(['-v', 'ON_ERROR_STOP=1', '-c', readFileSync(MIG, 'utf8')]);
  offer(BOT_AG); assert.equal(sent(), n0 + 1);
});
