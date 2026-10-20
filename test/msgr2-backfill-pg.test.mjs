// 메신저 v2 U8 — 기존 데이터 이전(백필) 실제 PG 시험. 옛 msgr 전체 + msgr2를 운영 순서로 적용한 DB(setupFull)에 합성 옛 데이터를 넣는다
// (운영 데이터는 쓰지 않는다 — 설계 6절 개인정보). 조직·지운 조직·탈퇴자·만료 멤버·손님·제외 목록 public·조직 dm·같은 짝 dm·그룹 dm·
// 개인 그룹·친구 방·개인 에이전트 1:1·보관 방·작성자가 지워진 글·첨부·읽음·반응(쉼표 이모지)·고정·결재 대기·결정된 결재.
// 순서: 백필(scripts/msgr2-migrate.sh run) → 검증 → 옛 표 불변 → 옛/새 읽기 판정 대조(경우 25) → 다시 백필(쓰기 0) → claim·세대·문맥 거부
//      → 되돌림 → 중간 종료 뒤 재개(경우 13) → v2 새 행이 있으면 되돌림 거부.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-backfill-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { setupFull, v2FullMode, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-backfill-pg.test.mjs';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const migrate = (cmd) => spawnSync('bash', ['scripts/msgr2-migrate.sh', cmd], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MSGR2_MIGRATE_DB: DB } });
const ROLLBACK = readFileSync(fileURLToPath(new URL('../scripts/msgr2-migrate-rollback.sql', import.meta.url)), 'utf8');

