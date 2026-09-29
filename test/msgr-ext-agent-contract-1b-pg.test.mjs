// 외부 에이전트 크루 계약 1-b(20260929150000) — 1-a 운영 반영 때 VPS에서 손으로 한 일을 누구나 같은 계약으로 쓰게 시스템으로 옮긴다.
// 유건 2026-09-29 결정: 버전·승인 모드 보고(강제 안 함), '모든 예약 작업 보기'는 소유자 스위치, 보낼 곳 없는 작업은 소유자가 방 지정, 에이전트 결재+후속 보고.
// 하네스는 msgr-bot-handoff-limit-pg와 같다(모든 msgr 마이그레이션 적용, auth.uid() 스텁). 실행: scripts/billing-pg-drill.sh <이 파일>
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222', member: '33333333-3333-4333-8333-333333333333' };

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asAnon = (q) => sql(`set role anon; ${q}`);
const asAnonRaw = (q) => psqlRaw(['-A', '-t', '-c', `set role anon; ${q}`]);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };
const j = (s) => JSON.parse(last(s));

let ORG, PUB, A, B, ARGO_CREW;
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
  sql(`create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;`);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  for (const f of readdirSync(fileURLToPath(new URL('../supabase/migrations/', import.meta.url))).filter((f) => /^\d+_msgr.*\.sql$/.test(f)).sort())
    psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.admin}', 'admin'), ('${ORG}', '${U.member}', 'member')`);
  // 같은 관리자(owner)가 봇 둘과 Argo 크루 하나를 가진다 — H6(소유자 기준 판정이면 서로 닿는다)
  A = JSON.parse(last(asUser(U.owner, `select msgr_bot_create('${ORG}','hermes','pepper','moderator')`)));
  B = JSON.parse(last(asUser(U.owner, `select msgr_bot_create('${ORG}','openclaw','claw','peer')`)));
  ARGO_CREW = last(asUser(U.owner, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'lean', 'mine', 'Mine') returning id`));
  sql(`update msgr_crews set allow='all', last_seen_at=now(), dm_delivery_protocol=1 where org_id='${ORG}'`);
  PUB = last(asUser(U.owner, `select msgr_create_channel('${ORG}','public','ops','[]')`));
  for (const id of [A.crew_id, B.crew_id]) sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${PUB}','crew','${id}') on conflict do nothing`);
  for (const id of [U.admin, U.member]) sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${PUB}','user','${id}') on conflict do nothing`);
});

const rows = (ext = 'j1', extra = {}) => JSON.stringify([{ ext_id: ext, title: '야간 핸드오버', prompt: '오늘 한 일을 정리', schedule: { type: 'daily', time: '00:49', tz: 'Asia/Seoul' },
  enabled: true, editable: true, status: { last_status: 'ok' }, ...extra }]);
const botSync = (bot, r) => j(asAnon(`select public.msgr_bot_routines_sync('${bot.token}', '${r}'::jsonb)`));
const events = (bot) => j(asAnon(`select public.msgr_bot_events('${bot.token}')`));
const routineId = (bot, ext = 'j1') => sql(`select id from msgr_crew_routines where crew_id='${bot.crew_id}' and ext_id='${ext}'`);
const expireLeases = () => sql(`update msgr_crew_routine_edits set bot_leased_at = now() - interval '2 minutes' where bot_leased_at is not null;
  update msgr_bot_approval_acks set leased_at = now() - interval '2 minutes' where leased_at is not null;
  update msgr_bots set event_scan_at = now() - interval '2 minutes' where event_scan_at is not null`);
const post = (bot, text = 'go') => last(asUser(U.member, `insert into public.msgr_messages(channel_id, author_kind, author_user_id, body, mentions) values ('${PUB}', 'user', '${U.member}', '${text}', '[{"kind":"crew","id":"${bot.crew_id}"}]') returning id`));
const claim = (bot, src) => JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${bot.token}') x`)).map((u) => u.message).find((m) => m?.message_id === Number(src));
const request = (bot, attempt, id, cmd = 'rm -rf /tmp/x', reason = 'cleanup') => asAnonRaw(`select public.msgr_bot_request_approval('${bot.token}', '${attempt}', '${id}', '${cmd}', '${reason}')`);


