// 참여 행 신원 열 잠금(20261006180000_msgr_member_row_lock.sql) — 같은 파일 안에서 수정 전(#847까지) → 수정 뒤를 잰다.
//   결함: 조직 1:1(b가 만든, 참여자 b·c)에서 c가 update msgr_channel_members set member_id = d where member_id = b 로 b를 빼고 d를 넣었다.
//   처방: channel_id·member_kind·member_id를 바꾸는 update는 어느 채널 종류·역할·문맥(서비스 포함)에서든 거절. 사람 바꾸기는 delete + insert.
//   정상 update(added_by — 앱 upsert·계정 삭제의 added_by = null)와 delete + insert 결과는 전후 같다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-member-row-lock-pg.test.mjs
// 변이: ARGO_MUTATE_MEMBER_LOCK=channel_id|member_kind|member_id|added_at — 적용할 마이그레이션에서 그 열의 잠금 한 줄을 지운다 → 해당 칸이 빨개져야 한다.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-member-row-lock-pg.test.mjs';
const FIX = '20261006180000_msgr_member_row_lock.sql';
const MUTATE = process.env.ARGO_MUTATE_MEMBER_LOCK || '';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = {
  a: '11111111-1111-4111-8111-111111111111', // 조직 owner
  k: '22222222-2222-4222-8222-222222222222', // 조직 admin
  b: '33333333-3333-4333-8333-333333333333', // member — 방을 만든다
  c: '44444444-4444-4444-8444-444444444444', // member — 참여자
  d: '55555555-5555-4555-8555-555555555555', // member — 방 밖(바꿔치기로 들어오려는 사람)
  g: '66666666-6666-4666-8666-666666666666', // guest — 그룹 대화 참여자
  e: '77777777-7777-4777-8777-777777777777', // member — 계정 삭제(msgr_delete_me) 정상 경로 확인용
};
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim(); // 슈퍼유저 — 시드·관찰 전용(auth.uid() 없음 = 서비스 문맥)
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asUser = (uid, q) => { const r = asUserRaw(uid, q); if (r.status !== 0) throw new Error(`psql 실패(${uid.slice(0, 2)}): ${r.stderr}`); return r.stdout.trim(); };
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const applyMig = (f) => psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
function applyFix() {
  let text = readFileSync(mig(FIX), 'utf8');
  if (MUTATE) { // 변이: 그 열의 잠금 한 줄만 지운다(WHEN 절은 그대로 — 함수가 불려도 그 열은 통과)
    const line = new RegExp(`^\\s*if new\\.${MUTATE} is distinct from old\\.${MUTATE} then raise exception[^\\n]*\\n`, 'm');
    assert.match(text, line, `변이 대상 줄이 있어야 한다: ${MUTATE}`);
    text = text.replace(line, '');
  }
  psql(['-c', text]);
}

let ORG, CREW_C;
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
  assert.ok(files.includes('20261006170000_msgr_group_delete_report.sql'), '#847 마이그레이션 위에 쌓인다');
  for (const f of files.filter((x) => x < FIX)) applyMig(f); // 수정 직전(#847 포함)까지 — 실제 적용 순서대로
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 20 where org_id = '${ORG}'`);
  for (const [u, role] of [[U.k, 'admin'], [U.b, 'member'], [U.c, 'member'], [U.d, 'member'], [U.e, 'member']]) {
    const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.a}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.g}', 'guest')`); // 게스트 시드는 슈퍼유저(msgr-pg-integration과 같은 방식)
  CREW_C = last(asUser(U.c, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.c}', 'ws-c', 'c-agent', '비서') returning id`));
  for (const u of [U.c, U.d, U.a]) assert.equal(last(asUser(U.b, `select public.msgr_friend_request('${u}')`)), 'friend'); // 같은 조직 동료는 요청 없이 친구
});

