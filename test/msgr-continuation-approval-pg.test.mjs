// 이어 실행 턴의 결재 카드 — 본체 코드(approval-actions·routines·gateway·msgr.mjs) → 표 직접 넣기·개인 RPC → 실제 Postgres 출처 가드 왕복.
// 결함(PR #864 '남은 것'·경우 12): 결재 후속·예약·긴 작업·루프 정지가 올린 결재의 카드 출처는 원래 지시이고 그 지시의 실행은 이미 끝났다(completed).
// 출처 가드(msgr_approval_source_guard)는 실행 중(running)이거나 승인된 부모 결재(payload.followup_of)가 있어야 받아서 카드가 거절되고 결재는 로컬에만 남았다.
// 고친 계약: 이어 실행 턴은 카드에 근거를 싣는다 — payload.continuation(종류) + 결재 후속이면 payload.followup_of(승인된 부모 결재, 봇 선례 20260929150000_1b).
// 가드는 근거가 있을 때만 끝난 원래 글을 받는다(그 에이전트가 그 글을 실제로 실행해 끝냈고, 지금도 그 글을 이어서 할 수 있고, 근거로 들어온 대기 카드가 그 글에 없을 때).
// supabase-js 대신 makeDb가 부르는 모양만 흉내 내는 작은 클라이언트(pgClient)를 그 사용자 권한(set role authenticated + argo.uid)으로 psql에 보낸다 —
// RLS·트리거·정의자 함수는 마이그레이션 그대로 돈다(msgr-personal-room-body-pg.test.mjs와 같은 방식).
// 실행: bash scripts/billing-pg-drill.sh test/msgr-continuation-approval-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { psqlSpawn } from './helpers/pg.mjs';
import { mkdtemp } from './helpers/tmp.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-continuation-approval-pg.test.mjs';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-continuation-approval-pg-'));
const { createCompany, paths } = await import('../src/workspace.mjs');
const chatMod = await import('../src/chat.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');
const approvals = await import('../src/approval-actions.mjs');
const { addRoutine, runRoutine } = await import('../src/routines.mjs');
const gateway = await import('../src/gateway.mjs');
const M = await import('../src/gateway/msgr.mjs');
const { messengerOrigin } = await import('../src/gateway/msgr-handoff.mjs');

const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
// a = 에이전트 주인, b = a의 친구, d = 조직 만든 사람
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', d: '44444444-4444-4444-8444-444444444444' };
const WS = 'cont-pg';
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const post = (uid, ch, body, mentions = '[]') => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', '${mentions}'::jsonb, gen_random_uuid()::text) returning id`));
const execution = (crew, source, state) => sql(`insert into public.msgr_executions (crew_id, source_msg_id, attempt, state) values ('${crew}', ${source}, gen_random_uuid(), '${state}') on conflict (crew_id, source_msg_id) do update set state = '${state}'`);
const tick = () => new Promise((r) => setTimeout(r, 3)); // 예약 id는 밀리초 기반(r<시각>) — 같은 밀리초에 두 개를 만들지 않게

