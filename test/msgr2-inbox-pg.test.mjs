// 메신저 단순화 1단계 — 대화 목록을 한 번에 읽는 msgr2_inbox(20261022160000)를 실제 Postgres에서 본다.
// 경우: 개인 1:1·여러 명 방·조직 채널 혼합(1번 호출로 전부, 주인 표시), 조직 2개, 조직 탈퇴 뒤 빠짐, 남의 방 0(방마다 msgr2_access와 대조),
// 무료 = msgr2_pro_required, 기기 없음 거절, 중단 중 빈 결과, 방 1,000개 상한·쪽 넘김·인덱스, 쓰기 0, 되돌림.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-inbox-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-inbox-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261022160000_msgr2_inbox.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261022160000_msgr2_inbox.down.sql', import.meta.url));
const U = { A: 'd1000000-0000-4000-8000-00000000000a', B: 'd1000000-0000-4000-8000-00000000000b', C: 'd1000000-0000-4000-8000-00000000000c', F: 'd1000000-0000-4000-8000-00000000000f', Z: 'd1000000-0000-4000-8000-0000000000ee' };
let db, a, b, c, f, z; const S = {}; const R = {}; let AG;

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const id = () => db.sql('select gen_random_uuid()');
const space = (kind, owner, name = '') => db.sql('insert into public.msgr2_spaces (kind, name, owner_user_id) values (' + q(kind) + ', ' + q(name) + ', ' + q(owner) + ') returning id');
const smember = (sp, u, role = 'member') => db.sql('insert into public.msgr2_space_members (space_id, user_id, role) values (' + q(sp) + ', ' + q(u) + ', ' + q(role) + ')');
const room = (sp, kind, name, users, { agents = [], pair = null, archived = false, at = null } = {}) => {
  const r = db.sql('insert into public.msgr2_rooms (space_id, kind, name, pair_key, archived_at, created_at) values (' + q(sp) + ', ' + q(kind) + ', ' + q(name) + ', ' + (pair ? q(pair) : 'null') + ', ' + (archived ? 'now()' : 'null') + ', ' + (at ? q(at) : 'now()') + ') returning id');
  for (const u of users) db.sql('insert into public.msgr2_room_members (room_id, member_kind, member_id) values (' + q(r) + ', ' + q('user') + ', ' + q(u) + ')');
  for (const g of agents) db.sql('insert into public.msgr2_room_members (room_id, member_kind, member_id) values (' + q(r) + ', ' + q('agent') + ', ' + q(g) + ')');
  return r;
};
const say = (r, who, body, { kind = 'text', agent = false, at = null } = {}) => {
  const ak = agent ? 'agent' : kind === 'system' ? 'system' : 'user';
  const col = agent ? 'author_agent_id' : 'author_user_id';
  return db.sql('insert into public.msgr2_messages (room_id, author_kind, ' + col + ', kind, body, created_at) values (' + q(r) + ', ' + q(ak) + ', ' + (kind === 'system' ? 'null' : q(who)) + ', ' + q(kind) + ', ' + q(body) + ', ' + (at ? q(at) : 'clock_timestamp()') + ') returning id');
};
const inbox = (dev, args = '') => JSON.parse(db.as(dev.uid, dev.sid, "select coalesce(json_agg(t), '[]') from public.msgr2_inbox(" + args + ') t'));
const setting = (k, v) => db.sql(v == null ? 'delete from public.msgr_settings where key = ' + q(k) : 'insert into public.msgr_settings values (' + q(k) + ', ' + q(v) + ') on conflict (key) do update set value = excluded.value');
const accessRead = (dev, r) => db.as(dev.uid, dev.sid, 'select coalesce((public.msgr2_access(' + q(r) + ')).read, false)') === 't';
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