const agentReq = (bot, attempt, id, title = '광고비 50만 원 집행', reason = '이번 주 캠페인') => asAnonRaw(`select public.msgr_bot_request_agent_approval('${bot.token}', '${attempt}', '${id}', '${title}', '${reason}')`);
const report = (bot, v, mode, applied = null) => j(asAnon(`select public.msgr_bot_report_status('${bot.token}', ${v === null ? 'null' : `'${v}'`}, ${mode === null ? 'null' : `'${mode}'`}, ${applied === null ? 'null' : applied})`));
const decide = (id, status = 'approved') => asUser(U.owner, `update msgr_crew_approvals set status='${status}', decided_by='${U.owner}', decided_at=now() where id='${id}'`);
const followup = (bot, id, body = '집행했습니다.') => asAnonRaw(`select public.msgr_bot_followup('${bot.token}', '${id}', '${body}')`);

test('내부 함수는 직접 부를 수 없고, 소유자 스위치는 anon이 못 부른다', { skip }, () => {
  fails(asAnonRaw(`select public._msgr_routine_channel_ok('${A.crew_id}', '${U.owner}', '${PUB}')`), /permission denied/, 'anon → 방 판정');
  fails(asUserRaw(U.owner, `select public._msgr_bot_resume_block('${A.crew_id}', '${ORG}', 1)`), /permission denied/, 'authenticated → 재개 판정');
  fails(asAnonRaw(`select public.msgr_bot_set_mirror_all('${A.bot_id}', true)`), /permission denied/, 'anon → 스위치');
});

// ① 버전·승인 모드 보고 — "설정은 강제하지 않고 실제 상태를 보여 준다"(유건 결정 1·2)
test('보고는 값이 바뀔 때만 쓰고(xmin 불변), 표시 문자열은 짧게 정리한다', { skip }, () => {
  report(A, '0.3.0', 'smart');
  const x1 = sql(`select xmin::text from msgr_bot_state where bot_id='${A.bot_id}'`);
  report(A, '0.3.0', 'smart'); report(A, null, null);
  assert.equal(sql(`select xmin::text from msgr_bot_state where bot_id='${A.bot_id}'`), x1, '같은 보고는 쓰지 않는다');
  report(A, "0.3.1<script>", 'MANUAL\n');
  assert.equal(sql(`select adapter_version||'|'||approval_mode from msgr_bot_state where bot_id='${A.bot_id}'`), '0.3.1script|manual');
  assert.equal(last(asUser(U.admin, `select count(*) from msgr_bot_state where bot_id='${A.bot_id}'`)), '1', '조직 관리자는 카드에서 본다');
  assert.equal(last(asUser(U.member, `select count(*) from msgr_bot_state`)), '0', '일반 멤버는 못 본다');
});

