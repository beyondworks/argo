// 초대 채널·사용 한도·미리보기·수락 v1/v2(20260918200000) — 0.1.30 초대 흐름 개편 1장.
// 권한 행렬(공개/비공개 × 관리자/방장/멤버/게스트), max_uses 동시 수락 경합, 만료·취소·소진, 미리보기 누출 없음,
// 옛 앱 호환(v1 uuid 반환·msgr_invite_invalid 하나·max_uses 기본 1·게스트 channel_id 단수·옛 수락 행 백필).
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
import { spawn } from 'node:child_process';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { // 고정 uuid — 값은 전부 이 파일의 상수(주입 표면 없음)
  owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333', guest: '44444444-4444-4444-8444-444444444444',
  outsider: '66666666-6666-4666-8666-666666666666', other: '77777777-7777-4777-8777-777777777777',
  n1: 'a1111111-1111-4111-8111-111111111111', n2: 'a2222222-2222-4222-8222-222222222222', n3: 'a3333333-3333-4333-8333-333333333333',
  n4: 'a4444444-4444-4444-8444-444444444444', n5: 'a5555555-5555-4555-8555-555555555555', n6: 'a6666666-6666-4666-8666-666666666666',
};

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();                 // 슈퍼유저(RLS 우회) — 시드·관찰 전용. BEFORE 트리거는 슈퍼유저에도 돈다
const sqlRaw = (q) => psqlRaw(['-A', '-t', '-c', q]);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';        // set_config 출력 뒤 마지막 결과 줄
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };


let ORG, OTHER_ORG, PUB, PRIV, PRIVM, DM, OTHER_PUB;
before(() => {
  if (!DB) return;
  psql(['-c', `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    create schema if not exists auth;
    grant usage on schema auth to anon, authenticated, service_role;
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    create schema if not exists storage;
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    create table if not exists storage.buckets (id text primary key, name text, public boolean not null default false);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    create schema if not exists realtime;
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb);
    create table if not exists realtime.sent (id bigint generated always as identity primary key, payload jsonb, event text, topic text, private boolean);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
      language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
    alter table realtime.messages enable row level security;
    grant select, insert on realtime.messages to authenticated;
    grant usage on schema realtime to authenticated;
  `]);
  // Supabase's outbound HTTP extension is stubbed; all Messenger SQL, RLS and triggers run unchanged.
  sql(`create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  const migrationDir=fileURLToPath(new URL('../supabase/migrations/',import.meta.url));
  for(const f of readdirSync(migrationDir).filter(f=>/^\d+_msgr.*\.sql$/.test(f)).sort()) {
    const source=readFileSync(mig(f),'utf8');
    psql(['-c',source.replace(/^create extension if not exists pg_net;$/m,'')]);
  }
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean-AX', 'lean-ax', '${U.owner}') returning id`));
  OTHER_ORG = last(asUser(U.other, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Other', 'other', '${U.other}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 30 where org_id = '${ORG}'`);
  for (const [uid, role] of [[U.admin, 'admin'], [U.member, 'member']]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  PUB = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}', 'public', 'general')`));
  PRIV = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}', 'private', 'Lean Crew')`));   // 방장 = owner
  sql(`update public.msgr_channels set topic = '비밀 주제' where id = '${PRIV}'`);
  PRIVM = last(asUser(U.member, `select public.msgr_create_channel('${ORG}', 'private', 'member-room')`)); // 방장 = member(조직 관리자 아님)
  DM = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}', 'dm', 'o-m', '[{"kind":"user","id":"${U.member}"}]')`));
  OTHER_PUB = last(asUser(U.other, `select public.msgr_create_channel('${OTHER_ORG}', 'public', 'x')`));
  // 게스트: PRIVM에 게스트 초대로 들어온 사람
  const gcode = last(asUser(U.member, `insert into public.msgr_invites (org_id, role, channel_id, created_by) values ('${ORG}', 'guest', '${PRIVM}', '${U.member}') returning code`));
  assert.equal(last(asUser(U.guest, `select public.msgr_accept_invite('${gcode}')`)), ORG);
});

