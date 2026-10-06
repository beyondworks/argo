// 메신저 보안 결함 4건(20261006160000_msgr_security_fixes.sql) — 같은 파일 안에서 수정 전(빨강 재현) → 수정 뒤(막힘)를 잰다.
//   1) 게스트의 공개 채널 찾아보기·참여  2) 나간 생성자·채널 관리자의 재입장·관리  3) 사람의 kind·전달 표지 위조, 사람 명의 system 글 신고
//   4) 멘션 푸시가 채널을 못 읽는 사람에게 감
// 정상 경로(멤버의 공개 채널 참여, 참여 중인 방장·조직 관리자의 관리, 에이전트 system 글, 정상 멘션 푸시, 초대받은 게스트의 비공개 채널)는 전후 모두 같다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-security-0197-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-security-0197-pg.test.mjs';
const FIX = '20261006160000_msgr_security_fixes.sql';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = {
  a: '11111111-1111-4111-8111-111111111111', // 조직 owner
  b: '22222222-2222-4222-8222-222222222222', // member
  c: '33333333-3333-4333-8333-333333333333', // member — 비공개 채널을 만들고 나간다
  d: '44444444-4444-4444-8444-444444444444', // member — 채널 관리자였다가 나간다
  e: '55555555-5555-4555-8555-555555555555', // member — 남이 넣는 대상
  g: '66666666-6666-4666-8666-666666666666', // guest — 비공개 채널 하나에 초대됨
  x: '77777777-7777-4777-8777-777777777777', // 다른 조직 사람(이 조직 밖)
};
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim(); // 슈퍼유저 — 시드·관찰 전용
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asUser = (uid, q) => { const r = asUserRaw(uid, q); if (r.status !== 0) throw new Error(`psql 실패(${uid.slice(0, 2)}): ${r.stderr}`); return r.stdout.trim(); };
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const ok = (raw) => raw.status === 0;
const deniedRls = (raw) => raw.status !== 0 && /row-level security|msgr_forbidden/.test(raw.stderr);
const applyMig = (f) => psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);

let ORG, ORG_X;
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
  // 수정 직전까지 — 실제 적용 순서대로. 이 파일보다 뒤 마이그레이션이 생기면 수정 뒤 단계에서 함께 적용한다.
  for (const f of files.filter((x) => x < FIX)) applyMig(f);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 20 where org_id = '${ORG}'`);
  for (const u of [U.b, U.c, U.d, U.e]) {
    const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.g}', 'guest')`); // 게스트는 채널 링크로만 생긴다 — 시드는 슈퍼유저(msgr-pg-integration과 같은 방식)
  ORG_X = last(asUser(U.x, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Other', 'other', '${U.x}') returning id`));
});

