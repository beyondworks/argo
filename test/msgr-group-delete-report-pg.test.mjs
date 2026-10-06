// 메신저 결정 두 가지(유건 승인 2026-10-06, 20261006170000_msgr_group_delete_report.sql) — 같은 파일 안에서 수정 전(#846까지) → 수정 뒤를 잰다.
//   1) 조직 그룹 대화(kind='dm', 조직 안, 사람 3명 이상)는 만든 사람(지금 참여 중)과 조직 관리자(owner·admin, 참여 중)만 지운다. 나머지는 나가기만.
//      1:1 DM·사람 둘 + 에이전트·개인 1:1·개인 그룹·공개/비공개 채널의 삭제 규칙과 이름 바꾸기·보관 권한은 그대로.
//   2) 신고 제외는 진짜 시스템 글(author_kind='system')만 — 에이전트 명의 글은 kind와 상관없이 신고된다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-group-delete-report-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-group-delete-report-pg.test.mjs';
const FIX = '20261006170000_msgr_group_delete_report.sql';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = {
  a: '11111111-1111-4111-8111-111111111111', // 조직 owner
  k: '22222222-2222-4222-8222-222222222222', // 조직 admin
  b: '33333333-3333-4333-8333-333333333333', // member — 그룹 대화를 만든다
  c: '44444444-4444-4444-8444-444444444444', // member — 일반 참여자
  d: '55555555-5555-4555-8555-555555555555', // member — 일반 참여자
  g: '66666666-6666-4666-8666-666666666666', // guest — 그룹 대화 참여자
};
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim(); // 슈퍼유저 — 시드·관찰 전용
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asUser = (uid, q) => { const r = asUserRaw(uid, q); if (r.status !== 0) throw new Error(`psql 실패(${uid.slice(0, 2)}): ${r.stderr}`); return r.stdout.trim(); };
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const ok = (raw) => raw.status === 0;
const applyMig = (f) => psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);

let ORG, CREW_B, CREW_A;
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
  assert.ok(files.includes('20261006160000_msgr_security_fixes.sql'), '#846 마이그레이션 위에 쌓인다');
  for (const f of files.filter((x) => x < FIX)) applyMig(f); // 수정 직전(#846 포함)까지 — 실제 적용 순서대로
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 20 where org_id = '${ORG}'`);
  for (const [u, role] of [[U.k, 'admin'], [U.b, 'member'], [U.c, 'member'], [U.d, 'member']]) {
    const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.a}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.g}', 'guest')`); // 게스트 시드는 슈퍼유저(msgr-pg-integration과 같은 방식)
  CREW_B = last(asUser(U.b, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.b}', 'ws-b', 'b-agent', '비서') returning id`));
  CREW_A = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.a}', 'ws-a', 'a-agent', '공지봇') returning id`));
  // 개인 공간: b는 c·d와 친구(개인 1:1·개인 그룹)
  for (const u of [U.c, U.d]) assert.equal(last(asUser(U.b, `select public.msgr_friend_request('${u}')`)), 'friend'); // 같은 조직 동료는 요청 없이 친구(msgr_friend_request)
});

