// 메신저 v2 U2b — u:<uid>·s:<space> 방송, Realtime 토픽 권한, Storage 버킷 msgr의 v2 경로 정책, offer 첨부(Storage 위치), 효과 unknown 계산, 보존 정리.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-realtime-storage-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateEnvelope } from '../packages/agent-link/contract/v1.mjs';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-realtime-storage-pg.test.mjs';
const O = '50000000-0000-4000-8000-000000000001', M = '50000000-0000-4000-8000-000000000002', G = '50000000-0000-4000-8000-000000000003', Z = '50000000-0000-4000-8000-000000000004';

let db, oApp, oRun, oRun2, mApp, mRun, gApp, zApp, PS, TS, DM, TR, OPEN, AG;
const seqs = new Map();
const env = (type, { work, dev = oRun, data = {} } = {}) => {
  const k = `${work}|${dev.dev}`; const s = (seqs.get(k) ?? 0) + 1; seqs.set(k, s);
  return { v: 1, id: randomUUID(), work, seq: s, type, agent: AG, device: dev.dev, at: new Date().toISOString(), data };
};
const send = (dev, e) => db.send(dev.uid, dev.sid, e);
const say = (who, room, body, mentions = []) => db.as(who.uid, who.sid,
  `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, mentions) values ('${room}', 'user', '${who.uid}', '${body.replace(/'/g, "''")}', '{${mentions.join(',')}}') returning id`);
const lastWork = (room) => db.sql(`select id from public.msgr2_works where room_id = '${room}' order by created_at desc, id limit 1`);
const sentTo = (topic, since) => JSON.parse(db.sql(`select coalesce(jsonb_agg(jsonb_build_object('event', event, 'payload', payload) order by id), '[]') from realtime.sent where topic = '${topic}' and id > ${since}`));
const mark = () => Number(db.sql('select coalesce(max(id), 0) from realtime.sent'));
// Storage 판정(사람·본체 문맥) — 객체 행 하나를 넣어 두고 select/insert를 RLS로 시험한다
const canRead = (who, name) => { db.sql(`insert into storage.objects (bucket_id, name) select 'msgr', '${name}' where not exists (select 1 from storage.objects where name = '${name}')`);
  return db.as(who.uid, who.sid, `select count(*) from storage.objects where bucket_id = 'msgr' and name = '${name}'`) === '1'; };
const canWrite = (who, name) => db.asErr(who.uid, who.sid, `insert into storage.objects (bucket_id, name) values ('msgr', '${name}')`) === null;