const id = (n) => `b8000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = { O: id(1), M: id(2), G: id(3), X: id(4), E: id(5), F: id(6), Z: id(7), N: id(8), W: id(9) }; // N·W = 참여 행 없는 조직 멤버(W는 PUBX 제외 목록)
const T = id(100), T2 = id(101);
const AG1 = id(200), AG2 = id(201), AG3 = id(202); // AG3 = 자리가 하나도 없는 에이전트(게이트웨이가 자리만 지운 경우)
const PC1 = id(300), OC1 = id(301), OC2 = id(302), OC1b = id(303);
const CH = { PUB: id(400), PUBX: id(401), PRIV: id(402), ODM: id(403), OADM: id(404), ODUP: id(405), OGRP: id(406), ARCH: id(407),
             GRP: id(408), FDM: id(409), CDM: id(410), DEL: id(411) };
const AP_PENDING = id(500), AP_DONE = id(501);
const pair = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const BULK = 3200; // PUB에 넣는 사람 글 수 — 글 묶음 상한 1,000으로 4묶음

// 백필 데이터 표(작업 행·기기 표 제외) — 두 번째 실행 쓰기 0을 xmin으로 본다
const V2 = ['msgr2_agents', 'msgr2_spaces', 'msgr2_space_members', 'msgr2_agent_seats', 'msgr2_rooms', 'msgr2_room_members', 'msgr2_messages',
  'msgr2_attachments', 'msgr2_reads', 'msgr2_reactions', 'msgr2_prefs', 'msgr2_works', 'msgr2_approvals'];
const OLD = ['msgr_orgs', 'msgr_org_members', 'msgr_channels', 'msgr_channel_members', 'msgr_crews', 'msgr_agents', 'msgr_messages', 'msgr_attachments',
  'msgr_reads', 'msgr_reactions', 'msgr_channel_prefs', 'msgr_target_prefs', 'msgr_crew_approvals', 'msgr_profiles', 'msgr_friends'];

let db;
const one = (q) => db.sql(q);
const json = (q) => JSON.parse(db.sql(q));
// 옛 표 전체 내용 해시(행 순서와 무관) — 백필은 옛 표를 읽기만 한다
const oldHash = () => Object.fromEntries(OLD.map((t) => [t, one(`select count(*) || ':' || coalesce(md5(string_agg(md5(x::text), ',' order by md5(x::text))), '-') from public.${t} x`)]));
const v2Counts = () => Object.fromEntries(V2.map((t) => [t, Number(one(`select count(*) from public.${t}`))]));
const v2Xmins = () => Object.fromEntries(V2.map((t) => [t, db.xmins(t)]));
const jobs = () => db.sql(`select name || '|' || coalesce(checkpoint, '-') || '|' || (done_at is not null) || '|' || rows_written from public.msgr2_backfill_jobs order by step`).split('\n');
const room = (ch) => db.sql(`select kind || '|' || coalesce(pair_key, '-') || '|' || space_id || '|' || agent_policy || '|' || memory || '|' || (archived_at is not null) from public.msgr2_rooms where id = '${ch}'`);
const members = (ch) => db.sql(`select coalesce(string_agg(member_kind || ':' || member_id, ',' order by member_kind, member_id), '') from public.msgr2_room_members where room_id = '${ch}' and removed_at is null`);
let base, oldBefore, sentBefore, firstCounts, ids;

before(() => {
  if (!DB) return;
  db = setupFull(DB);
  v2FullMode(db); // A+ 1:1 밖 막기·Pro 검사를 끈다(이 시험은 A+ 앞 v2 전체 기능을 잠근다)
  // 합성 옛 데이터 — 옛 트리거(서버 시각·좌석·봇·푸시·중단 스위치 등)는 끄고 넣는다(운영의 "이미 쌓인 데이터" 모양을 그대로 만든다)
  const users = Object.values(U).map((u) => `('${u}')`).join(',');
  db.psql(['-c', `
    set session_replication_role = replica;
    insert into auth.users (id) values ${users};
    insert into public.msgr_profiles (user_id, display_name) values ('${U.F}', 'friend');
    insert into public.msgr_friends (a, b, status, requested_by) values ('${U.O < U.F ? U.O : U.F}', '${U.O < U.F ? U.F : U.O}', 'accepted', '${U.O}');
    insert into public.msgr_orgs (id, name, slug, owner_user_id, created_at) values ('${T}', 'Team', 'team-b8', '${U.O}', now() - interval '30 days');
    insert into public.msgr_orgs (id, name, slug, owner_user_id, created_at, deleted_at) values ('${T2}', 'Gone', 'gone-b8', '${U.O}', now() - interval '30 days', now() - interval '1 day');
    insert into public.msgr_org_members (org_id, user_id, role, display_name, joined_at, removed_at, expires_at) values
      ('${T}', '${U.O}', 'owner', 'O', now() - interval '30 days', null, null),
      ('${T}', '${U.M}', 'member', 'M', now() - interval '29 days', null, null),
      ('${T}', '${U.G}', 'guest', null, now() - interval '20 days', null, now() + interval '5 days'),
      ('${T}', '${U.X}', 'member', null, now() - interval '20 days', now() - interval '2 days', null),
      ('${T}', '${U.E}', 'member', null, now() - interval '20 days', null, now() - interval '1 day'),
      ('${T}', '${U.N}', 'member', null, now() - interval '20 days', null, null), ('${T}', '${U.W}', 'admin', null, now() - interval '20 days', null, null),
      ('${T2}', '${U.O}', 'owner', null, now() - interval '30 days', null, null),
      ('${T2}', '${U.M}', 'member', null, now() - interval '30 days', null, null);
    insert into public.msgr_agents (id, owner_user_id, ws_id, slug, created_at) values
      ('${AG1}', '${U.O}', 'w1', 'a1', now() - interval '30 days'), ('${AG2}', '${U.M}', 'w2', 'b1', now() - interval '30 days'),
      ('${AG3}', '${U.M}', 'w3', 'c1', now() - interval '30 days');
    insert into public.msgr_crews (id, org_id, owner_user_id, ws_id, slug, display_name, role_text, hosting, status, allow, allow_users, registered_at, created_at, agent_id) values
      ('${PC1}', null, '${U.O}', 'w1', 'a1', '에이전트 하나', '조사', 'local', 'active', 'owner', '{}', now() - interval '1 day', now() - interval '30 days', '${AG1}'),
      ('${OC1}', '${T}', '${U.O}', 'w1', 'a1', '조직 자리 이름', '', 'local', 'active', 'list', '{${U.M}}', now() - interval '2 days', now() - interval '29 days', '${AG1}'),
      ('${OC1b}', '${T2}', '${U.O}', 'w1', 'a1', '지운 조직 자리', '', 'local', 'active', 'all', '{}', now() - interval '3 days', now() - interval '29 days', '${AG1}'),
      ('${OC2}', '${T}', '${U.M}', 'w2', 'b1', '봇', '', 'bot', 'paused', 'all', '{}', now() - interval '2 days', now() - interval '29 days', '${AG2}');
    insert into public.msgr_channels (id, org_id, kind, name, crew_memory, created_by, created_at, archived_at, personal_crews, excluded_user_ids, excluded_crew_ids, personal_pair) values
      ('${CH.PUB}', '${T}', 'public', 'general', true, '${U.O}', now() - interval '28 days', null, 'allowed', '{}', '{${OC2}}', null),
      ('${CH.PUBX}', '${T}', 'public', 'no-m', true, '${U.O}', now() - interval '28 days', null, 'approval', '{${U.M},${U.W}}', '{}', null),
      ('${CH.PRIV}', '${T}', 'private', 'secret', false, '${U.O}', now() - interval '27 days', null, 'blocked', '{}', '{}', null),
      ('${CH.ODM}', '${T}', 'dm', 'dm', true, '${U.O}', now() - interval '26 days', null, 'allowed', '{}', '{}', null),
      ('${CH.OADM}', '${T}', 'dm', 'dm', true, '${U.O}', now() - interval '26 days', null, 'allowed', '{}', '{}', null),
      ('${CH.ODUP}', '${T}', 'dm', 'dm', true, '${U.M}', now() - interval '25 days', null, 'allowed', '{}', '{}', null),
      ('${CH.OGRP}', '${T}', 'dm', 'group', true, '${U.O}', now() - interval '25 days', null, 'allowed', '{}', '{}', null),
      ('${CH.ARCH}', '${T}', 'private', 'old', true, '${U.O}', now() - interval '25 days', now() - interval '3 days', 'allowed', '{}', '{}', null),
      ('${CH.GRP}', null, 'dm', 'friends', true, '${U.O}', now() - interval '24 days', null, 'allowed', '{}', '{}', null),
      ('${CH.FDM}', null, 'dm', 'dm', true, '${U.O}', now() - interval '24 days', null, 'allowed', '{}', '{}', '${pair(U.O, U.F)}'),
      ('${CH.CDM}', null, 'dm', 'dm', true, '${U.O}', now() - interval '24 days', null, 'read_only', '{}', '{}', 'crew:${PC1}'),
      ('${CH.DEL}', '${T2}', 'public', 'gone', true, '${U.O}', now() - interval '24 days', null, 'allowed', '{}', '{}', null);
    insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by, added_at) values
      ('${CH.PUB}', 'user', '${U.M}', '${U.M}', now() - interval '28 days'), ('${CH.PUB}', 'user', '${U.G}', '${U.O}', now() - interval '20 days'),
      ('${CH.PUB}', 'crew', '${OC1}', '${U.O}', now() - interval '28 days'), ('${CH.PUB}', 'crew', '${OC2}', '${U.M}', now() - interval '28 days'),
      ('${CH.PUBX}', 'user', '${U.O}', '${U.O}', now() - interval '28 days'), ('${CH.PUBX}', 'user', '${U.M}', '${U.O}', now() - interval '28 days'),
      ('${CH.PRIV}', 'user', '${U.O}', '${U.O}', now() - interval '27 days'), ('${CH.PRIV}', 'user', '${U.G}', '${U.O}', now() - interval '20 days'),
      ('${CH.PRIV}', 'user', '${U.X}', '${U.O}', now() - interval '20 days'),
      ('${CH.ODM}', 'user', '${U.O}', null, now() - interval '26 days'), ('${CH.ODM}', 'user', '${U.M}', null, now() - interval '26 days'),
      ('${CH.OADM}', 'user', '${U.O}', null, now() - interval '26 days'), ('${CH.OADM}', 'crew', '${OC1}', null, now() - interval '26 days'),
      ('${CH.ODUP}', 'user', '${U.O}', null, now() - interval '25 days'), ('${CH.ODUP}', 'user', '${U.M}', null, now() - interval '25 days'),
      ('${CH.OGRP}', 'user', '${U.O}', null, now() - interval '25 days'), ('${CH.OGRP}', 'user', '${U.M}', null, now() - interval '25 days'),
      ('${CH.OGRP}', 'user', '${U.E}', null, now() - interval '25 days'),
      ('${CH.ARCH}', 'user', '${U.O}', null, now() - interval '25 days'), ('${CH.ARCH}', 'user', '${U.M}', null, now() - interval '25 days'),
      ('${CH.GRP}', 'user', '${U.O}', null, now() - interval '24 days'), ('${CH.GRP}', 'user', '${U.F}', null, now() - interval '24 days'),
      ('${CH.GRP}', 'user', '${U.M}', null, now() - interval '24 days'),
      ('${CH.FDM}', 'user', '${U.O}', null, now() - interval '24 days'), ('${CH.FDM}', 'user', '${U.F}', null, now() - interval '24 days'),
      ('${CH.CDM}', 'user', '${U.O}', null, now() - interval '24 days'), ('${CH.CDM}', 'crew', '${PC1}', null, now() - interval '24 days'),
      ('${CH.DEL}', 'user', '${U.M}', null, now() - interval '24 days');
    -- 글: PUB에 대량 사람 글(1..${BULK}) + 갈래별 글(10001~)
    insert into public.msgr_messages (id, org_id, channel_id, author_kind, author_user_id, kind, body, mentions, created_at, meta) overriding system value
      select g, '${T}', '${CH.PUB}', 'user', '${U.M}', 'text', '글 ' || g, '[]', now() - interval '20 days' + g * interval '1 second', '{}' from generate_series(1, ${BULK}) g;
    insert into public.msgr_messages (id, org_id, channel_id, author_kind, author_user_id, crew_id, kind, body, mentions, reply_to, thread_root, client_msg_id, created_at, edited_at, deleted_at, meta) overriding system value values
      (10001, '${T}', '${CH.OADM}', 'crew', null, '${OC1}', 'text', '에이전트 답', '[]', null, null, null, now() - interval '10 days', null, null, '{}'),
      (10002, '${T}', '${CH.PRIV}', 'user', null, null, 'text', '지운 계정의 글', '[]', null, null, null, now() - interval '10 days', null, null, '{"x":1}'),
      (10003, '${T}', '${CH.PUB}', 'crew', null, null, 'text', '지운 크루의 글', '[]', null, null, null, now() - interval '10 days', null, null, '{}'),
      (10004, '${T}', '${CH.OADM}', 'crew', null, '${OC1}', 'approval_card', '승인 요청', '[]', null, null, null, now() - interval '9 days', null, null, '{"approval":"a1"}'),
      (10005, '${T}', '${CH.PUB}', 'system', null, null, 'system', '시스템', '[]', null, null, null, now() - interval '9 days', null, null, '{"code":"x"}'),
      (10006, '${T}', '${CH.PUB}', 'user', '${U.M}', null, 'text', '스레드 답', '[{"kind":"crew","id":"${OC1}","role":"to"},{"kind":"user","id":"${U.O}"},{"kind":"bad","id":"zz"}]', null, 1, null, now() - interval '9 days', now() - interval '8 days', null, '{}'),
      (10007, '${T}', '${CH.PUB}', 'user', '${U.M}', null, 'text', '지운 글', '[]', 10006, 1, null, now() - interval '9 days', null, now() - interval '8 days', '{}'),
      (10008, '${T}', '${CH.ODM}', 'user', '${U.O}', null, 'text', '같은 클라 id 1', '[]', null, null, 'c-1', now() - interval '8 days', null, null, '{}'),
      (10009, '${T}', '${CH.ODM}', 'user', '${U.M}', null, 'text', '같은 클라 id 2', '[]', null, null, 'c-1', now() - interval '8 days', null, null, '{}'),
      (10010, '${T}', '${CH.ODM}', 'user', '${U.M}', null, 'text', '혼자인 클라 id', '[]', null, null, 'c-2', now() - interval '8 days', null, null, '{}'),
      (10011, null, '${CH.CDM}', 'user', '${U.O}', null, 'text', '개인 에이전트에게 지시', '[]', null, null, null, now() - interval '7 days', null, null, '{}'),
      (10012, null, '${CH.FDM}', 'user', '${U.F}', null, 'text', '친구 글', '[]', null, null, null, now() - interval '7 days', null, null, '{}'),
      (10013, null, '${CH.GRP}', 'user', '${U.O}', null, 'text', '그룹 글', '[]', null, null, null, now() - interval '7 days', null, null, '{}'),
      (10014, '${T2}', '${CH.DEL}', 'user', '${U.M}', null, 'text', '지운 조직의 글', '[]', null, null, null, now() - interval '7 days', null, null, '{}'),
      (10015, '${T}', '${CH.ARCH}', 'user', '${U.O}', null, 'text', '보관 방 글', '[]', null, null, null, now() - interval '7 days', null, null, '{}'),
      (10016, '${T}', '${CH.OADM}', 'user', '${U.O}', null, 'text', '조직 에이전트 1:1 지시', '[]', null, null, null, now() - interval '7 days', null, null, '{}');
    insert into public.msgr_attachments (id, message_id, org_id, storage_path, name, mime, bytes, created_at) values
      ('${id(600)}', 10006, '${T}', '${T}/${CH.PUB}/f1.png', 'f1.png', 'image/png', 1234, now() - interval '9 days'),
      ('${id(601)}', 10012, null, 'p/${CH.FDM}/f2.txt', 'f2.txt', 'text/plain', 10, now() - interval '7 days');
    insert into public.msgr_reads (channel_id, user_id, last_read_id, updated_at) values
      ('${CH.PUB}', '${U.M}', 10007, now() - interval '1 day'), ('${CH.FDM}', '${U.O}', 10012, now() - interval '1 day'), ('${CH.ODM}', '${U.O}', 10009, now() - interval '1 day');
    insert into public.msgr_reactions (message_id, user_id, emoji, created_at) values
      (10006, '${U.O}', 'a,b', now() - interval '1 day'), (10006, '${U.M}', '👍', now() - interval '1 day'), (10012, '${U.O}', '❤️', now() - interval '1 day');
    insert into public.msgr_channel_prefs (channel_id, user_id, muted, pinned, updated_at) values
      ('${CH.PUB}', '${U.M}', true, false, now() - interval '1 day'), ('${CH.ODM}', '${U.O}', false, false, now() - interval '1 day');
    insert into public.msgr_target_prefs (user_id, org_id, target_kind, target_id, pinned) values
      ('${U.O}', '${T}', 'user', '${U.M}', true), ('${U.O}', '${T}', 'crew', '${OC1}', true);
    insert into public.msgr_crew_approvals (id, org_id, channel_id, crew_id, approval_id, action, reason, status, message_id, source_msg_id, created_at, risk, kind) values
      ('${AP_PENDING}', '${T}', '${CH.OADM}', '${OC1}', 'ap-1', 'rm -rf build', '빌드 폴더 정리', 'pending', 10004, 10016, now() - interval '9 days', 'high', 'action'),
      ('${AP_DONE}', '${T}', '${CH.OADM}', '${OC1}', 'ap-2', 'ls', null, 'approved', null, null, now() - interval '9 days', 'low', 'action');
    set session_replication_role = origin;
    update public.msgr2_backfill_jobs set batch_limit = 1000 where name = 'messages';
    update public.msgr2_backfill_jobs set batch_limit = 1 where name = 'reactions';`]);
  // pg_net 대역(U7 시험과 같은 모양): 푸시 호출을 표에 남긴다. 주소를 넣어 두어 트리거가 부를 수 있는 상태로 시험한다
  db.sql(`create table if not exists public._push_calls (id bigserial primary key, url text, body jsonb);
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
      language plpgsql as $$ begin insert into public._push_calls (url, body) values (url, body); return 1; end $$;
    insert into public.msgr_settings (key, value) values ('msgr2_push_url', 'https://edge.test/msgr2-push') on conflict (key) do update set value = excluded.value`);
  oldBefore = oldHash();
  sentBefore = one('select count(*) from realtime.sent');
  base = { maxOld: Number(one('select max(id) from public.msgr_messages')) };
});

test('1) 백필: 모든 단계가 끝나고 방송·일·사건이 생기지 않는다(대기 결재 1건만 일 행)', { skip }, () => {
  const r = migrate('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /묶음  messages/, '글은 여러 묶음으로 나뉘어야 한다(상한 1,000)');
  assert.ok(jobs().every((j) => j.split('|')[2] === 'true'), jobs().join('\n'));
  assert.equal(one('select count(*) from realtime.sent'), sentBefore, '백필 중 방송 0');
  assert.equal(one('select count(*) from public._push_calls'), '0', '백필 중 푸시 호출 0(U7 트리거)');
  assert.equal(one('select count(*) from public.msgr2_works'), '1', '사람 글 → offer 0(에이전트 1:1 방 글·멘션 글이 있어도), 대기 결재 1건만');
  assert.equal(one('select count(*) from public.msgr2_work_events'), '0');
  assert.equal(one('select count(*) from public.msgr2_topics'), '0');
  assert.equal(one("select count(*) from public.msgr2_room_counters"), '0');
  firstCounts = v2Counts();
  assert.equal(firstCounts.msgr2_messages, BULK + 16);
});

test('2) 검증: 누락 0 · 방별 해시 같음 · 무작위 글 같음 · identity = 최댓값', { skip }, () => {
  const r = migrate('verify');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const v = json('select public.msgr2_backfill_verify(500)');
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.rooms_mismatch, 0);
  assert.equal(v.sample_mismatch, 0);
  assert.equal(v.old_counts.msgr_messages, BULK + 16);
  assert.ok(Number(one("select count(*) from public.msgr2_backfill_jobs where verified_at is null")) === 0);
  assert.equal(Number(one(`select last_value from pg_sequences where sequencename = 'msgr2_messages_id_seq'`)), base.maxOld);
  assert.equal(one(`select nextval(pg_get_serial_sequence('public.msgr2_messages', 'id'))`), String(base.maxOld + 1), '다음 새 글 id = 옛 최댓값 + 1');
});

test('3) 옛 표는 한 줄도 바뀌지 않았다(내용 해시)', { skip }, () => {
  assert.deepEqual(oldHash(), oldBefore);
});

test('4) 대응: 방 종류·짝·공간·정책·보관', { skip }, () => {
  const PO = one(`select id from public.msgr2_spaces where owner_user_id = '${U.O}' and kind = 'personal'`);
  assert.ok(PO);
  assert.equal(one(`select kind || '|' || coalesce(deleted_at::text, '-') <> '' from public.msgr2_spaces where id = '${T2}'`), 't');
  assert.equal(one(`select deleted_at is not null from public.msgr2_spaces where id = '${T2}' and kind = 'team'`), 't', '지운 조직 = 지운 팀 공간');
  assert.equal(room(CH.PUB), `open|-|${T}|allowed|true|false`);
  assert.equal(room(CH.PUBX), `private|-|${T}|approval|true|false`, '제외 목록이 있던 public → private');
  assert.equal(room(CH.PRIV), `private|-|${T}|blocked|false|false`);
  assert.equal(room(CH.ODM), `direct|${pair(U.O, U.M)}|${T}|allowed|true|false`, '팀 1:1 = U6d와 같은 짝 키');
  assert.equal(room(CH.ODUP), `private|-|${T}|allowed|true|false`, '같은 짝의 두 번째 dm은 private');
  assert.equal(room(CH.OADM), `private|-|${T}|allowed|true|false`, '조직 에이전트 1:1 = private(U6d 에이전트 1:1 규칙)');
  assert.equal(room(CH.OGRP), `private|-|${T}|allowed|true|false`);
  assert.equal(room(CH.ARCH), `private|-|${T}|allowed|true|true`);
  assert.equal(room(CH.GRP), `private|-|${PO}|allowed|true|false`, '개인 그룹 = 만든 사람의 개인 공간');
  assert.equal(room(CH.FDM), `direct|p:${pair(U.O, U.F)}|${PO}|allowed|true|false`, '개인 1:1 = p: + 짝(U6d)');
  assert.equal(room(CH.CDM), `private|-|${PO}|blocked|true|false`, '개인 에이전트 1:1 = private, read_only → blocked');
  assert.equal(room(CH.DEL), `open|-|${T2}|allowed|true|false`);
  // 방 멤버: PUB = M(손님 G 빠짐) + AG1(제외 목록의 OC2 빠짐), PUBX = O·M(M은 제외 목록에 있지만 참여 행이 있어 옛 판정도 읽는다. G 손님·X 탈퇴·E 만료는 없음), CDM = O + AG1
  assert.equal(members(CH.PUB), `agent:${AG1},user:${U.M}`);
  assert.equal(members(CH.PUBX), [`user:${U.O}`, `user:${U.M}`, `user:${U.N}`].sort().join(','), 'N = 제외되지 않은 활동 멤버(옛 public 규칙으로 읽던 사람), W = 제외');
  assert.equal(members(CH.PRIV), [`user:${U.G}`, `user:${U.O}`, `user:${U.X}`].sort().join(','));
  assert.equal(members(CH.CDM), `agent:${AG1},user:${U.O}`);
  // 공간 멤버·파견·에이전트
  assert.equal(one(`select string_agg(user_id || ':' || role || ':' || (removed_at is not null) || ':' || (expires_at is not null), ',' order by user_id) from public.msgr2_space_members where space_id = '${T}'`),
    [`${U.O}:owner:false:false`, `${U.M}:member:false:false`, `${U.G}:guest:false:true`, `${U.X}:member:true:false`, `${U.E}:member:false:true`,
     `${U.N}:member:false:false`, `${U.W}:admin:false:false`].sort().join(','));
  assert.equal(one(`select string_agg(space_id || ':' || allow || ':' || allow_users::text, ',' order by space_id) from public.msgr2_agent_seats where agent_id = '${AG1}'`),
    [`${T}:list:{${U.M}}`, `${T2}:all:{}`].sort().join(','));
  assert.equal(one(`select display_name || '|' || role_text || '|' || hosting || '|' || status from public.msgr2_agents where id = '${AG1}'`), '에이전트 하나|조사|local|active', '대표 자리 = 개인 자리');
  assert.equal(one(`select hosting || '|' || status from public.msgr2_agents where id = '${AG2}'`), 'bot|paused');
  assert.equal(one(`select owner_user_id || '|' || display_name || '|' || role_text || '|' || hosting || '|' || status from public.msgr2_agents where id = '${AG3}'`), `${U.M}|c1||local|active`, '자리 없는 에이전트도 같은 id로(이름 = slug)');
});

test('5) 대응: 글 작성자·종류·답글·멘션·클라 id·첨부·읽음·반응·고정·결재', { skip }, () => {
  const m = (n, cols) => one(`select ${cols} from public.msgr2_messages where id = ${n}`);
  assert.equal(m(10001, "author_kind || ':' || author_agent_id"), `agent:${AG1}`);
  assert.equal(m(10002, "author_kind || ':' || (meta->>'legacy_author') || ':' || (meta->>'x')"), 'system:user:1', '작성자가 지워진 사람 글');
  assert.equal(m(10003, "author_kind || ':' || (meta->>'legacy_author')"), 'system:crew');
  assert.equal(m(10004, 'kind'), 'card');
  assert.equal(m(10005, "author_kind || ':' || kind || ':' || (meta->>'code')"), 'system:system:x');
  assert.equal(m(10006, "reply_to || ':' || (edited_at is not null) || ':' || array_to_string(mentions, ',')"), `1:true:${AG1},${U.O}`.replace(`${AG1},${U.O}`, [AG1, U.O].sort().join(',')));
  assert.equal(m(10007, "reply_to || ':' || (deleted_at is not null)"), '10006:true');
  assert.equal(one(`select coalesce(string_agg(id || ':' || coalesce(client_msg_id, '-'), ',' order by id), '') from public.msgr2_messages where id between 10008 and 10010`), '10008:-,10009:-,10010:c-2');
  assert.equal(m(10002, 'created_at = (select created_at from public.msgr_messages where id = 10002)'), 't', '옛 시각 보존');
  assert.equal(one(`select string_agg(storage_path || ':' || room_id || ':' || bytes, ',' order by storage_path) from public.msgr2_attachments`),
    [`msgr/${T}/${CH.PUB}/f1.png:${CH.PUB}:1234`, `msgr/p/${CH.FDM}/f2.txt:${CH.FDM}:10`].sort().join(','));
  assert.equal(one(`select last_read_id from public.msgr2_reads where room_id = '${CH.PUB}' and user_id = '${U.M}'`), '10007');
  assert.equal(one(`select string_agg(message_id || ':' || emoji, ',' order by message_id, emoji) from public.msgr2_reactions`), ['10006:a,b', '10006:👍', '10012:❤️'].sort().join(','));
  assert.equal(one(`select string_agg(room_id || ':' || user_id || ':' || muted || ':' || pinned, ',' order by room_id, user_id) from public.msgr2_prefs`),
    [`${CH.PUB}:${U.M}:true:false`, `${CH.ODM}:${U.O}:false:true`, `${CH.OADM}:${U.O}:false:true`, `${CH.ODUP}:${U.O}:false:true`].sort().join(','),
    '조직 고정 → 옛 1:1 채널 방 pinned(같은 짝 두 방 모두, 에이전트 1:1 포함)');
  assert.equal(one(`select state || ':' || card_message_id || ':' || risk from public.msgr2_approvals where id = '${AP_PENDING}'`), 'expired:10004:high');
  assert.equal(one(`select state || ':' || agent_id || ':' || source_message_id || ':' || from_id from public.msgr2_works where id = '${AP_PENDING}'`), `cancelled:${AG1}:10016:${U.O}`);
  assert.equal(one(`select count(*) from public.msgr2_approvals where id = '${AP_DONE}'`), '0', '결정된 결재는 옮기지 않는다');
  assert.equal(one(`select count(*) from public.msgr2_works w where public._msgr2_effective_state(w.state, w.expires_at, w.lease_until, w.has_result) in ('offered', 'accepted', 'running', 'awaiting_approval', 'stalled')`), '0', '다시 실행될 일 없음');
});

test('5b) U6d 결합: 옮긴 1:1 방을 1:1 목록이 열고, dm_open(친구·팀원)·agent_dm_open이 그 방을 찾는다(새 방 0)', { skip }, () => {
  const { sid } = seedDevice(db, U.O, 'app');
  const n0 = one('select count(*) from public.msgr2_rooms');
  const rows = db.as(U.O, sid, `select coalesce(string_agg(room_id || '|' || kind || '|' || coalesce(other_user_id::text, '-') || '|' || coalesce(agent_id::text, '-'), ',' order by room_id), '')
                                  from public.msgr2_dm_list(true) where room_id in ('${CH.FDM}', '${CH.CDM}')`);
  assert.equal(rows, [`${CH.FDM}|direct|${U.F}|-`, `${CH.CDM}|private|-|${AG1}`].sort().join(','), '목록이 열리고(짝 키 파싱 성공) 친구 1:1·에이전트 1:1이 보인다');
  const fdm = JSON.parse(db.as(U.O, sid, `select public.msgr2_dm_open('${U.F}')`));
  assert.equal(fdm.room_id, CH.FDM); assert.equal(fdm.existing, true);
  assert.equal(JSON.parse(db.as(U.O, sid, `select public.msgr2_agent_dm_open('${AG1}')`)).room_id, CH.CDM);
  assert.equal(JSON.parse(db.as(U.O, sid, `select public.msgr2_dm_open('${U.M}', '${T}')`)).room_id, CH.ODM);
  assert.equal(one('select count(*) from public.msgr2_rooms'), n0, '새 방을 만들지 않았다(옛 기록과 갈라지지 않는다)');
});

test('6) 경우 25: 옛 판정(msgr_can_read_channel)과 새 판정(_msgr2_access_for.read)이 사람 × 방마다 같다', { skip }, () => {
  const rows = [];
  for (const [un, u] of Object.entries(U)) for (const [cn, c] of Object.entries(CH)) {
    const old = db.sql(`select set_config('argo.uid', '${u}', false); select public.msgr_can_read_channel('${c}')`).split('\n').pop();
    const nw = db.sql(`select coalesce((public._msgr2_access_for('${c}', '${u}')).read, false)`);
    rows.push(`${un}@${cn}:${old}/${nw}`);
  }
  const diff = rows.filter((r) => { const [a, b] = r.split(':')[1].split('/'); return a !== b; });
  assert.deepEqual(diff, [], rows.join(' '));
  assert.ok(rows.filter((r) => r.endsWith(':t/t')).length >= 15, '볼 수 있는 칸도 있어야 한다(전부 거짓이면 대조가 무의미)');
});

test('7) 다시 백필(restart → run): 새 표 쓰기 0(xmin 불변)', { skip }, () => {
  const x = v2Xmins();
  assert.equal(migrate('restart').status, 0);
  const r = migrate('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(v2Xmins(), x);
  assert.deepEqual(jobs().map((j) => j.split('|')[3]), jobs().map(() => '0'), '모든 단계 쓴 행 0');
  assert.equal(one('select count(*) from realtime.sent'), sentBefore);
});

test('8) claim·세대·문맥 거부: busy · stale_generation · 앞 단계 · 사람 토큰 · 스위치 뒤', { skip }, async () => {
  // 다른 연결이 작업 행을 잡고 있으면 busy(기다리지 않는다)
  const hold = spawn('psql', [DB, '-X', '-q', '-c', "begin; select 1 from public.msgr2_backfill_jobs where name = 'messages' for update; select pg_sleep(4); commit;"]);
  for (let i = 0; i < 40 && one("select count(*) from pg_locks l join pg_class c on c.oid = l.relation where c.relname = 'msgr2_backfill_jobs' and l.mode = 'RowShareLock'") === '0'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(json("select public.msgr2_backfill_run('messages')").code, 'busy');
  await new Promise((r) => hold.on('exit', r));
  const g = Number(one('select max(generation) from public.msgr2_backfill_jobs'));
  assert.equal(json(`select public.msgr2_backfill_run('messages', ${g - 1})`).code, 'stale_generation');
  assert.equal(json(`select public.msgr2_backfill_run('messages', ${g})`).done, true);
  // 앞 단계가 안 끝났으면 다음 단계는 돌지 않는다
  db.sql("update public.msgr2_backfill_jobs set done_at = null where name = 'rooms'");
  assert.equal(json("select public.msgr2_backfill_run('attachments')").code, 'previous_step_pending');
  assert.equal(json("select public.msgr2_backfill_run('rooms')").done, true);
  assert.equal(json("select public.msgr2_backfill_run('attachments')").done, true);
  // 사람 토큰(authenticated)으로는 실행 권한이 없다
  assert.match(db.asErr(U.O, null, "select public.msgr2_backfill_run('messages')") ?? '', /permission denied/);
  assert.match(db.asErr(U.O, null, 'select public.msgr2_backfill_verify(1)') ?? '', /permission denied/);
  // 스위치 뒤에는 거부
  db.sql("insert into public.msgr_settings (key, value) values ('msgr2_switched_at', now()::text)");
  const r = db.raw(['-A', '-t', '-c', "select public.msgr2_backfill_run('messages')"]);
  assert.match(r.stderr, /msgr2_backfill_after_switch/);
  const rb = db.raw(['-c', ROLLBACK]);
  assert.match(rb.stderr, /msgr2_rollback_after_switch/);
  db.sql("delete from public.msgr_settings where key = 'msgr2_switched_at'");
  // v2 운영 표지(msgr2_enabled, U6d)만 있어도 거부
  db.sql("insert into public.msgr_settings (key, value) values ('msgr2_enabled', now()::text)");
  assert.match(db.raw(['-A', '-t', '-c', "select public.msgr2_backfill_run('messages')"]).stderr, /msgr2_backfill_after_switch/);
  assert.match(db.raw(['-c', ROLLBACK]).stderr, /msgr2_rollback_after_switch/);
  db.sql("delete from public.msgr_settings where key = 'msgr2_enabled'");
  assert.deepEqual(v2Counts(), firstCounts, '거부된 실행은 아무것도 바꾸지 않았다');
  // 같은 id의 글이 다른 방에 이미 있으면(v2에서 먼저 쓴 글) 글 단계가 멈추고 덮지 않는다
  db.sql(`update public.msgr2_messages set room_id = '${CH.PRIV}' where id = 10012`);
  assert.equal(migrate('restart').status, 0);
  const rc = migrate('run');
  assert.equal(rc.status, 3, rc.stdout + rc.stderr);
  assert.match(rc.stdout + rc.stderr, /msgr2_backfill_message_id_conflict/);
  assert.equal(one('select room_id || \'|\' || body from public.msgr2_messages where id = 10012'), `${CH.PRIV}|친구 글`, '덮지 않았다');
  db.sql(`update public.msgr2_messages set room_id = '${CH.FDM}' where id = 10012`);
  assert.equal(migrate('run').status, 0);
});

test('9) 되돌림 → 중간 종료 뒤 재개(경우 13): 체크포인트부터, 최종 행 수·검증 같음', { skip }, () => {
  const r0 = migrate('rollback');
  assert.equal(r0.status, 0, r0.stdout + r0.stderr);
  assert.deepEqual(Object.values(v2Counts()), V2.map(() => 0), '백필 사본이 모두 비었다');
  assert.deepEqual(oldHash(), oldBefore, '되돌림도 옛 표를 건드리지 않는다');
  assert.ok(jobs().every((j) => j.split('|')[1] === '-' && j.split('|')[2] === 'false'));
  // 글 앞까지 + 글 두 묶음
  for (const j of ['agents', 'spaces', 'space_members', 'seats', 'rooms', 'room_members', 'message_keys']) assert.equal(json(`select public.msgr2_backfill_run('${j}')`).done, true, j);
  json("select public.msgr2_backfill_run('messages')"); json("select public.msgr2_backfill_run('messages')");
  assert.equal(one("select checkpoint from public.msgr2_backfill_jobs where name = 'messages'"), '2000');
  // 세 번째 묶음 도중 종료(트랜잭션이 커밋되지 않음) — 그 묶음의 글도 체크포인트도 남지 않는다
  const crash = db.raw(['-c', `do $$ declare r jsonb; begin r := public.msgr2_backfill_run('messages');
    if r->>'checkpoint' is distinct from '3000' then raise exception 'unexpected %', r; end if; raise exception 'simulated_crash'; end $$`]);
  assert.match(crash.stderr, /simulated_crash/, crash.stderr);
  assert.equal(one("select checkpoint from public.msgr2_backfill_jobs where name = 'messages'"), '2000');
  assert.equal(one('select count(*) from public.msgr2_messages'), '2000');
  // 실행기를 다시 돌리면 체크포인트부터 끝까지
  const r = migrate('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /묶음  messages .*"checkpoint": "1000"/, '처음부터 다시 돌지 않는다');
  assert.deepEqual(v2Counts(), firstCounts);
  assert.equal(json('select public.msgr2_backfill_verify(200)').ok, true);
  assert.equal(one('select count(*) from realtime.sent'), sentBefore);
  assert.equal(one('select count(*) from public._push_calls'), '0');
});

test('10) v2에서 새로 생긴 글이 있으면 되돌림은 아무것도 지우지 않는다', { skip }, () => {
  // v2에서 새로 쓴 글 하나(서비스 문맥, 새 id) — 이후 이 DB의 msgr2_messages는 기억 데이터다
  db.sql(`select set_config('argo.uid', '', false); insert into public.msgr2_messages (room_id, author_kind, author_user_id, kind, body) values ('${CH.PUB}', 'user', '${U.M}', 'text', 'v2 새 글')`);
  const before2 = v2Counts();
  const r = db.raw(['-c', ROLLBACK]);
  assert.match(r.stderr, /msgr2_rollback_native_rows: msgr2_messages 1 rows/);
  assert.deepEqual(v2Counts(), before2);
});

test('10b) 백필 밖(사람 문맥)에서는 감싼 offer 트리거가 그대로 일을 만든다', { skip }, () => {
  const { sid } = seedDevice(db, U.O, 'app');
  const before = Number(one(`select count(*) from public.msgr2_works where room_id = '${CH.OADM}'`));
  db.as(U.O, sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, kind, body) values ('${CH.OADM}', 'user', '${U.O}', 'text', '옮긴 뒤 새 지시')`);
  assert.equal(Number(one(`select count(*) from public.msgr2_works where room_id = '${CH.OADM}'`)), before + 1, '조직 에이전트 1:1 방 사람 글 → offer 1');
  assert.equal(one(`select agent_id || ':' || state from public.msgr2_works where room_id = '${CH.OADM}' order by created_at desc limit 1`), `${AG1}:offered`);
  assert.ok(Number(one('select count(*) from public._push_calls')) >= 1, '백필 밖 글은 푸시 트리거가 부른다(대역이 살아 있다)');
});

