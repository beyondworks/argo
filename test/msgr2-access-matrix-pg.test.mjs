// 메신저 v2 U1 판정 행렬(설계 1-5 원칙 7) — 실제 Postgres에 *_msgr2_space.sql만 적용하고, 공간 2 × 역할 7 × 방 3 × 기기 상태(지금은 '앱') × 행동 5를
// 기대값 파일(test/fixtures/msgr2-access-matrix.expected.json)과 칸마다 대조한다. read·write 칸은 판정 함수 값만이 아니라 실제 RLS(방 행 읽기·글 넣기)로도 본다.
// 기기 상태 본체·폐기·만료 칸은 U3(_msgr2_device_ok 정의) 병합 뒤 채운다. 지금은 자리 함수를 거짓으로 바꾸면 모든 칸이 거짓이 되는 것만 잠근다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-access-matrix-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-access-matrix-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const FILE = readdirSync(mig('')).filter((f) => f.endsWith('_msgr2_space.sql')).sort().pop();
const EXPECT = JSON.parse(readFileSync(new URL('./fixtures/msgr2-access-matrix.expected.json', import.meta.url), 'utf8'));

export const U = {
  owner: '10000000-0000-4000-8000-000000000001', admin: '10000000-0000-4000-8000-000000000002', member: '10000000-0000-4000-8000-000000000003',
  guest: '10000000-0000-4000-8000-000000000004', friend: '10000000-0000-4000-8000-000000000005', stranger: '10000000-0000-4000-8000-000000000006',
  removed: '10000000-0000-4000-8000-000000000007',
};
const ROLES = Object.keys(U);
const psql = (args) => { const r = psqlSpawn(DB, args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; };
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => psql(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]).trim();

const R = {}; // 방 이름 → id
const DEVICE_TRUE = `create or replace function public._msgr2_device_ok() returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select true $$;
  create or replace function public._msgr2_device_app() returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select true $$;`;
let TEAM, PERS;
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
  psql(['-c', DEVICE_TRUE]); // U3 전 자리 함수는 닫힘(거짓) — 판정 행렬은 기기가 유효하다는 전제로 본다
  // 시드는 슈퍼유저(서비스 문맥)로 — 사람 경로(RPC)는 msgr2-access-rpc-pg가 따로 본다
  TEAM = sql(`insert into public.msgr2_spaces (kind, name, slug, owner_user_id) values ('team', '팀', 'team-a', '${U.owner}') returning id`);
  PERS = sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${U.owner}') returning id`);
  sql(`insert into public.msgr2_space_members (space_id, user_id, role) values
    ('${TEAM}', '${U.owner}', 'owner'), ('${TEAM}', '${U.admin}', 'admin'), ('${TEAM}', '${U.member}', 'member'), ('${TEAM}', '${U.guest}', 'guest'),
    ('${PERS}', '${U.owner}', 'owner')`);
  sql(`insert into public.msgr2_space_members (space_id, user_id, role, removed_at) values ('${TEAM}', '${U.removed}', 'member', now() - interval '1 day')`);
  const room = (name, space, kind, members, { removedMembers = [] } = {}) => {
    R[name] = sql(`insert into public.msgr2_rooms (space_id, kind, name, pair_key, created_by) values ('${space}', '${kind}', '${name}', ${kind === 'direct' ? `'${name}'` : 'null'}, '${U.owner}') returning id`);
    for (const m of members) sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id, added_by) values ('${R[name]}', 'user', '${U[m]}', '${U.owner}')`);
    for (const m of removedMembers) sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id, added_by, removed_at) values ('${R[name]}', 'user', '${U[m]}', '${U.owner}', now())`);
  };
  const TEAM_ROOM = ['owner', 'admin', 'member', 'guest', 'friend', 'removed'];
  room('team.open', TEAM, 'open', TEAM_ROOM);
  room('team.private', TEAM, 'private', TEAM_ROOM);
  room('team.direct', TEAM, 'direct', ['owner', 'member']);
  room('personal.open', PERS, 'open', ['owner', 'admin', 'member', 'guest', 'friend'], { removedMembers: ['removed'] });
  room('personal.private', PERS, 'private', ['owner', 'admin', 'member', 'guest', 'friend'], { removedMembers: ['removed'] });
  room('personal.direct', PERS, 'direct', ['owner', 'friend']);
  // 등급 추가 칸
  room('team-private-no-guest', TEAM, 'private', ['owner', 'admin', 'member']);
  room('personal-private-solo', PERS, 'private', ['owner']);
  room('team-open-guest-not-in-room', TEAM, 'open', ['owner']);
  // 실제 RLS 쓰기 시험 — 호출자 권한(security invoker)으로 글 한 줄을 넣어 보고 되돌린다
  sql(`create or replace function public.t_try_write(p_room uuid) returns boolean language plpgsql security invoker as $$
    begin
      begin
        insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values (p_room, 'user', auth.uid(), 'x');
        raise exception 'rollback_ok';
      exception when others then
        return sqlerrm = 'rollback_ok';
      end;
    end $$; grant execute on function public.t_try_write(uuid) to authenticated;`);
});