test('전제: 관리자·멤버·게스트, 공개·비공개(owner·member 방장)·DM, 다른 조직', { skip }, () => {
  assert.equal(sql(`select string_agg(role, ',' order by role) from public.msgr_org_members where org_id = '${ORG}' and removed_at is null`), 'admin,guest,member,owner');
  assert.ok(PUB && PRIV && PRIVM && DM && OTHER_PUB);
});

// 초대 만들기(사용자 권한) — 성공이면 code, 실패면 raw
const mkInvite = (uid, cols) => {
  const keys = Object.keys(cols); const vals = keys.map((k) => cols[k]);
  return asUserRaw(uid, `insert into public.msgr_invites (org_id, created_by, ${keys.join(', ')}) values ('${ORG}', '${uid}', ${vals.join(', ')}) returning code`);
};
const arr = (...ids) => `array[${ids.map((x) => `'${x}'`).join(', ')}]::uuid[]`;
const codeOf = (raw) => { assert.equal(raw.status, 0, raw.stderr); return last(raw.stdout); };
const v2 = (uid, code) => JSON.parse(last(asUser(uid, `select public.msgr_accept_invite_v2('${code}')`)));
const preview = (uid, code) => JSON.parse(last(asUser(uid, `select public.msgr_invite_preview('${code}')`)));
const inChannel = (uid, ch) => sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${uid}'`) === '1';

test('만들기 권한 행렬: 조직 초대는 관리자만, 비공개 채널은 방장만, 게스트는 채널 1개(비공개), DM·다른 조직·보관 불가', { skip }, () => {
  // 관리자(owner·admin): 공개 + 비공개(관리자는 모든 비공개 채널의 방장)
  codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PUB, PRIV) }));
  codeOf(mkInvite(U.admin, { role: `'member'`, channel_ids: arr(PRIV, PRIVM) }));
  // 일반 멤버는 조직 초대를 만들 수 없다(총괄 결정 — 권한을 넓히지 않는다) — 공개 채널만 넣어도
  fails(mkInvite(U.member, { role: `'member'`, channel_ids: arr(PUB) }), /row-level security/, '멤버의 조직 초대');
  fails(mkInvite(U.member, { role: `'member'` }), /row-level security/, '멤버의 채널 없는 조직 초대');
  // 게스트 초대: 자기가 방장인 비공개 채널 1개는 된다(지금과 같다)
  codeOf(mkInvite(U.member, { role: `'guest'`, channel_ids: arr(PRIVM) }));
  fails(mkInvite(U.member, { role: `'guest'`, channel_ids: arr(PRIV) }), /msgr_invite_channel_forbidden/, '방장 아닌 비공개 채널');
  fails(mkInvite(U.member, { role: `'guest'`, channel_ids: arr(PUB) }), /row-level security/, '게스트 초대는 비공개 채널만(지금과 같다)');
  fails(mkInvite(U.owner, { role: `'guest'`, channel_ids: arr(PRIV, PRIVM) }), /msgr_invite_guest_one_channel/, '게스트는 채널 1개');
  fails(mkInvite(U.owner, { role: `'guest'` }), /msgr_invite_guest_one_channel/, '게스트는 채널 0개도 불가');
  fails(mkInvite(U.guest, { role: `'guest'`, channel_ids: arr(PRIVM) }), /msgr_invite_channel_forbidden|row-level security/, '게스트는 초대를 못 만든다');
  // 넣을 수 없는 채널
  fails(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(DM) }), /msgr_invite_channel_invalid/, 'DM');
  fails(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(OTHER_PUB) }), /msgr_invite_channel_invalid/, '다른 조직 채널');
  fails(mkInvite(U.owner, { role: `'member'`, channel_ids: arr('00000000-0000-4000-8000-000000000000') }), /msgr_invite_channel_invalid/, '없는 채널');
  const arch = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}', 'public', 'old')`));
  sql(`update public.msgr_channels set archived_at = now() where id = '${arch}'`);
  fails(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(arch) }), /msgr_invite_channel_invalid/, '보관된 채널');
  fails(mkInvite(U.owner, { role: `'member'`, channel_id: `'${PRIV}'` }), /msgr_invite_channel_invalid|msgr_invites_channel_guest/, '단수 channel_id는 게스트 전용');
  // 사용 횟수·취소는 만들 때 위조할 수 없다, 중복 채널은 한 번만, max_uses 기본 1
  const code = codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PUB, PUB, PRIV), use_count: '5', revoked_at: 'now()' }));
  assert.equal(sql(`select use_count || '|' || coalesce(revoked_at::text, 'null') || '|' || max_uses || '|' || array_to_string(channel_ids, ',') from public.msgr_invites where code = '${code}'`), `0|null|1|${PUB},${PRIV}`);
});

