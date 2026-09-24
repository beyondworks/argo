// 봇 getUpdates 유휴 게이트(20260914170000_msgr_bot_updates_idle_gate.sql) 행동 핀 — 실 Postgres.
// 라이브 실사고(2026-09-14): 봇 11개가 매초 전체 스캔 → Supabase CPU 80% 경고. 게이트 뒤에도 "새 글·멤버십·ack는 즉시"가 지켜져야 한다.
// 하네스는 msgr-dm-relay-pg.test.mjs와 같다(auth.uid() 스텁 + set role, _msgr 마이그레이션 전부 적용). ARGO_PG_TEST_URL 미설정이면 skip.
// 실행: `bash scripts/billing-pg-drill.sh test/msgr-bot-idle-gate-pg.test.mjs`
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222', member: '33333333-3333-4333-8333-333333333333' };

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asAnon = (q) => sql(`set role anon; ${q}`);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

let ORG, PUB, BOT, BOT_CREW, TOKEN;
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
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    create schema if not exists realtime;
    create table if not exists realtime.messages (id bigint generated always as identity primary key, topic text, extension text, payload jsonb);
    create table if not exists realtime.sent (id bigint generated always as identity primary key, payload jsonb, event text, topic text, private boolean);
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
      language sql as $$ insert into realtime.sent (payload, event, topic, private) values (payload, event, topic, private) $$;
    alter table realtime.messages enable row level security;
    grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema net;
    create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-f', mig(f)]);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((f) => /^\d+_msgr.*\.sql$/.test(f)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  if (process.env.ARGO_MUTATE_GATE) { // 변이 red 실증: 게이트 이전 정의로 되돌린다 → 유휴 핀이 빨개져야 한다
    const src = readFileSync(mig('20260913122421_msgr_dm_thread_delegation.sql'), 'utf8');
    const m = src.match(/create or replace function public\.msgr_bot_updates_before_work[\s\S]*?\nend \$\$;/);
    psql(['-c', m[0]]);
  }
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const [uid, role] of [[U.admin, 'admin'], [U.member, 'member']]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  PUB = last(asUser(U.owner, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'public', 'general', '${U.owner}') returning id`));
  const out = JSON.parse(last(asUser(U.admin, `select public.msgr_bot_create('${ORG}', 'hermes', '헤르메스', '외부 에이전트')`)));
  BOT = out.bot_id; BOT_CREW = out.crew_id; TOKEN = out.token;
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${PUB}', 'crew', '${BOT_CREW}')`); // 공개 채널도 초대된 에이전트만 받는다(2026-09-16)
});

const mention = () => JSON.stringify([{ kind: 'crew', id: BOT_CREW }]);
const post = (ch, body, mentions = '[]', u = U.owner) => last(asUser(u, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body, mentions) values ('${ORG}', '${ch}', 'user', '${u}', '${body}', '${mentions}'::jsonb) returning id`));
const updates = (after = 0, fn = 'msgr_bot_updates_with_delivery') => asAnon(`select public.${fn}('${TOKEN}', ${after})`).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const seen = () => sql(`select b.last_seen_at::text || '|' || coalesce(b.scan_at::text, '') || '|' || c.xmin::text from public.msgr_bots b join public.msgr_crews c on c.id = b.crew_id where b.id = '${BOT}'`);
const cursor = () => sql(`select cursor_msg_id from public.msgr_crews where id = '${BOT_CREW}'`);
let m1;

test('새 글은 즉시 온다 · ack 뒤엔 없다', { skip }, () => {
  post(PUB, '잡담');
  m1 = post(PUB, '@헤르메스 이거', mention());
  assert.deepEqual(updates().map((u) => String(u.update_id)), [m1]);
  assert.deepEqual(updates(m1), []); assert.equal(cursor(), m1, 'ack = 커서');
});

test('유휴 반복 호출은 전체 스캔을 건너뛴다(last_seen_at·크루 행 미갱신) — 게이트 없으면 red', { skip }, () => {
  updates(m1); // 지문 확정(직전 호출이 클레임한 실행 수까지 반영)
  const before = seen(); assert.match(before, /\|[^|]+\|/, 'scan_at 기록됨');
  for (let i = 0; i < 3; i++) assert.deepEqual(updates(m1), []);
  assert.equal(seen(), before, '유휴 호출 3번 동안 봇·크루 행에 쓰기 없음(dm_delivery_protocol 재기입 없음 포함)');
  // 옛 변형(일반 프로토콜)으로 바꾸면 지문의 프로토콜 성분이 달라져 한 번 스캔, 그 뒤 다시 유휴
  assert.deepEqual(updates(m1, 'msgr_bot_updates'), []);
  const before2 = seen(); assert.notEqual(before2, before, '변형 전환 = 지문 변화 → 한 번 스캔');
  for (let i = 0; i < 3; i++) assert.deepEqual(updates(m1, 'msgr_bot_updates'), []);
  assert.equal(seen(), before2, '일반 변형 유휴 호출 3번 동안 쓰기 없음');
});

test('새 글이 오면 게이트가 즉시 열린다', { skip }, () => {
  const m2 = post(PUB, '@헤르메스 하나 더', mention());
  assert.deepEqual(updates(m1).map((u) => String(u.update_id)), [m2]);
  assert.deepEqual(updates(m2), []); m1 = m2;
});

test('봇을 채널에 새로 넣으면 그 채널의 대기 멘션이 즉시 온다(멤버십도 지문)', { skip }, () => {
  const PRIV = last(asUser(U.admin, `select public.msgr_create_channel('${ORG}', 'private', 'secret')`));
  const s = post(PRIV, '@헤르메스 비밀', mention(), U.admin);
  assert.deepEqual(updates(m1), [], '멤버 아닌 채널');
  assert.deepEqual(updates(m1), [], '유휴');
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'crew', '${BOT_CREW}', '${U.admin}')`);
  assert.deepEqual(updates(m1).map((u) => String(u.update_id)), [s]);
  assert.deepEqual(updates(s), []); m1 = s;
});

