// 메신저 v2 U6d(방·공간·초대·안 읽음·검색·1:1 목록·방 설정·신고, *_msgr2_rooms.sql) PG 시험 본문 — 두 판에서 같은 칸을 돈다.
//   'msgr2': U1 → U3 → U2 → U2b → U6d만 적용(옛 표는 친구·차단·프로필 최소 대역). 시작할 때 U6d 적용 → 되돌림 = 적용 전도 본다.
//   'full' : 옛 msgr 전체 + msgr2를 운영 순서로(setupFull) — 옛 중단 장치가 켜진 상태(운영과 같다)에서 돌린다. 옛 표 접점(중단 통과·FK·신고)은 이 판에서만.
// 변이 시험: 환경 변수 MSGR2_ROOMS_MUT='<찾을 문자열>|||<바꿀 문자열>'이면 U6d 본문을 그렇게 바꿔 적용한다(빨강 확인용).
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { setupBase, setupFull, seedDevice, migText } from './msgr2-work-pg.mjs';

const migDir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
export const ROOMS_FILE = readdirSync(migDir).filter((f) => f.endsWith('_msgr2_rooms.sql')).sort().pop();
export const DOWN_FILE = fileURLToPath(new URL(`../../scripts/rollback/${ROOMS_FILE.replace(/\.sql$/, '.down.sql')}`, import.meta.url));
export function roomsText() {
  let t = migText(ROOMS_FILE);
  const mut = process.env.MSGR2_ROOMS_MUT;
  if (mut) { const [a, b] = mut.split('|||'); if (!t.includes(a)) throw new Error(`변이 대상 없음: ${a}`); t = t.split(a).join(b); }
  return t;
}

// 되돌림 비교용 스냅숏(public 함수·트리거·열·정책·타입·제약·인덱스)
export function snapshot(db) {
  return {
    procs: db.sql(`select p.oid::regprocedure::text || '|' || md5(p.prosrc) || '|' || coalesce(p.proacl::text, '-') || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '-')
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
                     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') order by 1`).split('\n'),
    triggers: db.sql(`select tgrelid::regclass::text || ':' || tgname::text || ':' || tgfoid::regprocedure::text || ':' || tgenabled::text from pg_trigger where not tgisinternal order by 1`).split('\n'),
    columns: db.sql(`select table_name || '.' || column_name || ':' || data_type from information_schema.columns where table_schema = 'public' order by 1`).split('\n'),
    policies: db.sql(`select schemaname || '.' || tablename || ':' || policyname || ':' || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) from pg_policies where schemaname in ('public', 'storage', 'realtime') order by 1`).split('\n'),
    constraints: db.sql(`select conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) || ':' || convalidated::text from pg_constraint where connamespace = 'public'::regnamespace order by 1`).split('\n'),
    acl: db.sql(`select relname || ':' || coalesce(relacl::text, '-') from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`).split('\n'),
    indexes: db.sql(`select indexrelid::regclass::text || ':' || pg_get_indexdef(indexrelid) from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' order by 1`).split('\n'),
  };
}

// msgr2 파일을 버전 순서로 적용하되 U6d(이 파일)만 뺀다 — 적용 전·후를 비교하려고(setup()은 U2b 뒤 파일을 모두 적용한다)
function setupWithoutRooms(DB) {
  const db = setupBase(DB);
  // U6d 뒤의 후속 파일 가운데 U6d 초대 표에 기대는 것(예: 061300 초대 취소 방송 — 함수가 msgr2_space_invites 타입을 쓴다)은 U6d 없이 만들 수 없다 →
  // 이 판(U6d 적용 전·되돌림 비교)에서는 뺀다. 그 파일은 운영 순서 전체 판(setupFull)을 쓰는 자기 시험이 따로 본다(test/msgr2-invite-revoke-pg.test.mjs).
  const needsRooms = (x) => x > ROOMS_FILE && /msgr2_space_invites/.test(migText(x));
  for (const f of readdirSync(migDir).filter((x) => /^\d+_msgr2_.*\.sql$/.test(x) && x !== ROOMS_FILE && !needsRooms(x)).sort()) db.psql(['-c', migText(f)]);
  return db;
}

const LEGACY_STUB = `
create table if not exists public.msgr_friends (a uuid not null, b uuid not null, status text not null default 'pending', requested_by uuid not null, primary key (a, b), check (a < b));
create table if not exists public.msgr_user_blocks (blocker uuid not null, blocked uuid, created_at timestamptz not null default now());
create table if not exists public.msgr_profiles (user_id uuid primary key, display_name text);`;

