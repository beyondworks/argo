// 개인 공간 결재(PR-A, 계획 rc-0195/personal-crew-room-features-plan.md 5-2) — 주인과 자기 에이전트만 있는 crew 1:1 방에서만
// org_id 없는 결재 행을 넣고 확정한다. 넣는 길은 정의자 RPC msgr_create_personal_approval 하나(PR-C 본체가 부른다)이고, 표 직접 넣기(RLS)는
// 배포본 그대로 org 없는 행을 거절한다 — 옛 본체(0.1.97)의 D28 셸 결재 직접 넣기가 배포본과 같은 오류를 받아야 한다(1차 재검수 MEDIUM).
// 친구 1:1·개인 그룹·남의 crew 방은 RPC·정의자 함수 넣기(트리거)·확정 모두 거절한다.
// 경우 표(계획 9절) 4·6·9·10·17(D28 칸) + "확정권자 집합 = msgr_can_decide"(개인 칸 포함) + 조직 경로 인접 핀(넣기·확정·감사 그대로).
// 실행: bash scripts/billing-pg-drill.sh test/msgr-personal-crew-approvals-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-personal-crew-approvals-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
// a = crew 1:1 주인, b = a의 친구, c = 아무 관계 없는 사람, d = 조직 관리자(조직 대조군)
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444' };
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q, extra = []) => psqlRaw([...extra, '-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 240)}`); };
const post = (uid, ch, body, mentions = '[]') => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', '${mentions}'::jsonb, gen_random_uuid()::text) returning id`));
const personalCrew = (uid, slug) => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${uid}', 'ws-${uid.slice(0, 4)}', '${slug}', '${slug}', 'local', 'active', 'owner') returning id`));
const befriend = (x, y) => { asUser(x, `select public.msgr_friend_request('${y}')`); asUser(y, `select public.msgr_friend_decide('${x}', true)`); };
const join = (uid, ch, crew) => last(asUser(uid, `select public.msgr_crew_join('${ch}', '${crew}')`));
const seedExec = (crew, source) => sql(`insert into public.msgr_executions (crew_id, source_msg_id, attempt, state) values ('${crew}', ${source}, gen_random_uuid(), 'running') on conflict (crew_id, source_msg_id) do update set state = 'running'`);
const lit = (v) => (v == null ? 'null' : `'${v}'`);
// 본체(msgr.mjs msgrPush)가 표에 바로 넣는 열과 같은 모양 — org_id·channel_id·crew_id·approval_id·action·reason·risk(+kind·payload)·source_msg_id.
// 조직 결재와 옛 본체(0.1.97)의 D28 셸 결재가 이 길을 쓴다.
const insertAp = (uid, { org = null, ch, crew, id, risk = 'low', kind = 'action', payload = null, src = null }, extra = []) =>
  asUserRaw(uid, `insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, reason, risk, kind, payload, source_msg_id)
    values (${lit(org)}, '${ch}', '${crew}', '${id}', '메일 보내기', '사유', '${risk}', '${kind}', ${payload ? `'${payload}'::jsonb` : 'null'}, ${src ?? 'null'}) returning id`, extra);
// 개인 결재의 유일한 넣기 길 — 본체(PR-C)가 같은 행 객체를 p_row로 넘긴다(결과 {id}는 insertApproval과 같은 모양)
const rpcRow = ({ ch, crew, id, risk = 'low', kind, payload, src = null, ...rest }) => ({ org_id: null, channel_id: ch, crew_id: crew, approval_id: id, action: '메일 보내기', reason: '사유', risk,
  ...(kind ? { kind } : {}), ...(payload !== undefined ? { payload } : {}), source_msg_id: src, ...rest });
const rpcAp = (uid, row) => asUserRaw(uid, `select public.msgr_create_personal_approval('${JSON.stringify(row)}'::jsonb)->>'id'`);
const canDecide = (uid, ap) => last(asUser(uid, `select coalesce(public.msgr_can_decide('${ap}'), false)`));
const decide = (uid, ap, st = 'approved', by = uid) => asUserRaw(uid, `update public.msgr_crew_approvals set status = '${st}', decided_by = '${by}', decided_at = now() where id = '${ap}' returning status`);
const status = (ap) => sql(`select status from public.msgr_crew_approvals where id = '${ap}'`);
const auditCount = () => Number(sql(`select count(*) from public.msgr_audit_log`));
const inDeciders = (ap, u) => sql(`select exists (select 1 from public.msgr_approval_deciders('${ap}') d where d = '${u}')`);
const own = (uid, ch, crew) => last(asUser(uid, `select public.msgr_is_own_crew_room('${ch}', '${crew}')`));
// 테스트용 직접 행(서비스 문맥 = 트리거는 그대로 돈다). 개인 결재 행은 a의 정상 흐름(RPC)으로 만든다(아래 ownAp).
let ORG, ORG_PUB, ORG_CREW, A1, A2, A3, B1, CH_A1, CH_A3, CH_B1, AB, G;
let seq = 0;
const ownAp = (risk = 'high', ch = CH_A1, crew = A1) => {
  const m = post(U.a, ch, `일 ${++seq}`); seedExec(crew, m);
  const r = rpcAp(U.a, rpcRow({ ch, crew, id: `ap-own-${seq}`, risk, src: m }));
  assert.equal(r.status, 0, `crew 1:1 주인의 개인 결재 넣기가 거절됨: ${r.stderr.trim().slice(0, 240)}`);
  return { ap: last(r.stdout), src: m, id: `ap-own-${seq}` };
};
// 방 모양 바꾸기(서비스 문맥 SQL) — [적용, 되돌리기]. 판정 조건 한 줄씩을 각각 깨는 모양이다.
const memberRow = (ch, kind, id) => sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', '${kind}', '${id}', '${U.a}') on conflict do nothing`);
const dropMember = (ch, kind, id) => sql(`delete from public.msgr_channel_members where channel_id = '${ch}' and member_kind = '${kind}' and member_id = '${id}'`);
const members = (ch) => sql(`select string_agg(member_kind || ':' || member_id, ',' order by member_kind, member_id) from public.msgr_channel_members where channel_id = '${ch}'`);
const shapesOf = (ch, crew, other) => ({
  secondHuman: [() => memberRow(ch, 'user', U.b), () => dropMember(ch, 'user', U.b)], // 사람 수 조건
  secondCrew: [() => assert.equal(join(U.a, ch, other), 'joined'), () => dropMember(ch, 'crew', other)], // 에이전트 수 조건(msgr_crew_join = 실제 경로)
  notPair: [() => { dropMember(ch, 'crew', crew); memberRow(ch, 'crew', other); }, () => { dropMember(ch, 'crew', other); memberRow(ch, 'crew', crew); }], // 짝 크루가 빠지고 내 다른 크루 하나 — msgr_crew_in_channel 조건(1차 재검수 LOW)
  // 사람 1명이지만 주인이 아님 — 주인 참여 조건(1차 재검수 LOW). 주인 참여 행을 지우면 msgr_crews_follow_owner_out이 주인의 크루 행도 지우므로
  // 크루 행을 다시 넣는다(사람 1·크루 1·짝 크루 참여 = 주인 조건 하나만 깨진 모양)
  ownerSwapped: [() => { memberRow(ch, 'user', U.b); dropMember(ch, 'user', U.a); memberRow(ch, 'crew', crew); }, () => { dropMember(ch, 'user', U.b); memberRow(ch, 'user', U.a); memberRow(ch, 'crew', crew); }],
  archived: [() => sql(`update public.msgr_channels set archived_at = now() where id = '${ch}'`), () => sql(`update public.msgr_channels set archived_at = null where id = '${ch}'`)],
  crewDetached: [() => sql(`update public.msgr_crews set status = 'detached' where id = '${crew}'`), () => sql(`update public.msgr_crews set status = 'active' where id = '${crew}'`)],
});

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
    create table if not exists realtime.sent (id bigint generated always as identity primary key, payload jsonb, event text, topic text, private boolean);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
      language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema if not exists net; create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  for (const f of [...base, ...readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  sql(`delete from public.msgr_settings where key = 'free_limits_grace_until'`);
  // 조직 대조군 — d가 만든 조직에 a가 멤버, a의 조직 크루
  ORG = last(asUser(U.d, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.d}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  const code = last(asUser(U.d, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.d}') returning code`));
  asUser(U.a, `select public.msgr_accept_invite('${code}')`);
  ORG_PUB = last(asUser(U.d, `select public.msgr_create_channel('${ORG}','public','General')`));
  ORG_CREW = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.a}', 'ws-1111', 'orgcrew', 'OrgCrew', 'local', 'active', 'owner') returning id`));
  // 개인 크루와 방
  [A1, A2, A3] = ['a1', 'a2', 'a3'].map((s) => personalCrew(U.a, s));
  B1 = personalCrew(U.b, 'b1');
  CH_A1 = last(asUser(U.a, `select public.msgr_dm_personal_crew('${A1}')`));
  CH_A3 = last(asUser(U.a, `select public.msgr_dm_personal_crew('${A3}')`));
  CH_B1 = last(asUser(U.b, `select public.msgr_dm_personal_crew('${B1}')`));
  befriend(U.a, U.b); befriend(U.a, U.c);
  AB = last(asUser(U.a, `select public.msgr_dm_personal('${U.b}')`));
  assert.equal(join(U.a, AB, A1), 'joined', '친구 1:1에 a의 크루');
  G = last(asUser(U.a, `select public.msgr_dm_personal_group(array['${U.b}','${U.c}']::uuid[])`));
  assert.equal(join(U.a, G, A2), 'joined', '개인 그룹에 a의 크루');
});

// 경우 17의 D28 칸(1차 재검수 MEDIUM) — 옛 본체(0.1.97)는 crew 1:1의 고위험 셸 결재를 실행 중 문맥(org NULL)으로 표에 바로 넣는다
// (chat.mjs:1425가 messengerOrigin 오류를 삼켜 gateMsgr = {} → permission-gate가 목적지 없이 결재 → msgr.mjs:1825 activeCtx → insertApproval).
// 배포본에서 이 넣기는 RLS 오류(42501)로 실패하고, 옛 본체는 결재를 로컬에 남겨 승인 뒤 같은 명령을 한 번 실행한다.
// 이 PR이 넣기를 받아 주면 카드만 생기고 승인 뒤 이어 실행이 'org 불일치'로 실패한다(배포본보다 나쁜 칸). 그래서 오류 문구·SQLSTATE까지 배포본과 같아야 한다.
// 이 테스트는 origin/main(새 마이그레이션 없음)에서도 그대로 통과해야 한다 — 같은 스크립트를 양쪽에 실행해 비교한다.
test('경우 17(D28) — 옛 본체의 표 직접 넣기(crew 1:1 주인·org NULL·실행 중 원문)는 배포본과 같은 RLS 오류(42501)로 거절, 행 0', { skip }, () => {
  for (const risk of ['high', 'low']) {
    const m = post(U.a, CH_A1, `rm -rf ./old ${risk}`); seedExec(A1, m);
    const r = insertAp(U.a, { ch: CH_A1, crew: A1, id: `ap-d28-${risk}`, risk, src: m }, ['-v', 'VERBOSITY=verbose']);
    assert.notEqual(r.status, 0, `${risk}: 옛 본체의 org 없는 직접 넣기가 들어갔다(배포본은 거절)`);
    assert.match(r.stderr, /ERROR:\s+42501: new row violates row-level security policy for table "msgr_crew_approvals"/, `${risk}: 배포본과 같은 오류 — 실제: ${r.stderr.trim().slice(0, 240)}`);
  }
  assert.equal(sql(`select count(*) from public.msgr_crew_approvals where approval_id like 'ap-d28-%'`), '0', '행 0');
});

test('판정 함수 — 공개용은 호출자 본인의 crew 1:1만 참, 내부 함수는 아무도 못 부른다', { skip }, () => {
  assert.equal(own(U.a, CH_A1, A1), 't', '내 crew 1:1');
  assert.equal(own(U.b, CH_A1, A1), 'f', '남의 방을 넣으면 false');
  assert.equal(own(U.c, CH_A1, A1), 'f', '관계 없는 사람');
  assert.equal(own(U.a, CH_B1, B1), 'f', '친구의 crew 1:1');
  assert.equal(own(U.a, CH_A1, A3), 'f', '방과 다른 내 크루');
  assert.equal(own(U.a, AB, A1), 'f', '친구 1:1');
  assert.equal(own(U.a, G, A2), 'f', '개인 그룹');
  assert.equal(own(U.a, ORG_PUB, ORG_CREW), 'f', '조직 채널');
  fails(psqlRaw(['-A', '-t', '-c', `set role anon; select public.msgr_is_own_crew_room('${CH_A1}', '${A1}')`]), /permission denied/, 'anon 실행');
  fails(asUserRaw(U.a, `select public._msgr_own_crew_room('${CH_A1}', '${A1}')`), /permission denied/, '내부 함수(auth를 안 봄)는 authenticated도 못 부른다');
  fails(psqlRaw(['-A', '-t', '-c', `set role anon; select public._msgr_own_crew_room('${CH_A1}', '${A1}')`]), /permission denied/, '내부 함수 anon');
});

test('개인 결재 넣기 RPC — 주인의 crew 1:1만, 열은 고정(org NULL·pending·확정 열 없음), 모르는 키·org_id·anon은 거절', { skip }, () => {
  const m = post(U.a, CH_A1, 'RPC 모양'); seedExec(A1, m);
  fails(psqlRaw(['-A', '-t', '-c', `set role anon; select public.msgr_create_personal_approval('${JSON.stringify(rpcRow({ ch: CH_A1, crew: A1, id: 'ap-rpc-anon', src: m }))}'::jsonb)`]), /permission denied/, 'anon 실행');
  fails(rpcAp(U.b, rpcRow({ ch: CH_A1, crew: A1, id: 'ap-rpc-friend', src: m })), /msgr_not_allowed/, '주인 아닌 사람이 남의 crew 1:1에');
  fails(rpcAp(U.a, rpcRow({ ch: CH_A1, crew: A1, id: 'ap-rpc-org', src: m, org_id: ORG })), /msgr_approval_invalid/, 'org_id를 채워 조직 결재로 위장');
  for (const [k, v] of [['status', 'approved'], ['decided_by', U.a], ['decided_at', '2026-10-08T00:00:00Z'], ['message_id', 1], ['dm_source_msg_id', m]]) {
    fails(rpcAp(U.a, rpcRow({ ch: CH_A1, crew: A1, id: `ap-rpc-${k}`, src: m, [k]: v })), /msgr_approval_invalid/, `모르는 키 ${k}`);
  }
  fails(asUserRaw(U.a, `select public.msgr_create_personal_approval('[1]'::jsonb)`), /msgr_approval_invalid/, '객체가 아닌 인자');
  fails(rpcAp(U.a, rpcRow({ ch: CH_A1, crew: A1, id: 'ap-rpc-nosrc', src: post(U.a, CH_A1, '실행 없는 원문') })), /msgr_approval_source_forbidden/, '실행 중이 아닌 원문(출처 가드는 그대로)');
  const r = rpcAp(U.a, rpcRow({ ch: CH_A1, crew: A1, id: 'ap-rpc-ok', risk: 'high', src: m, payload: null }));
  assert.equal(r.status, 0, r.stderr);
  const ap = last(r.stdout);
  assert.equal(sql(`select concat_ws('|', coalesce(org_id::text, 'NULL'), status, risk, kind, coalesce(payload::text, 'NULL'), coalesce(decided_by::text, 'NULL'), coalesce(message_id::text, 'NULL'), (source_msg_id = ${m})::text)
    from public.msgr_crew_approvals where id = '${ap}'`), 'NULL|pending|high|action|NULL|NULL|NULL|true', '행 모양(JSON null payload는 SQL NULL)');
  fails(rpcAp(U.a, rpcRow({ ch: CH_A1, crew: A1, id: 'ap-rpc-ok', risk: 'high', src: m })), /msgr_crew_approvals_crew_id_approval_id_key|duplicate key/, '같은 결재 id 재시도 — 표 직접 넣기와 같은 고유 제약');
  assert.equal(sql(`select count(*) from public.msgr_crew_approvals where approval_id like 'ap-rpc-%'`), '1', '성공 1건만');
});

test('경우 4 — crew 1:1 주인: 본체 흐름(RPC 넣기 → 카드 → 카드 연결 → 판정 → 확정)이 감사 쓰기 없이 성공, 방송은 u:주인에게만', { skip }, () => {
  for (const [risk, st] of [['high', 'approved'], ['low', 'rejected']]) {
    const { ap, src, id } = ownAp(risk);
    assert.equal(sql(`select coalesce(org_id::text, 'NULL') from public.msgr_crew_approvals where id = '${ap}'`), 'NULL', '개인 결재 행은 org 없음');
    const card = last(asUser(U.a, `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, reply_to, client_msg_id, body, mentions)
      values ('${CH_A1}', 'crew', '${A1}', 'approval_card', ${src}, 'ap:${A1}:${id}', '결재 요청', '[{"kind":"approval","id":"${ap}"}]'::jsonb) returning id`));
    assert.equal(last(asUser(U.a, `update public.msgr_crew_approvals set message_id = ${card} where id = '${ap}' returning id`)), ap, '카드 연결(pending 유지 갱신)');
    assert.equal(canDecide(U.a, ap), 't', `${risk} — 위험 등급과 무관하게 주인이 결정`);
    const before = auditCount();
    sql('delete from realtime.sent');
    const r = decide(U.a, ap, st);
    assert.equal(r.status, 0, `${risk} 확정 실패: ${r.stderr.trim().slice(0, 240)}`);
    assert.equal(last(r.stdout), st, `${risk} 확정`);
    assert.equal(auditCount(), before, '개인 결재 확정은 감사 행을 쓰지 않는다(감사 표 org_id NOT NULL)');
    assert.equal(sql(`select (decided_by = '${U.a}')::text || '/' || (decided_at is not null)::text from public.msgr_crew_approvals where id = '${ap}'`), 'true/true', '기록은 결재 행의 decided_by·decided_at');
    assert.equal(sql(`select coalesce(string_agg(distinct topic, ',' order by topic), '') from realtime.sent where event = 'approval' and payload->>'id' = '${ap}'`), `u:${U.a}`, '방송은 u:주인뿐');
  }
});

test('경우 6 — 개인 결재는 org_doc 불가(check 제약), 조직 org_doc은 그대로', { skip }, () => {
  const m = post(U.a, CH_A1, '문서 고쳐줘'); seedExec(A1, m);
  fails(rpcAp(U.a, rpcRow({ ch: CH_A1, crew: A1, id: 'ap-doc-personal', kind: 'org_doc', payload: { path: 'x.md', title: 't', body: 'b' }, src: m })), /msgr_crew_approvals_personal_no_org_doc/, '개인 org_doc');
  assert.equal(sql(`select count(*) from public.msgr_crew_approvals where approval_id = 'ap-doc-personal'`), '0', 'DB 행 0');
  const r = insertAp(U.a, { org: ORG, ch: ORG_PUB, crew: ORG_CREW, id: 'ap-doc-org', kind: 'org_doc', payload: '{"path":"x.md","title":"t","body":"b"}' });
  assert.equal(r.status, 0, `조직 org_doc 대조: ${r.stderr.trim().slice(0, 240)}`);
});

test('경우 9 — 친구 1:1·개인 그룹·남의 crew 방·방과 다른 크루·조직 크루: RPC 넣기와 표 직접 넣기 모두 거절', { skip }, () => {
  const tries = [
    ['친구 1:1(내 크루)', U.a, { ch: AB, crew: A1 }],
    ['개인 그룹(내 크루)', U.a, { ch: G, crew: A2 }],
    ['친구의 crew 1:1에 친구 크루', U.a, { ch: CH_B1, crew: B1 }],
    ['내 crew 1:1에 친구 크루(친구 명의)', U.b, { ch: CH_A1, crew: B1 }],
    ['내 crew 1:1에 짝이 아닌 내 크루', U.a, { ch: CH_A1, crew: A3 }],
    ['친구가 내 crew 1:1에 내 크루', U.b, { ch: CH_A1, crew: A1 }],
    ['조직 크루를 org 없이 내 crew 1:1에', U.a, { ch: CH_A1, crew: ORG_CREW }],
  ];
  for (const [label, uid, row] of tries) {
    fails(rpcAp(uid, rpcRow({ ...row, id: `ap-rls-rpc-${label}` })), /msgr_not_allowed/, `RPC: ${label}`);
    fails(insertAp(uid, { ...row, id: `ap-rls-${label}` }), /msgr_not_allowed|row-level security/, `직접: ${label}`);
  }
  // 겹 하나 떼기 — 넣기 트리거를 꺼도 RPC의 판정과 정책이 따로 막는다(겹마다 각각 선다)
  sql(`alter table public.msgr_crew_approvals disable trigger msgr_personal_approval_gate`);
  try {
    for (const [label, uid, row] of tries) {
      fails(rpcAp(uid, rpcRow({ ...row, id: `ap-rls2-rpc-${label}` })), /msgr_not_allowed/, `트리거 없이 RPC: ${label}`);
      fails(insertAp(uid, { ...row, id: `ap-rls2-${label}` }), /row-level security/, `트리거 없이 정책만: ${label}`);
    }
    assert.ok(ownAp('low').ap, '대조: RPC는 내 crew 1:1을 통과시킨다');
  } finally { sql(`alter table public.msgr_crew_approvals enable trigger msgr_personal_approval_gate`); }
  // 개인 크루로 조직 행을 위장하지 못한다(기존 갈래 그대로)
  fails(insertAp(U.a, { org: ORG, ch: CH_A1, crew: A1, id: 'ap-rls-orgmask' }), /row-level security|msgr_approval_source_forbidden/, '개인 크루에 조직 org_id');
  assert.equal(sql(`select count(*) from public.msgr_crew_approvals where approval_id like 'ap-rls%'`), '0');
});

test('경우 9 — 방 모양이 바뀌면 넣기 거절: 사람 둘·에이전트 둘·짝 아닌 크루 하나·주인 아닌 사람 하나·보관·크루 비활성', { skip }, () => {
  for (const [label, [apply, undo]] of Object.entries(shapesOf(CH_A3, A3, A2))) {
    const m = post(U.a, CH_A3, `모양 ${label}`); seedExec(A3, m); // 원문은 모양을 바꾸기 전에 올린다(주인이 빠진 모양에서는 글을 못 쓴다)
    apply();
    try {
      if (label === 'notPair') assert.equal(members(CH_A3), `crew:${A2},user:${U.a}`, '짝 아닌 크루 하나 + 주인(조건 하나만 깨진 모양)');
      if (label === 'ownerSwapped') assert.equal(members(CH_A3), `crew:${A3},user:${U.b}`, '짝 크루 + 주인 아닌 사람 하나(조건 하나만 깨진 모양)');
      assert.equal(own(U.a, CH_A3, A3), 'f', `${label}: 판정`);
      fails(rpcAp(U.a, rpcRow({ ch: CH_A3, crew: A3, id: `ap-shape-${label}`, src: m })), /msgr_not_allowed/, `${label}: RPC`);
      // 정의자 함수(서비스 문맥, RLS 없음)도 넣기 트리거에서 걸린다 — RPC의 판정과 따로 선 겹
      fails(psqlRaw(['-A', '-t', '-c', `select public._msgr_bot_approval_card(gen_random_uuid(), '${A3}', null, ${m}, 'ap-shape-def-${label}', true, '보내기', '사유')`]), /msgr_not_allowed|msgr_approval_source_forbidden/, `${label}: 정의자 함수`);
    } finally { undo(); }
  }
  assert.equal(sql(`select count(*) from public.msgr_crew_approvals where approval_id like 'ap-shape-%'`), '0');
  assert.ok(ownAp('low', CH_A3, A3).ap, '대조: 원래 모양으로 돌리면 된다');
});

test('경우 9 — 사람 1·내 크루 1이어도 crew 1:1이 아니면 거절: 친구가 나간 친구 1:1, 다른 사람이 다 나간 개인 그룹', { skip }, () => {
  // msgr_leave_dm은 나간 사람의 참여 행을 지우고, 개인 방에서는 크루 행을 남긴다(c.org_id = channel.org_id가 NULL 비교) — 실제로 닿는 모양
  const AC = last(asUser(U.a, `select public.msgr_dm_personal('${U.c}')`));
  assert.equal(join(U.a, AC, A3), 'joined');
  asUser(U.c, `select public.msgr_leave_dm('${AC}')`);
  // 개인 그룹 G(a·b·c + A2) — 같은 구성원으로 그룹을 다시 만들면 G가 돌아오므로 G에서 b·c가 나간다(뒤 테스트의 G 거절 단언은 그대로 성립)
  asUser(U.b, `select public.msgr_leave_dm('${G}')`); asUser(U.c, `select public.msgr_leave_dm('${G}')`);
  for (const [label, ch, crew, slug] of [['친구가 나간 친구 1:1', AC, A3, 'a3'], ['혼자 남은 개인 그룹', G, A2, 'a2']]) {
    assert.equal(sql(`select count(*) filter (where member_kind = 'user') || '/' || count(*) filter (where member_kind = 'crew') from public.msgr_channel_members where channel_id = '${ch}'`), '1/1', `${label}: 사람 1·크루 1`);
    assert.equal(own(U.a, ch, crew), 'f', `${label}: 판정`);
    const m = post(U.a, ch, `@${slug} ${label}`, `[{"kind":"crew","id":"${crew}","role":"to"}]`); seedExec(crew, m);
    fails(rpcAp(U.a, rpcRow({ ch, crew, id: `ap-left-rpc-${label}`, src: m })), /msgr_not_allowed/, `${label}: RPC 넣기`);
    fails(insertAp(U.a, { ch, crew, id: `ap-left-${label}`, src: m }), /msgr_not_allowed|row-level security/, `${label}: 표 직접 넣기`);
    fails(psqlRaw(['-A', '-t', '-c', `select public._msgr_bot_approval_card(gen_random_uuid(), '${crew}', null, ${m}, 'ap-left-def-${label}', true, '보내기', '사유')`]), /msgr_not_allowed/, `${label}: 정의자 함수`);
  }
  assert.equal(sql(`select count(*) from public.msgr_crew_approvals where approval_id like 'ap-left-%'`), '0');
});

test('경우 9 — 정의자 함수 경로(RLS를 거치지 않음)도 친구 방·남의 crew 방이면 트리거가 거절', { skip }, () => {
  // msgr_create_thread_approval — 크루의 org(NULL)를 그대로 넣는다. 친구 1:1에서 주인이 부른 내 크루의 실행.
  const m = post(U.a, AB, '@a1 보내줘', `[{"kind":"crew","id":"${A1}","role":"to"}]`); seedExec(A1, m);
  const ws = sql(`select ws_id from public.msgr_crews where id = '${A1}'`);
  const thread = (uid, ch, crew, src, id) => asUserRaw(uid, `select public.msgr_create_thread_approval('${ws}', '${crew}', ${src}, '${ch}', '{"approval_id":"${id}","action":"보내기","risk":"high"}'::jsonb, '결재 요청')`);
  fails(thread(U.a, AB, A1, m, 'ap-def-friend'), /msgr_not_allowed/, 'msgr_create_thread_approval 친구 1:1');
  // _msgr_bot_approval_card — 인자 p_org를 넣는다(서비스 문맥에서 직접). 친구 1:1 원문 / 남의 crew 방 원문
  const card = (crew, src, id) => psqlRaw(['-A', '-t', '-c', `select public._msgr_bot_approval_card(gen_random_uuid(), '${crew}', null, ${src}, '${id}', true, '보내기', '사유')`]);
  fails(card(A1, m, 'ap-def-bot-friend'), /msgr_not_allowed/, '_msgr_bot_approval_card 친구 1:1');
  const mb = post(U.a, CH_A1, '남의 크루 실행 위장'); seedExec(B1, mb);
  fails(card(B1, mb, 'ap-def-bot-other'), /msgr_not_allowed/, '_msgr_bot_approval_card 남의 crew 방');
  const gm = post(U.a, G, '@a2 그룹', `[{"kind":"crew","id":"${A2}","role":"to"}]`); seedExec(A2, gm);
  fails(card(A2, gm, 'ap-def-bot-group'), /msgr_not_allowed/, '_msgr_bot_approval_card 개인 그룹');
  assert.equal(sql(`select count(*) from public.msgr_crew_approvals where approval_id like 'ap-def-%'`), '0', '행 0');
  // 대조: 같은 정의자 함수라도 내 crew 1:1이면 들어간다(트리거가 막는 것은 방 모양뿐). 옛 본체는 이 함수를 위임(delegated) 문맥에서만 부르는데,
  // 서버가 주는 delegated는 '크루가 그 방에 없음'이라 crew 1:1에서는 거짓이다(msgr_crew_context) — 옛 본체가 이 갈래로 개인 행을 만들지 않는다.
  const own1 = post(U.a, CH_A1, '1:1 위임 결재'); seedExec(A1, own1);
  const r = thread(U.a, CH_A1, A1, own1, 'ap-def-own');
  assert.equal(r.status, 0, `내 crew 1:1의 정의자 경로: ${r.stderr.trim().slice(0, 240)}`);
  assert.equal(sql(`select coalesce(org_id::text, 'NULL') from public.msgr_crew_approvals where approval_id = 'ap-def-own'`), 'NULL');
});

test('경우 10 — 주인 아닌 사람의 개인 결재 확정은 0행, 방 모양이 바뀌면 주인도 못 한다', { skip }, () => {
  const { ap } = ownAp('high');
  for (const [who, uid] of [['친구', U.b], ['관계 없는 사람', U.c], ['조직 관리자', U.d]]) {
    assert.equal(canDecide(uid, ap), 'f', `${who} 판정`);
    const r = decide(uid, ap);
    assert.equal(r.status, 0, r.stderr); assert.equal(last(r.stdout), '', `${who} 확정 0행`);
    assert.equal(last(asUser(uid, `update public.msgr_crew_approvals set message_id = null where id = '${ap}' returning id`)), '', `${who} pending 갱신 0행`);
  }
  assert.notEqual(decide(U.a, ap, 'approved', U.b).status, 0, '주인이 남의 명의로 확정 — with check 위반');
  assert.equal(status(ap), 'pending');
  // 확정 시점에 방이 더 이상 crew 1:1이 아니면 주인도 못 한다(DB 결정 겹) — 모양마다
  for (const [label, [apply, undo]] of Object.entries(shapesOf(CH_A1, A1, A3))) {
    apply();
    try {
      assert.equal(canDecide(U.a, ap), 'f', `${label}: 주인 판정`);
      const r = decide(U.a, ap);
      assert.equal(r.status, 0, r.stderr); assert.equal(last(r.stdout), '', `${label}: 주인 확정 0행`);
      assert.equal(canDecide(U.b, ap), 'f', `${label}: 친구 판정`);
      assert.equal(last(decide(U.b, ap).stdout), '', `${label}: 친구 확정 0행`);
    } finally { undo(); }
  }
  assert.equal(status(ap), 'pending');
  assert.equal(last(decide(U.a, ap).stdout), 'approved', '대조: 원래 모양이면 주인이 확정');
});

test('확정권자 집합 = msgr_can_decide — 개인 칸(방 모양 × 위험 × 사람)과 조직 칸', { skip }, () => {
  const people = { a: U.a, b: U.b, c: U.c, d: U.d };
  const mismatch = []; let cells = 0, yes = 0;
  const check = (label, ap) => { for (const [who, u] of Object.entries(people)) {
    const dd = inDeciders(ap, u), cc = canDecide(u, ap); cells++; if (cc === 't') yes++;
    if (dd !== cc) mismatch.push(`${label}/${who}: deciders=${dd} can_decide=${cc}`);
  } };
  const states = { intact: [() => {}, () => {}], ...shapesOf(CH_A1, A1, A3) };
  for (const risk of ['low', 'high']) {
    const { ap } = ownAp(risk);
    for (const [st, [apply, undo]] of Object.entries(states)) { apply(); try { check(`personal/${st}/${risk}`, ap); } finally { undo(); } }
  }
  // 조직 칸 — 관리자 모드(기본): low = 크루 주인(a), high = 조직 관리자(d)
  for (const risk of ['low', 'high']) {
    const r = insertAp(U.a, { org: ORG, ch: ORG_PUB, crew: ORG_CREW, id: `ap-org-cell-${risk}`, risk });
    assert.equal(r.status, 0, r.stderr);
    check(`org/${risk}`, last(r.stdout));
  }
  console.log(`# deciders cells=${cells} can_decide=true ${yes}`);
  assert.deepEqual(mismatch, [], '확정권자 집합과 판정이 어긋난다');
  assert.ok(yes > 0 && yes < cells, '양쪽 값이 모두 나오는 표여야 대조가 의미 있다');
  assert.equal(yes, 4, '참 칸 = 개인 intact low·high의 주인 + 조직 low 주인 + 조직 high 관리자');
});

test('인접 핀 — 조직 결재: 넣기·확정·감사·방송은 그대로', { skip }, () => {
  const r = insertAp(U.a, { org: ORG, ch: ORG_PUB, crew: ORG_CREW, id: 'ap-org-pin' });
  assert.equal(r.status, 0, r.stderr);
  const ap = last(r.stdout);
  assert.equal(canDecide(U.a, ap), 't', 'low = 크루 주인');
  const before = Number(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'approval.approved' and target_id = 'ap-org-pin'`));
  sql('delete from realtime.sent');
  assert.equal(last(decide(U.a, ap).stdout), 'approved');
  assert.equal(Number(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'approval.approved' and target_id = 'ap-org-pin'`)), before + 1, '조직 결재 확정은 감사를 남긴다');
  assert.equal(sql(`select count(*) from realtime.sent where event = 'approval' and payload->>'id' = '${ap}' and topic = 'org:${ORG}'`), '1', '공개 채널 결재는 org: 토픽');
  // 조직 크루는 org_id를 비워 넣을 수 없다(개인 갈래는 크루 org NULL만)
  fails(insertAp(U.a, { ch: ORG_PUB, crew: ORG_CREW, id: 'ap-org-null' }), /msgr_not_allowed|row-level security|null value/, '조직 채널에 org 없는 결재');
  // 조직 관리자도 high 조직 결재는 그대로 확정(대조)
  const h = last(insertAp(U.a, { org: ORG, ch: ORG_PUB, crew: ORG_CREW, id: 'ap-org-pin-h', risk: 'high' }).stdout);
  assert.equal(canDecide(U.a, h), 'f', 'high는 크루 주인 아님(관리자 모드)');
  assert.equal(last(decide(U.d, h).stdout), 'approved', '관리자 확정');
});
