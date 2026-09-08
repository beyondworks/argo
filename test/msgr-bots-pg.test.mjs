// 봇 API 스키마(20260908120000_msgr_bots.sql) 실행 검증 — 외부 에이전트(헤르메스·오픈클로)가 봇 토큰으로 접속하는 경로를 실제 Postgres에서 돈다.
// 하네스는 msgr-pg-integration.test.mjs와 같다(auth.uid() 스텁 + set role). ARGO_PG_TEST_URL 미설정이면 skip.
// 실행: `npm run test:pg` (scripts/billing-pg-drill.sh — 파일마다 별도 임시 DB). 사용자 흉내: set role authenticated +
// argo.uid 세션 변수(auth.uid() 스텁이 읽는다) — 슈퍼유저는 RLS를 우회하므로 반드시 역할을 낮춰 실행한다.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — npm run test:pg로 실행';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { // 고정 uuid — 값은 전부 이 파일의 상수(주입 표면 없음)
  owner: '11111111-1111-4111-8111-111111111111', admin: '22222222-2222-4222-8222-222222222222',
  member: '33333333-3333-4333-8333-333333333333', guest: '44444444-4444-4444-8444-444444444444',
  removed: '55555555-5555-4555-8555-555555555555', outsider: '66666666-6666-4666-8666-666666666666',
  svc: '77777777-7777-4777-8777-777777777777', extra: '88888888-8888-4888-8888-888888888888',
};

function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();                 // 슈퍼유저(RLS 우회) — 시드·관찰 전용
const asAnon = (q) => sql(`set role anon; ${q}`);                      // 봇 쪽 RPC는 토큰이 자격 — anon으로 호출
const asAnonRaw = (q) => psqlRaw(['-A', '-t', '-c', `set role anon; ${q}`]);
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
// denied 기본 정규식은 RLS·권한만(msgr_ 접두 예외는 명시 정규식으로 — 검수 MEDIUM-7: 이 스키마는 이름이 전부 msgr_라 무의미한 안전망)
const denied = (uid, q, re = /row-level security policy|permission denied for/i) => { const r = asUserRaw(uid, q); assert.notEqual(r.status, 0, `허용됨: ${q.slice(0, 80)}`); assert.match(r.stderr, re); };
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';        // set_config 출력 뒤 마지막 결과 줄