test('옛 앱 게스트 초대(channel_id 단수) → channel_ids가 채워지고, 옛 앱 조직 초대는 1회용 기본값', { skip }, () => {
  const g = codeOf(mkInvite(U.member, { role: `'guest'`, channel_id: `'${PRIVM}'` }));
  assert.equal(sql(`select array_to_string(channel_ids, ',') || '|' || channel_id from public.msgr_invites where code = '${g}'`), `${PRIVM}|${PRIVM}`);
  const m = codeOf(mkInvite(U.owner, { role: `'member'` }));
  assert.equal(sql(`select max_uses || '|' || use_count || '|' || (array_length(channel_ids, 1) is null) from public.msgr_invites where code = '${m}'`), '1|0|true');
});

test('v2 수락: 조직 멤버 + 채널 전부 참여, 첫 채널 id 반환, added_by = 초대 만든 사람', { skip }, () => {
  const code = codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PRIV, PUB), max_uses: 'null' }));
  const r = v2(U.n1, code);
  assert.deepEqual(r, { org_id: ORG, channel_id: PRIV, joined_channel_ids: [PRIV, PUB], skipped_channel_ids: [] });
  assert.equal(sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.n1}' and removed_at is null`), 'member');
  assert.ok(inChannel(U.n1, PRIV) && inChannel(U.n1, PUB), '두 채널 모두 사람 멤버');
  assert.equal(sql(`select added_by from public.msgr_channel_members where channel_id = '${PRIV}' and member_id = '${U.n1}'`), U.owner);
  assert.equal(sql(`select use_count || '|' || accepted_by from public.msgr_invites where code = '${code}'`), `1|${U.n1}`, '첫 사용자 = accepted_by(옛 앱 목록 호환)');
});

test('v1 수락(옛 앱·노드): 반환은 조직 id 그대로, 채널도 참여, 쓸 수 없는 초대는 전부 msgr_invite_invalid', { skip }, () => {
  const code = codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PRIV) }));
  assert.equal(last(asUser(U.n2, `select public.msgr_accept_invite('${code}')`)), ORG, 'uuid 반환 — 옛 앱 setOrgId');
  assert.ok(inChannel(U.n2, PRIV), 'v1도 채널까지 넣는다(유건 사례: 비공개 Lean Crew만 있는 조직)');
  fails(asUserRaw(U.n3, `select public.msgr_accept_invite('${code}')`), /msgr_invite_invalid/, '소진(1회용 기본)');
  fails(asUserRaw(U.n3, `select public.msgr_accept_invite('deadbeef')`), /msgr_invite_invalid/, '없음');
  const exp = codeOf(mkInvite(U.owner, { role: `'member'`, expires_at: `now() - interval '1 minute'` }));
  fails(asUserRaw(U.n3, `select public.msgr_accept_invite('${exp}')`), /msgr_invite_invalid/, '만료');
  const rev = codeOf(mkInvite(U.owner, { role: `'member'` }));
  asUser(U.owner, `select public.msgr_invite_revoke((select id from public.msgr_invites where code = '${rev}'))`);
  fails(asUserRaw(U.n3, `select public.msgr_accept_invite('${rev}')`), /msgr_invite_invalid/, '취소');
  assert.equal(sql(`select count(*) from public.msgr_org_members where user_id = '${U.n3}'`), '0', '실패한 수락은 아무것도 남기지 않는다');
});