before(() => {
  if (!DB) return;
  db = setup(DB);
  db.sql(`insert into public.msgr_settings values ('msgr2_limit_agent_min', '1000'), ('msgr2_limit_room_min', '1000') on conflict (key) do update set value = excluded.value`);
  oApp = seedDevice(db, O, 'app'); oRun = seedDevice(db, O, 'runner'); oRun2 = seedDevice(db, O, 'runner');
  mApp = seedDevice(db, M, 'app'); mRun = seedDevice(db, M, 'runner'); gApp = seedDevice(db, G, 'app'); zApp = seedDevice(db, Z, 'app');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${O}') returning id`);
  TS = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', '팀', '${O}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${O}', 'owner'), ('${TS}', '${O}', 'owner'), ('${TS}', '${M}', 'member'), ('${TS}', '${G}', 'guest')`);
  AG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${O}', 'w', 'a', '에이') returning id`);
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id, allow) values ('${AG}', '${TS}', 'all')`);
  DM = db.sql(`insert into public.msgr2_rooms (space_id, kind, pair_key) values ('${PS}', 'direct', 'o-a') returning id`);
  TR = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'private', '팀방') returning id`);
  OPEN = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'open', '공지') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${DM}', 'user', '${O}'), ('${DM}', 'agent', '${AG}'),
    ('${TR}', 'user', '${O}'), ('${TR}', 'user', '${M}'), ('${TR}', 'agent', '${AG}')`);
});

test('u: 방송 — 글 1개는 방의 사람마다 u:<uid> msg(본문 포함), 방 밖 사람·손님(방 멤버 아님)에게는 없다, 4KB를 넘으면 id만', { skip }, () => {
  const m0 = mark();
  const id = Number(say(mApp, TR, '안녕 팀'));
  const toO = sentTo(`u:${O}`, m0), toM = sentTo(`u:${M}`, m0);
  assert.equal(toO.length, 1); assert.equal(toM.length, 1, '글쓴이 자신에게도(다른 기기)');
  assert.equal(toO[0].event, 'msg'); assert.equal(toO[0].payload.message.id, id); assert.equal(toO[0].payload.message.body, '안녕 팀');
  assert.equal(sentTo(`u:${G}`, m0).length, 0, '방 멤버 아닌 손님'); assert.equal(sentTo(`u:${Z}`, m0).length, 0, '공간 밖');
  const m1 = mark(); const big = Number(say(mApp, TR, '가'.repeat(2000)));
  const p = sentTo(`u:${O}`, m1)[0].payload.message;
  assert.equal(p.id, big); assert.equal(p.body, undefined, '4KB 초과는 본문 없이'); assert.equal(p.room_id, TR);
});

test('u: 방송 — 고치거나 지우면 같은 id로 다시 보내고, 바뀐 것이 없는 갱신은 보내지 않는다', { skip }, () => {
  const id = say(mApp, TR, '고칠 글'); const m0 = mark();
  db.sql(`update public.msgr2_messages set body = '고친 글', edited_at = now() where id = ${id}`);
  const e = sentTo(`u:${O}`, m0); assert.equal(e.length, 1); assert.equal(e[0].payload.message.body, '고친 글'); assert.ok(e[0].payload.message.edited_at);
  const m1 = mark(); db.sql(`update public.msgr2_messages set deleted_at = now() where id = ${id}`);
  const d = sentTo(`u:${O}`, m1)[0].payload.message; assert.ok(d.deleted_at); assert.equal(d.body, undefined, '지운 글은 본문 없이');
  const m2 = mark(); db.sql(`update public.msgr2_messages set client_msg_id = client_msg_id where id = ${id}`);
  assert.equal(sentTo(`u:${O}`, m2).length, 0);
});

test('s: 방송 — 사람이 상한(설정 msgr2_fanout_max)을 넘는 팀 open 방은 s:<space> 한 번, 넘지 않으면 사람마다', { skip }, () => {
  const m0 = mark(); say(mApp, OPEN, '작은 open 방');
  assert.equal(sentTo(`s:${TS}`, m0).length, 0); assert.equal(sentTo(`u:${O}`, m0).length, 1);
  db.sql(`insert into public.msgr_settings values ('msgr2_fanout_max', '1') on conflict (key) do update set value = excluded.value`);
  try {
    const m1 = mark(); say(mApp, OPEN, '큰 open 방');
    assert.equal(sentTo(`s:${TS}`, m1).length, 1, '공간 토픽 한 번'); assert.equal(sentTo(`u:${O}`, m1).length, 0, '사람마다 보내지 않는다');
    const m2 = mark(); say(mApp, TR, 'private 방은 상한과 무관');
    assert.equal(sentTo(`s:${TS}`, m2).length, 0); assert.equal(sentTo(`u:${O}`, m2).length, 1);
  } finally { db.sql(`delete from public.msgr_settings where key = 'msgr2_fanout_max'`); }
});

test('pause·device_revoked 방송 — 중단을 켜고 끄면 유효한 앱 기기 사용자에게 u: pause, 세대를 올리면 device_revoked {all:true}', { skip }, () => {
  const m0 = mark();
  db.sql(`insert into public.msgr_settings values ('msgr2_paused', '2026-10-17T13:00:00Z')`);
  assert.deepEqual(sentTo(`u:${M}`, m0).map((x) => x.payload), [{ paused: true, since: '2026-10-17T13:00:00Z' }]);
  const m1 = mark(); db.sql(`delete from public.msgr_settings where key = 'msgr2_paused'`);
  assert.deepEqual(sentTo(`u:${O}`, m1).map((x) => [x.event, x.payload]), [['pause', { paused: false }]]);
  const m2 = mark(); db.sql(`insert into public.msgr_settings values ('other_key', 'x') on conflict (key) do update set value = 'y'`);
  assert.equal(Number(mark()), m2, '다른 설정은 방송 없음');
  const m3 = mark(); db.sql(`insert into public.msgr2_user_gen (user_id, gen) values ('${Z}', 1) on conflict (user_id) do update set gen = public.msgr2_user_gen.gen + 1`);
  assert.deepEqual(sentTo(`u:${Z}`, m3).map((x) => [x.event, x.payload]), [['device_revoked', { all: true }]]);
});

test('토픽 권한 — u:·w:는 본인만(w:는 본체 기기만), s:는 그 팀 공간의 owner·admin·member, wk:는 그 일의 방을 읽는 사람, 폐기된 기기·anon은 못 받는다', { skip }, () => {
  assert.equal(db.canListen(O, oApp.sid, `u:${O}`), true);
  assert.equal(db.canListen(M, mApp.sid, `u:${O}`), false, '남의 u:');
  assert.equal(db.canListen(O, oApp.sid, `w:${O}`), false, '앱 기기는 w:를 못 받는다');
  assert.equal(db.canListen(O, oRun.sid, `w:${O}`), true);
  assert.equal(db.canListen(M, mRun.sid, `w:${O}`), false, '남의 w:');
  assert.equal(db.canListen(M, mApp.sid, `s:${TS}`), true); assert.equal(db.canListen(G, gApp.sid, `s:${TS}`), false, '손님은 s: 아님');
  assert.equal(db.canListen(Z, zApp.sid, `s:${TS}`), false, '공간 밖');
  say(mApp, TR, '일 시키기', [AG]); const wid = lastWork(TR);
  assert.equal(db.canListen(M, mApp.sid, `wk:${wid}`), true); assert.equal(db.canListen(G, gApp.sid, `wk:${wid}`), false);
  const rev = seedDevice(db, O, 'app', { revoked: true });
  assert.equal(db.canListen(O, rev.sid, `u:${O}`), false, '폐기된 기기');
  assert.equal(db.canListen(O, oApp.sid, 'org:00000000-0000-4000-8000-000000000000'), false, '옛 토픽은 이 정책이 열지 않는다');
  const r = db.raw(['-A', '-t', '-c', `set role anon; select set_config('realtime.topic', 'u:${O}', false); select count(*) from realtime.messages`]);
  assert.notEqual(r.status === 0 && r.stdout.trim().split('\n').pop() !== '0', true, 'anon');
  assert.match(db.asErr(O, oApp.sid, `insert into realtime.messages (topic, extension, payload) values ('u:${O}', 'broadcast', '{}')`) ?? '', /row-level security/, '보내기 정책 없음');
});

test('Storage — 사람 첨부: 내 글의 첨부 행 경로만 올리고, 방을 읽는 사람만 받는다(손님·방 밖·다른 방 경로 거부)', { skip }, () => {
  const mid = say(mApp, TR, '파일');
  const a = JSON.parse(db.as(M, mApp.sid, `select public.msgr2_attachment_add(${mid}, 0, 'r.pdf', 'application/pdf', 3)`));
  assert.equal(canWrite(mApp, a.path), true, '내 첨부 경로');
  assert.equal(canWrite(mApp, `${TS}/${TR}/${mid}/1-other.pdf`), false, '첨부 행이 없는 경로');
  assert.equal(canWrite(oApp, a.path), false, '남의 글 경로');
  assert.equal(canWrite(mApp, `${PS}/${DM}/x.pdf`), false, '못 읽는 방');
  assert.equal(canWrite(mApp, `${TS}/${DM}/${mid}/0-r.pdf`), false, '공간과 방이 어긋난 경로');
  assert.equal(canRead(oApp, a.path), true); assert.equal(canRead(mApp, a.path), true);
  assert.equal(canRead(gApp, a.path), false, '방 멤버 아닌 손님'); assert.equal(canRead(zApp, a.path), false, '공간 밖');
  assert.equal(canRead(oApp, 'org-x/chan-y/file.pdf'), false, '옛 경로 모양은 이 정책이 열지 않는다');
  assert.equal(canRead(mApp, `${PS}/${TR}/${mid}/0-r.pdf`), false, '읽을 수 있는 방이라도 다른 공간 이름 아래 경로는 거부(공간·방 대조)');
  assert.match(db.asErr(M, mApp.sid, `delete from storage.objects where name = '${a.path}' returning 1`) ?? 'none', /none|^$/);
  assert.equal(db.sql(`select count(*) from storage.objects where name = '${a.path}'`), '1', '지우기 정책 없음(0행)');
});

test('Storage — 본체: offer 첨부는 그 방에 진행 중인 일의 리스를 쥔 runner만 받고, 결과 파일은 내 리스의 슬롯 경로만 올린다', { skip }, () => {
  const mid = say(oApp, DM, '이 파일 봐줘'); const wid = lastWork(DM);
  const a = JSON.parse(db.as(O, oApp.sid, `select public.msgr2_attachment_add(${mid}, 0, 'brief.pdf', 'application/pdf', 9)`));
  const name = a.path; canRead(oApp, name);
  // offer에는 아직 첨부가 없다(글 뒤에 붙었다) — accept 답이 지금 첨부를 싣는다
  const offer = JSON.parse(db.sql(`select envelope from public.msgr2_work_events where work_id = '${wid}' and type = 'work.offer'`));
  assert.deepEqual(offer.data.attachments, []);
  const acc = send(oRun, env('work.accept', { work: wid })); assert.equal(acc.ok, true, JSON.stringify(acc));
  assert.deepEqual(acc.attachments, [{ id: a.attachment_id, name: 'brief.pdf', mime: 'application/pdf', bytes: 9, bucket: 'msgr', path: name }]);
  // 결과 슬롯
  const slot = JSON.parse(db.as(O, oRun.sid, `select public.msgr2_link_upload_slot('${wid}', 'out.txt', 5)`));
  assert.equal(canWrite(oRun, slot.path), true, '리스를 쥔 본체의 슬롯');
  assert.equal(canWrite(oRun2, slot.path), false, '다른 본체');
  assert.equal(canWrite(oRun, `${PS}/${DM}/${randomUUID()}/x.txt`), false, '슬롯이 아닌 경로');
  // 리스가 끝나면 슬롯 쓰기도 막힌다
  db.sql(`update public.msgr2_works set lease_until = now() - interval '1 second' where id = '${wid}'`);
  assert.equal(canWrite(oRun, slot.path), false, '리스 만료');
});

test('Storage — 방을 못 읽는 주인의 runner도 리스를 쥔 일의 방 파일은 받는다(받는 동안만), 리스가 없으면 못 받는다', { skip }, () => {
  // 사람 판정(msgr2_access)이 거짓인 runner: M의 에이전트가 일을 잡은 뒤 M이 방에서 빠진다
  const MAG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug) values ('${M}', 'm', 'b') returning id`);
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id, allow) values ('${MAG}', '${TS}', 'all'); insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${TR}', 'agent', '${MAG}')`);
  const mid = say(oApp, TR, '엠 에이전트 일', [MAG]); const wid = lastWork(TR);
  const a = JSON.parse(db.as(O, oApp.sid, `select public.msgr2_attachment_add(${mid}, 0, 'f.txt', null, 1)`)); canRead(oApp, a.path);
  const acc = db.send(M, mRun.sid, { v: 1, id: randomUUID(), work: wid, seq: 1, type: 'work.accept', agent: MAG, device: mRun.dev, at: new Date().toISOString(), data: {} });
  assert.equal(acc.ok, true, JSON.stringify(acc));
  db.sql(`update public.msgr2_room_members set removed_at = now() where room_id = '${TR}' and member_kind = 'user' and member_id = '${M}'`);
  assert.equal(db.as(M, mApp.sid, `select (public.msgr2_access('${TR}')).read`), 'f', 'M은 이제 방을 못 읽는다');
  assert.equal(canRead(mApp, a.path), false, 'M의 앱은 못 받는다');
  assert.equal(canRead(mRun, a.path), true, '리스를 쥔 M의 본체는 그 일 동안 받는다');
  db.sql(`update public.msgr2_works set lease_until = now() - interval '1 second' where id = '${wid}'`);
  assert.equal(canRead(mRun, a.path), false, '리스가 끝나면 못 받는다');
  db.sql(`update public.msgr2_room_members set removed_at = null where room_id = '${TR}' and member_kind = 'user' and member_id = '${M}'`);
});

