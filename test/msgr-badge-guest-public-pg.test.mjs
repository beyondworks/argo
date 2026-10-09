// 앱 아이콘 배지 숫자의 채널 범위(H43, 20261009130000_msgr_badge_guest_public.sql) — 같은 파일 안에서 수정 전(빨강 재현) → 수정 뒤를 잰다.
// 배지 셈법 한 곳 msgr_push_unread_by_channel(합계 msgr_push_unread_total·앱 읽기 msgr_my_badge가 이 함수를 쓴다)의 채널 범위가
// 푸시 수신자 판정(msgr_push_recipients = msgr_can_read_channel을 그 사람 기준으로)과 같아야 한다.
//   빨강: 게스트(참여 행 없음·있음)·만료 멤버·제외된 사람·삭제된 조직 사람의 공개 채널 멘션, 제거·만료된 사람의 비공개 채널 참여 행이 숫자로 잡힌다.
//   그대로: owner·admin·member의 공개 채널 멘션, 비공개 채널 참여자, 초대받은 게스트의 비공개 채널, 조직 1:1, 개인 1:1(조직 없음).
// 실행: bash scripts/billing-pg-drill.sh test/msgr-badge-guest-public-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-badge-guest-public-pg.test.mjs';
const FIX = '20261009130000_msgr_badge_guest_public.sql';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = {
  a: '11111111-1111-4111-8111-111111111111', // 두 조직의 owner — 채널을 만들고 모두를 멘션한다
  b: '22222222-2222-4222-8222-222222222222', // member — 공개 채널 참여, 비공개 채널·1:1 참여자
  ad: '33333333-3333-4333-8333-333333333333', // admin — 공개 채널에 참여 안 함(공개 갈래만)
  g: '44444444-4444-4444-8444-444444444444', // guest — 공개 채널 참여 행 없음, 비공개 채널 하나에 초대됨
  gp: '55555555-5555-4555-8555-555555555555', // guest — 공개 채널 참여 행만 남음(강등·#846 이전에 들어간 행)
  ex: '66666666-6666-4666-8666-666666666666', // member — 비공개 채널 참여자, 뒤에 expires_at이 지난다
  rm: '77777777-7777-4777-8777-777777777777', // member — 비공개 채널 참여자, 뒤에 조직에서 제거된다(removed_at) — 참여 행이 남은 경우를 잰다
  xc: '88888888-8888-4888-8888-888888888888', // member — 공개 채널 excluded_user_ids에 든다(참여 행 없음)
  dl: '99999999-9999-4999-8999-999999999999', // 두 번째 조직의 member — 그 조직이 삭제된다(deleted_at)
  x: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', // 조직 밖 — a와 개인 1:1(조직 없는 방)
};
const NAME = Object.fromEntries(Object.entries(U).map(([k, v]) => [v, k]));
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim(); // 슈퍼유저 — 시드·관찰 전용
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asUser = (uid, q) => { const r = asUserRaw(uid, q); if (r.status !== 0) throw new Error(`psql 실패(${NAME[uid]}): ${r.stderr}`); return r.stdout.trim(); };
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const applyMig = (f) => psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
const ALL = Object.values(U);
const MENTION_ALL = `'${JSON.stringify(ALL.map((id) => ({ kind: 'user', id })))}'::jsonb`;
const post = (uid, ch) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '모두 봐줘', ${MENTION_ALL}, gen_random_uuid()::text) returning id`));

let PERSONAL;
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
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    create schema if not exists storage;
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    create table if not exists storage.buckets (id text primary key, name text, public boolean not null default false);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    create schema if not exists realtime;
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ select null::void $$;
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema if not exists net; create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql']) psql(['-c', readFileSync(mig(f), 'utf8')]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const files = readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort();
  assert.ok(files.includes(FIX), `${FIX}가 있어야 한다`);
  // 수정 직전까지 — 실제 적용 순서대로. 이 파일과 그 뒤 마이그레이션은 '적용' 단계에서 함께 적용한다.
  for (const f of files.filter((x) => x < FIX)) applyMig(f);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  // 개인 1:1(조직 없음) — 단계마다 새로 만들 수 없어 하나를 두고, 단계 시작마다 읽음 처리한다
  asUser(U.a, `select public.msgr_friend_request('${U.x}')`); asUser(U.x, `select public.msgr_friend_decide('${U.a}', true)`);
  PERSONAL = last(asUser(U.a, `select public.msgr_dm_personal('${U.x}')`));
});

// 단계마다 새 조직·채널을 만든다 — 수정 전 단계의 제거·만료·삭제가 수정 뒤 단계의 시드를 흐리지 않게.
function seed(tag) {
  const s = {};
  s.ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean ${tag}', 'lean-${tag}', '${U.a}') returning id`));
  s.ORG_D = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Del ${tag}', 'del-${tag}', '${U.a}') returning id`));
  for (const o of [s.ORG, s.ORG_D]) sql(`update public.msgr_org_entitlements set plan = 'team', seats = 20 where org_id = '${o}'`);
  // 멤버 시드는 슈퍼유저(게스트는 채널 링크로만 생긴다 — msgr-security-0197과 같은 방식)
  for (const [u, role] of [[U.b, 'member'], [U.ad, 'admin'], [U.g, 'guest'], [U.gp, 'guest'], [U.ex, 'member'], [U.rm, 'member'], [U.xc, 'member']]) {
    sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${s.ORG}', '${u}', '${role}')`);
  }
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${s.ORG_D}', '${U.dl}', 'member')`);
  s.PUB = last(asUser(U.a, `select public.msgr_create_channel('${s.ORG}', 'public', 'pub-${tag}')`));
  asUser(U.b, `select public.msgr_join_channel('${s.PUB}')`);
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${s.PUB}', 'user', '${U.gp}')`); // 공개 채널 참여 행만 남은 게스트
  s.PRIV = last(asUser(U.a, `select public.msgr_create_channel('${s.ORG}', 'private', 'priv-${tag}', '${JSON.stringify([U.b, U.ex, U.rm].map((id) => ({ kind: 'user', id })))}'::jsonb)`));
  s.PRIV_G = last(asUser(U.a, `select public.msgr_create_channel('${s.ORG}', 'private', 'g-${tag}')`));
  asUser(U.a, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${s.PRIV_G}', 'user', '${U.g}', '${U.a}')`);
  s.DM = last(asUser(U.a, `select public.msgr_create_channel('${s.ORG}', 'dm', 'dm:b-${tag}', '[{"kind":"user","id":"${U.b}"}]'::jsonb)`));
  s.PUB_D = last(asUser(U.a, `select public.msgr_create_channel('${s.ORG_D}', 'public', 'pubd-${tag}')`));
  asUser(U.dl, `select public.msgr_join_channel('${s.PUB_D}')`);
  s.PERSONAL = PERSONAL;
  // 개인 1:1은 앞 단계 글을 읽음 처리해 단계마다 같은 출발점
  for (const u of [U.a, U.x]) asUser(u, `insert into public.msgr_reads (channel_id, user_id, last_read_id) values ('${PERSONAL}', '${u}', coalesce((select max(id) from public.msgr_messages where channel_id = '${PERSONAL}'), 0)) on conflict (channel_id, user_id) do update set last_read_id = excluded.last_read_id`);
  // 채널마다 글쓴이 둘이 모두를 멘션한다 — 글쓴이 자신도 상대 글 하나를 받는다
  for (const [ch, w1, w2] of [[s.PUB, U.a, U.b], [s.PRIV, U.a, U.b], [s.PRIV_G, U.a, U.g], [s.DM, U.a, U.b], [s.PUB_D, U.a, U.dl], [PERSONAL, U.a, U.x]]) { post(w1, ch); post(w2, ch); }
  // 상태 변화(앱의 만료·제거·제외·조직 삭제와 같은 행 변경 — 시드는 슈퍼유저)
  sql(`update public.msgr_org_members set expires_at = now() - interval '1 hour' where org_id = '${s.ORG}' and user_id = '${U.ex}'`);
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${s.ORG}' and user_id = '${U.rm}'`);
  // 제거 트리거(msgr_member_offboard)가 참여 행을 지운다 — 트리거 밖에서 남은 행(예전 데이터·경합)을 흉내 내 참여 갈래의 조직 조건을 잰다
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${s.PRIV}', 'user', '${U.rm}') on conflict do nothing`);
  sql(`update public.msgr_channels set excluded_user_ids = array['${U.xc}']::uuid[] where id = '${s.PUB}'`);
  sql(`update public.msgr_orgs set deleted_at = now() where id = '${s.ORG_D}'`);
  return s;
}
const CHANNELS = ['PUB', 'PRIV', 'PRIV_G', 'DM', 'PUB_D', 'PERSONAL'];

