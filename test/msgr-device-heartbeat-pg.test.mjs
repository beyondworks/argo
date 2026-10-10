// 기기 단위 심박(유건 2026-10-10, 20261010120000_msgr_device_heartbeat) — 실제 Postgres에서 본다.
// ① 쉬는 동안(같은 목록·기한 안) 심박 요청은 쓰기 0 — 트랜잭션 번호도 안 생기고 기기 행·에이전트 행 xmin 그대로
// ② 옛 읽기(표의 last_seen_at 직접 — 설치된 메신저)로 새 심박을 읽어도 접속(90초 안). 조직 행은 35초, 개인 행은 50초 넘을 때만 다시 쓴다
// ③ 옛 Argo(0.1.100 이하)가 행에 쓴 심박만 있어도 새 읽기(계산 열·서버 함수)가 접속으로 본다
// ④ 기기가 꺼지면 기존과 같은 시간 안에 부재중 — 기기 행 기한 35초 = 종전 조직 행과 같은 최악 나이(요청 지연 10초 모의에서 둘 다 약 54초)
// ⑤ 기기 이동(맥 → 서버 예비)·여러 기기·목록 변경(해고)·남의 행·다른 회사 행·권한
// ⑥ 서버 읽는 쪽(msgr_personal_room_crews·msgr_work_create·office_work_status)이 기기 심박을 쓴다
// 실행: bash scripts/billing-pg-drill.sh test/msgr-device-heartbeat-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-device-heartbeat-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { owner: '11111111-1111-4111-8111-111111111111', member: '33333333-3333-4333-8333-333333333333', outsider: '55555555-5555-4555-8555-555555555555' };

function psqlRaw(args) { return psqlSpawn(DB, args); }
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim(); // 슈퍼유저 — 시드·관찰(시각 되돌리기)만
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, label); };
const arr = (ids) => `array[${ids.map((x) => `'${x}'`).join(',')}]::uuid[]`;
/** 심박 한 번 — 같은 트랜잭션에서 쓰기가 있었는지(트랜잭션 번호가 생겼는지)를 함께 돌려준다 */
const beat = (uid, ws, dev, ids) => last(asUser(uid, `select public.msgr_device_beat('${ws}', '${dev}', ${arr(ids)}); select coalesce(txid_current_if_assigned()::text, 'none')`)) !== 'none';
const age = (expr) => Number(sql(`select extract(epoch from now() - (${expr}))::int`)); // 초
const xmin = (table, where) => sql(`select xmin::text from public.${table} where ${where}`);
const setAge = (table, col, where, secs) => sql(`update public.${table} set ${col} = now() - interval '${secs} seconds' where ${where}`);
const seenBy = (uid, crew) => last(asUser(uid, `select coalesce(extract(epoch from now() - public.msgr_crew_seen(c))::int::text, 'null') from public.msgr_crews c where c.id = '${crew}'`)); // 계산 열(앱이 읽는 값)의 나이
const oldRead = (uid, crew) => last(asUser(uid, `select coalesce(extract(epoch from now() - last_seen_at)::int::text, 'null') from public.msgr_crews where id = '${crew}'`)); // 설치된 메신저가 읽는 값의 나이

