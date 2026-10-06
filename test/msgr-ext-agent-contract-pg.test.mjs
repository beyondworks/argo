// 외부 에이전트 크루 계약 1-a(20260929130000) — 봇 토큰으로 자동화(크루 루틴) 미러·편집과 위험 명령 결재 카드를 Argo 크루와
// 같은 계약으로 주고받는다. 설계: _argo-internal-docs/docs/external-agent-contract-phase1-2026-09-29.md(v2).
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

// ── 내부 함수 노출(H1) ──
test('T13 내부 함수는 anon·authenticated가 직접 부를 수 없다', { skip }, () => {
  fails(asAnonRaw(`select public._msgr_crew_routines_apply('${A.crew_id}', 'argo', '[]'::jsonb)`), /permission denied/, 'anon → 내부 apply');
  fails(asUserRaw(U.owner, `select public._msgr_crew_routines_apply('${A.crew_id}', 'hermes', '[]'::jsonb)`), /permission denied/, 'authenticated → 내부 apply');
});

// ── 루틴 미러 ──
test('T1 봇 스냅샷은 source=봇 kind 행으로 생기고, 같은 스냅샷 재전송은 쓰기 0(xmin 불변)', { skip }, () => {
  const r = botSync(A, rows());
  assert.deepEqual([r.kept, r.skipped, r.total], [1, 0, 1]);
  assert.equal(sql(`select source||'|'||owner_user_id||'|'||editable||'|'||(status->>'last_status') from msgr_crew_routines where crew_id='${A.crew_id}'`), `hermes|${U.owner}|true|ok`);
  assert.equal(last(asUser(U.owner, `select count(*) from msgr_crew_routines where crew_id='${A.crew_id}'`)), '1', '소유자(봇을 연결한 관리자)는 본다 — Argo와 같은 규칙');
  assert.equal(last(asUser(U.member, `select count(*) from msgr_crew_routines where crew_id='${A.crew_id}'`)), '0', '다른 조직원은 못 본다');
  const x1 = sql(`select xmin::text from msgr_crew_routines where crew_id='${A.crew_id}'`);
  botSync(A, rows());
  assert.equal(sql(`select xmin::text from msgr_crew_routines where crew_id='${A.crew_id}'`), x1, '유휴 재전송은 행을 다시 쓰지 않는다');
});

test('봇 행의 editable은 명시한 true만 — 생략하면 고칠 수 없고, enabled 문자열 "false"는 true로 오해하지 않는다', { skip }, () => {
  botSync(A, JSON.stringify([{ ext_id: 'j2', title: 't', prompt: 'p', schedule: { type: 'daily', time: '09:00' }, enabled: 'false' }]));
  assert.equal(sql(`select editable||'|'||enabled from msgr_crew_routines where crew_id='${A.crew_id}' and ext_id='j2'`), 'false|true', '문자열은 boolean 아님 → 기본 true');
  fails(asUserRaw(U.owner, `select public.msgr_crew_routine_edit('${routineId(A, 'j2')}','update','{"enabled":false}'::jsonb)`), /msgr_routine_not_editable/, '편집 불가 행');
  botSync(A, rows());
});

test('p_unsupported는 행을 지우지 않고 사유만 남긴다(L6), 정상 스냅샷이 오면 사유를 지운다', { skip }, () => {
  botSync(A, rows());
  asAnon(`select public.msgr_bot_routines_sync('${A.token}', '[]'::jsonb, 'hermes cron API 없음')`);
  assert.equal(sql(`select count(*) from msgr_crew_routines where crew_id='${A.crew_id}'`), '1', '미러 유지');
  assert.equal(sql(`select routines_unsupported from msgr_bots where crew_id='${A.crew_id}'`), 'hermes cron API 없음');
  botSync(A, rows());
  assert.equal(sql(`select coalesce(routines_unsupported,'-') from msgr_bots where crew_id='${A.crew_id}'`), '-');
});