test('v2 오류는 상태별: not_found · expired · revoked · exhausted', { skip }, () => {
  fails(asUserRaw(U.n3, `select public.msgr_accept_invite_v2('deadbeef')`), /msgr_invite_not_found/, '없음');
  const exp = codeOf(mkInvite(U.owner, { role: `'member'`, expires_at: `now() - interval '1 minute'` }));
  fails(asUserRaw(U.n3, `select public.msgr_accept_invite_v2('${exp}')`), /msgr_invite_expired/, '만료');
  const rev = codeOf(mkInvite(U.owner, { role: `'member'` }));
  asUser(U.admin, `select public.msgr_invite_revoke((select id from public.msgr_invites where code = '${rev}'))`);
  fails(asUserRaw(U.n3, `select public.msgr_accept_invite_v2('${rev}')`), /msgr_invite_revoked/, '취소');
  const one = codeOf(mkInvite(U.owner, { role: `'member'`, max_uses: '1' }));
  v2(U.n3, one);
  fails(asUserRaw(U.n4, `select public.msgr_accept_invite_v2('${one}')`), /msgr_invite_exhausted/, '소진');
  const forever = codeOf(mkInvite(U.owner, { role: `'member'`, expires_at: 'null', max_uses: 'null' }));
  assert.equal(v2(U.n4, forever).org_id, ORG, '만료 없음(null)·제한 없음(null)');
});

test('취소: 관리자·채널 관리자만(볼 수 없는 사람에겐 없는 초대), 옛 앱의 delete도 그대로 된다', { skip }, () => {
  const code = codeOf(mkInvite(U.owner, { role: `'member'` }));
  const id = sql(`select id from public.msgr_invites where code = '${code}'`);
  fails(asUserRaw(U.member, `select public.msgr_invite_revoke('${id}')`), /msgr_invite_not_found/, '멤버는 조직 초대를 취소 못 한다');
  fails(asUserRaw(U.outsider, `select public.msgr_invite_revoke('${id}')`), /msgr_invite_not_found/, '바깥 사람');
  asUser(U.admin, `select public.msgr_invite_revoke('${id}')`);
  assert.notEqual(sql(`select coalesce(revoked_at::text, '') from public.msgr_invites where id = '${id}'`), '');
  const g = codeOf(mkInvite(U.member, { role: `'guest'`, channel_ids: arr(PRIVM) }));
  asUser(U.member, `select public.msgr_invite_revoke((select id from public.msgr_invites where code = '${g}'))`); // 채널 관리자는 자기 채널 게스트 초대를 취소
  const old = codeOf(mkInvite(U.owner, { role: `'member'` }));
  assert.equal(last(asUser(U.admin, `delete from public.msgr_invites where code = '${old}' returning 1`)), '1', '옛 앱 delete');
  fails(asUserRaw(U.n5, `select public.msgr_accept_invite_v2('${old}')`), /msgr_invite_not_found/, '지운 초대는 없음');
});

test('건너뜀: 그사이 보관된 채널, 만든 사람이 방장이 아니게 된 비공개 채널 — 나머지는 진행', { skip }, () => {
  const tmp = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}', 'public', 'soon-archived')`));
  const code = codeOf(mkInvite(U.admin, { role: `'member'`, channel_ids: arr(tmp, PRIV, PUB), max_uses: 'null' }));
  sql(`update public.msgr_channels set archived_at = now() where id = '${tmp}'`);
  sql(`update public.msgr_org_members set role = 'member' where org_id = '${ORG}' and user_id = '${U.admin}'`); // 초대 만든 관리자가 강등 → PRIV의 방장이 아님
  try {
    const r = v2(U.n5, code);
    assert.deepEqual(r, { org_id: ORG, channel_id: PUB, joined_channel_ids: [PUB], skipped_channel_ids: [tmp, PRIV] });
    assert.ok(!inChannel(U.n5, PRIV) && inChannel(U.n5, PUB));
  } finally { sql(`update public.msgr_org_members set role = 'admin' where org_id = '${ORG}' and user_id = '${U.admin}'`); }
});

test('같은 사람이 다시 열면 한 번 더 세지 않는다 — 단, 쫓겨난 뒤에는 새 사용으로 센다(옛 1회용 링크로 못 돌아온다)', { skip }, () => {
  const code = codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PUB), max_uses: '2' }));
  v2(U.n6, code); v2(U.n6, code);
  assert.equal(sql(`select use_count from public.msgr_invites where code = '${code}'`), '1', '재수락은 세지 않는다');
  const once = codeOf(mkInvite(U.owner, { role: `'member'`, max_uses: '1' }));
  const who = '99999999-9999-4999-8999-999999999991';
  sql(`insert into auth.users (id, created_at, email) values ('${who}', now(), 'back@example.test') on conflict do nothing`);
  v2(who, once);
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${who}'`);
  fails(asUserRaw(who, `select public.msgr_accept_invite_v2('${once}')`), /msgr_invite_exhausted/, '쫓겨난 뒤 옛 1회용 링크');
});

