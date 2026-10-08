// 개인 공간 crew 1:1 결재·이어 실행 — 본체 코드(src/gateway/msgr.mjs·chat.mjs) → RPC → 실제 Postgres 왕복(PR-C, 계획 rc-0195 personal-crew-room-features-plan.md 5-3·9절).
// supabase-js 대신 makeDb가 부르는 모양만 흉내 내는 작은 클라이언트(아래 pgClient)를 그 사용자 권한(set role authenticated + argo.uid)으로 psql에 보낸다.
// 그래서 RLS·트리거·정의자 함수(msgr_is_own_crew_room·msgr_create_personal_approval·msgr_can_decide·msgr_crew_context)는 마이그레이션 그대로 돈다.
// 한계: PostgREST가 없어 옛 서버의 '함수 없음'은 PGRST202가 아니라 Postgres 42883으로 온다(어댑터는 둘을 같게 다룬다 — 단위 테스트가 PGRST202를 따로 본다).
// 경우 표: 1·4(본체 흐름: 판정 → 결재 → 카드 → 판정 → 확정), 7·9(친구 방 거절·위장 기록 거절), 15(이어 실행 중 방 바뀜), 16(옛 서버 — 함수 없음), 6절 2번(이어 실행 결재 카드와 출처 가드, 조직 1:1 재현).
// 실행: bash scripts/billing-pg-drill.sh test/msgr-personal-room-body-pg.test.mjs
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
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr-personal-room-body-pg.test.mjs';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-personal-room-body-pg-'));
const { createCompany, paths } = await import('../src/workspace.mjs');
const chatMod = await import('../src/chat.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');
const approvals = await import('../src/approval-actions.mjs');
const M = await import('../src/gateway/msgr.mjs');
const { messengerOrigin } = await import('../src/gateway/msgr-handoff.mjs');
const { onNotify } = await import('../src/notify.mjs');

const mig = (f) => fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url));
// a = crew 1:1 주인, b = a의 친구, d = 조직 만든 사람(조직 대조군)
const U = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', d: '44444444-4444-4444-8444-444444444444' };
const WS = 'personal-pg';
const psqlRaw = (args) => psqlSpawn(DB, args);
function psql(args) { const r = psqlRaw(args); if (r.status !== 0) throw new Error(`psql 실패: ${r.stderr || r.stdout}`); return r.stdout; }
const sql = (q) => psql(['-A', '-t', '-c', q]).trim();
const asUser = (uid, q) => sql(`set role authenticated; select set_config('argo.uid', '${uid}', false); ${q}`);
const last = (s) => s.split('\n').filter(Boolean).pop() ?? '';
const post = (uid, ch, body, mentions = '[]') => last(asUser(uid, `insert into public.msgr_messages (channel_id, author_kind, author_user_id, kind, body, mentions, client_msg_id) values ('${ch}', 'user', '${uid}', 'text', '${body}', '${mentions}'::jsonb, gen_random_uuid()::text) returning id`));
const execution = (crew, source, state) => sql(`insert into public.msgr_executions (crew_id, source_msg_id, attempt, state) values ('${crew}', ${source}, gen_random_uuid(), '${state}') on conflict (crew_id, source_msg_id) do update set state = '${state}'`);

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
  const rpc = async (name, args = {}) => runAs(uid, `select to_jsonb(public.${ident(name)}(${Object.entries(args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(', ')}))`);
  return { from, rpc };
}
const sessionAs = (uid) => { const client = pgClient(uid); const db = M.makeDb(client); return async () => ({ uid, db, client }); };

