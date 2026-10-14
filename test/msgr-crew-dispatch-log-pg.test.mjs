// 파견 기록 + 채널 관리자 내보내기(0.1.108 U2 — 20261014200000_msgr_crew_dispatch_log). 실행: bash scripts/billing-pg-drill.sh test/msgr-crew-dispatch-log-pg.test.mjs
// 경우 표: 방장(채널 만든 사람·조직 관리자)/주인/일반 멤버/손님 × 개인 에이전트/외부 봇/회사 에이전트 × 공개·비공개 채널·조직 DM·개인 친구 방.
// 남이 남의 에이전트를 내보내는 길은 '조직 공개·비공개 채널의 방장이 RPC로'만 열리고, 나머지(일반 멤버·손님·DM 상대·직접 삭제·제외 목록)는 닫혀 있음을 잠근다.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crew-dispatch-log-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
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


const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333',
  d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555', g: '66666666-6666-4666-8666-666666666666', f: '77777777-7777-4777-8777-777777777777' };
// a = 조직 소유자(조직 관리자 — 모든 채널의 방장), b = 멤버(PUB·PRIV를 만든 방장), c = 일반 멤버, d = 에이전트 주인(멤버), e = 서비스 계정(회사 에이전트), g = 손님, f = d의 친구(개인 공간)
let ORG, PUB, PRIV, DM, FR, D1, DBOT, CO, B1, DPER;
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
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  sql(`delete from public.msgr_settings where key = 'free_limits_grace_until'`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const u of [U.b, U.c, U.d, U.e]) { const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`)); asUser(u, `select public.msgr_accept_invite('${code}')`); }
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.g}', 'guest')`); // 게스트는 채널 링크로만 생긴다 — 시드는 슈퍼유저(msgr-bots-pg와 같음)
  PUB = last(asUser(U.b, `select public.msgr_create_channel('${ORG}','public','Work')`));
  PRIV = last(asUser(U.b, `select public.msgr_create_channel('${ORG}','private','Secret')`));
  for (const u of [U.c, U.d]) asUser(u, `select public.msgr_join_channel('${PUB}')`);
  for (const u of [U.c, U.d, U.g]) asUser(U.b, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'user', '${u}', '${U.b}')`);
  DM = last(asUser(U.d, `select public.msgr_create_channel('${ORG}', 'dm', 'dm:c', '[{"kind":"user","id":"${U.c}"}]'::jsonb)`)); // d가 연 조직 DM(d = 결재자)
  const crew = (uid, slug, hosting = 'local', org = ORG) => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (${org ? `'${org}'` : 'null'}, '${uid}', 'ws-${uid.slice(0, 4)}', '${slug}', '${slug}', '${hosting}', 'active', 'owner') returning id`));
  D1 = crew(U.d, 'd1'); DBOT = last(sql(`select set_config('msgr.bot_create', '1', true); insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.d}', 'bot', 'dbot', 'dbot', 'bot', 'active', 'owner') returning id`)); B1 = crew(U.b, 'b1');
  sql(`update public.msgr_orgs set service_user_id = '${U.e}' where id = '${ORG}'`);
  CO = sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.e}', 'ws-node', 'co', 'Company', 'resident', 'active', 'all') returning id`);
  DPER = crew(U.d, 'dper', 'local', null);
  asUser(U.d, `select public.msgr_friend_request('${U.f}')`); asUser(U.f, `select public.msgr_friend_decide('${U.d}', true)`);
  FR = last(asUser(U.f, `select public.msgr_dm_personal('${U.d}')`)); // f가 연 친구 방
});
const inRoom = (ch, crew) => sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'crew' and member_id = '${crew}'`) === '1';
const decideAll = (uid, ch, ok = true) => { for (const id of sql(`select id from public.msgr_channel_crew_requests where channel_id = '${ch}' and status = 'pending'`).split('\n').filter(Boolean)) asUser(uid, `select public.msgr_crew_join_decide('${id}', ${ok})`); };
const leave = (uid, ch, crew) => asUserRaw(uid, `select public.msgr_crew_leave_channel('${ch}', '${crew}')`);
const logRows = (ch, crew) => sql(`select event || ':' || coalesce(actor::text, '-') from public.msgr_crew_dispatch_log where channel_id = '${ch}' and crew_id = '${crew}' order by id`).split('\n').filter(Boolean);
const put = (ch, crew) => { if (!inRoom(ch, crew)) sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${crew}', '${U.a}')`); };
const ago = (ch, crew, mins) => sql(`update public.msgr_crew_dispatch_log set at = now() - interval '${mins} minutes' where channel_id = '${ch}' and crew_id = '${crew}'`);

