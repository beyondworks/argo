// 무료 계정 에이전트 일시 중지(2026-10-10 유건 지시: "Pro 결제 안 하면 클라우드 사용 못하게") — 20261010200000·20261010200100.
// 이 파일이 잠그는 것:
//   ① sweep — 무료 계정의 사람 에이전트 active → paused, Pro(결제·운영자 부여·유료 조직 좌석·남은 체험)는 그대로. available·detached는 손대지 않는다.
//   ② 쓰기 관문 — 무료 계정의 새 행(미러 insert)·detached→active(0.1.96+ 미러 되살리기)·paused→active는 조용히 paused, 사람이 누른 available→active만
//      msgr_pro_required. 업서트 충돌이 파견 해제한 available 행을 paused로 바꾸지 않는다. 사람이 paused를 직접 쓰지 못한다.
//   ③ 재개 — 결제 반영(entitlements 삽입·갱신)은 그 자리에서, 조직 좌석·체험 만료는 크론 함수 한 번으로. 커서는 지금 끝으로(멈춘 동안 받은 글에 답하지 않는다).
//   ④ 보존 — 멈춘 동안 방 참여·메시지·결재·자동화(켜짐 유지)·실행 기록·루틴 미러가 그대로(삭제 0).
//   ⑤ DB 위생 — 바뀔 것이 없는 sweep은 msgr_crews·msgr_crew_pauses·msgr_automations 행 xmin 불변(쓰기 0).
//   ⑥ 봇 관문 msgr_bot_gate — 무료 주인 'plan_required', Pro 'ok', 스위치(bot_plan_gate=off) 'ok', 재개 전까지는 Pro여도 막고 재개 때 봇 커서를 끝으로.
//   ⑦ 자동화 발송·멤버 내보내기 — 멈춘 에이전트의 자동화를 끄지 않고 건너뛰며, 조직을 떠나면 paused 행도 detached.
// 다른 pg 테스트는 드릴이 msgr.pro_gate=off로 돌린다(사용자를 Pro로 전제) — 이 파일은 자기 DB에서 on으로 되돌린다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-crews-pro-pause-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crews-pro-pause-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
// a = 무료(조직 O1 주인), b = 결제 Pro(O1 멤버), c = 체험 중, d = 무료(조직 O2 주인 — 좌석 경로), e = 무료(O1 멤버 — 내보내기 경로)
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333',
  d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555' };
