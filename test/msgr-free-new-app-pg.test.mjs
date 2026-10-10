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
//   검수 #945 반영(10/11): [직접 연결 재개] 사람이 paused→active로 연결해도 재개 처리(커서 끝·기록 닫기·자동화 정리) — 무료·Pro 모두(HIGH-1)
//   [교체] 4명이 찬 무료 계정에서 사람이 다섯 번째를 연결하면 오류 대신 가장 오래 대화하지 않은 에이전트를 멈추고 연결, 교체 안내(MEDIUM-1)
//   [사람 우선] 사람이 고른 에이전트는 자동 재개 순위에서 '지금 대화한 것'으로 센다(LOW-3) · [경합] sweep과 사람 연결이 겹쳐도 4명(LOW-1)
//   [심박 분리] 심박은 재개를 직접 돌리지 않고 신호만 — 재개는 msgr_free_resume() 따로, 재개가 깨져도 심박은 성공(LOW-6)
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
/** 새 앱 심박(버전 실음) — 같은 트랜잭션에서 쓰기가 있었는지를 함께 돌려준다. 심박이 재개 신호(resume)를 주면 게이트웨이처럼 msgr_free_resume()을 따로 부른다 */
const beatV = (uid, dev, crewIds, ver = NEW) => {
  const [res, txid] = last(asUser(uid, `select coalesce(x.r::text, '{}') || '|' || coalesce(txid_current_if_assigned()::text, 'none') from (select public.msgr_device_beat('${WS}', '${dev}', ${arr(crewIds)}, ${ver === null ? 'null' : q(ver)}) r offset 0) x`)).split('|');
  if (JSON.parse(res || '{}').resume) asUser(uid, 'select public.msgr_free_resume()');
  return txid !== 'none';
};
const swapNotes = (uid, crewIds) => last(asUser(uid, `select coalesce(string_agg(victim_name, ',' order by victim_name), '') from public.msgr_agent_swap_notes(${arr(crewIds)})`));
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
  assert.deepEqual(reason(U.f), { paused: 6, active: 0, limit: 4, reason: 'app', min_app: NEW });
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
  assert.deepEqual(reason(U.f), { paused: 2, active: 4, limit: 4, reason: 'limit', min_app: NEW });
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