const people = (list) => `'${JSON.stringify(list.map((id) => ({ kind: 'user', id })))}'::jsonb`;
// 조직 대화 — msgr_create_channel(앱 createGroupDm과 같은 경로). 만든 사람은 자동으로 참여한다
const orgDm = (creator, others, extra = []) => last(asUser(creator, `select public.msgr_create_channel('${ORG}', 'dm', 'dm:t', '${JSON.stringify([...others.map((id) => ({ kind: 'user', id })), ...extra])}'::jsonb)`));
const channel = (creator, kind, others = []) => last(asUser(creator, `select public.msgr_create_channel('${ORG}', '${kind}', '${kind}-' || gen_random_uuid()::text, ${people(others)})`));
const memberRowOf = (ch, uid) => sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${uid}'`);
const exists = (ch) => sql(`select count(*) from public.msgr_channels where id = '${ch}'`) === '1';
const msgCount = (ch) => Number(sql(`select count(*) from public.msgr_messages where channel_id = '${ch}'`));
const post = (uid, ch) => asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, client_msg_id) values ('${ch}', 'user', '${uid}', '기록', gen_random_uuid()::text)`);
// 앱 deleteChannel과 같은 길 — PostgREST delete(RLS). 지워졌으면 true. 실패하면 행이 남는지까지 본다
function del(uid, ch) {
  const r = asUserRaw(uid, `with d as (delete from public.msgr_channels where id = '${ch}' returning 1) select count(*) from d`);
  if (r.status !== 0) throw new Error(`삭제 질의 실패: ${r.stderr}`);
  const gone = last(r.stdout) === '1';
  assert.equal(exists(ch), !gone, '삭제 결과와 행 존재가 맞아야 한다');
  return gone;
}

// 결정 1 — 칸마다 새 방(지워지면 다음 칸이 쓸 수 없다)
function observeDelete() {
  const o = {};
  const grp = () => { const ch = orgDm(U.b, [U.c, U.d, U.g, U.a]); post(U.b, ch); post(U.c, ch); return ch; }; // b가 만든 그룹: b·c·d·g(게스트)·a(owner)
  { const ch = grp(); o.grpMemberDel = del(U.c, ch); o.grpMemberDelLostMsgs = o.grpMemberDel && msgCount(ch) === 0; }
  { const ch = grp(); o.grpGuestDel = del(U.g, ch); }
  { const ch = grp(); o.grpCreatorDel = del(U.b, ch); }
  { const ch = grp(); o.grpOwnerInRoomDel = del(U.a, ch); }
  { const ch = orgDm(U.b, [U.c, U.d, U.k]); o.grpAdminInRoomDel = del(U.k, ch); }
  { const ch = grp(); o.grpAdminOutsideDel = del(U.k, ch); } // 조직 admin이지만 방 밖 — 종전에도 못 지웠다(관리 판정 dm 갈래)
  { // 만든 사람이 나간 뒤 — 칸마다 새 방(앞 칸이 지우면 뒤 칸이 빈 방을 보게 된다)
    const leftGrp = () => { const ch = grp(); assert.equal(last(asUser(U.b, `select public.msgr_leave_dm('${ch}')`)), 't'); return ch; };
    o.grpLeftCreatorDel = del(U.b, leftGrp());
    o.grpAfterCreatorLeftMemberDel = del(U.c, leftGrp());
    o.grpAfterCreatorLeftOwnerDel = del(U.a, leftGrp());
  }
  { // 채널 관리자(admin_user_ids)로 지정된 일반 참여자 — 결정: 만든 사람과 조직 관리자만
    const ch = grp(); sql(`update public.msgr_channels set admin_user_ids = array['${U.c}']::uuid[] where id = '${ch}'`);
    o.grpChAdminDel = del(U.c, ch);
  }
  { // 나가기는 누구나 그대로
    const ch = grp(); o.grpMemberLeave = last(asUser(U.d, `select public.msgr_leave_dm('${ch}')`)) === 't'; o.grpMemberLeaveKeepsRoom = exists(ch) && msgCount(ch) >= 2;
  }
  { // 이름 바꾸기·보관은 이번 결정 밖 — 참여자 누구나 그대로
    const ch = grp();
    o.grpMemberRename = last(asUser(U.c, `with u as (update public.msgr_channels set name = 'dm:새 이름' where id = '${ch}' returning 1) select count(*) from u`)) === '1';
    o.grpMemberArchive = last(asUser(U.c, `with u as (update public.msgr_channels set archived_at = now() where id = '${ch}' returning 1) select count(*) from u`)) === '1';
  }
  { // 그룹이 사람 둘로 줄면 1:1 규칙
    const ch = orgDm(U.b, [U.c, U.d]); asUser(U.d, `select public.msgr_leave_dm('${ch}')`);
    o.shrunkToTwoMemberDel = del(U.c, ch);
  }
  // 같은 결과의 다른 길(자동 검토 표시 반박) — 남의 참여 행 지우기, 만든 사람 바꾸기, 관리자 강등·만료
  const kick = (actor, ch, uid) => { const r = asUserRaw(actor, `with d as (delete from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${uid}' returning 1) select count(*) from d`); if (r.status !== 0) throw new Error(r.stderr); return last(r.stdout) === '1'; };
  { const ch = grp(); o.grpMemberKicksOther = kick(U.c, ch, U.d); }
  { // 일반 참여자가 남을 다 빼고 사람 둘만 남긴 뒤 1:1 규칙으로 지우기
    const ch = grp(); for (const x of [U.d, U.g, U.a]) kick(U.c, ch, x);
    o.grpBypassByKick = del(U.c, ch);
  }
  { const ch = grp(); o.grpCreatorKicksOther = kick(U.b, ch, U.d); }
  // 옆 길 — 참여 행 고치기(update): 남의 행을 방 밖 사람(k)으로 바꿔 빼내기
  const swap = (actor, ch, from, to) => { const r = asUserRaw(actor, `with u as (update public.msgr_channel_members set member_id = '${to}', added_by = '${actor}' where channel_id = '${ch}' and member_kind = 'user' and member_id = '${from}' returning 1) select count(*) from u`); return r.status === 0 && last(r.stdout) === '1'; };
  { const ch = grp(); o.grpMemberSwapsOther = swap(U.c, ch, U.d, U.k); o.grpMemberSwapRemovedD = memberRowOf(ch, U.d) === '0'; }
  { const ch = grp(); o.grpCreatorSwapsOther = swap(U.b, ch, U.d, U.k); }
  { const ch = channel(U.b, 'private', [U.c, U.d]); o.privCreatorSwaps = swap(U.b, ch, U.d, U.k); o.privMemberSwaps = swap(U.c, ch, U.d, U.k); }
  { const ch = grp(); o.grpOwnerKicksOther = kick(U.a, ch, U.d); }
  { const ch = grp(); o.grpSelfRowLeave = kick(U.d, ch, U.d); } // 자기 행 지우기(나가기)는 누구나
  { const ch = orgDm(U.b, [U.c]); o.dmKickOther = kick(U.c, ch, U.b); } // 1:1 — 종전대로(지우는 것과 같은 권한)
  { const ch = channel(U.b, 'private', [U.c, U.d]); o.privCreatorKicks = kick(U.b, ch, U.c); o.privMemberKicks = kick(U.d, ch, U.c); }
  { // 만든 사람·종류·조직은 바꿀 수 없다(msgr_lock_channels) — 판정에 쓰는 열
    const ch = grp();
    o.grpForgeCreator = asUserRaw(U.c, `update public.msgr_channels set created_by = '${U.c}' where id = '${ch}'`).stderr;
    o.grpForgeKind = asUserRaw(U.c, `update public.msgr_channels set kind = 'private' where id = '${ch}'`).stderr;
  }
  { // 조직 관리자 판정은 지금 역할 — 강등된 관리자, 기한이 지난 관리자는 못 지운다(칸마다 새 방)
    const ch = orgDm(U.b, [U.c, U.d, U.k]);
    sql(`update public.msgr_org_members set role = 'member' where org_id = '${ORG}' and user_id = '${U.k}'`);
    try { o.grpDemotedAdminDel = del(U.k, ch); } finally { sql(`update public.msgr_org_members set role = 'admin' where org_id = '${ORG}' and user_id = '${U.k}'`); }
    const ch2 = orgDm(U.b, [U.c, U.d, U.k]);
    sql(`update public.msgr_org_members set expires_at = now() - interval '1 minute' where org_id = '${ORG}' and user_id = '${U.k}'`);
    try { o.grpExpiredAdminDel = del(U.k, ch2); } finally { sql(`update public.msgr_org_members set expires_at = null where org_id = '${ORG}' and user_id = '${U.k}'`); }
  }
  // 1:1 DM — 두 사람 누구나
  { const ch = orgDm(U.b, [U.c]); o.dmOtherDel = del(U.c, ch); }
  { const ch = orgDm(U.b, [U.c]); o.dmCreatorDel = del(U.b, ch); }
  // 사람 둘 + 에이전트 — 두 사람의 대화(에이전트는 세지 않는다)
  { const ch = orgDm(U.b, [U.c], [{ kind: 'crew', id: CREW_B }]); assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}'`), '3'); o.dmWithAgentOtherDel = del(U.c, ch); }
  // 공개·비공개 채널 — 종전 규칙(만든 사람·채널 관리자·조직 관리자)
  { const ch = channel(U.b, 'public'); asUser(U.c, `select public.msgr_join_channel('${ch}')`); o.pubMemberDel = del(U.c, ch); o.pubCreatorDel = del(U.b, ch); }
  { const ch = channel(U.b, 'public'); o.pubOrgAdminOutsideDel = del(U.k, ch); }
  { const ch = channel(U.b, 'private', [U.c, U.d]); o.privMemberDel = del(U.d, ch); o.privCreatorDel = del(U.b, ch); }
  { const ch = channel(U.b, 'private', [U.c, U.d]); sql(`update public.msgr_channels set admin_user_ids = array['${U.c}']::uuid[] where id = '${ch}'`); o.privChAdminDel = del(U.c, ch); }
  { const ch = channel(U.b, 'private', [U.c, U.d]); o.privOrgAdminOutsideDel = del(U.k, ch); } // 방 밖 조직 관리자 — 비공개 채널 행이 안 보여(select 정책) 삭제 대상이 없다(종전과 같음)
  // 개인 공간 — 1:1은 두 사람, 그룹은 만든 사람만(20260917190000)
  { const ch = last(asUser(U.b, `select public.msgr_dm_personal('${U.c}')`)); o.personalPairOtherDel = del(U.c, ch); }
  { const ch = last(asUser(U.b, `select public.msgr_dm_personal_group(array['${U.c}','${U.d}']::uuid[], null)`)); o.personalGroupMemberDel = del(U.c, ch); o.personalGroupCreatorDel = del(U.b, ch); }
  return o;
}