// 단계마다 새 채널을 만든다 — 수정 전 단계에서 생긴 참여 행·글이 수정 뒤 판정을 흐리지 않게.
function seed(tag) {
  const s = {};
  s.PUB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}', 'public', 'pub-${tag}')`)); // a = 참여 중인 생성자
  s.PUB2 = last(asUser(U.a, `select public.msgr_create_channel('${ORG}', 'public', 'pub2-${tag}')`)); // 멤버 참여용
  asUser(U.b, `select public.msgr_join_channel('${s.PUB}')`);
  // c가 만들고 b를 넣은 비공개 채널 → c가 나간다
  s.PRIV_C = last(asUser(U.c, `select public.msgr_create_channel('${ORG}', 'private', 'c-${tag}', '[{"kind":"user","id":"${U.b}"}]'::jsonb)`));
  asUser(U.c, `delete from public.msgr_channel_members where channel_id = '${s.PRIV_C}' and member_kind = 'user' and member_id = '${U.c}'`);
  // a가 만들고 d를 채널 관리자로 둔 비공개 채널 → d가 나간다
  s.PRIV_D = last(asUser(U.a, `select public.msgr_create_channel('${ORG}', 'private', 'd-${tag}', '[{"kind":"user","id":"${U.d}"}]'::jsonb)`));
  sql(`update public.msgr_channels set admin_user_ids = array['${U.d}']::uuid[] where id = '${s.PRIV_D}'`);
  asUser(U.d, `delete from public.msgr_channel_members where channel_id = '${s.PRIV_D}' and member_kind = 'user' and member_id = '${U.d}'`);
  // a가 만들고 b를 채널 관리자로 둔 비공개 채널 — b는 참여 중(정상 경로)
  s.PRIV_B = last(asUser(U.a, `select public.msgr_create_channel('${ORG}', 'private', 'b-${tag}', '[{"kind":"user","id":"${U.b}"}]'::jsonb)`));
  sql(`update public.msgr_channels set admin_user_ids = array['${U.b}']::uuid[] where id = '${s.PRIV_B}'`);
  // 게스트가 초대받은 비공개 채널
  s.PRIV_G = last(asUser(U.a, `select public.msgr_create_channel('${ORG}', 'private', 'g-${tag}')`));
  asUser(U.a, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${s.PRIV_G}', 'user', '${U.g}', '${U.a}')`);
  return s;
}
const memberRow = (ch, uid) => sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'user' and member_id = '${uid}'`);
const addRaw = (actor, ch, uid) => asUserRaw(actor, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'user', '${uid}', '${actor}')`);
const insertMsg = (uid, ch, extra = '', vals = '') => asUserRaw(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, client_msg_id${extra}) values ('${ch}', 'user', '${uid}', 'hi', gen_random_uuid()::text${vals}) returning id`);
const recipients = (mid) => sql(`select coalesce(string_agg(u::text, ',' order by u), '') from public.msgr_messages m, public.msgr_push_recipients(m) u where m.id = ${mid}`).split(',').filter(Boolean);
const canRead = (uid, ch) => last(asUser(uid, `select public.msgr_can_read_channel('${ch}')`)) === 't';

// 결함별 관찰 — 같은 함수로 수정 전·뒤를 잰다(값이 바뀌어야 하는 칸과 그대로여야 하는 칸을 한 표로)
function observe(tag) {
  const s = seed(tag);
  const o = {};
  // 1) 게스트 공개 채널
  o.guestBrowseSeesPub = asUser(U.g, `select count(*) from public.msgr_browse_channels('${ORG}') where id = '${s.PUB}'`) === '1';
  o.guestJoin = ok(asUserRaw(U.g, `select public.msgr_join_channel('${s.PUB}')`));
  o.guestRowInPub = memberRow(s.PUB, U.g) === '1';
  o.guestWritesPub = ok(insertMsg(U.g, s.PUB));
  o.guestReadsPub = canRead(U.g, s.PUB);
  // 정상: 멤버는 찾아보기에서 보고 들어간다, 게스트는 초대받은 비공개 채널을 읽고 쓴다
  o.memberBrowseSeesPub2 = asUser(U.c, `select count(*) from public.msgr_browse_channels('${ORG}') where id = '${s.PUB2}'`) === '1';
  o.memberJoin = ok(asUserRaw(U.c, `select public.msgr_join_channel('${s.PUB2}')`)) && memberRow(s.PUB2, U.c) === '1';
  o.guestPrivRead = canRead(U.g, s.PRIV_G);
  o.guestPrivWrite = ok(insertMsg(U.g, s.PRIV_G));
  o.guestJoinPrivRefused = /msgr_public_only/.test(asUserRaw(U.g, `select public.msgr_join_channel('${s.PRIV_G}')`).stderr);

  // 2) 나간 생성자·채널 관리자
  o.leftCreatorManage = last(asUser(U.c, `select public.msgr_can_manage_channel('${s.PRIV_C}')`)) === 't';
  o.leftCreatorHost = last(asUser(U.c, `select public.msgr_is_channel_host('${s.PRIV_C}')`)) === 't';
  o.leftCreatorReaddsOther = ok(addRaw(U.c, s.PRIV_C, U.e));
  o.leftCreatorReaddsSelf = ok(addRaw(U.c, s.PRIV_C, U.c));
  o.leftAdminManage = last(asUser(U.d, `select public.msgr_can_manage_channel('${s.PRIV_D}')`)) === 't';
  o.leftAdminHost = last(asUser(U.d, `select public.msgr_is_channel_host('${s.PRIV_D}')`)) === 't';
  o.leftAdminReaddsSelf = ok(addRaw(U.d, s.PRIV_D, U.d));
  // 정상: 참여 중인 생성자·채널 관리자, 참여 안 한 조직 관리자(owner)
  o.creatorAdds = ok(addRaw(U.a, s.PRIV_G, U.e)) && memberRow(s.PRIV_G, U.e) === '1';
  o.creatorHost = last(asUser(U.a, `select public.msgr_is_channel_host('${s.PRIV_G}')`)) === 't';
  o.chanAdminManage = last(asUser(U.b, `select public.msgr_can_manage_channel('${s.PRIV_B}')`)) === 't';
  o.chanAdminHost = last(asUser(U.b, `select public.msgr_is_channel_host('${s.PRIV_B}')`)) === 't';
  o.chanAdminAdds = ok(addRaw(U.b, s.PRIV_B, U.e));
  sql(`delete from public.msgr_channel_members where channel_id = '${s.PRIV_D}' and member_kind = 'user' and member_id = '${U.a}'`); // a도 나가게 해 조직 관리자 갈래만 남긴다
  o.orgAdminManagesUnjoined = last(asUser(U.a, `select public.msgr_can_manage_channel('${s.PRIV_D}')`)) === 't';
  o.orgAdminHostUnjoined = last(asUser(U.a, `select public.msgr_is_channel_host('${s.PRIV_D}')`)) === 't';
  o.plainMemberManage = last(asUser(U.e, `select public.msgr_can_manage_channel('${s.PRIV_B}')`)) === 't'; // 참여 중이지만 생성자·관리자 아님(위에서 b가 넣음)

  // 3) 사람의 kind·전달 표지 위조
  o.userSystem = insertMsg(U.b, s.PUB, ', kind', `, 'system'`); o.userSystemOk = ok(o.userSystem);
  o.userApproval = ok(insertMsg(U.b, s.PUB, ', kind', `, 'approval_card'`));
  o.userRelayTo = ok(insertMsg(U.b, s.PUB, ', meta', `, '{"relay_to":["x"]}'::jsonb`));
  o.userRelay = ok(insertMsg(U.b, s.PUB, ', meta', `, '{"relay":{"via_crew_id":"x"}}'::jsonb`));
  o.userRelayChain = ok(insertMsg(U.b, s.PUB, ', meta', `, '{"relay_chain_id":"x"}'::jsonb`));
  // 정상: 보통 글, kind를 'text'로 밝힌 글, 다른 meta 키를 든 글(오피스 맡기기 등)
  o.userText = ok(insertMsg(U.b, s.PUB));
  o.userTextExplicit = ok(insertMsg(U.b, s.PUB, ', kind', `, 'text'`));
  o.userOtherMeta = ok(insertMsg(U.b, s.PUB, ', meta', `, '{"office":true,"task":"t1"}'::jsonb`));
  // 신고: 수정 전에 이미 들어간 사람 명의 system 글(위조)은 신고 가능해야 하고, 서버 안내(author_kind='system')는 계속 제외
  const forged = sql(`insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, client_msg_id) values ('${s.PUB}', 'user', '${U.b}', 'system', '위조 안내', gen_random_uuid()::text) returning id`).split('\n').pop();
  const serverSys = sql(`insert into public.msgr_messages (channel_id, author_kind, kind, body, client_msg_id) values ('${s.PUB}', 'system', 'system', '입장', gen_random_uuid()::text) returning id`).split('\n').pop();
  o.reportForged = ok(asUserRaw(U.a, `select public.msgr_report_message(${forged})`));
  o.reportServerSysRefused = /msgr_report_no_message/.test(asUserRaw(U.a, `select public.msgr_report_message(${serverSys})`).stderr);
  o.reportOwnErr = asUserRaw(U.b, `select public.msgr_report_message(${forged})`).stderr; // 수정 전 msgr_report_no_message(system 제외), 수정 뒤 msgr_report_own
  o.reportOwnForgedRefused = /msgr_report_(own|no_message)/.test(o.reportOwnErr);

  // 4) 푸시 수신자 — 비공개 채널 PRIV_B(a·b·e 참여)에 b가 x(조직 밖)·g(게스트, 이 채널 밖)·c(조직원, 이 채널 밖)·a(참여자)를 멘션
  const ment = (ids) => `'${JSON.stringify(ids.map((id) => ({ kind: 'user', id })))}'::jsonb`;
  const pm = last(asUser(U.b, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, mentions, client_msg_id) values ('${s.PRIV_B}', 'user', '${U.b}', '비밀 본문', ${ment([U.x, U.g, U.c, U.a])}, gen_random_uuid()::text) returning id`));
  const r = recipients(pm);
  o.pushOutsider = r.includes(U.x); o.pushGuestOutside = r.includes(U.g); o.pushMemberOutside = r.includes(U.c);
  o.pushMentionedParticipant = r.includes(U.a); o.pushParticipant = r.includes(U.e);
  // 공개 채널: 아직 안 들어간 조직원 멘션은 간다(읽을 수 있다), 게스트·조직 밖은 안 간다
  const qm = last(asUser(U.b, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, mentions, client_msg_id) values ('${s.PUB}', 'user', '${U.b}', '공개 본문', ${ment([U.d, U.g, U.x])}, gen_random_uuid()::text) returning id`));
  const r2 = recipients(qm);
  o.pushPubUnjoinedMember = r2.includes(U.d); o.pushPubGuest = r2.includes(U.g); o.pushPubOutsider = r2.includes(U.x);
  o.pushPubParticipantA = r2.includes(U.a);
  return { s, o };
}

let PRE, POST;
test('수정 전: 네 결함이 재현된다(빨강) — 정상 경로는 동작', { skip }, () => {
  PRE = observe('pre');
  const o = PRE.o;
  // 1
  assert.equal(o.guestBrowseSeesPub, true, '1 재현: 게스트 찾아보기에 공개 채널');
  assert.equal(o.guestJoin && o.guestRowInPub, true, '1 재현: 게스트가 공개 채널에 참여');
  assert.equal(o.guestWritesPub && o.guestReadsPub, true, '1 재현: 참여한 게스트가 공개 채널을 읽고 쓴다');
  // 2
  assert.equal(o.leftCreatorManage && o.leftCreatorHost, true, '2 재현: 나간 생성자가 관리자·방장');
  assert.equal(o.leftCreatorReaddsOther && o.leftCreatorReaddsSelf, true, '2 재현: 나간 생성자가 남·자기를 다시 넣는다');
  assert.equal(o.leftAdminManage && o.leftAdminHost && o.leftAdminReaddsSelf, true, '2 재현: 나간 채널 관리자가 다시 들어온다');
  // 3
  assert.equal(o.userSystemOk && o.userApproval, true, '3 재현: 사람이 system·approval_card 글을 넣는다');
  assert.equal(o.userRelayTo && o.userRelay && o.userRelayChain, true, '3 재현: 사람이 전달 표지를 넣는다');
  assert.equal(o.reportForged, false, '3 재현: 사람 명의 system 글은 신고되지 않는다');
  // 4
  assert.equal(o.pushOutsider && o.pushGuestOutside && o.pushMemberOutside, true, '4 재현: 비공개 채널 멘션 푸시가 채널 밖·조직 밖으로');
  assert.equal(o.pushPubGuest && o.pushPubOutsider, true, '4 재현: 공개 채널 멘션 푸시가 게스트·조직 밖으로');
});

test('새 마이그레이션 적용(그 뒤 파일이 있으면 순서대로 함께)', { skip }, () => {
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x) && x >= FIX).sort()) applyMig(f);
  POST = observe('post');
});

test('1. 게스트는 공개 채널을 찾아보거나 들어가지 못한다 — 멤버 참여·게스트의 초대 비공개 채널은 그대로', { skip }, () => {
  const o = POST.o;
  assert.equal(o.guestBrowseSeesPub, false, '게스트 찾아보기는 빈 목록');
  assert.equal(o.guestJoin, false, '게스트 참여 거절(msgr_forbidden)');
  assert.equal(o.guestRowInPub, false, '참여 행이 생기지 않는다');
  assert.equal(o.guestWritesPub, false, '공개 채널에 못 쓴다');
  assert.equal(o.guestReadsPub, false, '공개 채널을 못 읽는다');
  for (const k of ['memberBrowseSeesPub2', 'memberJoin', 'guestPrivRead', 'guestPrivWrite', 'guestJoinPrivRefused']) {
    assert.equal(o[k], true, `정상 경로 ${k} (수정 뒤)`); assert.equal(PRE.o[k], true, `정상 경로 ${k} (수정 전)`);
  }
});

test('2. 나간 생성자·채널 관리자는 관리·재입장을 못 한다 — 참여 중인 방장·조직 관리자는 그대로', { skip }, () => {
  const o = POST.o;
  assert.equal(o.leftCreatorManage, false, '나간 생성자 msgr_can_manage_channel');
  assert.equal(o.leftCreatorHost, false, '나간 생성자 msgr_is_channel_host');
  assert.equal(o.leftCreatorReaddsOther, false, '나간 생성자가 남을 넣지 못한다');
  assert.equal(o.leftCreatorReaddsSelf, false, '나간 생성자가 자기를 넣지 못한다');
  assert.equal(o.leftAdminManage, false, '나간 채널 관리자 msgr_can_manage_channel');
  assert.equal(o.leftAdminHost, false, '나간 채널 관리자 msgr_is_channel_host');
  assert.equal(o.leftAdminReaddsSelf, false, '나간 채널 관리자가 자기를 넣지 못한다');
  assert.equal(memberRow(POST.s.PRIV_C, U.c), '0'); assert.equal(memberRow(POST.s.PRIV_C, U.e), '0'); assert.equal(memberRow(POST.s.PRIV_D, U.d), '0');
  for (const k of ['creatorAdds', 'creatorHost', 'chanAdminManage', 'chanAdminHost', 'chanAdminAdds', 'orgAdminManagesUnjoined', 'orgAdminHostUnjoined']) {
    assert.equal(o[k], true, `정상 경로 ${k} (수정 뒤)`); assert.equal(PRE.o[k], true, `정상 경로 ${k} (수정 전)`);
  }
  assert.equal(o.plainMemberManage, false, '생성자·관리자 아닌 참여자는 전후 모두 관리 못 함'); assert.equal(PRE.o.plainMemberManage, false);
});

test('3. 사람은 text 글만, 전달 표지 없이 쓴다 — 사람 명의 system 글은 신고된다', { skip }, () => {
  const o = POST.o;
  assert.ok(deniedRls(o.userSystem), `system 글 거절: ${o.userSystem.stderr}`);
  assert.equal(o.userApproval, false, 'approval_card 거절');
  assert.equal(o.userRelayTo, false, 'meta.relay_to 거절');
  assert.equal(o.userRelay, false, 'meta.relay 거절');
  assert.equal(o.userRelayChain, false, 'meta.relay_chain_id 거절');
  for (const k of ['userText', 'userTextExplicit', 'userOtherMeta', 'reportServerSysRefused', 'reportOwnForgedRefused']) {
    assert.equal(o[k], true, `정상 경로 ${k} (수정 뒤)`); assert.equal(PRE.o[k], true, `정상 경로 ${k} (수정 전)`);
  }
  assert.equal(o.reportForged, true, '사람 명의 system 글은 신고된다');
  assert.match(o.reportOwnErr, /msgr_report_own/, '자기 글은 자기 글이라서 거절');
});

test('3. 에이전트(author_kind=crew) system·approval_card 글은 그대로 들어간다(크루 주인 RLS 경로)', { skip }, () => {
  const s = POST.s;
  const crew = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.a}', 'ws-sec', 'sec', '보안') returning id`));
  asUser(U.a, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${s.PUB}', 'crew', '${crew}', '${U.a}')`);
  const root = last(asUser(U.a, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, mentions, client_msg_id) values ('${s.PUB}', 'user', '${U.a}', '부탁', '[{"kind":"crew","id":"${crew}"}]'::jsonb, gen_random_uuid()::text) returning id`));
  for (const kind of ['system', 'approval_card', 'text']) {
    const r = asUserRaw(U.a, `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, reply_to, thread_root, client_msg_id) values ('${s.PUB}', 'crew', '${crew}', '${kind}', '안내', ${root}, ${root}, gen_random_uuid()::text) returning id`);
    assert.equal(r.status, 0, `크루 ${kind} 글: ${r.stderr}`);
  }
});

test('3. 서버 정의자 함수가 넣는 사람 명의 system 글은 정책을 거치지 않는다(msgr_dm_relay 등 — 소유자·정의자 확인)', { skip }, () => {
  // 정책으로 막아도 서버 경로가 그대로인 근거: msgr_messages에 insert하는 public 함수는 전부 security definer이고 테이블 소유자가 같으며 FORCE RLS가 아니다.
  const bad = sql(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosrc ~* 'insert\\s+into\\s+(public\\.)?msgr_messages'
      and (not p.prosecdef or p.proowner <> (select relowner from pg_class where oid = 'public.msgr_messages'::regclass))`);
  assert.equal(bad, '', `invoker이거나 소유자가 다른 insert 함수: ${bad}`);
  assert.equal(sql(`select relforcerowsecurity from pg_class where oid = 'public.msgr_messages'::regclass`), 'f');
  assert.ok(Number(sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msgr_dm_relay' and p.prosecdef`)) === 1, 'msgr_dm_relay는 정의자');
});