test('파견 기록 — 요청 승인(dispatched·승인한 사람), 거절(declined), 이미 있으면 기록 없음', { skip }, () => {
  assert.equal(join(U.d, PUB, D1), 'requested', '공개 채널 기본은 방장 허락');
  decideAll(U.b, PUB, false);
  assert.deepEqual(logRows(PUB, D1), [`declined:${U.b}`]);
  sql(`update public.msgr_channel_crew_requests set decided_at = now() - interval '2 hours' where channel_id = '${PUB}'`); // 거절 1시간 막기는 기존 규칙 — 지난 것으로
  assert.equal(join(U.d, PUB, D1), 'requested'); decideAll(U.b, PUB, true);
  assert.equal(inRoom(PUB, D1), true);
  assert.deepEqual(logRows(PUB, D1), [`declined:${U.b}`, `dispatched:${U.b}`]);
  assert.equal(join(U.d, PUB, D1), 'already'); assert.equal(logRows(PUB, D1).length, 2, '이미 있으면 기록하지 않는다');
});

test('관리자 판정 — 조직 공개·비공개 채널의 방장(만든 사람·조직 관리자)만 참, 일반 멤버·손님·주인(방장 아님)은 거짓', { skip }, () => {
  const can = (uid, ch, crew) => last(asUser(uid, `select public.msgr_crew_admin_removable('${ch}', '${crew}')`));
  for (const ch of [PUB, PRIV]) {
    assert.equal(can(U.b, ch, D1), 't', `방장 b ${ch === PUB ? '공개' : '비공개'}`);
    assert.equal(can(U.a, ch, D1), 't', '조직 관리자 a');
    assert.equal(can(U.c, ch, D1), 'f', '일반 멤버 c');
    assert.equal(can(U.d, ch, D1), 'f', '주인 d도 방장은 아니다(주인은 다른 판정으로 뺀다)');
  }
  assert.equal(can(U.g, PRIV, D1), 'f', '손님 g');
  assert.equal(can(U.d, DM, D1), 'f', '조직 DM — 결재자(d)라도 관리자 갈래는 없다');
  assert.equal(can(U.c, DM, D1), 'f', '조직 DM 상대');
  assert.equal(can(U.f, FR, DPER), 'f', '개인 공간 친구 방 — 방을 연 f도 아니다(D8)');
});

test('일반 멤버·손님은 남의 에이전트를 못 뺀다 — RPC 거절, 직접 삭제도 막힘, 기록 없음', { skip }, () => {
  put(PRIV, D1);
  const before = logRows(PRIV, D1).length;
  fails(leave(U.c, PRIV, D1), /msgr_crew_remove_owner_only/, '일반 멤버 c(RPC)');
  fails(leave(U.g, PRIV, D1), /msgr_crew_remove_owner_only/, '손님 g(RPC)');
  for (const u of [U.c, U.g, U.b]) asUser(u, `delete from public.msgr_channel_members where channel_id = '${PRIV}' and member_kind = 'crew' and member_id = '${D1}'`);
  assert.equal(inRoom(PRIV, D1), true, '직접 삭제는 일반 멤버·손님·방장 모두 막힌다(관리자 내보냄은 RPC 한 길)');
  fails(asUserRaw(U.b, `update public.msgr_channels set excluded_crew_ids = array['${D1}']::uuid[] where id = '${PUB}'`), /msgr_crew_remove_owner_only/, '공개 채널 제외 목록도 방장에게 열지 않는다');
  assert.equal(logRows(PRIV, D1).length, before, '거절된 시도는 기록하지 않는다');
});

