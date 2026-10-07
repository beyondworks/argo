// 예전 조직 1:1 보관(20261008103000_msgr_legacy_dm_archive.sql, 유건 결정 2026-10-08 1-②) — 고른 방·백업·멱등·되돌리기를 실제 Postgres에서 잰다.
//  보관: 사람 = 주인 한 명 + 에이전트 = 그 주인의 본체 에이전트 한 명인 조직 DM, 같은 에이전트(주인·회사·slug)의 활성 개인 행이 있을 때만.
//  그대로: 남이 낀 방·그룹·친구 1:1·개인 공간 방·외부 봇 방(결정 1-④)·개인 행이 없는(또는 회사가 다른·멈춘) 에이전트·이미 보관한 방.
// 글은 지우지 않고(보관 뒤에도 주인이 읽는다), 새 글은 서버가 막는다(msgr_can_write_channel). 두 번 돌려도 바뀌는 것이 없다(행 xmin 불변).
// 실행: bash scripts/billing-pg-drill.sh test/msgr-legacy-dm-archive-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-legacy-dm-archive-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
// 이름 끝으로 찾는다 — 적용은 앱이 사용자에게 간 뒤라, 그 사이 더 새 마이그레이션이 운영에 적용되면 scripts/msgr-live-apply.sh가 이 파일을 거부한다
// (더 새 버전이 기록돼 있으면 거부). 적용 직전에 파일 이름의 버전만 다시 매기면 이 테스트는 그대로 돈다(검수 #857 LOW).
const FIX = readdirSync(mig('')).filter((f) => f.endsWith('_msgr_legacy_dm_archive.sql')).sort().pop();
assert.ok(FIX, 'supabase/migrations/*_msgr_legacy_dm_archive.sql 이 있어야 한다');
const U = {
  a: '11111111-1111-4111-8111-111111111111', // 조직 owner — 본체 에이전트 여럿
  b: '22222222-2222-4222-8222-222222222222', // member — 자기 에이전트 1:1 하나
  c: '33333333-3333-4333-8333-333333333333', // member — 옛 본체(개인 행 없음)
};
function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim(); // 슈퍼유저 — 시드·관찰 전용
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asUser = (uid, q) => { const r = asUserRaw(uid, q); if (r.status !== 0) throw new Error(`psql 실패(${uid.slice(0, 2)}): ${r.stderr}`); return r.stdout.trim(); };
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const applyMig = (f) => psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);