let ORG, PUB, PRIV, CREW, CREW_SVC;
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
    grant usage on schema auth to anon, authenticated, service_role; -- 정책 본문의 auth.uid()는 호출 역할로 평가된다(실 Supabase와 동일 권한)
    create table if not exists auth.users (id uuid primary key, created_at timestamptz not null default now(), email text);
    -- auth.uid() 스텁: 세션 변수 argo.uid — asUser()가 set_config로 사용자를 흉내 낸다
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('argo.uid', true), '')::uuid $$;
    -- storage 스텁(정책 문법·foldername 계약만) — 실 Supabase의 storage.objects와 같은 열 이름
    create schema if not exists storage;
    create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
    -- realtime 스텁: 방송을 realtime.sent에 기록해 payload·topic·private를 단언한다
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
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql',
    '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql',
    '20260903120000_msgr.sql', '20260907120000_msgr_crew_inventory.sql', '20260908120000_msgr_bots.sql', '20260908140000_msgr_crew_autodispatch.sql', '20260909000000_msgr_bot_external_id.sql', '20260909002000_msgr_profiles_friends.sql', '20260909003000_msgr_message_meta.sql', '20260909004000_msgr_p0_reads_reactions_prefs.sql']) psql(['-f', mig(f)]); // 배포될 그 파일을 그대로 적용
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`); // 체험 창 밖
  // 시드: owner가 조직 생성(트리거가 owner 멤버·free 자격 생성) → admin/member/guest/removed 초대 → 공개·비공개 채널 → 크루 2개
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.guest}', 'guest')`); // 게스트는 채널 링크로만 생긴다(검수 L-3) — 시드는 슈퍼유저
  for (const [uid, role] of [[U.admin, 'admin'], [U.member, 'member']]) {
    sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`); // 시드 동안 좌석 넉넉히(좌석 테스트는 별도)
    const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.owner}') returning code`));
    assert.equal(last(asUser(uid, `select public.msgr_accept_invite('${code}')`)), ORG, `초대 수락 ${role}`);
  }
  sql(`insert into public.msgr_org_members (org_id, user_id, role, removed_at) values ('${ORG}', '${U.removed}', 'member', now())`); // 제거된 멤버
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.svc}', 'member')`);                        // 상주 노드 서비스 계정
  PUB = last(asUser(U.owner, `insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'public', 'general', '${U.owner}') returning id`));
  PRIV = last(asUser(U.admin, `select public.msgr_create_channel('${ORG}', 'private', 'secret')`)); // 앱과 같게 RPC — 만든 사람이 첫 멤버로 함께 등록된다(생성 직후 열람 예외 폐지, 검수 HIGH 2026-09-05)
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'user', '${U.guest}', '${U.admin}')`);
  CREW = last(asUser(U.member, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values ('${ORG}', '${U.member}', 'lean-ax-abcd', 'seoyun', '서윤') returning id`));
  CREW_SVC = last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting) values ('${ORG}', '${U.svc}', 'lean-node', 'node-crew', '노드', 'resident') returning id`)); // 시드는 슈퍼유저: resident는 서비스 계정 지정 뒤에만 사용자 문맥으로 등록 가능(검수 LOW-1 게이트)
});

const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };
const q = (s) => s.replace(/'/g, "''");
let BOT, BOT_CREW, TOKEN;

test('봇 만들기: 관리자만 · 토큰은 응답에 1회 · 저장은 sha256 · 크루 hosting=bot(회사 등급) · 조직 좌석 미소모 · 감사 bot.create', { skip }, () => {
  fails(asUserRaw(U.member, `select public.msgr_bot_create('${ORG}', 'hermes', '헤르메스')`), /msgr_admin_only/, '멤버 생성');
  fails(asUserRaw(U.outsider, `select public.msgr_bot_create('${ORG}', 'hermes', '헤르메스')`), /msgr_admin_only/, '외부인 생성');
  fails(asUserRaw(U.admin, `select public.msgr_bot_create('${ORG}', 'slackbot', '헤르메스')`), /check constraint|invalid input/i, '모르는 종류');
  fails(asUserRaw(U.admin, `select public.msgr_bot_create('${ORG}', 'hermes', '  ')`), /msgr_bot_name/, '빈 이름');
  const out = JSON.parse(last(asUser(U.admin, `select public.msgr_bot_create('${ORG}', 'hermes', '헤르메스', '외부 에이전트')`)));
  BOT = out.bot_id; BOT_CREW = out.crew_id; TOKEN = out.token;
  assert.match(TOKEN, /^argo_bot_[0-9a-f]{48}$/);
  assert.equal(sql(`select token_hash = encode(sha256(convert_to('${TOKEN}', 'utf8')), 'hex') from public.msgr_bots where id = '${BOT}'`), 't');
  assert.equal(sql(`select count(*) from public.msgr_bots where token_hash = '${TOKEN}'`), '0', '원문 저장 금지');
  assert.equal(sql(`select hosting || '|' || status || '|' || owner_user_id from public.msgr_crews where id = '${BOT_CREW}'`), `bot|active|${U.admin}`);
  assert.equal(last(asUser(U.admin, `select public.msgr_crew_tier('${BOT_CREW}')`)), 'company');
  assert.equal(sql(`select count(*) from public.msgr_org_members where org_id = '${ORG}' and user_id = '${U.admin}'`), '1', '봇은 멤버 행을 만들지 않는다');
  assert.equal(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'bot.create' and target_id = '${BOT}'`), '1');
  // 봇 표는 관리자만 읽고, 직접 쓰기 정책은 없다
  assert.equal(last(asUser(U.admin, `select count(*) from public.msgr_bots where org_id = '${ORG}'`)), '1');
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_bots where org_id = '${ORG}'`)), '0');
  denied(U.admin, `update public.msgr_bots set name = 'x' where id = '${BOT}'`);
  denied(U.admin, `delete from public.msgr_bots where id = '${BOT}'`);
});

test('봇 크루는 RPC로만: hosting=bot 직접 insert·승격은 관리자여도 거절', { skip }, () => {
  fails(asUserRaw(U.admin, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting) values ('${ORG}', '${U.admin}', 'bot', 'fake-bot', '가짜', 'bot')`), /msgr_bot_rpc_only/, '직접 insert');
  fails(asUserRaw(U.member, `update public.msgr_crews set hosting = 'bot' where id = '${CREW}'`), /msgr_bot_rpc_only/, '승격');
  assert.equal(sql(`select hosting from public.msgr_crews where id = '${CREW}'`), 'local');
});