// 결정 2 — 신고 대상(신고자 a = 조직 owner, 공개 채널)
function observeReport() {
  const o = {};
  const ch = channel(U.b, 'public'); asUser(U.a, `select public.msgr_join_channel('${ch}')`);
  for (const cr of [CREW_B, CREW_A]) sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${cr}', '${U.b}')`);
  const root = last(asUser(U.b, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, mentions, client_msg_id) values ('${ch}', 'user', '${U.b}', '부탁', '[{"kind":"crew","id":"${CREW_B}"}]'::jsonb, gen_random_uuid()::text) returning id`));
  // 에이전트 명의 글 — 사람 세션(b)이 자기 에이전트 명의로 넣는 RLS 경로(#846 정책 그대로 허용)
  const crewMsg = (kind, body) => last(asUser(U.b, `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, reply_to, thread_root, client_msg_id) values ('${ch}', 'crew', '${CREW_B}', '${kind}', '${body}', ${root}, ${root}, gen_random_uuid()::text) returning id`));
  const report = (uid, mid) => asUserRaw(uid, `select public.msgr_report_message(${mid}, '사칭')`);
  const M = {
    userText: root,
    crewText: crewMsg('text', '답'),
    crewSystem: crewMsg('system', '관리자 공지: 재로그인 링크'),
    crewApproval: crewMsg('approval_card', '결재'),
    realSystem: sql(`insert into public.msgr_messages (channel_id, author_kind, kind, body, client_msg_id) values ('${ch}', 'system', 'system', '입장', gen_random_uuid()::text) returning id`).split('\n').pop(),
    userSystem: sql(`insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${ch}', 'user', '${U.b}', 'system', '위조 안내', gen_random_uuid()::text) returning id`).split('\n').pop(), // #846 전에 들어갔을 수 있는 글
  };
  for (const [k, mid] of Object.entries(M)) { const r = report(U.a, mid); o[k] = ok(r); o[`${k}Err`] = r.stderr; }
  o.ownCrewSystem = ok(report(U.b, M.crewSystem)); // 에이전트 주인 본인도 신고할 수 있다(사람 글만 자기 글 거절 — 종전 규칙)
  o.ownUserText = report(U.b, M.userText).stderr; // 자기 사람 글은 msgr_report_own
  o.outsiderCrewSystem = report(U.g, M.crewSystem).stderr; // 공개 채널을 못 읽는 게스트 — 없는 글과 같은 오류
  // 신고 처리 쪽: 관리자 신고함·처리 RPC가 에이전트 system 글 신고를 받는다
  if (o.crewSystem) {
    o.listRow = last(asUser(U.a, `select message_body || '|' || coalesce(author_user_id::text, 'null') || '|' || status from public.msgr_reports_list() where message_id = ${M.crewSystem}`));
    o.crewIdSaved = sql(`select author_crew_id from public.msgr_reports where message_id = ${M.crewSystem} and reporter_user_id = '${U.a}'`);
    const rid = sql(`select id from public.msgr_reports where message_id = ${M.crewSystem} and reporter_user_id = '${U.a}'`);
    o.resolve = ok(asUserRaw(U.a, `select public.msgr_report_resolve('${rid}')`)) && sql(`select status from public.msgr_reports where id = '${rid}'`) === 'resolved';
  }
  return o;
}