test('30초가 지나면 전체 스캔이 한 번 돈다(시간 의존 규칙의 상한)', { skip }, () => {
  updates(m1); const before = seen();
  sql(`update public.msgr_bots set scan_at = now() - interval '31 seconds' where id = '${BOT}'`);
  assert.deepEqual(updates(m1), []);
  assert.notEqual(seen().split('|')[0], before.split('|')[0], 'last_seen_at 갱신 = 전체 스캔');
});

test('지문 밖 상태(크루 status)로 막힌 글은 풀어도 30초 게이트를 타고, 31초 뒤 전체 스캔이 배달한다', { skip }, () => {
  sql(`update public.msgr_crews set status = 'detached' where id = '${BOT_CREW}'`);
  const held = post(PUB, '@헤르메스 멈춘 동안', mention());
  assert.deepEqual(updates(m1), [], '비활성 크루엔 배달 없음(새 글이라 전체 스캔은 돌았다)');
  sql(`update public.msgr_crews set status = 'active' where id = '${BOT_CREW}'`);
  assert.deepEqual(updates(m1), [], 'status는 지문 밖 → 게이트 유지(게이트 없으면 여기서 도착해 red)');
  sql(`update public.msgr_bots set scan_at = now() - interval '31 seconds' where id = '${BOT}'`);
  assert.deepEqual(updates(m1).map((u) => String(u.update_id)), [held], '30초 상한이 실제로 풀어준다');
  assert.deepEqual(updates(held), []); m1 = held;
});

test('ack가 커서보다 앞서면 게이트를 우회해 커서를 올린다', { skip }, () => {
  const plain = post(PUB, '봇에게 안 온 글'); // 지문 변화 → 한 번 스캔
  assert.deepEqual(updates(m1), []); assert.deepEqual(updates(m1), []);
  assert.equal(cursor(), m1);
  assert.deepEqual(updates(plain), []); assert.equal(cursor(), plain, '유휴 중에도 ack는 반영');
});

// 2026-09-23 VPS 응답 지연(픽업 중앙값 614초): 받을 글이 없는 봇은 ack가 없어 커서가 0에 머물렀고, 매 스캔마다 조직 글 451건을
// 배달 판정 함수로 다시 훑다가 3초 statement_timeout에 걸렸다(봇당 하루 약 200회). 아무것도 못 준 전체 스캔이면
// 10분 넘은 글까지 커서를 넘긴다 — 최근 10분 안의 대기 글(초대 직후 배달·순서 대기)은 종전대로 남는다.
test('아무것도 못 준 전체 스캔은 10분 넘은 글까지 커서를 넘긴다(최근 글은 남긴다)', { skip }, () => {
  const old = post(PUB, '봇과 무관한 옛 글');
  sql(`update public.msgr_messages set created_at = now() - interval '11 minutes' where id = ${old}`);
  const fresh = post(PUB, '봇과 무관한 새 글');
  assert.deepEqual(updates(m1), []);
  assert.equal(cursor(), old, '옛 글까지만 전진 — 새 글은 커서 뒤에 남는다');
  assert.ok(Number(fresh) > Number(cursor()));
  assert.deepEqual(updates(old), []); m1 = old;
});

