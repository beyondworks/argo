// 개인 공간 에이전트 1단계(2026-09-30 유건) — 내 Argo 크루를 조직 없이 개인 공간에서 부르고, 친구와의 개인 방에도 넣는다.
// 규칙: 개인 크루는 개인 방에만, 조직 크루는 그 조직에만 / "내 에이전트"·"추가 후보"에 남의 에이전트가 안 나온다 /
//       기본은 주인만 지시 / 무료는 사람이 둘 이상인 방에서 사람+에이전트 4명까지, 혼자 쓰는 방은 제한 없음.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-personal-crews-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-personal-crews-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555' };
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 200)}`); };
const post = (uid, ch, body, mentions = '[]') => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', '${mentions}'::jsonb, gen_random_uuid()::text) returning id`));
const personalCrew = (uid, slug) => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${uid}', 'ws-${uid.slice(0, 4)}', '${slug}', '${slug}', 'local', 'active', 'owner') returning id`));
const befriend = (x, y) => { asUser(x, `select public.msgr_friend_request('${y}')`); asUser(y, `select public.msgr_friend_decide('${x}', true)`); };
const join = (uid, ch, crew) => last(asUser(uid, `select public.msgr_crew_join('${ch}', '${crew}')`));

let ORG, ORG_CREW, A1, A2, A3, A4, B1, AB, SOLO;
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
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  for (const f of [...base, ...readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  sql(`delete from public.msgr_settings where key = 'free_limits_grace_until'`); // 한도 테스트는 유예가 끝난 뒤를 본다(유예 자체는 별도 테스트가 날짜를 넣어 본다)
  // 조직 대조군 — a·d가 같은 조직
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`));
  asUser(U.d, `select public.msgr_accept_invite('${code}')`);
  ORG_CREW = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.a}', 'ws-1111', 'orgcrew', 'OrgCrew', 'local', 'active', 'owner') returning id`));
  [A1, A2, A3, A4] = ['a1', 'a2', 'a3', 'a4'].map((s) => personalCrew(U.a, s));
  B1 = personalCrew(U.b, 'b1');
  befriend(U.a, U.b); befriend(U.a, U.c); befriend(U.b, U.c);
  AB = last(asUser(U.a, `select public.msgr_dm_personal('${U.b}')`));
});

test('개인 크루 행: 조직 없이 만들고, 같은 크루를 두 번 넣지 못하며, 주인만 본다', { skip }, () => {
  assert.equal(sql(`select coalesce(org_id::text,'NULL') from public.msgr_crews where id='${A1}'`), 'NULL');
  fails(asUserRaw(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting) values (null, '${U.a}', 'ws-1111', 'a1', 'dup', 'local')`), /duplicate key|msgr_crews_personal_uniq/, '같은 회사·slug 개인 행 중복');
  fails(asUserRaw(U.b, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting) values (null, '${U.a}', 'ws-x', 'steal', 'x', 'local')`), /row-level security|violates/, '남의 이름으로 개인 크루');
  fails(psqlRaw(['-c', `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting) values (null, '${U.a}', 'ws-1111', 'res', 'x', 'resident')`]), /msgr_crews_personal_local/, '개인 행은 local만(봇·상주는 다음 단계)');
  assert.equal(asUser(U.a, `select count(*) from public.msgr_crews where org_id is null`), '4', '주인은 자기 개인 크루 4');
  assert.equal(asUser(U.b, `select count(*) from public.msgr_crews where org_id is null`), '1', 'b는 자기 것 1개만(a의 개인 크루는 안 보인다)');
  assert.equal(asUser(U.d, `select count(*) from public.msgr_crews where id='${A1}'`), '0', '같은 조직 동료도 남의 개인 크루는 못 본다');
});

