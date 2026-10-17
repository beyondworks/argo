// 메신저 v2 U1 RPC·잠금·직접 쓰기 금지·유휴 쓰기 0(설계 1-3·1-5 원칙 5·6, 경우 표 6·7·15·19) — 실제 Postgres에 *_msgr2_space.sql만 적용한다.
// 검수 1 #1070 지적 1~3(id 선점·기록 위조·남의 방 파일 경로)은 'msgr2-access-attack-pg'와 아래 '지적' 시험이 잠근다.
// 잠그는 것: 개인 공간 1인 1개(두 번 불러도 같은 id·쓰기 0) · 에이전트 sync는 값이 바뀐 행만(두 번째 쓰기 0, xmin 불변) · 권한 표(멤버 역할·파견·방 정책)는
// 직접 쓰기가 없고 앱 기기 RPC로만, 권한 밖이면 42501 · 파견은 팀 공간에만 · 소속 열 잠금 · 다른 방의 토픽·글에 붙이기 금지 · 사람만 직접 글을 쓴다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-access-rpc-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-access-rpc-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const FILE = readdirSync(mig('')).filter((f) => f.endsWith('_msgr2_space.sql')).sort().pop();
const U = {
  owner: '20000000-0000-4000-8000-000000000001', admin: '20000000-0000-4000-8000-000000000002', member: '20000000-0000-4000-8000-000000000003',
  guest: '20000000-0000-4000-8000-000000000004', stranger: '20000000-0000-4000-8000-000000000005', admin2: '20000000-0000-4000-8000-000000000006',
};
const psqlRaw = (args) => psqlSpawn(DB, args);
const psql = (args) => { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; };
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const pre = (uid) => `set role authenticated; select set_config('argo.uid', '${uid}', false); `;
const asUser = (uid, q) => psql(['-A', '-t', '-c', pre(uid) + q]).trim();
const asUserErr = (uid, q) => { const r = psqlRaw(['-A', '-t', '-c', pre(uid) + q]); return r.status === 0 ? null : r.stderr; };
const xmins = (t, where = 'true') => sql(`select coalesce(string_agg(xmin::text, ',' order by ctid), '') from public.${t} where ${where}`);
const setDeviceApp = (v) => sql(`create or replace function public._msgr2_device_app() returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select ${v} $$`);

let TEAM, ROOM, ROOM2, DIRECT;
before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth; grant usage on schema auth to anon, authenticated, service_role;
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;`]);
  psql(['-c', readFileSync(mig(FILE), 'utf8')]);
  TEAM = sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', '팀', '${U.owner}') returning id`);
  sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${TEAM}', '${U.owner}', 'owner'), ('${TEAM}', '${U.admin}', 'admin'),
    ('${TEAM}', '${U.admin2}', 'admin'), ('${TEAM}', '${U.member}', 'member'), ('${TEAM}', '${U.guest}', 'guest')`);
  ROOM = sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TEAM}', 'open', '일반') returning id`);
  ROOM2 = sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TEAM}', 'private', '비밀') returning id`);
  DIRECT = sql(`insert into public.msgr2_rooms (space_id, kind, pair_key) values ('${TEAM}', 'direct', 'o-m') returning id`);
  sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${ROOM2}', 'user', '${U.owner}'), ('${ROOM2}', 'user', '${U.member}'),
    ('${DIRECT}', 'user', '${U.owner}'), ('${DIRECT}', 'user', '${U.member}')`);
});

test('경우 표 6 — 개인 공간은 1인 1개: 두 번 불러도 같은 id, 두 번째 부름은 쓰기 0(xmin 불변), 주인 멤버 행 1개', { skip }, () => {
  const a = asUser(U.stranger, 'select public.msgr2_my_personal_space()');
  const x1 = xmins('msgr2_spaces', `owner_user_id = '${U.stranger}'`) + '/' + xmins('msgr2_space_members', `user_id = '${U.stranger}'`);
  const b = asUser(U.stranger, 'select public.msgr2_my_personal_space()');
  assert.equal(a, b, '같은 id');
  assert.equal(xmins('msgr2_spaces', `owner_user_id = '${U.stranger}'`) + '/' + xmins('msgr2_space_members', `user_id = '${U.stranger}'`), x1, '두 번째 부름은 쓰기 0');
  assert.equal(sql(`select count(*) from public.msgr2_spaces where owner_user_id = '${U.stranger}' and kind = 'personal'`), '1');
  assert.equal(sql(`select role from public.msgr2_space_members where space_id = '${a}' and user_id = '${U.stranger}'`), 'owner');
  assert.match(asUserErr('', 'select public.msgr2_my_personal_space()') ?? '', /msgr2_signin_required/, '로그인 없음');
  // 한 사람이 개인 공간을 둘 가질 수 없다(서비스 문맥 직접 넣기도 유일 색인이 막는다)
  assert.throws(() => sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${U.stranger}')`), /msgr2_spaces_personal_one/);
});

