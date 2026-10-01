// 개인 공간에 내 외부 에이전트(20261001140000_msgr_personal_bots.sql) — 조직에 연결한 내 봇이 개인 공간에 쌍둥이 크루로 보이고 대화된다.
// 규칙은 개인 Argo 크루(#779)와 같다: 지시는 주인만 / 크루 1:1은 모든 글 / 친구 방은 @로만 / 무료 방 4명 / 개인 방 AI 동의는 명시적 동의만.
// 반대 검토 H1~H4·M1·M3~M5 경계 사례를 여기서 잠근다. 실행: bash scripts/billing-pg-drill.sh test/msgr-personal-bots-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-personal-bots-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333', d: '44444444-4444-4444-8444-444444444444', e: '55555555-5555-4555-8555-555555555555', f: '66666666-6666-4666-8666-666666666666' };
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asAnon = (q) => sql(`set role anon; ${q}`);
const asAnonRaw = (q) => psqlRaw(['-A', '-t', '-c', `set role anon; ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 240)}`); };
const to = (crew) => `[{"kind":"crew","id":"${crew}","role":"to"}]`;
const post = (uid, ch, body, mentions = '[]') => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', '${mentions}'::jsonb, gen_random_uuid()::text) returning id`));
const postRaw = (uid, ch, body, mentions = '[]') => asUserRaw(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', '${mentions}'::jsonb, gen_random_uuid()::text) returning id`);
// after = 마지막으로 받은 update_id(엣지가 offset - 1로 넘기는 ack 값)
const ups = (token, after = 0, lim = 10) => asAnon(`select public.msgr_bot_updates('${token}', ${after}, ${lim})`).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const upsD = (token, after = 0, lim = 10) => asAnon(`select public.msgr_bot_updates_with_delivery('${token}', ${after}, ${lim})`).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const finish = (token, ch, body, src, attempt) => asAnon(`select public.msgr_bot_finish('${token}', '${ch}', '${body}', ${src}, '${attempt}', 'done', '[]'::jsonb)`);
const finishRaw = (token, ch, body, src, attempt) => asAnonRaw(`select public.msgr_bot_finish('${token}', '${ch}', '${body}', ${src}, ${attempt ? `'${attempt}'` : 'null'}, 'done', '[]'::jsonb)`);
const befriend = (x, y) => { asUser(x, `select public.msgr_friend_request('${y}')`); asUser(y, `select public.msgr_friend_decide('${x}', true)`); };
const join = (uid, ch, crew) => last(asUser(uid, `select public.msgr_crew_join('${ch}', '${crew}')`));
const twinOf = (bot) => sql(`select crew_id from public.msgr_bot_personal where bot_id = '${bot}'`);
const mkBot = (uid, org, name, ext = null) => JSON.parse(last(asUser(uid, `select public.msgr_bot_create('${org}', 'hermes', '${name}', null, ${ext ? `'${ext}'` : 'null'})`)));
const personalCrew = (uid, slug) => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${uid}', 'ws-${uid.slice(0, 4)}', '${slug}', '${slug}', 'local', 'active', 'owner') returning id`));
const roomCrews = (uid) => JSON.parse(last(asUser(uid, `select coalesce(jsonb_agg(to_jsonb(r)), '[]') from public.msgr_personal_room_crews() r`)));
const drain = (token) => { for (let i = 0; i < 6; i++) { const u = ups(token, 0, 50); if (!u.length) return; } };

let ORG, ORG2, PUB, PUB2, BOT1, T1, BC1, TW1;
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
  sql(`delete from public.msgr_settings where key = 'free_limits_grace_until'`); // 한도는 유예가 끝난 뒤를 본다
  // a = 조직 주인(봇 주인), c = 같은 조직 관리자, d = 같은 조직 멤버, b·e = a의 친구(조직 밖), f = 계정 삭제용(자기 조직)
  ORG = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const [uid, role] of [[U.c, 'admin'], [U.d, 'member']]) {
    const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', '${role}', '${U.a}') returning code`));
    asUser(uid, `select public.msgr_accept_invite('${code}')`);
  }
  ORG2 = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean2', 'lean2', '${U.a}') returning id`));
  PUB = last(asUser(U.a, `select public.msgr_create_channel('${ORG}', 'public', 'pub')`));
  PUB2 = last(asUser(U.a, `select public.msgr_create_channel('${ORG2}', 'public', 'pub2')`));
  for (const u of [U.a, U.b, U.d, U.e]) asUser(u, `select public.msgr_set_ai_consent(true)`); // c는 명시적 동의 없음(동의 경계 테스트)
  befriend(U.a, U.b); befriend(U.a, U.e); befriend(U.b, U.e);
  const out = mkBot(U.a, ORG, 'Hermes', 'hermes:main');
  BOT1 = out.bot_id; T1 = out.token; BC1 = out.crew_id; TW1 = twinOf(BOT1);
  asUser(U.a, `select public.msgr_crew_join('${PUB}', '${BC1}')`);
});