const people = (list) => `'${JSON.stringify(list.map((id) => ({ kind: 'user', id })))}'::jsonb`;
const orgDm = (creator, others) => last(asUser(creator, `select public.msgr_create_channel('${ORG}', 'dm', 'dm:t', ${people(others)})`));
const channel = (creator, kind, others = []) => last(asUser(creator, `select public.msgr_create_channel('${ORG}', '${kind}', '${kind}-' || gen_random_uuid()::text, ${people(others)})`));
const has = (ch, kind, id) => sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}' and member_kind = '${kind}' and member_id = '${id}'`) === '1';
const rowsOf = (ch) => sql(`select string_agg(member_kind || ':' || left(member_id::text, 2), ',' order by member_kind, member_id) from public.msgr_channel_members where channel_id = '${ch}'`);
// 사용자 문맥(RLS) update — 바뀐 행이 1이면 true. 오류 문구도 남긴다
function upd(uid, set, ch, kind, id) {
  const r = asUserRaw(uid, `with u as (update public.msgr_channel_members set ${set} where channel_id = '${ch}' and member_kind = '${kind}' and member_id = '${id}' returning 1) select count(*) from u`);
  return { ok: r.status === 0 && last(r.stdout) === '1', err: r.stderr.trim() };
}
// 서비스 문맥(auth.uid() 없음, RLS 없음) update
function svcUpd(set, ch, kind, id) {
  const r = psqlRaw(['-A', '-t', '-c', `with u as (update public.msgr_channel_members set ${set} where channel_id = '${ch}' and member_kind = '${kind}' and member_id = '${id}' returning 1) select count(*) from u`]);
  return { ok: r.status === 0 && last(r.stdout) === '1', err: r.stderr.trim() };
}
const kick = (uid, ch, kind, id) => { const r = asUserRaw(uid, `with d as (delete from public.msgr_channel_members where channel_id = '${ch}' and member_kind = '${kind}' and member_id = '${id}' returning 1) select count(*) from d`); return r.status === 0 && last(r.stdout) === '1'; };
const add = (uid, ch, kind, id) => asUserRaw(uid, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', '${kind}', '${id}', '${uid}')`).status === 0;
// 앱 ChannelSheet addMember·restoreMember와 같은 모양 — PostgREST upsert(onConflict 기본 키)는 보낸 열을 모두 excluded 값으로 덮는다
const appUpsert = (uid, ch, id) => asUserRaw(uid, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'user', '${id}', '${uid}')
  on conflict (channel_id, member_kind, member_id) do update set channel_id = excluded.channel_id, member_kind = excluded.member_kind, member_id = excluded.member_id, added_by = excluded.added_by`).status === 0;

// 칸마다 새 방 — 앞 칸의 바꿔치기가 뒤 칸의 전제를 바꾸지 않게
function observe() {
  const o = {};
  const swap = (key, uid, ch, from, to) => { const r = upd(uid, `member_id = '${to}', added_by = '${uid}'`, ch, 'user', from); o[key] = r.ok; o[`${key}Err`] = r.err; };
  // ── 1:1(조직, 사람 둘) — 신고된 결함
  { const ch = orgDm(U.b, [U.c]); swap('dmMemberSwapsCreator', U.c, ch, U.b, U.d); o.dmCreatorLost = !has(ch, 'user', U.b); o.dmOutsiderIn = has(ch, 'user', U.d); }
  { const ch = orgDm(U.b, [U.c]); swap('dmCreatorSwapsOther', U.b, ch, U.c, U.d); }
  { const ch = orgDm(U.b, [U.c]); swap('dmSelfSwap', U.c, ch, U.c, U.d); } // 자기 행을 남으로 바꾸기
  { const ch = orgDm(U.b, [U.c]); const r = upd(U.c, `member_kind = 'crew', member_id = '${CREW_C}', added_by = '${U.c}'`, ch, 'user', U.b); o.dmKindSwap = r.ok; o.dmKindSwapErr = r.err; } // 사람 행을 내 에이전트로
  { // channel_id — c가 b의 1:1 참여 행을 c가 만든 비공개 채널로 옮긴다(b는 1:1을 잃고 동의 없이 c의 채널에 들어간다)
    const ch = orgDm(U.b, [U.c]); const mine = channel(U.c, 'private');
    const r = upd(U.c, `channel_id = '${mine}', added_by = '${U.c}'`, ch, 'user', U.b); o.dmMoveRow = r.ok; o.dmMoveRowErr = r.err; o.dmMoveRowLanded = has(mine, 'user', U.b);
  }
  // ── 그룹 대화(조직, 사람 셋 이상) — 만든 사람·조직 owner(참여 중)·게스트
  { const ch = orgDm(U.b, [U.c, U.g, U.a]); swap('grpCreatorSwaps', U.b, ch, U.c, U.d); }
  { const ch = orgDm(U.b, [U.c, U.g, U.a]); swap('grpOwnerSwaps', U.a, ch, U.c, U.d); }
  { const ch = orgDm(U.b, [U.c, U.g, U.a]); swap('grpGuestSwaps', U.g, ch, U.c, U.d); }
  // 검수 #849 LOW: 만든 사람이 나가 사람 둘이 남은 대화방에서 참여자가 자기 added_at을 과거로 고쳐 결재자(msgr_dm_approver)를 가로챈다
  { const ch = orgDm(U.b, [U.c, U.g]); asUser(U.b, `select public.msgr_leave_dm('${ch}')`);
    const before = sql(`select public.msgr_dm_approver('${ch}')`);
    const r = upd(U.g, `added_at = '2000-01-01', added_by = '${U.g}'`, ch, 'user', U.g); o.dmApproverHijack = r.ok; o.dmApproverHijackErr = r.err;
    o.dmApproverChanged = sql(`select public.msgr_dm_approver('${ch}')`) !== before; }
  // ── 공개·비공개 채널 — 만든 사람·조직 admin·일반 참여자
  { const ch = channel(U.b, 'public'); asUser(U.c, `select public.msgr_join_channel('${ch}')`); swap('pubCreatorSwaps', U.b, ch, U.c, U.d); }
  { const ch = channel(U.b, 'public'); asUser(U.c, `select public.msgr_join_channel('${ch}')`); swap('pubOrgAdminSwaps', U.k, ch, U.c, U.d); }
  { const ch = channel(U.b, 'private', [U.c]); swap('privCreatorSwaps', U.b, ch, U.c, U.d); }
  { const ch = channel(U.b, 'private', [U.c]); swap('privMemberSwaps', U.c, ch, U.b, U.d); }
  { const ch = channel(U.b, 'private', [U.c]); const other = channel(U.b, 'private'); const r = upd(U.b, `channel_id = '${other}'`, ch, 'user', U.c); o.privMoveRow = r.ok; o.privMoveRowErr = r.err; }
  // ── 개인 공간 — 1:1(두 사람)·그룹(만든 사람)
  { const ch = last(asUser(U.b, `select public.msgr_dm_personal('${U.c}')`)); swap('personalPairSwaps', U.c, ch, U.b, U.d); }
  { const ch = last(asUser(U.b, `select public.msgr_dm_personal_group(array['${U.c}','${U.d}']::uuid[], null)`)); swap('personalGroupCreatorSwaps', U.b, ch, U.d, U.a); } // 친구 a는 방 밖
  // ── 서비스 문맥(auth.uid() 없음) — 열마다 하나씩(사용자 문맥에서는 member_kind만 따로 바꿀 길이 없다: 같은 uuid의 에이전트가 없다)
  { const ch = orgDm(U.b, [U.c]); const r = svcUpd(`member_id = '${U.d}'`, ch, 'user', U.b); o.svcMemberId = r.ok; o.svcMemberIdErr = r.err; }
  { const ch = orgDm(U.b, [U.c]); const r = svcUpd(`member_kind = 'crew'`, ch, 'user', U.b); o.svcKind = r.ok; o.svcKindErr = r.err; }
  { const ch = orgDm(U.b, [U.c]); const other = channel(U.b, 'private'); const r = svcUpd(`channel_id = '${other}'`, ch, 'user', U.c); o.svcChannel = r.ok; o.svcChannelErr = r.err; }
  // ── 정상 update(신원 열 그대로) — 전후 같아야 한다
  { const ch = channel(U.b, 'private', [U.c]); o.privAddedByUpd = upd(U.b, `added_by = '${U.b}'`, ch, 'user', U.c).ok; }
  { const ch = channel(U.b, 'private', [U.c]); o.appUpsertExisting = appUpsert(U.b, ch, U.c) && has(ch, 'user', U.c); o.appUpsertNew = appUpsert(U.b, ch, U.d) && has(ch, 'user', U.d); }
  { const ch = channel(U.b, 'public'); o.pubAppUpsertNew = appUpsert(U.b, ch, U.c) && has(ch, 'user', U.c); }
  { const ch = orgDm(U.b, [U.c]); o.svcAddedByNull = svcUpd('added_by = null', ch, 'user', U.c).ok; }
  // ── delete + insert로 사람 바꾸기 — 각자 정책·트리거를 지난다(전후 같아야 한다)
  { const ch = channel(U.b, 'private', [U.c]); o.privCreatorDelIns = kick(U.b, ch, 'user', U.c) && add(U.b, ch, 'user', U.d); o.privCreatorDelInsRows = rowsOf(ch); }
  { const ch = channel(U.b, 'private', [U.c]); o.privMemberDelIns = kick(U.c, ch, 'user', U.b) && add(U.c, ch, 'user', U.d); }
  { const ch = orgDm(U.b, [U.c]); o.dmKickB = kick(U.c, ch, 'user', U.b); o.dmInsD = add(U.c, ch, 'user', U.d); o.dmDelInsRows = rowsOf(ch); } // 1:1 사람은 만들 때만 — insert는 거절
  { const ch = orgDm(U.b, [U.c, U.g, U.a]); o.grpCreatorKick = kick(U.b, ch, 'user', U.c); o.grpCreatorIns = add(U.b, ch, 'user', U.d); }
  return o;
}

// 계정 삭제(msgr_delete_me) — 정의자 함수의 added_by = null은 그대로(한 번만 — 계정이 사라진다)
function observeDeleteMe(tag) {
  const ch = channel(U.e, 'private', [U.c]);
  assert.equal(sql(`select added_by from public.msgr_channel_members where channel_id = '${ch}' and member_id = '${U.c}'`), U.e);
  const r = asUserRaw(U.e, `select public.msgr_delete_me()`);
  return { ok: r.status === 0, err: r.stderr.trim(), addedByNull: sql(`select coalesce(added_by::text, 'null') from public.msgr_channel_members where channel_id = '${ch}' and member_id = '${U.c}'`) === 'null', tag };
}

let PRE, POST;
const IDENTITY = ['dmMemberSwapsCreator', 'dmCreatorSwapsOther', 'dmSelfSwap', 'dmKindSwap', 'dmMoveRow', 'grpCreatorSwaps', 'grpOwnerSwaps', 'grpGuestSwaps',
  'pubCreatorSwaps', 'pubOrgAdminSwaps', 'privCreatorSwaps', 'privMemberSwaps', 'privMoveRow', 'personalPairSwaps', 'personalGroupCreatorSwaps', 'svcMemberId', 'svcKind', 'svcChannel', 'dmApproverHijack'];
const NORMAL = ['privAddedByUpd', 'appUpsertExisting', 'appUpsertNew', 'pubAppUpsertNew', 'svcAddedByNull'];
const DELINS = ['privCreatorDelIns', 'privCreatorDelInsRows', 'privMemberDelIns', 'dmKickB', 'dmInsD', 'dmDelInsRows', 'grpCreatorKick', 'grpCreatorIns'];

test('수정 전(#847까지) — 참여 행 바꿔치기가 통한다(재현)', { skip }, () => {
  PRE = observe();
  const o = PRE;
  assert.equal(o.dmMemberSwapsCreator, true, `재현: 1:1 참여자 c가 b의 행을 d로 바꾼다 ${o.dmMemberSwapsCreatorErr}`);
  assert.equal(o.dmCreatorLost && o.dmOutsiderIn, true, '재현: b는 자기 1:1에서 빠지고 d가 들어간다');
  assert.equal(o.dmMoveRow && o.dmMoveRowLanded, true, `재현: 1:1 참여자가 상대 행을 자기 비공개 채널로 옮긴다 ${o.dmMoveRowErr}`);
  for (const k of ['svcMemberId', 'svcKind', 'svcChannel']) assert.equal(o[k], true, `재현(서비스 문맥): ${k} ${o[`${k}Err`]}`);
  assert.equal(o.dmApproverHijack && o.dmApproverChanged, true, `재현: added_at을 고쳐 결재자를 가로챈다 ${o.dmApproverHijackErr}`);
  for (const k of NORMAL) assert.equal(o[k], true, `수정 전 정상: ${k}`);
  // 다른 칸의 수정 전 값은 기록만 한다(아래 표 출력) — 수정 뒤에는 칸마다 거절이어야 한다
  console.log('# PRE', JSON.stringify(Object.fromEntries([...IDENTITY, ...NORMAL, ...DELINS].map((k) => [k, o[k]]))));
});

test('새 마이그레이션 적용(그 뒤 파일이 있으면 순서대로 함께)', { skip }, () => {
  applyFix();
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x) && x > FIX).sort()) applyMig(f);
  POST = observe();
  POST.deleteMe = observeDeleteMe('post');
  console.log('# POST', JSON.stringify(Object.fromEntries([...IDENTITY, ...NORMAL, ...DELINS].map((k) => [k, POST[k]]))));
});

test('신원 열(channel_id·member_kind·member_id)·added_at update는 채널 종류·역할·문맥과 상관없이 거절', { skip }, () => {
  const o = POST;
  for (const k of IDENTITY) assert.equal(o[k], false, `거절이어야 한다: ${k}`);
  assert.match(o.dmMemberSwapsCreatorErr, /msgr_immutable_member_id/, '신고된 결함 — 1:1 바꿔치기');
  assert.match(o.dmMoveRowErr, /msgr_immutable_channel_id/);
  assert.match(o.privMoveRowErr, /msgr_immutable_channel_id/);
  assert.match(o.dmKindSwapErr, /msgr_immutable_member_(kind|id)/);
  assert.match(o.svcMemberIdErr, /msgr_immutable_member_id/, '서비스 문맥도 예외 없음');
  assert.match(o.svcKindErr, /msgr_immutable_member_kind/);
  assert.match(o.svcChannelErr, /msgr_immutable_channel_id/);
  assert.equal(o.dmCreatorLost || o.dmOutsiderIn || o.dmMoveRowLanded, false, 'b는 1:1에 남고 d는 들어오지 못한다');
  assert.match(o.dmApproverHijackErr, /msgr_immutable_added_at/); assert.equal(o.dmApproverChanged, false, '결재자가 바뀌지 않는다');
});

test('정상 update(added_by — 앱 upsert·서비스·계정 삭제)와 delete + insert는 전후 같다', { skip }, () => {
  for (const k of NORMAL) assert.equal(POST[k], true, `정상: ${k}`);
  for (const k of DELINS) assert.equal(POST[k], PRE[k], `전후 같음: ${k}`);
  assert.equal(POST.privCreatorDelIns, true, '비공개 채널 만든 사람: c를 빼고 d를 넣는다');
  assert.equal(POST.dmInsD, false, '1:1 사람은 만들 때만 — insert는 종전대로 거절');
  assert.equal(POST.deleteMe.ok, true, `계정 삭제 정의자 함수: ${POST.deleteMe.err}`);
  assert.equal(POST.deleteMe.addedByNull, true, '계정 삭제가 남긴 참여 행의 added_by를 비운다');
});

test('잠금 모양 — WHEN 절로 신원 열이 바뀔 때만 함수가 돈다, 정의자 아님·우회 조건 없음', { skip }, () => {
  const def = sql(`select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = 'public.msgr_channel_members'::regclass and t.tgname = 'msgr_lock_channel_members'`);
  assert.match(def, /BEFORE UPDATE/);
  for (const c of ['channel_id', 'member_kind', 'member_id', 'added_at']) assert.match(def, new RegExp(`old\\.${c} IS DISTINCT FROM new\\.${c}`), `WHEN 절: ${c}`);
  const src = sql(`select prosrc from pg_proc where proname = 'msgr_channel_member_identity_lock'`);
  assert.doesNotMatch(src, /pg_trigger_depth|current_setting|auth\.uid/, '위조 가능한 통과 조건이 없다(#691)');
  assert.equal(sql(`select prosecdef from pg_proc where proname = 'msgr_channel_member_identity_lock'`), 'f');
});