let ORG, PUB, C_ORG, C_PER, C_TWO, C_MEMBER, C_OTHER_WS;
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
    create or replace function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ select null::void $$;
    alter table realtime.messages enable row level security; grant select, insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;
    create schema if not exists net; create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
  `]);
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql']) psql(['-c', readFileSync(mig(f), 'utf8')]);
  // 배포될 메신저 마이그레이션 전부(이 PR의 20261010120000 포함) — 날짜 순서 그대로
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x)).sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  // 오피스 업무 현황(office_work_status)과 그 위의 이 PR 파일 — office-work-status-pg.test.mjs와 같은 오피스 목록
  for (const f of ['20260927144230_office_business.sql', '20260927170000_office_pages.sql', '20260927171000_office_mail.sql', '20260928010000_office_marketing.sql', '20260929140000_office_deal_flow.sql', '20260929180000_office_tasks_owners.sql',
    '20260929190000_office_perf.sql', '20260930150000_office_perf_tie_order.sql', '20261002201800_office_company.sql', '20261004100000_office_task_props.sql', '20261008200000_office_work_status.sql', '20261010120100_office_work_status_device_seen.sql']) psql(['-c', readFileSync(mig(f), 'utf8')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  ORG = last(asUser(U.owner, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.owner}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  const code = last(asUser(U.owner, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.owner}') returning code`));
  assert.equal(last(asUser(U.member, `select public.msgr_accept_invite('${code}')`)), ORG);
  const crew = (uid, org, ws, slug) => last(asUser(uid, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name) values (${org ? `'${org}'` : 'null'}, '${uid}', '${ws}', '${slug}', '${slug}') returning id`));
  C_ORG = crew(U.owner, ORG, 'lean', 'mine');       // 조직 행
  C_PER = crew(U.owner, null, 'lean', 'mine');      // 같은 에이전트의 개인 행
  C_TWO = crew(U.owner, ORG, 'lean', 'two');        // 같은 회사의 다른 에이전트
  C_OTHER_WS = crew(U.owner, ORG, 'other-ws', 'x'); // 같은 주인, 다른 회사
  C_MEMBER = crew(U.member, ORG, 'lean', 'theirs'); // 남의 에이전트
  PUB = last(asUser(U.owner, `select public.msgr_create_channel('${ORG}', 'public', 'Work')`));
  for (const id of [C_ORG, C_TWO]) asUser(U.owner, `select public.msgr_crew_join('${PUB}', '${id}')`); // 팀 업무 총괄 후보 = 방에 든 에이전트
  sql(`update public.msgr_crews set last_seen_at = null`);
});

test('첫 심박: 기기 행 1개(맡은 에이전트 이름) + 옛 읽기 호환 행 + 업무 기능 표시, 쉬는 동안 다시 부르면 쓰기 0(트랜잭션 번호 없음·xmin 그대로)', { skip }, () => {
  assert.equal(beat(U.owner, 'lean', 'mac-1', [C_ORG, C_PER, C_TWO]), true);
  assert.equal(sql(`select array_to_string(slugs, ',') from public.msgr_device_beats where owner_user_id = '${U.owner}' and ws_id = 'lean' and device_id = 'mac-1'`), 'mine,two');
  assert.ok(age(`select seen_at from public.msgr_device_beats where device_id = 'mac-1'`) <= 1);
  for (const id of [C_ORG, C_PER, C_TWO]) assert.ok(Number(oldRead(U.owner, id)) <= 1, '옛 읽기 호환 — 행 시각도 지금');
  assert.equal(sql(`select work_protocol from public.msgr_crews where id = '${C_ORG}'`), '1', 'msgr_work_heartbeat와 같은 일');
  assert.notEqual(sql(`select work_protocol from public.msgr_crews where id = '${C_PER}'`), '1', '업무 기능은 조직 행만(개인 행은 종전처럼 표시하지 않는다)');

  const before = [xmin('msgr_device_beats', `device_id = 'mac-1'`), ...[C_ORG, C_PER, C_TWO].map((id) => xmin('msgr_crews', `id = '${id}'`))];
  for (let i = 0; i < 3; i++) assert.equal(beat(U.owner, 'lean', 'mac-1', [C_ORG, C_PER, C_TWO]), false, `쉬는 틱 ${i + 1}: 쓰기 0(트랜잭션 번호 없음)`);
  const after = [xmin('msgr_device_beats', `device_id = 'mac-1'`), ...[C_ORG, C_PER, C_TWO].map((id) => xmin('msgr_crews', `id = '${id}'`))];
  assert.deepEqual(after, before, '기기 행·에이전트 행 xmin 그대로');
});

test('기한: 기기 행·조직 행은 35초, 개인 행은 50초 넘을 때만 다시 쓴다(15초 틱이면 대개 45초·60초마다) — 그 안은 쓰기 0', { skip }, () => {
  setAge('msgr_device_beats', 'seen_at', `device_id = 'mac-1'`, 30); setAge('msgr_crews', 'last_seen_at', `id in ('${C_ORG}', '${C_TWO}')`, 30); setAge('msgr_crews', 'last_seen_at', `id = '${C_PER}'`, 45);
  assert.equal(beat(U.owner, 'lean', 'mac-1', [C_ORG, C_PER, C_TWO]), false, '30초·45초 = 기한 안 → 쓰기 0(15초 틱의 두 번째·세 번째 틱)');
  setAge('msgr_device_beats', 'seen_at', `device_id = 'mac-1'`, 36); setAge('msgr_crews', 'last_seen_at', `id in ('${C_ORG}', '${C_TWO}')`, 36);
  const per0 = xmin('msgr_crews', `id = '${C_PER}'`);
  assert.equal(beat(U.owner, 'lean', 'mac-1', [C_ORG, C_PER, C_TWO]), true);
  assert.ok(age(`select seen_at from public.msgr_device_beats where device_id = 'mac-1'`) <= 1, '기기 행 36초 → 다시 씀');
  assert.ok(Number(oldRead(U.owner, C_ORG)) <= 1, '조직 행 36초 → 다시 씀');
  assert.equal(xmin('msgr_crews', `id = '${C_PER}'`), per0, '개인 행 45초 → 그대로(50초 기한)');
  setAge('msgr_crews', 'last_seen_at', `id = '${C_PER}'`, 51);
  beat(U.owner, 'lean', 'mac-1', [C_ORG, C_PER, C_TWO]);
  assert.ok(Number(oldRead(U.owner, C_PER)) <= 1, '개인 행 51초 → 다시 씀');
});

test('옛 읽기(표의 last_seen_at 직접 — 설치된 메신저): 새 심박만 받는 에이전트도 조직 멤버에게 접속으로 보인다', { skip }, () => {
  // 메신저 0.1.47 이하 = 30초마다 다시 읽고 지금 시각과 비교 → 보이는 나이 = 행 나이 + 30초. 행 나이는 조직 행 대개 최대 45초(35초 기한 + 15초 틱, 요청 지연 10초면 약 54초 — 종전 30초 기한과 같은 최악)
  setAge('msgr_crews', 'last_seen_at', `id = '${C_ORG}'`, 44);
  beat(U.owner, 'lean', 'mac-1', [C_ORG, C_PER, C_TWO]);
  const seen = Number(oldRead(U.member, C_ORG));
  assert.ok(seen + 30 < 90, `멤버가 읽은 행 나이 ${seen}초 + 재조회 30초 < 부재 판정 90초`);
  assert.ok(Number(seenBy(U.member, C_ORG)) <= 1, '새 읽기(계산 열)도 접속');
});

test('옛 Argo(0.1.100 이하)가 행에 쓴 심박만 있어도 새 읽기가 접속으로 본다 — 기기 행 없음', { skip }, () => {
  sql(`delete from public.msgr_device_beats`);
  setAge('msgr_crews', 'last_seen_at', `owner_user_id = '${U.owner}'`, 600);
  asUser(U.owner, `update public.msgr_crews set last_seen_at = now() where id in ('${C_ORG}', '${C_PER}')`); // 옛 앱의 PATCH와 같은 쓰기
  assert.ok(Number(seenBy(U.member, C_ORG)) <= 1, '계산 열(메신저·넘김 표시) — 행 시각 그대로');
  const per = last(asUser(U.owner, `select extract(epoch from now() - last_seen_at)::int from public.msgr_personal_room_crews() where id = '${C_PER}'`));
  assert.ok(Number(per) <= 1, '개인 공간 목록(msgr_personal_room_crews)');
});

test('기기가 꺼지면 기존과 같은 시간 안에 부재중 — 마지막 기기 심박 90초 뒤 계산 열·개인 공간 목록·팀 업무 총괄 고르기 모두 꺼짐', { skip }, () => {
  sql(`delete from public.msgr_device_beats`);
  beat(U.owner, 'lean', 'mac-1', [C_ORG, C_PER, C_TWO]);
  sql(`update public.msgr_crews set allow = 'all', role_text = '총괄 moderator' where id = '${C_ORG}'`);
  // 켜져 있는 동안: 행이 오래돼도 기기 심박으로 접속(앞으로 행 쓰기를 끄는 단계에서도 같은 판정)
  setAge('msgr_crews', 'last_seen_at', `owner_user_id = '${U.owner}'`, 86400);
  assert.ok(Number(seenBy(U.member, C_ORG)) <= 1);
  assert.ok(Number(last(asUser(U.owner, `select extract(epoch from now() - last_seen_at)::int from public.msgr_personal_room_crews() where id = '${C_PER}'`))) <= 1);
  const w = JSON.parse(last(asUser(U.owner, `select public.msgr_work_create('${PUB}', '99999999-9999-4999-8999-000000000001', 'Compare', '', null)`)));
  assert.equal(w.lead_crew_id, C_ORG, '총괄 자동 선택이 기기 심박을 본다(90초)');
  // 기기가 꺼짐: 마지막 심박 뒤 시간이 흐른다. 기기 행 나이는 켜져 있는 동안 종전 조직 행과 같은 최악(대개 45초)이다 → 꺼진 뒤 같은 시간 안에 부재중
  setAge('msgr_device_beats', 'seen_at', `device_id = 'mac-1'`, 89);
  assert.ok(Number(seenBy(U.member, C_ORG)) < 90, '89초 = 아직 접속');
  setAge('msgr_device_beats', 'seen_at', `device_id = 'mac-1'`, 91);
  assert.ok(Number(seenBy(U.member, C_ORG)) >= 90, '91초 = 부재중');
  assert.ok(Number(last(asUser(U.owner, `select extract(epoch from now() - last_seen_at)::int from public.msgr_personal_room_crews() where id = '${C_PER}'`))) >= 90);
  fails(asUserRaw(U.owner, `select public.msgr_work_create('${PUB}', '99999999-9999-4999-8999-000000000002', 'Compare', '', null)`), /no_available_lead/, '꺼진 에이전트는 총괄로 고르지 않는다');
});

test('기기 이동(맥 → 서버 예비)·여러 기기: 어느 기기든 살아 있으면 접속, 두 번째 기기는 행을 겹쳐 쓰지 않는다', { skip }, () => {
  sql(`delete from public.msgr_device_beats`); setAge('msgr_crews', 'last_seen_at', `owner_user_id = '${U.owner}'`, 0);
  beat(U.owner, 'lean', 'mac-1', [C_ORG, C_PER]);
  const rows = [C_ORG, C_PER].map((id) => xmin('msgr_crews', `id = '${id}'`));
  assert.equal(beat(U.owner, 'lean', 'vps-1', [C_ORG, C_PER]), true, '서버 기기는 자기 기기 행 하나를 쓴다');
  assert.deepEqual([C_ORG, C_PER].map((id) => xmin('msgr_crews', `id = '${id}'`)), rows, '에이전트 행은 맥이 방금 썼으므로 다시 쓰지 않는다');
  assert.equal(sql(`select count(*) from public.msgr_device_beats where owner_user_id = '${U.owner}' and ws_id = 'lean'`), '2');
  // 맥이 꺼지고 서버 예비가 이어받음
  setAge('msgr_device_beats', 'seen_at', `device_id = 'mac-1'`, 300); setAge('msgr_crews', 'last_seen_at', `owner_user_id = '${U.owner}'`, 300);
  assert.ok(Number(seenBy(U.member, C_ORG)) <= 1, '서버 기기 심박으로 접속');
  // 맥이 돌아오고 서버가 물러남(standbyIdle → 브리지 멈춤 = 심박 없음)
  setAge('msgr_device_beats', 'seen_at', `device_id = 'vps-1'`, 300);
  beat(U.owner, 'lean', 'mac-1', [C_ORG, C_PER]);
  assert.ok(Number(seenBy(U.member, C_ORG)) <= 1, '맥 심박으로 접속');
});

test('목록 변경(해고·카드 없음)은 기한을 기다리지 않고 바로 반영 — 빠진 에이전트는 기기 심박을 받지 않는다', { skip }, () => {
  sql(`delete from public.msgr_device_beats`); setAge('msgr_crews', 'last_seen_at', `owner_user_id = '${U.owner}'`, 300);
  beat(U.owner, 'lean', 'mac-1', [C_ORG, C_TWO]);
  setAge('msgr_crews', 'last_seen_at', `id = '${C_TWO}'`, 300);
  assert.equal(beat(U.owner, 'lean', 'mac-1', [C_ORG]), true, 'two가 빠짐 → 기기 행을 바로 고쳐 쓴다');
  assert.equal(sql(`select array_to_string(slugs, ',') from public.msgr_device_beats where device_id = 'mac-1'`), 'mine');
  assert.ok(Number(seenBy(U.member, C_TWO)) >= 90, '빠진 에이전트 = 부재중(CX-14 — 해고를 못 본 행이 접속으로 남지 않는다)');
});

test('남의 행·다른 회사 행은 이 기기 심박으로 접속이 되지 않는다 — 행도 쓰지 않는다', { skip }, () => {
  sql(`delete from public.msgr_device_beats`); setAge('msgr_crews', 'last_seen_at', `true`, 300);
  const before = [C_MEMBER, C_OTHER_WS].map((id) => xmin('msgr_crews', `id = '${id}'`));
  beat(U.owner, 'lean', 'mac-1', [C_ORG, C_MEMBER, C_OTHER_WS]);
  assert.equal(sql(`select array_to_string(slugs, ',') from public.msgr_device_beats where device_id = 'mac-1'`), 'mine', '남의 에이전트(theirs)·다른 회사(x)는 목록에 없다');
  assert.deepEqual([C_MEMBER, C_OTHER_WS].map((id) => xmin('msgr_crews', `id = '${id}'`)), before);
  assert.ok(Number(seenBy(U.owner, C_MEMBER)) >= 90);
  // 같은 slug라도 다른 주인의 기기 심박은 섞이지 않는다
  sql(`update public.msgr_crews set slug = 'mine' where id = '${C_MEMBER}'`);
  assert.ok(Number(seenBy(U.owner, C_MEMBER)) >= 90, '주인이 다르면 같은 이름이어도 별개');
  sql(`update public.msgr_crews set slug = 'theirs' where id = '${C_MEMBER}'`);
});

test('권한: 기기 행은 직접 못 읽고, 계산 열은 그 행을 읽을 수 있는 사람에게만 값이 있다, 로그인 없이는 심박 불가', { skip }, () => {
  fails(asUserRaw(U.owner, `select * from public.msgr_device_beats`), /permission denied/, '주인도 표를 직접 못 읽는다(기기 이름)');
  fails(asUserRaw(U.owner, `insert into public.msgr_device_beats (owner_user_id, ws_id, device_id) values ('${U.member}', 'lean', 'fake')`), /permission denied/, '직접 쓰기 없음');
  fails(asUserRaw(U.owner, `select public._msgr_device_seen('${U.member}', 'lean', 'theirs')`), /permission denied/, '내부 함수는 못 부른다');
  // 조직 밖 사람이 표 밖에서 만든 행 값으로 계산 열을 불러도 값이 없다(저장된 행 + 읽기 정책 조건으로 판정)
  sql(`delete from public.msgr_device_beats`); beat(U.owner, 'lean', 'mac-1', [C_ORG]);
  sql(`drop table if exists public._probe; create table public._probe as select * from public.msgr_crews where id = '${C_ORG}'; grant select on public._probe to authenticated`);
  assert.equal(last(asUser(U.outsider, `select coalesce(public.msgr_crew_seen(row(p.*)::public.msgr_crews)::text, 'null') from public._probe p`)), 'null', '조직 밖 사람');
  assert.notEqual(last(asUser(U.member, `select coalesce(public.msgr_crew_seen(row(p.*)::public.msgr_crews)::text, 'null') from public._probe p`)), 'null', '조직 멤버는 값이 있다');
  sql(`drop table public._probe`);
  assert.equal(last(asUser(U.member, `select coalesce(public.msgr_crew_seen(c)::text, 'null') from public.msgr_crews c where c.id = '${C_PER}'`)), '', '남의 개인 행은 표 읽기 정책에서 이미 안 보인다');
  fails(psqlRaw(['-A', '-t', '-c', `set role authenticated; select public.msgr_device_beat('lean', 'mac-1', ${arr([C_ORG])})`]), /msgr_device_beat_forbidden/, '로그인 없음');
  fails(asUserRaw(U.owner, `select public.msgr_device_beat('lean', '', ${arr([C_ORG])})`), /msgr_device_beat_invalid/, '빈 기기 id');
  assert.equal(sql(`select has_function_privilege('anon', 'public.msgr_device_beat(text,text,uuid[],text)', 'EXECUTE')`), 'f'); // 20261011120000부터 앱 버전 인자(기본값 null — 옛 3인자 호출도 이 함수로 온다)
  assert.equal(sql(`select has_function_privilege('anon', 'public.msgr_crew_seen(public.msgr_crews)', 'EXECUTE')`), 'f');
});

test('오피스 업무 현황(office_work_status)의 에이전트 접속 시각 = 기기 심박을 합친 값', { skip }, () => {
  sql(`delete from public.msgr_device_beats`); setAge('msgr_crews', 'last_seen_at', `true`, 86400);
  beat(U.owner, 'lean', 'mac-1', [C_ORG]); setAge('msgr_crews', 'last_seen_at', `true`, 86400);
  const st = JSON.parse(last(asUser(U.owner, `select public.office_work_status('${ORG}')`)));
  const c = st.crews.find((x) => x.id === C_ORG);
  assert.ok(c, '내 에이전트가 목록에 있다');
  assert.ok((Date.now() - Date.parse(c.last_seen_at)) / 1000 < 30, `기기 심박 시각 ${c.last_seen_at}`);
  assert.equal(st.crews[0].id, C_ORG, '접속 순 정렬도 같은 값');
  const two = st.crews.find((x) => x.id === C_TWO);
  assert.ok(two && (Date.now() - Date.parse(two.last_seen_at)) / 1000 > 3600, '기기가 맡지 않은 에이전트는 행 시각 그대로');
});

test('기기 행 상한(분리 검수 M2): 맡은 에이전트가 없으면 넣지 않고, 회사 id 규칙을 지키며, 주인당 50행을 넘지 않는다 — 쉬는 틱은 지우지 않는다', { skip }, () => {
  sql(`delete from public.msgr_device_beats`);
  assert.equal(beat(U.owner, 'lean', 'ghost', []), false, '빈 목록 = 넣지 않음(쓰기 0)');
  assert.equal(beat(U.owner, 'lean', 'ghost', [C_MEMBER]), false, '남의 행만 = 맡은 에이전트 없음 → 넣지 않음');
  fails(asUserRaw(U.owner, `select public.msgr_device_beat('../x', 'mac-1', ${arr([C_ORG])})`), /msgr_device_beat_invalid/, '회사 id 규칙');
  fails(asUserRaw(U.owner, `select public.msgr_device_beat('lean', '${'d'.repeat(201)}', ${arr([C_ORG])})`), /msgr_device_beat_invalid/, '기기 id 200자');
  for (let i = 0; i < 55; i++) beat(U.owner, 'lean', `dev-${i}`, [C_ORG]);
  assert.equal(sql(`select count(*) from public.msgr_device_beats where owner_user_id = '${U.owner}'`), '50', '주인당 50행');
  assert.equal(sql(`select count(*) from public.msgr_device_beats where device_id in ('dev-0', 'dev-4')`), '0', '가장 오래된 것부터 비웠다');
  assert.equal(sql(`select count(*) from public.msgr_device_beats where device_id = 'dev-54'`), '1');
  assert.equal(beat(U.owner, 'lean', 'dev-54', [C_ORG]), false, '있는 기기의 쉬는 틱은 아무것도 지우지·쓰지 않는다');
});

test('파견 해제(available)된 행은 같은 에이전트가 다른 곳에서 심박을 받아도 행 시각만 준다(분리 검수 L3)', { skip }, () => {
  sql(`delete from public.msgr_device_beats`); beat(U.owner, 'lean', 'mac-1', [C_ORG, C_TWO]);
  setAge('msgr_crews', 'last_seen_at', `id = '${C_TWO}'`, 3600);
  sql(`update public.msgr_crews set status = 'available' where id = '${C_TWO}'`);
  assert.ok(Number(seenBy(U.member, C_TWO)) >= 3500, '해제된 행 = 행 시각(주인 기기 상태를 다른 멤버가 알아낼 수 없다)');
  sql(`update public.msgr_crews set status = 'active' where id = '${C_TWO}'`);
  assert.ok(Number(seenBy(U.member, C_TWO)) <= 5, '다시 파견하면 기기 심박');
});
