// 메신저 v2 U2b — 옛 메신저 마이그레이션 전체 + msgr2를 운영 순서로 적용한 판(검수 #1076 높음 1~3 재현·잠금).
// msgr2만 적용하면 옛 허용 정책(OR로 합쳐짐)·옛 정리 작업과의 상호작용이 안 보인다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-legacy-combo-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { setupFull, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-legacy-combo-pg.test.mjs';
const O = '70000000-0000-4000-8000-000000000001'; // v2 공간 주인
const X = '70000000-0000-4000-8000-000000000002'; // 옛 표에서만 관리자(v2 공간 멤버 아님)
const S = '71000000-0000-4000-8000-000000000001'; // v2 공간 id = 옛 조직 id(U8 id 보존)
const R = '72000000-0000-4000-8000-000000000001'; // v2 방 id = 옛 채널 id
const R2 = '72000000-0000-4000-8000-000000000002'; // 옛 채널이 없는 새 v2 방
const OLDCH = '73000000-0000-4000-8000-000000000001'; // v2 방이 아닌 옛 채널(같은 조직)

let db, oApp, oRev, oRun, xApp;
const put = (name, age = '0 seconds') => db.sql(`insert into storage.objects (bucket_id, name, created_at) select 'msgr', '${name}', now() - interval '${age}' where not exists (select 1 from storage.objects where name = '${name}')`);
const canRead = (who, name) => { put(name); return db.as(who.uid, who.sid, `select count(*) from storage.objects where bucket_id = 'msgr' and name = '${name}'`) === '1'; };
const canWrite = (who, name) => db.asErr(who.uid, who.sid, `insert into storage.objects (bucket_id, name) values ('msgr', '${name}')`) === null;
const delCount = (who, name) => { put(name); const r = db.raw(['-A', '-t', '-c', db.ctx(who.uid, who.sid) + `delete from storage.objects where bucket_id = 'msgr' and name = '${name}' returning 1`]); return r.status === 0 ? r.stdout.trim().split('\n').filter((l) => l === '1').length : -1; };
const sweep = () => db.sql('select coalesce(string_agg(n, \',\'), \'\') from public.msgr_storage_sweep_list(1000) n').split(',');

