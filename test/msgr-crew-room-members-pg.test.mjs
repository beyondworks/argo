// 방에 들어온 에이전트는 방 전원이 부린다 — 에이전트는 주인이 데려오고, 방장이 문을 연다(유건 2026-09-18).
// 종전에는 방에 있어도 크루의 허용 범위(allow='owner')가 이겨, 같은 방 멤버의 멘션이 거절됐다(라이브 msg 829, Lean Crew).
// 새 규칙이 "방에 있다 = 주인이 데려왔다"에 기대므로, 주인 요청 없이 크루가 방에 들어가던 서버 경로 셋을 함께 막는다:
//   ① msgr_crew_join 방장 경로(소유자 확인 없음) ② RLS 직접 삽입(msgr_channel_member_ok가 소유자를 안 봄, DM은 멤버 누구나)
//   ③ msgr_create_channel의 others. 회사 크루(조직 서비스 계정 소유 상주)만 예외 — 봇은 연결한 멤버의 것이라 예외가 아니다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-crew-room-members-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crew-room-members-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { host: '11111111-1111-4111-8111-111111111111', mate: '22222222-2222-4222-8222-222222222222', other: '33333333-3333-4333-8333-333333333333', svc: '44444444-4444-4444-8444-444444444444', out: '55555555-5555-4555-8555-555555555555' };
function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제: ${raw.stderr.trim().slice(0, 160)}`); };
const why = (crew, author, ch) => sql(`select public.msgr_instruct_check('${crew}', '${author}', '${ch}')`);
const inCh = (ch, crew) => sql(`select public.msgr_crew_in_channel('${ch}', '${crew}')`);

let ORG, PRIV, PUB, DM, HOSTC, MATEC, OTHERC, COMP, MATEBOT;
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
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.host, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.host}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const u of [U.mate, U.other]) {
    const code = last(asUser(U.host, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.host}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.svc}', 'member')`);
  sql(`update public.msgr_orgs set service_user_id = '${U.svc}' where id = '${ORG}'`);
  const crew = (owner, slug, hosting = 'local') => last(sql(`select set_config('msgr.bot_create', '${hosting === 'bot' ? '1' : ''}', false); insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, status, allow, hosting) values ('${ORG}', '${owner}', 'lean', '${slug}', '${slug}', 'active', 'owner', '${hosting}') returning id`));
  HOSTC = crew(U.host, 'hostc'); MATEC = crew(U.mate, 'matec'); OTHERC = crew(U.other, 'otherc'); COMP = crew(U.svc, 'company', 'resident'); MATEBOT = crew(U.mate, 'matebot', 'bot');
  PRIV = last(asUser(U.host, `select public.msgr_create_channel('${ORG}', 'private', 'Lean Crew', '[{"kind":"user","id":"${U.mate}"}]'::jsonb)`));
  PUB = last(asUser(U.host, `select public.msgr_create_channel('${ORG}', 'public', 'General')`));
  DM = last(asUser(U.mate, `select public.msgr_create_channel('${ORG}', 'dm', 'mate-host', '[{"kind":"user","id":"${U.host}"}]'::jsonb)`));
});

// ── 새 규칙: 방에 들어온 에이전트는 방 전원이 부린다 ─────────────────────────────
test('방장이 자기 에이전트를 데려오면 같은 방 멤버가 허용 범위(owner)와 무관하게 부린다', { skip }, () => {
  assert.equal(why(HOSTC, U.mate, PRIV), 'crew_allow', '방에 들어오기 전에는 옛 규칙(주인만)');
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join('${PRIV}', '${HOSTC}')`)), 'joined');
  assert.equal(why(HOSTC, U.mate, PRIV), 'ok', '방 멤버는 방에 있는 에이전트를 부린다');
  assert.equal(sql(`select public.msgr_can_instruct('${HOSTC}', '${U.mate}', '${PRIV}')`), 't', '서버 소비자 20곳이 거치는 래퍼도 같은 답(드레인·답글 재판정·결재 흐름이 어긋나지 않게)');
  assert.equal(why(HOSTC, U.other, PRIV), 'crew_allow', '방 밖 사람은 여전히 못 부린다(비공개 채널 멤버 아님)');
  assert.equal(why(HOSTC, U.host, PRIV), 'ok', '주인은 그대로');
});

test('방에 없는 에이전트는 기존 규칙대로 — 같은 조직이어도 방에 들이지 않았으면 거절', { skip }, () => {
  assert.equal(inCh(PRIV, OTHERC), 'f');
  assert.equal(why(OTHERC, U.mate, PRIV), 'crew_allow');
});

test('공개 채널: 조직 멤버는 부리고, 채널에서 제외된 사람은 못 부린다', { skip }, () => {
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join('${PUB}', '${HOSTC}')`)), 'joined');
  assert.equal(why(HOSTC, U.other, PUB), 'ok', '공개 채널을 읽는 조직 멤버');
  sql(`update public.msgr_channels set excluded_user_ids = array['${U.other}']::uuid[] where id = '${PUB}'`);
  assert.equal(why(HOSTC, U.other, PUB), 'crew_allow', '제외된 사람은 채널을 못 읽으므로 못 부린다');
  sql(`update public.msgr_channels set excluded_user_ids = '{}' where id = '${PUB}'`);
  assert.equal(why(HOSTC, U.out, PUB), 'crew_allow', '조직 밖 사람');
});