// ② "모든 예약 작업 보기" — 크루 소유자만(D3과 같은 기준, 유건 결정 3)
test('스위치는 봇 크루 소유자만 켜고, 바뀔 때만 이벤트 지문을 올린다. 설정 이벤트는 보고한 어댑터에만 가고 반영을 보고하면 멈춘다', { skip }, () => {
  fails(asUserRaw(U.admin, `select public.msgr_bot_set_mirror_all('${B.bot_id}', true)`), /msgr_routine_forbidden/, '다른 관리자');
  fails(asUserRaw(U.member, `select public.msgr_bot_set_mirror_all('${B.bot_id}', true)`), /msgr_routine_forbidden/, '일반 멤버');
  const s0 = sql(`select event_seq from msgr_bots where id='${B.bot_id}'`);
  asUser(U.owner, `select public.msgr_bot_set_mirror_all('${B.bot_id}', true)`);
  const s1 = sql(`select event_seq from msgr_bots where id='${B.bot_id}'`);
  assert.equal(Number(s1), Number(s0) + 1);
  asUser(U.owner, `select public.msgr_bot_set_mirror_all('${B.bot_id}', true)`);
  assert.equal(sql(`select event_seq from msgr_bots where id='${B.bot_id}'`), s1, '같은 값은 지문을 안 올린다');
  assert.equal(events(B).filter((e) => e.event === 'config').length, 0, '버전 보고 전(예전 어댑터)에는 설정 이벤트 없음 — 60초마다 다시 주는 쓰기를 막는다');
  assert.equal(report(B, '0.3.0', 'manual').mirror_all, true, '보고 응답으로 바로 받는다');
  expireLeases(); sql(`update msgr_bots set event_seq = event_seq + 1 where id='${B.bot_id}'`);
  assert.deepEqual(events(B).filter((e) => e.event === 'config'), [{ event: 'config', mirror_all: true }]);
  report(B, null, null, true);
  expireLeases(); sql(`update msgr_bots set event_seq = event_seq + 1 where id='${B.bot_id}'`);
  assert.equal(events(B).filter((e) => e.event === 'config').length, 0, '반영했으면 안 준다');
});

// ③ 보낼 곳 없는 작업 — 소유자가 메신저에서 방을 고른다(소유자·그 봇의 1:1 방 또는 그 봇이 들어간 채널, 유건 결정 4)
test('delivery 표시는 읽기 전용 행의 none·local만 남는다', { skip }, () => {
  botSync(A, JSON.stringify([
    { ext_id: 'n1', title: '야간 핸드오버', prompt: '정리', schedule: { type: 'daily', time: '00:49' }, enabled: true, editable: false, status: { delivery: 'none' } },
    { ext_id: 'l1', title: '로컬 저장', prompt: '정리', schedule: { type: 'daily', time: '01:00' }, enabled: true, editable: false, status: { delivery: 'local' } },
    { ext_id: 'm1', title: '브리프', prompt: '보고', schedule: { type: 'daily', time: '12:00' }, enabled: true, editable: true, channel_id: PUB, status: { delivery: 'none' } },
    { ext_id: 'x1', title: '이상값', prompt: '보고', schedule: { type: 'daily', time: '12:00' }, enabled: true, editable: false, status: { delivery: 'telegram' } }]));
  assert.equal(sql(`select string_agg(ext_id||'='||coalesce(status->>'delivery','-'), ',' order by ext_id) from msgr_crew_routines where crew_id='${A.crew_id}' and ext_id in ('n1','l1','m1','x1')`),
    'l1=local,m1=-,n1=none,x1=-');
});

