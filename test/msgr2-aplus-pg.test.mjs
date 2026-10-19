// 메신저 A+ 서버(20261019160000_msgr2_aplus.sql) — Pro 전용·1:1 밖 막기(lite)·회의방·외부 봇·상한·약속 v1.1 받기.
// 2026-10-19 유건 "A+ 진행"(라운드 2 고정). #1116 검수가 이 PR에서 잠그라고 한 4건: ① 회의 일 result의 handoffs 거부(H1)
// ② features 없는 본체(v1.0)에는 회의·봇 offer 없음 ③ agent.sync 저장 화이트리스트 ④ pro_required.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-aplus-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateEnvelope } from '../packages/agent-link/contract/v1.mjs';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-aplus-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261019160000_msgr2_aplus.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261019160000_msgr2_aplus.down.sql', import.meta.url));
const P = 'a0000000-0000-4000-8000-000000000001'; // Pro 주인
const F = 'a0000000-0000-4000-8000-000000000002'; // 무료 주인
const X = 'a0000000-0000-4000-8000-000000000003'; // 남

let db, pApp, pRun, fApp, fRun, xApp, PS, A1, A2, A3, A4, A5, A6, BOT, FA, XA;
const seqs = new Map();
const env = (type, { work = null, agent, dev = pRun, data = {} } = {}) => {
  const k = `${work}|${dev.dev}`; const s = (seqs.get(k) ?? 0) + 1; seqs.set(k, s);
  return { v: 1, id: randomUUID(), work, seq: s, type, agent: agent ?? (work ? db.sql(`select agent_id from public.msgr2_works where id = '${work}'`) : null), device: dev.dev, at: new Date().toISOString(), data };
};
const send = (dev, e) => db.send(dev.uid, dev.sid, e);
const say = (who, room, body, mentions = []) => db.as(who.uid, who.sid,
  `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, mentions) values ('${room}', 'user', '${who.uid}', '${body}', '{${mentions.join(',')}}') returning id`);
const works = (room) => JSON.parse(db.sql(`select coalesce(json_agg(w order by created_at, id), '[]') from (select id, kind, agent_id, meeting_agents, meeting_rounds, depth, chain_root, created_at from public.msgr2_works where room_id = '${room}') w`));
const lastSys = (room) => db.sql(`select meta::text from public.msgr2_messages where room_id = '${room}' and kind = 'system' order by id desc limit 1`);
const offerOf = (id) => JSON.parse(db.sql(`select envelope from public.msgr2_work_events where work_id = '${id}' and type = 'work.offer'`));
const err = (who, q) => db.asErr(who.uid, who.sid, `select ${q}`) ?? '';
const val = (who, q) => db.as(who.uid, who.sid, `select (${q})::text`);
const sync = (dev, agents, features) => send(dev, env('agent.sync', { dev, data: { agents, ...(features ? { features } : {}) } }));
const accept = (id, dev = pRun) => send(dev, env('work.accept', { work: id, dev }));
const result = (id, data, dev = pRun) => send(dev, env('work.result', { work: id, dev, data: { text: '끝', files: [], handoffs: [], ...data } }));
const room = (agents, { meeting = false, owner = P } = {}) => {
  const sp = owner === P ? PS : db.sql(`select id from public.msgr2_spaces where owner_user_id = '${owner}' and kind = 'personal'`);
  const r = db.sql(`insert into public.msgr2_rooms (space_id, kind, name, meeting) values ('${sp}', 'private', 'r', ${meeting}) returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${r}', 'user', '${owner}')`);
  for (const a of agents) db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${r}', 'agent', '${a}')`);
  return r;
};
const setting = (k, v) => db.sql(v == null ? `delete from public.msgr_settings where key = '${k}'` : `insert into public.msgr_settings values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`);
const agentRow = (ws, slug, owner = P, hosting = 'local') => db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name, hosting) values ('${owner}', '${ws}', '${slug}', '${slug}', '${hosting}') returning id`);

before(() => {
  if (!DB) return;
  db = setup(DB);
  // Pro 판정 대역: 운영의 is_pro_for(uuid)와 같은 이름. 시험 표에 있는 사용자만 Pro
  db.sql(`create table if not exists public.test_pro (uid uuid primary key);
    create or replace function public.is_pro_for(p uuid) returns boolean language sql stable as $$ select exists (select 1 from public.test_pro where uid = p) $$;
    insert into public.test_pro values ('${P}');
    insert into public.msgr_settings values ('msgr2_limit_agent_min', '1000'), ('msgr2_limit_room_min', '1000') on conflict (key) do update set value = excluded.value`);
  pApp = seedDevice(db, P, 'app'); pRun = seedDevice(db, P, 'runner'); fApp = seedDevice(db, F, 'app'); fRun = seedDevice(db, F, 'runner'); xApp = seedDevice(db, X, 'app');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${P}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${P}', 'owner')`);
  const FS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${F}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${FS}', '${F}', 'owner')`);
  [A1, A2, A3, A4, A5, A6] = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((s) => agentRow('w', s));
  BOT = agentRow('w', 'hermes-r', P, 'bot');
  FA = agentRow('w', 'fa', F); XA = agentRow('w', 'xa', X);
});