test('방장 내보냄(G3) — 개인 에이전트·외부 봇·회사 에이전트 모두 빠지고 removed_by_admin 기록, 감사 기록은 host', { skip }, () => {
  put(PRIV, D1); put(PRIV, DBOT); put(PRIV, CO);
  for (const crew of [D1, DBOT, CO]) {
    assert.equal(last(leave(U.b, PRIV, crew).stdout), 'removed', crew);
    assert.equal(inRoom(PRIV, crew), false);
    assert.equal(logRows(PRIV, crew).pop(), `removed_by_admin:${U.b}`);
  }
  assert.equal(sql(`select count(*) from public.msgr_audit_log where action = 'crew_removed_from_channel' and meta->>'channel_id' = '${PRIV}' and meta->>'by' = 'host'`), '3');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${PRIV}' and member_kind = 'user' and member_id = '${U.d}'`), '1', '주인(사람)은 채널에 남는다');
});

test('내보낸 뒤 1시간은 방장이 아닌 사람이 다시 못 넣는다(요청·누구나 데려옴 바로 넣기 모두) — 1시간 지나면 풀린다, 방장은 막지 않는다', { skip }, () => {
  fails(asUserRaw(U.d, `select public.msgr_crew_join('${PRIV}', '${D1}')`), /msgr_request_recently_rejected/, '요청 경로');
  asUser(U.b, `update public.msgr_channels set personal_crews = 'allowed' where id = '${PRIV}'`);
  fails(asUserRaw(U.d, `select public.msgr_crew_join('${PRIV}', '${D1}')`), /msgr_request_recently_rejected/, '누구나 데려옴(바로 넣기) 경로');
  assert.equal(inRoom(PRIV, D1), false);
  ago(PRIV, D1, 61);
  assert.equal(join(U.d, PRIV, D1), 'joined', '1시간 지나면 다시 넣는다(누구나 데려옴)');
  assert.deepEqual(logRows(PRIV, D1).slice(-1), [`dispatched:${U.d}`]);
  asUser(U.b, `update public.msgr_channels set personal_crews = 'approval' where id = '${PRIV}'`);
  // 방장 본인의 에이전트를 조직 관리자가 내보낸 뒤 — 방장(b)은 막지 않는다
  assert.equal(join(U.b, PRIV, B1), 'joined');
  assert.equal(last(leave(U.a, PRIV, B1).stdout), 'removed');
  assert.equal(join(U.b, PRIV, B1), 'joined', '방장은 1시간 막기를 받지 않는다');
});

test('주인 해제 — released_by_owner 기록, 재가입 막지 않음', { skip }, () => {
  put(PUB, D1);
  assert.equal(last(leave(U.d, PUB, D1).stdout), 'removed');
  assert.equal(logRows(PUB, D1).pop(), `released_by_owner:${U.d}`);
  assert.equal(join(U.d, PUB, D1), 'requested', '주인이 뺀 것은 다시 요청할 수 있다');
  decideAll(U.b, PUB, true);
});

test('조직 DM·개인 친구 방은 종전대로 주인만 — 상대·방을 연 사람은 owner_only/거절, 기록 없음', { skip }, () => {
  assert.equal(join(U.d, DM, D1), 'joined', 'DM 결재자 d는 바로 넣는다');
  assert.deepEqual(logRows(DM, D1), [`dispatched:${U.d}`], 'DM 바로 넣기도 기록');
  const r = leave(U.c, DM, D1);
  if (r.status === 0) assert.equal(last(r.stdout), 'owner_only'); else assert.match(r.stderr, /msgr_crew_remove_owner_only/);
  assert.equal(inRoom(DM, D1), true, 'DM 상대 c는 못 뺀다');
  assert.equal(join(U.d, FR, DPER), 'requested', '친구 방은 방을 연 f의 허락'); decideAll(U.f, FR, true);
  assert.equal(inRoom(FR, DPER), true);
  const r2 = leave(U.f, FR, DPER);
  assert.equal(r2.status === 0 ? last(r2.stdout) : 'error', 'owner_only', '친구 방을 연 f도 남의 에이전트를 못 뺀다(D8)');
  assert.equal(inRoom(FR, DPER), true);
  assert.equal(logRows(FR, DPER).filter((x) => x.startsWith('removed')).length, 0);
});