/* ── makeDb가 부르는 supabase-js 모양만 흉내 내는 클라이언트(그 사용자 권한으로 psql) — msgr-personal-room-body-pg.test.mjs와 같은 모양 ── */
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const lit = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : typeof v === 'object' ? `${q(JSON.stringify(v))}::jsonb` : q(v));
const ident = (k) => { if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error(`흉내 클라이언트가 모르는 열: ${k}`); return k; };
function runAs(uid, text) {
  const r = psqlRaw(['-v', 'VERBOSITY=verbose', '-A', '-t', '-c', `set role authenticated; select set_config('argo.uid', '${uid}', false); ${text}`]);
  if (r.status !== 0) { const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(r.stderr); return { data: null, error: { code: m?.[1] ?? 'XX000', message: m?.[2] ?? r.stderr.trim() } }; }
  return { data: JSON.parse(last(r.stdout) || 'null'), error: null };
}
let calls = []; // 본체가 보낸 요청(표·RPC 이름) — 결재 1건당 요청 수를 잰다(DB 위생)
function pgClient(uid) {
  const from = (table) => {
    const s = { op: 'select', cols: '*', ret: null, where: [], mode: 'many', limit: null, order: null };
    const b = {
      select(cols = '*') { if (s.op === 'select') s.cols = cols; else s.ret = cols; return b; },
      insert(row) { s.op = 'insert'; s.row = row; return b; },
      update(patch) { s.op = 'update'; s.row = patch; return b; },
      eq(k, v) { s.where.push(`${ident(k)} = ${lit(v)}`); return b; },
      neq(k, v) { s.where.push(`${ident(k)} <> ${lit(v)}`); return b; },
      is(k, v) { s.where.push(`${ident(k)} is ${v === null ? 'null' : String(v)}`); return b; },
      in(k, vs) { s.where.push(vs.length ? `${ident(k)} in (${vs.map(lit).join(', ')})` : 'false'); return b; },
      lt(k, v) { s.where.push(`${ident(k)} < ${lit(v)}`); return b; },
      gt(k, v) { s.where.push(`${ident(k)} > ${lit(v)}`); return b; },
      order(k, { ascending = true } = {}) { s.order = `${ident(k)} ${ascending ? 'asc' : 'desc'}`; return b; },
      limit(n) { s.limit = n; return b; },
      single() { s.mode = 'single'; return b; },
      maybeSingle() { s.mode = 'maybe'; return b; },
      then(res, rej) { return Promise.resolve().then(() => exec()).then(res, rej); },
    };
    const where = () => (s.where.length ? ` where ${s.where.join(' and ')}` : '');
    const exec = () => {
      calls.push(`${s.op}:${table}`);
      const t = `public.${ident(table)}`;
      let text;
      if (s.op === 'select') text = `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select ${s.cols} from ${t}${where()}${s.order ? ` order by ${s.order}` : ''}${s.limit ? ` limit ${s.limit}` : ''}) x`;
      else {
        const cols = Object.keys(s.row).map(ident);
        const rec = `jsonb_populate_record(null::${t}, ${lit(s.row)})`;
        const body = s.op === 'insert'
          ? `insert into ${t} (${cols.join(', ')}) select ${cols.join(', ')} from ${rec} returning *`
          : `update ${t} set ${cols.map((c) => `${c} = (select ${c} from ${rec})`).join(', ')}${where()} returning *`;
        text = `with w as (${body}) select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select ${s.ret ?? '*'} from w) x`;
      }
      const r = runAs(uid, text);
      if (r.error) return r;
      if (s.mode === 'single') return r.data.length === 1 ? { data: r.data[0], error: null } : { data: null, error: { code: 'PGRST116', message: `${r.data.length} rows` } };
      if (s.mode === 'maybe') return { data: r.data[0] ?? null, error: null };
      return r;
    };
    return b;
  };
  const rpc = async (name, args = {}) => { calls.push(`rpc:${name}`); return runAs(uid, `select to_jsonb(public.${ident(name)}(${Object.entries(args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(', ')}))`); };
  return { from, rpc };
}
const sessionAs = (uid) => { const client = pgClient(uid); const db = M.makeDb(client); return async () => ({ uid, db, client }); };