test('④ Pro 전용 — 무료 주인의 1:1 글은 일을 만들지 않고 안내 1줄, 무료 본체의 agent.sync는 pro_required, Pro는 된다, 스위치 off면 통과', { skip }, () => {
  const fr = room([FA], { owner: F });
  say(fApp, fr, '안녕');
  assert.equal(works(fr).length, 0);
  assert.equal(JSON.parse(lastSys(fr)).limit, 'pro');
  const r = sync(fRun, [{ ws: 'w', slug: 'fa', name: 'fa', role: '', face_hash: null }], ['meeting', 'bot']);
  assert.deepEqual(r, { ok: false, code: 'pro_required', retry: false });
  assert.equal(db.sql(`select features::text from public.msgr2_devices where id = '${fRun.dev}'`), '{}', '거부된 봉투는 기능도 기록하지 않는다');
  const pr = room([A1]);
  say(pApp, pr, '안녕');
  assert.equal(works(pr).length, 1);
  assert.equal(works(pr)[0].kind, 'chat');
  setting('msgr2_pro_gate', 'off');
  try { say(fApp, fr, '다시'); assert.equal(works(fr).length, 1, '스위치 off'); } finally { setting('msgr2_pro_gate', null); }
});

test('③ agent.sync 화이트리스트 — 봇의 url·키·모르는 필드는 저장되지 않고 hosting=bot만 남는다, 기능은 기기 행에', { skip }, () => {
  const r = sync(pRun, [
    { ws: 'w', slug: 'a1', name: 'a1', role: '', face_hash: null },
    { ws: 'w', slug: 'hermes-r', name: '헤르메스', role: '외부 봇', face_hash: null, kind: 'bot', bot: { kind: 'hermes', profile: 'research', url: 'https://bot.example/v1', api_key: 'SECRETKEY123' }, extra: 'zzz' },
  ], ['meeting', 'bot']);
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = db.sql(`select to_jsonb(a)::text from public.msgr2_agents a where id = '${BOT}'`);
  assert.equal(JSON.parse(row).hosting, 'bot');
  assert.equal(JSON.parse(row).display_name, '헤르메스');
  const everywhere = db.sql(`select coalesce(string_agg(t, ' '), '') from (
    select to_jsonb(a)::text t from public.msgr2_agents a union all select to_jsonb(d)::text from public.msgr2_devices d union all select envelope::text from public.msgr2_work_events) q`);
  for (const bad of ['bot.example', 'SECRETKEY123', 'zzz']) assert.ok(!everywhere.includes(bad), `서버에 남음: ${bad}`);
  assert.equal(db.sql(`select features::text from public.msgr2_devices where id = '${pRun.dev}'`), '{bot,meeting}');
});

