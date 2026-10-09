// 능동 비서 3단계 — 방에서 복구 읽기 셋(src/gateway/msgr.mjs makeDb personalCrewsOf·personalRoomsOf·assistantNotices)과 src/assistant/recover.mjs를
// 실제 Postgres(마이그레이션 그대로 — RLS·트리거·유니크 인덱스)에 돌린다. supabase-js 대신 makeDb가 부르는 모양만 흉내 내는 작은 클라이언트(pgClient)를
// 그 사용자 권한(set role authenticated + argo.uid)으로 psql에 보낸다 — msgr-personal-room-body-pg.test.mjs와 같은 하네스.
// 경우 표: R9(주인만 읽힌다·방 찾기는 방을 만들지 않는다·'as:' 글만), R10(같은 방의 같은 client_msg_id는 23505 → insertMessage null — 다른 방은 들어간다),
// V4(0.1.99 엔진이 쓴 글 모양이 복구된다).
// 실행: bash scripts/billing-pg-drill.sh test/assistant-recover-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { psqlSpawn } from './helpers/pg.mjs';
import { mkdtemp } from './helpers/tmp.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/assistant-recover-pg.test.mjs';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-asst-recover-pg-'));
const M = await import('../src/gateway/msgr.mjs');
const { readRoomNotices, foldNotices } = await import('../src/assistant/recover.mjs');
const { clientMsgId } = await import('../src/assistant/deliver.mjs');

const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222' };
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';

/* ── makeDb가 부르는 supabase-js 모양만 흉내 내는 클라이언트(그 사용자 권한으로 psql) ── */
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const lit = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : typeof v === 'object' ? `${q(JSON.stringify(v))}::jsonb` : q(v));
const ident = (k) => { if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error(`흉내 클라이언트가 모르는 열: ${k}`); return k; };
function runAs(uid, text) {
  const r = psqlRaw(['-v', 'VERBOSITY=verbose', '-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${text}`]);
  if (r.status !== 0) { const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(r.stderr); return { data: null, error: { code: m?.[1] ?? 'XX000', message: m?.[2] ?? r.stderr.trim() } }; }
  return { data: JSON.parse(last(r.stdout) || 'null'), error: null };
}
function pgClient(uid) {
  const from = (table) => {
    const s = { op: 'select', cols: '*', ret: null, where: [], mode: 'many', limit: null, order: null };
    const b = {
      select(cols = '*') { if (s.op === 'select') s.cols = cols; else s.ret = cols; return b; },
      insert(row) { s.op = 'insert'; s.row = row; return b; },
      eq(k, v) { s.where.push(`${ident(k)} = ${lit(v)}`); return b; },
      is(k, v) { s.where.push(`${ident(k)} is ${v === null ? 'null' : String(v)}`); return b; },
      in(k, vs) { s.where.push(vs.length ? `${ident(k)} in (${vs.map(lit).join(', ')})` : 'false'); return b; },
      like(k, v) { s.where.push(`${ident(k)} like ${lit(v)}`); return b; },
      gte(k, v) { s.where.push(`${ident(k)} >= ${lit(v)}`); return b; },
      order(k, { ascending = true } = {}) { s.order = `${ident(k)} ${ascending ? 'asc' : 'desc'}`; return b; },
      limit(n) { s.limit = n; return b; },
      single() { s.mode = 'single'; return b; },
      then(res, rej) { return Promise.resolve().then(() => exec()).then(res, rej); },
    };
    const where = () => (s.where.length ? ` where ${s.where.join(' and ')}` : '');
    const exec = () => {
      const t = `public.${ident(table)}`;
      let text;
      if (s.op === 'select') text = `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select ${s.cols} from ${t}${where()}${s.order ? ` order by ${s.order}` : ''}${s.limit ? ` limit ${s.limit}` : ''}) x`;
      else {
        const cols = Object.keys(s.row).map(ident);
        text = `with w as (insert into ${t} (${cols.join(', ')}) select ${cols.join(', ')} from jsonb_populate_record(null::${t}, ${lit(s.row)}) returning *) select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select ${s.ret ?? '*'} from w) x`;
      }
      const r = runAs(uid, text);
      if (r.error) return r;
      if (s.mode === 'single') return r.data.length === 1 ? { data: r.data[0], error: null } : { data: null, error: { code: 'PGRST116', message: `${r.data.length} rows` } };
      return r;
    };
    return b;
  };
  const rpc = async (name, args = {}) => runAs(uid, `select to_jsonb(public.${ident(name)}(${Object.entries(args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(', ')}))`);
  return { from, rpc };
}
const dbAs = (uid) => M.makeDb(pgClient(uid));

const WS1 = 'pg-co1'; const WS2 = 'pg-co2';
let P1, W2, X3, ORGCREW, CH1, CH2;
const key = (id) => `cal:${id}:2026-10-08T05:00:00.000Z:pre`;
const notice = (crew, ch, k, extra = {}) => ({
  channel_id: ch, author_kind: 'crew', crew_id: crew, kind: 'text', reply_to: null, thread_root: null, client_msg_id: clientMsgId(crew, k), body: `[비서] ${k}`, mentions: [],
  meta: { disposition: 'done', notification: 'assistant', assistant: { v: 1, kind: 'pre', keys: [k], items: [{ key: k, source: 'calendar', eventId: 'e', at: '2026-10-08T05:00:00.000Z' }] } }, ...extra,
});

before(async () => {
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
  sql(`delete from public.msgr_settings where key = 'free_limits_grace_until'`);
  const crew = (ws, slug, org = null) => last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (${org ? `'${org}'` : 'null'}, '${U.a}', '${ws}', '${slug}', '${slug}', 'local', 'active', 'owner') returning id`));
  P1 = crew(WS1, 'pepper'); W2 = crew(WS2, 'wolff'); X3 = crew(WS1, 'kim');
  const org = last(asUser(U.a, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.a}') returning id`));
  ORGCREW = crew(WS1, 'pepper', org); // 같은 slug의 조직 행 — 복구는 개인 행만 읽는다
  CH1 = last(asUser(U.a, `select public.msgr_dm_personal_crew('${P1}')`));
  CH2 = last(asUser(U.a, `select public.msgr_dm_personal_crew('${W2}')`));
});