let ORG, ORG_CREW, ORG_DM, ORG_CH, A1, CH_A1, AB;
// 방 셋 — 조직 1:1(dm), 개인 crew 1:1(dm, org 없음), 조직 채널(private, 인접 핀)
const ROOMS = () => ({
  org: { label: '조직 1:1', ch: ORG_DM, crew: ORG_CREW, org: ORG, kind: 'dm' },
  personal: { label: '개인 crew 1:1', ch: CH_A1, crew: A1, org: null, kind: 'dm' },
  channel: { label: '조직 채널', ch: ORG_CH, crew: ORG_CREW, org: ORG, kind: 'private', mention: true },
});
const sinkTool = (ctx, name) => { const sink = []; chatMod.makeCrewServer(WS, 'alpha', 'alpha', [], 0, [], ctx, 'ko', [], '', sink); return sink.find((t) => t.name === name).handler; };
/** 게이트웨이(run)가 만드는 턴 문맥 — 개인 방의 ownCrewRoom은 실제 서버 판정(어댑터 → msgr_is_own_crew_room) */
async function turnCtx(room, src) {
  const db = M.makeDb(pgClient(U.a));
  const own = room.org ? undefined : await db.ownCrewRoom(room.ch, room.crew);
  return { kind: 'msgr', orgId: room.org, channelId: room.ch, channelKind: room.kind, crewId: room.crew, threadRoot: src, sourceMsgId: src, uid: U.a, wsId: WS, origin: U.a, hop: 0,
    peers: [{ id: room.crew, slug: 'alpha', display_name: '알파', owner_user_id: U.a, ws_id: WS }], handoffs: [], ...(own !== undefined ? { ownCrewRoom: own } : {}) };
}
const say = (room, body) => post(U.a, room.ch, body, room.mention ? `[{"kind":"crew","id":"${room.crew}","role":"to"}]` : '[]');
const serverRow = (apId) => sql(`select concat_ws('|', coalesce(org_id::text, 'NULL'), status, coalesce(source_msg_id::text, 'NULL'), coalesce(message_id::text, 'NULL'), coalesce(payload->>'continuation', '-'), coalesce(payload->>'followup_of', '-')) from public.msgr_crew_approvals where approval_id = '${apId}'`);
const cardOf = (apId, crew) => sql(`select concat_ws('|', kind, reply_to) from public.msgr_messages where client_msg_id = 'ap:${crew}:${apId}'`);
const approvalByAction = async (action) => (await loadApprovals(WS)).find((a) => a.action === action);
/** 원래 지시 — 원래 턴이 결재 하나 없이 끝난 글(예약·긴 작업·루프는 그 턴이 걸어 둔 것). origin = 본체가 저장한 기록 모양 */
async function finishedSource(room, label) {
  const m = say(room, `${label} 원래 지시`);
  execution(room.crew, m, 'running');
  const ctx = await turnCtx(room, m);
  execution(room.crew, m, 'completed');
  return { m, ctx, origin: messengerOrigin(ctx) };
}
/** 이어 실행 턴 안에서 모델이 결재를 하나 올리는 runChat(본체가 보내는 행 모양 그대로 — request_approval 도구) */
const raising = (action, extra = {}) => async (_ws, _slug, _msg, _sid, opts) => {
  await sinkTool(opts.mirrorCtx, 'request_approval')({ action, reason: '필요' });
  return { reply: '결재를 올렸다', sessionId: null, handover: null, ...extra };
};
async function pushCard(item) { calls = []; const r = await M.msgrPush({ type: 'approval', wsId: WS, item }, { session: sessionAs(U.a) }); return { r, calls: [...calls] }; }

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
  for (const uid of [U.a, U.b]) asUser(uid, 'select public.msgr_set_ai_consent(true)'); // 개인 방 동의는 명시적 동의만
  await createCompany(WS, '린', '유건', U.a);
  await mkdir(paths(WS).agents, { recursive: true });
  ORG = last(asUser(U.d, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.d}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  const code = last(asUser(U.d, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.d}') returning code`));
  asUser(U.a, `select public.msgr_accept_invite('${code}')`);
  ORG_CREW = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.a}', '${WS}', 'alpha', '알파', 'local', 'active', 'owner') returning id`));
  ORG_DM = last(asUser(U.a, `select public.msgr_create_channel(org => '${ORG}', kind => 'dm', name => 'dm:알파', others => '[{"kind":"crew","id":"${ORG_CREW}"}]'::jsonb)`));
  ORG_CH = last(asUser(U.a, `select public.msgr_create_channel(org => '${ORG}', kind => 'private', name => '운영', others => '[{"kind":"crew","id":"${ORG_CREW}"}]'::jsonb)`));
  A1 = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${U.a}', '${WS}', 'alpha', '알파', 'local', 'active', 'owner') returning id`));
  CH_A1 = last(asUser(U.a, `select public.msgr_dm_personal_crew('${A1}')`));
  asUser(U.a, `select public.msgr_friend_request('${U.b}')`); asUser(U.b, `select public.msgr_friend_decide('${U.a}', true)`);
  AB = last(asUser(U.a, `select public.msgr_dm_personal('${U.b}')`));
  assert.equal(last(asUser(U.a, `select public.msgr_crew_join('${AB}', '${A1}')`)), 'joined', '친구 1:1에 a의 개인 크루');
});