test('방 지정: 보낼 곳 없는 작업은 읽기 전용이어도 방만 지정하고, 고를 수 있는 방은 소유자와의 1:1 방·그 봇이 들어간 채널뿐', { skip }, () => {
  const n1 = routineId(A, 'n1'); const l1 = routineId(A, 'l1');
  const dmOwner = last(sql(`insert into msgr_channels(org_id, kind, name, created_by) values ('${ORG}','dm','o','${U.owner}') returning id`));
  sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${dmOwner}','user','${U.owner}'),('${dmOwner}','crew','${A.crew_id}')`);
  const dmOther = last(sql(`insert into msgr_channels(org_id, kind, name, created_by) values ('${ORG}','dm','m','${U.member}') returning id`));
  sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${dmOther}','user','${U.member}'),('${dmOther}','crew','${A.crew_id}')`);
  const noBot = last(asUser(U.owner, `select msgr_create_channel('${ORG}','public','nobot','[]')`));
  const edit = (id, patch) => asUserRaw(U.owner, `select public.msgr_crew_routine_edit('${id}', 'update', '${JSON.stringify(patch)}'::jsonb)`);
  assert.equal(edit(n1, { channel_id: dmOwner }).status, 0, '소유자와 그 봇의 1:1 방');
  assert.equal(edit(n1, { channel_id: PUB }).status, 0, '그 봇이 들어간 채널');
  fails(edit(n1, { channel_id: dmOther }), /msgr_routine_invalid_channel/, '다른 사람과 봇의 1:1 방');
  fails(edit(n1, { channel_id: noBot }), /msgr_routine_invalid_channel/, '봇이 없는 채널');
  fails(edit(n1, { channel_id: PUB, title: 'x' }), /msgr_routine_not_editable/, '읽기 전용 행은 방 지정만');
  fails(edit(l1, { channel_id: PUB }), /msgr_routine_not_editable/, '의도적으로 밖으로 보내는 작업(local)은 방 지정 대상이 아니다');
  // 검수 M-1(재현): status가 없거나 delivery 키가 없는 읽기 전용 행(0.2.0 어댑터·custom 봇)도 막혀야 한다 — NULL 비교로 통과하던 빈틈
  botSync(A, JSON.stringify([...['n1','l1'].map((ext) => JSON.parse(sql(`select json_build_object('ext_id',ext_id,'title',title,'prompt',prompt,'schedule',schedule,'enabled',enabled,'editable',editable,'status',status) from msgr_crew_routines where crew_id='${A.crew_id}' and ext_id='${ext}'`))),
    { ext_id: 'q0', title: '상태 없음', prompt: 'p', schedule: { type: 'daily', time: '02:00' }, enabled: true, editable: false },
    { ext_id: 'q1', title: '이상값', prompt: 'p', schedule: { type: 'daily', time: '03:00' }, enabled: true, editable: false, status: { delivery: 'telegram', last_status: 'ok' } }]));
  fails(edit(routineId(A, 'q0'), { channel_id: PUB }), /msgr_routine_not_editable/, 'status 없음');
  fails(edit(routineId(A, 'q1'), { channel_id: PUB }), /msgr_routine_not_editable/, 'delivery 이상값(서버가 지움)');
  fails(asUserRaw(U.admin, `select public.msgr_crew_routine_edit('${n1}', 'update', '{"channel_id":"${PUB}"}'::jsonb)`), /msgr_routine_forbidden/, '소유자가 아닌 관리자');
  const ev = (expireLeases(), events(A)).filter((e) => e.event === 'routine_edit' && e.ext_id === 'n1');
  assert.equal(ev.length, 1, '앞 편집은 대체되고 마지막 한 건만');
  assert.equal(ev[0].patch.channel_id, PUB);
  asAnon(`select public.msgr_bot_routine_edit_done('${A.token}', '${ev[0].edit_id}', 'applied')`);
});

test('Argo 크루 작업은 방 지정을 받지 않는다(회귀)', { skip }, () => {
  asUser(U.owner, `select public.msgr_crew_routines_sync('${ORG}', '${ARGO_CREW}', '[{"ext_id":"a1","title":"t","prompt":"p","schedule":{"type":"daily","time":"09:00"},"enabled":true}]'::jsonb)`);
  const a1 = sql(`select id from msgr_crew_routines where crew_id='${ARGO_CREW}' and ext_id='a1'`);
  fails(asUserRaw(U.owner, `select public.msgr_crew_routine_edit('${a1}', 'update', '{"channel_id":"${PUB}"}'::jsonb)`), /msgr_routine_invalid_patch/, 'Argo 방 지정');
  assert.equal(asUserRaw(U.owner, `select public.msgr_crew_routine_edit('${a1}', 'update', '{"title":"t2"}'::jsonb)`).status, 0, '기존 편집은 그대로');
});