test('배달한 스캔에서는 커서를 ack 밖으로 넘기지 않는다', { skip }, () => {
  const stale = post(PUB, '무관 글');
  sql(`update public.msgr_messages set created_at = now() - interval '11 minutes' where id = ${stale}`);
  const want = post(PUB, '@헤르메스 받아', mention());
  assert.deepEqual(updates(m1).map((u) => String(u.update_id)), [want]);
  assert.equal(cursor(), m1, '돌려준 글이 있으면 커서는 ack만 따른다');
  assert.deepEqual(updates(want), []); m1 = want;
});

// 검수 #689 HIGH-1·MEDIUM-1 재현 핀: 커서 전진이 "나중에 배달될 수 있는 글"을 건너뛰면 안 된다.
const age = (id, iv) => sql(`update public.msgr_messages set created_at = now() - interval '${iv}' where id = ${id}`);
const rescan = () => sql(`update public.msgr_bots set scan_at = now() - interval '31 seconds' where id = '${BOT}'`);
test('A: 파견 해제 중 받은 멘션은 10분이 넘어도 재개 뒤 배달된다', { skip }, () => {
  sql(`update public.msgr_crews set status = 'detached' where id = '${BOT_CREW}'`);
  const held = post(PUB, '@헤르메스 멈춘 동안', mention()); age(held, '11 minutes');
  assert.deepEqual(updates(m1), []);
  sql(`update public.msgr_crews set status = 'active' where id = '${BOT_CREW}'`); rescan();
  assert.deepEqual(updates(m1).map((u) => String(u.update_id)), [held]);
  assert.deepEqual(updates(held), []); m1 = held;
});
test('B: 초대 전 멘션은 10분이 넘어도 초대 뒤 배달된다(방장 결재가 늦는 경우)', { skip }, () => {
  const PRIV2 = last(asUser(U.admin, `select public.msgr_create_channel('${ORG}', 'private', 'late-invite')`));
  const s = post(PRIV2, '@헤르메스 비밀', mention(), U.admin); age(s, '11 minutes');
  assert.deepEqual(updates(m1), []);
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV2}', 'crew', '${BOT_CREW}', '${U.admin}')`);
  assert.deepEqual(updates(m1).map((u) => String(u.update_id)), [s]);
  assert.deepEqual(updates(s), []); m1 = s;
});
test('C: 과거 시각(created_at)으로 넣은 글이 최근 대기 글을 건너뛰게 하지 못한다', { skip }, () => {
  const PRIV3 = last(asUser(U.admin, `select public.msgr_create_channel('${ORG}', 'private', 'backdate')`));
  const fresh = post(PRIV3, '@헤르메스 방금', mention(), U.admin);
  last(asUser(U.member, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body, created_at) values ('${ORG}', '${PUB}', 'user', '${U.member}', 'backdated', now() - interval '1 day') returning id`));
  assert.deepEqual(updates(m1), []);
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV3}', 'crew', '${BOT_CREW}', '${U.admin}')`);
  assert.deepEqual(updates(m1).map((u) => String(u.update_id)), [fresh]);
  assert.deepEqual(updates(fresh), []); m1 = fresh;
});

// 재검수 #689 HIGH-2 재현 핀(D): 진행 중 트랜잭션의 멘션은 id가 먼저 잡히고 늦게 보인다 — 그 사이 빈 스캔이 커서를 그 id 너머로 넘기면 영영 못 받는다.
test('D: 늦게 커밋된 멘션(낮은 id)은 그 사이 빈 스캔이 있어도 커밋 뒤 배달된다', { skip }, async () => {
  const old = post(PUB, '옛 무관 글'); age(old, '11 minutes');
  const slow = spawn('psql', [DB, '-X', '-q', '-c', `begin; set role authenticated; select set_config('argo.uid', '${U.owner}', true); insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body, mentions) values ('${ORG}', '${PUB}', 'user', '${U.owner}', '@헤르메스 느린 커밋', '${mention()}'::jsonb); select pg_sleep(3); commit;`]);
  const done = new Promise((r) => slow.on('exit', r));
  await new Promise((r) => setTimeout(r, 1200));
  post(PUB, '빠른 무관 글');
  rescan(); assert.deepEqual(updates(m1), [], '보이는 글 중엔 받을 게 없다');
  assert.equal(await done, 0);
  const x = sql(`select id from public.msgr_messages where body = '@헤르메스 느린 커밋'`);
  rescan(); assert.deepEqual(updates(m1).map((u) => String(u.update_id)), [x], '커서가 느린 멘션을 넘기지 않았다');
  assert.deepEqual(updates(x), []); m1 = x;
});