// 관찰 — 사용자마다 채널별 배지(n), 합계, 그 사람으로 msgr_can_read_channel
function observe(tag) {
  const s = seed(tag);
  const byId = Object.fromEntries(CHANNELS.map((k) => [s[k], k]));
  const badge = {}; const total = {}; const sumAll = {}; const canRead = {};
  for (const [k, u] of Object.entries(U)) {
    badge[k] = Object.fromEntries(CHANNELS.map((c) => [c, 0]));
    const rows = sql(`select coalesce(string_agg(channel_id::text || '=' || n, ','), '') from public.msgr_push_unread_by_channel('${u}')`).split(',').filter(Boolean);
    sumAll[k] = 0;
    for (const r of rows) { const [id, n] = r.split('='); sumAll[k] += Number(n); if (byId[id]) badge[k][byId[id]] = Number(n); }
    total[k] = Number(sql(`select public.msgr_push_unread_total('${u}')`));
    const ids = CHANNELS.map((c) => `'${s[c]}'`).join(',');
    const cr = last(asUser(u, `select string_agg(x.id::text || '=' || public.msgr_can_read_channel(x.id)::text, ',') from unnest(array[${ids}]::uuid[]) x(id)`)).split(',');
    canRead[k] = Object.fromEntries(cr.map((r) => { const [id, v] = r.split('='); return [byId[id], v === 'true' || v === 't']; }));
  }
  // 앱이 읽는 배지(msgr_my_badge — auth.uid 기준): 게스트 g의 공개 채널 행
  const myG = asUser(U.g, `select coalesce(string_agg(channel_id::text || '=' || n, ','), '') from public.msgr_my_badge() where n > 0`);
  const gMyPub = last(myG).split(',').filter(Boolean).some((r) => r.startsWith(`${s.PUB}=`));
  return { s, badge, total, sumAll, canRead, gMyPub };
}

