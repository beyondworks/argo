// 에이전트도 초대된 것만 채널에 있다 — 멤버가 자기 에이전트를 데려올 때는 방장이 허락한다(유건 2026-09-16).
// 종전에는 공개 채널에 파견된 에이전트 전원이 자동으로 들어가 있었다(라이브 153개 × 공개 5개).
// 실행: bash scripts/billing-pg-drill.sh test/msgr-crew-join-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crew-join-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { host: '11111111-1111-4111-8111-111111111111', mate: '22222222-2222-4222-8222-222222222222', other: '33333333-3333-4333-8333-333333333333', svc: '44444444-4444-4444-8444-444444444444' };
function psqlRaw(args) { return spawnSync('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', ...args], { encoding: 'utf8' }); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제: ${raw.stderr.trim().slice(0, 160)}`); };
const inCh = (ch, crew) => sql(`select public.msgr_crew_in_channel('${ch}', '${crew}')`);
const crewRow = (ch, crew) => sql(`select count(*) from public.msgr_channel_members where channel_id = '${ch}' and member_kind = 'crew' and member_id = '${crew}'`);
const JOIN = '20260917090000_msgr_crew_join_approval.sql';

let ORG, PUB, OLD_PUB, PRIV, SPOKE, SILENT, MINE, MATE_CREW, COMPANY, SCHEDULED, BLOCKED_PUB;
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
  // 이관(백필)을 실제로 태우려면 그 마이그레이션 **전에** 옛 상태(공개 채널에서 말한 에이전트·말 안 한 에이전트)를 만든다.
  for (const f of files.filter((x) => x !== JOIN)) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.host, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.host}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  for (const u of [U.mate, U.other]) {
    const code = last(asUser(U.host, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.host}') returning code`));
    assert.equal(last(asUser(u, `select public.msgr_accept_invite('${code}')`)), ORG);
  }
  const crew = (owner, slug, hosting = null) => last(sql(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, status${hosting ? ', hosting' : ''}) values ('${ORG}', '${owner}', 'lean', '${slug}', '${slug}', 'active'${hosting ? `, '${hosting}'` : ''}) returning id`));
  // 회사 에이전트 = 조직 서비스 계정이 소유한 상주 에이전트(msgr_crew_tier). 봇 행은 전용 RPC로만 만들 수 있어 이 방식으로 둔다.
  sql(`insert into public.msgr_org_members (org_id, user_id, role) values ('${ORG}', '${U.svc}', 'member')`);
  sql(`update public.msgr_orgs set service_user_id = '${U.svc}' where id = '${ORG}'`);
  SCHEDULED = crew(U.host, 'scheduled'); SPOKE = crew(U.host, 'spoke'); SILENT = crew(U.host, 'silent'); MINE = crew(U.mate, 'mine'); MATE_CREW = crew(U.other, 'others'); COMPANY = crew(U.svc, 'company', 'resident');
  assert.equal(sql(`select public.msgr_crew_tier('${COMPANY}')`), 'company');
  OLD_PUB = last(asUser(U.host, `select public.msgr_create_channel('${ORG}','public','Crew')`));
  sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, client_msg_id) values ('${OLD_PUB}', 'crew', '${SPOKE}', 'text', '옛 채널에서 한 말', 'old-spoke')`);
  sql(`insert into public.msgr_automations (org_id, channel_id, crew_id, created_by, title, prompt, schedule, next_run_at) values ('${ORG}', '${OLD_PUB}', '${SCHEDULED}', '${U.host}', '아침 요약', '요약해 줘', '{"kind":"daily","time":"09:00"}', now() + interval '1 day')`); // 아직 한 번도 안 돈 자동화
  // 라이브 실사고(2026-09-17 적용 실패): '못 데려옴' 공개 채널에서 말한 개인 에이전트가 있으면 이관이 게이트 트리거에 막혀 파일 전체가 롤백됐다.
  BLOCKED_PUB = last(asUser(U.host, `select public.msgr_create_channel('${ORG}','public','Blocked')`));
  sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, client_msg_id) values ('${BLOCKED_PUB}', 'crew', '${SPOKE}', 'text', '막히기 전에 한 말', 'blocked-spoke'), ('${BLOCKED_PUB}', 'crew', '${COMPANY}', 'text', '회사 에이전트의 말', 'blocked-company')`);
  sql(`update public.msgr_channels set personal_crews = 'blocked' where id = '${BLOCKED_PUB}'`);
  psql(['-c', readFileSync(mig(JOIN), 'utf8')]); // ← 이관이 여기서 돈다
  PUB = last(asUser(U.host, `select public.msgr_create_channel('${ORG}','public','New')`));
  PRIV = last(asUser(U.host, `select public.msgr_create_channel('${ORG}','private','Secret')`));
  for (const ch of [PUB, PRIV]) sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ch}', 'user', '${U.mate}') on conflict do nothing`);
  asUser(U.mate, `select public.msgr_join_channel('${OLD_PUB}')`);
});