// #846 재검수 — 에이전트 답 저장(msgr_execution_finish)이 p_reply.meta의 전달 표지를 그대로 저장하던 길. 공개·비공개 채널, 주인 b의 에이전트
function observeExecutionMeta() {
  const o = {};
  for (const kind of ['public', 'private']) {
    const ch = channel(U.b, kind, kind === 'private' ? [U.c] : []);
    sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${CREW_B}', '${U.b}') on conflict do nothing`);
    const src = last(asUser(U.b, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, mentions, client_msg_id) values ('${ch}', 'user', '${U.b}', '정리해 줘', '[{"kind":"crew","id":"${CREW_B}"}]'::jsonb, gen_random_uuid()::text) returning id`));
    const attempt = sql('select gen_random_uuid()');
    const claim = JSON.parse(last(asUser(U.b, `select public.msgr_execution_claim('ws-b', '${CREW_B}', ${src}, '${ch}', '${attempt}')`)));
    assert.equal(claim.acquired, true, `${kind} 실행권`);
    const reply = { channel_id: ch, author_kind: 'crew', crew_id: CREW_B, kind: 'text', client_msg_id: `reply:${CREW_B}:${src}`, reply_to: Number(src), thread_root: Number(src), body: '정리했습니다', mentions: [],
      meta: { hop: 1, origin: U.b, disposition: 'done', relay: { via_crew_id: CREW_B, via_name: '관리자' }, relay_to: ['x'], relay_capped: true, relay_cycle: true, relay_chain_id: 'c1' } };
    const done = JSON.parse(last(asUser(U.b, `select public.msgr_execution_finish('ws-b', '${CREW_B}', ${src}, '${ch}', '${attempt}', '${JSON.stringify(reply)}')`)));
    o[kind] = JSON.parse(sql(`select meta from public.msgr_messages where id = ${done.id}`));
  }
  return o;
}
const RELAY_KEYS = ['relay', 'relay_to', 'relay_capped', 'relay_cycle', 'relay_chain_id'];

// 결정 3 — 채널에서 남이 내보낸 사람은 제외 목록에 올라 재사용 초대로 다시 들어오지 못한다(공개 채널과 같게). 스스로 나간 사람은 다시 들어온다
function observeKick() {
  const o = {};
  const excluded = (ch, uid) => sql(`select (('${uid}')::uuid = any (excluded_user_ids))::text from public.msgr_channels where id = '${ch}'`) === 'true';
  const readable = (uid, ch) => last(asUser(uid, `select public.msgr_can_read_channel('${ch}')`)) === 't';
  const delRow = (actor, ch, uid) => asUser(actor, `delete from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${uid}'`);
  const addRow = (actor, ch, uid) => asUser(actor, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'user', '${uid}', '${actor}')`);
  const unexclude = (actor, ch, uid) => asUser(actor, `update public.msgr_channels set excluded_user_ids = array_remove(excluded_user_ids, '${uid}'::uuid) where id = '${ch}'`);
  const reusable = (chs) => last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by, channel_ids, max_uses) values ('${ORG}', 'member', '${U.a}', array[${chs.map((x) => `'${x}'`).join(',')}]::uuid[], null) returning code`));
  const accept = (uid, code) => asUser(uid, `select public.msgr_accept_invite('${code}')`);
  { // 비공개: 방장 b가 c를 내보냄(앱 removeMember와 같은 참여 행 삭제) → 조직 owner의 재사용 초대 수락
    const ch = channel(U.b, 'private', [U.c, U.d]);
    delRow(U.b, ch, U.c); o.privKickExcluded = excluded(ch, U.c);
    accept(U.c, reusable([ch])); o.privKickedRejoinsByInvite = memberRowOf(ch, U.c) === '1';
  }
  { // 비공개: 스스로 나감 → 제외 아님, 재사용 초대로 다시 들어온다
    const ch = channel(U.b, 'private', [U.c, U.d]);
    delRow(U.d, ch, U.d); o.privLeaveExcluded = excluded(ch, U.d);
    accept(U.d, reusable([ch])); o.privLeaverRejoinsByInvite = memberRowOf(ch, U.d) === '1';
  }
  // 되돌리기·참여 행만 다시 넣기 — 공개 채널(앱 excludeMember: 제외 목록 + 행 삭제)과 비공개 채널을 같은 순서로
  for (const kind of ['public', 'private']) {
    const kick = (ch) => { if (kind === 'public') asUser(U.b, `update public.msgr_channels set excluded_user_ids = array_append(excluded_user_ids, '${U.c}'::uuid) where id = '${ch}'`); delRow(U.b, ch, U.c); };
    const mk = () => { const ch = channel(U.b, kind, kind === 'private' ? [U.c] : []); if (kind === 'public') asUser(U.c, `select public.msgr_join_channel('${ch}')`); return ch; };
    { const ch = mk(); kick(ch); addRow(U.b, ch, U.c); unexclude(U.b, ch, U.c); // 앱 restoreMember
      o[`${kind}Restore`] = [excluded(ch, U.c), readable(U.c, ch), (accept(U.c, reusable([ch])), memberRowOf(ch, U.c))].join('|'); }
    { const ch = mk(); kick(ch); addRow(U.b, ch, U.c); // 참여 행만 다시 넣기 — 제외는 남는다
      o[`${kind}ReaddRowOnly`] = [excluded(ch, U.c), readable(U.c, ch)].join('|'); }
    { const ch = mk(); kick(ch); o[`${kind}KickedReads`] = readable(U.c, ch); }
  }
  { // 조직에서 내보냄(offboard) — 참여 행은 지워지지만 제외 목록에는 오르지 않는다(공개 채널과 같음)
    const ch = channel(U.b, 'private', [U.g]);
    asUser(U.a, `update public.msgr_org_members set removed_at = now() where org_id = '${ORG}' and user_id = '${U.g}'`);
    o.offboardRowGone = memberRowOf(ch, U.g) === '0'; o.offboardExcluded = excluded(ch, U.g);
    sql(`update public.msgr_org_members set removed_at = null where org_id = '${ORG}' and user_id = '${U.g}'`); // 다음 칸을 위해 되돌림(슈퍼유저)
  }
  { const ch = orgDm(U.b, [U.c]); delRow(U.c, ch, U.b); o.dmKickExcluded = sql(`select cardinality(excluded_user_ids) from public.msgr_channels where id = '${ch}'`) !== '0'; }
  return o;
}