// 칸: [사용자, 채널, 수정 전, 수정 뒤]
const DEFECT = [
  ['g', 'PUB', 2, 0], // 게스트(참여 행 없음) — 공개 갈래가 역할을 안 봤다(두 글)
  ['gp', 'PUB', 2, 0], // 게스트(공개 채널 참여 행) — 참여 갈래가 공개 채널 게스트를 안 뺐다(두 글)
  ['ex', 'PUB', 2, 0], // 만료 멤버 — 공개 갈래가 expires_at을 안 봤다
  ['xc', 'PUB', 2, 0], // 제외된 사람 — 공개 갈래가 excluded_user_ids를 안 봤다
  ['dl', 'PUB_D', 1, 0], // 삭제된 조직의 멤버(참여 중) — 두 갈래 모두 조직 삭제를 안 봤다
  ['a', 'PUB_D', 1, 0], // 삭제된 조직의 owner(만든 사람·참여 중)
  ['ex', 'PRIV', 2, 0], // 만료 멤버의 비공개 채널 참여 행 — 참여 갈래가 조직 멤버 상태를 안 봤다
  ['rm', 'PRIV', 2, 0], // 제거된 멤버에게 남은 비공개 채널 참여 행
];
const SAME = [
  ['a', 'PUB', 1], ['b', 'PUB', 1], ['ad', 'PUB', 2], // owner·member·admin(참여 안 함)
  ['rm', 'PUB', 0], // 제거된 멤버(참여 행 없음)는 수정 전에도 0 — 공개 갈래가 removed_at은 봤다(변이 시험의 잠금 칸)
  ['a', 'PRIV', 1], ['b', 'PRIV', 1], // 비공개 채널 참여자
  ['a', 'PRIV_G', 1], ['g', 'PRIV_G', 1], // 초대받은 게스트의 비공개 채널
  ['a', 'DM', 1], ['b', 'DM', 1], // 조직 1:1
  ['a', 'PERSONAL', 1], ['x', 'PERSONAL', 1], // 개인 1:1(조직 없음)
  ['x', 'PUB', 0], ['b', 'PRIV_G', 0], ['g', 'PRIV', 0], // 채널 밖
];

let PRE, POST;
test('수정 전: 못 읽는 공개 채널·참여 행의 멘션이 배지로 잡힌다(빨강) — 정상 칸은 그대로', { skip }, () => {
  PRE = observe('pre');
  for (const [u, c, pre] of DEFECT) assert.equal(PRE.badge[u][c], pre, `재현 ${u}/${c}`);
  for (const [u, c, n] of SAME) assert.equal(PRE.badge[u][c], n, `정상 ${u}/${c} (수정 전)`);
  assert.equal(PRE.gMyPub, true, '재현: 앱 배지(msgr_my_badge)에도 게스트의 공개 채널 숫자가 있다');
  // 재현 칸이 정말 '못 읽는' 칸인지(시드가 의도한 상태인지) — 수정 전에도 열람 판정은 거짓
  for (const [u, c] of DEFECT) assert.equal(PRE.canRead[u][c], false, `시드 확인: ${u}는 ${c}를 못 읽는다`);
});