test('getMe: 토큰이 자격(anon) · 무효 토큰 거절 · last_seen_at 갱신', { skip }, () => {
  const me = JSON.parse(last(asAnon(`select public.msgr_bot_me('${TOKEN}')`)));
  assert.equal(me.crew_id, BOT_CREW); assert.equal(me.org_id, ORG); assert.equal(me.name, '헤르메스'); assert.equal(me.kind, 'hermes'); assert.equal(me.org_slug, 'lean');
  fails(asAnonRaw(`select public.msgr_bot_me('argo_bot_${'0'.repeat(48)}')`), /msgr_bot_unauthorized/, '무효 토큰');
  fails(asAnonRaw(`select public.msgr_bot_me('')`), /msgr_bot_unauthorized/, '빈 토큰');
  assert.equal(sql(`select last_seen_at is not null from public.msgr_bots where id = '${BOT}'`), 't');
  fails(asAnonRaw(`select * from public.msgr_bot_auth('${TOKEN}')`), /permission denied/, '내부 함수 직접 호출');
  fails(asAnonRaw(`select public.msgr_bot_hash('x')`), /permission denied/, '해시 함수 직접 호출');
});

test('getUpdates: 멘션·봇이 참가한 DM·봇 글에 대한 답글만 · 읽을 수 있는 채널(공개 또는 멤버)만 · after_id 커서', { skip }, () => {
  const mention = q(JSON.stringify([{ kind: 'crew', id: BOT_CREW }]));
  const post = (u, ch, body, extra = '') => last(asUser(u, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body${extra ? ', ' + extra.split('=')[0] : ''}) values ('${ORG}', '${ch}', 'user', '${u}', '${q(body)}'${extra ? ', ' + extra.split('=')[1] : ''}) returning id`));
  const plain = post(U.owner, PUB, '그냥 잡담');
  const m1 = post(U.owner, PUB, '@헤르메스 이거 봐줘', `mentions='${mention}'::jsonb`);
  const secret = post(U.admin, PRIV, '@헤르메스 비밀', `mentions='${mention}'::jsonb`); // 봇이 아직 멤버가 아닌 비공개 채널
  const ups = asAnon(`select public.msgr_bot_updates('${TOKEN}')`).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(ups.map((u) => String(u.update_id)), [m1], '멘션만, 비공개 채널 제외');
  assert.equal(ups[0].message.text, '@헤르메스 이거 봐줘'); assert.equal(ups[0].message.chat.id, PUB); assert.equal(ups[0].message.from.id, U.owner); assert.equal(ups[0].message.mentioned, true);
  assert.equal(sql(`select cursor_msg_id from public.msgr_crews where id = '${BOT_CREW}'`), '0');
  assert.equal(asAnon(`select count(*) from public.msgr_bot_updates('${TOKEN}', ${m1})`).trim(), '0', 'after_id 뒤엔 없음');
  assert.equal(sql(`select cursor_msg_id from public.msgr_crews where id = '${BOT_CREW}'`), m1, 'after_id = ack');
  // 관리자가 봇을 비공개 채널에 넣으면 그 채널 멘션이 보인다(기존 채널 멤버 경로 그대로)
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'crew', '${BOT_CREW}', '${U.admin}')`);
  const ups2 = asAnon(`select public.msgr_bot_updates('${TOKEN}', ${plain})`).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(ups2.map((u) => String(u.update_id)), [secret], 'after_id가 커서보다 낮아도 ack된 m1은 다시 오지 않는다');
  assert.equal(sql(`select cursor_msg_id from public.msgr_crews where id = '${BOT_CREW}'`), m1, '커서는 뒤로 안 간다');
  assert.equal(asAnon(`select count(*) from public.msgr_bot_updates('${TOKEN}', 0)`).trim(), '1', 'ack 뒤 offset 0으로 다시 물어도 ack된 것(m1)은 재생되지 않고 새 것(secret)만 온다');
  // 멤버(직원)가 다른 크루를 멘션한 글은 이 봇에게 안 간다
  post(U.member, PUB, '@서윤 이거', `mentions='${q(JSON.stringify([{ kind: 'crew', id: CREW }]))}'::jsonb`);
  assert.equal(asAnon(`select count(*) from public.msgr_bot_updates('${TOKEN}', ${secret})`).trim(), '0');
});