const WS = 'ws-a';
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asAnon = (q) => sql(`set role anon; ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const orgCrew = (uid, org, slug, status = 'active') => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${org}', '${uid}', '${WS}', '${slug}', '${slug}', 'local', '${status}', 'all') returning id`));
const personalCrew = (uid, slug) => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${uid}', '${WS}', '${slug}', '${slug}', 'local', 'active', 'owner') returning id`));
const statusOf = (id) => sql(`select status from public.msgr_crews where id = '${id}'`);
const cursorOf = (id) => Number(sql(`select coalesce(cursor_msg_id, 0) from public.msgr_crews where id = '${id}'`));
const sweep = (uid = null) => JSON.parse(sql(`select public.msgr_crews_plan_sweep(${uid ? `'${uid}'` : 'null'})`));
const topMsg = () => Number(sql('select coalesce(max(id), 0) from public.msgr_messages'));
const post = (uid, ch, body, crew) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', ${q(body)}, ${q(JSON.stringify(crew ? [{ kind: 'crew', id: crew, role: 'to' }] : []))}::jsonb, gen_random_uuid()::text) returning id`));
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 200)}`); };

const C = {}; let O1, O2, CH, CH2, TOKEN_A, TOKEN_D, BOT_A, BOT_D, AUTO, SRC;
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
  // 이 DB만 관문을 켠다(드릴은 다른 테스트를 위해 off로 만든다). 새 접속부터 적용 — 이 파일의 psql 호출은 매번 새 접속이다.
  sql(`do $$ begin execute format('alter database %I set msgr.pro_gate = %L', current_database(), 'on'); end $$`);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  for (const f of [...base, ...readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  // 체험: plan_no_trial의 기준 시각 T(위에서 막 적용) 이전 가입자만 가입+14일. c는 하루 전 가입 = 체험 중, 나머지는 30일 전 = 체험 끝.
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '${k === 'c' ? 1 : 30} days', '${k}@example.test') on conflict do nothing`);
  sql(`insert into public.entitlements (user_id, plan) values ('${U.b}', 'pro')`);

  O1 = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  O2 = last(asUser(U.d, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Side', 'side', '${U.d}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id in ('${O1}', '${O2}')`);
  for (const uid of [U.b, U.e]) {
    const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${O1}', 'member', '${U.a}') returning code`));
    asUser(uid, `select public.msgr_accept_invite('${code}')`);
  }
  // 관문이 켜진 상태에서 Pro·체험 계정의 행은 그대로 active로 들어간다
  C.B1 = orgCrew(U.b, O1, 'b1'); C.C1 = personalCrew(U.c, 'c1'); C.D1 = orgCrew(U.d, O2, 'd1'); C.E1 = orgCrew(U.e, O1, 'e1');
  // 무료 계정 a의 행 — 관문 도입 전(이미 운영에 있는 active 행)을 흉내 내려고 관문을 끈 세션에서 넣는다
  const off = (q2) => sql(`select set_config('msgr.pro_gate', 'off', false); ${q2}`);
  const offIns = (org, slug, status, allow = 'all') => last(off(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (${org ? `'${org}'` : 'null'}, '${U.a}', '${WS}', '${slug}', '${slug}', 'local', '${status}', '${allow}') returning id`));
  C.A1 = offIns(O1, 'a1', 'active'); C.A2 = offIns(null, 'a2', 'active', 'owner'); C.AV = offIns(O1, 'av', 'available'); C.AD = offIns(O1, 'ad', 'detached');
  C.D1 = last(off(`update public.msgr_crews set status = 'active' where id = '${C.D1}' returning id`)); // d도 관문 도입 전 active
  C.E1 = last(off(`update public.msgr_crews set status = 'active' where id = '${C.E1}' returning id`));
  // 봇: a(O1)·d(O2) 각각
  let out = JSON.parse(last(asUser(U.a, `select public.msgr_bot_create('${O1}', 'hermes', '헤르메스', '외부 에이전트')`))); BOT_A = out.crew_id; TOKEN_A = out.token;
  out = JSON.parse(last(asUser(U.d, `select public.msgr_bot_create('${O2}', 'hermes', '헤르메스D', '외부 에이전트')`))); BOT_D = out.crew_id; TOKEN_D = out.token;
  // 방·참여·글·결재·자동화·실행 기록·루틴 미러 — a1에 붙은 기억 데이터
  CH = last(asUser(U.a, `select public.msgr_create_channel('${O1}', 'public', 'Work')`));
  CH2 = last(asUser(U.d, `select public.msgr_create_channel('${O2}', 'public', 'Side')`));
  for (const crew of [C.A1, BOT_A, C.B1, C.E1]) sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${CH}', 'crew', '${crew}') on conflict do nothing`);
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${CH}', 'user', '${U.e}') on conflict do nothing`);
  for (const crew of [C.D1, BOT_D]) sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${CH2}', 'crew', '${crew}') on conflict do nothing`);
  SRC = post(U.a, CH, '@a1 이거 정리해 줘', C.A1);
  sql(`insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, reason) values ('${O1}', '${CH}', '${C.A1}', 'ap-1', 'rm -rf build', 'test')`);
  sql(`insert into public.msgr_executions (crew_id, source_msg_id, attempt, state) values ('${C.A1}', ${SRC}, gen_random_uuid(), 'completed')`);
  sql(`insert into public.msgr_crew_routines (org_id, crew_id, owner_user_id, ext_id, title, prompt, schedule, channel_id) values ('${O1}', '${C.A1}', '${U.a}', 'r1', '매일 정리', '정리해', '{"kind":"daily","time":"09:00","timezone":"Asia/Seoul"}', '${CH}')`);
  AUTO = last(sql(`insert into public.msgr_automations (org_id, channel_id, crew_id, created_by, title, prompt, schedule, next_run_at) values ('${O1}', '${CH}', '${C.A1}', '${U.a}', '시간마다', '보고해', '{"kind":"interval","minutes":60,"timezone":"Asia/Seoul"}', now() + interval '1 hour') returning id`));
});