test("이관 — '못 데려옴' 채널: 개인 에이전트는 옮기지 않고(지금도 지시 불가 — 옮기면 일하게 된다) 회사 에이전트는 남는다", { skip }, () => {
  assert.equal(inCh(BLOCKED_PUB, SPOKE), 'f', '막힌 채널의 개인 에이전트');
  assert.equal(inCh(BLOCKED_PUB, COMPANY), 't', '막힌 채널의 회사 에이전트');
  assert.equal(inCh(OLD_PUB, SPOKE), 't', '다른 채널 이관은 그대로');
});

test('이관 — 공개 채널에서 말하던 에이전트는 남고, 파견만 된 에이전트는 빠진다', { skip }, () => {
  assert.equal(inCh(OLD_PUB, SPOKE), 't', '말하던 에이전트');
  assert.equal(inCh(OLD_PUB, SILENT), 'f', '말한 적 없는 에이전트는 더 이상 저절로 들어와 있지 않다');
  assert.equal(inCh(PUB, SPOKE), 'f', '새 공개 채널에도 저절로 들어오지 않는다');
  assert.equal(inCh(OLD_PUB, SCHEDULED), 't', '그 채널에 자동화가 걸린 에이전트는 남는다(아직 안 돌았어도 — 검수 M-1)');
});

test('채널에 없는 에이전트는 받지도 쓰지도 못한다 — 서버가 막는다', { skip }, () => {
  const src = last(asUser(U.host, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${PUB}', 'user', '${U.host}', 'text', '@silent 해 줘', '[{"kind":"crew","id":"${SILENT}"}]', 'm-silent') returning id`));
  assert.equal(sql(`select public.msgr_delivery_allowed('${SILENT}', ${src})`), 'f', '배달 대상이 아니다');
  const w = psqlRaw(['-A', '-t', '-c', `insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, client_msg_id) values ('${PUB}', 'crew', '${SILENT}', 'text', '끼어들기', 'w-silent')`]);
  assert.notEqual(w.status, 0, '글을 쓰지 못한다'); assert.match(w.stderr, /msgr_crew_not_in_channel/);
});

test('방장은 바로 넣는다 — 들어오면 받는다', { skip }, () => {
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join('${PUB}', '${SILENT}')`)), 'joined');
  assert.equal(inCh(PUB, SILENT), 't');
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join('${PUB}', '${SILENT}')`)), 'already', '두 번 눌러도 한 번');
});

