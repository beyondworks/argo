// 봇 파일 보내기(20260930160000) — 유건 2026-09-30 "헤르메스 포함 외부 에이전트랑 내부 에이전트 모두 파일 송수신 등이 가능해야해".
// 승인 기준: 봇의 답글·새 글에만 붙는다, 파일당 25MB, 봇이 글을 쓸 수 있는 방만, 첨부는 지우지 않는다. 첨부가 글보다 늦게 붙으면 'attach' 방송.
// 하네스는 msgr-ext-agent-contract-1b-pg와 같다(모든 msgr 마이그레이션 적용, auth.uid() 스텁). 실행: scripts/billing-pg-drill.sh <이 파일>
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
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz not null default now());
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


const q = (s) => s.replace(/'/g, "''");
const say = (bot, ch = PUB, body = '보고서입니다') => last(asAnon(`select public.msgr_bot_send('${bot.token}', '${ch}', '${q(body)}')`));
const prepareRaw = (bot, mid, name = '보고서 최종.pdf', bytes = 1234) => asAnonRaw(`select public.msgr_bot_attach_prepare('${bot.token}', ${mid}, '${q(name)}', ${bytes})`);
const prepare = (bot, mid, name, bytes) => { const r = prepareRaw(bot, mid, name, bytes); assert.equal(r.status, 0, r.stderr); return j(r.stdout).storage_path; };
const upload = (path, size = 1234, mime = 'application/pdf') => sql(`insert into storage.objects(bucket_id, name, metadata) values ('msgr', '${path}', '{"size": ${size}, "mimetype": "${mime}"}')`);
const commitRaw = (bot, mid, path, name = '보고서 최종.pdf', mime = null) => asAnonRaw(`select public.msgr_bot_attach_commit('${bot.token}', ${mid}, '${q(path)}', '${q(name)}', ${mime ? `'${mime}'` : 'null'})`);
const commit = (bot, mid, path, name, mime) => { const r = commitRaw(bot, mid, path, name, mime); assert.equal(r.status, 0, r.stderr); return last(r.stdout); };
const sent = (event, mid) => sql(`select coalesce(string_agg(topic, ',' order by topic), '') from realtime.sent where event = '${event}' and (payload->>'id')::bigint = ${mid}`);

test('내부 판정 함수는 직접 부를 수 없다', { skip }, () => {
  fails(asAnonRaw(`select public._msgr_bot_attach_target(null::public.msgr_bots, 1)`), /permission denied/, 'anon → 대상 판정');
});

// 기준 ①③ — 봇 자기 글에만, 그 방에 아직 있을 때만
test('준비는 봇 자기 글에만 경로를 주고(ASCII 키·글 폴더), DB에는 아무것도 쓰지 않는다', { skip }, () => {
  const mid = say(A);
  const before = sql(`select count(*) from msgr_attachments`);
  const path = prepare(A, mid, '보고서 [최종] v2.PDF');
  assert.match(path, new RegExp(`^${ORG}/${PUB}/${mid}/bot-[0-9a-f]{8}-v2\\.PDF$`), path);
  assert.match(prepare(A, mid, '데이터'), /\/bot-[0-9a-f]{8}-file$/, '한글만인 이름 → file');
  assert.match(prepare(A, mid, 'report.tar.gz'), /\/bot-[0-9a-f]{8}-report\.tar\.gz$/);
  assert.equal(sql(`select count(*) from msgr_attachments`), before, '준비는 쓰기 없음');
  const human = last(asUser(U.member, `insert into msgr_messages(channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.member}', 'hi') returning id`));
  fails(prepareRaw(A, human), /msgr_bot_bad_attach_target/, '사람 글');
  fails(prepareRaw(B, mid), /msgr_bot_bad_attach_target/, '다른 봇의 글');
  fails(prepareRaw(A, 999999999), /msgr_bot_bad_attach_target/, '없는 글');
});

// 기준 ② — 파일당 25MB
test('크기·이름·개수 상한', { skip }, () => {
  const mid = say(A);
  fails(prepareRaw(A, mid, 'big.zip', 26214401), /msgr_bot_file_too_large/, '25MB 초과');
  assert.ok(prepare(A, mid, 'edge.zip', 26214400), '정확히 25MB는 된다');
  fails(prepareRaw(A, mid, 'empty.txt', 0), /msgr_bot_bad_file_size/, '0바이트');
  fails(prepareRaw(A, mid, '  ', 10), /msgr_bot_bad_file_name/, '빈 이름');
  for (let i = 0; i < 10; i++) { const p = prepare(A, mid, `f${i}.txt`, 10); upload(p, 10, 'text/plain'); commit(A, mid, p, `f${i}.txt`); }
  fails(prepareRaw(A, mid, 'f10.txt', 10), /msgr_bot_too_many_files/, '글당 10개');
  const m2 = say(A);
  for (let i = 0; i < 10; i++) upload(prepare(A, m2, `u${i}.txt`, 10), 10, 'text/plain'); // 올리기만 하고 등록하지 않음
  fails(prepareRaw(A, m2, 'u10.txt', 10), /msgr_bot_too_many_files/, '등록 없이 올리기만 반복해도 글당 10개(검수 M2)');
});

test('1시간 지난 글과 방에서 빠진 봇은 붙일 수 없다', { skip }, () => {
  const old = say(A);
  sql(`update msgr_messages set created_at = now() - interval '61 minutes' where id = ${old}`);
  fails(prepareRaw(A, old), /msgr_bot_attach_expired/, '오래된 글');
  const mid = say(A);
  const path = prepare(A, mid); upload(path);
  sql(`delete from msgr_channel_members where channel_id = '${PUB}' and member_kind = 'crew' and member_id = '${A.crew_id}'`);
  try { fails(commitRaw(A, mid, path), /msgr_bot_not_member/, '방에서 빠짐'); }
  finally { sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${PUB}','crew','${A.crew_id}') on conflict do nothing`); }
});

test('등록은 저장소에 실제로 올라온 객체만, 크기는 저장소 값으로, 이름은 원문 그대로. 같은 경로 재등록은 같은 id', { skip }, () => {
  const mid = say(A);
  const path = prepare(A, mid, '보고서 최종.pdf', 10);
  fails(commitRaw(A, mid, path), /msgr_bot_upload_missing/, '올리기 전');
  upload(path, 4321, 'application/pdf');
  const id = commit(A, mid, path, '보고서 최종.pdf');
  assert.equal(sql(`select name||'|'||mime||'|'||bytes||'|'||org_id from msgr_attachments where id='${id}'`), `보고서 최종.pdf|application/pdf|4321|${ORG}`);
  assert.equal(commit(A, mid, path, '보고서 최종.pdf'), id, '재시도 안전');
  const other = say(A);
  fails(commitRaw(A, other, path), /msgr_bot_bad_attach_path/, '다른 글 폴더의 경로');
  fails(commitRaw(A, mid, `${ORG}/${PUB}/${mid}/../x`), /msgr_bot_bad_attach_path/, '경로 조작');
  // 멤버는 봇 첨부를 사람 첨부처럼 읽는다(RLS 그대로)
  assert.equal(last(asUser(U.member, `select count(*) from msgr_attachments where id='${id}'`)), '1');
});

// 앱 결함: 글 방송 직후 첨부를 읽어 늦게 붙은 첨부가 안 보였다 → 첨부 등록마다 'attach' 방송
test('첨부가 등록되면 글 방송과 같은 수신자에게 attach(글 id)를 보낸다 — 봇·사람 첨부 모두, 1:1 방은 사용자 토픽', { skip }, () => {
  const mid = say(A);
  const path = prepare(A, mid, 'a.txt', 3); upload(path, 3, 'text/plain'); commit(A, mid, path, 'a.txt');
  assert.equal(sent('attach', mid), `org:${ORG}`, '공개 채널 → 조직 토픽');
  const human = last(asUser(U.member, `insert into msgr_messages(channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.member}', 'file') returning id`));
  asUser(U.member, `insert into msgr_attachments(message_id, org_id, storage_path, name, bytes) values (${human}, '${ORG}', '${ORG}/${PUB}/${human}/0-x.txt', 'x.txt', 1)`);
  assert.equal(sent('attach', human), `org:${ORG}`, '사람 첨부도');
  const dm = last(sql(`insert into msgr_channels(org_id, kind, name, created_by) values ('${ORG}','dm','o','${U.owner}') returning id`));
  sql(`insert into msgr_channel_members(channel_id, member_kind, member_id) values ('${dm}','user','${U.owner}'), ('${dm}','crew','${A.crew_id}')`);
  const dmMsg = say(A, dm);
  const p2 = prepare(A, dmMsg, 'b.txt', 3); upload(p2, 3, 'text/plain'); commit(A, dmMsg, p2, 'b.txt');
  assert.equal(sent('attach', dmMsg), `u:${U.owner}`, '1:1 방 → 방 사람의 사용자 토픽만');
});

// 검수 M2 — 올리기만 하고 등록하지 않은 객체가 쌓이지 않게. SQL 삭제는 막혀 있어(protect_objects_delete) 엣지가 Storage API로 지운다.
test('준비는 이 봇이 2시간 넘게 등록하지 않은 업로드만 지울 목록(purge)으로 돌려준다 — 등록된 것·남의 것·최근 것은 빼고', { skip }, () => {
  const mine = say(A), theirs = say(B);
  const orphan = prepare(A, mine, 'old.pdf', 5); upload(orphan, 5);
  const kept = prepare(A, mine, 'kept.pdf', 5); upload(kept, 5); commit(A, mine, kept, 'kept.pdf');
  const fresh = prepare(A, mine, 'fresh.pdf', 5); upload(fresh, 5);
  const other = prepare(B, theirs, 'b.pdf', 5); upload(other, 5);
  sql(`update storage.objects set created_at = now() - interval '3 hours' where name in ('${orphan}', '${kept}', '${other}')`);
  const out = j(asAnon(`select public.msgr_bot_attach_prepare('${A.token}', ${say(A)}, 'x.txt', 1)`));
  assert.deepEqual(out.purge, [orphan], JSON.stringify(out.purge));
  assert.deepEqual(j(asAnon(`select public.msgr_bot_attach_prepare('${B.token}', ${say(B)}, 'x.txt', 1)`)).purge, [other]);
});

test('크루를 떼어 냈거나 조직이 잠기면 붙일 수 없다(msgr_bot_send와 같은 조건)', { skip }, () => {
  const mid = say(A);
  sql(`update msgr_crews set status = 'detached' where id = '${A.crew_id}'`);
  try { fails(prepareRaw(A, mid), /msgr_not_allowed/, '떼어 낸 크루'); }
  finally { sql(`update msgr_crews set status = 'active' where id = '${A.crew_id}'`); }
});

// 재검수 LOW — 정리 목록은 폴더의 조직·방까지 그 글과 같아야 한다(사람 업로드 정책은 글 id 칸을 보지 않는다)
test('다른 방 폴더에 이 봇 글 id로 올라간 객체는 정리 목록에 들어가지 않는다', { skip }, () => {
  const mid = say(A);
  const odd = `${ORG}/00000000-0000-4000-8000-000000000000/${mid}/bot-deadbeef-x.pdf`;
  sql(`insert into storage.objects(bucket_id, name, metadata, created_at) values ('msgr', '${odd}', '{"size":1}', now() - interval '3 hours')`);
  assert.ok(!j(asAnon(`select public.msgr_bot_attach_prepare('${A.token}', ${say(A)}, 'x.txt', 1)`)).purge.includes(odd));
});
