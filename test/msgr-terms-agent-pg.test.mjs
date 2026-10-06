// 용어 변경 T3(크루→에이전트, 20261006100000_msgr_terms_agent.sql) — 실 Postgres 행동 핀.
// 잠그는 것: (1) 세 함수의 권한·security definer·search_path는 마이그레이션 전과 같다(문자열만 바뀜).
//   (2) 외부 봇 경로의 AI 동의·무료 기간 안내가 새 문구로 올라간다. (3) A5 — 옛 문구 안내가 이미 있는 방(운영 DB에 옛 함수로 쌓인 행)에는
//   새 안내가 다시 올라가지 않고, 옛 행은 그대로다(client_msg_id 중복 방지는 본문과 무관, D1 — 옛 행 UPDATE 0).
//   (4) 일지의 이름 없는 대체 이름이 **에이전트**/← 에이전트. 하네스는 msgr-bot-idle-gate-pg.test.mjs와 같다.
// 변이 red: ARGO_SKIP_TERMS_MIG=1이면 이 마이그레이션을 빼고 적용한다 → 문구 단언이 빨개져야 한다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-terms-agent-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';
import { NOTICE } from './helpers/msgr-terms.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-terms-agent-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const TERMS_MIG = '20261006100000_msgr_terms_agent.sql';
const U = { owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222', member: '33333333-3333-4333-8333-333333333333' };

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asAnon = (q) => sql(`set role anon; ${q}`);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const FNS = ['msgr_bot_updates_before_work', '_msgr_bot_personal_updates', 'msgr_channel_journal'];
const meta = () => sql(`select string_agg(p.proname || '|' || p.prosecdef || '|' || coalesce(array_to_string(p.proconfig, ','), '') || '|' || coalesce(p.proacl::text, ''), E'\n' order by p.proname)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in (${FNS.map((f) => `'${f}'`).join(',')})`);
const BOTH = (k) => `${NOTICE[k].ko} / ${NOTICE[k].en}`;

let ORG, PUB, BOT_CREW, TOKEN, META_BEFORE, META_AFTER;
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
  const files = readdirSync(dir).filter((f) => /^\d+_msgr.*\.sql$/.test(f)).sort();
  assert.ok(files.includes(TERMS_MIG), '용어 마이그레이션이 msgr 묶음에 들어 있다');
  const apply = (f) => psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const f of files.filter((f) => f < TERMS_MIG)) apply(f);
  META_BEFORE = meta();
  for (const f of files.filter((f) => f >= TERMS_MIG)) if (!(process.env.ARGO_SKIP_TERMS_MIG && f === TERMS_MIG)) apply(f);
  META_AFTER = meta();
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const [uid, role] of [[U.admin, 'admin'], [U.member, 'member']]) {
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  const out = JSON.parse(last(asUser(U.admin, `select public.msgr_bot_create('${ORG}', 'hermes', '헤르메스', '외부 에이전트')`)));
  BOT_CREW = out.crew_id; TOKEN = out.token;
  PUB = newChannel('general'); // 봇을 만든 뒤에 — newChannel이 봇을 구성원으로 넣는다(공개 채널도 초대된 에이전트만 받는다)
  for (const uid of [U.owner, U.admin]) asUser(uid, `select public.msgr_set_ai_consent(true)`);
  asUser(U.member, `select public.msgr_set_ai_consent(false)`); // 동의 안 한 사람 — AI 동의 안내 경로
});

function newChannel(name) {
  const ch = last(asUser(U.owner, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'public', '${name}', '${U.owner}') returning id`));
  if (BOT_CREW) sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ch}', 'crew', '${BOT_CREW}')`);
  return ch;
}
const mention = () => JSON.stringify([{ kind: 'crew', id: BOT_CREW }]);
const post = (ch, body, u = U.owner) => last(asUser(u, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body, mentions) values ('${ORG}', '${ch}', 'user', '${u}', '${body}', '${mention()}'::jsonb) returning id`));
const updates = (after = 0) => asAnon(`select public.msgr_bot_updates_with_delivery('${TOKEN}', ${after})`).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const notices = (ch, key) => sql(`select coalesce(string_agg(body, E'\n' order by id), '') || '#' || count(*) from public.msgr_messages where channel_id = '${ch}' and client_msg_id = '${key}'`);

test('세 함수의 권한·security definer·search_path는 마이그레이션 전과 같다(문자열만 바뀜)', { skip }, () => {
  assert.equal(META_AFTER.split('\n').length, 3, '세 함수가 있다');
  assert.equal(META_AFTER, META_BEFORE);
  assert.match(META_AFTER, /msgr_bot_updates_before_work\|true\|search_path=public, ?pg_temp\|/);
});

test('세 함수의 라이브 정의(prosrc)에 옛 크루 문구가 없고 새 문구가 있다', { skip }, () => {
  const src = sql(`select string_agg(prosrc, E'\n') from pg_proc where proname in (${FNS.map((f) => `'${f}'`).join(',')})`);
  assert.doesNotMatch(src, /크루 작업이 멈췄습니다|크루에게 맡길|'크루'|crew work is paused|to a crew/);
  assert.equal(src.split(BOTH('consent')).length - 1, 2, 'AI 동의 안내 2곳(조직·개인)');
  assert.equal(src.split(BOTH('paused')).length - 1, 1, '무료 기간 안내 1곳');
  assert.equal(src.split("'에이전트')").length - 1, 2, '일지 대체 이름 2곳');
});

test('외부 봇 AI 동의 안내가 새 문구로 한 번만 올라간다', { skip }, () => {
  const key = `aiconsent:${BOT_CREW}:${PUB}`;
  post(PUB, '@헤르메스 해줘', U.member);
  assert.deepEqual(updates(), [], '동의하지 않은 글은 배달되지 않는다');
  assert.equal(notices(PUB, key), `${BOTH('consent')}#1`);
  post(PUB, '@헤르메스 또', U.member); updates();
  assert.equal(notices(PUB, key), `${BOTH('consent')}#1`, '두 번째는 같은 키라 다시 올라가지 않는다');
});

