// 무료 계정도 최신 앱이면 메신저 에이전트 4명까지(유건 2026-10-11) — 20261011120000_msgr_free_new_app_agents.sql.
// 이 파일이 잠그는 것(경우 표의 칸 이름을 테스트 이름 앞에 단다):
//   [옛 앱만]    버전 없는 심박(옛 앱 0.1.101 이하 — 3인자 호출)만 있으면 지금처럼 전부 paused. 이유 'app'.
//   [새 앱 1대]  최소 버전 이상 심박이 처음 들어오면 그 자리에서 최근 대화 순 4명(같은 에이전트의 개인·조직 행은 한 명) 재개 — 커서는 끝으로, 기록 닫기.
//   [유휴]       같은 심박·sweep을 다시 부르면 쓰기 0(트랜잭션 번호 없음·xmin 불변).
//   [한도]       사람이 누른 다섯 번째 연결(available→active)은 msgr_free_agent_limit(옛 메신저가 알아보게 msgr_pro_required도 같이), 미러 insert는 조용히 paused,
//                이미 연결된 에이전트의 새 행은 한도에 세지 않는다. 한 문장의 여러 행 insert도 한도를 넘지 않는다.
//   [사람 선택]  사람이 연결을 해제해 빈자리가 생겨도 sweep이 다른 에이전트로 채우지 않는다(연결된 에이전트가 있으면) — 사람이 고른 에이전트(paused→active)는 한도 안에서 허용.
//   [꺼짐]       새 앱 심박이 30분 넘게 없으면 sweep이 다시 전부 paused(이유 'off'), 다시 켜지면 첫 심박에서 재개.
//   [새+옛 앱]   다른 기기의 옛 앱 심박은 판정에 들어가지 않는다 — 새 앱 기기가 꺼지면 옛 앱이 돌고 있어도 멈춘다.
//   [버전]       최소 버전 미만·형식이 틀린 버전은 새 앱이 아니다, 설정 free_agent_min_app으로 기준을 바꾼다.
//   [Pro→무료]   결제 해지(entitlements 트리거)로 무료가 되면 최근 대화 순 4명만 남기고 멈춘다(새 앱이 켜져 있으면), [무료→Pro] 전부 재개.
//   [봇]         봇 연결은 Pro 전용 그대로 — 새 앱이어도 msgr_bot_gate 'plan_required'.
//   [옛 서버 호환] 옛 앱의 3인자 이름 호출이 그대로 되고, 멈춘 행의 last_seen_at(옛 읽기 호환)은 쓰지 않는다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-free-new-app-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-free-new-app-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
// f = 무료(조직 OF 주인, 에이전트 6명), b = 결제 Pro(조직 OB 주인, 6명 — 해지 경로), h = 무료 새 가입자(개인 공간만)
const U = { f: 'f1111111-1111-4111-8111-111111111111', b: 'b2222222-2222-4222-8222-222222222222', h: 'a3333333-3333-4333-8333-333333333333' };
const WS = 'ws-f';
const NEW = '0.1.102'; const OLD = '0.1.101';
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const asUserRaw = (uid, q) => psqlRaw(['-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`]);
const asAnon = (q) => sql(`set role anon; ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const arr = (ids) => `array[${ids.map((x) => `'${x}'`).join(',')}]::uuid[]`;
const fails = (raw, re, label) => { assert.notEqual(raw.status, 0, `허용됨: ${label}`); assert.match(raw.stderr, re, `${label} — 실제 오류: ${raw.stderr.trim().slice(0, 200)}`); };
const off = (q2) => sql(`select set_config('msgr.pro_gate', 'off', false); ${q2}`);
const statusOf = (id) => sql(`select status from public.msgr_crews where id = '${id}'`);
const cursorOf = (id) => Number(sql(`select coalesce(cursor_msg_id, 0) from public.msgr_crews where id = '${id}'`));
const sweep = (uid = null) => JSON.parse(sql(`select public.msgr_crews_plan_sweep(${uid ? `'${uid}'` : 'null'})`));
const topMsg = () => Number(sql('select coalesce(max(id), 0) from public.msgr_messages'));
const ids = (uid, status) => sql(`select coalesce(string_agg(id::text, ',' order by id), '') from public.msgr_crews where owner_user_id = '${uid}' and hosting <> 'bot' and status = '${status}'`).split(',').filter(Boolean);
const slugsOf = (uid, status) => sql(`select coalesce(string_agg(distinct slug, ',' order by slug), '') from public.msgr_crews where owner_user_id = '${uid}' and hosting <> 'bot' and status = '${status}'`);
/** 새 앱 심박(버전 실음) — 같은 트랜잭션에서 쓰기가 있었는지를 함께 돌려준다 */
const beatV = (uid, dev, crewIds, ver = NEW) => last(asUser(uid, `select public.msgr_device_beat('${WS}', '${dev}', ${arr(crewIds)}, ${ver === null ? 'null' : q(ver)}); select coalesce(txid_current_if_assigned()::text, 'none')`)) !== 'none';
/** 옛 앱 심박(0.1.101 — 3인자 이름 호출, PostgREST가 보내는 모양 그대로) */
const beatOld = (uid, dev, crewIds) => asUser(uid, `select public.msgr_device_beat(p_ws => '${WS}', p_device => '${dev}', p_crews => ${arr(crewIds)})`);
const reason = (uid) => JSON.parse(last(asUser(uid, 'select public.msgr_my_agent_pause()')));
const snap = (uid) => sql(`select string_agg(id::text || ':' || xmin::text, ',' order by id) from public.msgr_crews where owner_user_id = '${uid}'`) + '|' +
  sql(`select coalesce(string_agg(device_id || ':' || xmin::text, ',' order by device_id), '') from public.msgr_device_beats where owner_user_id = '${uid}'`) + '|' +
  sql(`select coalesce(string_agg(crew_id::text || ':' || xmin::text, ',' order by crew_id), '') from public.msgr_crew_pauses where owner_user_id = '${uid}'`);

const F = {}; const B = {}; let OF, OB, CHF, CHB, BOT_F, TOKEN_F;
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
  // 이 DB만 관문을 켠다(드릴은 다른 테스트를 위해 off로 만든다) — msgr-crews-pro-pause-pg와 같은 방식
  sql(`do $$ begin execute format('alter database %I set msgr.pro_gate = %L', current_database(), 'on'); end $$`);
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  for (const f of [...base, ...readdirSync(dir).filter((x) => /^\d+_msgr.*\.sql$/.test(x))].sort()) psql(['-c', readFileSync(mig(f), 'utf8').replace(/^create extension if not exists pg_net;$/m, '')]);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users (id, created_at, email) values ('${id}', now() - interval '30 days', '${k}@example.test') on conflict do nothing`);
  sql(`insert into public.entitlements (user_id, plan) values ('${U.b}', 'pro')`);
  OF = last(asUser(U.f, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Free', 'free', '${U.f}') returning id`));
  OB = last(asUser(U.b, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Paid', 'paid', '${U.b}') returning id`));
  // 조직 플랜은 Pro 판정에 들지 않게(좌석 경로는 msgr-crews-pro-pause-pg가 잠근다) — 결제 없는 조직 그대로
  // f: 조직 행 f1~f6 + f2의 개인 행(같은 에이전트) — #941 적용 전부터 있던 active 행(관문 끈 세션에서 넣는다)
  const ins = (uid, org, slug, status = 'active') => last(off(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (${org ? `'${org}'` : 'null'}, '${uid}', '${WS}', '${slug}', '${slug}', 'local', '${status}', 'all') returning id`));
  for (const s of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']) F[s] = ins(U.f, OF, s);
  F.f2p = ins(U.f, null, 'f2'); F.f7 = ins(U.f, OF, 'f7', 'available'); F.fd = ins(U.f, OF, 'fd', 'detached');
  for (const s of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']) B[s] = ins(U.b, OB, s);
  // 최근 대화(실행 기록) 순서: f3 > f5 > f2(개인 행) > f1 > f6, f4는 기록 없음 / b: b1 > b2 > b3 > b4, b5·b6 없음
  CHF = last(asUser(U.f, `select public.msgr_create_channel('${OF}', 'public', 'Work')`));
  CHB = last(asUser(U.b, `select public.msgr_create_channel('${OB}', 'public', 'Work')`));
  const post = (uid, ch, body) => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', ${q(body)}, '[]'::jsonb, gen_random_uuid()::text) returning id`));
  const exec = (crew, msg) => sql(`insert into public.msgr_executions (crew_id, source_msg_id, attempt, state) values ('${crew}', ${msg}, gen_random_uuid(), 'completed')`);
  for (const crew of [F.f6, F.f1, F.f2p, F.f5, F.f3]) exec(crew, post(U.f, CHF, `일 ${crew}`));
  for (const crew of [B.b4, B.b3, B.b2, B.b1]) exec(crew, post(U.b, CHB, `일 ${crew}`));
  const out = JSON.parse(last(asUser(U.f, `select public.msgr_bot_create('${OF}', 'hermes', '헤르메스', '외부 에이전트')`))); BOT_F = out.crew_id; TOKEN_F = out.token;
});

test('[옛 앱만] 버전 없는 심박만 있으면 지금처럼 전부 paused — 이유 app, 다시 판정해도 재개하지 않는다', { skip }, () => {
  beatOld(U.f, 'vps-old', [F.f1, F.f2, F.f3, F.f4, F.f5, F.f6, F.f2p]);
  assert.equal(sql(`select coalesce(app_version, 'null') || ':' || (app_seen_at is null) from public.msgr_device_beats where device_id = 'vps-old'`), 'null:true', '옛 심박은 버전 칸을 쓰지 않는다');
  const r = sweep();
  assert.equal(r.failed, 0);
  assert.deepEqual(ids(U.f, 'active'), [], '무료 + 옛 앱 = 전부 멈춤(#941 그대로)');
  assert.equal(ids(U.f, 'paused').length, 7);
  assert.equal(statusOf(F.f7), 'available'); assert.equal(statusOf(F.fd), 'detached', '해고(detached)·해제(available)는 손대지 않는다');
  assert.equal(slugsOf(U.b, 'active'), 'b1,b2,b3,b4,b5,b6', 'Pro는 기기와 상관없이 그대로');
  assert.deepEqual(reason(U.f), { paused: 6, active: 0, limit: 4, reason: 'app' });
  assert.equal(reason(U.b).reason, null, 'Pro는 이유 없음');
  // 버전이 낮은 새 형식 심박(0.1.101 개발 빌드 등)도 새 앱이 아니다
  beatV(U.f, 'mac', ids(U.f, 'paused'), OLD);
  assert.deepEqual(ids(U.f, 'active'), []);
  sweep(); assert.deepEqual(ids(U.f, 'active'), []);
  // 형식이 틀린 버전은 버린다(행에 남기지 않는다)
  beatV(U.f, 'mac2', ids(U.f, 'paused'), 'abc; drop table x');
  assert.equal(sql(`select coalesce(app_version, 'null') from public.msgr_device_beats where device_id = 'mac2'`), 'null');
  sql(`delete from public.msgr_device_beats where device_id in ('mac', 'mac2')`);
});

let TOP_B;
test('[새 앱 1대] 최소 버전 심박이 처음 들어오면 그 자리에서 최근 대화 순 4명 재개 — 같은 에이전트의 두 행은 한 명, 커서는 끝으로, 기록 닫기', { skip }, () => {
  TOP_B = topMsg();
  const wrote = beatV(U.f, 'mac', ids(U.f, 'paused'));
  assert.ok(wrote);
  assert.equal(slugsOf(U.f, 'active'), 'f1,f2,f3,f5', '실행 기록 순 f3 > f5 > f2 > f1');
  assert.equal(statusOf(F.f2p), 'active', 'f2의 개인 행도 같은 에이전트라 같이(한 명으로 셈)');
  assert.equal(slugsOf(U.f, 'paused'), 'f4,f6');
  for (const id of [F.f1, F.f2, F.f2p, F.f3, F.f5]) assert.ok(cursorOf(id) >= TOP_B, '재개 커서는 끝으로(#941 경로)');
  assert.equal(sql(`select count(*) from public.msgr_crew_pauses where crew_id in ('${F.f1}', '${F.f3}') and resumed_at is not null`), '2', '중지 기록 닫기');
  assert.equal(sql(`select count(*) from public.msgr_crew_pauses where crew_id in ('${F.f4}', '${F.f6}') and resumed_at is null`), '2');
  assert.equal(sql(`select app_version from public.msgr_device_beats where device_id = 'mac'`), NEW);
  assert.deepEqual(reason(U.f), { paused: 2, active: 4, limit: 4, reason: 'limit' });
  assert.equal(statusOf(F.f7), 'available'); assert.equal(statusOf(F.fd), 'detached');
});

test('[유휴] 같은 심박·sweep을 다시 부르면 쓰기 0(트랜잭션 번호 없음·xmin 불변) — 옛 읽기 호환은 멈춘 행의 last_seen_at을 쓰지 않는다', { skip }, () => {
  const all = [...ids(U.f, 'active'), ...ids(U.f, 'paused')];
  beatV(U.f, 'mac', all); // 재개 뒤 첫 심박 — 새로 active가 된 행의 옛 읽기 호환·업무 기능 표시를 쓴다
  const s0 = snap(U.f);
  assert.equal(beatV(U.f, 'mac', all), false, '쉬는 동안 다시 부른 심박은 쓰지 않는다');
  assert.deepEqual(sweep(), { paused: 0, resumed: 0, failed: 0 });
  sweep(U.f);
  assert.equal(snap(U.f), s0);
  // 멈춘 행은 심박 목록에 있어도 last_seen_at을 쓰지 않는다(종전 함수는 받은 행 전부를 고쳐 썼다)
  sql(`update public.msgr_crews set last_seen_at = now() - interval '10 minutes' where id = '${F.f4}'`);
  sql(`update public.msgr_device_beats set seen_at = now() - interval '40 seconds' where device_id = 'mac'`);
  beatV(U.f, 'mac', [F.f4, F.f1]);
  assert.ok(Number(sql(`select extract(epoch from now() - last_seen_at)::int from public.msgr_crews where id = '${F.f4}'`)) >= 590, '멈춘 행 last_seen_at 그대로');
});

test('[한도] 사람이 누른 다섯 번째 연결은 msgr_free_agent_limit, 미러 insert는 조용히 paused, 이미 연결된 에이전트의 새 행은 세지 않는다', { skip }, () => {
  fails(asUserRaw(U.f, `update public.msgr_crews set status = 'active' where id = '${F.f7}'`), /msgr_free_agent_limit.*msgr_pro_required/, '다섯 번째 연결(옛 메신저도 알아보게 msgr_pro_required 동반)');
  assert.equal(statusOf(F.f7), 'available');
  const n = last(asUser(U.f, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${OF}', '${U.f}', '${WS}', 'f8', 'f8', 'local', 'active', 'all') returning id`));
  F.f8 = n; assert.equal(statusOf(n), 'paused', '미러 insert(옛·새 앱 모두 active로 넣는다) — 오류 대신 paused');
  const p3 = last(asUser(U.f, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${U.f}', '${WS}', 'f3', 'f3', 'local', 'active', 'owner') returning id`));
  F.f3p = p3; assert.equal(statusOf(p3), 'active', 'f3은 이미 연결된 에이전트 — 개인 행이 늘어도 한 명');
  // 업서트 충돌(설정 POST): 한도에 걸리면 파견 해제한 available 행은 그대로
  asUser(U.f, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${OF}', '${U.f}', '${WS}', 'f7', 'f7', 'local', 'active', 'all')
    on conflict (org_id, owner_user_id, ws_id, slug) do update set status = excluded.status`);
  assert.equal(statusOf(F.f7), 'available');
  assert.equal(slugsOf(U.f, 'active'), 'f1,f2,f3,f5');
});

test('[사람 선택] 해제로 빈자리가 생겨도 sweep은 채우지 않고, 사람이 고른 멈춘 에이전트는 한도 안에서 연결된다 — 한도를 넘으면 조용히 paused + 이유 limit', { skip }, () => {
  asUser(U.f, `update public.msgr_crews set status = 'available' where id = '${F.f1}'`);
  assert.equal(statusOf(F.f1), 'available');
  sweep(); sweep(U.f);
  assert.equal(slugsOf(U.f, 'active'), 'f2,f3,f5', '사람이 비운 자리를 다른 에이전트로 채우지 않는다');
  asUser(U.f, `update public.msgr_crews set status = 'active' where id = '${F.f6}'`);
  assert.equal(statusOf(F.f6), 'active', '사람이 고른 에이전트(paused→active, 설정의 연결) — 한도 안');
  asUser(U.f, `update public.msgr_crews set status = 'active' where id = '${F.f4}'`);
  assert.equal(statusOf(F.f4), 'paused', '한도를 넘는 paused→active는 조용히 그대로(옛 앱의 같은 쓰기가 오류로 반복되지 않게)');
  assert.equal(reason(U.f).reason, 'limit');
  sweep();
  assert.equal(slugsOf(U.f, 'active'), 'f2,f3,f5,f6');
});

test('[한도] 한 문장의 여러 행 insert(미러 일괄)도 한도를 넘지 않는다 — 새 가입자는 첫 새 앱 심박에서 4명', { skip }, () => {
  const rows = (slugs) => slugs.map((s) => `(null, '${U.h}', '${WS}', '${s}', '${s}', 'local', 'active', 'owner')`).join(',');
  asUser(U.h, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ${rows(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])}`);
  assert.equal(slugsOf(U.h, 'paused'), 'h1,h2,h3,h4,h5,h6', '기기 심박 전(새 가입자 첫 틱) — 전부 paused');
  // 다음 틱: 새 앱 게이트웨이가 멈춘 행으로 심박 → 기기 행이 생기고 그 자리에서 4명 재개
  assert.ok(beatV(U.h, 'win', ids(U.h, 'paused')));
  assert.equal(slugsOf(U.h, 'active'), 'h1,h2,h3,h4', '기록이 없으면 만든 순·이름 순');
  // 둘을 해제한 뒤 한 문장에 셋을 넣으면 둘만 연결
  asUser(U.h, `update public.msgr_crews set status = 'available' where owner_user_id = '${U.h}' and slug in ('h3', 'h4')`);
  asUser(U.h, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ${rows(['h7', 'h8', 'h9'])}`);
  assert.equal(sql(`select count(distinct slug) from public.msgr_crews where owner_user_id = '${U.h}' and status = 'active'`), '4', '한 문장 안에서도 4명');
  assert.equal(slugsOf(U.h, 'active'), 'h1,h2,h7,h8');
});

test('[봇] 새 앱이어도 봇 연결은 Pro 전용 — msgr_bot_gate plan_required', { skip }, () => {
  assert.equal(asAnon(`select public.msgr_bot_gate('${TOKEN_F}')`), 'plan_required');
  assert.equal(statusOf(BOT_F), 'active', '봇 행 상태는 바꾸지 않는다(#941 그대로)');
});

test('[꺼짐] 새 앱 심박이 30분 넘게 없으면 sweep이 전부 멈춘다(이유 off) — 다시 켜지면 첫 심박에서 최근 대화 순 4명', { skip }, () => {
  sql(`update public.msgr_device_beats set app_seen_at = now() - interval '29 minutes', seen_at = now() - interval '29 minutes' where owner_user_id = '${U.f}'`);
  sweep(); assert.equal(slugsOf(U.f, 'active'), 'f2,f3,f5,f6', '30분 안은 그대로(잠깐 잠자기·재시작)');
  sql(`update public.msgr_device_beats set app_seen_at = now() - interval '31 minutes', seen_at = now() - interval '31 minutes' where owner_user_id = '${U.f}'`);
  const r = sweep(); assert.equal(r.failed, 0);
  assert.deepEqual(ids(U.f, 'active'), []);
  assert.deepEqual(reason(U.f), { paused: 6, active: 0, limit: 4, reason: 'off' }); // f2·f3은 개인·조직 두 행이어도 한 명
  const top = topMsg();
  assert.ok(beatV(U.f, 'mac', ids(U.f, 'paused')));
  assert.equal(slugsOf(U.f, 'active'), 'f2,f3,f5,f6', 'f1은 사람이 해제한 그대로(available) — 멈춘 것 중 최근 대화 순');
  assert.ok(cursorOf(F.f6) >= top);
});

test('[새+옛 앱] 다른 기기의 옛 앱 심박은 판정에 들지 않는다 — 맥(새 앱)이 꺼지면 VPS(옛 CLI)가 돌고 있어도 멈춘다', { skip }, () => {
  sql(`update public.msgr_device_beats set seen_at = now() where device_id = 'vps-old'`);
  beatOld(U.f, 'vps-old', ids(U.f, 'active'));
  sweep(); assert.equal(slugsOf(U.f, 'active'), 'f2,f3,f5,f6', '맥이 켜져 있는 동안은 연결');
  sql(`update public.msgr_device_beats set app_seen_at = now() - interval '31 minutes' where device_id = 'mac'`);
  sql(`update public.msgr_device_beats set seen_at = now() where device_id = 'vps-old'`);
  sweep();
  assert.deepEqual(ids(U.f, 'active'), [], '옛 앱만 남으면 멈춘다');
  assert.equal(reason(U.f).reason, 'off');
});

test('[버전] 설정 free_agent_min_app으로 기준을 바꾼다 — 기준보다 낮은 새 앱은 재개하지 않고, 틀린 값은 기본값 0.1.102', { skip }, () => {
  sql(`insert into public.msgr_settings (key, value) values ('free_agent_min_app', '0.1.110') on conflict (key) do update set value = excluded.value`);
  beatV(U.f, 'mac', ids(U.f, 'paused'));
  assert.deepEqual(ids(U.f, 'active'), [], '0.1.102 < 0.1.110');
  assert.equal(reason(U.f).reason, 'app', '기준 이상인 새 앱 기기가 한 번도 없다');
  sql(`update public.msgr_settings set value = 'not-a-version' where key = 'free_agent_min_app'`);
  sql(`update public.msgr_device_beats set app_seen_at = now() - interval '31 minutes' where device_id = 'mac'`); // 다시 '처음 들어온 심박'이 되게
  beatV(U.f, 'mac', ids(U.f, 'paused'));
  assert.equal(slugsOf(U.f, 'active'), 'f2,f3,f5,f6', '틀린 설정 값은 기본값(0.1.102)으로');
  sql(`delete from public.msgr_settings where key = 'free_agent_min_app'`);
});

test('[Pro→무료] 결제 해지로 무료가 되면(새 앱 켜짐) 최근 대화 순 4명만 남기고 멈춘다, [무료→Pro] 결제하면 전부 재개', { skip }, () => {
  beatV(U.b, 'mac-b', ids(U.b, 'active'));
  assert.equal(slugsOf(U.b, 'active'), 'b1,b2,b3,b4,b5,b6');
  sql(`update public.entitlements set plan = 'free' where user_id = '${U.b}'`);
  assert.equal(slugsOf(U.b, 'active'), 'b1,b2,b3,b4', '해지 즉시(entitlements 트리거) — 실행 기록 순 4명');
  assert.equal(slugsOf(U.b, 'paused'), 'b5,b6');
  // 결제
  sql(`insert into public.entitlements (user_id, plan) values ('${U.f}', 'pro')`);
  assert.equal(slugsOf(U.f, 'paused'), '', '무료→Pro는 멈춘 에이전트 전부 재개');
  assert.equal(statusOf(F.f7), 'available'); assert.equal(statusOf(F.f1), 'available', '사람이 해제한 것은 그대로');
  assert.equal(asAnon(`select public.msgr_bot_gate('${TOKEN_F}')`), 'ok', 'Pro가 되면 봇도');
  assert.equal(reason(U.f).reason, null);
});

test('권한: 이유 조회는 로그인한 본인 것만(인자 없음), 로그인 없이는 null — 심박 함수는 옛 3인자 이름 호출과 새 4인자 호출 모두 authenticated에게만', { skip }, () => {
  assert.equal(last(asUser(U.h, 'select public.msgr_my_agent_pause() is not null')), 't');
  fails(psqlRaw(['-A', '-t', '-c', 'set role anon; select public.msgr_my_agent_pause()']), /permission denied/, '익명');
  fails(psqlRaw(['-A', '-t', '-c', `set role anon; select public.msgr_device_beat('${WS}', 'x', array[]::uuid[], '${NEW}')`]), /permission denied/, '익명 심박');
  assert.equal(sql(`select count(*) from pg_proc where proname = 'msgr_device_beat'`), '1', '겹치는 함수(3인자·4인자)가 함께 있으면 PostgREST가 고르지 못한다(PGRST203)');
  for (const fn of ['_msgr_free_app_ok(uuid)', '_msgr_free_agent_policy()', '_msgr_app_ver(text)']) {
    fails(asUserRaw(U.f, `select public.${fn.replace('(uuid)', `('${U.f}')`).replace('(text)', "('0.1.1')")}`), /permission denied/, `내부 함수 ${fn}`);
  }
});