before(() => {
  if (!DB) return;
  db = setup(DB);
  db.sql('create table if not exists public.msgr_user_blocks (blocker uuid not null, blocked uuid, created_at timestamptz not null default now()); '
    + 'create table if not exists public.test_pro (uid uuid primary key); '
    + 'create or replace function public.is_pro_for(p uuid) returns boolean language sql stable as $f$ select exists (select 1 from public.test_pro where uid = p) $f$; '
    + 'insert into public.test_pro values (' + [U.A, U.B, U.C, U.Z].map(q).join('), (') + ') on conflict do nothing');
  setting('msgr2_pro_gate', null); // 운영 기본(켬) — F는 무료
  a = seedDevice(db, U.A, 'app'); b = seedDevice(db, U.B, 'app'); c = seedDevice(db, U.C, 'app'); f = seedDevice(db, U.F, 'app'); z = seedDevice(db, U.Z, 'app');
  S.PA = space('personal', U.A); S.PB = space('personal', U.B); S.PC = space('personal', U.C);
  S.T1 = space('team', U.B, 'Beyond 팀'); S.T2 = space('team', U.A, 'Lumen 연구'); S.T3 = space('team', U.C, 'Orbit 마케팅');
  smember(S.T1, U.B, 'owner'); smember(S.T1, U.A); smember(S.T2, U.A, 'owner'); smember(S.T2, U.B); smember(S.T3, U.C, 'owner');
  AG = db.sql('insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values (' + q(U.A) + ", 'ws', 'research', '리서치') returning id");
  R.agentDm = room(S.PA, 'direct', '', [U.A], { agents: [AG], pair: 'a:' + AG, at: ago(300) });
  R.friendDm = room(S.PB, 'direct', '', [U.B, U.A], { pair: 'p:' + U.A + ':' + U.B, at: ago(290) }); // 친구가 연 1:1(친구 개인 공간)
  R.group = room(S.PA, 'private', '주말 모임', [U.A, U.B], { at: ago(280) });
  R.t1open = room(S.T1, 'open', '일반', [U.A, U.B], { agents: [AG], at: ago(270) });
  R.t1priv = room(S.T1, 'private', '기획', [U.A, U.B], { at: ago(260) });
  R.t1notJoined = room(S.T1, 'open', '공지', [U.B], { at: ago(250) }); // 읽을 수는 있지만 들어가지 않은 open 방 — 목록 밖(둘러보기)
  R.t2open = room(S.T2, 'open', '연구', [U.A], { at: ago(240) });
  R.archived = room(S.T2, 'private', '옛 방', [U.A], { archived: true, at: ago(230) });
  R.others = room(S.T3, 'private', '남의 방', [U.C], { at: ago(220) });
  R.othersPersonal = room(S.PC, 'private', 'C 혼자', [U.C], { at: ago(210) });
  R.empty = room(S.PA, 'private', '빈 방', [U.A], { at: ago(5) });
  say(R.agentDm, AG, '요약 끝났어요', { agent: true, at: ago(30) });
  say(R.friendDm, U.B, '안녕하세요', { at: ago(20) });
  say(R.group, U.A, '토요일 어때요', { at: ago(40) });
  say(R.t1open, U.B, '회의 10시', { at: ago(15) }); say(R.t1open, U.B, '자료 올렸어요', { at: ago(14) });
  say(R.t1priv, U.B, '기획안 v2', { at: ago(50) });
  say(R.t2open, U.A, '내 글', { at: ago(60) });
  say(R.others, U.C, '비밀', { at: ago(1) });
  db.sql('insert into public.msgr2_prefs (room_id, user_id, pinned) values (' + q(R.t2open) + ', ' + q(U.A) + ', true)');
});

test('혼합: 1번 호출로 내 방 전부(개인 1:1·친구 1:1·여러 명 방·조직 채널 2곳), 주인 표시·상대·안 읽음·마지막 글', { skip }, () => {
  const rows = inbox(a);
  assert.deepEqual(new Set(rows.map((r) => r.room_id)), new Set([R.agentDm, R.friendDm, R.group, R.t1open, R.t1priv, R.t2open, R.empty]));
  assert.equal(rows[0].room_id, R.t2open, '고정이 맨 위');
  assert.deepEqual(rows.slice(1).map((r) => r.room_id), [R.empty, R.t1open, R.friendDm, R.agentDm, R.group, R.t1priv], '나머지는 마지막 활동 최신순(글 없는 방은 만든 시각)');
  const by = Object.fromEntries(rows.map((r) => [r.room_id, r]));
  assert.equal(by[R.t1open].space_name, 'Beyond 팀'); assert.equal(by[R.t1priv].space_name, 'Beyond 팀'); assert.equal(by[R.t2open].space_name, 'Lumen 연구');
  for (const k of [R.agentDm, R.friendDm, R.group, R.empty]) { assert.equal(by[k].space_kind, 'personal'); assert.equal(by[k].space_name, null, '개인 방은 주인 표시 없음'); }
  assert.deepEqual([by[R.agentDm].peer_kind, by[R.agentDm].peer_id], ['agent', AG]);
  assert.deepEqual([by[R.friendDm].peer_kind, by[R.friendDm].peer_id], ['user', U.B]);
  assert.equal(by[R.group].peer_kind, null, '여러 명 방은 상대 없음');
  assert.deepEqual([by[R.t1open].users, by[R.t1open].agents], [2, 1]);
  assert.equal(by[R.t1open].unread, 2); assert.equal(by[R.t1open].last_preview, '자료 올렸어요');
  assert.equal(by[R.t2open].unread, 0, '내 글은 안 읽음이 아니다');
  assert.equal(by[R.empty].last_id, null); assert.equal(by[R.empty].unread, 0);
  for (const r of rows) assert.ok(accessRead(a, r.room_id), 'msgr2_access와 같은 판정: ' + r.room_name);
});