test('새 마이그레이션 적용(그 뒤 파일이 있으면 순서대로 함께)', { skip }, () => {
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x) && x >= FIX).sort()) applyMig(f);
  POST = observe('post');
});

test('수정 뒤: 게스트·만료·제거·제외·삭제된 조직의 배지는 0, 정상 멤버·비공개·1:1은 수정 전과 같은 숫자', { skip }, () => {
  for (const [u, c, , post] of DEFECT) assert.equal(POST.badge[u][c], post, `${u}/${c}`);
  for (const [u, c, n] of SAME) assert.equal(POST.badge[u][c], n, `정상 ${u}/${c} (수정 뒤)`);
  assert.equal(POST.gMyPub, false, '앱 배지(msgr_my_badge)에도 게스트의 공개 채널 숫자가 없다');
  // 합계 함수 = 채널별 함수의 합(앞 단계 조직의 채널도 포함 — 합계는 그 사람의 모든 채널을 센다)
  for (const k of Object.keys(U)) assert.equal(POST.total[k], POST.sumAll[k], `합계 = 채널별 합 (${k})`);
  // 게스트 g: 수정 전 단계의 조직에서도 공개 채널 숫자가 빠지고, 두 단계의 초대받은 비공개 채널(글 하나씩)만 남는다
  assert.equal(POST.total.g, 2, '게스트 합계 = 초대받은 비공개 채널 두 곳(단계마다 하나)');
  assert.equal(PRE.total.g, 3, '수정 전 게스트 합계 = 공개 채널 2 + 초대받은 비공개 채널 1');
});

test('배지 범위 = 그 사람으로 msgr_can_read_channel(채널 6종 × 사용자 10명, 모두 멘션)', { skip }, () => {
  // 두 판정(배지 함수의 인라인 조건, msgr_can_read_channel)이 갈라지면 여기서 빨강이 된다. 모든 칸에 안 읽은 멘션이 있으므로 n > 0 ⟺ 읽을 수 있다.
  const bad = [];
  for (const k of Object.keys(U)) for (const c of CHANNELS) if ((POST.badge[k][c] > 0) !== POST.canRead[k][c]) bad.push(`${k}/${c}: 배지 ${POST.badge[k][c]}, 열람 ${POST.canRead[k][c]}`);
  assert.deepEqual(bad, []);
  // 표가 양쪽 칸을 실제로 담는지
  const cells = Object.keys(U).flatMap((k) => CHANNELS.map((c) => POST.canRead[k][c]));
  assert.ok(cells.filter(Boolean).length >= 10 && cells.filter((v) => !v).length >= 10, '읽을 수 있는 칸·없는 칸이 모두 있다');
  // 수정 전에는 같은 표가 갈라졌다(빨강 근거)
  const preBad = Object.keys(U).flatMap((k) => CHANNELS.filter((c) => (PRE.badge[k][c] > 0) !== PRE.canRead[k][c]).map((c) => `${k}/${c}`));
  assert.deepEqual(preBad.sort(), DEFECT.map(([u, c]) => `${u}/${c}`).sort(), '수정 전 어긋난 칸 = 결함 칸');
});

test('권한·모양 그대로: 반환 열(channel_id uuid, n int), security definer, search_path, 로그인 사용자·anon은 직접 못 부른다', { skip }, () => {
  assert.equal(sql(`select pg_get_function_result('public.msgr_push_unread_by_channel(uuid)'::regprocedure)`), 'TABLE(channel_id uuid, n integer)');
  assert.equal(sql(`select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc where oid = 'public.msgr_push_unread_by_channel(uuid)'::regprocedure`), 'true|search_path=public, pg_temp');
  for (const role of ['authenticated', 'anon']) {
    const r = psqlRaw(['-A', '-t', '-c', `set role ${role}; select * from public.msgr_push_unread_by_channel('${U.b}')`]);
    assert.notEqual(r.status, 0, `${role}는 임의 uid 셈 함수를 못 부른다`);
    const r2 = psqlRaw(['-A', '-t', '-c', `set role ${role}; select public.msgr_push_unread_total('${U.b}')`]);
    assert.notEqual(r2.status, 0, `${role}는 합계 함수를 못 부른다`);
  }
});