let ORG, ORG_CREW, ORG_DM, A1, A3, CH_A1, CH_A3, AB;
const sinkTool = (ctx, name, lang = 'ko') => { const sink = []; chatMod.makeCrewServer(WS, 'alpha', 'alpha', [], 0, [], ctx, lang, [], '', sink); return sink.find((t) => t.name === name).handler; };
/** 게이트웨이(run)가 개인 턴에 만드는 문맥 — ownCrewRoom은 실제 서버 판정(어댑터 → msgr_is_own_crew_room) */
async function turnCtx(uid, ch, crew, src, { org = null, kind = 'dm' } = {}) {
  const db = M.makeDb(pgClient(uid));
  const own = org ? undefined : await db.ownCrewRoom(ch, crew);
  return { kind: 'msgr', orgId: org, channelId: ch, channelKind: kind, crewId: crew, threadRoot: src, sourceMsgId: src, uid, wsId: WS, origin: uid, hop: 0,
    peers: [{ id: crew, slug: 'alpha', display_name: '알파', owner_user_id: uid, ws_id: WS }], handoffs: [], ...(own !== undefined ? { ownCrewRoom: own } : {}) };
}
const events = [];
onNotify((e) => { if (e.wsId === WS) events.push(e); });
const rowOf = (apId) => sql(`select concat_ws('|', coalesce(org_id::text, 'NULL'), status, risk, coalesce(message_id::text, 'NULL'), coalesce(decided_by::text, 'NULL')) from public.msgr_crew_approvals where approval_id = '${apId}'`);

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
  for (const uid of [U.a, U.b]) asUser(uid, 'select public.msgr_set_ai_consent(true)'); // 개인 방 동의는 명시적 동의만(msgr_ai_consent_ok_for)
  await createCompany(WS, '린', '유건', U.a);
  await mkdir(paths(WS).agents, { recursive: true });
  // 조직 대조군 — d의 조직에 a가 멤버, a의 조직 크루와 조직 1:1
  ORG = last(asUser(U.d, `insert into public.msgr_orgs (name, slug, owner_user_id) values ('Lean', 'lean', '${U.d}') returning id`));
  sql(`update public.msgr_org_entitlements set plan = 'team', seats = 10 where org_id = '${ORG}'`);
  const code = last(asUser(U.d, `insert into public.msgr_invites (org_id, role, created_by) values ('${ORG}', 'member', '${U.d}') returning code`));
  asUser(U.a, `select public.msgr_accept_invite('${code}')`);
  ORG_CREW = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values ('${ORG}', '${U.a}', '${WS}', 'alpha', '알파', 'local', 'active', 'owner') returning id`));
  ORG_DM = last(asUser(U.a, `select public.msgr_create_channel(org => '${ORG}', kind => 'dm', name => 'dm:알파', others => '[{"kind":"crew","id":"${ORG_CREW}"}]'::jsonb)`));
  // 개인 크루(같은 slug의 개인 행 — 본체 crewBySlug(orgId null)가 고른다)와 방
  A1 = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${U.a}', '${WS}', 'alpha', '알파', 'local', 'active', 'owner') returning id`));
  A3 = last(asUser(U.a, `insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow) values (null, '${U.a}', '${WS}-other', 'alpha', '알파2', 'local', 'active', 'owner') returning id`));
  CH_A1 = last(asUser(U.a, `select public.msgr_dm_personal_crew('${A1}')`));
  CH_A3 = last(asUser(U.a, `select public.msgr_dm_personal_crew('${A3}')`));
  asUser(U.a, `select public.msgr_friend_request('${U.b}')`); asUser(U.b, `select public.msgr_friend_decide('${U.a}', true)`);
  AB = last(asUser(U.a, `select public.msgr_dm_personal('${U.b}')`));
  assert.equal(last(asUser(U.a, `select public.msgr_crew_join('${AB}', '${A1}')`)), 'joined', '친구 1:1에 a의 개인 크루');
});