/* ── 인접 핀(고치기 전 코드에서도 같아야 한다) ── */
test('인접 핀 — 원래 턴이 도는 동안(running)의 결재 카드는 세 방 모두 그대로 들어가고, 근거 표지가 없다', { skip }, async () => {
  for (const room of Object.values(ROOMS())) {
    const m = say(room, `${room.label} 실행 중`); execution(room.crew, m, 'running');
    const ctx = await turnCtx(room, m);
    await sinkTool(ctx, 'request_approval')({ action: `${room.label} 실행 중 결재`, reason: '필요' });
    const item = await approvalByAction(`${room.label} 실행 중 결재`);
    assert.equal(item.msgr.continuation, undefined, `${room.label}: 보통 턴의 기록에는 이어 실행 근거가 없다`);
    const { r } = await pushCard(item);
    assert.equal(r, true, `${room.label}: 카드`);
    assert.equal(serverRow(item.id), `${room.org ?? 'NULL'}|pending|${m}|${(await approvalByAction(item.action)).msgr.messageId}|-|-`, `${room.label}: 출처 = 원래 글, payload 근거 없음`);
    execution(room.crew, m, 'completed');
  }
});

test('인접 핀 — 근거 없는 끝난 글 카드는 지금처럼 거절된다(옛 본체가 보내는 행 모양 · 호출자가 종류를 밝히지 않은 이어 실행)', { skip }, async () => {
  for (const room of [ROOMS().org, ROOMS().personal]) {
    const { m, origin } = await finishedSource(room, `${room.label} 근거 없음`);
    let item = null;
    await M.runMessengerContinuation(WS, 'alpha', origin, '이어서', null, { session: sessionAs(U.a), runChat: async (...a) => { const t = await raising(`${room.label} 근거 없는 결재`)(...a); item = await approvalByAction(`${room.label} 근거 없는 결재`); return t; } });
    assert.equal(item.msgr.sourceMsgId, Number(m));
    assert.equal(item.msgr.continuation, undefined, `${room.label}: 종류를 밝히지 않은 이어 실행은 근거를 싣지 않는다`);
    await assert.rejects(pushCard(item), /msgr_approval_source_forbidden/, `${room.label}: 거절`);
    assert.equal(serverRow(item.id), '', `${room.label}: 행 0`);
  }
});

/* ── 고친 동작 — 네 종류 × 두 방(+ 조직 채널) ── */
async function followupCase(room) {
  // 원래 턴이 결재 P를 올리고 끝났다 → P 승인 → 결재 후속 턴이 결재 C를 올린다
  const m = say(room, `${room.label} 결재 후속 원래 지시`); execution(room.crew, m, 'running');
  await sinkTool(await turnCtx(room, m), 'request_approval')({ action: `${room.label} 부모 결재`, reason: '필요' });
  const parent = await approvalByAction(`${room.label} 부모 결재`);
  assert.equal((await pushCard(parent)).r, true);
  execution(room.crew, m, 'completed');
  const saved = (await loadApprovals(WS)).find((a) => a.id === parent.id);
  assert.equal(await M.msgrPush({ type: 'approval_resolved', wsId: WS, item: { ...saved, status: 'approved' } }, { session: sessionAs(U.a) }), true, '부모 결재 확정(서버 행 approved)');
  await approvals._followUpForTest(WS, { ...saved, status: 'approved' }, true, { session: sessionAs(U.a), runChat: raising(`${room.label} 후속 결재`) });
  const child = await approvalByAction(`${room.label} 후속 결재`);
  assert.deepEqual(child.msgr.continuation, { kind: 'followup', followupOf: saved.msgr.rowId }, '결재 후속 근거 = 부모 결재 행');
  const { r, calls: c } = await pushCard(child);
  assert.equal(r, true, `${room.label}: 결재 후속 카드`);
  const row = (await loadApprovals(WS)).find((a) => a.id === child.id).msgr;
  assert.equal(serverRow(child.id), `${room.org ?? 'NULL'}|pending|${m}|${row.messageId}|followup|${saved.msgr.rowId}`);
  assert.equal(cardOf(child.id, room.crew), `approval_card|${m}`, '카드는 원래 글에 답으로');
  return { m, calls: c };
}
for (const key of ['org', 'personal', 'channel']) {
  test(`결재 후속(approval_followup) — ${key}: 이어 실행 턴의 결재가 카드로 뜬다(근거 continuation=followup + followup_of=부모)`, { skip }, async () => {
    await followupCase(ROOMS()[key]);
  });
}