let ORG; const R = {}; // 방 이름 → id
const crew = (org, owner, ws, slug, hosting = 'local', status = 'active') => {
  const pre = hosting === 'bot' ? `select set_config('msgr.bot_create', '1', false); ` : '';
  const allow = org ? 'all' : 'owner';
  return last(sql(`${pre}insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow)
    values (${org ? `'${org}'` : 'null'}, '${owner}', '${ws}', '${slug}', '${slug}', '${hosting}', '${status}', '${allow}') returning id`));
};
// 조직 DM을 운영과 같은 모양으로(행 + 구성원) — 같은 쌍의 방이 둘인 경우(운영 실측: 페퍼 조직 1:1 두 개)도 만든다
const room = (name, members, { org = ORG, pair = null, archived = false, msgs = 2 } = {}) => {
  const id = last(sql(`insert into public.msgr_channels (org_id, kind, name, created_by, personal_pair)
    values (${org ? `'${org}'` : 'null'}, 'dm', 'dm:${name}', '${members.find(([k]) => k === 'user')[1]}', ${pair ? `'${pair}'` : 'null'}) returning id`));
  for (const [k, m] of members) sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${id}', '${k}', '${m}')`);
  const author = members.find(([k]) => k === 'user')[1];
  for (let i = 0; i < msgs; i++) sql(`insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body) values ('${id}', 'user', '${author}', 'text', 'm${i}')`);
  if (archived) sql(`update public.msgr_channels set archived_at = now() - interval '3 days' where id = '${id}'`); // 글을 쓴 뒤에 보관(보관한 DM에는 새 글이 막힌다)
  R[name] = id; return id;
};
const archivedOf = (name) => sql(`select archived_at is not null from public.msgr_channels where id = '${R[name]}'`);
const SHOULD = ['a-pepper', 'a-pepper-2', 'b-shuri'];
const KEEP = ['a-max-noprow', 'a-bot', 'a-pepper-plus-b', 'a-group', 'b-with-a-crew', 'a-pepper-personal', 'ab-friend', 'a-otherws', 'a-detached-prow', 'c-old-desktop', 'a-pepper-archived'];

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
  for (const f of files.filter((x) => x < FIX)) applyMig(f); // 이 파일 직전까지 — 실제 적용 순서대로
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 20 where org_id = '${ORG}'`);
  for (const u of [U.b, U.c]) {
    const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.a}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  // 에이전트 행 — 조직 행과 같은 에이전트의 개인 행(주인·회사·slug가 같다)
  const pepper = crew(ORG, U.a, 'ws-a', 'pepper'); const pepperP = crew(null, U.a, 'ws-a', 'pepper');
  const max = crew(ORG, U.a, 'ws-a', 'max'); // 개인 행 없음
  const bot = crew(ORG, U.a, 'bot', 'bot-pepperv', 'bot'); crew(null, U.a, 'bot', 'bot-pepperv', 'bot'); // 외부 봇 + 개인 쌍둥이(결정 1-④: 별개 에이전트, 보관하지 않는다)
  const yoda = crew(ORG, U.a, 'ws-a', 'yoda'); crew(null, U.a, 'ws-other', 'yoda'); // 개인 행이 다른 회사 — 같은 에이전트가 아니다
  const walt = crew(ORG, U.a, 'ws-a', 'walt'); crew(null, U.a, 'ws-a', 'walt', 'local', 'detached'); // 개인 행이 멈춤
  const shuri = crew(ORG, U.b, 'ws-b', 'shuri'); crew(null, U.b, 'ws-b', 'shuri');
  crew(null, U.b, 'ws-a', 'pepper'); // b에게 a의 페퍼와 같은 회사·slug 개인 행이 있어도(가져오기 등) a의 에이전트는 b의 것이 아니다 — 주인 확인만이 'b-with-a-crew'를 가른다
  const kar = crew(ORG, U.c, 'ws-c', 'carmack'); // 옛 본체 — 조직 행만
  // 방
  // 대상: 주인 + 자기 에이전트 — 하나는 실제 앱 경로(msgr_create_channel), 같은 쌍의 두 번째 방은 운영 실측 모양(직접 행)
  R['a-pepper'] = last(asUser(U.a, `select public.msgr_create_channel('${ORG}', 'dm', 'dm:pepper', '[{"kind":"crew","id":"${pepper}"}]'::jsonb)`));
  for (let i = 0; i < 3; i++) sql(`insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body) values ('${R['a-pepper']}', 'user', '${U.a}', 'text', 'p${i}')`);
  room('a-pepper-2', [['user', U.a], ['crew', pepper]], { msgs: 5 });
  room('b-shuri', [['user', U.b], ['crew', shuri]], { msgs: 1 });
  // 그대로 둘 방
  room('a-max-noprow', [['user', U.a], ['crew', max]]);
  room('a-bot', [['user', U.a], ['crew', bot]]);
  room('a-pepper-plus-b', [['user', U.a], ['user', U.b], ['crew', pepper]]); // 남이 낀 방
  room('a-group', [['user', U.a], ['crew', pepper], ['crew', max]]); // 그룹(에이전트 둘)
  room('b-with-a-crew', [['user', U.b], ['crew', pepper]]); // 남의 에이전트와 단둘(주인이 아니다)
  room('a-pepper-personal', [['user', U.a], ['crew', pepperP]], { org: null, pair: `crew:${pepperP}` }); // 개인 공간 1:1
  room('ab-friend', [['user', U.a], ['user', U.b]], { org: null, pair: [U.a, U.b].sort().join(':') }); // 친구 1:1
  room('a-otherws', [['user', U.a], ['crew', yoda]]);
  room('a-detached-prow', [['user', U.a], ['crew', walt]]);
  room('c-old-desktop', [['user', U.c], ['crew', kar]]);
  room('a-pepper-archived', [['user', U.a], ['crew', pepper]], { archived: true });
});

test('적용 전: 대상 방은 보관 안 됨, 백업 표 없음 — 시드가 의도한 모양인지', { skip }, () => {
  for (const n of [...SHOULD, ...KEEP.filter((x) => x !== 'a-pepper-archived')]) assert.equal(archivedOf(n), 'f', n);
  assert.equal(archivedOf('a-pepper-archived'), 't');
  assert.equal(sql(`select to_regclass('public.msgr_legacy_dm_archive_backup') is null`), 't');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${R['a-pepper']}'`), '2', '앱 경로로 만든 1:1 = 사람 1 + 에이전트 1');
});