test('경우 1·4(본체 흐름) — crew 1:1 주인 턴: 서버 판정 true → 결재 기록 → 개인 RPC 넣기·카드·카드 연결 → 결정권 true → 확정(감사 쓰기 없음)', { skip }, async () => {
  const before = Number(sql('select count(*) from public.msgr_audit_log'));
  for (const [action, risk] of [['거래처에 견적서 메일 발송', 'high'], ['보고서 초안 정리', 'low']]) {
    const m = post(U.a, CH_A1, `일 ${risk}`); execution(A1, m, 'running'); // 원래 턴이 도는 동안의 결재 카드
    const ctx = await turnCtx(U.a, CH_A1, A1, m);
    assert.equal(ctx.ownCrewRoom, true, '서버 판정(msgr_is_own_crew_room)');
    await sinkTool(ctx, 'request_approval')({ action, reason: '필요' });
    const item = (await loadApprovals(WS)).find((a) => a.action === action);
    assert.deepEqual([item.msgr.orgId, item.msgr.channelId, item.msgr.ownCrewRoom], [null, CH_A1, true]);
    assert.equal(await M.msgrPush({ type: 'approval', wsId: WS, item }, { session: sessionAs(U.a) }), true, `${risk}: 카드가 들어간다`);
    const saved = (await loadApprovals(WS)).find((a) => a.id === item.id);
    const card = sql(`select concat_ws('|', kind, channel_id, reply_to, (mentions @> '[{"kind":"approval"}]')::text) from public.msgr_messages where id = ${saved.msgr.messageId}`);
    assert.equal(card, `approval_card|${CH_A1}|${m}|true`, `${risk}: 카드 글`);
    assert.equal(rowOf(item.id), `NULL|pending|${risk}|${saved.msgr.messageId}|NULL`, `${risk}: org 없는 결재 행 + 카드 연결`);
    assert.equal(saved.msgr.ownerMayDecide, true, `${risk}: 위험 등급과 무관하게 주인이 결정(실제 msgr_can_decide)`);
    // 데스크톱(로컬)에서 확정 → 미러 행 확정(approval_resolved 경로)
    assert.equal(await M.msgrPush({ type: 'approval_resolved', wsId: WS, item: { ...saved, status: 'approved' } }, { session: sessionAs(U.a) }), true);
    assert.equal(rowOf(item.id), `NULL|approved|${risk}|${saved.msgr.messageId}|${U.a}`, `${risk}: 확정`);
  }
  assert.equal(Number(sql('select count(*) from public.msgr_audit_log')), before, '개인 결재 확정은 감사 행을 쓰지 않는다');
});

test('경우 7·9 — 친구 1:1: 서버 판정 false → 기록 거절(친구 방 문구), 실행 중 문맥으로 찾아도 넣기 시도 0, 위장 기록(ownCrewRoom: true)은 서버 RPC가 거절', { skip }, async () => {
  const m = post(U.a, AB, '@알파 보내줘', `[{"kind":"crew","id":"${A1}","role":"to"}]`); execution(A1, m, 'running');
  const ctx = await turnCtx(U.a, AB, A1, m);
  assert.equal(ctx.ownCrewRoom, false, '친구 1:1은 서버 판정 false');
  assert.throws(() => messengerOrigin(ctx), /친구와의 방/);
  const n0 = Number(sql('select count(*) from public.msgr_crew_approvals'));
  // D28 친구 방 — 목적지 없는 결재 + 실행 중 문맥(친구 방)
  M._activeCtxForTest.set(`${WS}:alpha`, ctx);
  try { assert.equal(await M.msgrPush({ type: 'approval', wsId: WS, item: { id: 'ap-friend-d28', slug: 'alpha', action: '셸 명령 실행(재귀 삭제): rm -rf x', payload: { shell: 'rm -rf x' } } }, { session: sessionAs(U.a) }), false); }
  finally { M._activeCtxForTest.delete(`${WS}:alpha`); }
  // 위장 — 로컬 기록에 표지만 붙여도 서버가 방을 다시 판정한다
  const forged = { id: 'ap-forged', slug: 'alpha', action: '메일 발송', msgr: { orgId: null, ownCrewRoom: true, channelId: AB, channelKind: 'dm', crewId: A1, threadRoot: m, sourceMsgId: m, uid: U.a, wsId: WS, origin: U.a, hop: 0 } };
  await assert.rejects(M.msgrPush({ type: 'approval', wsId: WS, item: forged }, { session: sessionAs(U.a) }), /msgr_not_allowed/);
  assert.equal(Number(sql('select count(*) from public.msgr_crew_approvals')), n0, '결재 행 0');
});