const flags = (row) => { const [rd, w, i, m, d] = row.split('|'); return `${rd === 't' ? 'R' : '-'}${w === 't' ? 'W' : '-'}${i === 't' ? 'I' : '-'}${m === 't' ? 'M' : '-'}${d === 't' ? 'D' : '-'}`; };
// 한 사람이 볼 수 있는 모든 것을 한 번의 psql로 읽는다: 방마다 판정 값 + 실제 방 행 읽기 + 실제 글 넣기
function observe(uid) {
  const names = Object.keys(R);
  const q = names.map((n) => `select '${n}', a.read, a.write, a.invite, a.manage, a.decide, coalesce(a.tier, ''), exists (select 1 from public.msgr2_rooms where id = '${R[n]}'), public.t_try_write('${R[n]}') from public.msgr2_access('${R[n]}') a`).join(' union all ');
  const out = {};
  for (const line of asUser(uid, q).split('\n').filter(Boolean)) {
    const [name, rd, w, i, m, d, tier, rlsRead, rlsWrite] = line.split('|');
    out[name] = { code: flags([rd, w, i, m, d].join('|')), tier: tier || null, rlsRead: rlsRead === 't', rlsWrite: rlsWrite === 't' };
  }
  return out;
}

test('행렬 — 기기 상태 앱: 공간 2 × 역할 7 × 방 3 × 행동 5가 기대값 파일과 칸마다 같고, read·write는 실제 RLS와도 같다', { skip }, () => {
  const exp = EXPECT.device.app;
  const bad = []; let cells = 0;
  for (const role of ROLES) {
    const seen = observe(U[role]);
    for (const space of ['team', 'personal']) for (const kind of ['open', 'private', 'direct']) {
      const got = seen[`${space}.${kind}`]; const want = exp[space][kind][role];
      cells += 5;
      if (got.code !== want) bad.push(`${space}.${kind}.${role}: 판정 ${got.code} ≠ 기대 ${want}`);
      if (got.rlsRead !== want.includes('R')) bad.push(`${space}.${kind}.${role}: RLS 읽기 ${got.rlsRead} ≠ 기대 ${want.includes('R')}`);
      if (got.rlsWrite !== want.includes('W')) bad.push(`${space}.${kind}.${role}: RLS 쓰기 ${got.rlsWrite} ≠ 기대 ${want.includes('W')}`);
      const wantTier = want.includes('R') ? EXPECT.tier[space][kind] : null;
      if (got.tier !== wantTier) bad.push(`${space}.${kind}.${role}: tier ${got.tier} ≠ 기대 ${wantTier}`);
    }
  }
  assert.equal(cells, 2 * 7 * 3 * 5, '칸 수');
  assert.deepEqual(bad, []);
});

