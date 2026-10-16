// 메신저 서비스 일시 중단 스위치(20261016170000_msgr_service_pause) — 실제 Postgres에서 스위치 없음 → 켬 → 끔을 같은 시드로 본다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-service-pause-pg.test.mjs
// 경우 표(PR 본문): 사람·크루·봇(서비스 권한) 글 / 방 만들기(공개·조직 DM) / 참여·초대·초대 수락·친구 요청(차단은 허용) / 크루 지시(파견 요청·에이전트 요청·조직 만들기)
//   × 스위치 없음·켬·끔, 읽기(글·방·첨부) 그대로, 받은 글·봇 업데이트 빈 결과, 기기 심박 쓰기 0(xmin), 자동화 디스패치 빈 배열, 공지 한 번(다시 불러도 0), core 직접 호출 막힘.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-service-pause-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const psqlRaw = (args) => psqlSpawn(DB, ['-v', 'VERBOSITY=verbose', ...args]); // 오류에 SQLSTATE를 싣는다(ERROR:  42501: …)
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asAnon = (q) => sql(`set role anon; select set_config('argo.uid', '', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const PAUSED = /42501: msgr_forbidden \(new row violates row-level security policy, messenger service paused\)/;
const paused = (raw, label) => { assert.notEqual(raw.status, 0, `중단 중인데 허용됨: ${label}`); assert.match(raw.stderr, PAUSED, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 240)}`); };
const ok = (raw, label) => { assert.equal(raw.status, 0, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 240)}`); return last(raw.stdout); };
const superRaw = (q) => psqlRaw(['-A', '-t', '-c', q]); // 슈퍼유저 = service_role처럼 RLS를 건너뛴다(엣지 msgr-bot·크론 경로) — 트리거는 그대로 돈다
const post = (uid, ch, body) => asUserRaw(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', '[]'::jsonb, gen_random_uuid()::text) returning id`);
const crewPost = (uid, ch, crew, body) => asUserRaw(uid, `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, client_msg_id) values ('${ch}', 'crew', '${crew}', 'text', '${body}', gen_random_uuid()::text) returning id`);
const botPost = (ch, crew, body) => superRaw(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, client_msg_id) values ('${ch}', 'crew', '${crew}', 'text', '${body}', gen_random_uuid()::text) returning id`);
const pause = (since = '2026-10-16T17:00:00+09:00') => sql(`insert into public.msgr_settings (key, value) values ('msgr_paused', '${since}') on conflict (key) do update set value = excluded.value`);
const unpause = () => sql(`delete from public.msgr_settings where key = 'msgr_paused'`);

const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333',
  d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555', g: '66666666-6666-4666-8666-666666666666', f: '77777777-7777-4777-8777-777777777777',
  h: '88888888-8888-4888-8888-888888888888', i: '99999999-9999-4999-8999-999999999999' };
// a = 조직 소유자, b = 멤버(채널을 만든 방장), c = 일반 멤버, d = 에이전트 주인, e = 서비스 계정, g = 손님, f = d의 친구(개인 공간), h·i = 초대를 받을 새 사람
let ORG, PUB, PUB2, PRIV, DM, FR, ARCH, D1, DBOT, CODE, M1;
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
  sql(`delete from public.msgr_settings where key = 'free_limits_grace_until'`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 20 where org_id = '${ORG}'`);
  for (const u of [U.b, U.c, U.d, U.e]) { const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`)); asUser(u, `select public.msgr_accept_invite('${code}')`); }
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.g}', 'guest')`);
  PUB = last(asUser(U.b, `select public.msgr_create_channel('${ORG}','public','Work')`));
  PUB2 = last(asUser(U.b, `select public.msgr_create_channel('${ORG}','public','Later')`));
  PRIV = last(asUser(U.b, `select public.msgr_create_channel('${ORG}','private','Secret')`));
  ARCH = last(asUser(U.b, `select public.msgr_create_channel('${ORG}','public','Old')`));
  for (const u of [U.c, U.d]) asUser(u, `select public.msgr_join_channel('${PUB}')`);
  asUser(U.d, `select public.msgr_join_channel('${PUB2}')`); // 파견(msgr_crew_join)은 주인이 그 방에 있어야 한다 — 중단 거절과 다른 거절이 먼저 나지 않게
  DM = last(asUser(U.d, `select public.msgr_create_channel('${ORG}', 'dm', 'dm:c', '[{"kind":"user","id":"${U.c}"}]'::jsonb)`));
  D1 = last(asUser(U.d, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.d}', 'ws-4444', 'd1', 'd1', 'local', 'active', 'owner') returning id`));
  DBOT = last(sql(`select set_config('msgr.bot_create', '1', true); insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.d}', 'bot', 'dbot', 'dbot', 'bot', 'active', 'owner') returning id`));
  sql(`update public.msgr_orgs set service_user_id = '${U.e}' where id = '${ORG}'`);
  for (const crew of [D1, DBOT]) sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PUB}', 'crew', '${crew}', '${U.a}')`);
  asUser(U.d, `select public.msgr_friend_request('${U.f}')`); asUser(U.f, `select public.msgr_friend_decide('${U.d}', true)`);
  FR = last(asUser(U.f, `select public.msgr_dm_personal('${U.d}')`));
  CODE = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`)); // 중단 전에 만든 초대 — 중단 중 수락은 막힌다
  sql(`update public.msgr_channels set archived_at = now() where id = '${ARCH}'`);
  M1 = ok(post(U.c, PUB, 'before pause'), '중단 전 글');
  sql(`insert into public.msgr_attachments (message_id, org_id, storage_path, name, mime, bytes) values (${M1}, '${ORG}', '${ORG}/${PUB}/${M1}/a.txt', 'a.txt', 'text/plain', 3)`);
});

const inbox = (uid, crew) => Number(asUser(uid, `select count(*) from public.msgr_crew_inbox('ws-4444', '${crew}', 0, 100)`).split('\n').pop());
const inboxMany = (uid, crew) => last(asUser(uid, `select (public.msgr_crew_inbox_many('ws-4444', '[{"crew":"${crew}","after":0}]'::jsonb, 100))->'crews'->0->>'ids'`));
const beat = (uid) => last(asUser(uid, `select public.msgr_device_beat('ws-4444', 'dev-1', array['${D1}']::uuid[], '0.1.112')::text`));
const beatXmin = () => sql(`select coalesce((select xmin::text from public.msgr_device_beats where owner_user_id = '${U.d}' and ws_id = 'ws-4444' and device_id = 'dev-1'), 'none') || '/' || (select xmin::text from public.msgr_crews where id = '${D1}')`);
const writesWork = (label) => {
  ok(post(U.c, PUB, `${label} user`), `${label}: 사람 글`);
  ok(crewPost(U.d, PUB, D1, `${label} crew`), `${label}: 크루 글`);
  ok(botPost(PUB, DBOT, `${label} bot`), `${label}: 봇 글(서비스 권한)`);
};

test('스위치 없음 — 지금과 같다(쓰기·받은 글·심박·디스패치·상태 RPC)', { skip }, () => {
  assert.equal(sql(`select count(*) from public.msgr_settings where key = 'msgr_paused'`), '0');
  writesWork('off');
  assert.ok(inbox(U.d, D1) >= 1, '받은 글이 온다');
  assert.notEqual(inboxMany(U.d, D1), '[]');
  assert.equal(beat(U.d), '{}', '심박은 종전 응답');
  assert.equal(asAnon(`select coalesce(public.msgr_service_pause()::text, '(null)')`).split('\n').pop(), '(null)');
  assert.equal(last(asUser(U.c, `select coalesce(public.msgr_service_pause()::text, '(null)')`)), '(null)');
  const r = superRaw(`select public.msgr_automation_dispatch_due('ws-4444')`); // 로그인 없음 → 원래 함수의 거절(디스패치가 그대로 돈다는 뜻)
  assert.notEqual(r.status, 0); assert.match(r.stderr, /msgr_automation_forbidden/);
  const b = superRaw(`select count(*) from public.msgr_bot_updates('nope', 0, 10)`);
  assert.notEqual(b.status, 0, '봇 업데이트는 원래 인증을 거친다'); assert.match(b.stderr, /msgr_bot_unauthorized/);
});

test('켬 — 사람·크루·봇 글, 방 만들기·참여·초대·수락·친구 요청·크루 지시가 모두 같은 오류(42501)로 거부된다', { skip }, () => {
  pause();
  try {
    paused(post(U.c, PUB, 'x'), '사람 글(RLS 경로)');
    paused(post(U.d, DM, 'x'), '조직 DM 글');
    paused(post(U.d, FR, 'x'), '개인 공간 친구 방 글');
    paused(crewPost(U.d, PUB, D1, 'x'), '크루 글');
    paused(botPost(PUB, DBOT, 'x'), '봇 글(서비스 권한 — RLS 건너뜀)');
    paused(asUserRaw(U.b, `select public.msgr_create_channel('${ORG}','public','New')`), '공개 방 만들기');
    paused(asUserRaw(U.b, `select public.msgr_create_channel('${ORG}', 'dm', 'dm:x', '[{"kind":"user","id":"${U.a}"}]'::jsonb)`), '조직 DM 만들기');
    paused(asUserRaw(U.c, `select public.msgr_join_channel('${PUB2}')`), '공개 방 참여');
    paused(asUserRaw(U.b, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'user', '${U.c}', '${U.b}')`), '비공개 방에 사람 넣기');
    paused(asUserRaw(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`), '조직 초대 만들기');
    paused(asUserRaw(U.h, `select public.msgr_accept_invite('${CODE}')`), '중단 전 초대 수락');
    paused(asUserRaw(U.c, `select public.msgr_friend_request('${U.f}')`), '친구 요청');
    paused(asUserRaw(U.d, `select public.msgr_crew_join('${PUB2}', '${D1}')`), '에이전트 파견(방에 넣기)');
    paused(asUserRaw(U.c, `insert into public.msgr_crew_requests (org_id, channel_id, name, prompt, created_by) values ('${ORG}', '${PUB}', 'helper', 'help', '${U.c}')`), '에이전트 만들기 요청');
    paused(asUserRaw(U.i, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('New', 'new-org', '${U.i}')`), '조직 만들기');
    // 차단은 안전 기능 — 중단 중에도 된다
    ok(asUserRaw(U.c, `select public.msgr_friend_remove('${U.g}', true)`), '차단');
  } finally { unpause(); }
});

