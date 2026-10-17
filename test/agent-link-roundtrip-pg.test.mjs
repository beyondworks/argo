// 본체 연결부(src/agent-link-host.mjs + packages/agent-link) × 실제 서버 함수(U1·U3·U2·U2b 마이그레이션)를 실제 Postgres에서 왕복한다(U4b).
// 가짜는 둘뿐이다: chat()(모델 턴)과 결재 확정(resolveWithFollowUp — 로컬 결재 파일). 전송층은 RPC를 **이름 있는 인자**로 부른다 —
// PostgREST가 JSON 키를 함수 인자 이름에 잇는 것과 같다. 그래서 본체가 보내는 인자 이름이 서버 함수와 어긋나면 여기서 빨강이다
// (#1074 병합본은 { envelope }·{ work, name, bytes }로 보내 PGRST202로 거부됐다 — U4b에서 고침).
// Realtime은 없다: 시험이 link.catchUp()을 불러 msgr2_link_pending으로 서버→본체 봉투를 받는다(재접속 따라잡기와 같은 길).
// 건너뜀: ARGO_PG_TEST_URL 미설정. 실행: bash scripts/billing-pg-drill.sh test/agent-link-roundtrip-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { setup, seedDevice, migText } from './helpers/msgr2-work-pg.mjs';
import { createAgentLinkHost } from '../src/agent-link-host.mjs';
import { validateEnvelope } from '../packages/agent-link/contract/v1.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/agent-link-roundtrip-pg.test.mjs';
const O = '50000000-0000-4000-8000-000000000001';
let db, oApp, PS, TS;
// 본체 하나를 두 시험이 함께 쓴다 — 에이전트 리스(10분)는 그 기기에 남아, 다른 기기로 시작하면 서버가 offer를 리스 기기로만 보낸다(설계대로)
let turn = () => ({ reply: '' });
let shared = null;
const AGENTS = [{ ws: 'w', slug: 'a', name: '에이', role: '비서' }, { ws: 'w', slug: 'b', name: '비', role: '일정 담당' }];
const argoOnce = async () => (shared ??= await argo({ agents: AGENTS, chatImpl: (opts, tools) => turn(opts, tools) }));
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const until = async (cond, ms = 15_000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); };

const ident = (k) => { assert.match(k, /^[a-z_][a-z0-9_]*$/, `인자 이름 모양: ${k}`); return k; };
const sqlVal = (v) => (v === null || v === undefined ? 'null'
  : Array.isArray(v) ? `array[${v.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',')}]::text[]`
    : typeof v === 'object' ? `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`
      : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** 본체 세션으로 RPC를 이름 있는 인자로 부르는 전송층(PostgREST 대역). 42883(이름·인자가 맞는 함수 없음) → PGRST202 404. */
function pgTransport(uid, sid, log) {
  return {
    async rpc(name, args = {}) {
      const named = Object.entries(args).map(([k, v]) => `${ident(k)} => ${sqlVal(v)}`).join(', ');
      const r = db.raw(['-v', 'VERBOSITY=verbose', '-A', '-t', '-c', db.ctx(uid, sid) + `select public.${ident(name)}(${named})::text`]);
      log.push({ name, args });
      if (r.status !== 0) {
        const code = r.stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] ?? 'unknown';
        return { data: null, error: { code: code === '42883' ? 'PGRST202' : code, message: r.stderr.trim().slice(0, 300), status: code === '42883' ? 404 : 400 } };
      }
      const out = r.stdout.trim().split('\n').filter(Boolean).pop();
      return { data: out ? JSON.parse(out) : null, error: null };
    },
    subscribe(topic, onEnvelope, onStatus) { queueMicrotask(() => onStatus?.('connected')); return { close() {} }; },
    async broadcast() {},
    async download() { return new Uint8Array(); },
    async upload() {},
  };
}