let PRE, POST;
test('수정 전(#846까지): 그룹 대화를 참여자 누구나 지우고 글이 함께 사라진다, 에이전트 system 글은 신고되지 않는다', { skip }, () => {
  PRE = { d: observeDelete(), r: observeReport(), x: observeExecutionMeta(), k: observeKick() };
  const { d, r } = PRE;
  assert.equal(d.grpMemberDel, true, '재현: 일반 참여자가 그룹 대화를 지운다');
  assert.equal(d.grpMemberDelLostMsgs, true, '재현: 모두의 글이 cascade로 사라진다');
  assert.equal(d.grpGuestDel, true, '재현: 게스트 참여자도 지운다');
  assert.equal(d.grpChAdminDel, true, '수정 전: 채널 관리자로 지정된 참여자도 지운다');
  assert.equal(d.grpAfterCreatorLeftMemberDel, true, '재현: 만든 사람이 나간 뒤 남은 참여자가 지운다');
  assert.equal(d.grpMemberKicksOther, true, '재현(우회 길): 일반 참여자가 남의 참여 행을 지운다');
  assert.equal(d.grpBypassByKick, true, '재현(우회 길): 남을 다 빼고 사람 둘만 남겨 방을 지운다');
  assert.equal(d.grpDemotedAdminDel, true, '수정 전: 강등된 관리자도 참여자라 지운다');
  assert.equal(d.grpMemberSwapsOther && d.grpMemberSwapRemovedD, true, '재현(옆 길): 일반 참여자가 남의 참여 행을 방 밖 사람으로 바꿔 빼낸다');
  assert.equal(r.crewSystem, false, '재현: 에이전트 명의 system 글은 신고되지 않는다');
  assert.match(r.crewSystemErr, /msgr_report_no_message/);
  assert.equal(r.ownCrewSystem, false, '재현: 주인도 신고 불가(같은 제외)');
  // 정상 경로(전후 같아야 하는 칸)
  for (const k of ['grpCreatorDel', 'grpOwnerInRoomDel', 'grpAdminInRoomDel', 'grpMemberLeave', 'grpMemberLeaveKeepsRoom', 'grpMemberRename', 'grpMemberArchive', 'shrunkToTwoMemberDel', 'dmOtherDel', 'dmCreatorDel', 'dmWithAgentOtherDel', 'pubCreatorDel', 'pubOrgAdminOutsideDel', 'privCreatorDel', 'privChAdminDel', 'personalPairOtherDel', 'personalGroupCreatorDel', 'grpCreatorKicksOther', 'grpOwnerKicksOther', 'grpSelfRowLeave', 'dmKickOther', 'privCreatorKicks', 'grpCreatorSwapsOther', 'privCreatorSwaps']) assert.equal(d[k], true, `수정 전 정상: ${k}`);
  for (const k of ['grpAdminOutsideDel', 'grpLeftCreatorDel', 'pubMemberDel', 'privMemberDel', 'privOrgAdminOutsideDel', 'personalGroupMemberDel', 'privMemberKicks', 'grpExpiredAdminDel', 'privMemberSwaps']) assert.equal(d[k], false, `수정 전 거절: ${k}`);
  for (const k of ['userText', 'crewText', 'crewApproval', 'userSystem']) assert.equal(r[k], true, `수정 전 신고 가능: ${k} ${r[`${k}Err`]}`);
  assert.equal(r.realSystem, false);
  const k = PRE.k;
  assert.equal(k.privKickExcluded, false, '재현(결정 3): 비공개 채널에서 내보낸 사람이 제외 목록에 오르지 않는다');
  assert.equal(k.privKickedRejoinsByInvite, true, '재현(결정 3): 재사용 초대로 그 비공개 채널에 다시 들어온다');
  assert.equal(k.privLeaverRejoinsByInvite, true, '수정 전: 스스로 나간 사람은 재사용 초대로 다시 들어온다');
  for (const kind of ['public', 'private']) assert.deepEqual(RELAY_KEYS.filter((k) => k in PRE.x[kind]), RELAY_KEYS, `재현(#846 재검수): ${kind} 채널 에이전트 답에 전달 표지가 저장된다`);
});