test('기록 읽기 — 그 에이전트의 주인·채널 관리자만, 일반 멤버·손님은 0행. 직접 쓰기는 누구도 못 함', { skip }, () => {
  const seen = (uid, ch) => last(asUser(uid, `select count(*) from public.msgr_crew_dispatch_log where channel_id = '${ch}'`));
  assert.notEqual(seen(U.d, PRIV), '0', '주인 d는 자기 에이전트 기록을 본다');
  assert.notEqual(seen(U.b, PRIV), '0', '방장 b는 그 채널 기록을 본다');
  assert.equal(seen(U.c, PRIV), '0', '일반 멤버 c');
  assert.equal(seen(U.g, PRIV), '0', '손님 g');
  assert.equal(last(asUser(U.d, `select count(*) from public.msgr_crew_dispatch_log where crew_id = '${B1}'`)), '0', '남(d)은 남(b)의 에이전트 기록을 주인 자격으로 보지 못한다');
  fails(asUserRaw(U.b, `insert into public.msgr_crew_dispatch_log (channel_id, crew_id, event, actor) values ('${PRIV}', '${D1}', 'dispatched', '${U.b}')`), /permission denied/, '직접 삽입');
  fails(asUserRaw(U.b, `update public.msgr_crew_dispatch_log set event = 'declined'`), /permission denied/, '직접 수정');
  fails(asUserRaw(U.b, `delete from public.msgr_crew_dispatch_log`), /permission denied/, '직접 삭제');
  fails(asUserRaw(U.b, `select public._msgr_dispatch_log('${PRIV}', '${D1}', 'dispatched', '${U.b}')`), /permission denied/, '내부 도우미 직접 호출');
});

test('DB 위생 — 판정·재가입 확인은 쓰기 0, 보존 정리는 1년 지난 행만 지우고 지울 것이 없으면 쓰기 0', { skip }, () => {
  const noWrite = (uid, q) => last(asUser(uid, `${q}; select coalesce(txid_current_if_assigned()::text, 'none')`));
  assert.equal(noWrite(U.b, `select public.msgr_crew_admin_removable('${PRIV}', '${D1}')`), 'none');
  assert.equal(noWrite(U.c, `select count(*) from public.msgr_crew_dispatch_log`), 'none');
  assert.equal(last(sql(`select public.msgr_crew_dispatch_log_prune(); select coalesce(txid_current_if_assigned()::text, 'none')`)), 'none', '지울 행이 없으면 쓰기 0');
  const n = Number(sql(`select count(*) from public.msgr_crew_dispatch_log`));
  sql(`insert into public.msgr_crew_dispatch_log (channel_id, crew_id, event, actor, at) values ('${PUB}', '${D1}', 'dispatched', '${U.d}', now() - interval '400 days'), ('${PUB}', '${D1}', 'declined', '${U.d}', now() - interval '300 days')`);
  assert.equal(sql(`select public.msgr_crew_dispatch_log_prune()`), '1', '1년 지난 1행만');
  assert.equal(sql(`select count(*) from public.msgr_crew_dispatch_log where at < now() - interval '200 days'`), '1', '1년이 안 된 행(300일)은 남는다');
  assert.equal(Number(sql(`select count(*) from public.msgr_crew_dispatch_log`)), n + 1, '최근 기록과 300일 행은 그대로');
});