/** 본체 하나: 실제 연결부 + PG 전송층 + 가짜 chat·결재. 등록은 연결부가 직접 한다(msgr2_device_register). */
async function argo({ chatImpl, agents }) {
  const sid = db.sql('select gen_random_uuid()');
  db.sql(`insert into auth.sessions (id, user_id) values ('${sid}', '${O}')`);
  const log = []; const calls = { chat: [], resolved: [] };
  const handlers = new Set();
  const emit = (ev) => { for (const h of handlers) Promise.resolve().then(() => h(ev)); };
  const items = new Map();
  const vault = await mkdtemp(join(tmpdir(), 'argo-link-rt-'));
  const host = createAgentLinkHost({
    getSession: async () => ({ client: {}, uid: O }),
    listOwnedAgents: async () => agents,
    chat: async (ws, slug, text, s, opts) => { calls.chat.push({ ws, slug, text, opts }); return chatImpl(opts, { emit, items }); },
    interruptTurn: async () => {},
    onNotify: (fn) => { handlers.add(fn); return () => handlers.delete(fn); },
    resolveWithFollowUp: async (ws, id, approve) => {
      calls.resolved.push({ id, approve, effect: db.sql(`select coalesce(max(state), '') from public.msgr2_effects where effect_key = 'approval:${id}'`) });
      emit({ type: 'approval_followup', wsId: ws, item: items.get(id), reply: approve ? `후속: ${items.get(id).action} 처리함` : '후속: 거절됨' });
    },
    resolveApproval: async () => {},
    planReplyFiles: async (ws, body) => ({ body, files: [] }),
    readReplyFile: async () => new Uint8Array(),
    vaultDir: () => vault,
    appVersion: '0.2.0',
    detectRunners: async () => ({ claude: { installed: true, authed: true } }), // 러너 없는 기기는 offer 대상이 아니다(서버)
    transportFor: () => pgTransport(O, sid, log),
    log: () => {},
  });
  host.start();
  await until(() => !!host.link && host.agents.size === agents.length);
  assert.equal(host.agents.size, agents.length, `연결부 시작(등록·목록) 실패: ${JSON.stringify(log.map((x) => x.name))}`);
  return { host, log, calls, sid };
}
const agentId = (slug) => db.sql(`select id from public.msgr2_agents where owner_user_id = '${O}' and ws_id = 'w' and slug = '${slug}'`);
const say = (room, body, mentions = []) => db.as(oApp.uid, oApp.sid,
  `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, mentions) values ('${room}', 'user', '${O}', '${body}', '{${mentions.join(',')}}') returning id`);
const workOf = (room) => JSON.parse(db.sql(`select to_jsonb(w) from public.msgr2_works w where room_id = '${room}' order by created_at desc, id limit 1`));
const stateOf = (id) => JSON.parse(db.as(oApp.uid, oApp.sid, `select public.msgr2_work_status('${id}')`)).state;

before(() => {
  if (!DB) return;
  db = setup(DB);
  const migDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  db.psql(['-c', migText(readdirSync(migDir).find((f) => f.endsWith('_msgr_app_min_version.sql')))]); // 등록 함수가 부르는 최소 버전 함수
  db.sql(`create table if not exists auth.sessions (id uuid primary key, user_id uuid not null, created_at timestamptz not null default now())`);
  db.sql(`create table if not exists public.msgr_settings (key text primary key, value text);
    insert into public.msgr_settings values ('msgr2_limit_agent_min', '1000'), ('msgr2_limit_room_min', '1000') on conflict (key) do update set value = excluded.value`);
  oApp = seedDevice(db, O, 'app');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${O}') returning id`);
  TS = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', '팀', '${O}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${O}', 'owner'), ('${TS}', '${O}', 'owner')`);
});