// ④ 에이전트가 올리는 결재 — 기한 없음(D1), 기본 고위험(D6), 결정 뒤 한 번만 후속 보고(M11·T7)
test('에이전트 결재는 행+카드를 만들고 고위험·agent 표시, 같은 id는 멱등·다르면 충돌, 실행이 끝나도 만료되지 않는다', { skip }, () => {
  const src = post(A, 'budget'); const m = claim(A, src); assert.ok(m?.execution_attempt);
  const out = j(agentReq(A, m.execution_attempt, 'ag-1').stdout);
  assert.equal(sql(`select risk||'|'||kind||'|'||(payload->>'agent')||'|'||coalesce(payload->>'shell','-')||'|'||action from msgr_crew_approvals where id='${out.id}'`),
    'high|action|true|-|광고비 50만 원 집행');
  assert.match(sql(`select body from msgr_messages where id=${out.message_id}`), /결재 요청: 광고비 50만 원 집행/);
  assert.equal(j(agentReq(A, m.execution_attempt, 'ag-1').stdout).id, out.id, '멱등');
  fails(agentReq(A, m.execution_attempt, 'ag-1', '다른 제목'), /msgr_approval_conflict/, '같은 id 다른 제목');
  j(request(A, m.execution_attempt, 'sh-1', 'rm q').stdout);
  fails(agentReq(A, m.execution_attempt, 'sh-1'), /msgr_approval_conflict/, '셸 결재 id를 에이전트 결재로 재사용 못함');
  asAnon(`select public.msgr_bot_finish('${A.token}', '${PUB}', '결재를 올렸습니다.', ${m.message_id}, '${m.execution_attempt}', 'done', '[]')`);
  assert.equal(sql(`select status from msgr_crew_approvals where id='${out.id}'`), 'pending', '에이전트 결재는 실행 완료로 만료되지 않는다(D1)');
  assert.equal(sql(`select status from msgr_crew_approvals where crew_id='${A.crew_id}' and approval_id='sh-1'`), 'expired', '셸 결재는 그대로 만료(회귀)');
  fails(agentReq(A, m.execution_attempt, 'ag-2'), /msgr_not_allowed/, '끝난 실행으로는 새 결재를 못 올린다');
});

test('결정 이벤트에 agent 표시, 후속 보고는 결정 뒤 한 번만 원문 답글로, 결정 전·남의 결재는 거절', { skip }, () => {
  const ap = sql(`select id from msgr_crew_approvals where crew_id='${A.crew_id}' and approval_id='ag-1'`);
  fails(followup(A, 'ag-1'), /msgr_not_allowed/, '결정 전');
  decide(ap);
  const ev = (expireLeases(), events(A)).find((e) => e.approval_id === 'ag-1');
  assert.deepEqual([ev.agent, ev.shell, ev.resume, ev.action], [true, false, true, '광고비 50만 원 집행']);
  assert.equal(j(asAnon(`select public.msgr_bot_ack_approval('${A.token}','ag-1')`)).claimed, true);
  const f1 = last(followup(A, 'ag-1').stdout); const f2 = last(followup(A, 'ag-1', '두 번째').stdout);
  assert.equal(f1, f2, '두 번째 후속 보고는 같은 글');
  const src = sql(`select source_msg_id from msgr_crew_approvals where id='${ap}'`);
  assert.equal(sql(`select reply_to||'|'||author_kind||'|'||body||'|'||(meta->>'approval_followup') from msgr_messages where id=${f1}`), `${src}|crew|집행했습니다.|${ap}`);
  fails(followup(B, 'ag-1'), /msgr_not_allowed/, '다른 봇');
});