test('새 마이그레이션 적용(그 뒤 파일이 있으면 순서대로 함께)', { skip }, () => {
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x) && x >= FIX).sort()) applyMig(f);
  POST = { d: observeDelete(), r: observeReport(), x: observeExecutionMeta(), k: observeKick() };
});

test('결정 1. 조직 그룹 대화 삭제는 만든 사람(참여 중)·조직 관리자(참여 중)만 — 일반·게스트·채널 관리자·나간 만든 사람은 못 지운다', { skip }, () => {
  const d = POST.d;
  assert.equal(d.grpMemberDel, false, '일반 참여자');
  assert.equal(d.grpGuestDel, false, '게스트 참여자');
  assert.equal(d.grpChAdminDel, false, '채널 관리자(admin_user_ids)로 지정된 참여자');
  assert.equal(d.grpLeftCreatorDel, false, '나간 만든 사람');
  assert.equal(d.grpAfterCreatorLeftMemberDel, false, '만든 사람이 나간 뒤 남은 일반 참여자');
  assert.equal(d.grpAdminOutsideDel, false, '방 밖 조직 admin(종전과 같음)');
  assert.equal(d.grpCreatorDel, true, '만든 사람(참여 중)');
  assert.equal(d.grpOwnerInRoomDel, true, '조직 owner(참여 중)');
  assert.equal(d.grpAdminInRoomDel, true, '조직 admin(참여 중)');
  assert.equal(d.grpAfterCreatorLeftOwnerDel, true, '만든 사람이 나간 뒤에도 조직 owner(참여 중)는 지운다');
  assert.equal(d.grpDemotedAdminDel, false, '강등된 관리자(지금 역할 member)');
  assert.equal(d.grpExpiredAdminDel, false, '기한이 지난 관리자');
});