test('쉬는 동안 쓰기 0 — 같은 agent.sync·같은 기능을 다시 보내도 에이전트·기기 행 xmin이 그대로다', { skip }, () => {
  const agents = [{ ws: 'w', slug: 'a1', name: 'a1', role: '', face_hash: null }, { ws: 'w', slug: 'hermes-r', name: '헤르메스', role: '외부 봇', face_hash: null, kind: 'bot', bot: { kind: 'hermes', profile: 'research' } }];
  sync(pRun, agents, ['bot', 'meeting']);
  const before = [db.xmins('msgr2_agents', `owner_user_id = '${P}'`), db.xmins('msgr2_devices', `user_id = '${P}'`)];
  sync(pRun, agents, ['meeting', 'bot']);
  assert.deepEqual([db.xmins('msgr2_agents', `owner_user_id = '${P}'`), db.xmins('msgr2_devices', `user_id = '${P}'`)], before);
});

test('② features 없는 본체(v1.0)에는 회의·봇 offer를 만들지 않는다 — 안내 1줄(need_update), 알리면 만든다', { skip }, () => {
  sync(pRun, [{ ws: 'w', slug: 'a1', name: 'a1', role: '', face_hash: null }]); // features 없음 = v1.0
  assert.equal(db.sql(`select features::text from public.msgr2_devices where id = '${pRun.dev}'`), '{}');
  const mr = room([A1, A2], { meeting: true });
  say(pApp, mr, '토론');
  assert.equal(works(mr).length, 0);
  assert.deepEqual(JSON.parse(lastSys(mr)), { code: 'work.limit', limit: 'need_update', feature: 'meeting', agent: A1 });
  const br = room([BOT]);
  say(pApp, br, '봇아');
  assert.equal(works(br).length, 0);
  assert.equal(JSON.parse(lastSys(br)).feature, 'bot');
  const chat = room([A3]);
  say(pApp, chat, '보통 1:1은 그대로');
  assert.equal(works(chat).length, 1);
  sync(pRun, [{ ws: 'w', slug: 'a1', name: 'a1', role: '', face_hash: null }], ['meeting', 'bot']);
  say(pApp, mr, '다시'); say(pApp, br, '다시');
  assert.equal(works(mr).length, 1); assert.equal(works(br).length, 1);
});

test('회의방 offer — 사람 글 1개 = offer 1개(대표 = 첫 참가자), 참가자·라운드 2가 약속 v1.1 모양으로 실리고 봇은 빠진다, 멘션하면 그 사람들만', { skip }, () => {
  const mr = room([A1, A2, A3, BOT], { meeting: true }); // 봇은 시드로 억지로 넣어도 참가자에서 빠진다
  say(pApp, mr, '분기 우선순위');
  const ws = works(mr);
  assert.equal(ws.length, 1);
  assert.equal(ws[0].kind, 'meeting'); assert.equal(ws[0].agent_id, A1); assert.equal(ws[0].meeting_rounds, 2);
  assert.deepEqual(ws[0].meeting_agents, [A1, A2, A3]);
  const offer = offerOf(ws[0].id);
  assert.ok(validateEnvelope(offer, { from: 'server' }).ok, JSON.stringify(validateEnvelope(offer)));
  assert.equal(offer.data.kind, 'meeting');
  assert.deepEqual(offer.data.meeting.participants.map((p) => p.agent), [A1, A2, A3]);
  assert.equal(offer.data.meeting.rounds, 2);
  assert.deepEqual(offer.data.peers, [], '회의 일은 넘기지 않는다');
  say(pApp, mr, '둘만', [A3, A2]);
  const w2 = works(mr)[1];
  assert.deepEqual(w2.meeting_agents, [A2, A3]); assert.equal(w2.agent_id, A2);
  setting('msgr2_meeting_rounds', '9');
  try { say(pApp, mr, '라운드 설정을 크게 해도'); assert.equal(works(mr)[2].meeting_rounds, 2, '최대 2'); } finally { setting('msgr2_meeting_rounds', null); }
});