test('보기만(read_only) 채널은 방 규칙보다 먼저 이긴다', { skip }, () => {
  asUser(U.host, `update public.msgr_channels set personal_crews = 'read_only' where id = '${PRIV}'`);
  assert.equal(why(HOSTC, U.mate, PRIV), 'channel_policy');
  asUser(U.host, `update public.msgr_channels set personal_crews = 'approval' where id = '${PRIV}'`);
  assert.equal(why(HOSTC, U.mate, PRIV), 'ok');
});

test('DM도 방이다: 참여자가 자기 에이전트를 넣으면 다른 참여자가 부린다', { skip }, () => {
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_join('${DM}', '${MATEC}')`)), 'joined');
  assert.equal(why(MATEC, U.host, DM), 'ok');
  assert.equal(why(MATEC, U.other, DM), 'crew_allow', 'DM 밖 사람');
});

// ── 주인 요청 없이 에이전트가 방에 들어가던 경로를 막는다 ──────────────────────────
test('구멍 ①: 방장도 남의 개인 에이전트를 바로 넣지 못한다 — 주인이 요청해야 한다', { skip }, () => {
  fails(asUserRaw(U.host, `select public.msgr_crew_join('${PRIV}', '${MATEC}')`), /msgr_forbidden/, '방장이 남의 에이전트를 데려옴');
  assert.equal(inCh(PRIV, MATEC), 'f');
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_join('${PRIV}', '${MATEC}')`)), 'requested', '주인이 데려오면 방장 승인으로');
  fails(asUserRaw(U.host, `select public.msgr_crew_join('${PRIV}', '${MATEBOT}')`), /msgr_forbidden/, '봇은 등급이 회사여도 연결한 멤버의 것');
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join('${PRIV}', '${COMP}')`)), 'joined', '회사 에이전트는 방장이 바로 넣는다');
});

test('구멍 ②: RLS 직접 삽입도 주인만 — 비DM은 방장이어도, DM은 참여자여도', { skip }, () => {
  fails(asUserRaw(U.host, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'crew', '${OTHERC}', '${U.host}')`), /row-level security/, '방장이 남의 에이전트를 직접 삽입');
  fails(asUserRaw(U.host, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${DM}', 'crew', '${OTHERC}', '${U.host}')`), /row-level security/, 'DM 참여자가 방에 없는 사람의 에이전트를 직접 삽입');
  fails(asUserRaw(U.host, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${DM}', 'crew', '${COMP}', '${U.host}')`), /row-level security/, 'DM에는 회사 에이전트도 직접 못 넣는다(방장이 없다)');
  assert.equal(inCh(DM, OTHERC), 'f');
});

test('구멍 ② DM: 주인이 같은 DM에 있어도 남이 그 에이전트를 넣지 못한다', { skip }, () => {
  const bot2 = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, status, allow) values ('${ORG}', '${U.mate}', 'lean', 'matec2', 'matec2', 'active', 'owner') returning id`));
  fails(asUserRaw(U.host, `select public.msgr_crew_join('${DM}', '${bot2}')`), /msgr_forbidden/, '주인(mate)이 DM에 있어도 host가 넣음');
  assert.equal(inCh(DM, bot2), 'f');
});

test('구멍 ③: 채널을 만들며 남의 에이전트를 끼워 넣지 못한다', { skip }, () => {
  fails(asUserRaw(U.host, `select public.msgr_create_channel('${ORG}', 'private', 'Sneak', '[{"kind":"crew","id":"${MATEC}"}]'::jsonb)`), /msgr_bad_member/, 'others에 남의 에이전트');
  const ok = last(asUser(U.host, `select public.msgr_create_channel('${ORG}', 'private', 'Mine', '[{"kind":"crew","id":"${HOSTC}"}]'::jsonb)`));
  assert.equal(inCh(ok, HOSTC), 't', '자기 에이전트는 만들며 넣을 수 있다');
});

test('added_by는 넣는 사람 자신이어야 한다(영향 반경 집계가 이 열에 기댄다)', { skip }, () => {
  const ch = last(asUser(U.host, `select public.msgr_create_channel('${ORG}', 'private', 'Attr')`));
  fails(asUserRaw(U.host, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'crew', '${HOSTC}', '${U.mate}')`), /row-level security/, '남의 이름으로 추가');
  asUser(U.host, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${ch}', 'user', '${U.mate}', '${U.host}')`);
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}' and member_id = '${U.mate}'`), '1', '앱의 사람 추가(added_by = 나) 경로는 그대로');
});