let before1;
test('적용: 주인 + 자기 본체 에이전트(개인 행 있음)인 조직 1:1만 보관하고, 바꾸기 전에 백업 표에 적는다', { skip }, () => {
  const msgsBefore = sql(`select count(*) from public.msgr_messages`);
  applyMig(FIX);
  for (const n of SHOULD) assert.equal(archivedOf(n), 't', `보관 대상 ${n}`);
  for (const n of KEEP.filter((x) => x !== 'a-pepper-archived')) assert.equal(archivedOf(n), 'f', `그대로 ${n}`);
  const archivedBefore = sql(`select archived_at < now() - interval '1 day' from public.msgr_channels where id = '${R['a-pepper-archived']}'`);
  assert.equal(archivedBefore, 't', '이미 보관한 방의 보관 시각은 그대로');
  const backup = sql(`select string_agg(channel_id || '|' || coalesce(prev_archived_at::text, 'NULL') || '|' || msg_count, ',' order by msg_count) from public.msgr_legacy_dm_archive_backup`);
  assert.equal(backup, [`${R['b-shuri']}|NULL|1`, `${R['a-pepper']}|NULL|3`, `${R['a-pepper-2']}|NULL|5`].join(','), '대상 셋만, 보관 전 값·글 수');
  assert.equal(sql(`select count(*) from public.msgr_channels c join public.msgr_legacy_dm_archive_backup b on b.channel_id = c.id where c.archived_at = b.archived_at`), '3', '백업의 보관 시각 = 방에 넣은 값(되돌리기가 이것을 본다)');
  assert.equal(sql(`select count(*) from public.msgr_messages`), msgsBefore, '글은 하나도 지우지 않는다');
  before1 = sql(`select string_agg(id || ':' || xmin, ',' order by id) from public.msgr_channels`);
});

test('보관 뒤: 주인은 옛 글을 읽고, 새 글은 서버가 막는다 — 개인 공간 1:1에는 그대로 쓴다', { skip }, () => {
  assert.equal(asUser(U.a, `select count(*) from public.msgr_messages where channel_id = '${R['a-pepper']}'`), '3', '읽기 유지');
  assert.equal(asUser(U.a, `select public.msgr_can_write_channel('${R['a-pepper']}')`), 'f');
  const w = asUserRaw(U.a, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body) values ('${R['a-pepper']}', 'user', '${U.a}', 'text', 'late')`);
  assert.notEqual(w.status, 0, '보관한 방에 새 글');
  assert.equal(asUser(U.a, `select public.msgr_can_write_channel('${R['a-pepper-personal']}')`), 't', '개인 1:1은 쓴다');
});

test('백업 표는 사용자에게 열려 있지 않다', { skip }, () => {
  const r = asUserRaw(U.a, `select count(*) from public.msgr_legacy_dm_archive_backup`);
  assert.notEqual(r.status, 0, 'authenticated는 백업 표를 못 읽는다');
  assert.match(r.stderr, /permission denied/);
});

test('멱등: 두 번째 적용은 아무 행도 바꾸지 않는다(msgr_channels xmin·백업 불변)', { skip }, () => {
  const backupBefore = sql(`select string_agg(channel_id || ':' || archived_at || ':' || recorded_at || ':' || xmin, ',' order by channel_id) from public.msgr_legacy_dm_archive_backup`);
  applyMig(FIX);
  assert.equal(sql(`select string_agg(id || ':' || xmin, ',' order by id) from public.msgr_channels`), before1, '방 행을 다시 쓰지 않는다');
  assert.equal(sql(`select string_agg(channel_id || ':' || archived_at || ':' || recorded_at || ':' || xmin, ',' order by channel_id) from public.msgr_legacy_dm_archive_backup`), backupBefore);
});

test('되돌리기 SQL(파일 주석): 이 마이그레이션이 보관한 방만 되살리고, 그 뒤 사람이 다시 보관한 방은 그대로', { skip }, () => {
  const text = readFileSync(mig(FIX), 'utf8');
  const m = text.match(/^-- 되돌리기[^\n]*\n((?:--\s{3}.*\n)+)/m);
  assert.ok(m, '되돌리기 SQL 주석이 있어야 한다');
  const undo = m[1].split('\n').map((l) => l.replace(/^--\s{3}/, '')).join('\n');
  sql(`update public.msgr_channels set archived_at = now() + interval '1 minute' where id = '${R['b-shuri']}'`); // 사람이 그 뒤에 직접 다시 보관(값이 바뀜)
  psql(['-c', undo]);
  assert.equal(archivedOf('a-pepper'), 'f'); assert.equal(archivedOf('a-pepper-2'), 'f');
  assert.equal(archivedOf('b-shuri'), 't', '그 뒤에 바뀐 방은 되돌리지 않는다');
  assert.equal(archivedOf('a-pepper-archived'), 't', '원래 보관돼 있던 방은 손대지 않는다');
});