test('offer 첨부 — 넘김 offer는 결과 글의 첨부(슬롯 파일)를 Storage 위치로 싣고, 그 봉투가 약속 v1에 맞는다', { skip }, () => {
  const AG2 = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${O}', 'w', 'c', '씨') returning id`);
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id, allow) values ('${AG2}', '${TS}', 'all'); insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${TR}', 'agent', '${AG2}')`);
  say(oApp, TR, '씨에게 넘길 일', [AG]); const wid = lastWork(TR);
  assert.equal(send(oRun, env('work.accept', { work: wid })).ok, true);
  const slot = JSON.parse(db.as(O, oRun.sid, `select public.msgr2_link_upload_slot('${wid}', '표.csv', 12)`));
  const r = send(oRun, env('work.result', { work: wid, data: { text: '넘김', files: [slot.slot], handoffs: [{ agent: AG2, text: '표 봐줘' }] } }));
  assert.equal(r.ok, true, JSON.stringify(r));
  const child = db.sql(`select id from public.msgr2_works where parent_work_id = '${wid}'`);
  const offer = JSON.parse(db.sql(`select envelope from public.msgr2_work_events where work_id = '${child}' and type = 'work.offer'`));
  assert.equal(offer.data.attachments.length, 1);
  assert.deepEqual({ ...offer.data.attachments[0], id: 0 }, { id: 0, name: '표.csv', mime: 'application/octet-stream', bytes: 12, bucket: 'msgr', path: slot.path });
  assert.ok(validateEnvelope(offer, { from: 'server' }).ok, JSON.stringify(validateEnvelope(offer, { from: 'server' })));
});

