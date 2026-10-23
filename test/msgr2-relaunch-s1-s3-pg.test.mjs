// 메신저 재공개 전 검수 ① 보안 S1·S3(20261023180000) — setupFull(옛 msgr 전체 + msgr2)에서 본다. 시험용 공간·방만 쓴다.
// S1 사람 채팅 켬: 친구가 내 회의방에 자기 에이전트를 넣어도 회의 참가자는 대표 에이전트와 같은 주인의 에이전트만이고,
//    본체가 work.result posts에 남의 에이전트를 글쓴이로 보내면 post_denied(쓰기 0). 같은 주인의 회의는 종전대로.
// S3 v2 팀에서 내보낸(또는 스스로 나간) 사람: 같은 id의 옛 조직 멤버 행도 닫혀 옛 표(조직 문서·옛 채널)를 더는 읽지 못한다. 남은 사람은 그대로.
// 되돌림 파일을 적용하면 옛 동작(옛 멤버 행 그대로), 다시 적용하면 원래대로.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-relaunch-s1-s3-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setupFull, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-relaunch-s1-s3-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261023180000_msgr2_seat_keep_pro_attach.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261023180000_msgr2_seat_keep_pro_attach.down.sql', import.meta.url));
const id = (n) => `d8000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = id(1), F = id(2), M = id(3), X = id(4), TS = id(10);
let db, pApp, pRun, fApp, mApp, xApp, PS, A1, A2, FA;
const seqs = new Map();
const env = (type, { work = null, dev, data = {} }) => { const k = `${work}|${dev.dev}`; const s = (seqs.get(k) ?? 0) + 1; seqs.set(k, s);
  return { v: 1, id: randomUUID(), work, seq: s, type, agent: work ? db.sql(`select agent_id from public.msgr2_works where id = '${work}'`) : null, device: dev.dev, at: new Date().toISOString(), data }; };
const send = (dev, e) => db.send(dev.uid, dev.sid, e);
const say = (who, room, body, mentions = []) => db.as(who.uid, who.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, mentions) values ('${room}', 'user', '${who.uid}', '${body}', '{${mentions.join(',')}}') returning id`);
const lastWork = (room) => JSON.parse(db.sql(`select row_to_json(w) from (select id, agent_id, meeting_agents from public.msgr2_works where room_id = '${room}' order by created_at desc, id desc limit 1) w`));
const setting = (k, v) => db.sql(v == null ? `delete from public.msgr_settings where key = '${k}'` : `insert into public.msgr_settings (key, value) values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`);
const agent = (owner, slug) => db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${owner}', 'w', '${slug}', '${slug}') returning id`);