test('반려도 후속 보고 가능, 원문 작성자가 AI 동의를 철회하면 후속 보고도 거절(H5·L-7)', { skip }, () => {
  const src = post(A, 'budget 2'); const m = claim(A, src);
  const ap = j(agentReq(A, m.execution_attempt, 'ag-3', '예산 증액').stdout);
  decide(ap.id, 'rejected');
  assert.equal(followup(A, 'ag-3', '반려되어 진행하지 않습니다.').status, 0);
  const src2 = post(A, 'budget 3'); const m2 = claim(A, src2);
  const ap2 = j(agentReq(A, m2.execution_attempt, 'ag-4', '예산 증액 2').stdout);
  decide(ap2.id);
  sql(`insert into msgr_ai_consent(user_id, consent_at) values ('${U.member}', null) on conflict (user_id) do update set consent_at = null`);
  const ev = (expireLeases(), events(A)).find((e) => e.approval_id === 'ag-4');
  fails(followup(A, 'ag-4'), /msgr_not_allowed/, '동의 철회 뒤 후속 보고');
  sql(`delete from msgr_ai_consent where user_id='${U.member}'`);
  assert.deepEqual([ev.resume, ev.reason], [false, 'ai_consent']);
  asAnon(`select public.msgr_bot_ack_approval('${A.token}','ag-3'); select public.msgr_bot_ack_approval('${A.token}','ag-4')`);
});

test('기한 없는 에이전트 결재가 오래 대기해도 유휴 이벤트 조회는 쓰기 0(재스캔은 셸 결재 대기 때만)', { skip }, () => {
  const src = post(B, 'long wait'); const m = claim(B, src);
  j(agentReq(B, m.execution_attempt, 'ag-idle').stdout);
  asAnon(`select public.msgr_bot_finish('${B.token}', '${PUB}', '올렸습니다.', ${m.message_id}, '${m.execution_attempt}', 'done', '[]')`);
  for (let k = 0; k < 3; k++) { expireLeases(); events(B); }
  sql(`update msgr_bots set event_scan_at = null where id='${B.bot_id}'`); events(B);
  const x1 = sql(`select xmin::text from msgr_bots where id='${B.bot_id}'`);
  events(B); events(B);
  assert.equal(sql(`select xmin::text from msgr_bots where id='${B.bot_id}'`), x1, '대기 중인 에이전트 결재만 있으면 쓰지 않는다');
});