test('R10: 비서 글 넣기 — 같은 방의 같은 client_msg_id는 23505 → insertMessage null(성공으로 본다), 다른 방(다른 크루)이면 들어간다(두 방 중복은 DB가 막지 못한다 — 방에서 복구가 막는다)', { skip }, async () => {
  const db = dbAs(U.a);
  assert.ok(await db.insertMessage(notice(P1, CH1, key('e1'))), '첫 글');
  assert.equal(await db.insertMessage(notice(P1, CH1, key('e1'))), null, '같은 방·같은 id = 23505 → null');
  assert.ok(await db.insertMessage(notice(W2, CH2, key('e1'))), '다른 방은 같은 키라도 들어간다');
  // 복구가 읽지 않아야 할 글: 같은 방의 보통 답글(접두 reply:)·사람 글
  assert.ok(await db.insertMessage({ ...notice(P1, CH1, 'x'), client_msg_id: `reply:${P1}:1`, meta: { disposition: 'done' } }));
  assert.ok(last(asUser(U.a, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${CH1}', 'user', '${U.a}', 'text', '안녕', '[]'::jsonb, gen_random_uuid()::text) returning id`)));
});

test('R9: 방에서 복구 읽기 — 주인은 자기 개인 크루 행·이미 있는 방·비서(as:) 글만 읽고, 방 찾기는 방을 만들지 않는다(쓰기 0). 다른 사람은 0행', { skip }, async () => {
  const db = dbAs(U.a);
  const crews = await db.personalCrewsOf(U.a, [WS1, WS2]);
  assert.deepEqual(crews.map((r) => `${r.ws_id}/${r.slug}`).sort(), [`${WS1}/kim`, `${WS1}/pepper`, `${WS2}/wolff`], '개인 행만(조직 행 제외)');
  const channelsBefore = sql('select count(*) from public.msgr_channels');
  const rooms = await db.personalRoomsOf([P1, W2, X3]);
  assert.deepEqual(rooms.map((r) => r.id).sort(), [CH1, CH2].sort(), '방이 없는 크루(kim)는 빈칸 — 만들지 않는다');
  assert.equal(sql('select count(*) from public.msgr_channels'), channelsBefore, '방 찾기는 쓰기 0');
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const rows = await db.assistantNotices(CH1, P1, since, 300);
  assert.equal(rows.length, 1, `방 1의 as: 글 1건만(보통 답글·사람 글 제외): ${JSON.stringify(rows.map((r) => r.meta))}`);
  assert.ok(rows.every((r) => r.meta?.notification === 'assistant' && Array.isArray(r.meta.assistant?.keys) && r.created_at));
  assert.equal((await db.assistantNotices(CH2, W2, since, 300)).length, 1, '방 2의 as: 글');
  assert.equal((await db.assistantNotices(CH1, W2, since, 300)).length, 0, '그 방의 그 크루 글만');
  assert.ok(await db.insertMessage(notice(P1, CH1, key('e2'))));
  const two = await db.assistantNotices(CH1, P1, since, 300);
  assert.ok(two.length === 2 && two[0].id > two[1].id, '새 글부터');
  assert.equal((await db.assistantNotices(CH1, P1, since, 1)).length, 1, 'limit');
  assert.equal((await db.assistantNotices(CH1, P1, new Date(Date.now() + 60_000).toISOString(), 300)).length, 0, 'since 뒤만');
  // 다른 사람(b) — a의 행·방·글을 읽지 못한다(RLS)
  const dbB = dbAs(U.b);
  assert.deepEqual(await dbB.personalCrewsOf(U.a, [WS1, WS2]), []);
  assert.deepEqual(await dbB.personalRoomsOf([P1, W2]), []);
  assert.deepEqual(await dbB.assistantNotices(CH1, P1, since, 300), []);
  assert.deepEqual(await dbB.assistantNotices(CH2, W2, since, 300), []);
});

test('V4·R9: 엔진의 복구 읽기 그대로(readRoomNotices → foldNotices) — 지금 비서(회사 2 울프)와 꺼진 이전 비서(회사 1 페퍼)의 방을 합쳐 보낸 키를 얻는다', { skip }, async () => {
  const c = { uid: U.a, db: dbAs(U.a) };
  const now = Date.now();
  const rows = await readRoomNotices(c, [{ ws: WS2, agent: 'wolff' }, { ws: WS1, agent: 'pepper' }, { ws: WS1, agent: 'kim' }], now - 14 * 86_400_000); // 처음 복구 = 14일
  const rec = foldNotices(rows, { now, tz: 'Asia/Seoul' });
  assert.deepEqual(Object.keys(rec.sent).sort(), [key('e1'), key('e2')], '두 방의 같은 키(e1)는 합집합 1개');
  assert.equal(rec.instant, 2, '오늘 시작 전 알림 수는 키로 센다(두 방에 같은 e1이 있어도 1)');
});
