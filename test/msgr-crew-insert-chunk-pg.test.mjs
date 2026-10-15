// 조직 파견 insert 조각의 근거 측정(2026-10-15) — 실제 msgr_crews 트리거 전부(무료 관문·소유자 관문·에이전트 연결·멈춤 기록)를 태운 한 문장 insert의 행당 시간.
// 운영 실측: 행당 약 28ms, 353행 한 묶음이 authenticated statement_timeout 8초를 넘어 57014(PostgREST 500). 여기서는 운영과 같은 8초 제한으로
//   ① 400행 한 문장 ② 50행 조각 8번을 재고, ③ 제한을 넘는 문장이 57014로 끝나는 것(게이트웨이가 일시 오류로 분류하던 코드)을 확인한다.
// 로컬 기계·표 크기가 운영과 달라 행당 시간은 운영보다 작게 나올 수 있다 — 결과 줄([measure])을 그대로 PR에 옮긴다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr-crew-insert-chunk-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-crew-insert-chunk-pg.test.mjs';
const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
// f = 무료(조직 OF 주인, 에이전트 6명), b = 결제 Pro(조직 OB 주인, 6명 — 해지 경로), h = 무료 새 가입자(개인 공간만)
const U = { f: 'f1111111-1111-4111-8111-111111111111' };
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

let OF;
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
  OF = last(asUser(U.f, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Free', 'free', '${U.f}') returning id`));
  beatV(U.f, 'mac', []); // 새 앱이 켜진 무료 계정 — 운영의 그 계정과 같은 관문 경로(_msgr_free_app_ok = true, 주인 잠금·한도 셈)
});

const rowsSql = (from, n) => Array.from({ length: n }, (_, i) => `('${OF}', '${U.f}', '${WS}', 'a${String(from + i).padStart(4, '0')}', '에이전트', null, 'local', 'active', 'owner', '{}'::uuid[])`).join(',');
/** 게이트웨이 upsertAvailable과 같은 문장(PostgREST on_conflict 업서트) — 운영과 같은 8초 제한, 걸린 시간(ms)과 SQLSTATE */
function upsert(from, n, timeout = '8s') {
  const t0 = performance.now();
  const r = asUserRaw(U.f, `set statement_timeout = '${timeout}'; insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, role_text, hosting, status, allow, allow_users) values ${rowsSql(from, n)}
    on conflict (org_id, owner_user_id, ws_id, slug) do update set display_name = excluded.display_name returning id`);
  return { ms: Math.round(performance.now() - t0), ok: r.status === 0, err: (r.stderr.match(/ERROR:\s+([^\n]+)/) ?? [])[1] ?? '' };
}

test('[측정] 400행 한 문장 vs 50행 조각 8번 — 운영과 같은 8초 제한', { skip }, () => {
  const big = upsert(0, 400);
  const chunks = []; for (let i = 0; i < 8; i++) chunks.push(upsert(1000 + i * 50, 50));
  const perRow = big.ms / 400;
  console.log(`[measure] 400행 한 문장: ${big.ms}ms ok=${big.ok} ${big.err} | 행당 ${perRow.toFixed(1)}ms`);
  console.log(`[measure] 50행 조각 8번: ${chunks.map((c) => c.ms).join(', ')}ms (최대 ${Math.max(...chunks.map((c) => c.ms))}ms) 모두 ok=${chunks.every((c) => c.ok)}`);
  console.log(`[measure] 운영 행당 28ms로 환산: 400행 ≈ ${(400 * 28 / 1000).toFixed(1)}초, 50행 ≈ ${(50 * 28 / 1000).toFixed(1)}초 (제한 8초)`);
  assert.ok(chunks.every((c) => c.ok), '50행 조각은 8초 안에 끝난다');
  assert.equal(Number(sql(`select count(*) from public.msgr_crews where owner_user_id = '${U.f}' and slug >= 'a1000'`)), 400);
  assert.equal(sql(`select string_agg(distinct status, ',') from public.msgr_crews where owner_user_id = '${U.f}' and org_id = '${OF}'`), 'paused', '무료 계정 미러 insert는 조용히 paused(운영과 같은 관문 경로를 탔다)');
});

test('[57014] 제한을 넘는 같은 문장은 57014로 끝나고 행이 남지 않는다 — 게이트웨이가 일시 오류로 보고 틱마다 다시 보내던 코드', { skip }, () => {
  const before = Number(sql(`select count(*) from public.msgr_crews where owner_user_id = '${U.f}'`));
  const r = upsert(5000, 400, '50ms');
  const code = psqlRaw(['-v', 'VERBOSITY=verbose', '-A', '-t', '-c', `set role authenticated; set statement_timeout = '50ms'; select pg_sleep(1)`]).stderr.match(/ERROR:\s+(\w{5}):/)?.[1];
  console.log(`[measure] 제한 50ms의 400행 문장: ${r.ms}ms ok=${r.ok} ${r.err} | 시간 초과 SQLSTATE=${code}`);
  assert.equal(r.ok, false); assert.match(r.err, /statement timeout/);
  assert.equal(code, '57014');
  assert.equal(Number(sql(`select count(*) from public.msgr_crews where owner_user_id = '${U.f}'`)), before, '한 문장이라 전부 되돌려진다 — 다음 틱도 같은 353행을 다시 보냈다');
});