test('켬 — 읽기(글·방·첨부·멤버)는 그대로다(이관이 읽어 간다)', { skip }, () => {
  const before = { msgs: last(asUser(U.c, `select count(*) from public.msgr_messages where channel_id = '${PUB}'`)), chans: last(asUser(U.c, `select count(*) from public.msgr_channels`)),
    att: last(asUser(U.c, `select count(*) from public.msgr_attachments a join public.msgr_messages m on m.id = a.message_id where m.channel_id = '${PUB}'`)), mem: last(asUser(U.c, `select count(*) from public.msgr_channel_members where channel_id = '${PUB}'`)) };
  pause();
  try {
    assert.ok(Number(before.msgs) >= 1);
    assert.equal(last(asUser(U.c, `select count(*) from public.msgr_messages where channel_id = '${PUB}'`)), before.msgs, '글 읽기');
    assert.equal(last(asUser(U.c, `select count(*) from public.msgr_channels`)), before.chans, '방 목록');
    assert.equal(last(asUser(U.c, `select count(*) from public.msgr_attachments a join public.msgr_messages m on m.id = a.message_id where m.channel_id = '${PUB}'`)), before.att, '첨부 행');
    assert.equal(last(asUser(U.c, `select count(*) from public.msgr_channel_members where channel_id = '${PUB}'`)), before.mem, '멤버');
    assert.equal(last(asUser(U.f, `select count(*) from public.msgr_messages where channel_id = '${FR}'`)), last(asUser(U.d, `select count(*) from public.msgr_messages where channel_id = '${FR}'`)), '개인 방 읽기');
  } finally { unpause(); }
});