test('크루 1:1: 한 크루에 한 방, 주인만 연다', { skip }, () => {
  const ch = last(asUser(U.a, `select public.msgr_dm_personal_crew('${A1}')`));
  assert.equal(last(asUser(U.a, `select public.msgr_dm_personal_crew('${A1}')`)), ch, '다시 열어도 같은 방');
  assert.equal(sql(`select count(*) filter (where member_kind='user')||'/'||count(*) filter (where member_kind='crew') from public.msgr_channel_members where channel_id='${ch}'`), '1/1');
  fails(asUserRaw(U.b, `select public.msgr_dm_personal_crew('${A1}')`), /msgr_bad_member/, '남의 크루와 1:1');
  fails(asUserRaw(U.a, `select public.msgr_dm_personal_crew('${ORG_CREW}')`), /msgr_bad_member/, '조직 크루는 개인 1:1 아님');
  const m = post(U.a, ch, '안녕');
  assert.equal(sql(`select public.msgr_delivery_allowed('${A1}', ${m})`), 't', '주인 글은 크루에 전달');
  const inbox = asUser(U.a, `select id from public.msgr_crew_inbox('ws-1111', '${A1}', 0)`);
  assert.ok(inbox.split('\n').includes(m), '크루 받은 글에 온다(참여 행 기반)');
  const list = asUser(U.a, `select coalesce(crew_dm::text,'-') from public.msgr_dm_personal_list(true) where channel_id='${ch}'`);
  assert.equal(list, A1, '개인 목록에 크루 1:1로 표시');
});

