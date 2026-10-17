// 게이트 B(CLAUDE.md 회귀 게이트 4) — 같은 상황(로그인 → 공간 목록 → 방 열기 → 글 보내기 → 에이전트 일 → 결재 → 결과 → 유휴 10분)을
// 옛 경로(지금 배포본 동작, 옛 msgr_* 함수)와 v2 경로(msgr2_* 함수)로 같은 PG(옛 메신저 전체 + msgr2 운영 순서 setupFull)에서 돌려,
// 단계마다 DB 쓰기(그 요청의 트랜잭션이 넣거나 바꾼 행 = xmin이 그 트랜잭션인 행, 모든 표), 방송 행(realtime.send = 운영의 realtime.messages 행),
// pg_net 호출(푸시)을 센다. 쓰기를 부르는 요청만 여기서 돌린다 — 읽기 요청 수는 코드 조사(볼트 AI-Sessions/conversations/argo/2026-10-18-msgr2-u9-gate-b.md 표)로 센다.
// 결과 표: GATE_B_OUT 환경변수가 있으면 그 파일에 JSON으로 남긴다. 지운 행(delete)은 세지 않는다(두 경로 모두 이 상황에서 지우지 않는다 — 옛 심박의 50대 초과 정리만 예외).
// 실행: GATE_B_OUT=/tmp/gate-b.json bash scripts/billing-pg-drill.sh test/msgr2-gate-b-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setupFull, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-gate-b-pg.test.mjs';
const id = (n) => `e8000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const O = id(1), M = id(2), T = id(100), PUB = id(400), DM2 = id(401), AGO = id(200), CREW = id(300);

let db;
const report = { old: [], v2: [] };
// 한 요청 = 한 트랜잭션. 끝에 txid를 받아 그 트랜잭션이 쓴 행을 센다(곧바로 세야 다음 요청이 xmin을 덮지 않는다)
function call(side, step, label, uid, sid, q) {
  const r = db.raw(['-A', '-t', '-c', db.ctx(uid, sid) + `${q}; select txid_current()::text`]);
  if (r.status !== 0) throw new Error(`${side}/${step}/${label}: ${r.stderr}`);
  const xid = String(BigInt(r.stdout.trim().split('\n').pop()) % 4294967296n);
  const w = JSON.parse(db.sql(`select public._gate_b_writes('${xid}')`));
  report[side].push({ step, label, writes: w.total, tables: w.tables });
  return w;
}
const stepSum = (side, step) => report[side].filter((x) => x.step === step).reduce((a, x) => a + x.writes, 0);
const sent = () => Number(db.sql('select count(*) from realtime.sent'));
const net = () => Number(db.sql('select count(*) from public._gate_b_net'));

before(() => {
  if (!DB) return;
  db = setupFull(DB);
  // 쓰기 세기: public·realtime·auth 표에서 xmin = 그 트랜잭션인 행(넣거나 바꾼 행)
  db.sql(`create or replace function public._gate_b_writes(p_xid text) returns jsonb language plpgsql as $$
    declare r record; n bigint; tot bigint := 0; t jsonb := '{}'::jsonb;
    begin
      for r in select c.oid::regclass::text as rel from pg_class c join pg_namespace s on s.oid = c.relnamespace
                where c.relkind = 'r' and s.nspname in ('public', 'realtime', 'auth') and c.relname not like '\\_gate\\_b%' loop
        execute format('select count(*) from %s where xmin::text = $1', r.rel) into n using p_xid;
        if n > 0 then t := t || jsonb_build_object(r.rel, n); tot := tot + n; end if;
      end loop;
      return jsonb_build_object('total', tot, 'tables', t);
    end $$;
    create table if not exists public._gate_b_net (id bigserial primary key, url text);
    create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
      language plpgsql as $$ begin insert into public._gate_b_net (url) values (url); return 1; end $$;
    insert into public.msgr_settings (key, value) values ('msgr2_push_url', 'https://edge.test/msgr2-push'), ('msgr2_limit_agent_min', '1000'), ('msgr2_limit_room_min', '1000')
      on conflict (key) do update set value = excluded.value;
    create table if not exists auth.sessions (id uuid primary key, user_id uuid not null, created_at timestamptz not null default now());`);
  // 옛 경로 데이터(조직·공개 방·1:1 방·에이전트 자리) — 옛 트리거는 끄고 넣는다
  db.psql(['-c', `set session_replication_role = replica;
    insert into auth.users (id) values ('${O}'), ('${M}') on conflict do nothing;
    insert into public.msgr_orgs (id, name, slug, owner_user_id) values ('${T}', 'Team', 'team-gb', '${O}');
    insert into public.msgr_org_members (org_id, user_id, role) values ('${T}', '${O}', 'owner'), ('${T}', '${M}', 'member');
    insert into public.msgr_org_entitlements (org_id, plan, seats) values ('${T}', 'team', 10) on conflict (org_id) do update set plan = 'team', seats = 10;
    insert into public.msgr_agents (id, owner_user_id, ws_id, slug) values ('${AGO}', '${O}', 'w1', 'a1');
    insert into public.msgr_crews (id, org_id, owner_user_id, ws_id, slug, display_name, hosting, status, allow, allow_users, agent_id, registered_at, last_seen_at)
      values ('${CREW}', '${T}', '${O}', 'w1', 'a1', 'A', 'local', 'active', 'all', '{}', '${AGO}', now() - interval '1 day', now() - interval '1 hour');
    insert into public.msgr_channels (id, org_id, kind, name, created_by) values ('${PUB}', '${T}', 'public', 'general', '${O}'), ('${DM2}', '${T}', 'dm', 'dm', '${O}');
    insert into public.msgr_channel_members (channel_id, member_kind, member_id) values ('${PUB}', 'user', '${O}'), ('${PUB}', 'user', '${M}'), ('${PUB}', 'crew', '${CREW}'),
      ('${DM2}', 'user', '${O}'), ('${DM2}', 'crew', '${CREW}');
    set session_replication_role = origin;`]);
});

test('옛 경로: 단계마다 쓰기·방송·pg_net', { skip }, () => {
  const s0 = sent(), n0 = net();
  // 1 로그인: 접속 표시 심박(시작 1회) — 읽기 약 30요청은 코드 조사
  call('old', 'login', 'rpc msgr_presence_ping', O, null, `select public.msgr_presence_ping('desktop')`);
  // 3 방 열기: 읽음 upsert(세션 첫 진입은 서버 값과 같아도 쓴다 — read-sync.mjs)
  call('old', 'open', 'upsert msgr_reads', O, null, `insert into public.msgr_reads (channel_id, user_id, last_read_id) values ('${DM2}', '${O}', 0) on conflict (channel_id, user_id) do update set last_read_id = excluded.last_read_id`);
  // 4 글 보내기(1:1 방 — 에이전트에게 지시)
  call('old', 'send', 'insert msgr_messages', O, null, `insert into public.msgr_messages (org_id, channel_id, author_kind, author_user_id, kind, body, mentions) values ('${T}', '${DM2}', 'user', '${O}', 'text', '이거 해줘', '[]')`);
  call('old', 'send', 'upsert msgr_reads', O, null, `update public.msgr_reads set last_read_id = (select max(id) from public.msgr_messages where channel_id = '${DM2}') where channel_id = '${DM2}' and user_id = '${O}'`);
  const src = db.sql(`select max(id) from public.msgr_messages where channel_id = '${DM2}'`);
  // 5 에이전트가 받아 시작: 커서 갱신 + 실행권 + 심박(30초마다 — 2분 일이면 4번)
  call('old', 'agent', 'update msgr_crews.cursor_msg_id', O, null, `update public.msgr_crews set cursor_msg_id = ${src} where id = '${CREW}'`);
  const attempt = randomUUID();
  call('old', 'agent', 'rpc msgr_execution_claim', O, null, `select public.msgr_execution_claim('w1', '${CREW}', ${src}, '${DM2}', '${attempt}')`);
  for (let i = 0; i < 4; i++) {
    db.sql(`update public.msgr_executions set heartbeat_at = now() - interval '1 minute' where attempt = '${attempt}'`);
    call('old', 'agent', 'rpc msgr_execution_heartbeat(30초)', O, null, `select public.msgr_execution_heartbeat('w1', '${CREW}', ${src}, '${DM2}', '${attempt}')`);
  }
  // 6 결재: 결재 행 + 카드 글 + 결재 행에 카드 id + 사람 승인
  const ap = randomUUID();
  call('old', 'approval', 'insert msgr_crew_approvals', O, null, `insert into public.msgr_crew_approvals (id, org_id, channel_id, crew_id, approval_id, action, status, risk, kind, source_msg_id) values ('${ap}', '${T}', '${DM2}', '${CREW}', 'ap-1', '메일 발송', 'pending', 'high', 'action', ${src})`);
  call('old', 'approval', 'insert msgr_messages(approval_card)', O, null, `insert into public.msgr_messages (org_id, channel_id, author_kind, crew_id, kind, body, mentions, meta) values ('${T}', '${DM2}', 'crew', '${CREW}', 'approval_card', '승인 요청', '[]', '{"approval":"ap-1"}')`);
  call('old', 'approval', 'update msgr_crew_approvals.message_id', O, null, `update public.msgr_crew_approvals set message_id = (select max(id) from public.msgr_messages where channel_id = '${DM2}') where id = '${ap}'`);
  call('old', 'approval', 'update msgr_crew_approvals(승인)', O, null, `update public.msgr_crew_approvals set status = 'approved', decided_by = '${O}', decided_at = now() where id = '${ap}'`);
  // 7 결과: 실행 끝(답 글 + 실행 행) + 사람 읽음
  call('old', 'result', 'rpc msgr_execution_finish', O, null, `select public.msgr_execution_finish('w1', '${CREW}', ${src}, '${DM2}', '${attempt}', ${db.lit({ channel_id: DM2, crew_id: CREW, author_kind: 'crew', kind: 'text', client_msg_id: `reply:${CREW}:${src}`, reply_to: String(src), thread_root: String(src), body: '끝' })})`);
  call('old', 'result', 'upsert msgr_reads', O, null, `update public.msgr_reads set last_read_id = (select max(id) from public.msgr_messages where channel_id = '${DM2}') where channel_id = '${DM2}' and user_id = '${O}'`);
  report.oldSent = sent() - s0; report.oldNet = net() - n0;
  // 8 유휴 10분: 본체 심박 13번(약 45초 간격 — 매번 서버 기한 35초를 넘는다), 앱 접속 표시 10번(60초, 창에 초점이 있을 때)
  const s1 = sent();
  for (let i = 0; i < 13; i++) {
    db.sql(`update public.msgr_device_beats set seen_at = now() - interval '45 seconds' where owner_user_id = '${O}'; update public.msgr_crews set last_seen_at = now() - interval '45 seconds' where id = '${CREW}'`);
    call('old', 'idle', 'rpc msgr_device_beat(45초)', O, null, `select public.msgr_device_beat('w1', 'dev-1', '{${CREW}}'::uuid[], '0.1.200')`);
  }
  for (let i = 0; i < 10; i++) call('old', 'idle', 'rpc msgr_presence_ping(60초)', O, null, `select public.msgr_presence_ping('desktop')`);
  report.oldIdleSent = sent() - s1;
  assert.ok(stepSum('old', 'idle') >= 13, `옛 유휴 쓰기 ${stepSum('old', 'idle')}`);
});

test('v2 경로: 단계마다 쓰기·방송·pg_net', { skip }, () => {
  const s0 = sent(), n0 = net();
  // 1 로그인: 본체 runner 등록 + 앱 app 등록(실 GoTrue 세션 대역) + 에이전트 목록
  db.sql(`insert into auth.users (id) values ('${M}') on conflict do nothing`);
  const runSid = randomUUID(), appSid = randomUUID();
  db.sql(`insert into auth.sessions (id, user_id) values ('${runSid}', '${M}'), ('${appSid}', '${M}')`);
  call('v2', 'login', 'rpc msgr2_device_register(runner)', M, runSid, `select public.msgr2_device_register('runner', 'desktop', '0.1.200', 1, 1, '{claude}', null)`);
  call('v2', 'login', 'rpc msgr2_device_register(app)', M, appSid, `select public.msgr2_device_register('app', 'messenger', '0.1.200', null, null, '{}', null)`);
  const devRun = db.sql(`select id from public.msgr2_devices where session_id = '${runSid}'`);
  const seqs = new Map();
  const env = (type, work, agent, data) => { const k = `${work}`; const s = (seqs.get(k) ?? 0) + 1; seqs.set(k, s); return { v: 1, id: randomUUID(), work, seq: s, type, agent, device: devRun, at: new Date().toISOString(), data }; };
  const send = (step, label, e) => call('v2', step, label, M, runSid, `select public.msgr2_link_send(${db.lit(e)})`);
  send('login', 'rpc msgr2_link_send(agent.sync)', { ...env('agent.sync', null, null, { agents: [{ ws: 'w2', slug: 'b1', name: '비', role: '', face_hash: null }] }) });
  const AG = db.sql(`select id from public.msgr2_agents where owner_user_id = '${M}' and slug = 'b1'`);
  // 2 공간 목록: 개인 공간(처음 한 번 만든다)
  call('v2', 'spaces', 'rpc msgr2_my_personal_space', M, appSid, 'select public.msgr2_my_personal_space()');
  const PS = db.sql(`select id from public.msgr2_spaces where owner_user_id = '${M}' and kind = 'personal'`);
  // 에이전트 1:1 방(시험 준비 — 운영에서는 msgr2_agent_dm_open이 처음 한 번 만든다)
  const RM = db.sql(`insert into public.msgr2_rooms (space_id, kind, name, created_by) values ('${PS}', 'private', '', '${M}') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${RM}', 'user', '${M}'), ('${RM}', 'agent', '${AG}')`);
  // 3 방 열기: 쓰기 없음(앱은 REST 읽기 2~4) — 읽음 표시 msgr2_mark_read는 이 판의 앱이 아직 부르지 않는다(U6) — 부르면 값이 커질 때만 1행
  // 4 글 보내기 → 서버가 offer(일·토픽·사건)·방송·푸시
  call('v2', 'send', 'insert msgr2_messages', M, appSid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${RM}', 'user', '${M}', '이거 해줘')`);
  const W = db.sql(`select id from public.msgr2_works where room_id = '${RM}' order by created_at desc limit 1`);
  assert.ok(W, 'offer');
  // 5 본체가 받음: accept(리스·세대) — 진행 표시는 저장하지 않는 방송(쓰기 0)
  const acc = send('agent', 'rpc msgr2_link_send(work.accept)', env('work.accept', W, AG, {}));
  const gen = Number(db.sql(`select lease_gen from public.msgr2_works where id = '${W}'`));
  send('agent', 'rpc msgr2_link_send(work.progress)', env('work.progress', W, AG, { stage: 'thinking', lease_gen: gen }));
  // 6 결재: 요청(카드 글·결재 행·상태) → 사람 결정 → 효과 intent·done
  const ap = randomUUID();
  send('approval', 'rpc msgr2_link_send(work.approval_request)', env('work.approval_request', W, AG, { approval_id: ap, action: '메일 발송', risk: 'high', summary: '3명', effect_key: 'mail-1', expires_at: new Date(Date.now() + 3600e3).toISOString() }));
  call('v2', 'approval', 'rpc msgr2_approval_decide', M, appSid, `select public.msgr2_approval_decide('${ap}', 'approve')`);
  send('approval', 'rpc msgr2_link_send(work.effect intent)', env('work.effect', W, AG, { effect_key: 'mail-1', state: 'intent', kind: 'mail' }));
  send('approval', 'rpc msgr2_link_send(work.effect done)', env('work.effect', W, AG, { effect_key: 'mail-1', state: 'done' }));
  // 7 결과
  send('result', 'rpc msgr2_link_send(work.result)', env('work.result', W, AG, { text: '끝', files: [], handoffs: [] }));
  assert.equal(db.sql(`select state from public.msgr2_works where id = '${W}'`), 'done');
  report.v2Sent = sent() - s0; report.v2Net = net() - n0;
  // 8 유휴 10분: 주기 요청 없음(앱·본체 — 코드 조사). 따라잡기는 재접속 때만 — 한 번 불러도 쓰기 0인지 본다
  const s1 = sent();
  call('v2', 'idle', 'rpc msgr2_link_pending(재접속 때만)', M, runSid, 'select public.msgr2_link_pending()');
  call('v2', 'idle', 'rpc msgr2_catch_up(재접속 때만)', M, appSid, 'select public.msgr2_catch_up(0)');
  report.v2IdleSent = sent() - s1;
  assert.equal(stepSum('v2', 'idle'), 0, 'v2 유휴(재접속 따라잡기 포함) 쓰기 0');
  void acc;
});

test('요약을 남긴다', { skip }, () => {
  const steps = ['login', 'spaces', 'open', 'send', 'agent', 'approval', 'result', 'idle'];
  report.summary = Object.fromEntries(steps.map((s) => [s, { old: stepSum('old', s), v2: stepSum('v2', s) }]));
  if (process.env.GATE_B_OUT) writeFileSync(process.env.GATE_B_OUT, JSON.stringify(report, null, 2));
  console.log('# 게이트 B 쓰기 요약', JSON.stringify(report.summary), 'old 방송', report.oldSent, '/ v2 방송', report.v2Sent, '/ old pg_net', report.oldNet, '/ v2 pg_net', report.v2Net,
    '/ 유휴 방송 old', report.oldIdleSent, 'v2', report.v2IdleSent);
  assert.ok(report.summary.idle.v2 < report.summary.idle.old);
});