test('A5: 옛 문구 AI 동의 안내가 이미 있는 방에는 새 안내가 다시 올라가지 않고 옛 행도 그대로다', { skip }, () => {
  const ch = newChannel('old-consent');
  const key = `aiconsent:${BOT_CREW}:${ch}`;
  const OLD = '앱을 업데이트하고 AI 이용에 동의하면 크루에게 맡길 수 있습니다. / Update the app and agree to AI use to hand this to a crew.';
  const id = sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, client_msg_id, body, meta) values ('${ch}', 'crew', '${BOT_CREW}', 'system', '${key}', '${OLD}', '{"disposition":"done"}') returning id`);
  const xmin = sql(`select xmin from public.msgr_messages where id = ${id}`);
  post(ch, '@헤르메스 옛 안내가 있는 방', U.member);
  assert.deepEqual(updates(), []);
  assert.equal(notices(ch, key), `${OLD}#1`, '안내 1개, 옛 문구 그대로(중복·누락 없음)');
  assert.equal(sql(`select xmin from public.msgr_messages where id = ${id}`), xmin, '옛 행에 쓰기 없음(D1)');
});

test('외부 봇 무료 기간 안내가 새 문구로 올라가고, 옛 문구 안내가 있으면 다시 올라가지 않는다(A5)', { skip }, () => {
  const orig = sql(`select pg_get_functiondef('public.msgr_org_entitled(uuid)'::regprocedure)`);
  const keyOf = (ch) => sql(`select 'unentitled:${BOT_CREW}:${ch}:' || coalesce(extract(epoch from public.msgr_org_entitlement_marker('${ORG}'))::bigint::text, '')`);
  const fresh = newChannel('paused-new'), old = newChannel('paused-old');
  sql(`create or replace function public.msgr_org_entitled(org uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $$ select org <> '${ORG}'::uuid $$`);
  try {
    const OLD = '무료 기간이 끝나 이 조직의 크루 작업이 멈췄습니다. 조직 관리자에게 문의하세요. / The free period has ended, so crew work is paused for this organization. Contact your organization admin.';
    const oldKey = keyOf(old);
    const id = sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, client_msg_id, body) values ('${old}', 'crew', '${BOT_CREW}', 'system', '${oldKey}', '${OLD}') returning id`);
    const xmin = sql(`select xmin from public.msgr_messages where id = ${id}`);
    post(fresh, '@헤르메스 일해'); post(old, '@헤르메스 일해');
    assert.deepEqual(updates(), [], '미자격 조직은 배달하지 않는다');
    assert.equal(notices(fresh, keyOf(fresh)), `${BOTH('paused')}#1`, '새 방에는 새 문구');
    assert.equal(notices(old, oldKey), `${OLD}#1`, '옛 안내가 있는 방은 그대로 1개');
    assert.equal(sql(`select xmin from public.msgr_messages where id = ${id}`), xmin, '옛 행에 쓰기 없음(D1)');
  } finally {
    sql(orig.replace(/\n$/, '') + ';');
  }
});

test('일지: 글 쓴 에이전트 이름을 모르면 대체 이름이 에이전트다', { skip }, () => {
  const ch = newChannel('journal');
  const gone = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.owner}', 'ws-gone', 'gone', '떠난 에이전트') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ch}', 'crew', '${gone}')`);
  const src = sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body) values ('${ch}', 'crew', '${gone}', 'text', '떠나기 전 남긴 글') returning id`);
  sql(`delete from public.msgr_crews where id = '${gone}'`); // crew_id on delete set null — 이름을 더는 모른다
  assert.equal(sql(`select coalesce(crew_id::text, 'null') || '|' || author_kind from public.msgr_messages where id = ${src}`), 'null|crew');
  sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, reply_to, thread_root) values ('${ch}', 'crew', '${BOT_CREW}', 'text', '이어서 답', ${src}, ${src})`);
  const line = sql(`select body from public.msgr_org_docs where channel_id = '${ch}' and path like 'journal/%'`);
  assert.match(line, /\*\*헤르메스\*\* ← 에이전트: 떠나기 전 남긴 글 → 이어서 답/);
  assert.doesNotMatch(line, /크루/);
});