// 검수 M-3 — 재개된 턴(실행 행 없음)에서도 위험 명령·새 결재 카드를 올린다: 승인된 부모 결재의 같은 원문에 붙인다
const okj = (r) => { assert.equal(r.status, 0, r.stderr); return j(r.stdout); };
const followReq = (bot, parent, id, kind = 'shell', text = 'rm -rf /tmp/ads') => asAnonRaw(`select public.msgr_bot_request_followup_approval('${bot.token}', '${parent}', '${id}', '${kind}', '${text}', null)`);
test('이어서 올리는 결재 — 승인된 부모의 원문에 셸·에이전트 카드, 반려·후속 보고 뒤·남의 봇·24시간 지난 부모는 거절, 멱등', { skip }, () => {
  const src = post(A, 'ads cleanup'); const m = claim(A, src);
  const parent = j(agentReq(A, m.execution_attempt, 'pa-1', '광고 데이터 정리').stdout);
  asAnon(`select public.msgr_bot_finish('${A.token}', '${PUB}', '올렸습니다.', ${m.message_id}, '${m.execution_attempt}', 'done', '[]')`);
  fails(followReq(A, 'pa-1', 'fs-0'), /msgr_not_allowed/, '결정 전 부모');
  decide(parent.id);
  const sh = okj(followReq(A, 'pa-1', 'fs-1'));
  assert.equal(sql(`select source_msg_id||'|'||(payload->>'shell')||'|'||(payload->>'followup_of')||'|'||risk from msgr_crew_approvals where id='${sh.id}'`), `${src}|true|${parent.id}|high`);
  assert.equal(j(followReq(A, 'pa-1', 'fs-1').stdout).id, sh.id, '멱등');
  fails(followReq(A, 'pa-1', 'fs-1', 'agent'), /msgr_approval_conflict/, '같은 id 다른 종류');
  const ag = j(followReq(A, 'pa-1', 'fa-1', 'agent', '결과 메일 발송').stdout);
  assert.equal(sql(`select (payload->>'agent')||'|'||action from msgr_crew_approvals where id='${ag.id}'`), 'true|결과 메일 발송');
  fails(followReq(B, 'pa-1', 'fs-9'), /msgr_not_allowed/, '다른 봇');
  assert.equal(followup(A, 'pa-1', '정리했습니다.').status, 0);
  fails(followReq(A, 'pa-1', 'fs-2'), /msgr_not_allowed/, '후속 보고를 올린 뒤에는 이어서 못 올린다');
  const src2 = post(A, 'old'); const m2 = claim(A, src2);
  const old = j(agentReq(A, m2.execution_attempt, 'pa-old', '옛 결재').stdout); decide(old.id);
  sql(`update msgr_crew_approvals set decided_at = now() - interval '2 days' where id='${old.id}'`);
  fails(followReq(A, 'pa-old', 'fs-3'), /msgr_not_allowed/, '24시간 지난 부모');
  sql(`update msgr_crew_approvals set decided_at = now() - interval '8 days' where id='${old.id}'`);
  fails(followup(A, 'pa-old'), /msgr_not_allowed/, '7일 지난 결정에는 후속 보고도 안 붙는다');
  // 가드에 더한 예외는 "승인된 부모·같은 원문·24시간"일 때만 — followup_of만 적어서는 끝난 실행의 원문에 결재를 못 붙인다
  const rawIns = (payload, source) => psqlRaw(['-A', '-t', '-c', `insert into msgr_crew_approvals(org_id, channel_id, crew_id, approval_id, action, risk, kind, payload, source_msg_id) values ('${ORG}','${PUB}','${A.crew_id}','g-${Math.random().toString(36).slice(2)}','x','high','action','${JSON.stringify(payload)}'::jsonb,${source})`]);
  const rej = sql(`select id from msgr_crew_approvals where crew_id='${A.crew_id}' and approval_id='ag-3'`);
  const rejSrc = sql(`select source_msg_id from msgr_crew_approvals where id='${rej}'`);
  const oldSrc = sql(`select source_msg_id from msgr_crew_approvals where id='${old.id}'`);
  sql(`update msgr_executions set state='completed' where crew_id='${A.crew_id}' and source_msg_id in (${rejSrc}, ${oldSrc})`); // 실행이 끝난 원문 — 기존 조건으로는 막혀야 한다
  fails(rawIns({ followup_of: rej }, rejSrc), /msgr_approval_source_forbidden/, '반려된 부모');
  fails(rawIns({ followup_of: parent.id }, rejSrc), /msgr_approval_source_forbidden/, '다른 원문');
  fails(rawIns({ followup_of: old.id }, oldSrc), /msgr_approval_source_forbidden/, '오래된 부모');
  fails(rawIns({ followup_of: 'not-a-uuid' }, src), /msgr_approval_source_forbidden/, '형식이 틀린 부모');
  assert.equal(rawIns({ followup_of: parent.id }, src).status, 0, '승인된 부모·같은 원문이면 끝난 실행이어도 받는다(재개 턴)');
  asAnon(`select public.msgr_bot_ack_approval('${A.token}','pa-1'); select public.msgr_bot_ack_approval('${A.token}','pa-old')`);
});

test('재개 턴에서 올린 셸 카드는 실행 행이 없어 오래 pending이어도 유휴 이벤트 조회 쓰기 0', { skip }, () => {
  for (let k = 0; k < 3; k++) { expireLeases(); events(A); }
  sql(`update msgr_bots set event_scan_at = null where id='${A.bot_id}'`); events(A);
  assert.equal(sql(`select count(*) from msgr_crew_approvals where crew_id='${A.crew_id}' and approval_id='fs-1' and status='pending'`), '1', '앞 테스트의 셸 카드가 대기 중');
  const x1 = sql(`select xmin::text from msgr_bots where id='${A.bot_id}'`);
  events(A); events(A);
  assert.equal(sql(`select xmin::text from msgr_bots where id='${A.bot_id}'`), x1);
});