test('H6 hosting·source 일치 — Argo 경로로 봇 크루에 못 쓰고, 봇은 자기 크루에만 쓴다', { skip }, () => {
  fails(asUserRaw(U.owner, `select public.msgr_crew_routines_sync('${ORG}','${A.crew_id}','[]'::jsonb)`), /msgr_routine_forbidden/, 'Argo 경로 → 봇 크루');
  botSync(B, JSON.stringify([{ ext_id: 'b1', title: 'claw job', prompt: 'p', schedule: { type: 'daily', time: '10:00' }, editable: true }]));
  assert.equal(sql(`select source from msgr_crew_routines where crew_id='${B.crew_id}'`), 'openclaw');
  assert.equal(sql(`select count(*) from msgr_crew_routines where crew_id='${A.crew_id}' and ext_id='b1'`), '0', 'B 토큰이 A 크루에 쓰지 않았다');
});

test('T4·T16 소유자 편집 → 봇 이벤트(60초 임대로 중복 없음) → applied로 닫으면 다시 안 온다', { skip }, () => {
  botSync(A, rows());
  const e = j(asUser(U.owner, `select public.msgr_crew_routine_edit('${routineId(A)}','update','{"enabled":false}'::jsonb)`));
  const ev = events(A).filter((x) => x.event === 'routine_edit');
  assert.equal(ev.length, 1); assert.equal(ev[0].edit_id, e.id); assert.equal(ev[0].ext_id, 'j1'); assert.deepEqual(ev[0].patch, { enabled: false });
  assert.equal(events(A).filter((x) => x.event === 'routine_edit').length, 0, '임대 60초 안에는 다시 안 준다');
  expireLeases();
  assert.equal(events(A).filter((x) => x.event === 'routine_edit').length, 1, '임대가 끝나면 닫힐 때까지 다시 준다(유실 없음)');
  assert.equal(last(asAnon(`select public.msgr_bot_routine_edit_done('${A.token}','${e.id}','applied')`)), 't');
  expireLeases();
  assert.equal(events(A).filter((x) => x.event === 'routine_edit').length, 0, '닫힌 편집은 안 온다');
});

test('T18 같은 관리자의 다른 봇·Argo 크루 편집은 받지도 닫지도 못한다', { skip }, () => {
  botSync(A, rows());
  asUser(U.owner, `select public.msgr_crew_routines_sync('${ORG}','${ARGO_CREW}','[{"ext_id":"r1","title":"argo","prompt":"p","schedule":{"type":"daily","time":"08:00"}}]'::jsonb)`);
  const ea = j(asUser(U.owner, `select public.msgr_crew_routine_edit('${routineId(A)}','update','{"title":"A용"}'::jsonb)`));
  const argoRid = sql(`select id from msgr_crew_routines where crew_id='${ARGO_CREW}' and ext_id='r1'`);
  const er = j(asUser(U.owner, `select public.msgr_crew_routine_edit('${argoRid}','update','{"title":"Argo용"}'::jsonb)`));
  expireLeases();
  const got = events(B).filter((x) => x.event === 'routine_edit').map((x) => x.edit_id);
  assert.ok(!got.includes(ea.id) && !got.includes(er.id), 'B는 A·Argo 크루 편집을 받지 않는다');
  fails(asAnonRaw(`select public.msgr_bot_routine_edit_done('${B.token}','${ea.id}','applied')`), /msgr_routine_forbidden/, 'B가 A 편집 닫기');
  fails(asAnonRaw(`select public.msgr_bot_routine_edit_done('${A.token}','${er.id}','applied')`), /msgr_routine_forbidden/, 'A가 Argo 크루 편집 닫기');
  asAnon(`select public.msgr_bot_routine_edit_done('${A.token}','${ea.id}','superseded')`);
});