test('sendMessage: 답글은 client_msg_id reply:<crew>:<src>로 기존 답글 게이트(허용 범위·채널 정책)를 재판정 · 멱등 · 멤버가 아닌 채널 거절', { skip }, () => {
  const mention = q(JSON.stringify([{ kind: 'crew', id: BOT_CREW }]));
  const src = last(asUser(U.member, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body, mentions) values ('${ORG}', '${PUB}', 'user', '${U.member}', '@헤르메스 답해', '${mention}'::jsonb) returning id`));
  const id1 = asAnon(`select public.msgr_bot_send('${TOKEN}', '${PUB}', '네, 확인했습니다', ${src})`).trim();
  assert.match(id1, /^\d+$/);
  assert.equal(sql(`select author_kind || '|' || crew_id || '|' || client_msg_id || '|' || reply_to from public.msgr_messages where id = ${id1}`), `crew|${BOT_CREW}|reply:${BOT_CREW}:${src}|${src}`);
  assert.equal(asAnon(`select public.msgr_bot_send('${TOKEN}', '${PUB}', '다시', ${src})`).trim(), id1, '같은 원글엔 한 번만(멱등)');
  // 봇 글에 대한 사람 답글은 getUpdates에 잡힌다(멘션 없이도)
  const follow = last(asUser(U.member, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body, reply_to) values ('${ORG}', '${PUB}', 'user', '${U.member}', '고마워', ${id1}) returning id`));
  assert.equal(asAnon(`select (public.msgr_bot_updates('${TOKEN}', ${id1}))->'message'->>'message_id'`).trim(), follow);
  // 답글 아닌 발언: 공개 채널 OK, 멤버 아닌 채널 거절, 다른 조직 채널 거절
  assert.match(asAnon(`select public.msgr_bot_send('${TOKEN}', '${PUB}', '알림입니다')`).trim(), /^\d+$/);
  const other = last(asUser(U.admin, `select public.msgr_create_channel('${ORG}', 'private', 'ops')`));
  fails(asAnonRaw(`select public.msgr_bot_send('${TOKEN}', '${other}', 'x')`), /msgr_bot_not_member/, '비멤버 채널');
  fails(asAnonRaw(`select public.msgr_bot_send('${TOKEN}', '${BOT_CREW}', 'x')`), /msgr_bot_no_channel/, '없는 채널');
  fails(asAnonRaw(`select public.msgr_bot_send('${TOKEN}', '${PUB}', 'x', 999999999)`), /msgr_bot_bad_reply/, '없는 원글');
  // 허용 범위 owner: 만든 관리자만 지시 가능 → 멤버 글에 답하면 게이트가 거절, 관리자 글엔 통과
  sql(`update public.msgr_crews set allow = 'owner' where id = '${BOT_CREW}'`);
  const src2 = last(asUser(U.member, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body, mentions) values ('${ORG}', '${PUB}', 'user', '${U.member}', '@헤르메스 또', '${mention}'::jsonb) returning id`));
  fails(asAnonRaw(`select public.msgr_bot_send('${TOKEN}', '${PUB}', '답', ${src2})`), /crew_allow|msgr_not_allowed|msgr_crew_reply/, 'allow=owner 멤버 글');
  const src3 = last(asUser(U.admin, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body, mentions) values ('${ORG}', '${PUB}', 'user', '${U.admin}', '@헤르메스 관리자', '${mention}'::jsonb) returning id`));
  assert.match(asAnon(`select public.msgr_bot_send('${TOKEN}', '${PUB}', '네', ${src3})`).trim(), /^\d+$/);
  sql(`update public.msgr_crews set allow = 'all' where id = '${BOT_CREW}'`);
  // 개인 크루 차단 채널: 회사 등급(봇)은 통과
  sql(`update public.msgr_channels set personal_crews = 'blocked' where id = '${PRIV}'`);
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${PRIV}' and member_kind = 'crew' and member_id = '${BOT_CREW}'`), '1', 'sweep이 봇을 지우지 않는다');
  fails(asUserRaw(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${PRIV}', 'crew', '${CREW}', '${U.admin}')`), /msgr_channel_personal_blocked/, '개인 크루는 여전히 못 들어간다');
  const src4 = last(asUser(U.admin, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, body, mentions) values ('${ORG}', '${PRIV}', 'user', '${U.admin}', '@헤르메스 민감', '${mention}'::jsonb) returning id`));
  assert.match(asAnon(`select public.msgr_bot_send('${TOKEN}', '${PRIV}', '민감 답', ${src4})`).trim(), /^\d+$/, '차단 채널에서 회사 등급 통과');
  assert.equal(last(asUser(U.admin, `select public.msgr_instruct_check('${CREW}', '${U.member}', '${PRIV}')`)), 'channel_policy', '개인 크루는 여전히 막힘');
});

test('회전·폐기: 회전하면 옛 토큰 즉시 무효 · 폐기하면 크루 detached + 채널 멤버 삭제 + 봇 RPC 전부 거절 · 관리자만 · 감사', { skip }, () => {
  fails(asUserRaw(U.member, `select public.msgr_bot_rotate('${BOT}')`), /msgr_admin_only/, '멤버 회전');
  const t2 = last(asUser(U.owner, `select public.msgr_bot_rotate('${BOT}')`));
  assert.match(t2, /^argo_bot_[0-9a-f]{48}$/); assert.notEqual(t2, TOKEN);
  fails(asAnonRaw(`select public.msgr_bot_me('${TOKEN}')`), /msgr_bot_unauthorized/, '옛 토큰');
  assert.equal(JSON.parse(last(asAnon(`select public.msgr_bot_me('${t2}')`))).bot_id, BOT);
  assert.equal(sql(`select rotated_at is not null from public.msgr_bots where id = '${BOT}'`), 't');
  fails(asUserRaw(U.member, `select public.msgr_bot_revoke('${BOT}')`), /msgr_admin_only/, '멤버 폐기');
  asUser(U.admin, `select public.msgr_bot_revoke('${BOT}')`);
  assert.equal(sql(`select status from public.msgr_crews where id = '${BOT_CREW}'`), 'detached');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where member_kind = 'crew' and member_id = '${BOT_CREW}'`), '0');
  for (const call of [`msgr_bot_me('${t2}')`, `msgr_bot_updates('${t2}')`, `msgr_bot_send('${t2}', '${PUB}', 'x')`]) fails(asAnonRaw(`select public.${call}`), /msgr_bot_unauthorized/, call);
  fails(asUserRaw(U.admin, `select public.msgr_bot_rotate('${BOT}')`), /msgr_bot_revoked/, '폐기 뒤 회전');
  assert.equal(sql(`select string_agg(action, ',' order by id) from public.msgr_audit_log where org_id = '${ORG}' and action like 'bot.%'`), 'bot.create,bot.rotate,bot.revoke');
});