test('동시 수락 경합: max_uses 2에 세 명이 동시에 — 정확히 둘만 들어오고 셋째는 exhausted', { skip }, async () => {
  const code = codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PUB), max_uses: '2' }));
  const racers = ['99999999-9999-4999-8999-99999999a001', '99999999-9999-4999-8999-99999999a002', '99999999-9999-4999-8999-99999999a003'];
  for (const r of racers) sql(`insert into auth.users (id, created_at, email) values ('${r}', now(), '${r.slice(-4)}@example.test') on conflict do nothing`);
  // 각자 수락한 뒤 커밋 전에 잠시 머문다 — 셋이 같은 행을 두고 겹치게
  const run = (uid) => new Promise((resolve) => {
    const p = spawn('psql', [DB, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c',
      `begin; set local role authenticated; select set_config('argo.uid', '${uid}', true); select public.msgr_accept_invite_v2('${code}'); select pg_sleep(0.4); commit;`]);
    let err = ''; p.stderr.on('data', (d) => { err += d; }); p.on('close', (status) => resolve({ uid, status, err }));
  });
  const out = await Promise.all(racers.map(run));
  const ok = out.filter((o) => o.status === 0); const bad = out.filter((o) => o.status !== 0);
  assert.equal(ok.length, 2, JSON.stringify(out));
  assert.equal(bad.length, 1); assert.match(bad[0].err, /msgr_invite_exhausted/, '셋째는 제약 위반이 아니라 exhausted로 거절');
  assert.equal(sql(`select use_count from public.msgr_invites where code = '${code}'`), '2');
  assert.equal(sql(`select count(*) from public.msgr_invite_uses u join public.msgr_invites i on i.id = u.invite_id where i.code = '${code}'`), '2');
});

test('미리보기: 행선지(조직·채널 이름·초대자·역할·만료)만, 주제·멤버는 없다 — 쓸 수 없는 초대는 {state, org_name}, 틀린 코드는 not_found 하나', { skip }, () => {
  const code = codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PRIV, PUB), max_uses: '10' }));
  const p = preview(U.outsider, code);
  assert.deepEqual(Object.keys(p).sort(), ['channels', 'expires_at', 'inviter_name', 'org_id', 'org_name', 'role', 'state'], '사용 횟수도 싣지 않는다(설계서 1-3 목록)');
  assert.equal(p.state, 'valid'); assert.equal(p.org_name, 'Lean-AX'); assert.equal(p.role, 'member'); assert.equal(p.inviter_name, 'owner');
  assert.deepEqual(p.channels, [{ id: PRIV, name: 'Lean Crew', kind: 'private' }, { id: PUB, name: 'general', kind: 'public' }], '비공개 채널 이름은 의도(설계서 4장)');
  assert.ok(!JSON.stringify(p).includes('비밀 주제'), '주제는 싣지 않는다');
  assert.equal(sql(`select use_count from public.msgr_invites where code = '${code}'`), '0', '미리보기는 사용을 세지 않는다');
  fails(asUserRaw(U.outsider, `select public.msgr_invite_preview('deadbeef')`), /msgr_invite_not_found/, '틀린 코드');
  fails(psqlRaw(['-A', '-t', '-c', `set role anon; select public.msgr_invite_preview('${code}')`]), /permission denied/, '로그인 없이는 못 본다');
  const exp = codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PRIV), expires_at: `now() - interval '1 minute'` }));
  assert.deepEqual(preview(U.outsider, exp), { state: 'expired', org_name: 'Lean-AX' });
  const rev = codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PRIV) }));
  asUser(U.owner, `select public.msgr_invite_revoke((select id from public.msgr_invites where code = '${rev}'))`);
  assert.deepEqual(preview(U.outsider, rev), { state: 'revoked', org_name: 'Lean-AX' });
  const one = codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PUB) }));
  const fresh = '99999999-9999-4999-8999-99999999c001';
  sql(`insert into auth.users (id, created_at, email) values ('${fresh}', now(), 'fresh@example.test') on conflict do nothing`);
  v2(fresh, one); // 새 사람만 사용을 센다
  assert.deepEqual(preview(U.outsider, one), { state: 'exhausted', org_name: 'Lean-AX' });
  // 이미 멤버: 채널까지 전부 참여 중이면 already_member, 일부만이면 valid
  const both = codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PUB, PRIV), max_uses: 'null' }));
  assert.equal(preview(U.n1, both).state, 'already_member', 'n1은 PUB·PRIV 둘 다 참여 중');
  assert.equal(preview(U.n2, both).state, 'valid', 'n2는 PRIV만 — PUB이 남았다');
});