test('생성과 노출: 봇을 만들면 쌍둥이·핀이 생기고 주인에게만 보인다(조직 동료·친구·익명은 못 본다)', { skip }, () => {
  assert.match(TW1, /^[0-9a-f-]{36}$/, '쌍둥이 생성');
  assert.equal(sql(`select coalesce(org_id::text,'NULL')||'/'||hosting||'/'||allow||'/'||owner_user_id||'/'||status from public.msgr_crews where id='${TW1}'`), `NULL/bot/owner/${U.a}/active`);
  assert.equal(sql(`select (select slug from public.msgr_crews where id='${TW1}') = (select slug from public.msgr_crews where id='${BC1}')`), 't', 'slug = 조직 봇 크루(접속 표시를 빌린다)');
  assert.equal(sql(`select p.pin_hash = b.token_hash from public.msgr_bot_personal p join public.msgr_bots b on b.id = p.bot_id where p.bot_id='${BOT1}'`), 't', '만든 사람 = 주인 → 바로 핀');
  const mine = roomCrews(U.a).find((r) => r.id === TW1);
  assert.ok(mine, '주인 목록에 쌍둥이');
  assert.equal(mine.bot_kind, 'hermes'); assert.equal(mine.ready, true); assert.equal(mine.org_label, null, '같은 에이전트가 하나면 조직 이름 없음');
  assert.equal(asUser(U.c, `select count(*) from public.msgr_crews where id='${TW1}'`), '0', '같은 조직 관리자도 쌍둥이 행을 못 본다');
  assert.ok(!roomCrews(U.c).some((r) => r.id === TW1)); assert.ok(!roomCrews(U.b).some((r) => r.id === TW1), '친구도(같은 방이 아니면) 못 본다');
  fails(asUserRaw(U.a, `select * from public.msgr_bot_personal`), /permission denied/, '매핑 표는 사람에게 권한 없음');
  fails(asAnonRaw(`select * from public.msgr_bot_personal`), /permission denied/, '익명도');
  fails(asUserRaw(U.a, `select public._msgr_bot_twin_pin('${BOT1}')`), /permission denied/, '내부 함수는 사람이 못 부른다');
  fails(asAnonRaw(`select public._msgr_bot_twin('${BOT1}')`), /permission denied/, '내부 함수는 익명도 못 부른다');
  fails(asUserRaw(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, allow) values (null, '${U.a}', 'bot', 'fake', 'fake', 'bot', 'owner')`), /msgr_bot_rpc_only|row-level security/, '사용자가 봇 개인 행을 직접 만들지 못한다');
});

test('같은 에이전트를 두 조직에 연결하면 쌍둥이 둘, 주인에게만 조직 이름이 붙는다', { skip }, () => {
  const b2 = mkBot(U.a, ORG2, 'Hermes', 'hermes:main');
  const solo = mkBot(U.a, ORG2, 'Solo', 'hermes:solo');
  const rows = roomCrews(U.a);
  const tw2 = twinOf(b2.bot_id);
  assert.equal(rows.find((r) => r.id === TW1)?.org_label, 'Lean');
  assert.equal(rows.find((r) => r.id === tw2)?.org_label, 'Lean2');
  assert.equal(rows.find((r) => r.id === twinOf(solo.bot_id))?.org_label, null, '하나뿐인 에이전트는 라벨 없음');
  asUser(U.a, `select public.msgr_bot_revoke('${solo.bot_id}')`);
  asUser(U.a, `select public.msgr_bot_revoke('${b2.bot_id}')`);
  assert.equal(roomCrews(U.a).find((r) => r.id === TW1)?.org_label, null, '다른 쪽을 폐기하면 라벨이 사라진다');
});

let CH1;
test('크루 1:1: 주인 글은 개인 getUpdates로(to·실행 시도), 답은 쌍둥이 이름으로 · 남은 1:1을 못 연다 · 조직/개인 응답이 섞이지 않는다', { skip }, () => {
  drain(T1);
  CH1 = last(asUser(U.a, `select public.msgr_dm_personal_crew('${TW1}')`));
  fails(asUserRaw(U.b, `select public.msgr_dm_personal_crew('${TW1}')`), /msgr_bad_member/, '친구는 남의 쌍둥이와 1:1 못 연다');
  fails(asUserRaw(U.c, `select public.msgr_dm_personal_crew('${TW1}')`), /msgr_bad_member/, '조직 관리자도');
  fails(asUserRaw(U.a, `select public.msgr_dm_personal_crew('${BC1}')`), /msgr_bad_member/, '조직 봇 크루는 개인 1:1 아님');
  const p = post(U.a, CH1, '안녕');
  const o = post(U.a, PUB, '@Hermes 조직 일', to(BC1));
  const first = ups(T1, 0, 10);
  assert.deepEqual(first.map((u) => u.update_id), [Number(o)], '조직 글이 먼저, 한 응답에 개인 글 없음');
  assert.equal(first[0].message.personal, undefined);
  const second = ups(T1, Number(o), 10);
  assert.deepEqual(second.map((u) => u.update_id), [Number(p)], '조직이 비면 개인 글');
  const m = second[0].message;
  assert.equal(m.personal, true); assert.equal(m.chat.id, CH1); assert.equal(m.delivery_role, 'to'); assert.match(m.execution_attempt, /^[0-9a-f-]{36}$/);
  assert.equal(m.from.id, U.a); assert.deepEqual(m.attachments, []);
  const rid = last(finish(T1, CH1, '반가워요', p, m.execution_attempt));
  assert.equal(sql(`select crew_id||'/'||coalesce(org_id::text,'NULL')||'/'||client_msg_id from public.msgr_messages where id=${rid}`), `${TW1}/NULL/reply:${TW1}:${p}`, '답 작성자 = 쌍둥이');
  assert.equal(last(finish(T1, CH1, '반가워요', p, m.execution_attempt)), rid, '같은 답 다시 보내면 같은 id(멱등)');
  assert.equal(ups(T1, Number(p), 10).length, 0, '다시 오지 않는다');
  // delivery_protocol=1(Hermes 최신) 경로도 같은 함수를 탄다
  const p2 = post(U.a, CH1, '두 번째');
  const d = upsD(T1, Number(p), 10);
  assert.deepEqual(d.map((u) => u.update_id), [Number(p2)]);
  finish(T1, CH1, 'ok', p2, d[0].message.execution_attempt);
  // 입력 중 표시는 그 방 토픽으로(쌍둥이 id)
  asAnon(`select public.msgr_bot_typing('${T1}', '${CH1}')`);
  assert.equal(sql(`select topic||'/'||(payload->>'crew_id') from realtime.sent order by id desc limit 1`), `dm:${CH1}/${TW1}`);
  // 먼저 보내기(답글 아님)도 쌍둥이로
  const sent = last(asAnon(`select public.msgr_bot_send('${T1}', '${CH1}', '알림입니다')`));
  assert.equal(sql(`select crew_id from public.msgr_messages where id=${sent}`), TW1);
});

let AB;
test('친구 방: @로만 · 친구의 @는 거부 · 지시 범위는 주인 고정(넓히기·잠금 우회 불가, H2) · 문맥에 친구 글 없음 · 친구에게 역할·라벨 숨김', { skip }, () => {
  drain(T1);
  AB = last(asUser(U.a, `select public.msgr_dm_personal('${U.b}')`));
  assert.equal(join(U.a, AB, TW1), 'joined', '주인은 친구 방에 쌍둥이를 넣는다');
  fails(asUserRaw(U.a, `select public.msgr_crew_join('${AB}', '${BC1}')`), /msgr_bad_member/, '조직 봇 크루는 개인 방에 못 들어온다');
  fails(asUserRaw(U.a, `select public.msgr_crew_join('${PUB}', '${TW1}')`), /msgr_bad_member/, '쌍둥이는 조직 채널에 못 들어간다');
  post(U.a, AB, '친구야 밥 먹었어?');
  const secret = post(U.b, AB, '친구의 비밀 이야기');
  fails(postRaw(U.b, AB, '@Hermes 내 일 해줘', to(TW1)), /msgr_not_allowed/, '친구의 @는 글째 거부');
  assert.equal(sql(`select public.msgr_instruct_check('${TW1}', '${U.b}', '${AB}')`), 'crew_allow');
  // H2: 주인이 직접 넓히지 못한다(잠금 트리거) · 트리거를 건너뛰는 슈퍼유저도 표 제약이 막는다
  fails(asUserRaw(U.a, `update public.msgr_crews set allow='all' where id='${TW1}'`), /msgr_not_allowed/, '주인이 allow를 all로');
  fails(asUserRaw(U.a, `update public.msgr_crews set allow='list', allow_users=array['${U.b}']::uuid[] where id='${TW1}'`), /msgr_not_allowed/, '주인이 list로');
  fails(psqlRaw(['-c', `set msgr.bot_twin = '1'; update public.msgr_crews set allow='all' where id='${TW1}'`]), /msgr_crews_personal_local/, '플래그를 켜도 표 제약');
  sql(`update public.msgr_org_policies set allow_locked = true, allow_default = 'all' where org_id = '${ORG}'`); // 조직 잠금이 all이어도 쌍둥이는 주인만
  assert.equal(sql(`select public.msgr_instruct_check('${TW1}', '${U.b}', '${AB}')`), 'crew_allow', '조직 허용 잠금은 쌍둥이에 번지지 않는다');
  sql(`update public.msgr_org_policies set allow_locked = false, allow_default = 'owner' where org_id = '${ORG}'`);
  fails(asUserRaw(U.a, `update public.msgr_crews set display_name='바꿈' where id='${TW1}'`), /msgr_not_allowed/, '이름은 조직 RPC만');
  fails(asUserRaw(U.a, `update public.msgr_crews set role_text='바꿈' where id='${TW1}'`), /msgr_not_allowed/, '역할은 조직 RPC만');
  fails(asUserRaw(U.a, `update public.msgr_crews set status='available' where id='${TW1}'`), /msgr_not_allowed/, '상태는 RPC만');
  assert.equal(asUser(U.a, `with u as (update public.msgr_crews set face='{"shape":1,"color":2,"eyes":0}'::jsonb where id='${TW1}' returning 1) select count(*) from u`), '1', '얼굴은 주인이 바꾼다');
  assert.equal(ups(T1, 0, 10).length, 0, '부르지 않은 주인 글·친구 글은 안 간다');
  const call = post(U.a, AB, '@Hermes 정리해줘', to(TW1));
  const got = ups(T1, 0, 10);
  assert.deepEqual(got.map((u) => u.update_id), [Number(call)], '주인의 @만 간다');
  const texts = got[0].message.context.map((c) => c.text);
  assert.ok(!texts.includes('친구의 비밀 이야기'), 'M4: 친구 글은 문맥에 없다');
  assert.ok(texts.includes('친구야 밥 먹었어?'), '주인 글은 문맥에');
  assert.ok(!JSON.stringify(got[0]).includes('친구의 비밀'), `응답 어디에도 친구 글(${secret}) 없음`);
  finish(T1, AB, '정리했습니다', call, got[0].message.execution_attempt);
  const seen = roomCrews(U.b).find((r) => r.id === TW1);
  assert.ok(seen, '같은 방 친구에게는 표시용으로 보인다');
  assert.equal(seen.role_text, null, 'M4: 친구에게 역할 문구(조직이 쓴 것)를 숨긴다');
  assert.equal(seen.bot_kind, null); assert.equal(seen.org_label, null); assert.equal(seen.ready, null);
});

test('무료 4명 한도에 쌍둥이도 들어간다', { skip }, () => {
  const [x1, x2] = ['p1', 'p2'].map((s) => personalCrew(U.a, s));
  assert.equal(join(U.a, AB, x1), 'joined', '사람 2 + 쌍둥이 + 크루 = 4');
  fails(asUserRaw(U.a, `select public.msgr_crew_join('${AB}', '${x2}')`), /msgr_room_limit/, '5번째는 거부');
  asUser(U.a, `select public.msgr_crew_leave_channel('${AB}', '${x1}')`);
});

test('경계: 쌍둥이가 없는 방·남의 방·다른 조직 채널은 거부, 이름은 모두 엣지 ERR에 있는 것', { skip }, () => {
  const AE = last(asUser(U.a, `select public.msgr_dm_personal('${U.e}')`));
  fails(asAnonRaw(`select public.msgr_bot_send('${T1}', '${AE}', 'x')`), /msgr_bot_not_member/, '쌍둥이가 없는 내 방');
  fails(asAnonRaw(`select public.msgr_bot_typing('${T1}', '${AE}')`), /msgr_bot_not_member/, '입력 중도');
  const BE = last(asUser(U.b, `select public.msgr_dm_personal('${U.e}')`));
  fails(asAnonRaw(`select public.msgr_bot_send('${T1}', '${BE}', 'x')`), /msgr_bot_not_member/, '남의 개인 방');
  fails(asAnonRaw(`select public.msgr_bot_send('${T1}', '${PUB2}', 'x')`), /msgr_bot_no_channel/, '다른 조직 채널');
  const be = post(U.b, BE, '남의 방 글');
  fails(finishRaw(T1, BE, 'x', be, '00000000-0000-4000-8000-000000000000'), /msgr_not_allowed/, '남의 방 글에 답');
});

test('핀(H4): 주인 아닌 관리자가 회전하면 조직은 정상·개인은 멈춤(안내 한 번) → 주인이 회전하면 다시(멈춘 동안 글은 늦게 안 간다)', { skip }, () => {
  drain(T1);
  const t2 = last(asUser(U.c, `select public.msgr_bot_rotate('${BOT1}')`));
  const o = post(U.a, PUB, '@Hermes 조직', to(BC1));
  assert.deepEqual(ups(t2, 0, 10).map((u) => u.update_id), [Number(o)], '조직 쪽은 새 토큰으로 정상');
  assert.equal(roomCrews(U.a).find((r) => r.id === TW1)?.ready, false, '주인 목록에 다시 연결 필요');
  const p = post(U.a, CH1, '멈춘 동안 글');
  assert.equal(ups(t2, Number(o), 10).length, 0, '개인 글은 다른 관리자 서버로 가지 않는다');
  assert.equal(sql(`select count(*) from public.msgr_messages where channel_id='${CH1}' and client_msg_id like 'paused:${TW1}:%'`), '1', 'M5: 안내 한 번');
  post(U.a, CH1, '또');
  assert.equal(sql(`select count(*) from public.msgr_messages where channel_id='${CH1}' and client_msg_id like 'paused:${TW1}:%'`), '1', '안내는 한 번만');
  fails(asAnonRaw(`select public.msgr_bot_send('${t2}', '${CH1}', 'x')`), /msgr_not_allowed/, '개인 방 보내기 403(엣지 ERR에 있는 이름)');
  fails(asAnonRaw(`select public.msgr_bot_typing('${t2}', '${CH1}')`), /msgr_not_allowed/, '입력 중도');
  fails(finishRaw(t2, CH1, 'x', p, null), /msgr_not_allowed/, '답도');
  T1 = last(asUser(U.a, `select public.msgr_bot_rotate('${BOT1}')`));
  assert.equal(roomCrews(U.a).find((r) => r.id === TW1)?.ready, true, '주인이 회전하면 다시');
  assert.equal(ups(T1, 0, 10).filter((u) => u.message.personal).length, 0, '멈춘 동안의 옛 글에는 뒤늦게 답하지 않는다(커서를 끝으로)');
  const p2 = post(U.a, CH1, '다시 됨?');
  const got = ups(T1, 0, 10);
  assert.deepEqual(got.map((u) => u.update_id), [Number(p2)]);
  finish(T1, CH1, '네', p2, got[0].message.execution_attempt);
});

test('서버 연결(H4): 다른 관리자가 자기 연결을 자기가 승인해도 주인의 개인 쪽은 멈춘다 · 만든 사람 = 승인자면 핀 · 다르면 핀 안 함', { skip }, () => {
  const link = (uid, host, agentId, hash) => {
    const l = JSON.parse(last(asUser(uid, `select public.msgr_server_link_create('${ORG}')`)));
    asAnon(`select public.msgr_server_link_report('${l.code}', '${host}', '[{"kind":"hermes","id":"${agentId}","name":"Vps ${agentId}","token_hash":"${hash}","token_hint":"argo_bot_abc"}]'::jsonb)`);
    return l.link_id;
  };
  const h = (n) => String(n).repeat(64).slice(0, 64);
  // c가 만들고 c가 승인 → c 소유 새 봇, 핀
  const l1 = link(U.c, 'srv1', 'v1', h(1));
  const out1 = JSON.parse(last(asUser(U.c, `select public.msgr_server_link_approve('${l1}', '[{"kind":"hermes","id":"v1"}]'::jsonb)`)));
  const vb = out1[0].bot_id; const vtw = twinOf(vb);
  assert.equal(sql(`select pin_hash from public.msgr_bot_personal where bot_id='${vb}'`), h(1), '만든 사람 = 승인자 = 주인 → 서버 토큰으로 핀');
  // a(주인 아님)가 같은 서버·에이전트로 자기 연결을 만들고 자기가 승인 → 조직 쪽 토큰은 바뀌지만 c의 개인 쪽은 그대로(멈춤)
  const l2 = link(U.a, 'srv1', 'v1', h(2));
  asUser(U.a, `select public.msgr_server_link_approve('${l2}', '[{"kind":"hermes","id":"v1"}]'::jsonb)`);
  assert.equal(sql(`select token_hash from public.msgr_bots where id='${vb}'`), h(2));
  assert.equal(sql(`select pin_hash from public.msgr_bot_personal where bot_id='${vb}'`), h(1), '다른 관리자의 연결로 다시 핀하지 않는다');
  assert.equal(roomCrews(U.c).find((r) => r.id === vtw)?.ready, false);
  // c가 다시 연결 → 다시 핀
  const l3 = link(U.c, 'srv1', 'v1', h(3));
  asUser(U.c, `select public.msgr_server_link_approve('${l3}', '[{"kind":"hermes","id":"v1"}]'::jsonb)`);
  assert.equal(sql(`select pin_hash from public.msgr_bot_personal where bot_id='${vb}'`), h(3));
  assert.equal(roomCrews(U.c).find((r) => r.id === vtw)?.ready, true);
  // a가 만든 연결을 c가 승인 → c 소유 새 봇이지만 토큰은 a가 명령을 실행한 서버에 있다 → 핀 안 함
  const l4 = link(U.a, 'srv2', 'v2', h(4));
  const out4 = JSON.parse(last(asUser(U.c, `select public.msgr_server_link_approve('${l4}', '[{"kind":"hermes","id":"v2"}]'::jsonb)`)));
  assert.notEqual(sql(`select pin_hash from public.msgr_bot_personal where bot_id='${out4[0].bot_id}'`), h(4));
  assert.equal(roomCrews(U.c).find((r) => r.id === twinOf(out4[0].bot_id))?.ready, false, '다시 연결 필요');
});

test('수명 주기: 조직 상태(주인 탈퇴·연체 잠금)에는 #779 개인 크루와 똑같이 묶이지 않는다 · 폐기하면 쌍둥이 detached·방에서 빠짐(쓴 글은 남음) · 봇이 지워지면 detached', { skip }, () => {
  const cb = mkBot(U.c, ORG, 'CBot');
  const ctw = twinOf(cb.bot_id);
  const local = personalCrew(U.c, 'c779'); // 대조군: #779 개인 Argo 크루
  const lch = last(asUser(U.c, `select public.msgr_dm_personal_crew('${local}')`));
  const tch = last(asUser(U.c, `select public.msgr_dm_personal_crew('${ctw}')`));
  const same = (label) => {
    const lm = post(U.c, lch, `${label} — 개인 크루`); const tm = post(U.c, tch, `${label} — 쌍둥이`);
    const l = sql(`select public.msgr_delivery_allowed('${local}', ${lm})`); const t = sql(`select public.msgr_delivery_allowed('${ctw}', ${tm})`);
    assert.equal(t, l, `${label}: 쌍둥이 배달 판정 = #779 개인 크루`);
    assert.equal(t, 't', `${label}: 둘 다 계속 된다`);
    assert.equal(roomCrews(U.c).find((r) => r.id === ctw)?.ready, true, `${label}: 다시 연결 필요 아님`);
    assert.match(last(asAnon(`select public.msgr_bot_send('${cb.token}', '${tch}', '${label} 보내기')`)), /^\d+$/, `${label}: 개인 방 보내기 됨`);
  };
  same('평소');
  sql(`update public.msgr_org_members set removed_at = now() where org_id='${ORG}' and user_id='${U.c}'`);
  assert.equal(sql(`select status from public.msgr_crews where id='${cb.crew_id}'`), 'detached', '조직 쪽 봇 크루는 오프보딩으로 detached');
  same('주인 조직 탈퇴');
  sql(`update public.msgr_org_members set removed_at = null where org_id='${ORG}' and user_id='${U.c}'`);
  sql(`update public.msgr_org_entitlements set ls_status = 'past_due' where org_id='${ORG}'`);
  assert.equal(sql(`select public.msgr_org_locked('${ORG}')`), 't');
  same('조직 연체 잠금');
  sql(`update public.msgr_org_entitlements set ls_status = null where org_id='${ORG}'`);
  const said = last(asAnon(`select public.msgr_bot_send('${cb.token}', '${tch}', '쌍둥이가 쓴 글')`));
  asUser(U.a, `select public.msgr_bot_revoke('${cb.bot_id}')`);
  assert.equal(sql(`select status from public.msgr_crews where id='${ctw}'`), 'detached');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where member_kind='crew' and member_id='${ctw}'`), '0', '방에서 빠진다');
  assert.equal(sql(`select crew_id from public.msgr_messages where id=${said}`), ctw, '쌍둥이가 쓴 글은 남는다(작성자 보존)');
  assert.ok(!roomCrews(U.c).some((r) => r.id === ctw && r.status === 'active'));
  const gone = mkBot(U.a, ORG, 'Gone');
  const gtw = twinOf(gone.bot_id);
  sql(`delete from public.msgr_bots where id='${gone.bot_id}'`);
  assert.equal(sql(`select status from public.msgr_crews where id='${gtw}'`), 'detached', '봇(조직 삭제 연쇄 포함)이 지워지면 detached');
});

test('이름·역할 변경은 조직 RPC로만, 쌍둥이에 같이 반영된다', { skip }, () => {
  asUser(U.a, `select public.msgr_bot_rename('${BOT1}', 'Hermes2')`);
  asUser(U.a, `select public.msgr_bot_set_role('${BC1}', '리서치')`);
  assert.equal(sql(`select display_name||'/'||role_text from public.msgr_crews where id='${TW1}'`), 'Hermes2/리서치');
});

test('오프셋: 개인 글 ack가 조직 보류 글을 건너뛰지 않는다(E4 반대) · 조직 cc는 반복 안 됨 · 조직 대기 글이 있으면 조직만 · 개인 발송 없는 봇은 ack 그대로', { skip }, () => {
  drain(T1);
  // 봇이 아직 없는 비공개 채널에서 봇을 부른 글 H(보류 — 초대되면 배달)
  const PRIV = last(asUser(U.a, `select public.msgr_create_channel('${ORG}', 'private', 'later')`));
  const H = post(U.a, PRIV, '@Hermes 나중에', to(BC1));
  assert.equal(ups(T1, 0, 10).filter((u) => !u.message.personal).length, 0, 'H는 아직 안 온다');
  const P = post(U.a, CH1, '개인 글');
  const got = ups(T1, 0, 10);
  assert.deepEqual(got.map((u) => u.update_id), [Number(P)]);
  finish(T1, CH1, '네', P, got[0].message.execution_attempt);
  ups(T1, Number(P), 10); // P로 ack
  assert.ok(Number(sql(`select cursor_msg_id from public.msgr_crews where id='${BC1}'`)) < Number(H), '조직 커서가 H를 넘지 않는다');
  asUser(U.a, `select public.msgr_crew_join('${PRIV}', '${BC1}')`);
  const late = ups(T1, Number(P), 10);
  assert.deepEqual(late.map((u) => u.update_id), [Number(H)], '초대하면 H가 온다');
  finish(T1, PRIV, 'ok', H, late[0].message.execution_attempt);
  // 조직 cc(1:1, 실행 기록 없음): ack하면 다시 오지 않는다 — 조직 배달 기록(org_sent_id)이 ack 상한을 함께 올린다
  const DM = last(sql(`insert into public.msgr_channels (org_id, kind, name, created_by) values ('${ORG}', 'dm', 'dm', '${U.a}') returning id`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values ('${DM}', 'user', '${U.a}', '${U.a}'), ('${DM}', 'crew', '${BC1}', '${U.a}')`);
  const C = post(U.a, DM, '참고만', `[{"kind":"crew","id":"${BC1}","role":"cc"}]`);
  const cc = upsD(T1, Number(H), 10);
  assert.deepEqual(cc.map((u) => [u.update_id, u.message.delivery_role]), [[Number(C), 'cc']]);
  assert.equal(upsD(T1, Number(C), 10).length, 0, 'cc를 ack하면 다시 오지 않는다');
  // 조직 대기 글과 개인 대기 글이 같이 있으면 조직만
  const P2 = post(U.a, CH1, '개인 2');
  const O2 = post(U.a, PUB, '@Hermes 조직 2', to(BC1));
  const r1 = ups(T1, Number(C), 10);
  assert.deepEqual(r1.map((u) => u.update_id), [Number(O2)], '조직 글만');
  finish(T1, PUB, 'ok', O2, r1[0].message.execution_attempt);
  const r2 = ups(T1, Number(O2), 10);
  assert.deepEqual(r2.map((u) => u.update_id), [Number(P2)], '그다음 개인 글(조직 ack가 쌍둥이 커서를 P2 너머로 밀지 않았다)');
  finish(T1, CH1, 'ok', P2, r2[0].message.execution_attempt);
});