test('등급(tier) — 사람이 주인뿐이면 owner, 손님 없는 팀 방은 team, 손님·공간 밖 사람이 섞이면 guest(보는 사람과 무관)', { skip }, () => {
  const seen = observe(U.owner);
  for (const [name, want] of Object.entries(EXPECT.tier.extra)) assert.equal(seen[name].tier, want, name);
  assert.equal(observe(U.member)['team-private-no-guest'].tier, 'team', '다른 사람이 봐도 같은 등급');
  // 팀 open 방은 owner·admin·member만 방 멤버 없이 들어간다 — 손님·공간 밖 사람은 방 멤버여야 한다(1-5 원칙 2)
  const g = observe(U.guest)['team-open-guest-not-in-room'];
  assert.equal(g.code, '-----', '방 멤버가 아닌 손님은 open 방도 못 본다'); assert.equal(g.rlsRead, false);
  assert.equal(observe(U.member)['team-open-guest-not-in-room'].code, 'RWI--', '멤버는 방 멤버가 아니어도 open 방에 들어간다');
});

test('보관된 방 — 읽기는 그대로, 쓰기·초대는 거짓(실제 RLS 쓰기도 거부)', { skip }, () => {
  sql(`update public.msgr2_rooms set archived_at = now() where id = '${R['team.private']}'`);
  try {
    const s = observe(U.owner)['team.private'];
    assert.equal(s.code, 'R--MD'); assert.equal(s.rlsRead, true); assert.equal(s.rlsWrite, false);
  } finally { sql(`update public.msgr2_rooms set archived_at = null where id = '${R['team.private']}'`); }
});

test('삭제된 공간·만료된 멤버·로그인 없음 — 모두 거짓', { skip }, () => {
  sql(`update public.msgr2_space_members set expires_at = now() - interval '1 minute' where space_id = '${TEAM}' and user_id = '${U.guest}'`);
  try { assert.equal(observe(U.guest)['team.private'].code, '-----', '기한이 지난 손님'); }
  finally { sql(`update public.msgr2_space_members set expires_at = null where space_id = '${TEAM}' and user_id = '${U.guest}'`); }
  sql(`update public.msgr2_spaces set deleted_at = now() where id = '${PERS}'`);
  try { assert.equal(observe(U.owner)['personal.private'].code, '-----', '삭제된 공간'); }
  finally { sql(`update public.msgr2_spaces set deleted_at = null where id = '${PERS}'`); }
  assert.equal(asUser('', `select (public.msgr2_access('${R['team.open']}')).read`), 'f', '로그인 없음');
});

test('기기 확인 자리 — _msgr2_device_ok()가 거짓이면 모든 칸이 거짓이고 RLS 읽기·쓰기도 0(U3가 같은 이름으로 정의한다)', { skip }, () => {
  sql(`create or replace function public._msgr2_device_ok() returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select false $$`);
  try {
    for (const role of ROLES) for (const [name, s] of Object.entries(observe(U[role]))) {
      assert.equal(s.code, '-----', `${role} ${name}`); assert.equal(s.rlsRead, false); assert.equal(s.rlsWrite, false);
    }
    assert.equal(asUser(U.owner, 'select count(*) from public.msgr2_spaces'), '0', '공간도 안 보인다');
  } finally {
    sql(`create or replace function public._msgr2_device_ok() returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select true $$`);
  }
  assert.equal(observe(U.owner)['team.open'].code, 'RWIMD', '되돌린 뒤 다시 참');
});

test('anon은 판정 함수·표 모두 못 쓴다', { skip }, () => {
  const r = psqlSpawn(DB, ['-A', '-t', '-c', `set role anon; select (public.msgr2_access('${R['team.open']}')).read`]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /permission denied/);
  const t = psqlSpawn(DB, ['-A', '-t', '-c', 'set role anon; select count(*) from public.msgr2_messages']);
  assert.notEqual(t.status, 0);
});