test('4. 푸시는 그 채널을 읽을 수 있는 사람에게만 — 참여자·읽을 수 있는 멘션은 그대로', { skip }, () => {
  const o = POST.o;
  assert.equal(o.pushOutsider, false, '조직 밖 멘션');
  assert.equal(o.pushGuestOutside, false, '채널 밖 게스트 멘션');
  assert.equal(o.pushMemberOutside, false, '비공개 채널 밖 조직원 멘션');
  assert.equal(o.pushPubGuest, false, '공개 채널 게스트 멘션');
  assert.equal(o.pushPubOutsider, false, '공개 채널 조직 밖 멘션');
  for (const k of ['pushMentionedParticipant', 'pushParticipant', 'pushPubUnjoinedMember', 'pushPubParticipantA']) {
    assert.equal(o[k], true, `정상 경로 ${k} (수정 뒤)`); assert.equal(PRE.o[k], true, `정상 경로 ${k} (수정 전)`);
  }
});

test('4. 수신자 판정 = 그 사람으로 msgr_can_read_channel(채널 4종 × 사용자 7명, 모두 멘션)', { skip }, () => {
  // 두 판정(푸시 함수의 인라인 조건, msgr_can_read_channel)이 갈라지면 여기서 빨강이 된다.
  const s = POST.s;
  // 개인 1:1(조직 없음)도 넣는다 — a·x 친구
  asUser(U.a, `select public.msgr_friend_request('${U.x}')`); asUser(U.x, `select public.msgr_friend_decide('${U.a}', true)`);
  const personal = last(asUser(U.a, `select public.msgr_dm_personal('${U.x}')`));
  sql(`update public.msgr_channels set excluded_user_ids = array['${U.d}']::uuid[] where id = '${s.PUB}'`); // 제외된 조직원 — 공개 갈래의 제외 조건
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${s.PRIV_G}', 'user', '${U.x}')`); // 조직 밖인데 참여 행만 남은 사람 — 참여 갈래의 조직 조건
  const all = Object.values(U);
  const ment = `'${JSON.stringify(all.map((id) => ({ kind: 'user', id })))}'::jsonb`;
  for (const [name, ch, author] of [['PUB', s.PUB, U.b], ['PRIV_B', s.PRIV_B, U.b], ['PRIV_G', s.PRIV_G, U.a], ['personal', personal, U.a]]) {
    const mid = last(asUser(author, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, mentions, client_msg_id) values ('${ch}', 'user', '${author}', '모두', ${ment}, gen_random_uuid()::text) returning id`));
    const expected = all.filter((u) => u !== author && canRead(u, ch)).sort();
    assert.deepEqual(recipients(mid).sort(), expected, `${name}: 수신자 = 읽을 수 있는 사람`);
    if (name === 'PUB') assert.ok(!expected.includes(U.d) && !expected.includes(U.g), 'PUB: 제외된 d·게스트 g는 못 읽는다(표가 그 칸을 실제로 담는지)');
    if (name === 'PRIV_G') assert.ok(!expected.includes(U.x) && expected.includes(U.g), 'PRIV_G: 참여 행만 남은 조직 밖 x는 못 읽고, 초대받은 게스트 g는 읽는다');
  }
});