// 재검수 #689 MEDIUM-4 재현 핀(F): 1:1의 크루 자기 답글은 이 크루를 겨냥한 글이 아니다 — 7일 동안 커서를 묶으면 매 스캔이 다시 전체를 훑는다.
test('F: 1:1의 크루 자기 답글·지운 글은 커서를 묶지 않는다', { skip }, () => {
  const dm = last(sql(`insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'dm', 'dm-f', '${U.owner}') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${dm}', 'user', '${U.owner}'), ('${dm}', 'crew', '${BOT_CREW}')`);
  sql(`insert into public.msgr_messages (org_id, channel_id, author_kind, crew_id, body) values ('${ORG}', '${dm}', 'crew', '${BOT_CREW}', '내 답글')`);
  const gone = post(PUB, '@헤르메스 지울 글', mention()); sql(`update public.msgr_messages set deleted_at = now() where id = ${gone}`);
  const later = [1, 2, 3].map((i) => post(PUB, `무관 ${i}`));
  sql(`update public.msgr_messages set created_at = now() - interval '11 minutes' where id > ${m1}`);
  rescan(); updates(m1);
  assert.equal(cursor(), later[2], '무관한 글 끝까지 넘겼다');
});

// 재검수 #689 LOW 재현 핀(R): 멤버가 과거 시각으로 넣은 글이 "10분 넘은 글" 기준이 되면, 그 사이 진행 중이던 멘션(낮은 id)을 커서가 넘겼다.
// 삽입 시각을 서버가 정하면(20260924130000) 그 글은 최근 글이 되어 커서가 움직이지 않는다.
test('R: 과거 시각으로 넣은 글과 늦게 커밋된 멘션이 겹쳐도 멘션은 배달된다', { skip }, async () => {
  const slow = spawn('psql', [DB, '-X', '-q', '-c', `begin; set role authenticated; select set_config('argo.uid', '${U.owner}', true); insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body, mentions) values ('${ORG}', '${PUB}', 'user', '${U.owner}', '@헤르메스 느린2', '${mention()}'::jsonb); select pg_sleep(3); commit;`]);
  const done = new Promise((r) => slow.on('exit', r));
  await new Promise((r) => setTimeout(r, 1200));
  const back = last(asUser(U.member, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body, created_at) values ('${ORG}', '${PUB}', 'user', '${U.member}', 'backdated2', now() - interval '1 day') returning id`));
  assert.equal(sql(`select created_at > now() - interval '1 minute' from public.msgr_messages where id = ${back}`), 't', '삽입 시각은 서버가 정한다');
  rescan(); updates(m1);
  assert.equal(await done, 0);
  const x = sql(`select id from public.msgr_messages where body = '@헤르메스 느린2'`);
  rescan(); assert.deepEqual(updates(m1).map((u) => String(u.update_id)), [x], '느린 멘션이 배달된다');
  assert.deepEqual(updates(x), []); m1 = x;
});

// 2026-09-24 라이브 실측: 배달 판정(msgr_delivery_allowed)이 커서 뒤 글이 아니라 조직 글 전부에 불려 봇당 714ms → 봇 11개 동시 스캔이
// 3초 statement timeout에 걸려 VPS 봇 첫 반응이 30~50초였다. 판정 횟수를 세어, 커서 아래 옛 글에는 판정이 불리지 않음을 잠근다.
test('S: 스캔의 배달 판정은 커서 뒤 후보에만 불린다(조직 옛 글 전부에 부르지 않는다)', { skip }, () => {
  const old = Number(sql(`select count(*) from public.msgr_messages where org_id = '${ORG}' and id <= ${m1}`));
  assert.ok(old >= 20, `옛 글이 충분해야 의미가 있다: ${old}`);
  sql(`create sequence if not exists public.spy_delivery_calls;
       alter function public.msgr_delivery_allowed(uuid, bigint) rename to msgr_delivery_allowed_real;
       create function public.msgr_delivery_allowed(p_crew uuid, p_source bigint) returns boolean language plpgsql security definer set search_path = public, pg_temp as $f$
       begin perform nextval('public.spy_delivery_calls'); return public.msgr_delivery_allowed_real(p_crew, p_source); end $f$;
       grant execute on function public.msgr_delivery_allowed(uuid, bigint) to anon, authenticated, service_role;`);
  try {
    const fresh = post(PUB, '@헤르메스 스캔 범위', mention());
    const before = Number(sql(`select nextval('public.spy_delivery_calls')`));
    rescan();
    assert.deepEqual(updates(m1).map((u) => String(u.update_id)), [fresh]);
    const calls = Number(sql(`select nextval('public.spy_delivery_calls')`)) - before - 1;
    assert.ok(calls <= 10, `판정 ${calls}회 — 옛 글 ${old}개에 불리면 안 된다`);
    assert.deepEqual(updates(fresh), []); m1 = fresh;
  } finally {
    sql(`drop function public.msgr_delivery_allowed(uuid, bigint);
         alter function public.msgr_delivery_allowed_real(uuid, bigint) rename to msgr_delivery_allowed;`);
  }
});