before(() => {
  if (!DB) return;
  db = setupFull(DB);
  oApp = seedDevice(db, O, 'app'); oRev = seedDevice(db, O, 'app', { revoked: true }); oRun = seedDevice(db, O, 'runner'); xApp = seedDevice(db, X, 'app');
  // v2
  db.sql(`insert into public.msgr2_spaces (id, kind, name, owner_user_id) values ('${S}', 'team', '팀', '${O}')`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${S}', '${O}', 'owner')`);
  db.sql(`insert into public.msgr2_rooms (id, space_id, kind, name) values ('${R}', '${S}', 'private', '이전된 방'), ('${R2}', '${S}', 'private', '새 방')`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${R}', 'user', '${O}'), ('${R2}', 'user', '${O}')`);
  // 옛 표(동결): 같은 id의 조직·채널, X는 옛 조직 관리자
  db.sql(`insert into public.msgr_orgs (id, name, slug, owner_user_id) values ('${S}', '옛 조직', 'old-org', '${X}')`);
  db.sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${S}', '${X}', 'admin') on conflict (org_id, user_id) do update set role = 'admin'`); // 조직을 만들면 트리거가 주인을 넣는다
  db.sql(`insert into public.msgr_channels (id, org_id, kind, name, created_by) values ('${R}', '${S}', 'public', '옛 채널', '${X}'), ('${OLDCH}', '${S}', 'public', '옛 채널 2', '${X}')`);
});

test('높음 1 — 폐기된 기기는 v2:u:<본인>을 못 받는다(옛 u: 정책이 OR로 열어도 v2 토픽은 이름이 달라 무관), 옛 u: 정책은 그대로', { skip }, () => {
  assert.equal(db.canListen(O, oApp.sid, `v2:u:${O}`), true);
  assert.equal(db.canListen(O, oRev.sid, `v2:u:${O}`), false, '폐기된 기기');
  assert.equal(db.canListen(O, oRev.sid, `u:${O}`), true, '옛 u: 정책은 건드리지 않는다(옛 앱 중단 방송) — v2는 이 토픽을 쓰지 않는다');
  assert.equal(db.canListen(O, oApp.sid, `v2:w:${O}`), false, '앱 기기는 본체 토픽을 못 받는다');
  const m0 = Number(db.sql('select coalesce(max(id), 0) from realtime.sent'));
  db.as(O, oApp.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${R}', 'user', '${O}', '안녕')`);
  const topics = db.sql(`select coalesce(string_agg(distinct topic, ','), '') from realtime.sent where id > ${m0}`).split(',');
  assert.ok(topics.includes(`v2:u:${O}`)); assert.ok(!topics.some((t) => /^(u|w|s|wk):/.test(t)), `옛 모양 토픽으로 보내지 않는다: ${topics}`);
});

test('높음 2 — 옛 정리 작업(msgr_storage_sweep_list)이 v2 파일을 후보로 고르지 않고, 옛 고아 파일은 그대로 고른다', { skip }, () => {
  const v2new = `${S}/${R2}/9/0-new.pdf`; // 옛 채널이 없는 새 v2 방 — 고치기 전에는 올리자마자 후보
  const v2old = `${S}/${R}/8/0-old.pdf`; // 이전된 방 — 고치기 전에는 첨부 행이 옛 표에 없어 25시간 뒤 후보
  const orphan = `aaaaaaaa-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000001/x.pdf`; // 방·채널 어디에도 없는 옛 모양 경로
  const oldStale = `${S}/${OLDCH}/old-unattached.pdf`; // 옛 채널, 첨부 행 없음, 24시간 지남 — 옛 규칙대로 후보
  put(v2new); put(v2old, '25 hours'); put(orphan); put(oldStale, '25 hours');
  const c = sweep();
  assert.ok(!c.includes(v2new), 'v2 새 방 파일'); assert.ok(!c.includes(v2old), 'v2 이전 방 파일');
  assert.ok(c.includes(orphan), '옛 고아 파일은 여전히 후보'); assert.ok(c.includes(oldStale), '옛 채널의 첨부 없는 파일은 여전히 후보');
});

test('높음 3 — v2 방 경로는 v2 판정만: 옛 표 관리자(v2 멤버 아님)는 읽기·쓰기·지우기 모두 안 되고, v2 주인도 지우지 못한다', { skip }, () => {
  const mid = db.as(O, oApp.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${R}', 'user', '${O}', '파일') returning id`);
  const a = JSON.parse(db.as(O, oApp.sid, `select public.msgr2_attachment_add(${mid}, 0, 'secret.pdf', null, 1)`));
  assert.equal(canWrite(oApp, a.path), true, 'v2 주인은 자기 첨부 경로에 올린다');
  assert.equal(canRead(oApp, a.path), true);
  assert.equal(canRead(xApp, a.path), false, '옛 관리자 읽기 차단');
  assert.equal(canWrite(xApp, `${S}/${R}/${mid}/1-x.pdf`), false, '옛 관리자 쓰기 차단');
  assert.equal(delCount(xApp, a.path), 0, '옛 관리자 지우기 차단(0행)');
  assert.equal(delCount(oApp, a.path), 0, 'v2 주인도 SQL 정책으로는 못 지운다');
  // v2에서 읽을 수 있고 옛 표에서는 관리자인 사람 — 옛 지우기 정책(관리자)이 허용해도 v2 방 경로는 지우지 못한다
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${S}', '${X}', 'member'); insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${R}', 'user', '${X}')`);
  try {
    assert.equal(canRead(xApp, a.path), true, 'v2 멤버가 되면 읽는다');
    assert.equal(delCount(xApp, a.path), 0, '옛 관리자 지우기 정책이 있어도 v2 방 경로는 0행');
  } finally {
    db.sql(`update public.msgr2_room_members set removed_at = now() where room_id = '${R}' and member_id = '${X}'; update public.msgr2_space_members set removed_at = now() where space_id = '${S}' and user_id = '${X}'`);
  }
  assert.equal(db.sql(`select count(*) from storage.objects where name = '${a.path}'`), '1');
});

test('옛 경로는 영향 없음 — v2 방이 아닌 옛 채널 경로는 옛 정책대로(옛 관리자 읽기·지우기 됨)', { skip }, () => {
  const legacy = `${S}/${OLDCH}/legacy.pdf`;
  assert.equal(canRead(xApp, legacy), true, '옛 정책 그대로');
  assert.equal(delCount(xApp, legacy), 1, '옛 관리자 지우기 정책 그대로');
});

test('되돌림(운영 순서 판) — U2b 되돌림 뒤 옛 정리 후보 함수 본문이 20261011150000과 같다', { skip }, () => {
  const down = readFileSync(fileURLToPath(new URL('../scripts/rollback/20261018010000_msgr2_realtime_storage.down.sql', import.meta.url)), 'utf8');
  db.psql(['-c', down]);
  const orig = readFileSync(fileURLToPath(new URL('../supabase/migrations/20261011150000_msgr_free_storage_limit.sql', import.meta.url)), 'utf8');
  const a = orig.indexOf('\nbegin\n  return query\n    select o.name from public._msgr_live_objects() o'); const b = orig.indexOf('end $$;', a);
  const want = orig.slice(a, b) + 'end ';
  const got = db.sql(`select prosrc from pg_proc where proname = 'msgr_storage_sweep_list'`);
  assert.equal(got.trim(), want.trim());
  assert.equal(db.sql(`select count(*) from pg_policies where policyname like 'msgr2_files_gate_%' or policyname in ('msgr2_realtime_send', 'msgr2_realtime_recv')`), '0');
});

// U6b 접속 표시(v2:pr:<주인>) — Presence 받기·보내기 권한(옛 msgr 전체 + msgr2 운영 순서 판)
test('U6b 접속 표시 — 본인·같은 팀 공간 멤버는 받고, 남(공간 밖)·폐기된 기기는 못 받는다, track은 주인의 본체 기기만, 옛 pr: 토픽은 열리지 않는다', { skip }, () => {
  const Z = '70000000-0000-4000-8000-000000000009'; const zApp = seedDevice(db, Z, 'app');
  const pres = (who, topic) => { db.sql(`insert into realtime.messages (topic, extension, payload) select '${topic}', 'presence', '{}' where not exists (select 1 from realtime.messages where topic = '${topic}' and extension = 'presence')`);
    return db.as(who.uid, who.sid, `select set_config('realtime.topic', '${topic}', false); select count(*) from realtime.messages where topic = '${topic}' and extension = 'presence'`).split('\n').pop() !== '0'; };
  const track = (who, topic) => db.asErr(who.uid, who.sid, `select set_config('realtime.topic', '${topic}', false); insert into realtime.messages (topic, extension, payload) values ('${topic}', 'presence', '{}')`) === null;
  assert.equal(pres(oApp, `v2:pr:${O}`), true, '본인');
  assert.equal(pres(zApp, `v2:pr:${O}`), false, '공간 밖 남');
  const S9 = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', 'z팀', '${Z}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${S9}', '${Z}', 'owner')`);
  assert.equal(pres(zApp, `v2:pr:${O}`), false, '다른 팀 공간의 멤버일 뿐이면 못 받는다(그 주인과 같은 공간이어야)');
  assert.equal(pres(oRev, `v2:pr:${O}`), false, '폐기된 기기');
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${S}', '${Z}', 'guest')`);
  assert.equal(pres(zApp, `v2:pr:${O}`), true, '같은 팀 공간의 활동 멤버');
  db.sql(`update public.msgr2_space_members set removed_at = now() where space_id = '${S}' and user_id = '${Z}'`);
  assert.equal(pres(zApp, `v2:pr:${O}`), false, '공간에서 빠지면 못 받는다');
  assert.equal(pres(zApp, `pr:${O}`), false, '옛 모양 pr: 토픽은 v2 정책이 열지 않는다');
  // 그 주인의 에이전트가 있는 방을 읽을 수 있으면 받는다(Z의 개인 공간 방에 O의 에이전트)
  const ZP = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${Z}') returning id`);
  const ZR = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${ZP}', 'private', 'z방') returning id`);
  const OAG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug) values ('${O}', 'w', 'pa') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${ZR}', 'user', '${Z}'), ('${ZR}', 'agent', '${OAG}')`);
  assert.equal(pres(zApp, `v2:pr:${O}`), true, '그 주인의 에이전트가 있는 방을 읽는 사람');
  db.sql(`update public.msgr2_room_members set removed_at = now() where room_id = '${ZR}' and member_kind = 'agent'`);
  assert.equal(pres(zApp, `v2:pr:${O}`), false, '에이전트가 빠지면 못 받는다');
  assert.equal(track(oRun, `v2:pr:${O}`), true, '주인의 본체 기기');
  assert.equal(track(oApp, `v2:pr:${O}`), false, '앱 기기는 track 못 한다');
  assert.equal(track(xApp, `v2:pr:${O}`), false, '남');
});