const keep = () => ({
  members: sql(`select count(*) from public.msgr_channel_members where member_kind = 'crew' and member_id = '${C.A1}'`),
  msgs: sql('select count(*) from public.msgr_messages'),
  approvals: sql(`select count(*) from public.msgr_crew_approvals where crew_id = '${C.A1}'`),
  autos: sql(`select count(*) || ':' || bool_and(enabled) from public.msgr_automations where crew_id = '${C.A1}' and deleted_at is null`),
  execs: sql(`select count(*) from public.msgr_executions where crew_id = '${C.A1}'`),
  routines: sql(`select count(*) from public.msgr_crew_routines where crew_id = '${C.A1}'`),
});
let KEEP0;

test('① sweep: 무료 계정 active → paused(사람 에이전트), Pro·체험은 그대로, available·detached·봇 상태는 손대지 않는다', { skip }, () => {
  KEEP0 = keep();
  assert.deepEqual(KEEP0, { members: '1', msgs: KEEP0.msgs, approvals: '1', autos: '1:true', execs: '1', routines: '1' });
  const r = sweep();
  assert.equal(r.failed, 0);
  assert.equal(statusOf(C.A1), 'paused'); assert.equal(statusOf(C.A2), 'paused', '개인 공간 행도');
  assert.equal(statusOf(C.D1), 'paused'); assert.equal(statusOf(C.E1), 'paused');
  assert.equal(statusOf(C.B1), 'active', '결제 Pro'); assert.equal(statusOf(C.C1), 'active', '남은 체험');
  assert.equal(statusOf(C.AV), 'available'); assert.equal(statusOf(C.AD), 'detached');
  assert.equal(statusOf(BOT_A), 'active', '봇 상태는 바꾸지 않는다(엣지 관문)');
  assert.equal(sql(`select count(*) from public.msgr_crew_pauses where crew_id in ('${C.A1}', '${C.A2}', '${C.D1}', '${C.E1}', '${BOT_A}', '${BOT_D}') and resumed_at is null`), '6', '사람 4 + 봇 2의 중지 기록');
  assert.equal(sql(`select count(*) from public.msgr_crew_pauses where crew_id in ('${C.B1}', '${C.C1}', '${C.AV}', '${C.AD}')`), '0');
});

test('④ 보존: 멈춘 뒤에도 방 참여·메시지·결재·자동화(켜짐)·실행 기록·루틴 미러가 그대로', { skip }, () => {
  assert.deepEqual(keep(), KEEP0);
});

test('⑤ DB 위생: 바뀔 것이 없는 sweep은 쓰기 0(행 xmin 불변)', { skip }, () => {
  const snap = () => sql(`select string_agg(id::text || ':' || xmin::text, ',' order by id) from public.msgr_crews`) + '|' +
    sql(`select coalesce(string_agg(crew_id::text || ':' || xmin::text, ',' order by crew_id), '') from public.msgr_crew_pauses`) + '|' +
    sql(`select string_agg(id::text || ':' || xmin::text, ',' order by id) from public.msgr_automations`);
  const s0 = snap();
  const r = sweep();
  assert.deepEqual(r, { paused: 0, resumed: 0, failed: 0 });
  assert.equal(snap(), s0, '유휴 sweep이 행을 다시 쓰지 않았다');
  sweep(U.b); assert.equal(snap(), s0, '사용자 한 명 sweep(결제 트리거 경로)도 쓰기 0');
});