for (const key of ['org', 'personal', 'channel']) {
  test(`예약 실행(routines) — ${key}: 예약 턴의 결재가 카드로 뜬다(근거 continuation=routine)`, { skip }, async () => {
    const room = ROOMS()[key];
    const { m, origin } = await finishedSource(room, `${room.label} 예약`);
    await tick();
    const r = await addRoutine(WS, { agentSlug: 'alpha', title: `${room.label} 아침 보고`, prompt: '보고서 정리', schedule: { type: 'daily', time: '09:00' }, msgr: origin });
    await runRoutine(WS, r.id, { session: sessionAs(U.a), chatFn: raising(`${room.label} 예약 결재`) });
    const item = await approvalByAction(`${room.label} 예약 결재`);
    assert.deepEqual(item.msgr.continuation, { kind: 'routine' });
    assert.equal((await pushCard(item)).r, true, `${room.label}: 예약 카드`);
    assert.match(serverRow(item.id), new RegExp(`^${room.org ?? 'NULL'}\\|pending\\|${m}\\|\\d+\\|routine\\|-$`));
  });
}

for (const key of ['org', 'personal']) {
  test(`긴 작업(gateway job) — ${key}: 작업 턴의 결재가 카드로 뜬다(근거 continuation=job)`, { skip }, async () => {
    const room = ROOMS()[key];
    const { m, origin } = await finishedSource(room, `${room.label} 작업`);
    await gateway._makeJobHandlerForTest(WS, { session: sessionAs(U.a), runChat: raising(`${room.label} 작업 결재`) })({ id: `job-${key}`, slug: 'alpha', title: '수집', prompt: '자료 수집', msgr: origin });
    const item = await approvalByAction(`${room.label} 작업 결재`);
    assert.deepEqual(item.msgr.continuation, { kind: 'job' });
    assert.equal((await pushCard(item)).r, true, `${room.label}: 작업 카드`);
    assert.match(serverRow(item.id), new RegExp(`^${room.org ?? 'NULL'}\\|pending\\|${m}\\|\\d+\\|job\\|-$`));
  });
}

for (const key of ['org', 'personal']) {
  test(`루프 정지(경우 12) — ${key}: LOOP blocked의 재개 결재가 카드로 뜬다(성공 회차·실패 회차 둘 다)`, { skip }, async () => {
    const room = ROOMS()[key];
    const { m, origin } = await finishedSource(room, `${room.label} 루프`);
    await tick();
    const ok = await addRoutine(WS, { agentSlug: 'alpha', title: `${room.label} 점검 루프`, prompt: '점검', schedule: { type: 'interval', everyMinutes: 30 }, loop: { maxRuns: 5 }, msgr: origin });
    const res = await runRoutine(WS, ok.id, { session: sessionAs(U.a), chatFn: async () => ({ reply: '확인 필요\nLOOP: blocked 결정 필요', sessionId: null, handover: null }) });
    assert.equal(res.stopped, 'blocked');
    const stop = (await loadApprovals(WS)).find((a) => a.kind === 'loop' && a.payload?.routineId === ok.id);
    assert.deepEqual(stop.msgr.continuation, { kind: 'routine' });
    assert.equal((await pushCard(stop)).r, true, `${room.label}: 루프 정지 카드(성공 회차)`);
    assert.match(serverRow(stop.id), new RegExp(`^${room.org ?? 'NULL'}\\|pending\\|${m}\\|\\d+\\|routine\\|-$`));
    // 실패 회차(판정 없이 3회 연속 실패 → blocked) — 저장된 예약 기록으로 결재를 만든다(routines.mjs announceStop(…, null))
    await M.msgrPush({ type: 'approval_resolved', wsId: WS, item: { ...(await loadApprovals(WS)).find((a) => a.id === stop.id), status: 'rejected' } }, { session: sessionAs(U.a) }); // 앞 카드를 닫는다(근거 카드는 한 글에 하나씩 — 아래 '이미 결재가 있는 글')
    await tick();
    const bad = await addRoutine(WS, { agentSlug: 'alpha', title: `${room.label} 실패 루프`, prompt: '점검', schedule: { type: 'interval', everyMinutes: 30 }, loop: { maxRuns: 5 }, msgr: origin });
    for (let i = 0; i < 3; i++) await runRoutine(WS, bad.id, { session: sessionAs(U.a), chatFn: async () => { throw new Error('러너 끊김'); } }).catch(() => {});
    const failStop = (await loadApprovals(WS)).find((a) => a.kind === 'loop' && a.payload?.routineId === bad.id);
    assert.ok(failStop, '실패 회차 상한 → 재개 결재');
    assert.deepEqual(failStop.msgr.continuation, { kind: 'routine' }, '저장된 예약 기록으로 만든 결재도 예약 근거');
    assert.equal((await pushCard(failStop)).r, true, `${room.label}: 루프 정지 카드(실패 회차)`);
  });
}