test('회의 결과 — posts는 에이전트별 글(meta.round), 요약은 방에 없음 · ① 회의 일의 handoffs는 posts 유무와 무관하게 post_denied · 참가자 밖·개수 초과·회의 아닌 일의 posts도 거부', { skip }, () => {
  const mr = room([A1, A2], { meeting: true });
  say(pApp, mr, '회의');
  const id = works(mr)[0].id;
  assert.equal(accept(id).ok, true);
  const before = db.sql(`select count(*) from public.msgr2_messages where room_id = '${mr}'`);
  // ① H1: posts 없이 handoffs만 — 계약은 통과하지만 서버가 거부
  assert.equal(result(id, { posts: [], handoffs: [{ agent: A2, text: '넘김' }] }).code, 'post_denied');
  assert.equal(result(id, { posts: [{ agent: A1, round: 1, text: 'x' }], handoffs: [{ agent: A2, text: '넘김' }] }).code, 'invalid_envelope', 'posts + handoffs는 봉투 검사에서');
  assert.equal(result(id, { posts: [{ agent: A3, round: 1, text: '남' }] }).code, 'post_denied', '참가자 밖');
  assert.equal(result(id, { posts: Array.from({ length: 5 }, (_, i) => ({ agent: i % 2 ? A2 : A1, round: 1 + (i % 2), text: `${i}` })) }).code, 'post_denied', '2명 × 2라운드 = 4 초과');
  assert.equal(result(id, { posts: [{ agent: A1, round: 3, text: 'x' }] }).code, 'invalid_envelope', '라운드 3');
  assert.equal(db.sql(`select count(*) from public.msgr2_messages where room_id = '${mr}'`), before, '거부는 쓰기 0');
  const posts = [{ agent: A1, round: 1, text: '에이1' }, { agent: A2, round: 1, text: '에이2' }, { agent: A1, round: 2, text: '반응1' }, { agent: A2, round: 2, text: '반응2' }];
  assert.equal(result(id, { text: '요약', posts }).ok, true);
  const msgs = JSON.parse(db.sql(`select json_agg(json_build_object('a', author_agent_id, 'b', body, 'r', meta->'round', 'm', meta->'meeting') order by id) from public.msgr2_messages where room_id = '${mr}' and author_kind = 'agent'`));
  assert.deepEqual(msgs, posts.map((p) => ({ a: p.agent, b: p.text, r: p.round, m: true })));
  assert.equal(db.sql(`select count(*) from public.msgr2_messages where room_id = '${mr}' and body = '요약'`), '0');
  // 회의가 아닌 일에 posts
  const cr = room([A4]);
  say(pApp, cr, '보통');
  const cid = works(cr)[0].id; accept(cid);
  assert.equal(result(cid, { posts: [{ agent: A4, round: 1, text: 'x' }] }).code, 'post_denied');
});

test('1:1 밖 막기(lite) — 팀 공간·사람 1:1·1:1 방에 둘째 에이전트는 거부, 에이전트 1:1은 된다, off면 종전대로', { skip }, () => {
  assert.match(err(pApp, `public.msgr2_space_create('팀', 'team-x')`), /msgr2_lite_only/);
  assert.match(err(pApp, `public.msgr2_dm_open('${X}')`), /msgr2_lite_only|unavailable/);
  const dm = JSON.parse(val(pApp, `public.msgr2_agent_dm_open('${A5}')`));
  assert.ok(dm.room_id);
  assert.match(err(pApp, `public.msgr2_room_members_add('${dm.room_id}', '{}', array['${A6}']::uuid[])`), /msgr2_lite_only/);
  assert.match(err(pApp, `public.msgr2_room_members_add('${dm.room_id}', array['${X}']::uuid[])`), /msgr2_lite_only|msgr2_not_friend/); // 친구가 아니면 RPC가 먼저, 친구여도 트리거가 막는다
  setting('msgr2_lite', 'off');
  try { assert.match(val(pApp, `public.msgr2_space_create('팀', 'team-x')`), /^[0-9a-f-]{36}$/); } finally { setting('msgr2_lite', null); }
});