test('H3: 개인 발송이 한 번도 없던 봇 — 개인 글 P보다 뒤의 조직 글을 ack해도 P는 온다 · 그 전까지 조직 ack는 종전과 같다', { skip }, () => {
  const n = mkBot(U.a, ORG, 'Fresh');
  asUser(U.a, `select public.msgr_crew_join('${PUB}', '${n.crew_id}')`);
  const ntw = twinOf(n.bot_id);
  const nch = last(asUser(U.a, `select public.msgr_dm_personal_crew('${ntw}')`));
  const P = post(U.a, nch, '먼저 쓴 개인 글');
  const O1 = post(U.a, PUB, '@Fresh 1', to(n.crew_id));
  const O2 = post(U.a, PUB, '@Fresh 2', to(n.crew_id));
  const a1 = ups(n.token, 0, 1); assert.deepEqual(a1.map((u) => u.update_id), [Number(O1)]);
  const a2 = ups(n.token, Number(O1), 1); assert.deepEqual(a2.map((u) => u.update_id), [Number(O2)]);
  assert.equal(sql(`select cursor_msg_id from public.msgr_crews where id='${n.crew_id}'`), O1, '개인 발송 전: 조직 커서 = ack(종전과 같다)');
  const a3 = ups(n.token, Number(O2), 1);
  assert.deepEqual(a3.map((u) => u.update_id), [Number(P)], 'P가 온다(least(NULL) 함정 없음)');
  assert.equal(sql(`select personal_sent_id from public.msgr_bot_personal where bot_id='${n.bot_id}'`), P);
});