/* ── 막아야 하는 경우 — 위조·남의 방·끝난 지 오래된 글·이미 결재가 있는 글 ── */
// 본체가 아니라 주인 권한으로 표·RPC에 직접 넣는다(넣을 수 있는 사람은 크루 주인뿐 — 표 넣기 정책·개인 RPC). 근거 표지는 누구나 적을 수 있으니 서버 사실로만 판정해야 한다.
const insertRow = (room, row) => {
  const full = { org_id: room.org, channel_id: room.ch, crew_id: room.crew, approval_id: `ap-${Math.random().toString(36).slice(2, 10)}`, action: '직접 넣기', risk: 'low', ...row };
  const db = M.makeDb(pgClient(U.a));
  return room.org ? db.insertApproval(full) : db.createPersonalApproval(full);
};
for (const key of ['org', 'personal']) {
  test(`위조 — ${key}: 근거 표지를 적어도 그 에이전트가 실행해 끝낸 글이 아니면(실행 기록 없음·실행 중 아님) 거절, followup_of만 꾸며도 거절`, { skip }, async () => {
    const room = ROOMS()[key];
    const never = say(room, `${room.label} 실행한 적 없는 글`); // 실행 기록 없음 — 아무 글이나 원래 글로 대기
    await assert.rejects(insertRow(room, { source_msg_id: Number(never), payload: { continuation: 'routine' } }), /msgr_approval_source_forbidden/);
    const done = say(room, `${room.label} 끝난 글`); execution(room.crew, done, 'completed');
    // 실행해 끝낸 글이어도 근거 종류가 정해진 셋이 아니면 근거가 아니다
    for (const kind of ['', 'manual', 'ROUTINE', 'followups', 1]) await assert.rejects(insertRow(room, { source_msg_id: Number(done), payload: { continuation: kind } }), /msgr_approval_source_forbidden/, `모르는 종류(${kind || '빈 값'})`);
    await assert.rejects(insertRow(room, { source_msg_id: Number(done), payload: ['continuation'] }), /msgr_approval_source_forbidden/, 'payload가 객체가 아님');
    assert.ok((await insertRow(room, { source_msg_id: Number(done), payload: { continuation: 'job' }, approval_id: `ctl-${key}` })).id, '대조: 실행해 끝낸 글 + 근거면 들어간다');
    sql(`delete from public.msgr_crew_approvals where approval_id = 'ctl-${key}'`);
    // followup_of만 꾸밈 — 부모가 없는 id·다른 글의 승인된 결재
    await assert.rejects(insertRow(room, { source_msg_id: Number(done), payload: { followup_of: '00000000-0000-4000-8000-000000000000' } }), /msgr_approval_source_forbidden/);
  });
}

test('위조 — 다른 에이전트가 실행해 끝낸 글: 이 에이전트의 실행 기록이 아니면 거절(조직 1:1에 들어온 다른 내 에이전트)', { skip }, async () => {
  const room = ROOMS().org;
  const other = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.a}', '${WS}', 'beta', '베타', 'local', 'active', 'owner') returning id`));
  const m = say(room, '베타가 한 일'); execution(other, m, 'completed'); // 같은 방의 글이지만 실행한 에이전트는 베타
  await assert.rejects(insertRow(room, { source_msg_id: Number(m), payload: { continuation: 'routine' } }), /msgr_approval_source_forbidden/);
});