test('효과 unknown — intent가 남은 채 리스가 끝나거나 일이 끝나면 상태 보기의 effects[].state가 unknown, 결과가 온 효과는 그대로', { skip }, () => {
  say(oApp, DM, '결제 일'); const wid = lastWork(DM);
  assert.equal(send(oRun, env('work.accept', { work: wid })).ok, true);
  send(oRun, env('work.effect', { work: wid, data: { effect_key: 'pay-a', state: 'intent', kind: 'pay' } }));
  send(oRun, env('work.effect', { work: wid, data: { effect_key: 'pay-b', state: 'intent' } }));
  send(oRun, env('work.effect', { work: wid, data: { effect_key: 'pay-b', state: 'done' } }));
  const st = () => JSON.parse(db.as(O, oApp.sid, `select public.msgr2_work_status('${wid}')`));
  assert.deepEqual(st().effects.map((e) => [e.key, e.state]), [['pay-a', 'intent'], ['pay-b', 'done']], '일하는 중');
  db.sql(`update public.msgr2_works set lease_until = now() - interval '1 second' where id = '${wid}'`);
  assert.deepEqual(st().effects.map((e) => [e.key, e.state]), [['pay-a', 'unknown'], ['pay-b', 'done']], '리스 만료 = 재시작한 본체');
  assert.equal(db.sql(`select state from public.msgr2_effects where effect_key = 'pay-a'`), 'intent', '저장 값은 그대로(읽을 때 계산)');
});