test('DB 위생: 유휴 호출은 봇·조직 크루·쌍둥이·매핑 어디에도 쓰지 않는다(쌍둥이가 방에 있을 때와 없을 때)', { skip }, () => {
  const xmins = (bot, crew, tw) => sql(`select (select xmin::text from public.msgr_bots where id='${bot}')||'/'||(select xmin::text from public.msgr_crews where id='${crew}')||'/'||(select xmin::text from public.msgr_crews where id='${tw}')||'/'||(select xmin::text from public.msgr_bot_personal where bot_id='${bot}')`);
  const idle = mkBot(U.a, ORG, 'Idle');
  for (const [token, bot, crew, tw] of [[idle.token, idle.bot_id, idle.crew_id, twinOf(idle.bot_id)], [T1, BOT1, BC1, TW1]]) {
    ups(token, 0, 10); ups(token, 0, 10); // 첫 스캔이 지문을 남긴다
    const before = xmins(bot, crew, tw);
    for (let i = 0; i < 3; i++) assert.equal(ups(token, 0, 10).length, 0);
    assert.equal(xmins(bot, crew, tw), before, `유휴 쓰기 0 (${tw === TW1 ? '방 여러 개' : '방 없음'})`);
  }
});

test('검수 #794 M-1: 배달 뒤 실행이 끝나기 전에 그 글이 지워져도 보류가 끝나 유휴 쓰기 0(30초마다 갱신하지 않는다)', { skip }, () => {
  drain(T1);
  const P = post(U.a, CH1, '곧 지울 글');
  const got = ups(T1, 0, 10);
  assert.deepEqual(got.map((u) => u.update_id), [Number(P)]);
  asUser(U.a, `update public.msgr_messages set deleted_at = now() where id = ${P}`); // 방 보관·나가기·차단도 같은 모양(배달 판정이 거짓)
  fails(finishRaw(T1, CH1, '답', P, got[0].message.execution_attempt), /msgr_not_allowed/, '지운 글에는 답이 저장되지 않는다');
  ups(T1, 0, 10); ups(T1, 0, 10); // 지문을 남기는 스캔
  assert.equal(sql(`select scan_pending from public.msgr_bot_personal where bot_id='${BOT1}'`), 'f', '끝난 실행을 기다리지 않는다');
  const xmin = () => sql(`select xmin::text from public.msgr_bot_personal where bot_id='${BOT1}'`);
  const before = xmin();
  sql(`update public.msgr_bot_personal set scan_at = now() - interval '31 seconds' where bot_id='${BOT1}'`); // 30초가 지난 것처럼
  const aged = xmin();
  for (let i = 0; i < 3; i++) assert.equal(ups(T1, 0, 10).length, 0);
  assert.equal(xmin(), aged, '30초가 지나도 다시 쓰지 않는다(보류 없음)');
  assert.notEqual(before, '', 'xmin 읽음');
  // 결과를 기다리는 실행도 11분이 지나면(안내가 막혀도) 보류를 끝낸다
  const Q = post(U.a, CH1, '오래된 실행');
  const g2 = ups(T1, 0, 10);
  assert.deepEqual(g2.map((u) => u.update_id), [Number(Q)]);
  sql(`update public.msgr_executions set heartbeat_at = now() - interval '12 minutes' where crew_id='${TW1}' and source_msg_id=${Q}`);
  sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, client_msg_id, body, meta) values ('${CH1}', 'crew', '${TW1}', 'system', 'unknown:${TW1}:${Q}', 'x', '{"disposition":"done"}')`);
  sql(`update public.msgr_bot_personal set scan_key = null where bot_id='${BOT1}'`);
  ups(T1, 0, 10); ups(T1, 0, 10);
  assert.equal(sql(`select scan_pending from public.msgr_bot_personal where bot_id='${BOT1}'`), 'f');
  sql(`update public.msgr_executions set state = 'completed' where crew_id='${TW1}' and source_msg_id in (${P}, ${Q})`);
});

test('결과 미도착 안내(10분)는 쌍둥이 기준으로 한 번만', { skip }, () => {
  drain(T1);
  const P = post(U.a, CH1, '오래 걸리는 일');
  const got = ups(T1, 0, 10);
  assert.deepEqual(got.map((u) => u.update_id), [Number(P)]);
  sql(`update public.msgr_executions set heartbeat_at = now() - interval '11 minutes' where crew_id='${TW1}' and source_msg_id=${P}`);
  ups(T1, 0, 10); ups(T1, 0, 10);
  sql(`update public.msgr_bot_personal set scan_key = null where bot_id='${BOT1}'`); // 30초 보류 재검사를 앞당긴다
  ups(T1, 0, 10);
  assert.equal(sql(`select count(*) from public.msgr_messages where client_msg_id='unknown:${TW1}:${P}'`), '1');
  finish(T1, CH1, '끝', P, got[0].message.execution_attempt);
});

test('미지원(#779와 같음): 개인 글에 파일·결재 카드는 엣지 ERR의 403 이름으로 거부', { skip }, () => {
  drain(T1);
  const P = post(U.a, CH1, '파일 줘');
  const got = ups(T1, 0, 10);
  const rid = last(finish(T1, CH1, '여기', P, got[0].message.execution_attempt));
  fails(asAnonRaw(`select public.msgr_bot_attach_prepare('${T1}', ${rid}, 'a.txt', 10)`), /msgr_bot_bad_attach_target/, '개인 방 파일');
  const P2 = post(U.a, CH1, '위험한 일');
  const g2 = ups(T1, 0, 10);
  fails(asAnonRaw(`select public.msgr_bot_request_approval('${T1}', '${g2[0].message.execution_attempt}', 'ap1', 'rm -rf /')`), /msgr_not_allowed/, '결재 카드');
  fails(asAnonRaw(`select public.msgr_bot_request_agent_approval('${T1}', '${g2[0].message.execution_attempt}', 'ap2', '제목')`), /msgr_not_allowed/, '에이전트 결재');
  finish(T1, CH1, 'ok', P2, g2[0].message.execution_attempt);
});

test('개인 방 AI 동의는 명시적 동의만: 동의 전엔 안내 한 번·배달 없음, 동의하면 그 글이 간다', { skip }, () => {
  const cb = mkBot(U.c, ORG, 'Consent');
  const ctw = twinOf(cb.bot_id);
  const cch = last(asUser(U.c, `select public.msgr_dm_personal_crew('${ctw}')`));
  const P = post(U.c, cch, '해줘');
  assert.equal(ups(cb.token, 0, 10).length, 0);
  post(U.c, cch, '또 해줘');
  assert.equal(ups(cb.token, 0, 10).length, 0);
  assert.equal(sql(`select count(*) from public.msgr_messages where client_msg_id='aiconsent:${ctw}:${cch}'`), '1', '안내 한 번');
  asUser(U.c, `select public.msgr_set_ai_consent(true)`);
  const got = ups(cb.token, 0, 10);
  assert.equal(got[0]?.update_id, Number(P), '동의하면 보류된 글부터');
});

test('계정 삭제: 쌍둥이도 사라진다', { skip }, () => {
  const code = last(asUser(U.a, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'admin', '${U.a}') returning code`));
  asUser(U.f, `select public.msgr_accept_invite('${code}')`);
  const fb = mkBot(U.f, ORG, 'FBot');
  const ftw = twinOf(fb.bot_id);
  assert.match(ftw, /^[0-9a-f-]{36}$/);
  sql(`delete from auth.users where id='${U.f}'`);
  assert.equal(sql(`select count(*) from public.msgr_crews where id='${ftw}'`), '0');
  assert.equal(sql(`select count(*) from public.msgr_bot_personal where bot_id='${fb.bot_id}'`), '0');
});