test('켬 — 크루·봇은 새 턴이 없다(받은 글·봇 업데이트 빈 결과), 심박은 쓰기 0으로 paused 표지, 디스패치 빈 배열, 상태 RPC는 since', { skip }, () => {
  beat(U.d); // 기기 행이 있게
  sql(`update public.msgr_device_beats set seen_at = now() - interval '10 minutes' where owner_user_id = '${U.d}'; update public.msgr_crews set last_seen_at = now() - interval '10 minutes' where id = '${D1}'`); // 원래 함수라면 쓴다
  pause('2026-10-16T17:00:00+09:00');
  try {
    assert.equal(inbox(U.d, D1), 0, '받은 글 없음(중단 전 글도)');
    assert.equal(inboxMany(U.d, D1), '[]', '일괄 받은 글 — 에이전트마다 빈 목록');
    assert.equal(last(asUser(U.d, `select (public.msgr_crew_inbox_many('ws-4444', '[{"crew":"${D1}","after":0}]'::jsonb, 100))->>'messages'`)), '[]');
    const x0 = beatXmin();
    assert.deepEqual(JSON.parse(beat(U.d)), { paused: true, since: '2026-10-16T17:00:00+09:00' });
    assert.equal(beatXmin(), x0, '심박이 기기 행·크루 행을 쓰지 않는다(xmin 불변)');
    const anon = psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '', false); select public.msgr_device_beat('ws-4444', 'dev-1', array['${D1}']::uuid[], '0.1.112')`]);
    assert.notEqual(anon.status, 0, '로그인 없는 심박은 원래처럼 거절'); assert.match(anon.stderr, /msgr_device_beat_forbidden/);
    assert.equal(last(sql(`select public.msgr_automation_dispatch_due('ws-4444')::text`)), '[]', '기기 쪽 디스패치');
    assert.equal(last(sql(`select public.msgr_automation_dispatch_cloud()::text`)), '[]', '크론 디스패치 — 오류 없이 빈 배열');
    assert.equal(sql(`select count(*) from public.msgr_bot_updates('nope', 0, 10)`), '0', '봇 업데이트 빈 결과(인증 전에 끝난다 — 정보 없음)');
    for (const who of [() => asAnon(`select public.msgr_service_pause()::text`).split('\n').pop(), () => last(asUser(U.c, `select public.msgr_service_pause()::text`))]) {
      assert.deepEqual(JSON.parse(who()), { paused: true, since: '2026-10-16T17:00:00+09:00' });
    }
  } finally { unpause(); }
});

test('core 함수와 판정 함수는 사용자 역할이 직접 부를 수 없다(감싸개를 건너뛰지 못한다), 스위치 표는 직접 읽을 수 없다', { skip }, () => {
  for (const q of [`select count(*) from public._msgr_crew_inbox_core('ws-4444', '${D1}', 0, 10)`, `select public._msgr_crew_inbox_many_core('ws-4444', '[]'::jsonb, 10)`,
    `select public._msgr_device_beat_core('ws-4444', 'dev-1', array['${D1}']::uuid[], null)`, `select public._msgr_paused()`, `select public.msgr_pause_announce('a', 'b')`]) {
    const r = asUserRaw(U.d, q); assert.notEqual(r.status, 0, `허용됨: ${q}`); assert.match(r.stderr, /permission denied for function/, q);
  }
  const b = psqlRaw(['-A', '-t', '-c', `set role anon; select count(*) from public._msgr_bot_updates_core('nope', 0, 10)`]);
  assert.notEqual(b.status, 0); assert.match(b.stderr, /permission denied for function/);
  pause();
  try { // 운영(Supabase 기본 표 권한)은 RLS 켬·정책 없음이라 0행, 표 권한이 없는 시험 DB는 권한 거절 — 둘 다 '못 읽음'
    const r = asUserRaw(U.c, `select count(*) from public.msgr_settings`);
    assert.ok(r.status === 0 ? last(r.stdout) === '0' : /permission denied for table msgr_settings/.test(r.stderr), `스위치 표가 읽힌다: ${r.stdout}${r.stderr}`);
  } finally { unpause(); }
});

test('공지 — 켠 뒤 서비스 권한으로 활성 방마다 system 글 1건(보관 방 제외), 다시 불러도 0건, 꺼져 있으면 거절', { skip }, () => {
  const offR = superRaw(`select public.msgr_pause_announce('ko', 'en')`);
  assert.notEqual(offR.status, 0); assert.match(offR.stderr, /msgr_not_paused/);
  pause('2026-10-16T17:00:00+09:00');
  try {
    const bad = superRaw(`select public.msgr_pause_announce('', 'en')`); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /msgr_pause_text_invalid/);
    const active = Number(sql(`select count(*) from public.msgr_channels where archived_at is null`));
    assert.ok(active >= 5, `활성 방 ${active}개(공개·비공개·조직 DM·개인 친구 방)`);
    assert.equal(Number(last(sql(`select public.msgr_pause_announce('메신저를 잠시 멈춥니다.', 'Messenger is paused for now.')`))), active);
    assert.equal(Number(last(sql(`select public.msgr_pause_announce('메신저를 잠시 멈춥니다.', 'Messenger is paused for now.')`))), 0, '다시 불러도 중복 없음');
    const per = sql(`select ch.id, count(m.id) from public.msgr_channels ch left join public.msgr_messages m on m.channel_id = ch.id and m.kind = 'system' and m.meta->>'msgr_pause' = '2026-10-16T17:00:00+09:00' group by ch.id, ch.archived_at order by ch.id`).split('\n').map((l) => l.split('|'));
    for (const [id, n] of per) assert.equal(n, id === ARCH ? '0' : '1', `방 ${id}`);
    assert.equal(last(sql(`select body from public.msgr_messages where channel_id = '${PUB}' and kind = 'system' and meta->>'msgr_pause' is not null`)), 'Messenger is paused for now.', '두 줄(ko·en) — 마지막 줄이 en');
    assert.equal(last(sql(`select meta->>'ko' from public.msgr_messages where channel_id = '${PUB}' and kind = 'system' and meta->>'msgr_pause' is not null`)), '메신저를 잠시 멈춥니다.');
    assert.equal(last(asUser(U.c, `select count(*) from public.msgr_messages where channel_id = '${PUB}' and kind = 'system' and meta->>'msgr_pause' is not null`)), '1', '멤버가 공지를 읽는다');
    paused(superRaw(`insert into public.msgr_messages (channel_id, author_kind, kind, body) values ('${PUB}', 'system', 'system', 'forged')`), '공지 함수 밖의 system 글');
    // 다른 회차(값이 바뀜)면 새로 한 번
    pause('2026-10-17T09:00:00+09:00');
    assert.equal(Number(last(sql(`select public.msgr_pause_announce('다시 멈춥니다.', 'Paused again.')`))), active);
  } finally { unpause(); }
});

test('끔(행 삭제) — 원래대로: 쓰기·방 만들기·참여·초대·수락·친구 요청·파견이 되고, 중단 전 글이 받은 글로 다시 오고, 심박이 쓴다', { skip }, () => {
  pause(); unpause();
  assert.equal(sql(`select count(*) from public.msgr_settings where key = 'msgr_paused'`), '0');
  writesWork('back');
  ok(asUserRaw(U.b, `select public.msgr_create_channel('${ORG}','public','Again')`), '방 만들기');
  ok(asUserRaw(U.c, `select public.msgr_join_channel('${PUB2}')`), '참여');
  ok(asUserRaw(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`), '초대 만들기');
  ok(asUserRaw(U.h, `select public.msgr_accept_invite('${CODE}')`), '중단 전 초대 수락');
  ok(asUserRaw(U.c, `select public.msgr_friend_request('${U.f}')`), '친구 요청');
  ok(asUserRaw(U.d, `select public.msgr_crew_join('${PUB2}', '${D1}')`), '파견');
  assert.ok(inbox(U.d, D1) >= 1, '받은 글이 다시 온다');
  sql(`update public.msgr_device_beats set seen_at = now() - interval '10 minutes' where owner_user_id = '${U.d}'`);
  const x0 = beatXmin();
  assert.equal(beat(U.d), '{}');
  assert.notEqual(beatXmin(), x0, '심박이 다시 쓴다');
  assert.equal(asAnon(`select coalesce(public.msgr_service_pause()::text, '(null)')`).split('\n').pop(), '(null)');
});