const id = (n) => `6d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = { O: id(1), A: id(2), M: id(3), G: id(4), F: id(5), X: id(6), B: id(7), N: id(8), E: id(9), F2: id(10), Q: id(11), K: id(12), W: id(13), W2: id(14), Z: id(15), K2: id(16) };
const pair = (x, y) => (x < y ? [x, y] : [y, x]);

export function run(mode) {
  const DB = process.env.ARGO_PG_TEST_URL;
  const file = mode === 'full' ? 'test/msgr2-rooms-legacy-combo-pg.test.mjs' : 'test/msgr2-rooms-pg.test.mjs';
  const skip = !DB && `ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh ${file}`;
  const full = mode === 'full';
  let db; const d = {}; let TEAM, OPEN, PRIV, AG_O, AG_M, AG_X;
  const J = (who, q) => JSON.parse(db.as(who.uid, who.sid, `select (${q})::text`));
  const V = (who, q) => db.as(who.uid, who.sid, `select (${q})::text`);
  const E = (who, q) => db.asErr(who.uid, who.sid, `select ${q}`) ?? '';
  const rows = (who, q) => { const s = db.as(who.uid, who.sid, `select coalesce(json_agg(t), '[]')::text from (${q}) t`); return JSON.parse(s); };
  const friend = (x, y) => { const [a, b] = pair(x, y); db.sql(`insert into public.msgr_friends (a, b, status, requested_by) values ('${a}', '${b}', 'accepted', '${x}') on conflict (a, b) do update set status = 'accepted'`); };
  const block = (x, y) => db.sql(`insert into public.msgr_user_blocks (blocker, blocked) values ('${x}', '${y}')`);
  const canSeeRoom = (who, room) => db.as(who.uid, who.sid, `select count(*) from public.msgr2_rooms where id = '${room}'`) === '1';
  const ALL = ['msgr2_spaces', 'msgr2_space_members', 'msgr2_rooms', 'msgr2_room_members', 'msgr2_reads', 'msgr2_prefs', 'msgr2_space_invites', 'msgr2_agent_seats', 'msgr2_messages'];
  const allX = () => ALL.map((t) => `${t}:${db.sql(`select count(*) || '/' || coalesce(max(xmin::text::bigint), 0) from public.${t}`)}`).join(' ');

  before(() => {
    if (!DB) return;
    if (full) {
      // setupFull은 *_msgr*.sql 전부(U6d 포함)를 이름 순으로 — 변이 시험이면 U6d만 변이본으로 다시 적용한다
      db = setupFull(DB);
      if (process.env.MSGR2_ROOMS_MUT) db.psql(['-c', roomsText()]);
    } else {
      db = setupWithoutRooms(DB);
      db.psql(['-c', LEGACY_STUB]);
      d.base = snapshot(db);
      db.psql(['-c', roomsText()]);
      d.applied = snapshot(db);
      db.psql(['-c', readFileSync(DOWN_FILE, 'utf8')]);
      d.reverted = snapshot(db);
      db.psql(['-c', roomsText()]);
      d.reapplied = snapshot(db);
    }
    for (const [k, v] of Object.entries(U)) { d[k] = seedDevice(db, v, 'app'); db.sql(`update auth.users set email = '${k.toLowerCase()}@ex.com' where id = '${v}'`); }
    d.Orun = seedDevice(db, U.O, 'runner'); d.Orev = seedDevice(db, U.O, 'app', { revoked: true }); d.Oexp = seedDevice(db, U.O, 'app', { expired: true });
    d.Xrun = seedDevice(db, U.X, 'runner');
    d.Oold = { uid: U.O, sid: db.sql('select gen_random_uuid()') }; // 옛 앱 세션(기기 행 없음)
    friend(U.O, U.F); friend(U.O, U.B); friend(U.O, U.F2); block(U.O, U.B);
    if (full) db.sql(`insert into public.msgr_settings (key, value) values ('msgr_paused', '2026-10-16T17:00:00+09:00') on conflict (key) do nothing`); // 운영과 같이 옛 중단 켬(시드 뒤)
    AG_O = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${U.O}', 'w', 'helper', '도우미') returning id`);
    AG_M = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${U.M}', 'w', 'mbot', '멤버봇') returning id`);
    AG_X = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${U.X}', 'w', 'xbot', '남의봇') returning id`);
    // 팀 공간: O 주인, 초대로 A(admin)·M(member)·G(guest, PRIV만)·E(손님, 곧 만료)
    TEAM = V(d.O, `public.msgr2_space_create('팀 알파', 'team-alpha')`);
    OPEN = V(d.O, `public.msgr2_room_create('${TEAM}', 'open', '일반')`);
    PRIV = V(d.O, `public.msgr2_room_create('${TEAM}', 'private', '비밀')`);
    for (const [who, role] of [['A', 'admin'], ['M', 'member']]) {
      const inv = J(d.O, `public.msgr2_invite_create('${TEAM}', '${role}', '${U[who]}')`);
      J(d[who], `public.msgr2_invite_accept('${inv.code}')`);
    }
    const g = J(d.O, `public.msgr2_invite_create('${TEAM}', 'guest', '${U.G}', array['${PRIV}']::uuid[], 1, 604800, 30)`);
    J(d.G, `public.msgr2_invite_accept('${g.code}')`);
    const e = J(d.O, `public.msgr2_invite_create('${TEAM}', 'guest', '${U.E}', array['${PRIV}']::uuid[], 1, 604800, 1)`);
    J(d.E, `public.msgr2_invite_accept('${e.code}')`);
    db.sql(`update public.msgr2_space_members set expires_at = now() - interval '1 minute' where user_id = '${U.E}'`); // 손님 기한 지남
    V(d.O, `public.msgr2_room_members_add('${PRIV}', array['${U.M}']::uuid[])`);
    db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id) values ('${AG_M}', '${TEAM}')`);
  });

  if (!full) {
    test('되돌림(msgr2 판) — U6d 적용 → 되돌림 = 적용 전, 다시 적용 = 처음 적용', { skip }, () => {
      assert.notDeepEqual(d.applied, d.base, '적용하면 달라진다');
      assert.deepEqual(d.reverted, d.base);
      assert.deepEqual(d.reapplied, d.applied);
    });
  }

  test('공간 만들기 — 앱 기기만(runner·폐기·만료·옛 세션 42501), 같은 slug 거부, 주인 멤버 1행', { skip }, () => {
    for (const who of [d.Orun, d.Orev, d.Oexp, d.Oold]) assert.match(E(who, `public.msgr2_space_create('x')`), /msgr2_app_device_required/);
    assert.match(E(d.X, `public.msgr2_space_create('y', 'team-alpha')`), /msgr2_slug_taken/);
    assert.match(E(d.X, `public.msgr2_space_create('   ')`), /msgr2_bad_name/);
    assert.equal(db.sql(`select string_agg(user_id || ':' || role, ',' order by role) from public.msgr2_space_members where space_id = '${TEAM}' and role = 'owner'`), `${U.O}:owner`);
    if (full) {
      assert.equal(db.sql(`select count(*) from public.msgr_orgs where id = '${TEAM}' and owner_user_id = '${U.O}'`), '1', '같은 id의 옛 조직 행(요금·문서 FK)');
      assert.equal(db.sql(`select count(*) from public.msgr_org_entitlements where org_id = '${TEAM}'`), '1');
      // 옛 앱 경로(사용자가 msgr_orgs에 직접 넣기)는 중단 중 계속 막힌다
      assert.match(db.asErr(U.O, d.Oold.sid, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('옛', 'old-path-1', '${U.O}')`) ?? '', /messenger service paused/);
      assert.match(db.asErr(U.O, d.O.sid, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('옛', 'old-path-2', '${U.O}')`) ?? '', /messenger service paused/, 'v2 앱 세션이어도 직접 넣기는 막힘(트랜잭션 표지 없음)');
    }
  });

  test('개인 공간 1인 1개 — 방 만들기·1:1 열기를 여러 번 해도 개인 공간 행은 하나', { skip }, () => {
    V(d.O, `public.msgr2_room_create(null, 'private', '메모')`);
    V(d.O, `public.msgr2_my_personal_space()`);
    assert.equal(db.sql(`select count(*) from public.msgr2_spaces where owner_user_id = '${U.O}' and kind = 'personal'`), '1');
  });

  test('초대 — 권한(멤버·손님 못 만듦, admin은 admin 초대 못 함), 남의 사람 초대·틀린 코드는 not_found, 만료·취소·소진, 차단은 unavailable', { skip }, () => {
    assert.match(E(d.M, `public.msgr2_invite_create('${TEAM}', 'member')`), /msgr2_forbidden/);
    assert.match(E(d.G, `public.msgr2_invite_create('${TEAM}', 'member')`), /msgr2_forbidden/);
    assert.match(E(d.A, `public.msgr2_invite_create('${TEAM}', 'admin')`), /msgr2_forbidden/);
    assert.match(E(d.Orun, `public.msgr2_invite_create('${TEAM}', 'member')`), /msgr2_app_device_required/);
    assert.match(E(d.O, `public.msgr2_invite_create('${TEAM}', 'member', '${U.B}')`), /msgr2_invite_unavailable/, 'O가 B를 차단');
    assert.match(E(d.O, `public.msgr2_invite_create('${TEAM}', 'guest', null, '{}'::uuid[], 1, 604800, 3)`), /msgr2_bad_invite/, '손님은 방 1개 이상');
    const t = J(d.A, `public.msgr2_invite_create('${TEAM}', 'member', '${U.N}')`);
    assert.match(E(d.X, `public.msgr2_invite_preview('${t.code}')`), /msgr2_invite_not_found/, '남에게 온 초대');
    assert.match(E(d.X, `public.msgr2_invite_accept('${t.code}')`), /msgr2_invite_not_found/);
    assert.match(E(d.X, `public.msgr2_invite_preview('nope')`), /msgr2_invite_not_found/);
    assert.equal(rows(d.N, 'select * from public.msgr2_my_invites()').length, 1, 'N의 초대함');
    assert.equal(J(d.A, `public.msgr2_invite_create('${TEAM}', 'member', '${U.N}')`).existing, true, '같은 사람 재초대 = 같은 초대(쓰기 0)');
    assert.equal(V(d.N, `public.msgr2_invite_decline('${t.code}')`), 'true');
    assert.match(E(d.N, `public.msgr2_invite_accept('${t.code}')`), /msgr2_invite_declined/);
    const link = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', null, '{}'::uuid[], 1)`);
    assert.equal(J(d.Q, `public.msgr2_invite_preview('${link.code}')`).state, 'valid');
    assert.equal(J(d.Q, `public.msgr2_invite_accept('${link.code}')`).already_member, false);
    assert.match(E(d.X, `public.msgr2_invite_accept('${link.code}')`), /msgr2_invite_exhausted/, '1회용 소진');
    const exp = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', null, '{}'::uuid[], 5, 60)`);
    db.sql(`update public.msgr2_space_invites set expires_at = now() - interval '1 second' where id = '${exp.invite_id}'`);
    assert.match(E(d.X, `public.msgr2_invite_accept('${exp.code}')`), /msgr2_invite_expired/);
    const rv = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', null, '{}'::uuid[], 5)`);
    assert.match(E(d.M, `public.msgr2_invite_revoke('${rv.invite_id}')`), /msgr2_invite_not_found/, '멤버는 남의 초대를 못 취소');
    assert.equal(V(d.O, `public.msgr2_invite_revoke('${rv.invite_id}')`), 'true');
    assert.match(E(d.X, `public.msgr2_invite_accept('${rv.code}')`), /msgr2_invite_revoked/);
    assert.equal(rows(d.M, `select * from public.msgr2_invites_list('${TEAM}')`).length, 0, '멤버는 초대 목록 못 봄');
    assert.ok(rows(d.A, `select * from public.msgr2_invites_list('${TEAM}')`).length >= 4);
    // 만든 사람이 강등되면 그 초대는 revoked로 본다
    const ad = J(d.A, `public.msgr2_invite_create('${TEAM}', 'member', null, '{}'::uuid[], 5)`);
    V(d.O, `public.msgr2_set_member_role('${TEAM}', '${U.A}', 'member')`);
    assert.match(E(d.X, `public.msgr2_invite_accept('${ad.code}')`), /msgr2_invite_revoked/);
    V(d.O, `public.msgr2_set_member_role('${TEAM}', '${U.A}', 'admin')`);
    // Q 정리(뒤 시험의 구성 유지)
    V(d.Q, `public.msgr2_space_leave('${TEAM}')`);
  });

  test('손님 — 초대에 든 방만 읽고, open 방·다른 비공개 방·둘러보기는 못 본다. 기한 지난 손님은 아무것도 못 본다', { skip }, () => {
    assert.equal(canSeeRoom(d.G, PRIV), true);
    assert.equal(canSeeRoom(d.G, OPEN), false);
    assert.equal(rows(d.G, `select * from public.msgr2_rooms_browse('${TEAM}', true)`).length, 0);
    assert.match(E(d.G, `public.msgr2_room_create('${TEAM}', 'private', '손님방')`), /msgr2_forbidden/);
    assert.equal(canSeeRoom(d.E, PRIV), false, '만료 손님');
    assert.equal(rows(d.E, 'select * from public.msgr2_unread()').length, 0);
  });

  test('방 만들기 — 팀은 공간 멤버만 넣고, 개인은 친구(차단 아님)만, open은 팀만, 1:1은 전용 RPC', { skip }, () => {
    assert.match(E(d.O, `public.msgr2_room_create('${TEAM}', 'private', 'p', array['${U.X}']::uuid[])`), /msgr2_not_space_member/);
    assert.match(E(d.O, `public.msgr2_room_create('${TEAM}', 'private', 'p', array['${U.E}']::uuid[])`), /msgr2_not_space_member/, '만료 손님');
    assert.match(E(d.O, `public.msgr2_room_create(null, 'private', 'p', array['${U.X}']::uuid[])`), /msgr2_not_friend/);
    assert.match(E(d.O, `public.msgr2_room_create(null, 'private', 'p', array['${U.B}']::uuid[])`), /msgr2_not_friend/, '차단한 친구');
    assert.match(E(d.O, `public.msgr2_room_create(null, 'open', 'p')`), /msgr2_bad_kind/);
    assert.match(E(d.O, `public.msgr2_room_create('${TEAM}', 'direct', 'p')`), /msgr2_bad_kind/);
    assert.match(E(d.X, `public.msgr2_room_create('${TEAM}', 'private', 'p')`), /msgr2_forbidden/, '공간 밖 사람');
    assert.match(E(d.Orun, `public.msgr2_room_create('${TEAM}', 'private', 'p')`), /msgr2_app_device_required/);
    const grp = V(d.O, `public.msgr2_room_create(null, 'private', '친구방', array['${U.F}']::uuid[], array['${AG_O}']::uuid[])`);
    assert.equal(canSeeRoom(d.F, grp), true); assert.equal(canSeeRoom(d.X, grp), false);
    assert.match(E(d.O, `public.msgr2_room_create('${TEAM}', 'private', 'p', '{}'::uuid[], array['${AG_O}']::uuid[])`), /msgr2_agent_not_allowed/, '파견 없는 팀 공간');
    assert.match(E(d.O, `public.msgr2_room_create(null, 'private', 'p', '{}'::uuid[], array['${AG_X}']::uuid[])`), /msgr2_agent_not_allowed/, '남의 에이전트');
  });

  test('1:1 — 개인은 친구만·짝당 하나(양쪽에서 열어도 1방, 동시 2건도 1방), 차단·남·자기 자신은 unavailable, 팀은 둘 다 멤버', { skip }, async () => {
    const a = J(d.O, `public.msgr2_dm_open('${U.F}')`); const b = J(d.F, `public.msgr2_dm_open('${U.O}')`);
    assert.equal(a.room_id, b.room_id); assert.equal(a.existing, false); assert.equal(b.existing, true);
    const [p1, p2] = pair(U.O, U.F);
    assert.equal(db.sql(`select count(*) from public.msgr2_rooms where kind = 'direct' and pair_key = 'p:${p1}:${p2}'`), '1');
    for (const t of [U.B, U.X, U.O]) assert.match(E(d.O, `public.msgr2_dm_open('${t}')`), /msgr2_dm_unavailable/);
    assert.match(E(d.B, `public.msgr2_dm_open('${U.O}')`), /msgr2_dm_unavailable/, '차단당한 쪽에서도');
    assert.match(E(d.O, `public.msgr2_dm_open('${U.X}', '${TEAM}')`), /msgr2_dm_unavailable/, '공간 밖');
    assert.match(E(d.O, `public.msgr2_dm_open('${U.E}', '${TEAM}')`), /msgr2_dm_unavailable/, '만료 손님');
    const t1 = J(d.O, `public.msgr2_dm_open('${U.M}', '${TEAM}')`); const t2 = J(d.M, `public.msgr2_dm_open('${U.O}', '${TEAM}')`);
    assert.equal(t1.room_id, t2.room_id);
    assert.equal(canSeeRoom(d.A, t1.room_id), false, '팀 1:1은 두 사람만');
    // 동시: 처음 여는 두 요청이 겹쳐도 방은 하나
    const call = (who, other) => new Promise((res) => {
      const p = spawn('psql', [DB, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'SHOW_ALL_RESULTS=off', '-c',
        db.ctx(who.uid, who.sid) + `select pg_sleep(0.2); select (public.msgr2_dm_open('${other}'))::text`]);
      let out = ''; p.stdout.on('data', (c) => { out += c; }); p.on('close', (code) => res({ code, out: out.trim() }));
    });
    const [r1, r2] = await Promise.all([call(d.O, U.F2), call(d.F2, U.O)]);
    assert.equal(r1.code, 0); assert.equal(r2.code, 0);
    assert.equal(JSON.parse(r1.out).room_id, JSON.parse(r2.out).room_id);
    const [q1, q2] = pair(U.O, U.F2);
    assert.equal(db.sql(`select count(*) from public.msgr2_rooms where pair_key = 'p:${q1}:${q2}'`), '1');
    // 나간 뒤 다시 열면 같은 방(되살림)
    V(d.F, `public.msgr2_room_leave('${a.room_id}')`);
    assert.equal(J(d.O, `public.msgr2_dm_open('${U.F}')`).room_id, a.room_id);
    assert.equal(canSeeRoom(d.F, a.room_id), true);
  });

  test('에이전트 1:1 — 내 에이전트만, 다시 불러도 같은 방(쓰기 0)', { skip }, () => {
    const a = J(d.O, `public.msgr2_agent_dm_open('${AG_O}')`);
    const x0 = allX();
    const b = J(d.O, `public.msgr2_agent_dm_open('${AG_O}')`);
    assert.equal(a.room_id, b.room_id); assert.equal(b.existing, true); assert.equal(allX(), x0);
    assert.match(E(d.O, `public.msgr2_agent_dm_open('${AG_X}')`), /msgr2_agent_not_allowed/);
  });

  test('방 멤버 넣기·빼기 — 초대권(invite)·관리권(manage)은 msgr2_access, 1:1은 사람 고정, 빠진 사람은 못 읽고 그 사람의 에이전트도 빠진다', { skip }, () => {
    const r = V(d.M, `public.msgr2_room_create('${TEAM}', 'private', '멤버방', array['${U.A}']::uuid[], array['${AG_M}']::uuid[])`);
    assert.match(E(d.G, `public.msgr2_room_members_add('${r}', array['${U.O}']::uuid[])`), /msgr2_room_not_found/, '못 읽는 방');
    assert.match(E(d.M, `public.msgr2_room_members_add('${r}', array['${U.X}']::uuid[])`), /msgr2_not_space_member/);
    assert.equal(V(d.M, `public.msgr2_room_members_add('${r}', array['${U.O}']::uuid[])`), '1');
    assert.equal(V(d.M, `public.msgr2_room_members_add('${r}', array['${U.O}']::uuid[])`), '0', '이미 멤버면 0(쓰기 0)');
    assert.match(E(d.M, `public.msgr2_room_member_remove('${r}', 'user', '${U.A}')`), /msgr2_forbidden/, 'member는 manage 아님');
    const dm = J(d.O, `public.msgr2_dm_open('${U.M}', '${TEAM}')`).room_id;
    assert.match(E(d.O, `public.msgr2_room_members_add('${dm}', array['${U.A}']::uuid[])`), /msgr2_direct_fixed/);
    assert.equal(V(d.A, `public.msgr2_room_member_remove('${r}', 'user', '${U.M}')`), 'true');
    assert.equal(canSeeRoom(d.M, r), false);
    assert.equal(db.sql(`select count(*) from public.msgr2_room_members where room_id = '${r}' and member_kind = 'agent' and removed_at is null`), '0', 'M의 에이전트도 빠짐');
    assert.match(E(d.Orun, `public.msgr2_room_member_remove('${r}', 'user', '${U.A}')`), /msgr2_app_device_required/);
  });

  test('공간 나가기·내보내기 — 주인은 못 나감, admin은 admin 못 내보냄, 나간 사람의 방 멤버 행이 닫혀 다시 들어와도 옛 비공개 방은 안 열림', { skip }, () => {
    assert.match(E(d.O, `public.msgr2_space_leave('${TEAM}')`), /msgr2_owner_cannot_leave/);
    const inv = J(d.O, `public.msgr2_invite_create('${TEAM}', 'admin', '${U.N}')`); J(d.N, `public.msgr2_invite_accept('${inv.code}')`);
    assert.match(E(d.A, `public.msgr2_space_member_remove('${TEAM}', '${U.N}')`), /msgr2_forbidden/);
    const r = V(d.O, `public.msgr2_room_create('${TEAM}', 'private', 'N방', array['${U.N}']::uuid[])`);
    assert.equal(canSeeRoom(d.N, r), true);
    assert.equal(V(d.O, `public.msgr2_space_member_remove('${TEAM}', '${U.N}')`), 'true');
    assert.equal(canSeeRoom(d.N, r), false);
    const inv2 = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', '${U.N}')`); J(d.N, `public.msgr2_invite_accept('${inv2.code}')`);
    assert.equal(canSeeRoom(d.N, r), false, '다시 들어와도 옛 비공개 방은 닫혀 있다');
    assert.equal(canSeeRoom(d.N, OPEN), true);
    assert.equal(V(d.N, `public.msgr2_space_leave('${TEAM}')`), 'true');
    assert.equal(V(d.N, `public.msgr2_space_leave('${TEAM}')`), 'false', '이미 나감');
  });

  test('공개 방 둘러보기·참여 — 멤버는 open 방을 보고 참여(두 번째 참여 쓰기 0), 남은 빈 목록·참여 거부', { skip }, () => {
    const list = rows(d.M, `select * from public.msgr2_rooms_browse('${TEAM}')`);
    assert.ok(list.some((x) => x.id === OPEN));
    assert.equal(V(d.M, `public.msgr2_room_join('${OPEN}')`), 'true');
    assert.equal(V(d.M, `public.msgr2_room_join('${OPEN}')`), 'false');
    assert.ok(!rows(d.M, `select * from public.msgr2_rooms_browse('${TEAM}')`).some((x) => x.id === OPEN), '참여한 방은 기본 목록에서 빠짐');
    assert.equal(rows(d.X, `select * from public.msgr2_rooms_browse('${TEAM}', true)`).length, 0);
    assert.match(E(d.X, `public.msgr2_room_join('${OPEN}')`), /msgr2_room_not_found/);
    assert.match(E(d.M, `public.msgr2_room_join('${PRIV}')`), /msgr2_room_not_found/, 'private는 참여 불가');
  });

  test('안 읽음·읽음 표시 — 내 글·시스템 글·차단한 사람 글 제외, 99에서 멈춤, 읽음은 커질 때만 쓴다(xmin 불변), 남의 방은 안 나온다', { skip }, () => {
    const r = V(d.O, `public.msgr2_room_create(null, 'private', '셋', array['${U.F}']::uuid[])`); // B는 차단이라 RPC로는 못 넣는다
    db.as(U.F, d.F.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${r}', 'user', '${U.F}', '하나'), ('${r}', 'user', '${U.F}', '둘')`);
    db.as(U.O, d.O.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${r}', 'user', '${U.O}', '내 글')`);
    db.sql(`insert into public.msgr2_messages (room_id, author_kind, kind, meta) values ('${r}', 'system', 'system', '{"code":"x"}')`);
    // 차단한 사람의 글(방에 직접 넣어 둔 상황 — 차단 전에 들어와 있던 사람)
    db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${r}', 'user', '${U.B}')`);
    db.sql(`insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${r}', 'user', '${U.B}', '차단된 사람')`);
    const u = rows(d.O, `select * from public.msgr2_unread() where room_id = '${r}'`)[0];
    assert.equal(u.n, 2);
    assert.equal(rows(d.F, `select * from public.msgr2_unread() where room_id = '${r}'`)[0].n, 2, 'F: O 글 + B 글(F는 B를 차단하지 않음), 시스템 글 제외');
    assert.equal(rows(d.X, `select * from public.msgr2_unread() where room_id = '${r}'`).length, 0);
    assert.equal(V(d.O, `public.msgr2_mark_read('${r}', ${u.last_id})`), String(u.last_id));
    const x0 = db.xmins('msgr2_reads', `room_id = '${r}'`);
    V(d.O, `public.msgr2_mark_read('${r}', ${u.last_id})`); V(d.O, `public.msgr2_mark_read('${r}', ${u.last_id - 1})`);
    assert.equal(db.xmins('msgr2_reads', `room_id = '${r}'`), x0, '같거나 작은 값은 쓰기 0');
    assert.equal(V(d.O, `public.msgr2_mark_read('${r}', ${u.last_id + 1000})`), String(u.last_id), '마지막 글 id를 넘지 않는다');
    assert.equal(rows(d.O, `select * from public.msgr2_unread() where room_id = '${r}'`)[0].n, 0);
    db.sql(`insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) select '${r}', 'user', '${U.F}', 'm' || g from generate_series(1, 150) g`);
    assert.equal(rows(d.O, `select * from public.msgr2_unread() where room_id = '${r}'`)[0].n, 99);
    assert.match(E(d.X, `public.msgr2_mark_read('${r}', 1)`), /msgr2_room_not_found/);
    // 읽음 행은 RPC로만, updated_at은 서버 시각(휴대폰 알림 #1081의 "보는 중" 판정이 이 열을 믿는다)
    assert.match(db.asErr(U.O, d.O.sid, `update public.msgr2_reads set updated_at = now() + interval '1 day' where room_id = '${r}'`) ?? '', /permission denied/);
    assert.match(db.asErr(U.F, d.F.sid, `insert into public.msgr2_reads (room_id, user_id, last_read_id, updated_at) values ('${r}', '${U.F}', 1, now() + interval '1 day')`) ?? '', /permission denied/);
    db.sql(`update public.msgr2_reads set updated_at = now() + interval '1 day' where room_id = '${r}' and user_id = '${U.O}'`); // 서비스 문맥(이전 U8)은 준 값 그대로
    assert.equal(db.sql(`select updated_at > now() + interval '1 hour' from public.msgr2_reads where room_id = '${r}' and user_id = '${U.O}'`), 't');
    db.sql(`insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${r}', 'user', '${U.F}', '하나 더')`);
    V(d.O, `public.msgr2_mark_read('${r}', 9223372036854775807)`);
    assert.equal(db.sql(`select abs(extract(epoch from updated_at - now())) < 5 from public.msgr2_reads where room_id = '${r}' and user_id = '${U.O}'`), 't', 'RPC 쓰기는 서버 시각');
    assert.equal(rows(d.O, `select room_id from public.msgr2_reads where room_id = '${r}'`).length, 1, '내 읽음은 읽힌다');
    assert.equal(rows(d.F, `select room_id from public.msgr2_reads where room_id = '${r}' and user_id = '${U.O}'`).length, 0, '남의 읽음은 안 보인다');
    assert.match(E(d.Orev, `public.msgr2_unread()`), /msgr2_device_invalid/);
    d.UNREAD_ROOM = r;
  });

  test('방 알림 설정 — 음소거·고정, 같은 값이면 쓰기 0, 기본값이면 행을 만들지 않음, 못 읽는 방은 거부', { skip }, () => {
    const r = d.UNREAD_ROOM;
    assert.deepEqual(J(d.O, `public.msgr2_room_pref_set('${r}', false, false)`), { muted: false, pinned: false });
    assert.equal(db.sql(`select count(*) from public.msgr2_prefs where room_id = '${r}'`), '0');
    assert.deepEqual(J(d.O, `public.msgr2_room_pref_set('${r}', true)`), { muted: true, pinned: false });
    const x0 = db.xmins('msgr2_prefs', `room_id = '${r}'`);
    J(d.O, `public.msgr2_room_pref_set('${r}', true)`); J(d.O, `public.msgr2_room_pref_set('${r}', null, null)`);
    assert.equal(db.xmins('msgr2_prefs', `room_id = '${r}'`), x0);
    assert.equal(rows(d.O, `select * from public.msgr2_unread() where room_id = '${r}'`)[0].muted, true);
    assert.match(E(d.X, `public.msgr2_room_pref_set('${r}', true)`), /msgr2_room_not_found/);
  });

  test('개인 1:1 목록 — 상대가 연 방도 내 목록에 나온다(상대 이름), 남의 1:1은 안 나온다, 그룹은 옵션', { skip }, () => {
    const mine = rows(d.F, 'select * from public.msgr2_dm_list()');
    const dm = mine.find((x) => x.other_user_id === U.O);
    assert.ok(dm, 'O가 O의 개인 공간에 연 1:1이 F 목록에 있다');
    assert.equal(dm.other_name, 'o');
    assert.ok(!rows(d.X, 'select * from public.msgr2_dm_list(true)').some((x) => x.room_id === dm.room_id));
    assert.ok(rows(d.F, 'select * from public.msgr2_dm_list(true)').some((x) => x.kind === 'private'), '친구방(그룹)');
    const ag = rows(d.O, 'select * from public.msgr2_dm_list(true)').find((x) => x.agent_id === AG_O);
    assert.ok(ag, '에이전트 1:1은 agent_id');
  });

  test('검색 — 내가 읽을 수 있는 방·글·사람·에이전트만, 남의 방 글·남의 에이전트·기한 지난 손님은 안 나온다, 2자 미만은 빈 결과', { skip }, () => {
    db.as(U.M, d.M.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${PRIV}', 'user', '${U.M}', '비밀코드 zebra42 입니다')`);
    const o = J(d.O, `public.msgr2_search('zebra42')`);
    assert.equal(o.messages.length, 1); assert.match(o.messages[0].snippet, /zebra42/);
    assert.equal(J(d.X, `public.msgr2_search('zebra42')`).messages.length, 0, '공간 밖');
    assert.equal(J(d.E, `public.msgr2_search('zebra42')`).messages.length, 0, '기한 지난 손님(방 멤버 행은 살아 있음)');
    assert.equal(J(d.G, `public.msgr2_search('zebra42')`).messages.length, 1, '손님은 들어간 방만');
    assert.ok(J(d.O, `public.msgr2_search('비밀')`).rooms.some((r) => r.id === PRIV));
    assert.ok(!J(d.X, `public.msgr2_search('비밀')`).rooms.some((r) => r.id === PRIV));
    assert.ok(J(d.O, `public.msgr2_search('멤버봇')`).agents.some((a) => a.id === AG_M), '파견된 에이전트');
    assert.equal(J(d.X, `public.msgr2_search('멤버봇')`).agents.length, 0);
    assert.equal(J(d.O, `public.msgr2_search('남의봇')`).agents.length, 0);
    const ppl = J(d.X, `public.msgr2_search('o')`); assert.deepEqual(ppl, { rooms: [], messages: [], people: [], agents: [] }, '1자 = 빈 결과');
    assert.ok(J(d.O, `public.msgr2_search('ex.com')`).people.length === 0, '이메일 도메인은 이름이 아님');
    assert.ok(J(d.O, `public.msgr2_search('f2')`).people.some((x) => x.id === U.F2), '친구');
    assert.equal(J(d.X, `public.msgr2_search('f2')`).people.length, 0, '모르는 사람');
    assert.ok(!J(d.O, `public.msgr2_search('bb')`).people.length, '없는 이름');
    assert.ok(!J(d.F, `public.msgr2_search('b@')`).people.some((x) => x.id === U.B));
    const lim = J(d.O, `public.msgr2_search('m1', 3)`);
    assert.ok(lim.messages.length <= 3, '상한');
  });

  test('유휴 쓰기 0 — 읽기 RPC와 이미 된 쓰기 RPC를 다시 불러도 v2 표의 행·xmin이 그대로다', { skip }, () => {
    const x0 = allX();
    rows(d.O, 'select * from public.msgr2_unread()'); rows(d.O, 'select * from public.msgr2_dm_list(true)'); J(d.O, `public.msgr2_search('zebra42')`);
    rows(d.M, `select * from public.msgr2_rooms_browse('${TEAM}', true)`); rows(d.O, `select * from public.msgr2_invites_list('${TEAM}')`); rows(d.N, 'select * from public.msgr2_my_invites()');
    J(d.O, `public.msgr2_dm_open('${U.F}')`); J(d.O, `public.msgr2_agent_dm_open('${AG_O}')`); V(d.M, `public.msgr2_room_join('${OPEN}')`);
    V(d.O, 'public.msgr2_my_personal_space()'); V(d.O, `public.msgr2_room_members_add('${PRIV}', array['${U.M}']::uuid[])`);
    assert.equal(allX(), x0);
  });

  test('v2 중단 — 늘리는 쓰기는 service_paused, 줄이는 쓰기(나가기)는 된다, 읽기 목록은 빈 결과', { skip }, () => {
    db.sql(`insert into public.msgr_settings (key, value) values ('msgr2_paused', '2026-10-18T00:00:00Z')`);
    try {
      assert.match(E(d.X, `public.msgr2_space_create('z')`), /service_paused/);
      assert.match(E(d.O, `public.msgr2_room_create(null, 'private', 'z')`), /service_paused/);
      assert.match(E(d.O, `public.msgr2_dm_open('${U.F}')`), /service_paused/);
      assert.equal(rows(d.O, 'select * from public.msgr2_unread()').length, 0);
      assert.equal(J(d.O, `public.msgr2_search('zebra42')`).paused, true);
      assert.equal(V(d.M, `public.msgr2_room_leave('${OPEN}')`), 'true', '나가기는 된다');
    } finally { db.sql(`delete from public.msgr_settings where key = 'msgr2_paused'`); }
  });


  test('검수 A — 초대: 이미 멤버여도 소진·만료·취소 링크는 거부하고 받으면 횟수를 센다, 링크는 빠진 행을 되살리지 않는다, 만든 사람이 방에서 빠지면 그 방은 안 넣는다', { skip }, () => {
    const used = (code) => db.sql(`select use_count from public.msgr2_space_invites where code = '${code}'`);
    const l1 = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', null, '{}'::uuid[], 2)`);
    assert.equal(J(d.M, `public.msgr2_invite_accept('${l1.code}')`).already_member, true);
    assert.equal(used(l1.code), '1', '이미 멤버여도 센다');
    J(d.A, `public.msgr2_invite_accept('${l1.code}')`);
    assert.match(E(d.M, `public.msgr2_invite_accept('${l1.code}')`), /msgr2_invite_exhausted/, '이미 멤버여도 소진 링크는 거부');
    // 공간에서 내보낸 사람: 살아 있는 링크로는 못 돌아온다, 사람 지정 초대로만
    const inv = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', '${U.K}')`); J(d.K, `public.msgr2_invite_accept('${inv.code}')`);
    V(d.O, `public.msgr2_space_member_remove('${TEAM}', '${U.K}')`);
    const live = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', null, '{}'::uuid[], 50)`);
    assert.match(E(d.K, `public.msgr2_invite_accept('${live.code}')`), /msgr2_invite_rejoin_direct_only/);
    assert.equal(db.sql(`select removed_at is not null from public.msgr2_space_members where space_id = '${TEAM}' and user_id = '${U.K}'`), 't');
    const back = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', '${U.K}')`);
    assert.equal(J(d.K, `public.msgr2_invite_accept('${back.code}')`).already_member, false, '사람 지정 초대는 되살린다');
    // 방에서 빼낸 멤버: 그 방이 든 링크로 받아도 되살리지 않는다
    const r = V(d.O, `public.msgr2_room_create('${TEAM}', 'private', '링크방', array['${U.K}']::uuid[])`);
    V(d.O, `public.msgr2_room_member_remove('${r}', 'user', '${U.K}')`);
    const lr = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', null, array['${r}']::uuid[], 10)`);
    assert.deepEqual(J(d.K, `public.msgr2_invite_accept('${lr.code}')`).rooms, []);
    assert.equal(canSeeRoom(d.K, r), false, '링크로 방에 돌아오지 못한다');
    // 초대 만든 사람이 방에서 빠지면 그 방은 넣지 않는다
    const r2 = V(d.A, `public.msgr2_room_create('${TEAM}', 'private', '만든이방')`);
    const la = J(d.A, `public.msgr2_invite_create('${TEAM}', 'member', '${U.K2}', array['${r2}']::uuid[])`);
    V(d.A, `public.msgr2_room_leave('${r2}')`);
    assert.deepEqual(J(d.K2, `public.msgr2_invite_accept('${la.code}')`).rooms, []);
    assert.equal(canSeeRoom(d.K2, r2), false);
  });

  test('검수 A(결정) — 기한 지난 손님을 다시 초대하면 새로 시작: 옛 비공개 방은 닫히고 이번 초대의 방만 열린다', { skip }, () => {
    const r = V(d.O, `public.msgr2_room_create('${TEAM}', 'private', '새손님방')`);
    assert.equal(db.sql(`select count(*) from public.msgr2_room_members where room_id = '${PRIV}' and member_id = '${U.E}' and removed_at is null`), '1', '만료 손님의 옛 방 행은 아직 열려 있다');
    const g = J(d.O, `public.msgr2_invite_create('${TEAM}', 'guest', '${U.E}', array['${r}']::uuid[], 1, 604800, 7)`);
    J(d.E, `public.msgr2_invite_accept('${g.code}')`);
    assert.equal(canSeeRoom(d.E, r), true);
    assert.equal(canSeeRoom(d.E, PRIV), false, '옛 비공개 방은 돌려주지 않는다');
    const l = J(d.O, `public.msgr2_invite_create('${TEAM}', 'guest', null, array['${PRIV}']::uuid[], 5, 604800, 7)`);
    db.sql(`update public.msgr2_space_members set expires_at = now() - interval '1 minute' where user_id = '${U.E}' and space_id = '${TEAM}'`);
    assert.match(E(d.E, `public.msgr2_invite_accept('${l.code}')`), /msgr2_invite_rejoin_direct_only/, '만료 손님은 링크로 되살아나지 않는다');
  });

  test('검수 B — 구성원끼리 차단이면 방 만들기·넣기 거부(팀·개인), 1:1은 한쪽이 차단하면 둘 다 못 쓰고 읽기는 남는다', { skip }, () => {
    block(U.M, U.A);
    try {
      assert.match(E(d.O, `public.msgr2_room_create('${TEAM}', 'private', 'x', array['${U.M}', '${U.A}']::uuid[])`), /msgr2_group_blocked_pair/);
      const r = V(d.O, `public.msgr2_room_create('${TEAM}', 'private', 'y', array['${U.M}']::uuid[])`);
      assert.match(E(d.O, `public.msgr2_room_members_add('${r}', array['${U.A}']::uuid[])`), /msgr2_group_blocked_pair/, '방에 있는 사람과 차단');
      assert.match(E(d.A, `public.msgr2_dm_open('${U.M}', '${TEAM}')`), /msgr2_dm_unavailable/, '차단 관계의 팀 1:1은 열리지 않는다');
    } finally { db.sql(`delete from public.msgr_user_blocks where blocker = '${U.M}' and blocked = '${U.A}'`); }
    block(U.F, U.F2);
    try {
      assert.match(E(d.O, `public.msgr2_room_create(null, 'private', 'z', array['${U.F}', '${U.F2}']::uuid[])`), /msgr2_group_blocked_pair/, '개인 방');
    } finally { db.sql(`delete from public.msgr_user_blocks where blocker = '${U.F}' and blocked = '${U.F2}'`); }
    // 1:1 쓰기: 열어 둔 뒤 한쪽이 차단
    const tdm = J(d.O, `public.msgr2_dm_open('${U.M}', '${TEAM}')`).room_id;
    const pdm = J(d.O, `public.msgr2_dm_open('${U.F}')`).room_id;
    const write = (who, room) => db.asErr(who.uid, who.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${room}', 'user', '${who.uid}', 'hi')`) === null;
    assert.equal(write(d.M, tdm), true); assert.equal(write(d.F, pdm), true);
    block(U.M, U.O); block(U.O, U.F);
    try {
      assert.equal(write(d.M, tdm), false, '차단한 쪽'); assert.equal(write(d.O, tdm), false, '차단당한 쪽');
      assert.equal(write(d.F, pdm), false); assert.equal(write(d.O, pdm), false);
      assert.equal(canSeeRoom(d.O, tdm), true, '읽기는 남는다');
    } finally { db.sql(`delete from public.msgr_user_blocks where (blocker = '${U.M}' and blocked = '${U.O}') or (blocker = '${U.O}' and blocked = '${U.F}')`); }
    assert.equal(write(d.M, tdm), true, '차단을 풀면 다시 쓴다');
  });

  test('검수 E — 초대 목록·신고 처리는 앱 기기만, admin은 admin 초대의 코드를 못 본다', { skip }, () => {
    assert.match(E(d.Orun, `(select count(*) from public.msgr2_invites_list('${TEAM}'))`), /msgr2_app_device_required/);
    J(d.O, `public.msgr2_invite_create('${TEAM}', 'admin', null, '{}'::uuid[], 1)`);
    const seenByAdmin = rows(d.A, `select role, code from public.msgr2_invites_list('${TEAM}')`);
    assert.ok(seenByAdmin.some((x) => x.role === 'admin'));
    assert.ok(seenByAdmin.filter((x) => x.role === 'admin').every((x) => x.code === null), 'admin이 보는 admin 초대 코드는 비움');
    assert.ok(rows(d.O, `select role, code from public.msgr2_invites_list('${TEAM}')`).filter((x) => x.role === 'admin').every((x) => x.code), '주인은 본다');
    if (full) assert.match(E(d.Orun, `public.msgr2_report_resolve(gen_random_uuid())`), /msgr2_app_device_required/);
  });

  if (full) {

    test('검수 C — 거울 조직: 다른 v2 멤버가 있는 팀의 주인이 계정을 지우면 msgr_owner_transfer_required(조직·요금·문서·v2 멤버 유지), 일괄 정리는 그 조직만 건너뜀, 옛 조직만이면 옛 동작', { skip }, () => {
      const counts = (sp) => db.sql(`select (select count(*) from public.msgr_orgs where id = '${sp}') || '/' || (select count(*) from public.msgr_org_entitlements where org_id = '${sp}')
        || '/' || (select count(*) from public.msgr_org_docs where org_id = '${sp}') || '/' || (select count(*) from public.msgr2_space_members where space_id = '${sp}' and removed_at is null)`);
      const sp = V(d.W, `public.msgr2_space_create('거울팀')`);
      const inv = J(d.W, `public.msgr2_invite_create('${sp}', 'member', '${U.W2}')`); J(d.W2, `public.msgr2_invite_accept('${inv.code}')`);
      db.sql(`insert into public.msgr_org_docs (org_id, path, title, body, created_by, updated_by) values ('${sp}', 'rules/keep.md', 't', 'x', '${U.W}', '${U.W}')`);
      assert.equal(counts(sp), '1/1/1/2');
      assert.match(E(d.W, `public.msgr_delete_me()`), /msgr_owner_transfer_required/);
      assert.equal(counts(sp), '1/1/1/2', '계정 삭제가 통째로 되돌려진다');
      assert.equal(db.sql(`select count(*) from auth.users where id = '${U.W}'`), '1');
      // 일괄 정리: 옛 앱에서 보관(30일 지남)된 거울 조직은 건너뛰고, 옛 조직만 있는 보관 조직은 그대로 지운다
      db.sql(`delete from public.msgr_settings where key = 'msgr_paused'`);
      const old = db.sql(`insert into public.msgr_orgs (name, slug, owner_user_id) values ('옛만', 'old-only-org', '${U.Z}') returning id`).split('\n').pop();
      db.sql(`insert into public.msgr_settings (key, value) values ('msgr_paused', '2026-10-16T17:00:00+09:00')`);
      db.sql(`update public.msgr_orgs set deleted_at = now() - interval '31 days' where id in ('${sp}', '${old}')`);
      db.sql('select public.msgr_purge_orgs()');
      assert.equal(counts(sp), '1/1/1/2', '거울 조직 유지');
      assert.equal(db.sql(`select count(*) from public.msgr_orgs where id = '${old}'`), '0', '옛 조직만이면 옛 동작(지움)');
      db.sql(`update public.msgr_orgs set deleted_at = null where id = '${sp}'`);
      // v2 팀에 주인 혼자면 옛 동작(계정 삭제 진행) — 별도 사용자
      const solo = V(d.Z, `public.msgr2_space_create('혼자팀')`);
      const r = db.raw(['-A', '-t', '-c', db.ctx(U.Z, d.Z.sid) + 'select public.msgr_delete_me()']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(db.sql(`select count(*) from public.msgr_orgs where id = '${solo}'`), '0');
    });

    test('옛 중단 장치 — 친구 요청: 옛 앱 세션·runner·v2 운영 표지 없음·v2 중단 중은 막힘, v2 운영 중 v2 앱 기기만 통과', { skip }, () => {
      const req = (who, target) => db.asErr(who.uid, who.sid, `select public.msgr_friend_request('${target}')`) ?? 'ok';
      assert.match(req(d.O, U.Q), /messenger service paused/, 'v2 운영 표지 없음');
      db.sql(`insert into public.msgr_settings (key, value) values ('msgr2_enabled', '2026-10-18')`);
      try {
        assert.match(req(d.Oold, U.Q), /messenger service paused/, '옛 앱 세션(기기 행 없음)');
        assert.match(req(d.Orun, U.Q), /messenger service paused/, 'runner 기기(에이전트 셸)');
        assert.match(req(d.Orev, U.Q), /messenger service paused/, '폐기 기기');
        assert.equal(req(d.O, U.Q), 'ok', 'v2 앱 기기');
        assert.equal(db.sql(`select status from public.msgr_friends where a = least('${U.O}'::uuid, '${U.Q}'::uuid) and b = greatest('${U.O}'::uuid, '${U.Q}'::uuid)`), 'pending');
        db.sql(`insert into public.msgr_settings (key, value) values ('msgr2_paused', 'x')`);
        assert.match(req(d.X, U.Q), /messenger service paused/, 'v2 중단 중');
        db.sql(`delete from public.msgr_settings where key = 'msgr2_paused'`);
        // 옛 표의 다른 쓰기(옛 글)는 v2 앱 기기여도 그대로 막힌다
        assert.match(db.asErr(U.O, d.O.sid, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('옛', 'old-path-3', '${U.O}')`) ?? '', /messenger service paused/);
      } finally { db.sql(`delete from public.msgr_settings where key in ('msgr2_enabled', 'msgr2_paused')`); }
    });

    test('옛 FK → 두 표 중 하나 — 신고·일지에 v2 글·방을 넣을 수 있고(조직 문서 FK는 그대로), 둘 다 없는 값은 23503, 옛 값은 그대로 된다', { skip }, () => {
      const mid = db.sql(`select id from public.msgr2_messages where room_id = '${PRIV}' order by id desc limit 1`);
      db.sql(`insert into public.msgr_reports (message_id, channel_id, reporter_user_id) values (${mid}, '${PRIV}', '${U.O}')`);
      db.sql(`insert into public.msgr_journal_entries (org_id, channel_id, day, line, source_msg_id) values ('${TEAM}', '${PRIV}', '2026-10-18', 'x', ${mid})`);
      const bad = (q) => { const r = db.raw(['-A', '-t', '-c', q]); return r.status === 0 ? '' : r.stderr; };
      // 조직 문서 channel_id FK는 그대로(옛 본체 docsByIds의 msgr_channels 끼워 읽기) — v2 방 문서는 문서 단위로 미룸(PR 본문). 팀 공간 문서(channel_id null)는 된다
      assert.equal(db.sql(`select count(*) from pg_constraint where conname = 'msgr_org_docs_channel_id_fkey'`), '1');
      assert.match(bad(`insert into public.msgr_org_docs (org_id, channel_id, path, title, body, created_by, updated_by) values ('${TEAM}', '${PRIV}', 'rules/v2.md', 't', 'x', '${U.O}', '${U.O}')`), /msgr_doc_channel_missing/);
      db.sql(`insert into public.msgr_org_docs (org_id, channel_id, path, title, body, created_by, updated_by) values ('${TEAM}', null, 'rules/v2-team.md', 't', 'x', '${U.O}', '${U.O}')`); // 팀 공간 문서(옛 조직 행 = v2 팀 id)
      assert.match(bad(`insert into public.msgr_reports (message_id, reporter_user_id) values (999999999, '${U.O}')`), /violates foreign key/);
      assert.match(bad(`insert into public.msgr_journal_entries (org_id, channel_id, day, line) values ('${TEAM}', gen_random_uuid(), '2026-10-18', 'x')`), /violates foreign key/);
      assert.match(bad(`insert into public.msgr_journal_entries (org_id, channel_id, day, line, source_msg_id) values ('${TEAM}', '${PRIV}', '2026-10-18', 'x', 999999999)`), /violates foreign key/);
      assert.match(bad(`update public.msgr_reports set channel_id = gen_random_uuid() where message_id = ${mid}`), /violates foreign key/);
      // 옛 글: 지우면 신고의 message_id가 비워진다(옛 on delete set null 유지). 옛 표 쓰기는 옛 중단을 잠시 끄고 준비한다
      db.sql(`delete from public.msgr_settings where key = 'msgr_paused'`);
      const ch = db.sql(`insert into public.msgr_channels (org_id, kind, name, created_by) values ('${TEAM}', 'public', '옛', '${U.O}') returning id`);
      const om = db.sql(`insert into public.msgr_messages (id, org_id, channel_id, author_kind, author_user_id, body) overriding system value values (900000001, '${TEAM}', '${ch}', 'user', '${U.O}', 'old') returning id`).split('\n').pop();
      db.sql(`insert into public.msgr_reports (message_id, channel_id, org_id, reporter_user_id) values (${om}, '${ch}', '${TEAM}', '${U.A}')`);
      // 같은 id의 v2 글이 있으면(U8 id 보존) 신고는 v2 글을 가리키므로 비우지 않는다 — 여기서는 v2에 없는 id(900000001)
      db.sql(`delete from public.msgr_messages where id = ${om}`); // 시험 DB의 옛 글(시드) — set null 확인
      db.sql(`insert into public.msgr_settings (key, value) values ('msgr_paused', '2026-10-16T17:00:00+09:00')`);
      assert.equal(db.sql(`select count(*) from public.msgr_reports where reporter_user_id = '${U.A}' and message_id is null and channel_id = '${ch}'`), '1');
    });

    test('v2 신고 — 읽을 수 있는 남의 글만, 같은 글 반복은 하나, 목록은 신고자·팀 관리자·운영자, 처리는 팀 관리자(멤버 거부)', { skip }, () => {
      const mid = db.sql(`select id from public.msgr2_messages where room_id = '${PRIV}' and author_user_id = '${U.M}' order by id desc limit 1`);
      assert.match(E(d.X, `public.msgr2_report_message(${mid}, '스팸')`), /msgr2_report_no_message/, '못 읽는 글');
      assert.match(E(d.M, `public.msgr2_report_message(${mid})`), /msgr2_report_own/);
      const r1 = V(d.G, `public.msgr2_report_message(${mid}, '스팸')`); const r2 = V(d.G, `public.msgr2_report_message(${mid})`);
      assert.equal(r1, r2);
      assert.equal(db.sql(`select org_id is null and channel_id = '${PRIV}' from public.msgr_reports where id = '${r1}'`), 't');
      assert.ok(rows(d.G, 'select * from public.msgr2_reports_list()').some((x) => x.id === r1), '신고자');
      assert.ok(rows(d.A, 'select * from public.msgr2_reports_list()').some((x) => x.id === r1), '팀 admin');
      assert.ok(!rows(d.X, 'select * from public.msgr2_reports_list()').some((x) => x.id === r1));
      assert.ok(!rows(d.M, 'select * from public.msgr2_reports_list()').some((x) => x.id === r1), '팀 member는 남의 신고 못 봄');
      assert.match(E(d.M, `public.msgr2_report_resolve('${r1}')`), /msgr2_report_forbidden/);
      assert.equal(V(d.A, `public.msgr2_report_resolve('${r1}')`), 'true');
      assert.equal(V(d.A, `public.msgr2_report_resolve('${r1}')`), 'false');
    });

    test('되돌림이 멈추는 조건 — v2 값을 가리키는 옛 표 행·초대 행이 있으면 아무것도 바꾸지 않는다', { skip }, () => {
      const before = snapshot(db);
      const r = db.raw(['-v', 'ON_ERROR_STOP=1', '-c', readFileSync(DOWN_FILE, 'utf8')]);
      assert.notEqual(r.status, 0); assert.match(r.stderr, /msgr2_rollback_not_empty/);
      assert.deepEqual(snapshot(db), before);
    });
  }
}