test('멤버가 자기 에이전트를 넣으면 방장에게 요청이 간다 — 허락하면 들어온다', { skip }, () => {
  assert.equal(sql(`select personal_crews from public.msgr_channels where id = '${PUB}'`), 'approval', '새 채널의 기본은 방장 승인');
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_join('${PUB}', '${MINE}')`)), 'requested');
  assert.equal(crewRow(PUB, MINE), '0', '허락 전에는 들어오지 않는다');
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_join('${PUB}', '${MINE}')`)), 'requested', '다시 눌러도 요청은 하나');
  const req = last(asUser(U.host, `select id from public.msgr_channel_crew_requests where channel_id = '${PUB}' and crew_id = '${MINE}' and status = 'pending'`));
  assert.match(req, /^[0-9a-f-]{36}$/, '방장은 요청을 본다');
  fails(asUserRaw(U.mate, `select public.msgr_crew_join_decide('${req}', true)`), /msgr_forbidden/, '요청한 사람이 스스로 허락');
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join_decide('${req}', true)`)), 'approved');
  assert.equal(inCh(PUB, MINE), 't', '허락하면 들어온다');
  fails(asUserRaw(U.host, `select public.msgr_crew_join_decide('${req}', true)`), /msgr_request_closed/, '이미 끝난 요청');
});

test('거절하면 들어오지 않는다', { skip }, () => {
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_join('${PRIV}', '${MINE}')`)), 'requested', '비공개 채널도 같은 규칙');
  const req = last(asUser(U.host, `select id from public.msgr_channel_crew_requests where channel_id = '${PRIV}' and crew_id = '${MINE}' and status = 'pending'`));
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join_decide('${req}', false)`)), 'rejected');
  assert.equal(crewRow(PRIV, MINE), '0');
  fails(asUserRaw(U.mate, `select public.msgr_crew_join('${PRIV}', '${MINE}')`), /msgr_request_recently_rejected/, '거절 직후 같은 요청을 다시 보내기(검수 M-4)');
  sql(`update public.msgr_channel_crew_requests set decided_at = now() - interval '2 hours' where id = '${req}'`);
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_join('${PRIV}', '${MINE}')`)), 'requested', '한 시간이 지나면 다시 요청할 수 있다');
});