test('[교체] 4명이 찬 무료 계정에서 사람이 누른 다섯 번째 연결은 가장 오래 대화하지 않은 에이전트를 멈추고 연결(채널 참여 보존) + 교체 안내, 미러 insert는 조용히 paused, 같은 에이전트 새 행은 세지 않는다', { skip }, () => {
  sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${CHF}', 'crew', '${F.f1}') on conflict do nothing`);
  asUser(U.f, `update public.msgr_crews set status = 'active' where id = '${F.f7}'`); // 메신저 파견(available→active)
  assert.equal(statusOf(F.f7), 'active', '오류 대신 연결');
  assert.equal(statusOf(F.f1), 'paused', 'f1 = 연결된 넷(f1·f2·f3·f5) 중 가장 오래 대화하지 않은 에이전트');
  assert.equal(sql(`select count(*) from public.msgr_channel_members where member_kind = 'crew' and member_id = '${F.f1}'`), '1', '교체는 해제가 아니다 — 채널 참여 그대로');
  assert.equal(swapNotes(U.f, [F.f7]), 'f1', '교체 안내 — 무엇을 쉬게 했는지');
  assert.equal(swapNotes(U.b, [F.f7]), '', '남의 에이전트 교체 안내는 못 본다');
  assert.equal(sql(`select count(*) from public.msgr_crew_pauses where crew_id = '${F.f1}' and resumed_at is null`), '1', '멈춤 기록');
  const n = last(asUser(U.f, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${OF}', '${U.f}', '${WS}', 'f8', 'f8', 'local', 'active', 'all') returning id`));
  F.f8 = n; assert.equal(statusOf(n), 'paused', '미러 insert(옛·새 앱 모두 active로 넣는다) — 사람의 연결이 아니라 교체하지 않고 paused');
  const p3 = last(asUser(U.f, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${U.f}', '${WS}', 'f3', 'f3', 'local', 'active', 'owner') returning id`));
  F.f3p = p3; assert.equal(statusOf(p3), 'active', 'f3은 이미 연결된 에이전트 — 개인 행이 늘어도 한 명');
  asUser(U.f, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${OF}', '${U.f}', '${WS}', 'f7', 'f7', 'local', 'active', 'all')
    on conflict (org_id, owner_user_id, ws_id, slug) do update set status = excluded.status`);
  assert.equal(statusOf(F.f7), 'active', '이미 연결된 행의 업서트는 그대로');
  assert.equal(slugsOf(U.f, 'active'), 'f2,f3,f5,f7');
});

test('[사람 선택]·[직접 연결 재개] 해제로 생긴 빈자리는 sweep이 채우지 않고, 사람이 고른 멈춘 에이전트는 재개 처리(커서 끝·기록 닫기·자동화 다음 시각)로 연결, 넘으면 교체', { skip }, () => {
  asUser(U.f, `update public.msgr_crews set status = 'available' where id = '${F.f5}'`);
  sweep(); sweep(U.f);
  assert.equal(slugsOf(U.f, 'active'), 'f2,f3,f7', '사람이 비운 자리를 다른 에이전트로 채우지 않는다');
  // 멈춘 동안 f6에게 온 글 + 지난 예정 시각의 자동화 + 줄 선 실행 — 직접 연결도 재개처럼 처리해야 한다(검수 HIGH-1)
  for (let i = 0; i < 3; i++) asUser(U.f, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${CHF}', 'user', '${U.f}', 'text', '멈춘 동안 ${i}', jsonb_build_array(jsonb_build_object('kind','crew','id','${F.f6}')), gen_random_uuid()::text)`);
  const auto = last(sql(`insert into public.msgr_automations (org_id, channel_id, crew_id, created_by, title, prompt, schedule, next_run_at) values ('${OF}', '${CHF}', '${F.f6}', '${U.f}', 't', 'p', '{"kind":"interval","minutes":60,"timezone":"Asia/Seoul"}', now() - interval '3 hours') returning id`));
  const qm = topMsg();
  const run = last(sql(`insert into public.msgr_automation_runs (automation_id, scheduled_for, trigger, status, message_id) values ('${auto}', now() - interval '2 hours', 'schedule', 'queued', ${qm}) returning id`));
  const top = topMsg();
  asUser(U.f, `update public.msgr_crews set status = 'active' where id = '${F.f6}'`); // 설정 카드 activate와 같은 쓰기
  assert.equal(statusOf(F.f6), 'active');
  assert.ok(cursorOf(F.f6) >= top, `직접 연결도 커서를 끝으로 — ${cursorOf(F.f6)} ≥ ${top}`);
  assert.equal(sql(`select (resumed_at is not null) || ':' || (resume_after >= ${top}) from public.msgr_crew_pauses where crew_id = '${F.f6}'`), 'true:true', '중지 기록 닫기');
  assert.equal(sql(`select next_run_at > now() from public.msgr_automations where id = '${auto}'`), 't', '지난 예정 시각은 다음 시각으로');
  assert.equal(sql(`select status || ':' || error from public.msgr_automation_runs where id = '${run}'`), 'blocked:paused', '멈추기 전 줄 선 실행은 닫는다');
  // 넘으면 교체 — 사람이 방금 고른 f6·f7은 '지금 대화한 것'으로 세므로 f2(마지막 실행이 가장 오래)가 쉰다
  asUser(U.f, `update public.msgr_crews set status = 'active' where id = '${F.f4}'`);
  assert.equal(statusOf(F.f4), 'active');
  assert.equal(slugsOf(U.f, 'active'), 'f3,f4,f6,f7');
  assert.equal(statusOf(F.f2p), 'paused', '교체는 그 에이전트의 모든 행');
  assert.equal(swapNotes(U.f, [F.f4]), 'f2');
  assert.equal(reason(U.f).reason, 'limit');
  sweep();
  assert.equal(slugsOf(U.f, 'active'), 'f3,f4,f6,f7', '크론이 사람의 교체를 되돌리지 않는다');
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
  sweep(); assert.equal(slugsOf(U.f, 'active'), 'f3,f4,f6,f7', '30분 안은 그대로(잠깐 잠자기·재시작)');
  sql(`update public.msgr_device_beats set app_seen_at = now() - interval '31 minutes', seen_at = now() - interval '31 minutes' where owner_user_id = '${U.f}'`);
  const r = sweep(); assert.equal(r.failed, 0);
  assert.deepEqual(ids(U.f, 'active'), []);
  assert.deepEqual(reason(U.f), { paused: 7, active: 0, limit: 4, reason: 'off', min_app: NEW }); // f1·f2·f3·f4·f6·f7·f8(f5는 사람이 해제) — f2·f3은 개인·조직 두 행이어도 한 명
  const top = topMsg();
  assert.ok(beatV(U.f, 'mac', ids(U.f, 'paused')));
  assert.equal(slugsOf(U.f, 'active'), 'f3,f4,f6,f7', '[사람 우선] 사람이 고른 f4·f6·f7이 먼저, 그다음 마지막 실행이 가장 최근인 f3 — f5는 사람이 해제한 그대로');
  assert.ok(cursorOf(F.f6) >= top);
});

test('[새+옛 앱] 다른 기기의 옛 앱 심박은 판정에 들지 않는다 — 맥(새 앱)이 꺼지면 VPS(옛 CLI)가 돌고 있어도 멈춘다', { skip }, () => {
  sql(`update public.msgr_device_beats set seen_at = now() where device_id = 'vps-old'`);
  beatOld(U.f, 'vps-old', ids(U.f, 'active'));
  sweep(); assert.equal(slugsOf(U.f, 'active'), 'f3,f4,f6,f7', '맥이 켜져 있는 동안은 연결');
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
  assert.equal(slugsOf(U.f, 'active'), 'f3,f4,f6,f7', '틀린 설정 값은 기본값(0.1.102)으로');
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
  assert.equal(statusOf(F.f5), 'available', '사람이 해제한 것은 그대로'); assert.equal(statusOf(F.f1), 'active', '교체로 쉬던 것도 재개');
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

// ── 검수 #945 반영 ──
import { spawn } from 'node:child_process';
const psqlAsync = (body) => new Promise((res) => { const p = spawn('psql', [DB, '-X', '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t', '-c', body]); let err = ''; p.stderr.on('data', (d) => { err += d; }); p.on('close', (code) => res({ code, err })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const G = 'c4444444-4444-4444-8444-444444444444', P = 'd5555555-5555-4555-8555-555555555555', K = 'e6666666-6666-4666-8666-666666666666';
const insOff = (uid, org, slug, status = 'active') => last(off(`insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (${org ? `'${org}'` : 'null'}, '${uid}', '${WS}', '${slug}', '${slug}', 'local', '${status}', 'all') returning id`));

test('[직접 연결 재개] Pro 계정도 — 멈춘 행을 사람이 직접 active로 올리면 같은 재개 처리(크론을 기다리지 않은 결제 직후 등)', { skip }, () => {
  sql(`insert into auth.users (id, created_at, email) values ('${P}', now() - interval '30 days', 'p@example.test') on conflict do nothing`);
  sql(`insert into public.entitlements (user_id, plan) values ('${P}', 'pro')`);
  const crew = insOff(P, null, 'p1', 'paused'); // 무료일 때 멈춘 행이 남은 Pro(조직 좌석이 생긴 뒤 크론 전 등)
  assert.equal(sql(`select count(*) from public.msgr_crew_pauses where crew_id = '${crew}' and resumed_at is null`), '1');
  const top = topMsg();
  asUser(P, `update public.msgr_crews set status = 'active' where id = '${crew}'`);
  assert.equal(statusOf(crew), 'active');
  assert.ok(cursorOf(crew) >= top);
  assert.equal(sql(`select resumed_at is not null from public.msgr_crew_pauses where crew_id = '${crew}'`), 't');
});

test('[경합] 크론 sweep(전부 멈춤 → 4명 재개)과 사람의 연결이 겹쳐도 연결된 에이전트는 4명 — 같은 주인 잠금', { skip }, async () => {
  sql(`insert into auth.users (id, created_at, email) values ('${G}', now() - interval '30 days', 'g@example.test') on conflict do nothing`);
  const g = ['g1', 'g2', 'g3', 'g4'].map((sl) => insOff(G, null, sl, 'paused'));
  const g5 = insOff(G, null, 'g5', 'available');
  sql(`insert into public.msgr_device_beats (owner_user_id, ws_id, device_id, slugs, app_version, app_seen_at) values ('${G}', '${WS}', 'g-mac', array['g1'], '${NEW}', now())`);
  await Promise.all([psqlAsync(`begin; select public.msgr_crews_plan_sweep(null); select pg_sleep(2); commit;`),
    sleep(700).then(() => psqlAsync(`set role authenticated; select set_config('argo.uid', '${G}', false); update public.msgr_crews set status = 'active' where id = '${g5}'`))]);
  assert.equal(Number(sql(`select count(distinct slug) from public.msgr_crews where owner_user_id = '${G}' and status = 'active'`)), 4, '사람의 연결이 sweep 뒤로 줄 서서 교체로 들어간다');
  assert.equal(statusOf(g5), 'active', '사람이 고른 에이전트가 들어간다');
  sweep();
  assert.equal(statusOf(g5), 'active', '다음 크론도 사람의 선택을 되돌리지 않는다');
  assert.equal(g.filter((id) => statusOf(id) === 'paused').length, 1);
});

test('[심박 분리] 심박은 재개를 직접 돌리지 않고 신호(resume)만 — 재개는 msgr_free_resume() 따로, 재개가 깨져도 심박은 성공', { skip }, () => {
  sql(`insert into auth.users (id, created_at, email) values ('${K}', now() - interval '30 days', 'k@example.test') on conflict do nothing`);
  const k = ['k1', 'k2'].map((sl) => last(asUser(K, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${K}', '${WS}', '${sl}', '${sl}', 'local', 'active', 'owner') returning id`)));
  assert.deepEqual(k.map(statusOf), ['paused', 'paused'], '새 앱 심박 전');
  const r = JSON.parse(last(asUser(K, `select public.msgr_device_beat('${WS}', 'k-mac', ${arr(k)}, '${NEW}')`)));
  assert.deepEqual(r, { resume: true }, '처음 들어온 새 앱 심박 = 재개 신호');
  assert.deepEqual(k.map(statusOf), ['paused', 'paused'], '심박 함수는 재개를 돌리지 않는다');
  assert.equal(JSON.parse(last(asUser(K, `select public.msgr_device_beat('${WS}', 'k-mac', ${arr(k)}, '${NEW}')`))).resume ?? false, false, '이미 새 앱 판정이면 신호 없음');
  assert.equal(JSON.parse(last(asUser(K, 'select public.msgr_free_resume()'))).resumed, 2);
  assert.deepEqual(k.map(statusOf), ['active', 'active']);
  assert.equal(JSON.parse(last(asUser(K, 'select public.msgr_free_resume()'))).resumed ?? 0, 0, '할 일이 없으면 쓰기 없음');
  // 재개(sweep)가 깨진 서버에서도 심박은 성공한다
  sql(`update public.msgr_device_beats set app_seen_at = now() - interval '31 minutes' where owner_user_id = '${K}'`); sweep(K);
  sql(`alter function public.msgr_crews_plan_sweep(uuid) rename to msgr_crews_plan_sweep_saved`);
  try {
    assert.deepEqual(JSON.parse(last(asUser(K, `select public.msgr_device_beat('${WS}', 'k-mac', ${arr(k)}, '${NEW}')`))), { resume: true });
    assert.notEqual(asUserRaw(K, 'select public.msgr_free_resume()').status, 0, '재개만 실패');
  } finally { sql(`alter function public.msgr_crews_plan_sweep_saved(uuid) rename to msgr_crews_plan_sweep`); }
  assert.ok(Number(sql(`select extract(epoch from now() - app_seen_at)::int from public.msgr_device_beats where owner_user_id = '${K}'`)) <= 2, '심박 기록은 남았다');
  fails(psqlRaw(['-A', '-t', '-c', 'set role anon; select public.msgr_free_resume()']), /permission denied/, '익명 재개');
});

// ── 보안 점검(커밋 자동 점검 'authorization' 1건, 10/11) — 남의 것을 건드리는 길이 없는지 ──
const M = 'f7777777-7777-4777-8777-777777777777';
test('[보안 ②] 남의 회사·남의 에이전트 id로 심박을 보내도 남의 기기 행·판정·상태는 그대로 — 버전은 내 기기 행에만 쓰인다', { skip }, () => {
  sql(`update public.msgr_device_beats set app_seen_at = now() - interval '31 minutes' where owner_user_id = '${U.h}'`); sweep(U.h);
  const before = sql(`select string_agg(device_id || ':' || xmin::text, ',' order by device_id) from public.msgr_device_beats where owner_user_id = '${U.h}'`);
  const hStatus = sql(`select string_agg(id::text || ':' || status, ',' order by id) from public.msgr_crews where owner_user_id = '${U.h}'`);
  const hIds = ids(U.h, 'paused');
  const r = JSON.parse(last(asUser(K, `select public.msgr_device_beat('${WS}', 'atk', ${arr(hIds)}, '9.9.9')`)));
  assert.deepEqual(r, {}, '남의 행으로는 재개 신호도 없다');
  assert.equal(sql(`select count(*) from public.msgr_device_beats where device_id = 'atk'`), '0', '내 행이 없는 목록이면 기기 행도 만들지 않는다');
  asUser(K, 'select public.msgr_free_resume()');
  assert.equal(sql(`select string_agg(device_id || ':' || xmin::text, ',' order by device_id) from public.msgr_device_beats where owner_user_id = '${U.h}'`), before);
  assert.equal(sql(`select string_agg(id::text || ':' || status, ',' order by id) from public.msgr_crews where owner_user_id = '${U.h}'`), hStatus);
  assert.equal(reason(U.h).reason, 'off', '남의 심박으로 새 앱 판정이 되지 않는다');
});

test('[보안 ③④] 조직 관리자가 남(무료)의 에이전트를 연결해도 한도를 넘지 못하고 교체도 일어나지 않는다 — 멈춘 행은 주인·서버만 재개, 교체는 언제나 같은 주인의 에이전트', { skip }, () => {
  sql(`insert into auth.users (id, created_at, email) values ('${M}', now() - interval '30 days', 'm@example.test') on conflict do nothing`);
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${OF}'`);
  const code = last(asUser(U.f, `insert into public.msgr_invites (org_id, role, created_by) values ('${OF}', 'member', '${U.f}') returning code`));
  asUser(M, `select public.msgr_accept_invite('${code}')`);
  const m = {}; for (const sl of ['m1', 'm2', 'm3', 'm4']) m[sl] = insOff(M, OF, sl, 'active');
  m.m5 = insOff(M, OF, 'm5', 'available'); m.m6 = insOff(M, OF, 'm6', 'paused');
  sql(`insert into public.msgr_device_beats (owner_user_id, ws_id, device_id, slugs, app_version, app_seen_at) values ('${M}', '${WS}', 'm-mac', array['m1'], '${NEW}', now())`);
  const fActive = slugsOf(U.f, 'active');
  // 관리자(f — 조직 주인)가 4명이 찬 M의 에이전트를 연결: 교체 없이 한도 오류
  fails(asUserRaw(U.f, `update public.msgr_crews set status = 'active' where id = '${m.m5}'`), /msgr_free_agent_limit/, '관리자의 다섯 번째 연결');
  assert.equal(slugsOf(M, 'active'), 'm1,m2,m3,m4', '관리자 행동으로 주인의 에이전트가 멈추지 않는다');
  // 관리자의 paused→active: 주인·서버만 재개 — 조용히 그대로(커서·기록 손대지 않음)
  const cur6 = cursorOf(m.m6);
  asUser(U.f, `update public.msgr_crews set status = 'active' where id = '${m.m6}'`);
  assert.equal(statusOf(m.m6), 'paused'); assert.equal(cursorOf(m.m6), cur6);
  assert.equal(sql(`select count(*) from public.msgr_free_choices where owner_user_id = '${M}'`), '0', '관리자 행동은 주인의 선택으로 기록되지 않는다');
  // 자리가 나면 관리자 연결은 한도 안에서 허용(교체·선택 기록 없이)
  asUser(M, `update public.msgr_crews set status = 'available' where id = '${m.m4}'`);
  asUser(U.f, `update public.msgr_crews set status = 'active' where id = '${m.m6}'`); // 자리가 있어도 관리자는 멈춘 행을 재개하지 못한다(오류 없이 그대로)
  assert.equal(statusOf(m.m6), 'paused'); assert.equal(cursorOf(m.m6), cur6);
  asUser(U.f, `update public.msgr_crews set status = 'active' where id = '${m.m5}'`);
  assert.equal(statusOf(m.m5), 'active');
  assert.equal(sql(`select count(*) from public.msgr_free_choices where owner_user_id = '${M}'`), '0');
  // 주인이 고른 다섯 번째 → 교체 대상은 M의 에이전트만, 관리자(f)의 에이전트는 그대로
  asUser(M, `update public.msgr_crews set status = 'active' where id = '${m.m6}'`);
  assert.equal(statusOf(m.m6), 'active');
  assert.equal(Number(sql(`select count(distinct slug) from public.msgr_crews where owner_user_id = '${M}' and status = 'active'`)), 4);
  assert.equal(sql(`select v.owner_user_id from public.msgr_free_choices ch join public.msgr_crews v on v.id = ch.swapped_out where ch.crew_id = '${m.m6}'`), M, '교체 대상은 같은 주인');
  assert.equal(slugsOf(U.f, 'active'), fActive, '다른 주인의 에이전트는 그대로');
  assert.equal(swapNotes(U.f, [m.m6]), '', '교체 안내는 주인에게만');
});

test('[보안 ⑤①] 이유 조회는 내 것만, 교체 기록 표는 직접 못 읽고, 새 정의자 함수는 search_path 고정 + 클라이언트가 못 부르는 내부 함수', { skip }, () => {
  const mine = reason(K); const theirs = reason(M);
  assert.notDeepEqual(mine, theirs);
  assert.deepEqual(Object.keys(mine).sort(), ['active', 'limit', 'min_app', 'paused', 'reason'], '목록·이름·남의 id 없이 수와 이유만');
  fails(asUserRaw(M, 'select * from public.msgr_free_choices'), /permission denied/, '교체 기록 표 직접 읽기');
  fails(asUserRaw(M, `insert into public.msgr_free_choices (crew_id, owner_user_id) values ('${F.f1}', '${M}')`), /permission denied/, '교체 기록 표 직접 쓰기');
  for (const call of [`public._msgr_crew_resume_side('${F.f1}', 0)`, `public._msgr_crew_plan_resume('${F.f1}', 0)`, `public.msgr_crews_plan_sweep('${U.f}')`, `public._msgr_free_active_agents('${U.f}')`, `public._msgr_free_app_ok('${U.f}')`])
    fails(asUserRaw(M, `select ${call}`), /permission denied/, call);
  const bad = sql(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('msgr_device_beat','msgr_free_resume','msgr_my_agent_pause','msgr_agent_swap_notes','msgr_crews_pro_gate','msgr_crews_resume_side',
      '_msgr_crew_resume_side','_msgr_crew_plan_resume','msgr_crews_plan_sweep','_msgr_free_app_ok','_msgr_free_active_agents','_msgr_free_agent_policy')
      and not (p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))`);
  assert.equal(bad, '', '정의자 + search_path 고정이 아닌 함수');
  for (const fn of ['msgr_device_beat(text,text,uuid[],text)', 'msgr_free_resume()', 'msgr_my_agent_pause()', 'msgr_agent_swap_notes(uuid[])'])
    assert.equal(sql(`select has_function_privilege('anon', 'public.${fn}', 'EXECUTE')`), 'f', `anon ${fn}`);
});