test('② 쓰기 관문: 무료 계정의 새 행·detached→active·paused→active는 조용히 paused, 사람이 누른 available→active는 msgr_pro_required', { skip }, () => {
  // 미러 insert(0.1.94~ 모두 status 'active'로 넣는다) — 오류 없이 paused로 들어간다(오류면 옛 미러가 15초마다 다시 보낸다)
  const n1 = orgCrew(U.a, O1, 'a-new');
  assert.equal(statusOf(n1), 'paused');
  assert.equal(sql(`select count(*) from public.msgr_crew_pauses where crew_id = '${n1}' and resumed_at is null`), '1', '관문이 멈춘 새 행도 기록');
  const p1 = personalCrew(U.a, 'a-new-p'); assert.equal(statusOf(p1), 'paused');
  // 0.1.96+ 미러 되살리기: update … set status='active' where status='detached'
  asUser(U.a, `update public.msgr_crews set status = 'active' where id = '${C.AD}' and status = 'detached'`);
  assert.equal(statusOf(C.AD), 'paused');
  // paused를 직접 active로(설정 화면 activate·옛 앱) — 조용히 paused
  asUser(U.a, `update public.msgr_crews set status = 'active' where id = '${C.A1}'`);
  assert.equal(statusOf(C.A1), 'paused');
  // 사람이 누른 파견(available→active) — 이유가 보이게 거절
  fails(asUserRaw(U.a, `update public.msgr_crews set status = 'active' where id = '${C.AV}'`), /msgr_pro_required/, '무료 계정 파견');
  assert.equal(statusOf(C.AV), 'available');
  // 업서트 충돌(옛 미러 upsertAvailable·설정 POST): insert 쪽 관문이 excluded.status를 paused로 바꿔도 파견 해제한 available 행은 그대로
  asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${O1}', '${U.a}', '${WS}', 'av', 'av', 'local', 'active', 'all')
    on conflict (org_id, owner_user_id, ws_id, slug) do update set status = excluded.status, display_name = excluded.display_name`);
  assert.equal(statusOf(C.AV), 'available', '업서트 충돌이 available을 paused로 바꾸지 않는다');
  // 사람이 paused를 직접 쓰지 못한다(paused는 서버만 만든다) — Pro 계정의 active 행
  asUser(U.b, `update public.msgr_crews set status = 'paused' where id = '${C.B1}'`);
  assert.equal(statusOf(C.B1), 'active');
  // 파견 해제(paused→available)는 된다 — 그 뒤 sweep이 열린 기록을 닫는다
  asUser(U.a, `update public.msgr_crews set status = 'available' where id = '${p1}'`);
  assert.equal(statusOf(p1), 'available');
  sweep(U.a);
  assert.equal(sql(`select resumed_at is not null from public.msgr_crew_pauses where crew_id = '${p1}'`), 't');
  // Pro 계정은 관문이 막지 않는다(available→active 포함)
  const bv = orgCrew(U.b, O1, 'bv', 'available'); asUser(U.b, `update public.msgr_crews set status = 'active' where id = '${bv}'`);
  assert.equal(statusOf(bv), 'active');
  // 봇 행(hosting='bot')은 관문 밖 — 봇의 커서·심박 갱신이 그대로 된다
  sql(`update public.msgr_crews set last_seen_at = now(), cursor_msg_id = greatest(cursor_msg_id, 1) where id = '${BOT_A}'`);
  assert.equal(statusOf(BOT_A), 'active');
});

test('⑥ 봇 관문: 무료 주인 plan_required, 스위치 off면 ok, 토큰 오류는 msgr_bot_unauthorized', { skip }, () => {
  assert.equal(asAnon(`select public.msgr_bot_gate('${TOKEN_A}')`), 'plan_required');
  assert.equal(asAnon(`select public.msgr_bot_gate('${TOKEN_D}')`), 'plan_required');
  sql(`insert into public.msgr_settings (key, value) values ('bot_plan_gate', 'off') on conflict (key) do update set value = 'off'`);
  assert.equal(asAnon(`select public.msgr_bot_gate('${TOKEN_A}')`), 'ok', '스위치 off');
  sql(`delete from public.msgr_settings where key = 'bot_plan_gate'`);
  fails(psqlRaw(['-A', '-t', '-c', `set role anon; select public.msgr_bot_gate('argo_bot_${'z'.repeat(48)}')`]), /msgr_bot_unauthorized/, '없는 토큰');
});

let QRUN;
test('⑦ 자동화 발송: 멈춘 에이전트의 자동화는 보내지도 끄지도 않는다(쓰기 0) — 그대로 두면 권한 철회로 보고 enabled=false가 됐다', { skip }, () => {
  // 멈추기 전에 줄 서 있던 실행(실행 기록 없음) — 발송 첫 반복(줄 선 실행 정리)이 권한 철회로 보고 막음 + enabled=false로 만들던 갈래
  const qm = post(U.a, CH, '@a1 자동화 실행', C.A1);
  QRUN = last(sql(`insert into public.msgr_automation_runs (automation_id, scheduled_for, trigger, status, message_id) values ('${AUTO}', now() - interval '2 minutes', 'schedule', 'queued', ${qm}) returning id`));
  sql(`update public.msgr_automations set next_run_at = now() - interval '1 minute' where id = '${AUTO}'`);
  const before = sql(`select xmin::text || ':' || enabled from public.msgr_automations where id = '${AUTO}'`);
  const runs0 = sql(`select count(*) from public.msgr_automation_runs where automation_id = '${AUTO}'`);
  sql(`select public.msgr_automation_dispatch_cloud()`);
  assert.equal(sql(`select xmin::text || ':' || enabled from public.msgr_automations where id = '${AUTO}'`), before, '건너뛴다 — 끄지 않고 쓰지도 않는다');
  assert.equal(sql(`select count(*) from public.msgr_automation_runs where automation_id = '${AUTO}'`), runs0, '실행 행 0');
  assert.equal(sql(`select status from public.msgr_automation_runs where id = '${QRUN}'`), 'queued', '줄 선 실행을 권한 철회로 막지 않는다');
});

test('③ 재개(결제): entitlements 삽입이 그 사용자를 바로 active로 — 커서는 지금 끝, 밀린 자동화는 다음 시각으로, 봇도 커서를 끝으로 옮긴 뒤 ok', { skip }, () => {
  // 멈춘 동안 받은 글 — 재개 뒤 답하지 않는다(글은 남는다)
  const m1 = post(U.a, CH, '@a1 멈춘 동안 온 글', C.A1); const m2 = post(U.a, CH, '@헤르메스 봇에게도', BOT_A);
  const top = topMsg(); assert.ok(top >= Number(m2));
  sql(`insert into public.entitlements (user_id, plan) values ('${U.a}', 'pro')`);
  assert.equal(statusOf(C.A1), 'active'); assert.equal(statusOf(C.A2), 'active'); assert.equal(statusOf(C.AD), 'active', '미러가 되살리려던 행');
  assert.equal(statusOf(C.AV), 'available', '파견 해제는 사람 선택 — 재개가 덮지 않는다');
  assert.ok(cursorOf(C.A1) >= top, `커서 ${cursorOf(C.A1)} ≥ 끝 ${top}`);
  assert.ok(cursorOf(BOT_A) >= top, '봇 커서도 끝으로 — 재개 때 밀린 업데이트를 한꺼번에 주지 않는다');
  assert.equal(sql(`select count(*) from public.msgr_messages where id in (${m1}, ${m2})`), '2', '멈춘 동안 온 글은 남는다');
  assert.equal(asAnon(`select public.msgr_bot_gate('${TOKEN_A}')`), 'ok');
  assert.equal(sql(`select count(*) from public.msgr_crew_pauses where owner_user_id = '${U.a}' and resumed_at is null`), '0');
  assert.equal(sql(`select resume_after from public.msgr_crew_pauses where crew_id = '${C.A1}'`), String(top));
  // 자동화: 켜짐 그대로, 지난 예정 시각은 미래로(재개하자마자 밀린 실행 없음)
  assert.equal(sql(`select enabled and next_run_at > now() from public.msgr_automations where id = '${AUTO}'`), 't');
  // 멈추기 전에 줄 서 있던 실행은 막힘(paused)으로 닫는다 — 그 글은 커서 뒤로 넘어가 다시 읽히지 않고, 열린 채면 새 실행을 영영 막는다
  assert.equal(sql(`select status || ':' || error from public.msgr_automation_runs where id = '${QRUN}'`), 'blocked:paused');
  // 보존 — 글 2개만 늘었다
  assert.deepEqual({ ...keep(), msgs: '-' }, { ...KEEP0, msgs: '-' });
});

test('③ 결제 해지(entitlements 갱신)는 바로 다시 중지, 운영자 부여(granted)는 재개 — 결제 트리거는 오류를 밖으로 던지지 않는다', { skip }, () => {
  sql(`update public.entitlements set plan = 'free' where user_id = '${U.a}'`);
  assert.equal(statusOf(C.A1), 'paused'); assert.equal(asAnon(`select public.msgr_bot_gate('${TOKEN_A}')`), 'plan_required');
  sql(`update public.entitlements set granted = true where user_id = '${U.a}'`);
  assert.equal(statusOf(C.A1), 'active'); assert.equal(asAnon(`select public.msgr_bot_gate('${TOKEN_A}')`), 'ok');
  // sweep이 실패해도 결제 반영은 남는다 — 함수를 잠깐 깨뜨려 본다
  sql(`alter function public.msgr_crews_plan_sweep(uuid) rename to msgr_crews_plan_sweep_saved`);
  try { sql(`update public.entitlements set ls_status = 'active' where user_id = '${U.a}'`); }
  finally { sql(`alter function public.msgr_crews_plan_sweep_saved(uuid) rename to msgr_crews_plan_sweep`); }
  assert.equal(sql(`select ls_status from public.entitlements where user_id = '${U.a}'`), 'active');
});

test('③ 재개(조직 좌석·체험): 트리거 없는 변화는 크론 함수 한 번으로 — 재개 전까지 봇은 Pro여도 막는다', { skip }, () => {
  sql(`update public.msgr_org_entitlements set paid_until = now() + interval '30 days' where org_id = '${O2}'`);
  assert.equal(statusOf(C.D1), 'paused', '크론 전');
  assert.equal(asAnon(`select public.msgr_bot_gate('${TOKEN_D}')`), 'plan_required', 'Pro가 됐어도 재개(커서 이동) 전에는 막는다 — 밀린 글을 한꺼번에 받지 않게');
  const r = sweep();
  assert.equal(r.failed, 0); assert.ok(r.resumed >= 2, JSON.stringify(r));
  assert.equal(statusOf(C.D1), 'active'); assert.equal(asAnon(`select public.msgr_bot_gate('${TOKEN_D}')`), 'ok');
  // 좌석이 끝나면 다시 중지
  sql(`update public.msgr_org_entitlements set paid_until = now() - interval '1 minute' where org_id = '${O2}'`);
  sweep();
  assert.equal(statusOf(C.D1), 'paused'); assert.equal(asAnon(`select public.msgr_bot_gate('${TOKEN_D}')`), 'plan_required');
  // 체험 만료
  assert.equal(statusOf(C.C1), 'active');
  sql(`update auth.users set created_at = now() - interval '20 days' where id = '${U.c}'`);
  sweep();
  assert.equal(statusOf(C.C1), 'paused');
});

test('⑦ 멤버 내보내기: paused 행도 detached로 — Pro 재개가 조직을 떠난 사람의 에이전트를 되살리지 않는다', { skip }, () => {
  assert.equal(statusOf(C.E1), 'paused');
  sql(`update public.msgr_org_members set removed_at = now() where org_id = '${O1}' and user_id = '${U.e}'`);
  assert.equal(statusOf(C.E1), 'detached');
  sql(`insert into public.entitlements (user_id, plan) values ('${U.e}', 'pro')`);
  assert.equal(statusOf(C.E1), 'detached', '조직을 떠난 행은 재개 대상이 아니다');
});

test('전체 끄기: msgr.pro_gate=off면 관문·sweep·봇 관문이 아무것도 하지 않는다', { skip }, () => {
  assert.equal(statusOf(C.D1), 'paused');
  const r = JSON.parse(sql(`select set_config('msgr.pro_gate', 'off', false); select public.msgr_crews_plan_sweep()`).split('\n').pop());
  assert.equal(r.skipped, 'msgr.pro_gate=off');
  assert.equal(sql(`select set_config('msgr.pro_gate', 'off', false); select public.msgr_bot_gate('${TOKEN_D}')`).split('\n').pop(), 'ok');
  const n = last(sql(`select set_config('msgr.pro_gate', 'off', false); insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${O2}', '${U.d}', '${WS}', 'd-off', 'd-off', 'local', 'active', 'all') returning id`));
  assert.equal(statusOf(n), 'active');
});