test('보존 — 30일 지난 끝난 일·만료 offer·일 없는 sync 기록만 지우고, 진행 중인 일의 기록·일·글은 남긴다, 지울 것이 없으면 쓰기 0', { skip }, () => {
  say(oApp, DM, '오래된 끝난 일'); const done = lastWork(DM);
  send(oRun, env('work.accept', { work: done })); send(oRun, env('work.result', { work: done, data: { text: 'ok', files: [], handoffs: [] } }));
  say(oApp, DM, '오래된 진행 중'); const live = lastWork(DM); send(oRun, env('work.accept', { work: live }));
  say(oApp, DM, '오래된 만료 offer'); const exp = lastWork(DM);
  db.sql(`update public.msgr2_works set expires_at = now() - interval '40 days' where id = '${exp}'`);
  send(oRun, { v: 1, id: randomUUID(), work: null, seq: 900, type: 'agent.sync', agent: null, device: oRun.dev, at: new Date().toISOString(), data: { agents: [] } });
  db.sql(`update public.msgr2_work_events set created_at = now() - interval '31 days' where work_id in ('${done}', '${live}', '${exp}') or (work_id is null and seq = 900)`);
  const before1 = (w) => db.sql(`select count(*) from public.msgr2_work_events where work_id = '${w}'`);
  const liveN = before1(live), msgs = db.sql('select count(*) from public.msgr2_messages'), works = db.sql('select count(*) from public.msgr2_works');
  const n = Number(db.sql('select public.msgr2_retention_prune()'));
  assert.ok(n >= 4, `지운 행 ${n}`);
  assert.equal(before1(done), '0'); assert.equal(before1(exp), '0'); assert.equal(before1(live), liveN, '진행 중인 일의 기록은 남는다');
  assert.equal(db.sql('select count(*) from public.msgr2_messages'), msgs, '글은 지우지 않는다'); assert.equal(db.sql('select count(*) from public.msgr2_works'), works, '일 행은 지우지 않는다');
  const x0 = db.sql('select count(*) || \'/\' || coalesce(max(xmin::text::bigint), 0) from public.msgr2_work_events');
  assert.equal(db.sql('select public.msgr2_retention_prune()'), '0'); assert.equal(db.sql('select count(*) || \'/\' || coalesce(max(xmin::text::bigint), 0) from public.msgr2_work_events'), x0, '두 번째는 쓰기 0');
  assert.equal(db.sql(`select has_function_privilege('authenticated', 'public.msgr2_retention_prune()', 'execute')`), 'f');
});

test('권한 — 방송·판정 보조 함수는 사람이 직접 부를 수 없다', { skip }, () => {
  for (const f of ['_msgr2_send_u(uuid, text, jsonb)', '_msgr2_send_s(uuid, text, jsonb)', '_msgr2_room_humans(uuid)', 'msgr2_on_message_broadcast()', '_msgr2_storage_room(text)']) {
    assert.equal(db.sql(`select has_function_privilege('authenticated', 'public.${f}', 'execute')`), 'f', f);
  }
});