test('승인 왕복: 사람 글 → offer → 본체 턴의 결재 → approval_request(카드) → 앱이 승인 → 본체가 effect intent 뒤 결재를 풀고 → 후속 답이 결과로 방에', { skip }, async () => {
  const { host, log, calls } = await argoOnce();
  turn = (opts, { emit, items }) => {
    const it = { id: 'ap-rt', kind: 'action', action: '거래처 메일 발송', reason: '일정 안내', slug: 'a', status: 'pending', scope: opts.mirrorCtx.scope };
    items.set(it.id, it); emit({ type: 'approval', wsId: 'w', item: it });
    return { reply: '결재를 올렸습니다' };
  };
  const AG = agentId('a');
  const DM = db.sql(`insert into public.msgr2_rooms (space_id, kind, pair_key) values ('${PS}', 'direct', 'o-a-rt') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${DM}', 'user', '${O}'), ('${DM}', 'agent', '${AG}')`);
  say(DM, '거래처에 메일 보내줘');
  const w = workOf(DM);
  await host.link.catchUp(); await flush();
  await until(() => stateOf(w.id) === 'awaiting_approval');
  assert.equal(stateOf(w.id), 'awaiting_approval', `일 상태: ${stateOf(w.id)} ${JSON.stringify(log.slice(-3).map((x) => x.name))}`);
  assert.equal(calls.chat[0].opts.mirrorCtx.scope.owner, true, '1:1 주인 방 = owner 등급');
  const ap = JSON.parse(db.sql(`select to_jsonb(a) from public.msgr2_approvals a where work_id = '${w.id}'`));
  assert.equal(ap.effect_key, 'approval:ap-rt');
  assert.equal(calls.resolved.length, 0, '결정 전에는 로컬 결재를 풀지 않는다');
  assert.equal(db.as(oApp.uid, oApp.sid, `select public.msgr2_approval_decide('${ap.id}', 'approve')`), 'approved');
  await host.link.catchUp(); await flush();
  await until(() => stateOf(w.id) === 'done');
  assert.equal(stateOf(w.id), 'done');
  assert.deepEqual(calls.resolved, [{ id: 'ap-rt', approve: true, effect: 'intent' }], '승인 실행 순간 서버에 intent가 있다');
  assert.equal(db.sql(`select state from public.msgr2_effects where effect_key = 'approval:ap-rt'`), 'done');
  const reply = db.sql(`select body from public.msgr2_messages where room_id = '${DM}' and author_kind = 'agent' order by id desc limit 1`);
  assert.equal(reply, '결재를 올렸습니다\n\n후속: 거래처 메일 발송 처리함');
  // 본체가 보낸 봉투는 모두 계약에 맞고, 이름 있는 인자로 갔다
  const sends = log.filter((x) => x.name === 'msgr2_link_send');
  assert.ok(sends.length >= 5);
  for (const x of sends) { assert.deepEqual(Object.keys(x.args), ['p_env']); assert.ok(validateEnvelope(x.args.p_env, { from: 'runner' }).ok, x.args.p_env.type); }
});

test('넘김 왕복: 팀 방 멘션 → offer.peers에 동료 → 본체 답의 [넘김 @이름] → result.handoffs → 서버가 동료에게 새 일(같은 토픽·depth 1)', { skip }, async () => {
  const { host, calls } = await argoOnce();
  turn = () => ({ reply: '초안 끝.\n[넘김 @비] 일정 확정해 줘' });
  const before = calls.chat.length;
  const AG = agentId('a'); const AG2 = agentId('b');
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id, allow) values ('${AG}', '${TS}', 'all'), ('${AG2}', '${TS}', 'all') on conflict do nothing`);
  const TR = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'private', '팀방-rt') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${TR}', 'user', '${O}'), ('${TR}', 'agent', '${AG}'), ('${TR}', 'agent', '${AG2}')`);
  say(TR, '에이 초안 써 줘', [AG]);
  const w = workOf(TR);
  await host.link.catchUp(); await flush();
  await until(() => stateOf(w.id) === 'done');
  assert.equal(stateOf(w.id), 'done');
  assert.match(calls.chat[before].text, /## 이 방에서 넘길 수 있는 동료\n- @비 — 일정 담당/, '서버가 준 offer.peers를 보여 준다');
  const child = JSON.parse(db.sql(`select to_jsonb(c) from public.msgr2_works c where parent_work_id = '${w.id}'`) || 'null');
  assert.ok(child, '동료에게 새 일이 생겼다');
  assert.equal(child.agent_id, AG2); assert.equal(child.depth, 1); assert.equal(child.topic_id, w.topic_id);
  const reply = db.sql(`select body from public.msgr2_messages where room_id = '${TR}' and author_kind = 'agent' and author_agent_id = '${AG}' order by id desc limit 1`);
  assert.equal(reply, '초안 끝.', '넘김 줄은 본문에서 빠진다');
  host.stop();
});