test('옛 수락 행 백필: 이미 쓰인 옛 초대는 사용 1회로 세어져 재사용 불가, 옛 게스트 초대는 채널 목록이 채워진다(마이그레이션 재실행 멱등)', { skip }, () => {
  // 마이그레이션 전 모양의 행을 트리거 없이 만든다(수락됨·use_count 0 / 게스트·channel_ids 비어 있음)
  psql(['-c', `set session_replication_role = replica;
    insert into public.msgr_invites (org_id, role, created_by, accepted_by, accepted_at, code, use_count) values ('${ORG}', 'member', '${U.owner}', '${U.n1}', now(), 'legacy-used', 0);
    insert into public.msgr_invites (org_id, role, created_by, channel_id, guest_days, code, channel_ids) values ('${ORG}', 'guest', '${U.member}', '${PRIVM}', 10, 'legacy-guest', '{}');
    set session_replication_role = origin;`]);
  psql(['-c', readFileSync(mig('20260918200000_msgr_invite_channels.sql'), 'utf8')]); // 재실행
  assert.equal(sql(`select use_count || '|' || max_uses from public.msgr_invites where code = 'legacy-used'`), '1|1');
  fails(asUserRaw(U.outsider, `select public.msgr_accept_invite('legacy-used')`), /msgr_invite_invalid/, '옛 1회용은 계속 1회용');
  assert.equal(sql(`select array_to_string(channel_ids, ',') from public.msgr_invites where code = 'legacy-guest'`), PRIVM);
});

test('사용 기록 표: 그 초대를 볼 수 있는 사람(관리자)만 본다 — 멤버·당사자는 못 본다', { skip }, () => {
  assert.notEqual(last(asUser(U.owner, `select count(*) from public.msgr_invite_uses`)), '0');
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_invite_uses u join public.msgr_invites i on i.id = u.invite_id where i.channel_id is null`)), '0');
  assert.equal(last(asUser(U.n1, `select count(*) from public.msgr_invite_uses`)), '0');
});

test('강등 없음(검토 #610 MEDIUM): owner·admin이 멤버 링크를 열어도 역할 그대로 + 채널만 참여, 사용 횟수는 세지 않는다', { skip }, () => {
  const room = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}', 'public', 'launch')`));
  sql(`delete from public.msgr_channel_members where channel_id = '${room}'`); // 만든 owner도 빼고 시작 — 수락이 넣는지 본다
  const code = codeOf(mkInvite(U.admin, { role: `'member'`, channel_ids: arr(room), max_uses: '1' }));
  for (const [uid, role] of [[U.owner, 'owner'], [U.admin, 'admin']]) {
    const r = v2(uid, code);
    assert.equal(r.channel_id, room);
    assert.equal(sql(`select role || '|' || coalesce(expires_at::text, 'null') from public.msgr_org_members where org_id = '${ORG}' and user_id = '${uid}'`), `${role}|null`, `${role}는 강등되지 않는다`);
    assert.ok(inChannel(uid, room));
  }
  assert.equal(last(asUser(U.owner, `select public.msgr_accept_invite('${code}')`)), ORG, 'v1도 같은 본체');
  assert.equal(sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.owner}'`), 'owner');
  assert.equal(sql(`select use_count || '|' || coalesce(accepted_by::text, 'null') from public.msgr_invites where code = '${code}'`), '0|null', '기존 멤버는 새 사람용 1회 링크를 써 버리지 않는다');
  assert.equal(sql(`select count(*) from public.msgr_invite_uses u join public.msgr_invites i on i.id = u.invite_id where i.code = '${code}'`), '2', '기록은 남긴다');
  const newcomer = '99999999-9999-4999-8999-99999999b001';
  sql(`insert into auth.users (id, created_at, email) values ('${newcomer}', now(), 'newcomer@example.test') on conflict do nothing`);
  assert.equal(v2(newcomer, code).org_id, ORG, '새 사람은 아직 쓸 수 있다');
  assert.equal(sql(`select use_count from public.msgr_invites where code = '${code}'`), '1');
});