before(() => {
  if (!DB) return;
  db = setupFull(DB);
  db.sql(`insert into public.msgr_settings (key, value) values ('msgr2_limit_agent_min', '1000'), ('msgr2_limit_room_min', '1000') on conflict (key) do update set value = excluded.value`);
  pApp = seedDevice(db, P, 'app'); pRun = seedDevice(db, P, 'runner'); fApp = seedDevice(db, F, 'app'); mApp = seedDevice(db, M, 'app'); xApp = seedDevice(db, X, 'app');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${P}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${P}', 'owner')`);
  A1 = agent(P, 'a1'); A2 = agent(P, 'a2'); FA = agent(F, 'fa');
  // S3: 팀 공간 = 같은 id의 옛 조직(이전된 팀)
  db.sql(`insert into public.msgr_orgs (id, name, slug, owner_user_id) values ('${TS}', 'Team', 'team-s3', '${M}')`);
  db.sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${TS}', '${X}', 'member'), ('${TS}', '${P}', 'member') on conflict (org_id, user_id) do update set role = excluded.role, removed_at = null`);
  db.sql(`insert into public.msgr2_spaces (id, kind, name, owner_user_id) values ('${TS}', 'team', '팀', '${M}') on conflict (id) do nothing`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${TS}', '${M}', 'owner'), ('${TS}', '${X}', 'member'), ('${TS}', '${P}', 'member') on conflict (space_id, user_id) do update set role = excluded.role, removed_at = null`);
  db.sql(`insert into public.msgr_org_docs (org_id, path, title, body, created_by, updated_by) values ('${TS}', 'rules/a.md', '문서', '본문', '${M}', '${M}')`);
});

test('S1 사람 채팅 켬: 친구 에이전트가 들어온 내 회의방 — 참가자는 대표와 같은 주인의 에이전트만, 남의 에이전트 글쓴이 posts는 post_denied', { skip }, () => {
  const mr = db.sql(`insert into public.msgr2_rooms (space_id, kind, name, meeting) values ('${PS}', 'private', '회의', true) returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${mr}', 'user', '${P}'), ('${mr}', 'user', '${F}'), ('${mr}', 'agent', '${A1}'), ('${mr}', 'agent', '${FA}'), ('${mr}', 'agent', '${A2}')`);
  const sync = send(pRun, env('agent.sync', { dev: pRun, data: { agents: [{ ws: 'w', slug: 'a1', name: 'a1', role: '', face_hash: null }, { ws: 'w', slug: 'a2', name: 'a2', role: '', face_hash: null }], features: ['meeting', 'bot'] } }));
  assert.equal(sync.ok, true, JSON.stringify(sync));
  setting('msgr2_people', 'on');
  try {
    say(pApp, mr, '회의하자', [A1, FA, A2]);
    const w = lastWork(mr);
    assert.equal(w.agent_id, A1, '대표 = 첫 참가자');
    assert.deepEqual(w.meeting_agents, [A1, A2], '남의 에이전트(FA)는 참가자에서 빠진다');
    assert.equal(send(pRun, env('work.accept', { work: w.id, dev: pRun })).ok, true);
    const before = db.sql(`select count(*) from public.msgr2_messages where room_id = '${mr}'`);
    // 참가자 목록을 억지로 넓혀도(옛 판 행) 글쓴이는 내 에이전트만
    db.sql(`update public.msgr2_works set meeting_agents = array['${A1}', '${FA}']::uuid[] where id = '${w.id}'`);
    const r = send(pRun, env('work.result', { work: w.id, dev: pRun, data: { text: '끝', files: [], handoffs: [], posts: [{ agent: FA, round: 1, text: '친구 에이전트 행세' }] } }));
    assert.equal(r.code, 'post_denied', JSON.stringify(r));
    assert.equal(db.sql(`select count(*) from public.msgr2_messages where room_id = '${mr}'`), before, '거부는 쓰기 0');
    db.sql(`update public.msgr2_works set meeting_agents = array['${A1}', '${A2}']::uuid[] where id = '${w.id}'`);
    const ok = send(pRun, env('work.result', { work: w.id, dev: pRun, data: { text: '끝', files: [], handoffs: [], posts: [{ agent: A1, round: 1, text: '하나' }, { agent: A2, round: 1, text: '둘' }] } }));
    assert.equal(ok.ok, true, `같은 주인의 회의는 종전대로 ${JSON.stringify(ok)}`);
  } finally { setting('msgr2_people', null); }
});

test('S3 v2 팀에서 내보낸 사람·스스로 나간 사람은 옛 조직 멤버 행도 닫혀 옛 문서·옛 판정을 더는 못 읽는다, 남은 사람은 그대로', { skip }, () => {
  const docs = (who) => db.as(who.uid, who.sid, `select count(*) from public.msgr_org_docs where org_id = '${TS}'`);
  const member = (who) => db.as(who.uid, who.sid, `select public.msgr_is_member('${TS}')`);
  assert.equal(docs(xApp), '1', '전제: 내보내기 전에는 읽는다'); assert.equal(member(xApp), 't');
  assert.equal(db.as(M, mApp.sid, `select public.msgr2_space_member_remove('${TS}', '${X}')`), 't');
  assert.equal(db.sql(`select removed_at is not null from public.msgr_org_members where org_id = '${TS}' and user_id = '${X}'`), 't', '옛 멤버 행도 닫힘');
  assert.equal(docs(xApp), '0', '옛 조직 문서'); assert.equal(member(xApp), 'f', '옛 판정');
  assert.equal(db.as(P, pApp.sid, `select public.msgr2_space_leave('${TS}')`), 't', '스스로 나가기');
  assert.equal(member(pApp), 'f', '스스로 나간 사람도 닫힘');
  assert.equal(db.as(M, mApp.sid, `select count(*) from public.msgr_org_docs where org_id = '${TS}'`), '1', '남은 주인은 그대로');
  // 되돌림: 옛 동작(옛 멤버 행 그대로) → 다시 적용하면 닫힌다
  db.sql(`update public.msgr2_space_members set removed_at = null where space_id = '${TS}' and user_id = '${X}'; update public.msgr_org_members set removed_at = null where org_id = '${TS}' and user_id = '${X}'`);
  db.psql(['-v', 'ON_ERROR_STOP=1', '-f', DOWN]);
  db.as(M, mApp.sid, `select public.msgr2_space_member_remove('${TS}', '${X}')`);
  assert.equal(member(xApp), 't', '되돌린 판은 옛 동작(열린 채)');
  db.psql(['-c', readFileSync(MIG, 'utf8')]);
  db.sql(`update public.msgr2_space_members set removed_at = null where space_id = '${TS}' and user_id = '${X}'`);
  db.as(M, mApp.sid, `select public.msgr2_space_member_remove('${TS}', '${X}')`);
  assert.equal(member(xApp), 'f', '다시 적용하면 닫힌다');
});