test('남의 개인 에이전트는 못 데려오고, 회사 에이전트는 방장에게 요청한다', { skip }, () => {
  fails(asUserRaw(U.mate, `select public.msgr_crew_join('${PUB}', '${MATE_CREW}')`), /msgr_forbidden/, '남의 개인 에이전트');
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_join('${PUB}', '${COMPANY}')`)), 'requested', '회사 에이전트는 방장 몫');
  fails(asUserRaw(U.other, `select public.msgr_crew_join('${PUB}', '${MATE_CREW}')`), /msgr_forbidden/, '채널에 참여하지 않은 사람');
});

test('요청은 요청한 사람과 방장만 본다', { skip }, () => {
  assert.equal(asUser(U.other, `select count(*) from public.msgr_channel_crew_requests`), '0', '제3자');
  assert.ok(Number(asUser(U.mate, `select count(*) from public.msgr_channel_crew_requests`)) > 0, '요청한 사람');
  fails(asUserRaw(U.mate, `insert into public.msgr_channel_crew_requests (channel_id, crew_id, requested_by) values ('${PUB}', '${MINE}', '${U.mate}')`), /permission denied|row-level security/, '표에 직접 쓰기');
});

test('정책 — 바로 추가면 바로, 못 데려옴이면 거절(회사 에이전트는 예외)', { skip }, () => {
  const open = last(asUser(U.host, `select public.msgr_create_channel('${ORG}','public','Open')`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${open}', 'user', '${U.mate}')`);
  sql(`update public.msgr_channels set personal_crews = 'allowed' where id = '${open}'`);
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_join('${open}', '${MINE}')`)), 'joined');
  const shut = last(asUser(U.host, `select public.msgr_create_channel('${ORG}','public','Shut')`));
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${shut}', 'user', '${U.mate}')`);
  sql(`update public.msgr_channels set personal_crews = 'blocked' where id = '${shut}'`);
  fails(asUserRaw(U.mate, `select public.msgr_crew_join('${shut}', '${MINE}')`), /msgr_channel_personal_blocked/, '못 데려옴');
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join('${shut}', '${COMPANY}')`)), 'joined', '회사 에이전트는 막히지 않는다');
  sql(`update public.msgr_channels set personal_crews = 'read_only' where id = '${open}'`);
  assert.equal(sql(`select public.msgr_instruct_check('${MINE}', '${U.mate}', '${open}')`), 'channel_policy', '보기만(종전 값)은 여전히 개인 에이전트 지시를 막는다');
  assert.equal(sql(`select public.msgr_instruct_check('${MINE}', '${U.mate}', '${shut}')`), 'ok', '못 데려옴은 지시를 막지 않는다(새로 들어오는 것만 막는다)');
  const bad = psqlRaw(['-A', '-t', '-c', `update public.msgr_channels set personal_crews = 'nope' where id = '${shut}'`]);
  assert.notEqual(bad.status, 0, '정해진 값만 받는다');
});

test('못 데려옴은 설정한 때부터 새로 못 들어오게만 한다 — 이미 있는 에이전트는 퇴장하지 않고 일한다(유건 2026-09-16)', { skip }, () => {
  const ch = last(asUser(U.host, `select public.msgr_create_channel('${ORG}','public','Toggle')`));
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join('${ch}', '${SPOKE}')`)), 'joined');
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join('${ch}', '${COMPANY}')`)), 'joined');
  sql(`update public.msgr_channels set personal_crews = 'blocked' where id = '${ch}'`);
  assert.equal(crewRow(ch, SPOKE), '1', '행이 지워지지 않는다(종전에는 전환하는 순간 지웠다)');
  assert.equal(inCh(ch, SPOKE), 't', '이미 있는 개인 에이전트는 그대로 구성원');
  assert.equal(sql(`select public.msgr_instruct_check('${SPOKE}', '${U.host}', '${ch}')`), 'ok', '그대로 일한다');
  sql(`insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, body, client_msg_id) values ('${ch}', 'crew', '${SPOKE}', 'text', '계속 일함', 'blocked-write')`);
  fails(asUserRaw(U.host, `select public.msgr_crew_join('${ch}', '${SILENT}')`), /msgr_channel_personal_blocked/, '새 개인 에이전트는 방장도 못 넣는다');
  fails(asUserRaw(U.host, `insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ch}', 'crew', '${SILENT}')`), /msgr_channel_personal_blocked/, '직접 넣기도 막힌다');
  sql(`update public.msgr_channels set personal_crews = 'approval' where id = '${ch}'`);
  assert.equal(inCh(ch, SPOKE), 't', '되돌려도 그대로');
});

test('방장 승인 채널에서도 들어온 에이전트는 일한다 — 지시를 막는 것은 못 데려옴뿐', { skip }, () => {
  assert.equal(sql(`select public.msgr_instruct_check('${MINE}', '${U.mate}', '${PUB}')`), 'ok');
});

test('채팅은 참여자면 바로 넣는다 — 정책과 무관', { skip }, () => {
  const dm = last(asUser(U.mate, `select public.msgr_create_channel('${ORG}', 'dm', 'dm:x', '[{"kind":"user","id":"${U.host}"}]'::jsonb)`));
  assert.equal(last(asUser(U.mate, `select public.msgr_crew_join('${dm}', '${MINE}')`)), 'joined');
  fails(asUserRaw(U.mate, `select public.msgr_crew_join('${dm}', '${MATE_CREW}')`), /msgr_forbidden/, '주인이 방에 없는 에이전트(사람이 딸려 들어가는 길은 없다)');
});

test('비공개 채널에 방장이 남의 에이전트를 넣으면 주인도 함께 들어온다', { skip }, () => {
  const priv = last(asUser(U.host, `select public.msgr_create_channel('${ORG}','private','Team')`));
  assert.equal(last(asUser(U.host, `select public.msgr_crew_join('${priv}', '${MATE_CREW}')`)), 'joined');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where channel_id = '${priv}' and member_kind = 'user' and member_id = '${U.other}'`), '1', '주인 동반');
});