test('경우 15 — 개인 이어 실행(결재 후속): 서버 판정·봉투·동의를 다시 보고 같은 방에 답, 그 사이 방에 다른 에이전트가 들어오면 실행하지 않는다', { skip }, async () => {
  const m = post(U.a, CH_A1, '이어서 해줘'); execution(A1, m, 'completed');
  const origin = messengerOrigin(await turnCtx(U.a, CH_A1, A1, m));
  let ran = 0;
  const runChat = async (_ws, _slug, _msg, _sid, opts) => { ran++; assert.equal(opts.mirrorCtx.ownCrewRoom, true); return { reply: '후속 결과', sessionId: null, handover: null }; };
  events.length = 0;
  await approvals._followUpForTest(WS, { id: 'ap-follow', slug: 'alpha', kind: 'action', action: '보고서 발송', msgr: origin }, true, { runChat, session: sessionAs(U.a) });
  const event = events.find((e) => e.type === 'approval_followup');
  assert.equal(await M.msgrPush(event, { session: sessionAs(U.a) }), true);
  assert.equal(sql(`select concat_ws('|', author_kind, crew_id, reply_to, body) from public.msgr_messages where channel_id = '${CH_A1}' and client_msg_id like 'ct:%' order by id desc limit 1`), `crew|${A1}|${m}|후속 결과`, '같은 방의 원래 글에 답(실제 RLS·트리거 통과)');
  // 방 모양이 바뀜 — 내 다른 개인 크루가 crew 1:1에 들어온다(msgr_crew_join = 실제 경로) → 서버 판정 false
  assert.equal(last(asUser(U.a, `select public.msgr_crew_join('${CH_A1}', '${A3}')`)), 'joined');
  try {
    await assert.rejects(M.runMessengerContinuation(WS, 'alpha', origin, '진행', null, { session: sessionAs(U.a), runChat }), /개인 1:1로 확인되지 않아/);
    assert.equal(ran, 1, '바뀐 방에서는 유료 턴 0');
  } finally { sql(`delete from public.msgr_channel_members where channel_id = '${CH_A1}' and member_kind = 'crew' and member_id = '${A3}'`); }
});

// 6절 2번 — 결재 후속·예약·긴 작업(이어 실행) 턴에서 올린 결재 카드의 출처는 원래 지시이고(msgr.mjs msgrPush approval.source_msg_id), 그 지시의 실행은 이미 끝났다(completed).
// 출처 가드는 실행 중(running)이거나 승인된 부모 결재(payload.followup_of)가 있어야 받는데 본체는 followup_of를 싣지 않는다 → 카드가 거절되고 결재는 로컬에만 남는다.
// 조직 1:1 테스트는 고치기 전 코드(origin/main)에서도 같은 결과다(이번 범위에서 고치지 않음 — PR 본문 '남은 것'). 개인 crew 1:1도 같은 모양이다.
async function continuationCard(label, ch, crew, org) {
  const m = post(U.a, ch, `${label} 원래 지시`);
  execution(crew, m, 'completed'); // 원래 턴은 끝났다 — 결재 후속·예약·긴 작업은 이 원문을 출처로 이어 실행한다
  const origin = messengerOrigin(await turnCtx(U.a, ch, crew, m, { org }));
  let item = null;
  // 실제 이어 실행 — 턴 안에서 모델이 결재를 하나 더 올린다(본체가 보내는 행 모양 그대로)
  await M.runMessengerContinuation(WS, 'alpha', origin, '이어서', null, { session: sessionAs(U.a), runChat: async (_ws, _slug, _msg, _sid, opts) => {
    await sinkTool(opts.mirrorCtx, 'request_approval')({ action: `${label} 추가 발송`, reason: '필요' });
    item = (await loadApprovals(WS)).find((a) => a.action === `${label} 추가 발송`);
    return { reply: '결재 올림', sessionId: null, handover: null };
  } });
  assert.equal(item.msgr.sourceMsgId, Number(m), `${label}: 카드 출처 = 원래 지시(실행 완료)`);
  assert.equal(item.payload?.followup_of, undefined, `${label}: 본체는 followup_of를 싣지 않는다(봇 경로만 — 20260929150000_1b 318-319)`);
  await assert.rejects(M.msgrPush({ type: 'approval', wsId: WS, item }, { session: sessionAs(U.a) }), /msgr_approval_source_forbidden/, `${label}: 출처 가드 거절 — 카드 0, 결재는 로컬에만`);
  assert.equal(sql(`select count(*) from public.msgr_crew_approvals where approval_id = '${item.id}'`), '0');
  // 대조: 원래 턴이 도는 동안(running)이면 같은 모양이 들어간다
  execution(crew, m, 'running');
  assert.equal(await M.msgrPush({ type: 'approval', wsId: WS, item }, { session: sessionAs(U.a) }), true, `${label}: 대조 — 실행 중이면 통과`);
}
test('6절 2번 재현(조직 1:1, 고치기 전 코드와 같음) — 이어 실행 턴에서 올린 결재 카드는 원문의 실행이 끝나 출처 가드에 거절된다', { skip }, async () => {
  await continuationCard('조직 1:1', ORG_DM, ORG_CREW, ORG);
});
test('6절 2번(개인 crew 1:1) — 같은 모양: 이어 실행 턴의 결재 카드는 출처 가드에 거절, 결재는 로컬에만', { skip }, async () => {
  await continuationCard('개인 crew 1:1', CH_A1, A1, null);
});