test('게스트가 멤버 링크를 열면 member로 올라가고 게스트 기한이 지워진다 — 더 낮은 역할 링크는 아무것도 바꾸지 않는다', { skip }, () => {
  const before = sql(`select role || '|' || (expires_at is not null) from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.guest}'`);
  assert.equal(before, 'guest|true', '전제: 기한 있는 게스트');
  const code = codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PUB) }));
  v2(U.guest, code);
  assert.equal(sql(`select role || '|' || coalesce(expires_at::text, 'null') from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.guest}'`), 'member|null');
  assert.ok(inChannel(U.guest, PUB));
  // 이제 member인 사람이 게스트 링크를 열어도 강등되지 않는다(기존 규칙 유지)
  const g = codeOf(mkInvite(U.member, { role: `'guest'`, channel_ids: arr(PRIVM) }));
  v2(U.guest, g);
  assert.equal(sql(`select role || '|' || coalesce(expires_at::text, 'null') from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.guest}'`), 'member|null');
});

test('다시 들어오기(main·라이브 기존 결함): 제거된 멤버·기한 지난 게스트가 관리자의 새 초대로 다시 들어온다', { skip }, () => {
  const who = '99999999-9999-4999-8999-99999999d001'; const g = '99999999-9999-4999-8999-99999999d002';
  for (const [id, mail] of [[who, 'rejoin'], [g, 'reguest']]) sql(`insert into auth.users (id, created_at, email) values ('${id}', now(), '${mail}@example.test') on conflict do nothing`);
  v2(who, codeOf(mkInvite(U.owner, { role: `'member'` })));
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${who}'`);
  assert.equal(last(asUser(who, `select public.msgr_accept_invite('${codeOf(mkInvite(U.owner, { role: `'member'`, channel_ids: arr(PUB) }))}')`)), ORG, 'v1로도 다시 들어온다');
  assert.equal(sql(`select role || '|' || (removed_at is null) from public.msgr_org_members where org_id = '${ORG}' and user_id = '${who}'`), 'member|true');
  assert.ok(inChannel(who, PUB));
  v2(g, codeOf(mkInvite(U.owner, { role: `'guest'`, channel_ids: arr(PRIV), guest_days: '3' })));
  sql(`update public.msgr_org_members set expires_at = now() - interval '1 day' where org_id = '${ORG}' and user_id = '${g}'`);
  v2(g, codeOf(mkInvite(U.owner, { role: `'guest'`, channel_ids: arr(PRIV), guest_days: '5' })));
  assert.equal(sql(`select role || '|' || (expires_at > now() + interval '4 days') from public.msgr_org_members where org_id = '${ORG}' and user_id = '${g}'`), 'guest|true', '새 게스트 기한');
});

test('가드 예외는 수락 본체만: 플래그를 위조해 유효한 관리자 초대 id를 실어도 본인 역할을 올리지 못한다(사용 기록이 없다)', { skip }, () => {
  const adminInvite = sql(`select id from public.msgr_invites where code = '${codeOf(mkInvite(U.owner, { role: `'admin'` }))}'`);
  const r = asUserRaw(U.member, `select set_config('msgr.invite_accept', '${adminInvite}', true); update public.msgr_org_members set role = 'admin' where org_id = '${ORG}' and user_id = '${U.member}'`);
  assert.notEqual(r.status, 0, '위조 플래그로 역할 상승이 허용됨');
  assert.match(r.stderr, /msgr_member_self_only_name/);
  assert.equal(sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.member}'`), 'member');
  assert.equal(sql(`select count(*) from public.msgr_invite_uses where invite_id = '${adminInvite}'`), '0');
  fails(asUserRaw(U.member, `insert into public.msgr_invite_uses (invite_id, user_id) values ('${adminInvite}', '${U.member}')`), /permission denied|row-level security/, '사용 기록은 사용자가 쓸 수 없다');
});