test('10c) 큰 채널: 10만 글 채널(client_msg_id 있음, 중복 일부)에서 글 묶음 하나가 짧다 — 측정을 남긴다', { skip }, () => {
  const BIG = id(420), N = 100000, B0 = 1000000;
  db.psql(['-c', `set session_replication_role = replica;
    insert into public.msgr_channels (id, org_id, kind, name, crew_memory, created_by, created_at, personal_crews) values ('${BIG}', '${T}', 'public', 'big', true, '${U.O}', now() - interval '20 days', 'allowed');
    insert into public.msgr_messages (id, org_id, channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id, created_at, meta) overriding system value
      -- 1,000번째 글마다 값 'c-d<k/2>'를 쓰고 작성자를 번갈아(옛 유일 조건은 작성자별) — k = 2..99는 둘씩 겹친다(98글), k = 1·100은 혼자
      select ${B0} + g, '${T}', '${BIG}', 'user', case when (g / 1000) % 2 = 0 then '${U.M}'::uuid else '${U.O}'::uuid end, 'text', '큰 방 ' || g, '[]',
             case when g % 1000 = 0 then 'c-d' || ((g / 1000) / 2) else 'c-' || g end, now() - interval '19 days', '{}'
        from generate_series(1, ${N}) g;
    set session_replication_role = origin;
    analyze public.msgr_messages;
    update public.msgr2_backfill_jobs set batch_limit = 5000 where name = 'messages';`]);
  assert.equal(migrate('restart').status, 0);
  const t0 = Date.now();
  for (const j of ['agents', 'spaces', 'space_members', 'seats', 'rooms', 'room_members']) json(`select public.msgr2_backfill_run('${j}')`);
  const k0 = Date.now(); json("select public.msgr2_backfill_run('message_keys')"); const keysMs = Date.now() - k0;
  const ms = [];
  for (let i = 0; i < 100; i++) { const a = Date.now(); const r = json("select public.msgr2_backfill_run('messages')"); ms.push(Date.now() - a); if (r.done) break; }
  const max = Math.max(...ms);
  console.log(`# 큰 채널 측정: 옛 글 ${N}개(그 채널), 글 키 단계 ${keysMs}ms, 글 묶음 ${ms.length}개(5,000행씩) 최대 ${max}ms · 평균 ${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)}ms, 앞 단계 포함 ${Date.now() - t0}ms`);
  assert.ok(max < 20000, `글 묶음 하나 ${max}ms — 운영 statement_timeout 120s보다 훨씬 짧아야 한다`);
  assert.equal(one(`select count(*) from public.msgr2_messages where room_id = '${BIG}'`), String(N));
  assert.equal(one(`select count(*) from public.msgr2_messages where room_id = '${BIG}' and client_msg_id is null`), '98', '같은 채널에 같은 값이 둘인 글만 비운다');
  const rest = migrate('run'); // 남은 단계(반응은 상한 1이라 여러 번)
  assert.equal(rest.status, 0, rest.stdout + rest.stderr);
  const v = json('select public.msgr2_backfill_verify(200)');
  assert.equal(v.ok, true, JSON.stringify(v));
});