test('공지 푸시(20261016171000) — service_role만, 중단 중일 때만, 회차마다 엣지 호출 1번(다시 불러도 0번), push_url 없으면 행을 쓰지 않는다', { skip }, () => {
  sql(`create table if not exists public._net_calls (url text, body jsonb);
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
      language sql as $f$ insert into public._net_calls (url, body) values (url, body) returning 1::bigint $f$;`);
  const calls = () => Number(sql(`select count(*) from public._net_calls where body ? 'broadcast_id'`));
  const off = superRaw(`select public.msgr_pause_push('kt', 'ko', 'et', 'en')`);
  assert.notEqual(off.status, 0); assert.match(off.stderr, /msgr_not_paused/);
  sql(`delete from public.msgr_settings where key = 'push_url'`);
  pause('2026-10-16T18:00:00+09:00');
  try {
    const noUrl = superRaw(`select public.msgr_pause_push('kt', 'ko', 'et', 'en')`);
    assert.notEqual(noUrl.status, 0); assert.match(noUrl.stderr, /msgr_push_url_missing/);
    assert.equal(sql(`select count(*) from public.msgr_push_broadcasts`), '0', 'push_url이 없으면 회차를 쓰지 않는다');
    const bad = superRaw(`select public.msgr_pause_push('kt', '', 'et', 'en')`); assert.notEqual(bad.status, 0); assert.match(bad.stderr, /msgr_pause_text_invalid/);
    sql(`insert into public.msgr_settings (key, value) values ('push_url', 'https://edge.test/msgr-push') on conflict (key) do update set value = excluded.value`);
    // 스위치 값 형식 — 엣지 정규식(/^[A-Za-z0-9:._+-]{1,120}$/)을 못 지나는 값(공백 — now()::text 같은)은 행을 쓰기 전에 거절
    for (const bad of ['2026-10-16 18:00:00+09', 'x'.repeat(120)]) {
      pause(bad);
      const r = superRaw(`select public.msgr_pause_push('kt', 'ko', 'et', 'en')`);
      assert.notEqual(r.status, 0, `허용됨: ${bad}`); assert.match(r.stderr, /msgr_pause_since_invalid/);
    }
    assert.equal(sql(`select count(*) from public.msgr_push_broadcasts`), '0', '형식이 틀린 값은 회차를 쓰지 않는다');
    pause('2026-10-16T18:00:00+09:00');
    const u = asUserRaw(U.a, `select public.msgr_pause_push('kt', 'ko', 'et', 'en')`);
    assert.notEqual(u.status, 0, '사용자는 부를 수 없다'); assert.match(u.stderr, /permission denied for function msgr_pause_push/);
    const r = asUserRaw(U.a, `select count(*) from public.msgr_push_broadcasts`);
    assert.ok(r.status !== 0 ? /permission denied for table msgr_push_broadcasts/.test(r.stderr) : last(r.stdout) === '0', '사용자는 공지 행을 못 읽는다');
    const before = calls();
    assert.deepEqual(JSON.parse(last(sql(`select public.msgr_pause_push('Argo Messenger 운영 일시 중단', '메신저를 잠시 멈춥니다.', 'Argo Messenger is pausing', 'Messenger is paused.')::text`))), { queued: true, id: 'pause:2026-10-16T18:00:00+09:00' });
    assert.equal(calls() - before, 1, '엣지 호출 1번');
    assert.equal(last(sql(`select body->>'broadcast_id' from public._net_calls where body ? 'broadcast_id' order by ctid desc limit 1`)), 'pause:2026-10-16T18:00:00+09:00', '요청에는 id만 — 문구는 행에서 읽는다');
    assert.equal(last(sql(`select ko_title || '|' || ko || '|' || en_title || '|' || en from public.msgr_push_broadcasts where id = 'pause:2026-10-16T18:00:00+09:00'`)), 'Argo Messenger 운영 일시 중단|메신저를 잠시 멈춥니다.|Argo Messenger is pausing|Messenger is paused.');
    assert.deepEqual(JSON.parse(last(sql(`select public.msgr_pause_push('t', '다른 문구', 't', 'other')::text`))), { queued: false, id: 'pause:2026-10-16T18:00:00+09:00', reason: 'already' });
    assert.equal(calls() - before, 1, '다시 불러도 엣지 호출이 늘지 않는다');
    assert.equal(last(sql(`select ko from public.msgr_push_broadcasts where id = 'pause:2026-10-16T18:00:00+09:00'`)), '메신저를 잠시 멈춥니다.', '첫 문구가 그대로');
    pause('2026-10-17T09:00:00+09:00'); // 새 회차
    assert.equal(JSON.parse(last(sql(`select public.msgr_pause_push('t', '다시', 't', 'again')::text`))).queued, true);
    assert.equal(calls() - before, 2);
    assert.equal(sql(`select count(*) from pg_trigger where tgfoid = 'public.msgr_pause_push(text,text,text,text)'::regprocedure`), '0', '트리거로 열지 않는다');
  } finally { unpause(); }
});