test('경우 16 — 옛 서버(판정·넣기 함수 없음): 판정은 모름(null) → 1단계 문구로 거절, 넣기는 시도하지 않은 것으로(카드 0·표 직접 넣기 0)', { skip }, async () => {
  const m = post(U.a, CH_A1, '옛 서버'); execution(A1, m, 'running');
  sql('alter function public.msgr_is_own_crew_room(uuid, uuid) rename to msgr_is_own_crew_room_hidden; alter function public.msgr_create_personal_approval(jsonb) rename to msgr_create_personal_approval_hidden');
  try {
    const ctx = await turnCtx(U.a, CH_A1, A1, m);
    assert.equal(ctx.ownCrewRoom, null, '함수 없음 = 모름');
    assert.throws(() => messengerOrigin(ctx), /개인 공간에서는 아직/);
    const item = { id: 'ap-old-server', slug: 'alpha', action: '보고서 정리', msgr: { orgId: null, ownCrewRoom: true, channelId: CH_A1, channelKind: 'dm', crewId: A1, threadRoot: m, sourceMsgId: m, uid: U.a, wsId: WS, origin: U.a, hop: 0 } };
    const n0 = Number(sql('select count(*) from public.msgr_crew_approvals'));
    assert.equal(await M.msgrPush({ type: 'approval', wsId: WS, item }, { session: sessionAs(U.a) }), false);
    assert.equal(Number(sql('select count(*) from public.msgr_crew_approvals')), n0, '표 직접 넣기로 물러나지 않는다');
    assert.equal(sql(`select count(*) from public.msgr_messages where client_msg_id = 'ap:${A1}:ap-old-server'`), '0', '카드 0');
  } finally {
    sql('alter function public.msgr_is_own_crew_room_hidden(uuid, uuid) rename to msgr_is_own_crew_room; alter function public.msgr_create_personal_approval_hidden(jsonb) rename to msgr_create_personal_approval');
  }
});

test('인접 핀 — 조직 1:1 결재 카드: 본체가 표에 직접 넣고(org_id = 조직) 판정·확정·감사는 그대로', { skip }, async () => {
  const m = post(U.a, ORG_DM, '조직 1:1 일'); execution(ORG_CREW, m, 'running');
  const ctx = await turnCtx(U.a, ORG_DM, ORG_CREW, m, { org: ORG });
  await sinkTool(ctx, 'request_approval')({ action: '조직 보고서 정리', reason: '필요' });
  const item = (await loadApprovals(WS)).find((a) => a.action === '조직 보고서 정리');
  assert.equal(await M.msgrPush({ type: 'approval', wsId: WS, item }, { session: sessionAs(U.a) }), true);
  const saved = (await loadApprovals(WS)).find((a) => a.id === item.id);
  assert.equal(rowOf(item.id), `${ORG}|pending|low|${saved.msgr.messageId}|NULL`);
  assert.equal(saved.msgr.ownerMayDecide, true, 'low = 크루 주인');
  const audit0 = Number(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'approval.approved'`));
  assert.equal(await M.msgrPush({ type: 'approval_resolved', wsId: WS, item: { ...saved, status: 'approved' } }, { session: sessionAs(U.a) }), true);
  assert.equal(rowOf(item.id).split('|')[1], 'approved');
  assert.equal(Number(sql(`select count(*) from public.msgr_audit_log where org_id = '${ORG}' and action = 'approval.approved'`)), audit0 + 1, '조직 결재 확정은 감사를 남긴다');
});