test('남의 방 — 다른 방의 글을 출처로·친구 1:1에서·에이전트가 빠진 방에서는 거절', { skip }, async () => {
  const { org, personal } = ROOMS();
  // 조직 채널에서 실행해 끝낸 글을 조직 1:1 카드의 출처로
  const chMsg = say(ROOMS().channel, '채널에서 끝낸 일'); execution(ORG_CREW, chMsg, 'completed');
  await assert.rejects(insertRow(org, { source_msg_id: Number(chMsg), payload: { continuation: 'routine' } }), /msgr_approval_source_forbidden/, '카드 방 ≠ 출처 방');
  // 친구 1:1(개인 방이지만 crew 1:1 아님) — 실행해 끝낸 글 + 근거여도 개인 RPC가 방을 거절
  const ab = post(U.a, AB, '@알파 해줘', `[{"kind":"crew","id":"${A1}","role":"to"}]`); execution(A1, ab, 'completed');
  await assert.rejects(insertRow({ ...personal, ch: AB }, { source_msg_id: Number(ab), payload: { continuation: 'routine' } }), /msgr_not_allowed/, '친구 방');
  // 조직 채널에서 에이전트가 빠짐 — 지금은 그 글을 이어서 할 수 없다(msgr_delivery_allowed false)
  const kicked = say(ROOMS().channel, '빠지기 전 지시'); execution(ORG_CREW, kicked, 'completed');
  sql(`delete from public.msgr_channel_members where channel_id = '${ORG_CH}' and member_kind = 'crew' and member_id = '${ORG_CREW}'`);
  try {
    await assert.rejects(insertRow(ROOMS().channel, { source_msg_id: Number(kicked), payload: { continuation: 'routine' } }), /msgr_approval_source_forbidden/, '에이전트가 빠진 방');
  } finally { sql(`insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${ORG_CH}', 'crew', '${ORG_CREW}') on conflict do nothing`); }
});

test('끝난 지 오래된 글 — 결재 후속 근거는 결정 24시간까지, 이어 실행 근거는 그 글을 지금 이어서 할 수 없으면(보관·삭제) 거절, 시간만 지난 글은 받는다(예약은 오래된 글을 계속 잇는다)', { skip }, async () => {
  const room = ROOMS().org;
  // followup_of: 결정 25시간 전 부모 → 거절(봇 선례 그대로). 근거 표지 없이.
  const m = say(room, '오래전 결재'); execution(room.crew, m, 'running');
  const parent = await insertRow(room, { source_msg_id: Number(m), approval_id: 'old-parent' });
  execution(room.crew, m, 'completed');
  sql(`update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.a}', decided_at = now() - interval '25 hours' where id = '${parent.id}'`);
  await assert.rejects(insertRow(room, { source_msg_id: Number(m), payload: { followup_of: parent.id } }), /msgr_approval_source_forbidden/, '결정 25시간 지난 부모');
  sql(`update public.msgr_crew_approvals set decided_at = now() - interval '23 hours' where id = '${parent.id}'`);
  const ok = await insertRow(room, { source_msg_id: Number(m), payload: { followup_of: parent.id } });
  assert.ok(ok.id, '대조: 결정 23시간 부모는 받는다');
  // 이어 실행 근거 — 30일 전에 끝난 글(매일 도는 예약): 지금도 이어서 할 수 있으면 받는다
  const old = say(room, '한 달 전 지시'); execution(room.crew, old, 'completed');
  sql(`update public.msgr_messages set created_at = now() - interval '30 days' where id = ${old}; update public.msgr_executions set started_at = now() - interval '30 days', heartbeat_at = now() - interval '30 days' where source_msg_id = ${old}`);
  assert.ok((await insertRow(room, { source_msg_id: Number(old), payload: { continuation: 'routine' } })).id, '시간만 지난 글은 받는다(정책: 예약이 같은 글을 계속 잇는다 — PR 본문)');
  // 삭제된 원래 글·보관된 방 → 거절
  const gone = say(room, '지울 지시'); execution(room.crew, gone, 'completed');
  sql(`update public.msgr_messages set deleted_at = now() where id = ${gone}`);
  await assert.rejects(insertRow(room, { source_msg_id: Number(gone), payload: { continuation: 'routine' } }), /msgr_approval_source_forbidden/, '삭제된 원래 글');
  const arch = say(ROOMS().channel, '보관될 방의 지시'); execution(ORG_CREW, arch, 'completed');
  sql(`update public.msgr_channels set archived_at = now() where id = '${ORG_CH}'`);
  try {
    await assert.rejects(insertRow(ROOMS().channel, { source_msg_id: Number(arch), payload: { continuation: 'routine' } }), /msgr_approval_source_forbidden/, '보관된 방');
  } finally { sql(`update public.msgr_channels set archived_at = null where id = '${ORG_CH}'`); }
});