test('남의 방 0: 멤버가 아닌 방·읽을 수만 있는 open 방·보관 방·남의 개인 방은 나오지 않는다 / C는 자기 방만', { skip }, () => {
  const ids = new Set(inbox(a).map((r) => r.room_id));
  for (const k of ['t1notJoined', 'archived', 'others', 'othersPersonal']) assert.ok(!ids.has(R[k]), k);
  assert.deepEqual(new Set(inbox(c).map((r) => r.room_id)), new Set([R.others, R.othersPersonal]));
  assert.deepEqual(inbox(z), [], '방이 없는 Pro는 빈 목록');
});

test('안 읽음·미리보기: 읽음 표시 뒤만 세고, 차단한 사람 글은 세지도 보이지도 않는다, 시스템 글은 미리보기 없음', { skip }, () => {
  db.as(a.uid, a.sid, 'select public.msgr2_mark_read(' + q(R.t1open) + ', (select max(id) from public.msgr2_messages where room_id = ' + q(R.t1open) + '))');
  let row = inbox(a).find((r) => r.room_id === R.t1open);
  assert.equal(row.unread, 0);
  db.sql('insert into public.msgr_user_blocks (blocker, blocked) values (' + q(U.A) + ', ' + q(U.B) + ')');
  try {
    row = inbox(a).find((r) => r.room_id === R.friendDm);
    assert.equal(row.unread, 0); assert.equal(row.last_preview, null, '차단한 사람의 마지막 글은 미리보기에 없다');
  } finally { db.sql('delete from public.msgr_user_blocks where blocker = ' + q(U.A)); }
  say(R.group, null, '', { kind: 'system' });
  row = inbox(a).find((r) => r.room_id === R.group);
  assert.equal(row.last_kind, 'system'); assert.equal(row.last_preview, null); assert.equal(row.unread, 0, '시스템 글은 세지 않는다');
});

test('조직 탈퇴 뒤: 그 조직 방이 바로 빠지고(다른 조직·개인 방은 그대로), 손님 만료·방 나가기도 같다', { skip }, () => {
  db.sql('update public.msgr2_space_members set removed_at = now() where space_id = ' + q(S.T1) + ' and user_id = ' + q(U.A));
  try {
    const ids = new Set(inbox(a).map((r) => r.room_id));
    assert.ok(!ids.has(R.t1open) && !ids.has(R.t1priv), 'T1 방 빠짐');
    assert.ok(ids.has(R.t2open) && ids.has(R.agentDm) && ids.has(R.group), '나머지 그대로');
    assert.equal(accessRead(a, R.t1priv), false, 'msgr2_access도 거짓');
  } finally { db.sql('update public.msgr2_space_members set removed_at = null where space_id = ' + q(S.T1) + ' and user_id = ' + q(U.A)); }
  db.sql("update public.msgr2_space_members set role = 'guest', expires_at = now() - interval '1 minute' where space_id = " + q(S.T2) + ' and user_id = ' + q(U.A));
  try { assert.ok(!inbox(a).some((r) => r.room_id === R.t2open), '만료 손님'); }
  finally { db.sql("update public.msgr2_space_members set role = 'owner', expires_at = null where space_id = " + q(S.T2) + ' and user_id = ' + q(U.A)); }
  db.sql('update public.msgr2_room_members set removed_at = now() where room_id = ' + q(R.group) + ' and member_id = ' + q(U.A));
  try { assert.ok(!inbox(a).some((r) => r.room_id === R.group), '방에서 나가면 빠짐'); }
  finally { db.sql('update public.msgr2_room_members set removed_at = null where room_id = ' + q(R.group) + ' and member_id = ' + q(U.A)); }
});

test('무료 = msgr2_pro_required(관문 off면 통과), 기기 없음 = msgr2_device_invalid, 중단 중 빈 결과, 잘못된 쪽 표지·anon 거절', { skip }, () => {
  assert.match(db.asErr(f.uid, f.sid, 'select * from public.msgr2_inbox()') ?? '', /msgr2_pro_required/);
  setting('msgr2_pro_gate', 'off');
  try { assert.deepEqual(inbox(f), []); } finally { setting('msgr2_pro_gate', null); }
  assert.match(db.asErr(U.A, id(), 'select * from public.msgr2_inbox()') ?? '', /msgr2_device_invalid/);
  setting('msgr2_paused', new Date().toISOString());
  try { assert.deepEqual(inbox(a), []); } finally { setting('msgr2_paused', null); }
  assert.match(db.asErr(a.uid, a.sid, 'select * from public.msgr2_inbox(10, null, now(), null)') ?? '', /msgr2_inbox_cursor/);
  assert.match(db.asErr(U.A, a.sid, 'set role anon; select * from public.msgr2_inbox()') ?? '', /permission denied/, 'anon 실행 권한 없음');
});