test('재검토 A: 역할이 올라가는 수락은 센다 — 1회용 관리자 링크를 기존 멤버 둘이 열면 첫째만 admin(use_count 1), 둘째는 exhausted', { skip }, () => {
  const a = '99999999-9999-4999-8999-99999999e001'; const b = '99999999-9999-4999-8999-99999999e002';
  for (const [id, mail] of [[a, 'ra'], [b, 'rb']]) {
    sql(`insert into auth.users (id, created_at, email) values ('${id}', now(), '${mail}@example.test') on conflict do nothing`);
    v2(id, codeOf(mkInvite(U.owner, { role: `'member'` })));
  }
  const roleOf = (u) => sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${u}'`);
  const code = codeOf(mkInvite(U.owner, { role: `'admin'`, max_uses: '1' }));
  v2(a, code);
  assert.equal(roleOf(a), 'admin');
  assert.equal(sql(`select use_count || '|' || accepted_by from public.msgr_invites where code = '${code}'`), `1|${a}`, '역할 상승은 사용 1회');
  fails(asUserRaw(b, `select public.msgr_accept_invite_v2('${code}')`), /msgr_invite_exhausted/, '둘째 기존 멤버');
  fails(asUserRaw(b, `select public.msgr_accept_invite('${code}')`), /msgr_invite_invalid/, 'v1도 같은 판정');
  assert.equal(roleOf(b), 'member', '둘째는 그대로 member');
  globalThis.__raisedAdmin = a; globalThis.__adminInvite = sql(`select id from public.msgr_invites where code = '${code}'`);
});

test('재검토 B: 과거에 그 초대를 쓴 사람이 강등된 뒤 위조 플래그로 역할을 되돌리지 못한다(가드는 이 트랜잭션의 기록만 인정)', { skip }, () => {
  const a = globalThis.__raisedAdmin; const id = globalThis.__adminInvite;
  sql(`update public.msgr_org_members set role = 'member' where org_id = '${ORG}' and user_id = '${a}'`); // 관리자가 강등
  assert.equal(sql(`select count(*) from public.msgr_invite_uses where invite_id = '${id}' and user_id = '${a}'`), '1', '전제: 과거 사용 기록');
  const r = asUserRaw(a, `select set_config('msgr.invite_accept', '${id}', false); update public.msgr_org_members set role = 'admin' where org_id = '${ORG}' and user_id = '${a}'`);
  assert.notEqual(r.status, 0, '과거 기록 + 위조 플래그로 역할 상승이 허용됨');
  assert.match(r.stderr, /msgr_member_self_only_name/);
  assert.equal(sql(`select role from public.msgr_org_members where org_id = '${ORG}' and user_id = '${a}'`), 'member');
});

test('재검토 D: 같은 트랜잭션에서 게스트 초대를 수락한 직후 위조 플래그로 자기 게스트 기한을 늘리지 못한다(초대의 guest_days가 상한)', { skip }, () => {
  const who = '99999999-9999-4999-8999-99999999f001';
  sql(`insert into auth.users (id, created_at, email) values ('${who}', now(), 'extend@example.test') on conflict do nothing`);
  const code = codeOf(mkInvite(U.member, { role: `'guest'`, channel_ids: arr(PRIVM), guest_days: '3' }));
  const id = sql(`select id from public.msgr_invites where code = '${code}'`);
  const r = psqlRaw(['-A', '-t', '-c', `begin; set local role authenticated; select set_config('argo.uid', '${who}', true); select public.msgr_accept_invite_v2('${code}'); select set_config('msgr.invite_accept', '${id}', true); update public.msgr_org_members set expires_at = '2099-01-01' where org_id = '${ORG}' and user_id = '${who}'; commit;`]);
  assert.notEqual(r.status, 0, '같은 트랜잭션의 위조 플래그로 기한 연장이 허용됨');
  assert.match(r.stderr, /msgr_member_self_only_name/);
  assert.equal(sql(`select count(*) from public.msgr_org_members where org_id = '${ORG}' and user_id = '${who}'`), '0', '트랜잭션 전체가 되돌려진다');
  // 정상 수락은 그대로 된다(기한 = 초대의 guest_days)
  v2(who, code);
  assert.equal(sql(`select (expires_at <= now() + interval '3 days') and (expires_at > now() + interval '2 days') from public.msgr_org_members where org_id = '${ORG}' and user_id = '${who}'`), 't');
});