for (const key of ['org', 'personal']) {
  test(`이미 결재가 있는 글 — ${key}: 근거로 들어온 대기 카드가 그 글에 있으면 다음 근거 카드는 거절, 확정되면 다시 받는다. 원래 턴의 대기 카드는 막지 않는다`, { skip }, async () => {
    const room = ROOMS()[key];
    const m = say(room, `${room.label} 하나씩`); execution(room.crew, m, 'running');
    const own = await insertRow(room, { source_msg_id: Number(m) }); // 원래 턴의 카드(근거 없음, 대기)
    execution(room.crew, m, 'completed');
    const first = await insertRow(room, { source_msg_id: Number(m), payload: { continuation: 'routine' } });
    assert.ok(first.id, '원래 턴의 대기 카드가 있어도 첫 근거 카드는 받는다');
    await assert.rejects(insertRow(room, { source_msg_id: Number(m), payload: { continuation: 'job' } }), /msgr_approval_source_forbidden/, '근거 카드가 대기 중이면 거절(예약이 날마다 쌓지 않게)');
    sql(`update public.msgr_crew_approvals set status = 'approved', decided_by = '${U.a}', decided_at = now() where id = '${first.id}'`);
    assert.ok((await insertRow(room, { source_msg_id: Number(m), payload: { continuation: 'job' } })).id, '확정된 뒤에는 다시 받는다');
    assert.ok(own.id);
    // 같은 결재를 두 번(재시도) — 고유 (crew_id, approval_id)가 막는다
    await assert.rejects(insertRow(room, { source_msg_id: Number(m), approval_id: 'dup', payload: { continuation: 'followup', followup_of: first.id } }).then(() => insertRow(room, { source_msg_id: Number(m), approval_id: 'dup', payload: { continuation: 'followup', followup_of: first.id } })), /duplicate|23505|unique/i);
  });
}

/* ── 버전 섞임 ── */
test('새 본체 + 옛 DB(가드 1b) — 결재 후속은 followup_of로 들어가고, 예약·긴 작업 카드는 지금처럼 거절(배포본보다 나빠지지 않음)', { skip }, async () => {
  const src = readFileSync(mig('20260929150000_msgr_ext_agent_contract_1b.sql'), 'utf8');
  const i = src.indexOf('create or replace function public.msgr_approval_source_guard()');
  const oldGuard = src.slice(i, src.indexOf('end $$;', i) + 'end $$;'.length);
  const newGuard = readdirSync(fileURLToPath(new URL('../supabase/migrations/', import.meta.url))).filter((f) => /^\d+_msgr_continuation_approval_source\.sql$/.test(f));
  assert.equal(newGuard.length, 1, '새 가드 마이그레이션 파일 하나');
  psql(['-c', oldGuard]);
  try {
    for (const key of ['org', 'personal']) {
      const room = ROOMS()[key];
      await followupCase({ ...room, label: `옛 가드 ${room.label}` }); // followup_of(승인된 부모) — 1b 갈래로 통과
      const { origin } = await finishedSource(room, `옛 가드 ${room.label} 작업`);
      await gateway._makeJobHandlerForTest(WS, { session: sessionAs(U.a), runChat: raising(`옛 가드 ${room.label} 작업 결재`) })({ id: `job-old-${key}`, slug: 'alpha', title: '수집', prompt: '자료', msgr: origin });
      const item = await approvalByAction(`옛 가드 ${room.label} 작업 결재`);
      await assert.rejects(pushCard(item), /msgr_approval_source_forbidden/, `${room.label}: 옛 가드는 근거 표지를 모른다 → 배포본과 같은 거절`);
    }
  } finally { psql(['-c', readFileSync(mig(newGuard[0]), 'utf8')]); }
});

test('DB 위생 — 이어 실행 카드 1건의 본체 요청 수는 보통 카드와 같다(근거는 같은 넣기 행에 실린다, 추가 조회 0)', { skip }, async () => {
  const room = ROOMS().org;
  const m = say(room, '요청 수 대조'); execution(room.crew, m, 'running');
  await sinkTool(await turnCtx(room, m), 'request_approval')({ action: '보통 카드 요청 수', reason: '필요' });
  const plain = await pushCard(await approvalByAction('보통 카드 요청 수'));
  const { calls: cont } = await followupCase({ ...room, label: '요청 수' });
  assert.deepEqual(cont, plain.calls, `보통 ${plain.calls.join(',')} / 이어 실행 ${cont.join(',')}`);
});