test('보존 기간: 재개한 중지 기록은 30일 지나면 sweep이 지우고, 그 전은 남긴다', { skip }, () => {
  sql(`insert into public.msgr_crew_pauses (crew_id, owner_user_id, paused_at, resumed_at) values
    ('${C.AV}', '${U.a}', now() - interval '40 days', now() - interval '31 days'),
    ('${C.B1}', '${U.b}', now() - interval '40 days', now() - interval '29 days')
    on conflict (crew_id) do update set paused_at = excluded.paused_at, resumed_at = excluded.resumed_at`);
  sweep();
  assert.equal(sql(`select count(*) from public.msgr_crew_pauses where crew_id = '${C.AV}'`), '0', '31일 지난 기록은 지운다');
  assert.equal(sql(`select count(*) from public.msgr_crew_pauses where crew_id = '${C.B1}'`), '1', '29일 된 기록은 남긴다');
});

test('되돌리기 msgr_crews_plan_unpause_all: 재개와 같은 경로 — 사람 paused·봇 기록 전부, 커서를 끝으로, 기록 닫기. service_role 전용', { skip }, () => {
  fails(asUserRaw(U.a, 'select public.msgr_crews_plan_unpause_all()'), /permission denied/, 'authenticated 실행');
  // 되돌리기 순서: 관문·결제 트리거를 내리고 봇 스위치를 끈 뒤 부른다(마이그레이션 머리 주석)
  sql('drop trigger msgr_crews_plan_sweep_ent on public.entitlements; drop trigger msgr_crews_pro_gate on public.msgr_crews');
  sql(`insert into public.msgr_settings (key, value) values ('bot_plan_gate', 'off') on conflict (key) do update set value = 'off'`);
  const pausedIds = sql(`select string_agg(id::text, ',' order by id) from public.msgr_crews where status = 'paused'`).split(',');
  assert.ok(pausedIds.includes(C.D1) && pausedIds.includes(C.C1), pausedIds.join());
  assert.equal(sql(`select count(*) from public.msgr_crew_pauses where crew_id = '${BOT_D}' and resumed_at is null`), '1', '무료 주인 봇의 열린 기록');
  post(U.d, CH2, '@d1 되돌리기 전에 온 글', C.D1);
  const top = topMsg();
  const r = JSON.parse(sql('select public.msgr_crews_plan_unpause_all()'));
  assert.equal(r.failed, 0); assert.ok(r.resumed >= pausedIds.length, JSON.stringify(r));
  assert.equal(sql(`select count(*) from public.msgr_crews where status = 'paused'`), '0');
  for (const id of [...pausedIds, BOT_D]) assert.ok(cursorOf(id) >= top, `${id} 커서 ${cursorOf(id)} ≥ 끝 ${top}`);
  assert.equal(sql(`select count(*) from public.msgr_crew_pauses where resumed_at is null`), '0', '열린 기록 0');
  assert.equal(statusOf(C.D1), 'active'); assert.equal(statusOf(C.AV), 'available', '파견 해제는 그대로'); assert.equal(statusOf(C.E1), 'detached');
  assert.equal(asAnon(`select public.msgr_bot_gate('${TOKEN_D}')`), 'ok');
  assert.deepEqual(JSON.parse(sql('select public.msgr_crews_plan_unpause_all()')), { resumed: 0, failed: 0, cursor: top }, '두 번째는 할 일 없음');
});