test('경우 표 7 — 에이전트 sync: 첫 동기화는 행 수만큼, 두 번째는 쓰기 0(xmin 불변), 하나만 바뀌면 1행 · 주인은 부른 사람', { skip }, () => {
  const list = (name2) => JSON.stringify([
    { ws_id: 'w1', slug: 'pepper', display_name: '페퍼', role_text: '총괄', face: { v: 2, shape: 1 } },
    { ws_id: 'w1', slug: 'feynman', display_name: name2, owner_user_id: U.stranger },
  ]).replace(/'/g, "''");
  assert.equal(asUser(U.owner, `select public.msgr2_agent_sync('${list('파인만')}'::jsonb)`), '2');
  const x1 = xmins('msgr2_agents', `owner_user_id = '${U.owner}'`);
  assert.equal(asUser(U.owner, `select public.msgr2_agent_sync('${list('파인만')}'::jsonb)`), '0', '두 번째 동기화는 0행');
  assert.equal(xmins('msgr2_agents', `owner_user_id = '${U.owner}'`), x1, '두 번째 동기화 쓰기 0(xmin 불변)');
  assert.equal(asUser(U.owner, `select public.msgr2_agent_sync('${list('파인만2')}'::jsonb)`), '1', '바뀐 행만');
  assert.equal(sql(`select count(*) from public.msgr2_agents where owner_user_id = '${U.stranger}'`), '0', '받은 값의 주인 필드는 무시');
  assert.match(asUserErr(U.owner, `select public.msgr2_agent_sync('[{"ws_id":"w1"}]'::jsonb)`) ?? '', /msgr2_bad_agents/);
  assert.match(asUserErr(U.owner, `select public.msgr2_agent_sync('{}'::jsonb)`) ?? '', /msgr2_bad_agents/);
  // 에이전트는 주인 것만 보인다(파견·방 멤버가 아니면 남에게 안 보임)
  assert.equal(asUser(U.member, 'select count(*) from public.msgr2_agents'), '0');
  assert.equal(asUser(U.owner, 'select count(*) from public.msgr2_agents'), '2');
});

test('권한 표 직접 쓰기 금지(D9) — 공간·멤버·방·방 멤버·에이전트·파견·토픽에 사람이 직접 넣거나 바꾸지 못한다', { skip }, () => {
  const tries = [
    `insert into public.msgr2_spaces (kind, owner_user_id) values ('team', '${U.owner}')`,
    `insert into public.msgr2_space_members (space_id, user_id, role) values ('${TEAM}', '${U.stranger}', 'member')`,
    `update public.msgr2_space_members set role = 'owner' where user_id = '${U.admin}'`,
    `insert into public.msgr2_rooms (space_id, kind) values ('${TEAM}', 'open')`,
    `update public.msgr2_rooms set agent_policy = 'blocked' where id = '${ROOM}'`,
    `insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${ROOM2}', 'user', '${U.admin}')`,
    `insert into public.msgr2_agents (owner_user_id, ws_id, slug) values ('${U.owner}', 'w9', 'x')`,
    `insert into public.msgr2_agent_seats (agent_id, space_id) select id, '${TEAM}' from public.msgr2_agents limit 1`,
    `insert into public.msgr2_topics (room_id) values ('${ROOM}')`,
  ];
  for (const q of tries) assert.match(asUserErr(U.owner, q) ?? '', /permission denied/, q.slice(0, 60));
});

test('멤버 역할 RPC — 앱 기기의 owner·admin만, owner는 못 바꾸고 admin은 admin을 못 만든다 · 앱 기기가 아니면 42501', { skip }, () => {
  asUser(U.admin, `select public.msgr2_set_member_role('${TEAM}', '${U.member}', 'guest')`);
  assert.equal(sql(`select role from public.msgr2_space_members where space_id = '${TEAM}' and user_id = '${U.member}'`), 'guest');
  const x = xmins('msgr2_space_members', `space_id = '${TEAM}'`);
  asUser(U.admin, `select public.msgr2_set_member_role('${TEAM}', '${U.member}', 'guest')`);
  assert.equal(xmins('msgr2_space_members', `space_id = '${TEAM}'`), x, '같은 값이면 쓰기 0');
  asUser(U.owner, `select public.msgr2_set_member_role('${TEAM}', '${U.member}', 'member')`);
  for (const [who, target, role] of [[U.member, U.guest, 'member'], [U.guest, U.guest, 'member'], [U.admin, U.owner, 'member'], [U.admin, U.admin2, 'member'],
    [U.admin, U.member, 'admin'], [U.stranger, U.member, 'guest'], [U.owner, U.owner, 'admin']]) {
    assert.match(asUserErr(who, `select public.msgr2_set_member_role('${TEAM}', '${target}', '${role}')`) ?? '', /msgr2_forbidden/, `${who.slice(-1)}→${target.slice(-1)} ${role}`);
  }
  assert.match(asUserErr(U.owner, `select public.msgr2_set_member_role('${TEAM}', '${U.member}', 'owner')`) ?? '', /msgr2_bad_role/);
  const pers = asUser(U.admin, 'select public.msgr2_my_personal_space()');
  assert.match(asUserErr(U.admin, `select public.msgr2_set_member_role('${pers}', '${U.admin}', 'member')`) ?? '', /msgr2_team_only/, '개인 공간은 역할이 없다');
  setDeviceApp('false');
  try { assert.match(asUserErr(U.owner, `select public.msgr2_set_member_role('${TEAM}', '${U.member}', 'guest')`) ?? '', /msgr2_app_device_required/); }
  finally { setDeviceApp('true'); }
  assert.equal(sql(`select role from public.msgr2_space_members where space_id = '${TEAM}' and user_id = '${U.member}'`), 'member');
});

test('경우 표 15 — 파견: 앱 기기의 에이전트 주인·손님 아닌 멤버만, 팀 공간에만, 같은 값은 쓰기 0, 빼기는 removed_at(행 보존) · 파견하면 팀이 에이전트를 본다', { skip }, () => {
  const ag = sql(`select id from public.msgr2_agents where owner_user_id = '${U.owner}' and slug = 'pepper'`);
  assert.equal(asUser(U.member, `select count(*) from public.msgr2_agent_seats where space_id = '${TEAM}'`), '0', '파견 0인 팀 공간');
  asUser(U.owner, `select public.msgr2_set_seat('${ag}', '${TEAM}')`);
  assert.equal(asUser(U.member, `select count(*) from public.msgr2_agent_seats where space_id = '${TEAM}' and removed_at is null`), '1');
  assert.equal(asUser(U.member, `select count(*) from public.msgr2_agents where id = '${ag}'`), '1', '파견된 에이전트는 팀 멤버에게 보인다');
  const x = xmins('msgr2_agent_seats');
  asUser(U.owner, `select public.msgr2_set_seat('${ag}', '${TEAM}')`);
  assert.equal(xmins('msgr2_agent_seats'), x, '같은 값이면 쓰기 0');
  asUser(U.owner, `select public.msgr2_set_seat('${ag}', '${TEAM}', p_remove => true)`);
  assert.equal(sql(`select count(*) from public.msgr2_agent_seats where agent_id = '${ag}' and removed_at is not null`), '1', '빼도 행은 남는다');
  asUser(U.owner, `select public.msgr2_set_seat('${ag}', '${TEAM}', 'list', array['${U.member}']::uuid[])`);
  assert.equal(sql(`select allow || ':' || (removed_at is null) from public.msgr2_agent_seats where agent_id = '${ag}'`), 'list:true', '다시 넣기');
  const pers = asUser(U.owner, 'select public.msgr2_my_personal_space()');
  assert.match(asUserErr(U.owner, `select public.msgr2_set_seat('${ag}', '${pers}')`) ?? '', /msgr2_forbidden/, '개인 공간에는 파견하지 않는다');
  assert.throws(() => sql(`insert into public.msgr2_agent_seats (agent_id, space_id) values ('${ag}', '${pers}')`), /msgr2_seat_team_only/, '서비스 문맥도 팀 공간에만');
  assert.match(asUserErr(U.member, `select public.msgr2_set_seat('${ag}', '${TEAM}')`) ?? '', /msgr2_forbidden/, '남의 에이전트');
  asUser(U.guest, `select public.msgr2_agent_sync('[{"ws_id":"g","slug":"g1"}]'::jsonb)`);
  const gag = sql(`select id from public.msgr2_agents where owner_user_id = '${U.guest}'`);
  assert.match(asUserErr(U.guest, `select public.msgr2_set_seat('${gag}', '${TEAM}')`) ?? '', /msgr2_forbidden/, '손님은 파견하지 못한다');
  setDeviceApp('false');
  try { assert.match(asUserErr(U.owner, `select public.msgr2_set_seat('${ag}', '${TEAM}')`) ?? '', /msgr2_app_device_required/, '경우 표 19 — 앱 기기가 아니면 거부'); }
  finally { setDeviceApp('true'); }
});

test('방 에이전트 정책 RPC — manage일 때만(팀 owner·admin), 같은 값은 쓰기 0, direct 방은 못 바꾼다', { skip }, () => {
  asUser(U.admin, `select public.msgr2_set_room_agent_policy('${ROOM}', 'approval')`);
  assert.equal(sql(`select agent_policy from public.msgr2_rooms where id = '${ROOM}'`), 'approval');
  const x = xmins('msgr2_rooms', `id = '${ROOM}'`);
  asUser(U.admin, `select public.msgr2_set_room_agent_policy('${ROOM}', 'approval')`);
  assert.equal(xmins('msgr2_rooms', `id = '${ROOM}'`), x, '같은 값이면 쓰기 0');
  assert.match(asUserErr(U.member, `select public.msgr2_set_room_agent_policy('${ROOM}', 'blocked')`) ?? '', /msgr2_forbidden/);
  assert.match(asUserErr(U.owner, `select public.msgr2_set_room_agent_policy('${DIRECT}', 'blocked')`) ?? '', /msgr2_forbidden/, 'direct는 manage 거짓');
  assert.match(asUserErr(U.admin, `select public.msgr2_set_room_agent_policy('${ROOM2}', 'blocked')`) ?? '', /msgr2_forbidden/, '방 멤버가 아닌 admin은 비공개 방을 못 본다');
  assert.match(asUserErr(U.owner, `select public.msgr2_set_room_agent_policy('${ROOM}', 'nope')`) ?? '', /msgr2_bad_policy/);
});

test('글 넣기 — 사람만, 자기 이름으로, 같은 방의 토픽에만 · 에이전트·시스템 글을 사람이 넣지 못한다', { skip }, () => {
  const ag = sql(`select id from public.msgr2_agents where owner_user_id = '${U.owner}' and slug = 'pepper'`);
  const T1 = sql(`insert into public.msgr2_topics (room_id, title) values ('${ROOM}', '일') returning id`);
  const T2 = sql(`insert into public.msgr2_topics (room_id, title) values ('${ROOM2}', '다른 방') returning id`);
  asUser(U.member, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${ROOM}', 'user', '${U.member}', '안녕')`);
  asUser(U.member, `insert into public.msgr2_messages (room_id, topic_id, author_kind, author_user_id, body) values ('${ROOM}', ${T1}, 'user', '${U.member}', '토픽 글')`);
  assert.match(asUserErr(U.member, `insert into public.msgr2_messages (room_id, topic_id, author_kind, author_user_id, body) values ('${ROOM}', ${T2}, 'user', '${U.member}', 'x')`) ?? '', /msgr2_topic_room_mismatch/);
  for (const q of [
    `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${ROOM}', 'user', '${U.owner}', '남의 이름')`,
    `insert into public.msgr2_messages (room_id, author_kind, author_agent_id, body) values ('${ROOM}', 'agent', '${ag}', '에이전트인 척')`,
    `insert into public.msgr2_messages (room_id, author_kind, kind, body) values ('${ROOM}', 'system', 'system', '시스템인 척')`,
    `insert into public.msgr2_messages (room_id, author_kind, author_user_id, kind, body) values ('${ROOM}', 'user', '${U.member}', 'card', '카드')`,
    `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${DIRECT}', 'user', '${U.guest}', '남의 1:1')`,
  ]) assert.match(asUserErr(q.includes(U.guest) ? U.guest : U.member, q) ?? '', /row-level security|violates|permission denied/, q.slice(60, 140)); // author_agent_id는 열 권한부터 없다
  // 첨부 행: 사람이 직접 넣지 않는다(업로드 슬롯 RPC — U2·U6). 경로 검사는 아래 지적 시험이 본다
  const mid = sql(`select id from public.msgr2_messages where body = '안녕'`);
  assert.match(asUserErr(U.member, `insert into public.msgr2_attachments (message_id, room_id, storage_path, name) values (${mid}, '${ROOM}', 'msgr/${TEAM}/${ROOM}/a.png', 'a.png')`) ?? '', /permission denied/, '사람 직접 첨부 행');
});

test('검수 1 #1070 지적 1~3 — 사람이 id·시각을 정하지 못하고(선점으로 남의 글 막기 금지), meta·남의 방 답글·남의 방 파일 경로를 넣지 못한다', { skip }, () => {
  const before = sql('select coalesce(max(id), 0) from public.msgr2_messages');
  // 지적 1: id 직접 지정 → 열 권한 없음
  assert.match(asUserErr(U.member, `insert into public.msgr2_messages (id, room_id, author_kind, author_user_id, body) select g, '${ROOM}', 'user', '${U.member}', 'x' from generate_series(${Number(before) + 1}, ${Number(before) + 5}) g`) ?? '', /permission denied/, 'id 선점');
  asUser(U.owner, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${ROOM}', 'user', '${U.owner}', '다음 글')`); // 다른 사람의 다음 글이 그대로 들어간다
  // 지적 2: 시각·meta·답글
  for (const q of [
    `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, created_at) values ('${ROOM}', 'user', '${U.member}', 'x', '2001-01-01')`,
    `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, edited_at) values ('${ROOM}', 'user', '${U.member}', 'x', now())`,
    `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, deleted_at) values ('${ROOM}', 'user', '${U.member}', 'x', now())`,
  ]) assert.match(asUserErr(U.member, q) ?? '', /permission denied/, q.slice(100, 160));
  assert.match(asUserErr(U.member, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, meta) values ('${ROOM}', 'user', '${U.member}', 'x', '{"code":"topic.resolved"}')`) ?? '', /row-level security/, '시스템 글 코드 흉내');
  const other = sql(`insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${ROOM2}', 'user', '${U.owner}', '비밀 방 글') returning id`);
  assert.match(asUserErr(U.member, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, reply_to) values ('${ROOM}', 'user', '${U.member}', 'x', ${other})`) ?? '', /row-level security/, '다른 방 글에 답글');
  const same = sql(`select id from public.msgr2_messages where body = '다음 글'`);
  asUser(U.member, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, reply_to) values ('${ROOM}', 'user', '${U.member}', '같은 방 답글', ${same})`);
  // 지적 3: 사람은 첨부 행을 직접 넣지 못하고(id 지정 포함), 사람 문맥의 RPC가 넣어도 경로는 msgr/<공간>/<방>/만. 서비스 문맥(이전)은 옛 경로 그대로
  const mine = sql(`select id from public.msgr2_messages where body = '같은 방 답글'`);
  assert.match(asUserErr(U.member, `insert into public.msgr2_attachments (id, message_id, room_id, storage_path) values (999999, ${mine}, '${ROOM}', 'msgr/${TEAM}/${ROOM}/a')`) ?? '', /permission denied/, '첨부 id 지정');
  const inRpc = (path) => psqlRaw(['-A', '-t', '-c', `select set_config('argo.uid', '${U.member}', false); insert into public.msgr2_attachments (message_id, room_id, storage_path, created_at) values (${mine}, '${ROOM}', '${path}', '2001-01-01') returning extract(year from created_at)`]);
  for (const path of [`msgr/${TEAM}/${ROOM2}/secret.pdf`, 'r1/secret.pdf', `msgr/${TEAM}/${ROOM}/../${ROOM2}/x`, `msgr/${TEAM}/${ROOM}//x`, `${ROOM}/a.pdf`]) {
    const r = inRpc(path); assert.notEqual(r.status, 0, path); assert.match(r.stderr, /msgr2_attachment_path/, path);
  }
  const ok = inRpc(`msgr/${TEAM}/${ROOM}/ok.pdf`); assert.equal(ok.status, 0, ok.stderr);
  assert.notEqual(ok.stdout.trim(), '2001', '사람 문맥이면 시각은 서버가 정한다');
  assert.equal(sql(`insert into public.msgr2_attachments (message_id, room_id, storage_path, created_at) values (${mine}, '${ROOM}', 'old/legacy/path.pdf', '2001-01-01') returning extract(year from created_at)`), '2001', '서비스 문맥(이전)은 옛 경로·옛 시각 보존');
});

test('소속 열 잠금 — 읽음·설정 행의 방을 바꾸지 못하고, 서비스 문맥이 아닌 RPC 밖 갱신도 소속 열은 그대로', { skip }, () => {
  asUser(U.member, `insert into public.msgr2_reads (room_id, user_id, last_read_id) values ('${ROOM}', '${U.member}', 1)`);
  asUser(U.member, `update public.msgr2_reads set last_read_id = 5 where room_id = '${ROOM}' and user_id = '${U.member}'`);
  assert.equal(sql(`select last_read_id from public.msgr2_reads where user_id = '${U.member}'`), '5');
  assert.match(asUserErr(U.member, `update public.msgr2_reads set room_id = '${ROOM2}' where room_id = '${ROOM}' and user_id = '${U.member}'`) ?? '', /msgr2_immutable_room_id/);
  assert.match(asUserErr(U.member, `insert into public.msgr2_reads (room_id, user_id) values ('${ROOM}', '${U.owner}')`) ?? '', /row-level security/, '남의 읽음 행');
  asUser(U.member, `insert into public.msgr2_prefs (room_id, user_id, muted) values ('${ROOM}', '${U.member}', true)`);
  assert.match(asUserErr(U.member, `update public.msgr2_prefs set user_id = '${U.owner}' where user_id = '${U.member}'`) ?? '', /msgr2_immutable_user_id|row-level security/);
  // 반응 — 쓸 수 있는 방의 글에만, 자기 것만 지운다
  const mid = sql(`select id from public.msgr2_messages where body = '안녕'`);
  asUser(U.member, `insert into public.msgr2_reactions (message_id, user_id, emoji) values (${mid}, '${U.member}', '👍')`);
  assert.match(asUserErr(U.guest, `insert into public.msgr2_reactions (message_id, user_id, emoji) values (${mid}, '${U.member}', '👎')`) ?? '', /row-level security/, '남의 이름 반응');
  assert.equal(asUser(U.owner, `delete from public.msgr2_reactions where message_id = ${mid} returning 1`), '', '남의 반응은 못 지운다(0행)');
  assert.equal(asUser(U.member, `delete from public.msgr2_reactions where message_id = ${mid} returning 1`), '1');
});

test('함수 실행 권한 — anon은 RPC를 못 부르고, 트리거 함수는 사람이 못 부른다', { skip }, () => {
  for (const f of ['msgr2_my_personal_space()', `msgr2_agent_sync('[]'::jsonb)`]) {
    const r = psqlRaw(['-A', '-t', '-c', `set role anon; select public.${f}`]);
    assert.notEqual(r.status, 0, f); assert.match(r.stderr, /permission denied/);
  }
  for (const f of ['msgr2_lock_cols', 'msgr2_same_room', 'msgr2_seat_team_only']) {
    assert.equal(sql(`select has_function_privilege('authenticated', 'public.${f}()', 'execute')`), 'f', f);
  }
});