test('백필(M3): 근거가 있는 봇만 핀, 다른 관리자가 마지막으로 회전한 봇·연결 기록 없는 서버 봇은 다시 연결 필요', { skip }, () => {
  const ok = mkBot(U.a, ORG, 'BfOk'); const rot = mkBot(U.a, ORG, 'BfRot'); const vps = mkBot(U.a, ORG, 'BfVps', 'vps:gone:hermes:x');
  asUser(U.c, `select public.msgr_bot_rotate('${rot.bot_id}')`); // 다른 관리자가 마지막 회전
  sql(`delete from public.msgr_crews where id in (select crew_id from public.msgr_bot_personal where bot_id in ('${ok.bot_id}', '${rot.bot_id}', '${vps.bot_id}'))`); // 마이그레이션 전 상태로(쌍둥이·매핑 없음)
  const body = readFileSync(mig('20261001140000_msgr_personal_bots.sql'), 'utf8');
  psql(['-c', body.slice(body.indexOf('do $$\ndeclare r record;'), body.lastIndexOf('notify pgrst'))]);
  const pinned = (id) => sql(`select p.pin_hash = b.token_hash from public.msgr_bot_personal p join public.msgr_bots b on b.id = p.bot_id where p.bot_id='${id}'`);
  assert.equal(pinned(ok.bot_id), 't', '회전 없음 → 핀');
  assert.equal(pinned(rot.bot_id), 'f', '다른 관리자가 회전 → 핀 안 함');
  assert.equal(pinned(vps.bot_id), 'f', '연결 기록 없는 서버 봇 → 핀 안 함');
  psql(['-c', body.slice(body.indexOf('do $$\ndeclare r record;'), body.lastIndexOf('notify pgrst'))]);
  assert.equal(sql(`select count(*) from public.msgr_bot_personal where bot_id in ('${ok.bot_id}', '${rot.bot_id}', '${vps.bot_id}')`), '3', '다시 실행해도 같다');
});