test('회의방 만들기 — Pro·내 에이전트 2..5명(봇·남·중복 거부), 6번째 넣기는 meeting_full, 봇 넣기는 meeting_no_bot', { skip }, () => {
  assert.match(err(fApp, `public.msgr2_meeting_create('무료', array['${FA}','${FA}']::uuid[])`), /msgr2_pro_required/);
  assert.match(err(pApp, `public.msgr2_meeting_create('하나', array['${A1}']::uuid[])`), /msgr2_meeting_agents/);
  assert.match(err(pApp, `public.msgr2_meeting_create('중복', array['${A1}','${A1}']::uuid[])`), /msgr2_meeting_agents/);
  assert.match(err(pApp, `public.msgr2_meeting_create('여섯', array['${A1}','${A2}','${A3}','${A4}','${A5}','${A6}']::uuid[])`), /msgr2_meeting_agents/);
  assert.match(err(pApp, `public.msgr2_meeting_create('남', array['${A1}','${XA}']::uuid[])`), /msgr2_agent_not_allowed/);
  assert.match(err(pApp, `public.msgr2_meeting_create('봇', array['${A1}','${BOT}']::uuid[])`), /msgr2_agent_not_allowed/);
  const m = JSON.parse(val(pApp, `public.msgr2_meeting_create('다섯', array['${A1}','${A2}','${A3}','${A4}','${A5}']::uuid[])`));
  assert.equal(db.sql(`select meeting::text from public.msgr2_rooms where id = '${m.room_id}'`), 'true');
  assert.equal(db.sql(`select count(*) from public.msgr2_room_members where room_id = '${m.room_id}' and member_kind = 'agent'`), '5');
  assert.match(err(pApp, `public.msgr2_room_members_add('${m.room_id}', '{}', array['${A6}']::uuid[])`), /msgr2_meeting_full/);
  const m2 = JSON.parse(val(pApp, `public.msgr2_meeting_create('둘', array['${A1}','${A2}']::uuid[])`));
  assert.match(err(pApp, `public.msgr2_room_members_add('${m2.room_id}', '{}', array['${BOT}']::uuid[])`), /msgr2_meeting_no_bot/);
});

test('외부 봇 — offer kind=bot·hop 0·max_hops 2·turns_left 3, 봇은 분당 6건까지', { skip }, () => {
  const br = room([BOT]);
  say(pApp, br, '첫');
  const w = works(br)[0];
  assert.equal(w.kind, 'bot');
  const offer = offerOf(w.id);
  assert.ok(validateEnvelope(offer, { from: 'server' }).ok, JSON.stringify(validateEnvelope(offer)));
  assert.equal(offer.data.kind, 'bot');
  assert.deepEqual([offer.data.limits.hop, offer.data.limits.max_hops, offer.data.limits.turns_left], [0, 2, 3]);
  const n0 = db.sql(`select count(*) from public.msgr2_works where agent_id = '${BOT}' and created_at > now() - interval '1 minute'`);
  for (let i = Number(n0); i < 7; i++) say(pApp, br, `연속 ${i}`);
  assert.equal(db.sql(`select count(*) from public.msgr2_works where agent_id = '${BOT}' and created_at > now() - interval '1 minute'`), '6');
  assert.equal(JSON.parse(lastSys(br)).limit, 'agent_minute');
  db.sql(`update public.msgr2_works set created_at = created_at - interval '2 minutes' where agent_id = '${BOT}'`);
});