test('읽기만: 목록을 여러 번 읽어도 방·멤버·글·읽음·설정·기기 표 쓰기 0(xmin 그대로)', { skip }, () => {
  const snap = () => ['msgr2_rooms', 'msgr2_room_members', 'msgr2_messages', 'msgr2_reads', 'msgr2_prefs', 'msgr2_devices'].map((tb) => db.xmins(tb)).join('|');
  const s0 = snap(); inbox(a); inbox(a); inbox(b); assert.equal(snap(), s0);
});

test('방 1,000개: 한 번에 200개(상한), 쪽 넘김으로 겹침·빠짐 없이 전부, 인덱스로 읽는다(EXPLAIN)', { skip }, () => {
  const big = seedDevice(db, 'd1000000-0000-4000-8000-0000000000bb', 'app');
  db.sql('insert into public.test_pro values (' + q(big.uid) + ') on conflict do nothing');
  const sp = space('personal', big.uid);
  db.sql('with r as (insert into public.msgr2_rooms (space_id, kind, name, created_at) select ' + q(sp) + ", 'private', 'r' || g, now() - (g || ' minutes')::interval from generate_series(1, 1000) g returning id) "
    + 'insert into public.msgr2_room_members (room_id, member_kind, member_id) select id, ' + q('user') + ', ' + q(big.uid) + ' from r; '
    // 운영처럼 다른 사람 행이 훨씬 많다(방마다 20명 = 2만 행) — 내 행이 표의 대부분이면 계획기가 표 전체 읽기를 고르는 것이 맞아 인덱스 확인이 안 된다
    + 'insert into public.msgr2_room_members (room_id, member_kind, member_id) select r.id, ' + q('user') + ', gen_random_uuid() from public.msgr2_rooms r cross join generate_series(1, 20) where r.space_id = ' + q(sp) + '; '
    + 'insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, created_at) select r.id, ' + q('user') + ', ' + q(U.Z) + ", 'm', now() - (row_number() over (order by r.name) || ' seconds')::interval from public.msgr2_rooms r where r.space_id = " + q(sp) + " and right(r.name, 1) in ('1', '3', '5'); analyze");
  assert.equal(inbox(big, '999').length, 200, '상한 200');
  const seen = []; let cur = '';
  for (let i = 0; i < 10; i++) {
    const page = inbox(big, cur ? '200, ' + cur : '200');
    seen.push(...page.map((r) => r.room_id));
    if (page.length < 200) break;
    const l = page.at(-1); cur = l.pinned + ', ' + q(l.last_at) + '::timestamptz, ' + q(l.room_id);
  }
  assert.equal(seen.length, 1000); assert.equal(new Set(seen).size, 1000, '겹침 없음');
  const plan = db.sql('explain (costs off) select r.id from public.msgr2_room_members m join public.msgr2_rooms r on r.id = m.room_id '
    + 'left join lateral (select x.id from public.msgr2_messages x where x.room_id = r.id and x.deleted_at is null order by x.id desc limit 1) lm on true '
    + "where m.member_kind = 'user' and m.member_id = " + q(big.uid) + ' and m.removed_at is null');
  assert.match(plan, /msgr2_room_members_member/, plan);
  assert.match(plan, /msgr2_messages_room/, plan);
  console.log('# EXPLAIN\n' + plan.split('\n').map((l) => '# ' + l).join('\n'));
  const ms = db.as(big.uid, big.sid, 'select extract(milliseconds from clock_timestamp() - now())::int from (select count(*) from public.msgr2_inbox(200)) q');
  console.log('# 방 1,000개 사용자 첫 쪽 200개: 함수 실행 ' + ms + 'ms(임시 PG, 맥 two)');
});

test('되돌림: down 파일을 적용하면 함수가 없고, 다시 적용하면 같은 결과', { skip }, () => {
  const beforeRows = inbox(a).map((r) => r.room_id);
  db.psql(['-v', 'ON_ERROR_STOP=1', '-c', readFileSync(DOWN, 'utf8')]);
  assert.equal(db.sql("select to_regprocedure('public.msgr2_inbox(int, boolean, timestamptz, uuid)') is null"), 't');
  db.psql(['-v', 'ON_ERROR_STOP=1', '-c', readFileSync(MIG, 'utf8')]);
  assert.deepEqual(inbox(a).map((r) => r.room_id), beforeRows);
});