// ── 방에 없는 에이전트를 부르면 거절 안내가 그 방에 닿는다(2026-09-18 Argo Dev E2E 실측: msgr_crew_not_in_channel로 조용히 사라짐) ──
// 새 규칙 뒤로 거절의 주된 경우가 "에이전트가 방에 없을 때"다. 안내는 에이전트 명의 system 글이라 채널 범위 트리거가 막았다.
// 그래서 **받은 멘션에 대한 거절 안내만** 좁게 연다: 같은 채널의 실재하는 글이 이 에이전트를 멘션했고, 그 글에 대한 deny 키이며, 아무도 멘션하지 않는다.
const denyNote = (owner, ch, crew, replyTo, extra = '') => asUserRaw(owner, `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, reply_to, client_msg_id${extra ? ', mentions' : ''})
  values ('${ch}', 'crew', '${crew}', 'system', '방에 없는 에이전트입니다', ${replyTo}, 'deny:${crew}:${replyTo}'${extra ? `, '${extra}'::jsonb` : ''})`);
test('방에 없는 에이전트의 거절 안내 — 받은 멘션에만 그 방에 답할 수 있다', { skip }, () => {
  const pub = last(asUser(U.host, `select public.msgr_create_channel('${ORG}', 'public', 'NoCrew')`));
  asUser(U.mate, `select public.msgr_join_channel('${pub}')`);
  assert.equal(inCh(pub, OTHERC), 'f', '전제: 에이전트는 이 방에 없다');
  const asked = last(asUser(U.mate, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${pub}', 'user', '${U.mate}', 'text', '@otherc 해줘', '[{"kind":"crew","id":"${OTHERC}"}]'::jsonb) returning id`));
  const r = denyNote(U.other, pub, OTHERC, asked);
  assert.equal(r.status, 0, `받은 멘션에 대한 거절 안내는 닿는다 — ${r.stderr.trim().slice(0, 160)}`);
  // 받지 않은 멘션: 이 에이전트를 부르지 않은 글에 deny로 끼어들 수 없다
  const plain = last(asUser(U.mate, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body) values ('${pub}', 'user', '${U.mate}', 'text', '그냥 대화') returning id`));
  fails(denyNote(U.other, pub, OTHERC, plain), /msgr_crew_not_in_channel/, '멘션 없는 글에 답하는 deny');
  // 다른 채널의 글을 reply_to로 빌려 이 방에 쓰지 못한다
  const elsewhere = last(asUser(U.host, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${PUB}', 'user', '${U.host}', 'text', '@otherc', '[{"kind":"crew","id":"${OTHERC}"}]'::jsonb) returning id`));
  // 이 경우는 앞서 도는 msgr_message_fill이 먼저 막는다 — 범위 트리거의 같은 채널 조건은 트리거 순서에 기대지 않는 이중 방어다
  fails(denyNote(U.other, pub, OTHERC, elsewhere), /msgr_reply_cross_channel|msgr_crew_not_in_channel/, '다른 채널 글을 reply_to로');
  // 안내가 누군가를 멘션하면 넘김 통로가 된다 — 멘션 없는 안내만
  const asked2 = last(asUser(U.mate, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions) values ('${pub}', 'user', '${U.mate}', 'text', '@otherc 한 번 더', '[{"kind":"crew","id":"${OTHERC}"}]'::jsonb) returning id`));
  fails(denyNote(U.other, pub, OTHERC, asked2, `[{"kind":"crew","id":"${HOSTC}"}]`), /msgr_crew_not_in_channel/, '멘션을 단 거절 안내');
  // 거절 안내가 아닌 글(text)은 여전히 막힌다
  fails(asUserRaw(U.other, `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, reply_to) values ('${pub}', 'crew', '${OTHERC}', 'text', '방에 없는데 답함', ${asked2})`), /msgr_crew_not_in_channel/, '방에 없는 에이전트의 일반 답글');
});