test('10d) 개인 방 첨부(p/<방>/…): 백필 뒤 v2 방 멤버는 열고(서명 = 읽기 판정), 방 밖·다른 사람은 못 열고, p/ 경로 쓰기는 거부', { skip }, () => {
  // 옛 파일은 옮기지 않는다 — 객체는 옛 이름 그대로(버킷 msgr, 이름 = 옛 storage_path)
  db.sql(`insert into storage.objects (bucket_id, name) values ('msgr', 'p/${CH.FDM}/f2.txt'), ('msgr', '${T}/${CH.PUB}/f1.png'), ('msgr', 'p/${id(499)}/ghost.txt')`);
  const dev = Object.fromEntries(['F', 'M', 'Z', 'G', 'O'].map((k) => [k, seedDevice(db, U[k], 'app').sid]));
  const can = (k, name) => db.as(U[k], dev[k], `select count(*) from storage.objects where bucket_id = 'msgr' and name = '${name}'`);
  assert.equal(one(`select storage_path from public.msgr2_attachments where room_id = '${CH.FDM}'`), `msgr/p/${CH.FDM}/f2.txt`, '서비스 문맥 백필은 경로 검사를 건너뛰어 옛 경로로 들어갔다');
  assert.equal(can('F', `p/${CH.FDM}/f2.txt`), '1', '방 멤버(친구) = 열림');
  assert.equal(can('O', `p/${CH.FDM}/f2.txt`), '1', '방 멤버(만든 사람) = 열림');
  assert.equal(can('M', `p/${CH.FDM}/f2.txt`), '0', '방 밖 = 못 엶');
  assert.equal(can('Z', `p/${CH.FDM}/f2.txt`), '0', '모르는 사람 = 못 엶');
  assert.equal(can('F', `p/${id(499)}/ghost.txt`), '0', 'v2에 없는 방의 p/ 경로는 v2가 열지 않는다');
  assert.equal(db.as(U.F, dev.F, `select public._msgr2_storage_read('p/${CH.FDM}/f2.txt')`), 't', 'v2 판정이 연다(옛 정책이 아니라)');
  // v2 판정만 따른다: v2에서 F를 방에서 빼면 옛 채널 멤버십이 남아 있어도 못 연다
  db.sql(`update public.msgr2_room_members set removed_at = now() where room_id = '${CH.FDM}' and member_kind = 'user' and member_id = '${U.F}'`);
  assert.equal(can('F', `p/${CH.FDM}/f2.txt`), '0', 'v2에서 빠진 사람 = 못 엶(옛 멤버십 무시)');
  db.sql(`update public.msgr2_room_members set removed_at = null where room_id = '${CH.FDM}' and member_kind = 'user' and member_id = '${U.F}'`);
  assert.equal(can('M', `${T}/${CH.PUB}/f1.png`), '1', '조직 첨부(<공간>/<방>/…) = 방을 읽는 사람');
  assert.equal(can('G', `${T}/${CH.PUB}/f1.png`), '0', '손님(옛 public 방에서 막힌 사람) = 못 엶');
  assert.match(db.asErr(U.O, dev.O, `insert into storage.objects (bucket_id, name) values ('msgr', 'p/${CH.FDM}/10012/new.txt')`) ?? '', /row-level security/, 'p/ 경로 쓰기 거부');
  assert.match(db.asErr(U.F, dev.F, `update storage.objects set metadata = '{}' where name = 'p/${CH.FDM}/f2.txt'`) ?? 'no-error', /no-error|row-level security/);
  assert.equal(db.sql(`select count(*) from storage.objects where name = 'p/${CH.FDM}/f2.txt' and metadata is not null`), '0', '덮어쓰기 없음');
  // 경로 검사(U1 :345): 사람 문맥에서도 msgr/p/<개인 방>/…은 허용, 팀 방 id로 p/를 쓰면 거부
  const probe = (room, msg, path) => db.raw(['-c', `do $$ begin perform set_config('argo.uid', '${U.O}', true);
    insert into public.msgr2_attachments (message_id, room_id, storage_path, name) values (${msg}, '${room}', '${path}', 'x'); raise exception 'probe_ok'; end $$`]).stderr;
  assert.match(probe(CH.FDM, 10012, `msgr/p/${CH.FDM}/10012/x`), /probe_ok/);
  assert.match(probe(CH.PUB, 10006, `msgr/p/${CH.PUB}/10006/x`), /msgr2_attachment_path/);
  assert.match(probe(CH.FDM, 10012, `msgr/p/${CH.FDM}/../x`), /msgr2_attachment_path/);
});