test('결정 1-b·1-c. 우회·옆 길 — 일반 참여자는 남을 빼거나 바꾸지 못해 "사람 둘로 줄이고 지우기"가 막힌다, 판정 열은 바꿀 수 없다', { skip }, () => {
  const d = POST.d;
  assert.equal(d.grpMemberKicksOther, false, '일반 참여자가 남의 참여 행을 지우지 못한다');
  assert.equal(d.grpBypassByKick, false, '남을 빼고 지우는 길');
  assert.equal(d.grpMemberSwapsOther, false, '옆 길(update): 남의 참여 행을 바꿔 빼내지 못한다');
  for (const k of ['grpCreatorKicksOther', 'grpOwnerKicksOther', 'grpSelfRowLeave', 'dmKickOther', 'privCreatorKicks', 'privMemberKicks', 'grpCreatorSwapsOther', 'privCreatorSwaps', 'privMemberSwaps']) assert.equal(d[k], PRE.d[k], `전후 같음: ${k}`);
  for (const o of [PRE.d, POST.d]) {
    assert.match(o.grpForgeCreator, /immutable|msgr_/, `created_by 변경 거절: ${o.grpForgeCreator}`);
    assert.match(o.grpForgeKind, /immutable|msgr_/, `kind 변경 거절: ${o.grpForgeKind}`);
  }
  assert.match(sql(`select qual from pg_policies where schemaname = 'public' and tablename = 'msgr_channel_members' and policyname = 'msgr_channel_members_delete'`), /msgr_can_delete_channel\(channel_id\)/);
  const upd = sql(`select qual || ' | ' || with_check from pg_policies where schemaname = 'public' and tablename = 'msgr_channel_members' and policyname = 'msgr_channel_members_update'`);
  assert.equal((upd.match(/msgr_can_delete_channel\(channel_id\)/g) ?? []).length, 2, `update 정책 using·with check: ${upd}`);
  assert.doesNotMatch(upd, /msgr_can_manage_channel/);
});

test('결정 1. 나가기·이름 바꾸기·보관은 그대로, 1:1·사람 둘 + 에이전트·줄어든 그룹·채널·개인 공간 삭제 규칙도 그대로', { skip }, () => {
  const { d } = POST;
  for (const k of ['grpMemberLeave', 'grpMemberLeaveKeepsRoom', 'grpMemberRename', 'grpMemberArchive', 'shrunkToTwoMemberDel', 'dmOtherDel', 'dmCreatorDel', 'dmWithAgentOtherDel', 'pubCreatorDel', 'pubOrgAdminOutsideDel', 'privCreatorDel', 'privChAdminDel', 'privOrgAdminOutsideDel', 'personalPairOtherDel', 'personalGroupCreatorDel', 'pubMemberDel', 'privMemberDel', 'personalGroupMemberDel', 'grpAdminOutsideDel', 'grpLeftCreatorDel']) {
    assert.equal(d[k], PRE.d[k], `전후 같음: ${k}`);
  }
});