test('친구 1:1에 내 크루를 넣고, 친구 글에는 답하지 않는다(기본 주인만)', { skip }, () => {
  assert.equal(join(U.a, AB, A1), 'joined', '방을 연 사람(a)은 바로 넣는다');
  fails(asUserRaw(U.a, `select public.msgr_crew_join('${AB}', '${ORG_CREW}')`), /msgr_bad_member/, '조직 크루는 개인 방에 못 들어온다');
  fails(asUserRaw(U.b, `select public.msgr_crew_join('${AB}', '${A2}')`), /msgr_forbidden/, '남의 크루를 넣지 못한다');
  const mine = post(U.a, AB, '@a1 정리해줘', `[{"kind":"crew","id":"${A1}","role":"to"}]`);
  fails(asUserRaw(U.b, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${AB}', 'user', '${U.b}', 'text', '@a1', '[{"kind":"crew","id":"${A1}","role":"to"}]'::jsonb, gen_random_uuid()::text)`), /msgr_not_allowed/, '지시 권한 없는 크루 멘션은 글째 거부(기존 채팅 규칙)');
  const theirs = post(U.b, AB, '이것도 봐줘'); // 멘션 없는 친구 글 — 방 안 크루의 전달 대상이지만 지시 권한이 없다
  assert.equal(sql(`select public.msgr_delivery_allowed('${A1}', ${mine})`), 't', '주인 지시는 전달');
  const chat = post(U.a, AB, '친구야 저녁 먹었어?'); // 부르지 않은 주인 글 — 친구가 있는 방에서는 크루에게 가지 않는다(크루 1:1만 모든 글)
  assert.equal(sql(`select public.msgr_delivery_allowed('${A1}', ${chat})`), 'f', '친구 방의 일반 대화는 크루에게 안 간다');
  assert.equal(sql(`select public.msgr_delivery_allowed('${A1}', ${theirs})`), 'f', '친구 지시는 전달 안 됨(allow=owner)');
  assert.equal(sql(`select public.msgr_instruct_check('${A1}', '${U.b}', '${AB}')`), 'crew_allow');
  asUser(U.a, `update public.msgr_crews set allow='all' where id='${A1}'`);
  assert.equal(sql(`select public.msgr_instruct_check('${A1}', '${U.b}', '${AB}')`), 'ok', '주인이 허용을 넓히면 방 사람은 지시 가능');
  assert.equal(sql(`select public.msgr_instruct_check('${A1}', '${U.c}', '${AB}')`), 'crew_allow', '방 밖 사람은 all이어도 불가');
  asUser(U.a, `update public.msgr_crews set allow='owner' where id='${A1}'`);
  fails(asUserRaw(U.b, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${AB}', 'user', '${U.b}', 'text', 'x', '[{"kind":"crew","id":"${A3}","role":"to"}]'::jsonb, gen_random_uuid()::text)`), /msgr_not_allowed/, '방에 없는 크루 멘션은 거부(전달로 새 방이 생기지 않는다)');
  assert.equal(sql(`select count(*) from public.msgr_channels where org_id is null and personal_pair is null and created_by='${U.b}'`), '0');
});

test('남의 에이전트 노출: 방 안의 친구 크루는 방 표시용으로만, 내 목록에는 안 나온다', { skip }, () => {
  asUser(U.b, `select public.msgr_dm_personal('${U.a}')`);
  assert.equal(join(U.b, AB, B1), 'requested', 'b는 방을 연 사람이 아니라 요청이 된다(기존 채팅 규칙)');
  const req = last(asUser(U.a, `select id from public.msgr_channel_crew_requests where channel_id='${AB}' and crew_id='${B1}' and status='pending'`));
  assert.equal(last(asUser(U.a, `select public.msgr_crew_join_decide('${req}', true)`)), 'approved');
  const seen = asUser(U.a, `select id from public.msgr_personal_room_crews()`).split('\n');
  assert.ok(seen.includes(B1), '방 안의 친구 크루는 표시용 목록에 있다');
  assert.equal(asUser(U.a, `select count(*) from public.msgr_personal_room_crews() where owner_user_id <> '${U.a}' and commands is not null`), '0', '남의 크루 명령 목록은 싣지 않는다');
  assert.equal(asUser(U.a, `select count(*) from public.msgr_crews where id='${B1}'`), '0', '표(select)로는 친구 크루 행이 안 보인다');
  assert.ok(!asUser(U.c, `select id from public.msgr_personal_room_crews()`).split('\n').includes(B1), '방 밖 사람은 못 본다');
  const cand = asUser(U.a, `select x->>'id' from public.msgr_dm_candidates('${AB}') x`).split('\n');
  assert.ok(cand.includes(A1) && !cand.includes(B1), '멘션 후보: 내가 지시할 수 있는 크루만(친구 크루 제외)');
});

test('무료 한도: 사람이 둘 이상이면 사람+에이전트 4명까지, 혼자 쓰는 방은 제한 없음', { skip }, () => {
  // AB = a, b + A1, B1 = 4명 → 다섯 번째는 막힌다
  fails(asUserRaw(U.a, `select public.msgr_crew_join('${AB}', '${A2}')`), /msgr_room_limit/, '1:1 방 다섯 번째');
  // 혼자 쓰는 방(크루 1:1)에는 계속 넣는다
  SOLO = last(asUser(U.a, `select public.msgr_dm_personal_crew('${A2}')`));
  for (const c of [A1, A3, A4]) assert.equal(join(U.a, SOLO, c), 'joined');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id='${SOLO}' and member_kind='crew'`), '4', '혼자 쓰는 방은 에이전트 4명도 된다');
  // 그 방에 친구를 들이려 하면 한도(사람 2 + 에이전트 4)
  fails(asUserRaw(U.a, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${SOLO}', 'user', '${U.b}', '${U.a}')`), /msgr_room_limit|row-level security|msgr_dm_pair_only/, '에이전트 4명 방에 사람 추가');
  // 그룹: 사람 셋 + 에이전트 하나까지
  const G = last(asUser(U.a, `select public.msgr_dm_personal_group(array['${U.b}','${U.c}']::uuid[])`));
  assert.equal(join(U.a, G, A3), 'joined', '사람 3 + 에이전트 1 = 4');
  fails(asUserRaw(U.a, `select public.msgr_crew_join('${G}', '${A4}')`), /msgr_room_limit/, '그룹 다섯 번째');
  // Pro면 제한 없음
  sql(`insert into public.entitlements (user_id, plan, granted) values ('${U.a}', 'pro', true) on conflict (user_id) do update set plan='pro', granted=true`);
  assert.equal(join(U.a, G, A4), 'joined', 'Pro는 한도 없음');
  sql(`update public.entitlements set plan='free', granted=false where user_id='${U.a}'`);
  // 나갔다 돌아오는 1:1 사람은 세지 않는다
  asUser(U.b, `select public.msgr_leave_dm('${AB}')`);
  assert.match(last(asUser(U.b, `select public.msgr_dm_personal('${U.a}')`)), /^[0-9a-f-]{36}$/, '1:1로 돌아오기는 한도와 무관');
});

test('2주 유예(유건 2026-09-30 "2주 동안은 Pro처럼"): 기존 사용자는 정한 날짜까지, 신규 가입자는 가입부터 2주 동안 무료 한도가 없다', { skip }, () => {
  // 기존 사용자 c(가입 30일 전) — 유예 날짜가 앞이면 한도 없음, 지나면 한도
  const [C1, C2, C3] = ['c1', 'c2', 'c3'].map((x) => personalCrew(U.c, x));
  const CB = last(asUser(U.c, `select public.msgr_dm_personal('${U.b}')`));
  for (const x of [C1, C2]) assert.equal(join(U.c, CB, x), 'joined');
  sql(`insert into public.msgr_settings (key, value) values ('free_limits_grace_until', (now() + interval '3 days')::text) on conflict (key) do update set value = excluded.value`);
  assert.equal(join(U.c, CB, C3), 'joined', '유예 중 — 사람 2 + 에이전트 3 = 5명도 된다');
  asUser(U.c, `select public.msgr_crew_leave_channel('${CB}', '${C3}')`);
  sql(`update public.msgr_settings set value = (now() - interval '1 minute')::text where key = 'free_limits_grace_until'`);
  fails(asUserRaw(U.c, `select public.msgr_crew_join('${CB}', '${C3}')`), /msgr_room_limit/, '유예가 지나면 한도');
  // 신규 가입자 f(방금 가입) — 유예 날짜가 지났어도 가입부터 2주
  const F = '66666666-6666-4666-8666-666666666666';
  sql(`insert into auth.users (id, created_at, email) values ('${F}', now(), 'f@example.test') on conflict do nothing`);
  befriend(U.c, F);
  const [F1, F2, F3] = ['f1', 'f2', 'f3'].map((x) => personalCrew(F, x));
  const CF = last(asUser(F, `select public.msgr_dm_personal('${U.c}')`));
  for (const x of [F1, F2, F3]) assert.equal(join(F, CF, x), 'joined', '가입 2주 안 — 한도 없음');
  sql(`delete from public.msgr_settings where key = 'free_limits_grace_until'`);
});

test('분리 검수 반영: 개인 방 동의는 명시적 동의만, 없어진 크루는 한도에 안 센다, 옛 앱엔 크루 1:1을 주지 않는다, 작업 심박은 같은 값을 다시 쓰지 않는다', { skip }, () => {
  // H3 — 전환 기간이라도 개인 방은 "아직 안 물어봄"을 동의로 보지 않는다(친구 글이 남의 에이전트 제공자로 나가지 않게)
  assert.equal(last(asUser(U.a, `select public.msgr_personal_ai_consent_ok('${AB}', '${U.b}')`)), 'f', '동의 기록 없는 친구 → 거짓');
  sql(`insert into public.msgr_ai_consent (user_id, consent_at) values ('${U.b}', now()) on conflict (user_id) do update set consent_at = now()`);
  assert.equal(last(asUser(U.a, `select public.msgr_personal_ai_consent_ok('${AB}', '${U.b}')`)), 't', '명시 동의한 친구 → 참');
  // M5 — 없어진 크루의 남은 참여 행(FK 없음)은 한도에 세지 않는다
  // 앞 테스트에서 b가 나갔다 돌아와 B1은 이미 빠졌다(주인 따라 나감) — 방을 4명으로 채운 뒤 본다
  const crewsIn = () => Number(sql(`select count(*) from public.msgr_channel_members where channel_id='${AB}' and member_kind='crew'`));
  for (const c of [A1, A2]) if (crewsIn() < 2) join(U.a, AB, c);
  assert.equal(crewsIn(), 2, 'a·b + 크루 2 = 4명');
  fails(asUserRaw(U.a, `select public.msgr_crew_join('${AB}', '${A3}')`), /msgr_room_limit/, '다섯 번째');
  const gone = sql(`select member_id from public.msgr_channel_members where channel_id='${AB}' and member_kind='crew' limit 1`);
  sql(`delete from public.msgr_crews where id='${gone}'`); // 크루 행만 사라지고 참여 행은 남는다(FK 없음)
  assert.equal(join(U.a, AB, A3), 'joined', '없어진 크루는 한도에 세지 않는다');
  // L5 — 인자 없는 옛 앱에는 크루 1:1을 주지 않는다
  assert.equal(asUser(U.a, `select count(*) from public.msgr_dm_personal_list(false) where crew_dm is not null`), '0');
  // M3 — 작업 심박이 같은 값을 다시 쓰지 않는다(행 xmin 불변)
  asUser(U.a, `select public.msgr_work_heartbeat(array['${A1}']::uuid[])`);
  const x1 = sql(`select xmin from public.msgr_crews where id='${A1}'`);
  asUser(U.a, `select public.msgr_work_heartbeat(array['${A1}']::uuid[])`);
  assert.equal(sql(`select xmin from public.msgr_crews where id='${A1}'`), x1, '두 번째 심박은 쓰지 않는다');
});

test('조직 회귀: 조직 크루는 그 조직 채널에만, 개인 크루는 조직 채널에 못 들어간다', { skip }, () => {
  const pub = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','public','general','[]'::jsonb)`));
  fails(asUserRaw(U.a, `select public.msgr_crew_join('${pub}', '${A1}')`), /msgr_bad_member/, '개인 크루 → 조직 채널');
  assert.match(join(U.a, pub, ORG_CREW), /joined|already/, '조직 크루는 그대로');
  asUser(U.a, `update public.msgr_crews set allow='list', allow_users=array['${U.d}']::uuid[] where id='${ORG_CREW}'`); // 개인 행 정책이 조직 크루 수정을 재귀로 막던 결함(드릴 실측) 회귀
  assert.equal(sql(`select allow from public.msgr_crews where id='${ORG_CREW}'`), 'list', '주인이 조직 크루 허용 범위를 바꾼다');
  const orgDm = last(asUser(U.a, `select public.msgr_create_channel('${ORG}','dm','dm:d','[{"kind":"user","id":"${U.d}"}]'::jsonb)`));
  assert.equal(join(U.a, orgDm, ORG_CREW), 'joined', '조직 DM에 조직 크루');
  fails(asUserRaw(U.a, `select public.msgr_crew_join('${orgDm}', '${A2}')`), /msgr_bad_member/, '개인 크루 → 조직 DM');
  const m = post(U.a, orgDm, '@orgcrew', `[{"kind":"crew","id":"${ORG_CREW}","role":"to"}]`);
  assert.equal(sql(`select public.msgr_delivery_allowed('${ORG_CREW}', ${m})`), 't', '조직 DM 전달은 그대로');
  const n = post(U.d, orgDm, '@orgcrew', '[]');
  assert.equal(sql(`select public.msgr_delivery_allowed('${ORG_CREW}', ${n})`), 't', '조직 DM은 방 안이면 동료 글도 전달(9/18 규칙 유지)');
});

test('계정 삭제: 개인 크루와 크루 1:1이 정리되고 친구 방에서 빠진다', { skip }, () => {
  befriend(U.e, U.a);
  const E1 = personalCrew(U.e, 'e1');
  const ea = last(asUser(U.e, `select public.msgr_dm_personal('${U.a}')`));
  assert.equal(join(U.e, ea, E1), 'joined');
  const solo = last(asUser(U.e, `select public.msgr_dm_personal_crew('${E1}')`));
  asUser(U.e, `select public.msgr_delete_me()`);
  assert.equal(sql(`select count(*) from public.msgr_crews where owner_user_id='${U.e}'`), '0', '개인 크루 행 없음');
  assert.equal(sql(`select count(*) from public.msgr_channels where id='${solo}'`), '0', '혼자 쓰던 크루 1:1은 지운다');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id='${ea}' and member_kind='crew'`), '0', '친구 방에서 크루가 빠진다');
});