test('raw 일정은 일정 편집을 거절하고 켜기·끄기는 허용(L4)', { skip }, () => {
  botSync(A, JSON.stringify([{ ext_id: 'raw1', title: 'cron', prompt: 'p', schedule: { type: 'raw', expr: '*/7 1-5 * * 1', display: '*/7 1-5 * * 1' }, editable: true }]));
  const rid = routineId(A, 'raw1');
  fails(asUserRaw(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"schedule":{"type":"daily","time":"09:00"}}'::jsonb)`), /msgr_routine_invalid_patch/, 'raw 일정 변경');
  assert.ok(j(asUser(U.owner, `select public.msgr_crew_routine_edit('${rid}','update','{"enabled":false}'::jsonb)`)).id);
  botSync(A, rows());
});

test('T19 detach 뒤 봇 스냅샷 거절·미러 삭제, 다시 active면 채워진다(M1)', { skip }, () => {
  botSync(A, rows());
  sql(`update msgr_crews set status='detached' where id='${A.crew_id}'`);
  assert.equal(sql(`select count(*) from msgr_crew_routines where crew_id='${A.crew_id}'`), '0', '오프보딩 트리거가 미러를 지운다');
  fails(asAnonRaw(`select public.msgr_bot_routines_sync('${A.token}', '${rows()}'::jsonb)`), /msgr_routine_forbidden/, 'detached 봇 스냅샷');
  sql(`update msgr_crews set status='active' where id='${A.crew_id}'`);
  assert.equal(botSync(A, rows()).total, 1, '재활성 뒤 total로 어댑터가 불일치를 안다');
});

test('Argo 경로 회귀 — 소유자 sync는 그대로 source=argo, 쓰기 0 유지', { skip }, () => {
  const q = `select public.msgr_crew_routines_sync('${ORG}','${ARGO_CREW}','[{"ext_id":"r1","title":"argo","prompt":"p","schedule":{"type":"daily","time":"08:00"},"enabled":"false"}]'::jsonb)`;
  asUser(U.owner, q);
  assert.equal(sql(`select source||'|'||editable||'|'||enabled from msgr_crew_routines where crew_id='${ARGO_CREW}'`), 'argo|true|false', 'Argo는 기존과 같이 enabled 문자열 캐스트');
  const x1 = sql(`select xmin::text from msgr_crew_routines where crew_id='${ARGO_CREW}'`);
  asUser(U.owner, q);
  assert.equal(sql(`select xmin::text from msgr_crew_routines where crew_id='${ARGO_CREW}'`), x1);
  fails(asUserRaw(U.member, q), /msgr_routine_forbidden/, '비소유자');
});

// ── 결재 ──
test('T5·T14 위험 명령 결재 — 행+카드 원자 생성, 등급·kind는 서버가 정하고, 같은 id는 멱등·다르면 충돌', { skip }, () => {
  const src = post(A); const m = claim(A, src); assert.ok(m?.execution_attempt, '실행 선점');
  const r = request(A, m.execution_attempt, 'ap-1', 'rm -rf /tmp/x‮', 'cleanup');
  assert.equal(r.status, 0, r.stderr);
  const out = j(r.stdout);
  assert.equal(out.risk, 'high');
  assert.equal(sql(`select risk||'|'||kind||'|'||(payload->>'shell')||'|'||action||'|'||source_msg_id||'|'||(message_id is not null) from msgr_crew_approvals where id='${out.id}'`),
    `high|action|true|rm -rf /tmp/x|${src}|true`, '양방향 문자 제거, 셸은 action=command');
  assert.equal(sql(`select kind||'|'||reply_to||'|'||client_msg_id from msgr_messages where id=${out.message_id}`), `approval_card|${src}|ap:${A.crew_id}:ap-1`);
  assert.equal(j(request(A, m.execution_attempt, 'ap-1', 'rm -rf /tmp/x').stdout).id, out.id, '같은 요청은 같은 행');
  fails(request(A, m.execution_attempt, 'ap-1', 'rm -rf /'), /msgr_approval_conflict/, '같은 id 다른 명령');
  fails(request(B, m.execution_attempt, 'ap-9'), /msgr_not_allowed/, '다른 봇이 남의 실행 시도로 결재');
  fails(request(A, '00000000-0000-4000-8000-000000000000', 'ap-8'), /msgr_not_allowed/, '실행 중이 아닌 시도');
  const args = sql(`select string_agg(n, ',') from (select unnest(proargnames) n from pg_proc where proname='msgr_bot_request_approval') x`);
  assert.ok(!/risk|kind|source/.test(args), `등급·kind·원문을 인자로 받지 않는다: ${args}`);
});

test('T6·T15 결정 → 이벤트 → 선점 ack는 처음 한 번만 claimed, 결정 권한 없는 사람은 결정 못함', { skip }, () => {
  const src = post(A, 'deploy'); const m = claim(A, src);
  const ap = j(request(A, m.execution_attempt, 'ap-2', 'git push --force').stdout);
  assert.equal(last(asUser(U.member, `with u as (update msgr_crew_approvals set status='approved', decided_by='${U.member}', decided_at=now() where id='${ap.id}' returning 1) select count(*) from u`)), '0', '일반 멤버 결정 불가(RLS)');
  asUser(U.owner, `update msgr_crew_approvals set status='approved', decided_by='${U.owner}', decided_at=now() where id='${ap.id}'`);
  const ev = events(A).find((x) => x.event === 'approval_decided' && x.approval_id === 'ap-2');
  assert.ok(ev, '결정 이벤트'); assert.equal(ev.status, 'approved'); assert.equal(ev.resume, true); assert.equal(ev.source_message_id, Number(src));
  assert.equal(events(A).filter((x) => x.approval_id === 'ap-2').length, 0, '임대 중 재전달 없음');
  expireLeases();
  assert.equal(events(A).filter((x) => x.approval_id === 'ap-2').length, 1, 'ack 전에는 임대가 끝나면 다시 준다(ack 실패해도 유실 없음)');
  assert.equal(j(asAnon(`select public.msgr_bot_ack_approval('${A.token}','ap-2')`)).claimed, true);
  assert.equal(j(asAnon(`select public.msgr_bot_ack_approval('${A.token}','ap-2')`)).claimed, false, '두 번째 ack(다른 어댑터·재시도)는 재개하지 않는다');
  expireLeases();
  assert.equal(events(A).filter((x) => x.approval_id === 'ap-2').length, 0, '선점된 결정은 안 온다');
  fails(asAnonRaw(`select public.msgr_bot_ack_approval('${B.token}','ap-2')`), /msgr_not_allowed/, '다른 봇의 ack');
});

test('사람은 봇 선점 기록(msgr_bot_approval_acks)에 손댈 수 없고, 임대는 결재 행을 다시 쓰지도 방송하지도 않는다(검수 M-2·L-3)', { skip }, () => {
  const src = post(A, 'hide'); const m = claim(A, src);
  const ap = j(request(A, m.execution_attempt, 'ap-h', 'rm x').stdout);
  fails(asUserRaw(U.owner, `select count(*) from msgr_bot_approval_acks`), /permission denied/, '조회');
  fails(asUserRaw(U.owner, `update msgr_bot_approval_acks set acked_at = now() where approval_id = '${ap.id}'`), /permission denied/, '선점 조작');
  asUser(U.owner, `update msgr_crew_approvals set status='approved', decided_by='${U.owner}', decided_at=now() where id='${ap.id}'`);
  const x1 = sql(`select xmin::text from msgr_crew_approvals where id='${ap.id}'`); const b1 = sql(`select count(*) from realtime.sent`);
  events(A); expireLeases(); events(A); expireLeases(); events(A);
  assert.equal(sql(`select xmin::text from msgr_crew_approvals where id='${ap.id}'`), x1, '임대 갱신이 결재 행을 다시 쓰지 않는다');
  assert.equal(sql(`select count(*) from realtime.sent`), b1, '임대 갱신이 방송을 만들지 않는다');
  asAnon(`select public.msgr_bot_ack_approval('${A.token}','ap-h')`);
});

test('L-3 사람이 같은 approval_id로 먼저 넣은 행은 봇 요청이 받아들이지 않는다', { skip }, () => {
  const src = post(A, 'pre'); const m = claim(A, src);
  sql(`insert into msgr_crew_approvals(org_id, channel_id, crew_id, approval_id, action, risk, kind, source_msg_id) values ('${ORG}','${PUB}','${A.crew_id}','ap-pre','rm q','low','action',${src})`);
  fails(request(A, m.execution_attempt, 'ap-pre', 'rm q'), /msgr_approval_conflict/, '저위험 선입력 행');
});

test('H-2 사용자↔봇 1:1 방의 위험 명령 카드도 결재권자(봇 소유자)가 보고 결정한다', { skip }, () => {
  // 사람 멤버와 봇만 있는 1:1 방(소유자 = 관리자는 멤버가 아니다) — 시드는 검수 재현(R2)과 같다
  const dm = last(sql(`insert into msgr_channels(org_id, kind, name, created_by) values ('${ORG}','dm','bot','${U.member}') returning id`));
  sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${dm}','user','${U.member}'),('${dm}','crew','${A.crew_id}') on conflict do nothing`);
  const src = last(asUser(U.member, `insert into public.msgr_messages(channel_id, author_kind, author_user_id, body) values ('${dm}', 'user', '${U.member}', 'clean up') returning id`));
  const m = claim(A, src); assert.ok(m?.execution_attempt, 'DM 실행 선점');
  const ap = j(request(A, m.execution_attempt, 'ap-dm', 'rm -rf /tmp/dm').stdout);
  assert.equal(last(asUser(U.owner, `select count(*) from msgr_crew_approvals where id='${ap.id}'`)), '1', '소유자가 카드를 본다');
  assert.equal(last(asUser(U.owner, `with u as (update msgr_crew_approvals set status='approved', decided_by='${U.owner}', decided_at=now() where id='${ap.id}' returning 1) select count(*) from u`)), '1', '소유자가 결정한다');
  asAnon(`select public.msgr_bot_ack_approval('${A.token}','ap-dm')`);
});

test('L-4·L-5 문구 정리는 Argo 규칙(줄바꿈·양방향 문자 → 공백), 상태는 두 키만 남는다', { skip }, () => {
  const src = post(A, 'clean'); const m = claim(A, src);
  const ap = j(asAnon(`select public.msgr_bot_request_approval('${A.token}', '${m.execution_attempt}', 'ap-cl', E'rm a\\nrm b', E'이유\\n가짜 줄\\u2028끝')`));
  assert.equal(sql(`select action||'|'||reason from msgr_crew_approvals where id='${ap.id}'`), 'rm a rm b|이유 가짜 줄 끝');
  botSync(A, JSON.stringify([{ ext_id: 'st1', title: 't', prompt: 'p', schedule: { type: 'daily', time: '09:00' }, editable: true, status: { last_status: 'ok', junk: 'x'.repeat(5000) } }]));
  assert.equal(sql(`select status::text from msgr_crew_routines where crew_id='${A.crew_id}' and ext_id='st1'`), '{"last_status": "ok"}');
  asAnon(`select public.msgr_bot_expire_approval('${A.token}','ap-cl')`); botSync(A, rows());
});

test('T17 승인 뒤 원문 작성자가 조직에서 빠지거나 AI 동의를 철회하면 resume=false(H5)', { skip }, () => {
  const src = post(A, 'send mail'); const m = claim(A, src);
  const ap = j(request(A, m.execution_attempt, 'ap-3', 'sendmail all').stdout);
  sql(`insert into msgr_ai_consent(user_id, consent_at) values ('${U.member}', null) on conflict (user_id) do update set consent_at = null`);
  asUser(U.owner, `update msgr_crew_approvals set status='approved', decided_by='${U.owner}', decided_at=now() where id='${ap.id}'`);
  const ev = events(A).find((x) => x.approval_id === 'ap-3');
  assert.equal(ev.resume, false); assert.equal(ev.reason, 'ai_consent');
  sql(`delete from msgr_ai_consent where user_id='${U.member}'`);
  asAnon(`select public.msgr_bot_ack_approval('${A.token}','ap-3')`);
  const src2 = post(A, 'send mail 2'); const m2 = claim(A, src2);
  const ap2 = j(request(A, m2.execution_attempt, 'ap-4', 'sendmail all').stdout);
  asUser(U.owner, `update msgr_crew_approvals set status='approved', decided_by='${U.owner}', decided_at=now() where id='${ap2.id}'`);
  sql(`update msgr_org_members set removed_at = now() where org_id='${ORG}' and user_id='${U.member}'`);
  const ev2 = events(A).find((x) => x.approval_id === 'ap-4');
  sql(`update msgr_org_members set removed_at = null where org_id='${ORG}' and user_id='${U.member}'`);
  assert.equal(ev2.resume, false); assert.equal(ev2.reason, 'delivery_not_allowed');
  asAnon(`select public.msgr_bot_ack_approval('${A.token}','ap-4')`);
});

test('만료: 에이전트 쪽 시간 초과는 expired, 이미 결정됐으면 그 상태 / 봇 실행이 끝나면 pending 셸 카드 자동 만료(M6)', { skip }, () => {
  const src = post(A, 'long'); const m = claim(A, src);
  j(request(A, m.execution_attempt, 'ap-5', 'rm y').stdout);
  const e1 = j(asAnon(`select public.msgr_bot_expire_approval('${A.token}','ap-5')`));
  assert.deepEqual([e1.status, e1.expired_now], ['expired', true]);
  assert.equal(j(asAnon(`select public.msgr_bot_expire_approval('${A.token}','ap-5')`)).expired_now, false);
  j(request(A, m.execution_attempt, 'ap-6', 'rm z').stdout);
  asAnon(`select public.msgr_bot_finish('${A.token}', '${PUB}', 'done', ${m.message_id}, '${m.execution_attempt}', 'done', '[]')`);
  assert.equal(sql(`select status from msgr_crew_approvals where crew_id='${A.crew_id}' and approval_id='ap-6'`), 'expired', '실행 완료 뒤 남은 셸 카드는 만료');
});

test('유휴 이벤트 조회는 시간이 지나도 쓰기 0(검수 M-1), 결재 대기 중에만 다시 훑고 실행 심박을 올린다', { skip }, () => {
  for (let k = 0; k < 3; k++) { expireLeases(); events(A); } // 남은 임대를 비우고
  sql(`update msgr_bots set event_scan_at = null where crew_id='${A.crew_id}'`); events(A);
  const x1 = sql(`select xmin::text from msgr_bots where crew_id='${A.crew_id}'`);
  events(A); sql(`select pg_sleep(0)`); events(A);
  assert.equal(sql(`select xmin::text from msgr_bots where crew_id='${A.crew_id}'`), x1, '지문 그대로·대기 없음이면 쓰지 않는다');
  assert.equal(sql(`select coalesce(event_scan_at::text,'-') from msgr_bots where crew_id='${A.crew_id}'`), '-', '60초 재스캔 예약도 없다');
  const src = post(A, 'wait'); const m = claim(A, src);
  j(request(A, m.execution_attempt, 'ap-7', 'rm w').stdout);
  sql(`update msgr_executions set heartbeat_at = now() - interval '5 minutes' where crew_id='${A.crew_id}' and source_msg_id=${src}`);
  events(A);
  assert.equal(sql(`select heartbeat_at > now() - interval '1 minute' from msgr_executions where crew_id='${A.crew_id}' and source_msg_id=${src}`), 't');
  assert.notEqual(sql(`select coalesce(event_scan_at::text,'-') from msgr_bots where crew_id='${A.crew_id}'`), '-', '대기 결재가 있으면 60초 뒤 다시 훑는다');
});

test('D5 — 전달된 글(meta.relay)은 getUpdates에 relayed_by가 실리고, 일반 글에는 없다', { skip }, () => {
  // 전달 글은 서버(msgr_dm_relay 정의자 함수)만 넣는다 — 사람 세션의 RLS insert로는 meta.relay를 실을 수 없다(20261006160000). 시드는 서버 경로(슈퍼유저)로.
  const relayed = last(sql(`insert into public.msgr_messages(channel_id, author_kind, author_user_id, body, mentions, meta) values ('${PUB}', 'user', '${U.member}', 'relay', '[{"kind":"crew","id":"${B.crew_id}"}]', '{"relay":{"role":"to","via_name":"효원 - v"}}') returning id`));
  const plain = post(B, 'plain');
  const ups = JSON.parse(asAnon(`select coalesce(jsonb_agg(x), '[]') from public.msgr_bot_updates('${B.token}') x`)).map((u) => u.message);
  assert.equal(ups.find((x) => x.message_id === Number(relayed))?.relayed_by, '효원 - v');
  assert.equal(ups.find((x) => x.message_id === Number(plain))?.relayed_by, undefined);
});