test('기본 파견(20260908140000): 소유자가 파견 해제하면 서버가 채널 멤버를 지우고(모든 채널에서 빠짐) 지시 판정은 inactive, 다시 파견하면 다시 넣어야 한다', { skip }, () => {
  const priv2 = last(asUser(U.admin, `select public.msgr_create_channel('${ORG}', 'private', 'recall-test')`));
  asUser(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${priv2}', 'crew', '${CREW}', '${U.admin}')`);
  assert.equal(sql(`select count(*) from public.msgr_channel_members where member_kind = 'crew' and member_id = '${CREW}'`), '1');
  assert.equal(last(asUser(U.member, `update public.msgr_crews set status = 'available' where id = '${CREW}' returning status`)), 'available', '소유자(member)가 해제');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where member_kind = 'crew' and member_id = '${CREW}'`), '0', '해제 = 채널에서 빠짐(서버 sweep)');
  assert.equal(sql(`select public.msgr_instruct_check('${CREW}', '${U.member}', null)`), 'inactive', '해제된 크루는 지시 불가');
  assert.equal(sql(`select string_agg(action, ',' order by id) from public.msgr_audit_log where target_id = '${CREW}' and action like 'crew.%'`), 'crew.recall');
  fails(asUserRaw(U.admin, `insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${priv2}', 'crew', '${CREW}', '${U.admin}')`), /msgr_crew_not_active|msgr_channel/, '해제된 크루는 채널에 못 넣는다');
  assert.equal(last(asUser(U.member, `update public.msgr_crews set status = 'active', allow = 'all', allow_users = '{}' where id = '${CREW}' returning status`)), 'active', '다시 파견');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where member_kind = 'crew' and member_id = '${CREW}'`), '0', '되살려도 채널은 자동 복귀하지 않는다');
  assert.equal(sql(`select public.msgr_instruct_check('${CREW}', '${U.member}', null)`), 'ok');
});

test('external_id(20260909000000): 에이전트마다 봇 하나 — 같은 조직·같은 external_id는 두 번 못 만든다(회전으로), 폐기 뒤엔 다시 만들 수 있다', { skip }, () => {
  const a = JSON.parse(last(asUser(U.admin, `select public.msgr_bot_create('${ORG}', 'openclaw', 'Support', null, 'openclaw:support')`)));
  assert.equal(sql(`select external_id from public.msgr_bots where id = '${a.bot_id}'`), 'openclaw:support');
  fails(asUserRaw(U.admin, `select public.msgr_bot_create('${ORG}', 'openclaw', 'Support again', null, 'openclaw:support')`), /msgr_bot_exists/, '중복 생성');
  asUser(U.admin, `select public.msgr_bot_revoke('${a.bot_id}')`);
  const b = JSON.parse(last(asUser(U.admin, `select public.msgr_bot_create('${ORG}', 'openclaw', 'Support', null, 'openclaw:support')`)));
  assert.notEqual(b.bot_id, a.bot_id, '폐기 뒤 재생성');
  assert.equal(sql(`select count(*) from public.msgr_bots where org_id = '${ORG}' and external_id = 'openclaw:support' and revoked_at is null`), '1');
});

test('친구(20260909002000): 이메일은 정확 일치+허용한 사람만, 아이디는 앞부분+허용, 이메일은 결과에 없음 · 요청→수락 · 맞요청=수락 · 거절 삭제 · 차단은 검색·요청 차단', { skip }, () => {
  asUser(U.member, `insert into public.msgr_profiles (user_id, handle, display_name, email_search) values ('${U.member}', 'seoyun_dev', '서윤 개발', true)`);
  asUser(U.guest, `insert into public.msgr_profiles (user_id, handle, display_name, email_search, handle_search) values ('${U.guest}', 'ghost', '유령', false, false)`);
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_find_user('member@example.test')`)), '1', '이메일 정확 일치(허용)');
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_find_user('MEMBER@EXAMPLE.TEST')`)), '1', '대소문자 무시');
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_find_user('member@example')`)), '0', '부분 이메일은 안 찾아진다');
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_find_user('guest@example.test')`)), '0', '이메일 검색 안 허용');
  assert.equal(last(asUser(U.owner, `select handle from public.msgr_find_user('seo')`)), 'seoyun_dev', '아이디 앞부분');
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_find_user('gho')`)), '0', '아이디 검색 안 허용');
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_find_user('se')`)), '0', '3자 미만은 안 찾는다');
  assert.doesNotMatch(sql(`select pg_get_function_result('public.msgr_find_user'::regproc)`), /email/, '결과에 이메일 열 없음');
  assert.equal(last(asUser(U.owner, `select public.msgr_friend_request('${U.member}')`)), 'sent');
  assert.equal(last(asUser(U.owner, `select relation from public.msgr_find_user('seo')`)), 'sent');
  assert.equal(last(asUser(U.member, `select status || '|' || (requested_by = '${U.owner}') from public.msgr_my_friends()`)), 'pending|true', '상대는 받은 요청으로 본다');
  fails(asUserRaw(U.owner, `select public.msgr_friend_decide('${U.member}', true)`), /msgr_friend_no_request/, '보낸 쪽은 수락 못 한다');
  assert.equal(last(asUser(U.member, `select public.msgr_friend_decide('${U.owner}', true)`)), 'friend');
  assert.equal(last(asUser(U.owner, `select status from public.msgr_my_friends() where user_id = '${U.member}'`)), 'accepted');
  assert.equal(last(asUser(U.member, `select display_name from public.msgr_profiles where user_id = '${U.owner}'`)), '', '친구가 돼도 상대가 프로필을 안 만들었으면 없음(정책은 읽기 허용)');
  // 맞요청 = 수락
  asUser(U.admin, `select public.msgr_friend_request('${U.guest}')`); assert.equal(last(asUser(U.guest, `select public.msgr_friend_request('${U.admin}')`)), 'friend');
  // 거절·차단
  asUser(U.extra, `select public.msgr_friend_request('${U.owner}')`); assert.equal(last(asUser(U.owner, `select public.msgr_friend_decide('${U.extra}', false)`)), 'declined');
  assert.equal(sql(`select count(*) from public.msgr_friends where a = least('${U.owner}','${U.extra}')::uuid and b = greatest('${U.owner}','${U.extra}')::uuid`), '0');
  asUser(U.owner, `select public.msgr_friend_remove('${U.member}', true)`);
  fails(asUserRaw(U.member, `select public.msgr_friend_request('${U.owner}')`), /msgr_friend_blocked/, '차단당한 쪽은 요청 불가');
  assert.equal(last(asUser(U.member, `select count(*) from public.msgr_find_user('owner@example.test')`)), '0', '차단 관계는 검색에서도 빠진다(owner는 이메일 검색 미허용이기도 함)');
  fails(asUserRaw(U.owner, `insert into public.msgr_friends (a, b, requested_by) values (least('${U.owner}','${U.guest}')::uuid, greatest('${U.owner}','${U.guest}')::uuid, '${U.owner}')`), /permission denied|row-level security/, '직접 insert 금지');
});

test('P0(20260909003000·004000): 답글 meta.trace 저장·열람 · 안 읽음 RPC(내 글·삭제 글 제외, 멘션 수, 커서 뒤만) · 읽음 커서는 본인만 · 반응은 읽는 채널만·본인 삭제만 · 채널 음소거 본인만 · 조용한 시간 범위 체크', { skip }, () => {
  const base = last(sql(`select coalesce(max(id), 0) from public.msgr_messages where channel_id = '${PUB}'`)); // 앞 케이스들의 글은 읽은 것으로
  asUser(U.owner, `insert into public.msgr_reads (channel_id, user_id, last_read_id) values ('${PUB}', '${U.owner}', ${base}) on conflict (channel_id, user_id) do update set last_read_id = ${base}`);
  const m1 = last(asUser(U.admin, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body, mentions) values ('${PUB}', 'user', '${U.admin}', '안 읽음 1', '[{"kind":"user","id":"${U.owner}"}]') returning id`));
  const m2 = last(asUser(U.admin, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.admin}', '안 읽음 2') returning id`));
  const mine = last(asUser(U.owner, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.owner}', '내 글') returning id`));
  const del = last(asUser(U.admin, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, body) values ('${PUB}', 'user', '${U.admin}', '지울 글') returning id`));
  asUser(U.admin, `update public.msgr_messages set deleted_at = now(), body = '' where id = ${del}`);
  // meta.trace — 크루 답글에 실려 열람된다(브리지 insert 경로 = 소유자 명의)
  const tr = last(asUser(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, body, reply_to, meta) values ('${PUB}', 'crew', '${CREW}', '답', ${m2}, '{"trace":{"steps":[{"t":1200,"stage":"memory","detail":"notes.md"}],"thought":"생각","ms":3400}}') returning id`));
  assert.equal(last(asUser(U.owner, `select meta->'trace'->>'ms' from public.msgr_messages where id = ${tr}`)), '3400', '궤적 열람');
  fails(asUserRaw(U.member, `insert into public.msgr_messages (channel_id, author_kind, crew_id, body, meta) values ('${PUB}', 'crew', '${CREW}', 'x', ('{"pad":"' || repeat('a', 70000) || '"}')::jsonb)`), /msgr_messages_meta_size/, 'meta 64KB 상한');
  // 안 읽음: owner 기준 — admin 글 2 + 크루 답 1 = 3(내 글·삭제 글 제외), 멘션 1
  assert.equal(last(asUser(U.owner, `select n || '|' || mention from public.msgr_unread('${ORG}') where channel_id = '${PUB}'`)), '3|1', '안 읽음·멘션 수');
  assert.equal(last(asUser(U.owner, `update public.msgr_reads set last_read_id = ${m2} where channel_id = '${PUB}' and user_id = '${U.owner}' returning last_read_id`)), String(m2), '읽음 커서 저장');
  assert.equal(last(asUser(U.owner, `select n || '|' || mention from public.msgr_unread('${ORG}') where channel_id = '${PUB}'`)), '1|0', '커서 뒤(크루 답)만 남는다');
  denied(U.owner, `insert into public.msgr_reads (channel_id, user_id, last_read_id) values ('${PUB}', '${U.admin}', 1)`); // 남의 커서 금지
  assert.equal(last(asUser(U.outsider, `select count(*) from public.msgr_unread('${ORG}')`)), '0', '조직 밖은 0행');
  // 반응
  asUser(U.owner, `insert into public.msgr_reactions (message_id, user_id, emoji) values (${m1}, '${U.owner}', '👍')`);
  assert.equal(last(asUser(U.admin, `select count(*) from public.msgr_reactions where message_id = ${m1}`)), '1', '같은 채널 멤버가 본다');
  denied(U.outsider, `insert into public.msgr_reactions (message_id, user_id, emoji) values (${m1}, '${U.outsider}', '👍')`);
  denied(U.owner, `insert into public.msgr_reactions (message_id, user_id, emoji) values (${m1}, '${U.admin}', '👍')`); // 남 명의 금지
  denied(U.owner, `insert into public.msgr_reactions (message_id, user_id, emoji) values (${del}, '${U.owner}', '👍')`); // 삭제 글 금지
  asUser(U.admin, `delete from public.msgr_reactions where message_id = ${m1} and user_id = '${U.owner}'`);
  assert.equal(last(asUser(U.admin, `select count(*) from public.msgr_reactions where message_id = ${m1}`)), '1', '남의 반응은 삭제되지 않는다(0행 영향)');
  asUser(U.owner, `delete from public.msgr_reactions where message_id = ${m1} and user_id = '${U.owner}'`);
  assert.equal(last(asUser(U.owner, `select count(*) from public.msgr_reactions where message_id = ${m1}`)), '0', '본인 반응 삭제');
  // 음소거·조용한 시간
  asUser(U.owner, `insert into public.msgr_channel_prefs (channel_id, user_id, muted) values ('${PUB}', '${U.owner}', true)`);
  assert.equal(last(asUser(U.admin, `select count(*) from public.msgr_channel_prefs where channel_id = '${PUB}'`)), '0', '남의 음소거는 안 보인다');
  denied(U.admin, `insert into public.msgr_channel_prefs (channel_id, user_id, muted) values ('${PUB}', '${U.owner}', false)`);
  fails(asUserRaw(U.owner, `insert into public.msgr_profiles (user_id, quiet_from, quiet_to) values ('${U.owner}', 25, 7)`), /quiet_from_check/, '시 범위 밖 거절');
  assert.equal(last(asUser(U.owner, `insert into public.msgr_profiles (user_id, quiet_from, quiet_to) values ('${U.owner}', 22, 7) on conflict (user_id) do update set quiet_from = 22, quiet_to = 7 returning quiet_from || '-' || quiet_to`)), '22-7');
});