test('결정 1. 삭제 정책은 msgr_can_delete_channel 하나 — 정의자·search_path·권한', { skip }, () => {
  assert.match(sql(`select qual from pg_policies where schemaname = 'public' and tablename = 'msgr_channels' and policyname = 'msgr_channels_delete'`), /msgr_can_delete_channel\(id\)/);
  assert.equal(sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = 'msgr_channels' and cmd in ('DELETE', 'ALL')`), '1', '삭제를 여는 다른 정책이 없다');
  assert.equal(sql(`select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc where proname = 'msgr_can_delete_channel'`), 'true|search_path=public, pg_temp');
  assert.equal(sql(`select has_function_privilege('anon', 'public.msgr_can_delete_channel(uuid)', 'execute')::text || has_function_privilege('authenticated', 'public.msgr_can_delete_channel(uuid)', 'execute')::text`), 'falsetrue');
});

test('결정 2. 에이전트 명의 글은 kind와 상관없이 신고된다 — 진짜 시스템 글만 제외', { skip }, () => {
  const { r } = POST;
  assert.equal(r.crewSystem, true, `에이전트 system 글: ${r.crewSystemErr}`);
  assert.equal(r.ownCrewSystem, true, '에이전트 주인도 자기 에이전트 글을 신고한다(사람 글만 자기 글 거절)');
  for (const k of ['userText', 'crewText', 'crewApproval', 'userSystem']) assert.equal(r[k], true, `${k}: ${r[`${k}Err`]}`);
  assert.equal(r.realSystem, false, '진짜 시스템 글은 제외');
  assert.match(r.realSystemErr, /msgr_report_no_message/);
  assert.match(r.ownUserText, /msgr_report_own/, '자기 사람 글은 그대로 거절');
  assert.match(r.outsiderCrewSystem, /msgr_report_no_message/, '못 읽는 사람은 없는 글과 같은 오류');
});

test('결정 2. 신고함·처리가 에이전트 system 글 신고를 받는다(작성자 사람 없음, 에이전트 id 보존)', { skip }, () => {
  const { r } = POST;
  assert.equal(r.listRow, '관리자 공지: 재로그인 링크|null|open', '관리자 신고함에 본문·상태가 나온다');
  assert.equal(r.crewIdSaved, CREW_B, '신고 행에 에이전트 id가 남는다');
  assert.equal(r.resolve, true, '처리 완료로 바꿀 수 있다');
  assert.equal(sql(`select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc where proname = 'msgr_report_message'`), 'true|search_path=public, pg_temp');
  assert.equal(sql(`select has_function_privilege('anon', 'public.msgr_report_message(bigint, text)', 'execute')::text || has_function_privilege('authenticated', 'public.msgr_report_message(bigint, text)', 'execute')::text`), 'falsetrue');
});

test('3. 에이전트 답 저장(msgr_execution_finish)은 전달 표지를 빼고 저장한다 — hop·origin·disposition은 그대로', { skip }, () => {
  for (const kind of ['public', 'private']) {
    assert.deepEqual(POST.x[kind], { hop: 1, origin: U.b, disposition: 'done' }, `${kind} 채널`);
    assert.deepEqual(Object.fromEntries(Object.entries(PRE.x[kind]).filter(([k]) => !RELAY_KEYS.includes(k))), POST.x[kind], `${kind} 다른 키는 전후 같음`);
  }
  assert.equal(sql(`select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc where proname = 'msgr_execution_finish'`), 'true|search_path=public, pg_temp');
  assert.equal(sql(`select has_function_privilege('anon', 'public.msgr_execution_finish(text, uuid, bigint, uuid, uuid, jsonb)', 'execute')::text || has_function_privilege('authenticated', 'public.msgr_execution_finish(text, uuid, bigint, uuid, uuid, jsonb)', 'execute')::text`), 'falsetrue');
});

test('결정 3. 채널에서 남이 내보낸 사람은 제외 목록에 올라 재사용 초대가 그 채널을 건너뛴다 — 스스로 나간 사람·조직 탈퇴·대화방은 아니다, 되돌리기는 공개 채널과 같다', { skip }, () => {
  const k = POST.k;
  assert.equal(k.privKickExcluded, true, '비공개 채널 내보내기 → 제외 목록');
  assert.equal(k.privKickedRejoinsByInvite, false, '재사용 초대 수락해도 그 비공개 채널은 건너뜀');
  assert.equal(k.privLeaveExcluded, false, '스스로 나가기는 제외 아님');
  assert.equal(k.privLeaverRejoinsByInvite, true, '스스로 나간 사람은 재사용 초대로 다시 들어온다');
  assert.equal(k.offboardRowGone, true); assert.equal(k.offboardExcluded, false, '조직에서 내보낸 것은 채널 제외가 아니다');
  assert.equal(k.dmKickExcluded, false, '대화방(dm)은 제외 목록을 쓰지 않는다');
  // 공개 채널과 같은 결과
  assert.equal(k.publicRestore, 'false|true|1', '공개: 되돌리기 → 제외 풀림·읽기·초대 정상');
  assert.equal(k.privateRestore, k.publicRestore, '비공개 되돌리기 = 공개');
  assert.equal(k.privateReaddRowOnly, k.publicReaddRowOnly, `참여 행만 다시 넣기: 공개 ${k.publicReaddRowOnly} / 비공개 ${k.privateReaddRowOnly}`);
  assert.equal(k.publicKickedReads, false); assert.equal(k.privateKickedReads, false, '내보낸 뒤 못 읽는다');
  for (const key of ['publicRestore', 'publicReaddRowOnly', 'publicKickedReads', 'offboardRowGone', 'offboardExcluded', 'dmKickExcluded', 'privLeaveExcluded', 'privLeaverRejoinsByInvite']) assert.equal(k[key], PRE.k[key], `전후 같음: ${key}`);
  assert.equal(sql(`select prosecdef::text || '|' || array_to_string(proconfig, ',') from pg_proc where proname = 'msgr_channel_kick_excludes'`), 'true|search_path=public, pg_temp');
  assert.equal(sql(`select has_function_privilege('authenticated', 'public.msgr_channel_kick_excludes()', 'execute')::text`), 'false');
});