test('봇 사슬 — 사람 글 1개에서 시작한 사슬은 턴 4·hop 2까지(넘김 4개 중 3개만), 사람 멘션 없이 봇 글이 봇을 깨우지 않는다', { skip }, () => {
  setting('msgr2_lite', 'off'); // 여러 에이전트 방(넘김 시험) — 시드로 만든다
  try {
    const r = room([BOT, A1, A2, A3, A4]);
    say(pApp, r, '봇 시작', [BOT]);
    const root = works(r)[0];
    accept(root.id);
    assert.equal(result(root.id, { handoffs: [A1, A2, A3, A4].map((a) => ({ agent: a, text: '이어서' })) }).ok, true);
    const ws = works(r);
    assert.equal(ws.length, 4, '뿌리 1 + 넘김 3(턴 4)');
    assert.ok(ws.every((x) => x.chain_root === root.id));
    assert.equal(JSON.parse(lastSys(r)).limit, 'bot_turns');
    // 한 트랜잭션에서 만들어 created_at이 같다 — 남은 턴으로 순서를 본다(2·1·0, 합계 4)
    const kids = ws.filter((x) => x.id !== root.id).map((x) => ({ ...x, lim: offerOf(x.id).data.limits }));
    assert.deepEqual(kids.map((k) => k.lim.turns_left).sort(), [0, 1, 2]);
    assert.ok(kids.every((k) => k.lim.hop === 1 && k.lim.max_hops === 2));
    const child = kids.find((k) => k.lim.turns_left === 2);
    const others = kids.filter((k) => k !== child);
    // hop: 깊이 2 → 3은 거부
    db.sql(`update public.msgr2_works set depth = 2 where id = '${child.id}'`);
    accept(child.id);
    db.sql(`update public.msgr2_works set chain_root = null where id in ('${others[0].id}', '${others[1].id}')`); // 사슬에서 떼어 턴 여유를 만들고 hop만 본다
    assert.equal(result(child.id, { handoffs: [{ agent: BOT, text: '다시 봇' }] }).ok, true);
    assert.equal(JSON.parse(lastSys(r)).limit, 'bot_hops');
    // 에이전트(봇) 글은 offer를 만들지 않는다 — 사람 멘션만
    const n = works(r).length;
    db.sql(`insert into public.msgr2_messages (room_id, author_kind, author_agent_id, body, mentions) values ('${r}', 'agent', '${A1}', '봇아', '{${BOT}}')`);
    assert.equal(works(r).length, n);
  } finally { setting('msgr2_lite', null); }
});

test('R9 — 연속 답장 6에서 결과 1개가 넘김 8개를 보내도 새 일은 1개(넘김마다 다시 센다)', { skip }, () => {
  setting('msgr2_lite', 'off');
  try {
    const peers = Array.from({ length: 8 }, (_, i) => agentRow('w', `p${i}`));
    const r = room([A1, ...peers]);
    say(pApp, r, '시작', [A1]);
    const id = works(r)[0].id; accept(id);
    db.sql(`insert into public.msgr2_room_counters (room_id, agent_streak) values ('${r}', 6) on conflict (room_id) do update set agent_streak = 6`);
    assert.equal(result(id, { handoffs: peers.map((a) => ({ agent: a, text: '넘김' })) }).ok, true);
    assert.equal(works(r).length, 2, '뿌리 1 + 넘김 1');
    assert.equal(JSON.parse(lastSys(r)).limit, 'streak');
  } finally { setting('msgr2_lite', null); }
});

test('되돌림 — down.sql 뒤 새 열·함수·트리거가 없고 offer 함수는 회의를 모른다, 다시 적용하면 같은 모양', { skip }, () => {
  const shape = () => db.sql(`select string_agg(x, '|' order by x) from (
      select p.oid::regprocedure::text || ':' || md5(p.prosrc) x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%msgr2%'
      union all select tgrelid::regclass::text || ':' || tgname from pg_trigger where not tgisinternal and tgname like 'msgr2%'
      union all select table_name || '.' || column_name from information_schema.columns where table_schema = 'public' and table_name like 'msgr2%') q`);
  const applied = shape();
  db.psql(['-c', readFileSync(DOWN, 'utf8')]);
  assert.equal(db.sql(`select count(*) from information_schema.columns where table_schema = 'public' and column_name in ('meeting', 'meeting_agents', 'meeting_rounds', 'chain_root', 'features')`), '0');
  assert.equal(db.sql(`select count(*) from pg_proc where proname in ('_msgr2_make_offer_x', 'msgr2_meeting_create', 'msgr2_lite_guard', '_msgr2_pro_ok')`), '0');
  assert.ok(!db.sql(`select prosrc from pg_proc where proname = 'msgr2_on_user_message'`).includes('meeting'));
  assert.ok(!db.sql(`select prosrc from pg_proc where proname = 'msgr2_link_send'`).includes('post_denied'));
  db.psql(['-c', readFileSync(MIG, 'utf8')]);
  assert.equal(shape(), applied);
});