test('10e) 오피스 전용 조직(메신저 채널·자리 없음)은 팀 공간·멤버로 옮기지 않는다, 검증은 그대로 ok(2026-10-20 오피스 외래키 이동)', { skip }, () => {
  const OFF = id(190), OU = id(191);
  db.psql(['-c', `insert into auth.users (id) values ('${OU}') on conflict do nothing;
    insert into public.msgr_orgs (id, name, slug, owner_user_id) values ('${OFF}', 'Office only', 'office-only-b8', '${OU}');`]); // 주인 멤버 행은 트리거가 넣는다
  assert.equal(migrate('restart').status, 0);
  const r = migrate('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(one(`select count(*) from public.msgr2_spaces where id = '${OFF}'`), '0', '팀 공간 없음');
  assert.equal(one(`select count(*) from public.msgr2_space_members where user_id = '${OU}'`), '0', '멤버·개인 공간 없음');
  assert.equal(one(`select count(*) from public.msgr2_spaces where owner_user_id = '${OU}'`), '0');
  assert.equal(json('select public.msgr2_backfill_verify(50)').ok, true, '검증 기준도 같다');
  assert.equal(one(`select count(*) from public.msgr2_spaces where id = '${T2}' and kind = 'team'`), '1', '채널이 있는 지운 조직은 그대로 옮긴다');
});

test('11) 이 마이그레이션 되돌림: 백필이 돈 기록이 있으면 멈추고, 없으면 함수·작업 행을 걷어 내고 offer 트리거를 U2 본문으로', { skip }, () => {
  // 개인 방 첨부 판정(051000) 되돌림 → 세 함수가 U2b·U1 본문으로
  const downPf = readFileSync(fileURLToPath(new URL('../scripts/rollback/20261020200800_msgr2_personal_files.down.sql', import.meta.url)), 'utf8');
  const rp = db.raw(['-c', downPf]);
  assert.equal(rp.status, 0, rp.stderr);
  const body = (f, name) => { const t = readFileSync(fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url)), 'utf8'); const i = t.indexOf(`create or replace function public.${name}(`);
    const a2 = t.indexOf('$$', i) + 2; return t.slice(a2, t.indexOf('$$;', a2)); };
  for (const [f, n] of [['20261020200300_msgr2_realtime_storage.sql', '_msgr2_storage_room'], ['20261020200300_msgr2_realtime_storage.sql', '_msgr2_storage_write'], ['20261020200000_msgr2_space.sql', 'msgr2_insert_stamp']])
    assert.equal(one(`select md5(prosrc) from pg_proc where proname = '${n}'`), one(`select md5($b$${body(f, n)}$b$)`), n);
  const down = readFileSync(fileURLToPath(new URL('../scripts/rollback/20261020200700_msgr2_backfill.down.sql', import.meta.url)), 'utf8');
  const u2 = readFileSync(fileURLToPath(new URL('../supabase/migrations/20261020200200_msgr2_work.sql', import.meta.url)), 'utf8');
  const fn = (s) => s.slice(s.indexOf('create or replace function public.msgr2_on_user_message()'), s.indexOf('end $$;', s.indexOf('create or replace function public.msgr2_on_user_message()')));
  assert.equal(fn(down), fn(u2), '되돌림 파일의 트리거 본문 = U2 본문');
  assert.match(db.raw(['-c', down]).stderr, /msgr2_rollback_not_empty: msgr2_backfill_jobs/);
  assert.equal(one("select count(*) from pg_proc where proname = 'msgr2_backfill_run'"), '1', '멈추면 아무것도 바꾸지 않는다');
  db.sql('update public.msgr2_backfill_jobs set runs = 0, done_at = null'); // 시험용: 돈 기록이 없는 상태로
  const r = db.raw(['-c', down]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(one("select count(*) from pg_proc where proname like '%msgr2_bf%' or proname like 'msgr2_backfill%'"), '0');
  assert.equal(one("select to_regclass('public.msgr2_backfill_jobs') is null"), 't');
  assert.equal(one("select position('msgr2.backfill' in prosrc) from pg_proc where proname = 'msgr2_on_user_message'"), '0');
});
