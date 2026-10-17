// 메신저 v2 U2 — 일·약속 서버 흐름(설계 7절 경우 8·9·16·17·18·20·21·22, D8·D11·D12·D13·D15).
// 사람 글 → offer(방송·따라잡기) → accept(리스·세대) → 진행·효과·승인·결과(파일·넘김) → 끝. 늦은 결과(work.late), 취소, 상한, 등급, 기기, 쉬는 동안 쓰기 0.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-work-flow-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateEnvelope, jsonBytes, LIMITS } from '../packages/agent-link/contract/v1.mjs';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-work-flow-pg.test.mjs';
const O = '40000000-0000-4000-8000-000000000001', M = '40000000-0000-4000-8000-000000000002', G = '40000000-0000-4000-8000-000000000003';

let db, oApp, oRun1, oRun2, oIdle, mApp, gApp, PS, TS, DM, TR, GR, AG, AG2;
const seqs = new Map();
const agentOf = (work) => db.sql(`select agent_id from public.msgr2_works where id = '${work}'`) || AG;
const env = (type, { work, agent = work ? agentOf(work) : AG, dev = oRun1, data = {}, seq, id = randomUUID() } = {}) => {
  const k = `${work}|${dev.dev}`; const s = seq ?? (seqs.get(k) ?? 0) + 1; seqs.set(k, s);
  return { v: 1, id, work: work ?? null, seq: s, type, agent, device: dev.dev, at: new Date().toISOString(), data };
};
const send = (dev, e) => db.send(dev.uid, dev.sid, e);
const say = (who, room, body, mentions = []) => db.as(who.uid, who.sid,
  `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, mentions) values ('${room}', 'user', '${who.uid}', '${body.replace(/'/g, "''")}', '{${mentions.join(',')}}') returning id`);
const lastWork = (room) => db.sql(`select id from public.msgr2_works where room_id = '${room}' order by created_at desc, id limit 1`);
const workRow = (id) => JSON.parse(db.sql(`select to_jsonb(w) from public.msgr2_works w where id = '${id}'`));
const status = (who, id) => JSON.parse(db.as(who.uid, who.sid, `select public.msgr2_work_status('${id}')`));
const pending = (dev) => JSON.parse(db.as(dev.uid, dev.sid, 'select public.msgr2_link_pending()'));
const expireLease = (id) => db.sql(`update public.msgr2_works set lease_until = now() - interval '1 second' where id = '${id}';
  update public.msgr2_agent_leases set lease_until = now() - interval '1 second'`);
const accept = (id, dev = oRun1, data = {}) => send(dev, env('work.accept', { work: id, dev, data }));
const result = (id, data = {}, dev = oRun1) => send(dev, env('work.result', { work: id, dev, data: { text: '끝', files: [], handoffs: [], ...data } }));
const writes = () => ['msgr2_works', 'msgr2_work_events', 'msgr2_agent_leases', 'msgr2_messages', 'msgr2_effects', 'msgr2_approvals', 'msgr2_room_counters', 'msgr2_agents', 'msgr2_topics']
  .map((t) => `${t}:${db.sql(`select count(*) || '/' || coalesce(max(xmin::text::bigint), 0) from public.${t}`)}`).join(' ');

before(() => {
  if (!DB) return;
  db = setup(DB);
  // 분당 상한(D11 기본 10·30)은 시험이 한 분 안에 일을 많이 만들어 걸린다 — 크게 두고, 상한 시험만 낮춘다
  db.sql(`create table if not exists public.msgr_settings (key text primary key, value text);
    insert into public.msgr_settings values ('msgr2_limit_agent_min', '1000'), ('msgr2_limit_room_min', '1000') on conflict (key) do update set value = excluded.value`);
  oApp = seedDevice(db, O, 'app'); oRun1 = seedDevice(db, O, 'runner'); oRun2 = seedDevice(db, O, 'runner'); oIdle = seedDevice(db, O, 'resident', { runners: [] });
  mApp = seedDevice(db, M, 'app'); gApp = seedDevice(db, G, 'app');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${O}') returning id`);
  TS = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', '팀', '${O}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${O}', 'owner'), ('${TS}', '${O}', 'owner'), ('${TS}', '${M}', 'member'), ('${TS}', '${G}', 'guest')`);
  AG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${O}', 'w', 'a', '에이') returning id`);
  AG2 = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${O}', 'w', 'b', '비') returning id`);
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id, allow) values ('${AG}', '${TS}', 'all'), ('${AG2}', '${TS}', 'owner')`);
  DM = db.sql(`insert into public.msgr2_rooms (space_id, kind, pair_key) values ('${PS}', 'direct', 'o-a') returning id`);
  TR = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'private', '팀방') returning id`);
  GR = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'private', '손님방') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values
    ('${DM}', 'user', '${O}'), ('${DM}', 'agent', '${AG}'),
    ('${TR}', 'user', '${O}'), ('${TR}', 'user', '${M}'), ('${TR}', 'agent', '${AG}'), ('${TR}', 'agent', '${AG2}'),
    ('${GR}', 'user', '${O}'), ('${GR}', 'user', '${G}'), ('${GR}', 'agent', '${AG}')`);
});

test('경우 16·1:1 — 사람 글이 offer가 되고(등급 owner·토픽 생성·문맥에서 원글 제외), w:<주인>으로 방송되며 그 봉투가 약속 v1에 맞는다', { skip }, () => {
  say(oApp, DM, '첫 대화');
  const id = lastWork(DM); const w = workRow(id);
  assert.equal(w.state, 'offered'); assert.equal(w.tier, 'owner'); assert.equal(w.owner_user_id, O); assert.equal(w.from_kind, 'user');
  assert.equal(db.sql(`select work_id from public.msgr2_topics where id = '${w.topic_id}'`), id, 'D4 일 1건 = 토픽 1개');
  const sent = JSON.parse(db.sql(`select payload from realtime.sent where topic = 'w:${O}' and payload->'envelope'->>'work' = '${id}'`));
  const offer = sent.envelope;
  assert.equal(offer.type, 'work.offer'); assert.equal(offer.data.text, '첫 대화');
  const v = validateEnvelope(offer, { from: 'server' }); assert.ok(v.ok, JSON.stringify(v));
  assert.equal(offer.data.context.length, 0, '원글은 text로, 문맥에서 빠진다');
});

test('경우 17 — 문맥은 16KB 안에서 최근 글부터 싣고, 시간순이며 지운 글·시스템 글은 빠진다', { skip }, () => {
  for (let i = 0; i < 12; i++) db.sql(`insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${DM}', 'user', '${O}', '${String(i).padStart(2, '0')}${'가'.repeat(700)}')`);
  db.sql(`update public.msgr2_messages set deleted_at = now() where room_id = '${DM}' and body like '11%'`);
  say(oApp, DM, '요약해줘');
  const offer = JSON.parse(db.sql(`select envelope from public.msgr2_work_events where work_id = '${lastWork(DM)}' and type = 'work.offer'`));
  assert.ok(jsonBytes(offer.data.context) <= LIMITS.contextBytes, `${jsonBytes(offer.data.context)}B`);
  assert.ok(offer.data.context.length >= 5 && offer.data.context.length < 12, `${offer.data.context.length}개`);
  const ids = offer.data.context.map((c) => c.id); assert.deepEqual(ids, [...ids].sort((a, b) => a - b), '시간순');
  assert.ok(!offer.data.context.some((c) => c.text.startsWith('11')), '지운 글 제외');
  assert.ok(offer.data.context.at(-1).text.startsWith('10'), '가장 최근 글 포함');
  assert.ok(validateEnvelope(offer, { from: 'server' }).ok);
});

test('따라잡기 — 러너 있는 본체는 살아 있는 offer를 받고, 러너 없는 본체·앱 기기는 못 받으며, 두 번 불러도 쓰기 0', { skip }, () => {
  const p = pending(oRun1); assert.equal(p.ok, true);
  assert.ok(p.envelopes.some((e) => e.type === 'work.offer' && e.work === lastWork(DM)));
  assert.equal(pending(oIdle).envelopes.length, 0, '러너 없음');
  assert.equal(pending(oApp).code, 'device_unknown', '앱 기기는 본체 입구를 못 쓴다');
  const before1 = writes(); pending(oRun1); pending(oRun2); assert.equal(writes(), before1, '유휴 따라잡기 쓰기 0');
});

test('경우 9·D8 — accept는 에이전트 리스를 CAS로 잡고(세대 1), 다른 기기는 lease_held, 연장은 같은 기기 + 현재 세대만', { skip }, () => {
  const id = lastWork(DM);
  const a = accept(id); assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.state, 'accepted'); assert.equal(a.lease_gen, 1);
  assert.equal(accept(id, oRun2).code, 'lease_held', '다른 기기');
  assert.equal(accept(id, oRun1, {}).code, 'lease_held', '재시작한 본체(세대 모름)는 살아 있는 리스를 가로채지 못한다');
  assert.equal(accept(id, oRun1, { lease_gen: 2 }).code, 'lease_held', '틀린 세대');
  const ext = accept(id, oRun1, { lease_gen: 1 }); assert.equal(ext.ok, true); assert.equal(ext.state, 'accepted'); assert.equal(ext.lease_gen, 1);
  // 같은 에이전트의 다른 offer도 리스를 쥔 기기만 잡는다
  const id1 = lastWork(DM); say(oApp, DM, '하나 더'); const id2 = lastWork(DM); assert.notEqual(id1, id2);
  assert.equal(accept(id2, oRun2).code, 'lease_held', '에이전트 리스는 기기 한 대');
  assert.ok(!pending(oRun2).envelopes.some((e) => e.work === id2), '리스를 남이 쥔 에이전트의 offer는 따라잡기에 안 나온다');
  assert.equal(accept(id2).ok, true);
});

test('같은 봉투 다시 보내기는 쓰기 없이 duplicate, 같은 seq에 다른 봉투는 seq_conflict, 모르는 일·남의 일은 work_not_found', { skip }, () => {
  const id = lastWork(DM);
  const e = env('work.progress', { work: id, data: { stage: 'thinking' } });
  assert.equal(send(oRun1, e).ok, true);
  const p = env('work.effect', { work: id, data: { effect_key: 'dup-k', state: 'intent' } });
  assert.equal(send(oRun1, p).ok, true);
  const w0 = writes(); const again = send(oRun1, p); assert.deepEqual(again, { ok: true, duplicate: true }); assert.equal(writes(), w0, '재전송 쓰기 0');
  assert.equal(send(oRun1, { ...p, id: randomUUID() }).code, 'seq_conflict');
  assert.equal(send(oRun1, env('work.accept', { work: randomUUID() })).code, 'work_not_found');
  assert.equal(send(oRun1, env('work.accept', { work: id, agent: AG2 })).code, 'work_not_found', '에이전트가 다르다');
});

test('progress는 리스 기기만·기록 없음, 다른 기기의 봉투는 not_lease_holder', { skip }, () => {
  const id = lastWork(DM);
  const n0 = db.sql(`select count(*) from public.msgr2_work_events where work_id = '${id}'`);
  assert.equal(send(oRun1, env('work.progress', { work: id, data: { stage: 'tool', note: '검색' } })).ok, true);
  assert.equal(db.sql(`select count(*) from public.msgr2_work_events where work_id = '${id}'`), n0, 'progress는 쓰지 않는다');
  assert.equal(send(oRun2, env('work.progress', { work: id, dev: oRun2, data: { stage: 'tool' } })).code, 'not_lease_holder');
  assert.equal(send(oRun2, env('work.result', { work: id, dev: oRun2, data: { text: 'x', files: [], handoffs: [] } })).code, 'not_lease_holder');
});

test('경우 21·D13 — 효과는 intent 먼저(같은 키 두 번은 effect_exists), intent 없는 done은 effect_unknown, 결과를 모르는 효과는 상태 보기에 나온다', { skip }, () => {
  const id = lastWork(DM);
  assert.equal(send(oRun1, env('work.effect', { work: id, data: { effect_key: 'mail-1', state: 'intent', kind: 'mail' } })).ok, true);
  assert.equal(send(oRun1, env('work.effect', { work: id, data: { effect_key: 'mail-1', state: 'intent' } })).code, 'effect_exists');
  assert.equal(send(oRun1, env('work.effect', { work: id, data: { effect_key: 'nope', state: 'done' } })).code, 'effect_unknown');
  assert.equal(send(oRun1, env('work.effect', { work: id, data: { effect_key: 'mail-1', state: 'done' } })).ok, true);
  assert.equal(db.sql(`select state from public.msgr2_effects where effect_key = 'mail-1'`), 'done');
  assert.deepEqual(status(oApp, id).unknown_effects, [], '일하는 중에는 모름 표시 없음');
});

test('결과 — 업로드 슬롯 파일이 첨부가 되고(서버가 정한 방 폴더 경로), 일이 done, 연속 카운터 +1, 끝난 일에 다시 보내면 work_closed', { skip }, () => {
  const id = lastWork(DM);
  const slot = JSON.parse(db.as(O, oRun1.sid, `select public.msgr2_link_upload_slot('${id}', '../보고서.pdf', 1234)`));
  assert.equal(slot.ok, true, JSON.stringify(slot)); assert.equal(slot.bucket, 'msgr');
  assert.match(slot.path, new RegExp(`^${PS}/${DM}/${slot.slot}/__보고서\\.pdf$`), '이름의 /·..는 _로');
  assert.equal(JSON.parse(db.as(O, oRun2.sid, `select public.msgr2_link_upload_slot('${id}', 'a.txt', 1)`)).code, 'not_lease_holder');
  assert.equal(result(id, { files: [randomUUID()] }).code, 'upload_slot_invalid', '남의·없는 슬롯');
  const r = result(id, { text: '보고서입니다', files: [slot.slot], usage: { input_tokens: 10, output_tokens: 5, runner: 'claude' } });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.state, 'done');
  const msg = JSON.parse(db.sql(`select to_jsonb(m) from public.msgr2_messages m where work_id = '${id}' and author_kind = 'agent'`));
  assert.equal(msg.body, '보고서입니다'); assert.equal(msg.author_agent_id, AG); assert.equal(msg.meta.work, id); assert.equal(msg.meta.mark, undefined);
  assert.equal(db.sql(`select storage_path from public.msgr2_attachments where message_id = ${msg.id}`), `msgr/${slot.path}`);
  assert.equal(db.sql(`select agent_streak from public.msgr2_room_counters where room_id = '${DM}'`), '1');
  assert.equal(result(id).code, 'work_closed');
  assert.equal(status(oApp, id).state, 'done');
});

test('경우 8·20 — 리스가 끝난 일은 stalled: 다른 기기 거부, 재시작(세대 모름) 거부, 새 intent 거부, 같은 기기 늦은 결과는 받고 work.late 표시', { skip }, () => {
  say(oApp, DM, '느린 일'); const id = lastWork(DM);
  assert.equal(accept(id).lease_gen, 1);
  assert.equal(send(oRun1, env('work.effect', { work: id, data: { effect_key: 'pay-1', state: 'intent' } })).ok, true);
  expireLease(id);
  assert.equal(status(oApp, id).state, 'stalled'); assert.deepEqual(status(oApp, id).unknown_effects, ['pay-1'], '결과 모르는 효과');
  assert.equal(accept(id, oRun2, { lease_gen: 1 }).code, 'not_lease_holder', '다른 기기');
  assert.equal(accept(id, oRun1, {}).code, 'not_lease_holder', '재시작한 본체는 이어 하지 못한다(처음부터 다시 돌리지 않는다)');
  assert.equal(send(oRun1, env('work.effect', { work: id, data: { effect_key: 'pay-2', state: 'intent' } })).code, 'invalid_transition', 'stalled에 새 intent 금지');
  const late = result(id, { text: '늦었지만 끝' }); assert.equal(late.ok, true); assert.equal(late.state, 'done');
  assert.equal(workRow(id).late, true);
  assert.equal(db.sql(`select meta->>'mark' from public.msgr2_messages where work_id = '${id}' and author_kind = 'agent'`), 'work.late');
});

test('stalled 이어 하기 — 같은 기기 + 직전 세대면 running으로 리스를 다시 잡는다', { skip }, () => {
  say(oApp, DM, '이어 하기'); const id = lastWork(DM);
  accept(id); expireLease(id);
  const r = accept(id, oRun1, { lease_gen: 1 }); assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.state, 'running'); assert.equal(r.lease_gen, 1, '이어 하기는 세대 그대로');
  assert.equal(status(oApp, id).state, 'running');
  // 늦은 error도 같은 규칙(stalled → failed + work.late)
  expireLease(id);
  assert.equal(send(oRun1, env('work.error', { work: id, data: { code: 'weird_code', runner: 'claude' } })).state, 'failed');
  const sys = JSON.parse(db.sql(`select meta from public.msgr2_messages where work_id = '${id}' and author_kind = 'system'`));
  assert.deepEqual(sys, { code: 'work.error', error: 'internal', agent: AG, work: id, mark: 'work.late' }, 'D15 코드 + 값, 모르는 코드는 internal');
  assert.equal(db.sql(`select body from public.msgr2_messages where work_id = '${id}' and author_kind = 'system'`), '', '원문 없음');
});

test('취소 — 지시한 사람이 취소하면 cancelled + 리스 기기에 work.cancel(따라잡기에도), 본체의 cancelled 오류는 기록만, 끝난 일 취소는 쓰기 0', { skip }, () => {
  say(oApp, DM, '취소할 일'); const id = lastWork(DM); accept(id);
  assert.equal(db.as(O, oApp.sid, `select public.msgr2_work_cancel('${id}')`), 'cancelled');
  const p = pending(oRun1); assert.ok(p.envelopes.some((e) => e.type === 'work.cancel' && e.work === id));
  assert.ok(validateEnvelope(p.envelopes.find((e) => e.type === 'work.cancel' && e.work === id), { from: 'server' }).ok);
  assert.equal(send(oRun1, env('work.error', { work: id, data: { code: 'cancelled', runner: 'claude' } })).state, 'cancelled');
  const w0 = writes(); assert.equal(db.as(O, oApp.sid, `select public.msgr2_work_cancel('${id}')`), 'cancelled'); assert.equal(writes(), w0);
  assert.match(db.asErr(M, mApp.sid, `select public.msgr2_work_cancel('${id}')`) ?? '', /msgr2_work_not_found/, '방을 못 읽는 사람');
});

test('경우 22·승인 — approval_request는 카드 글 + awaiting_approval, 결정은 앱 기기의 에이전트 주인만, 결정은 리스 기기로 간다', { skip }, () => {
  say(oApp, DM, '메일 보내줘'); const id = lastWork(DM); accept(id);
  const apId = randomUUID();
  const r = send(oRun1, env('work.approval_request', { work: id, data: { approval_id: apId, action: '메일 발송', risk: 'high', summary: '3명에게 발송', effect_key: 'mail-9', expires_at: new Date(Date.now() + 3600e3).toISOString() } }));
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.state, 'awaiting_approval');
  const card = JSON.parse(db.sql(`select to_jsonb(m) from public.msgr2_messages m where id = (select card_message_id from public.msgr2_approvals where id = '${apId}')`));
  assert.equal(card.kind, 'card'); assert.equal(card.meta.code, 'approval.request'); assert.equal(card.meta.approval, apId);
  assert.match(db.asErr(O, oRun1.sid, `select public.msgr2_approval_decide('${apId}', 'approve')`) ?? '', /msgr2_app_device_required/);
  assert.equal(db.as(O, oApp.sid, `select public.msgr2_approval_decide('${apId}', 'approve')`), 'approved');
  assert.equal(status(oApp, id).state, 'running');
  const dec = pending(oRun1).envelopes.find((e) => e.type === 'work.approval_decision' && e.work === id);
  assert.equal(dec.data.decision, 'approve'); assert.ok(validateEnvelope(dec, { from: 'server' }).ok);
  assert.equal(db.as(O, oApp.sid, `select public.msgr2_approval_decide('${apId}', 'reject')`), 'approved', '이미 정함 → 그대로');
});

test('D12 등급 — 손님이 있는 방의 일은 guest: 효과·승인 요청·파일 결과·업로드 슬롯은 tier_denied, 글 결과는 된다', { skip }, () => {
  say(gApp, GR, '손님 질문', [AG]); const id = lastWork(GR);
  assert.equal(workRow(id).tier, 'guest'); assert.equal(accept(id).ok, true);
  assert.equal(send(oRun1, env('work.effect', { work: id, data: { effect_key: 'g-1', state: 'intent' } })).code, 'tier_denied');
  assert.equal(JSON.parse(db.as(O, oRun1.sid, `select public.msgr2_link_upload_slot('${id}', 'a.txt', 1)`)).code, 'tier_denied');
  assert.equal(result(id, { text: '답' }).ok, true);
});

test('팀 방 멘션 — 파견 allow all이면 멤버의 멘션이 offer, allow owner인 에이전트는 주인 말만 듣는다, 멘션 없는 여럿 방은 offer 없음', { skip }, () => {
  const n0 = Number(db.sql(`select count(*) from public.msgr2_works where room_id = '${TR}'`));
  say(mApp, TR, '에이 해줘', [AG]); assert.equal(Number(db.sql(`select count(*) from public.msgr2_works where room_id = '${TR}'`)), n0 + 1);
  assert.equal(workRow(lastWork(TR)).tier, 'team'); assert.equal(workRow(lastWork(TR)).root_user_id, M);
  say(mApp, TR, '비 해줘', [AG2]); assert.equal(Number(db.sql(`select count(*) from public.msgr2_works where room_id = '${TR}'`)), n0 + 1, 'allow owner');
  say(oApp, TR, '비 해줘', [AG2]); assert.equal(Number(db.sql(`select count(*) from public.msgr2_works where room_id = '${TR}'`)), n0 + 2, '주인은 된다');
  say(mApp, TR, '그냥 대화'); assert.equal(Number(db.sql(`select count(*) from public.msgr2_works where room_id = '${TR}'`)), n0 + 2);
});

test('넘김 — 결과의 handoffs는 같은 토픽에 에이전트발 offer(depth+1·parent), 연속 상한(8)에서 멈추고 상한 글은 한 번, 사람 글이 오면 풀린다', { skip }, () => {
  say(oApp, TR, '둘이 같이', [AG]); const id = lastWork(TR); const acc = accept(id); assert.equal(acc.ok, true, JSON.stringify(acc));
  const rr = result(id, { text: '비에게 넘김', handoffs: [{ agent: AG2, text: '이어서 해줘' }] }); assert.equal(rr.ok, true, JSON.stringify(rr));
  const child = JSON.parse(db.sql(`select to_jsonb(w) from public.msgr2_works w where parent_work_id = '${id}'`));
  assert.equal(child.agent_id, AG2); assert.equal(child.depth, 1); assert.equal(child.from_kind, 'agent'); assert.equal(child.from_id, AG);
  assert.equal(child.root_user_id, O); assert.equal(child.topic_id, workRow(id).topic_id, '같은 토픽');
  // 연속 상한
  db.sql(`update public.msgr2_room_counters set agent_streak = 8, streak_noted = false where room_id = '${TR}'`);
  const ca = accept(child.id, oRun1); assert.equal(ca.ok, true, JSON.stringify(ca) + JSON.stringify(child));
  assert.equal(result(child.id, { handoffs: [{ agent: AG, text: '다시 에이에게' }] }).ok, true);
  assert.equal(db.sql(`select count(*) from public.msgr2_works where parent_work_id = '${child.id}'`), '0', '상한에서 멈춤');
  const lim = () => db.sql(`select count(*) from public.msgr2_messages where room_id = '${TR}' and meta->>'code' = 'work.limit' and meta->>'limit' = 'streak'`);
  assert.equal(lim(), '1');
  assert.equal(db.sql(`select agent_streak from public.msgr2_room_counters where room_id = '${TR}'`), '9');
  say(oApp, TR, '사람이 말함');
  assert.equal(db.sql(`select agent_streak || '/' || streak_noted from public.msgr2_room_counters where room_id = '${TR}'`), '0/false');
});

test('D11 분당 상한 — msgr_settings 값으로 에이전트 분당 offer를 막고 시스템 글(code work.limit, limit agent_minute)을 남긴다', { skip }, () => {
  db.sql(`update public.msgr_settings set value = '1' where key = 'msgr2_limit_agent_min'`);
  try {
    const n0 = db.sql(`select count(*) from public.msgr2_works where agent_id = '${AG}'`);
    say(oApp, DM, '막혀야 함');
    assert.equal(db.sql(`select count(*) from public.msgr2_works where agent_id = '${AG}'`), n0);
    assert.equal(db.sql(`select meta->>'limit' from public.msgr2_messages where room_id = '${DM}' and meta->>'code' = 'work.limit' order by id desc limit 1`), 'agent_minute');
  } finally { db.sql(`update public.msgr_settings set value = '1000' where key = 'msgr2_limit_agent_min'`); }
});

test('기기·중단 — 폐기·만료 기기는 그 코드로, 봉투의 device가 내 기기가 아니면 device_unknown, 중단 스위치는 service_paused', { skip }, () => {
  const rev = seedDevice(db, O, 'runner', { revoked: true }); const exp = seedDevice(db, O, 'runner', { expired: true });
  assert.equal(send(rev, env('work.accept', { work: lastWork(DM), dev: rev })).code, 'device_revoked');
  assert.equal(send(exp, env('work.accept', { work: lastWork(DM), dev: exp })).code, 'device_expired');
  assert.equal(send(oRun1, { ...env('work.accept', { work: lastWork(DM) }), device: oRun2.dev }).code, 'device_unknown', '남의 기기 id');
  db.sql(`insert into public.msgr_settings values ('msgr2_paused', '2026-10-17T06:00:00Z') on conflict (key) do update set value = excluded.value`);
  try { assert.equal(send(oRun1, env('work.accept', { work: lastWork(DM) })).code, 'service_paused'); assert.equal(pending(oRun1).code, 'service_paused'); }
  finally { db.sql(`delete from public.msgr_settings where key = 'msgr2_paused'`); }
  assert.equal(send(oRun1, { ...env('work.accept', { work: lastWork(DM) }), v: 2 }).code, 'link_version_unsupported');
  assert.equal(send(oRun1, env('work.offer', { work: lastWork(DM) })).code, 'wrong_direction');
});

test('agent.sync — 본체의 에이전트 목록을 등록하고 id를 돌려주며, 같은 목록을 다시 보내면 에이전트 표 쓰기 0', { skip }, () => {
  const agents = [{ ws: 'w', slug: 'a', name: '에이', role: '', face_hash: null }, { ws: 'w', slug: 'c', name: '씨', role: '새로', face_hash: 'h1' }];
  const r = send(oRun1, env('agent.sync', { work: null, agent: null, data: { agents } })); assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.agents.map((a) => a.slug), ['a', 'c']); assert.equal(r.agents[0].id, AG);
  const x0 = db.xmins('msgr2_agents', `owner_user_id = '${O}'`);
  assert.equal(send(oRun1, env('agent.sync', { work: null, agent: null, data: { agents } })).ok, true);
  assert.equal(db.xmins('msgr2_agents', `owner_user_id = '${O}'`), x0, '두 번째 동기화 쓰기 0');
});

test('앱 따라잡기·상태 보기 — 읽을 수 있는 방의 since 뒤 글만, 두 번 불러도 쓰기 0, 못 읽는 일의 상태는 null', { skip }, () => {
  const c = JSON.parse(db.as(M, mApp.sid, 'select public.msgr2_catch_up(0)'));
  const rooms = c.rooms.map((r) => r.room_id);
  assert.ok(rooms.includes(TR)); assert.ok(!rooms.includes(DM), '남의 개인 방'); assert.ok(!rooms.includes(GR), '안 들어간 방');
  const maxId = Math.max(...c.rooms.find((r) => r.room_id === TR).messages.map((m) => m.id));
  assert.equal(JSON.parse(db.as(M, mApp.sid, `select public.msgr2_catch_up(${maxId})`)).rooms.length, 0);
  const w0 = writes(); db.as(M, mApp.sid, 'select public.msgr2_catch_up(0)'); db.as(O, oApp.sid, 'select public.msgr2_catch_up(0)'); status(oApp, lastWork(DM));
  assert.equal(writes(), w0, '조회 쓰기 0');
  assert.equal(db.as(M, mApp.sid, `select public.msgr2_work_status('${lastWork(DM)}')`), '', '못 읽는 일');
});

test('토픽 해결 — 쓸 수 있는 사람이 해결하면 시스템 글(topic.resolved) 한 번, 다시 하면 쓰기 0', { skip }, () => {
  const tp = workRow(lastWork(TR)).topic_id;
  assert.equal(db.as(M, mApp.sid, `select public.msgr2_topic_resolve('${tp}')`), 't');
  const w0 = writes(); assert.equal(db.as(M, mApp.sid, `select public.msgr2_topic_resolve('${tp}')`), 'f'); assert.equal(writes(), w0);
  assert.equal(db.sql(`select count(*) from public.msgr2_messages where topic_id = '${tp}' and meta->>'code' = 'topic.resolved'`), '1');
});

test('권한 — anon은 입구를 못 부르고, 사람은 내부 함수·사건 표를 직접 못 쓴다, 일 표는 읽을 수 있는 방만 보인다', { skip }, () => {
  for (const f of ['msgr2_link_send(\'{}\'::jsonb)', 'msgr2_link_pending()', 'msgr2_catch_up(0)']) {
    const r = db.raw(['-A', '-t', '-c', `set role anon; select public.${f}`]); assert.notEqual(r.status, 0, f); assert.match(r.stderr, /permission denied/);
  }
  for (const f of ['_msgr2_make_offer(uuid, uuid, uuid, text, uuid, uuid, text, bigint, uuid, integer)', '_msgr2_server_event(uuid, text, uuid, jsonb)', '_msgr2_system_msg(uuid, uuid, uuid, jsonb)']) {
    assert.equal(db.sql(`select has_function_privilege('authenticated', 'public.${f}', 'execute')`), 'f', f);
  }
  assert.match(db.asErr(O, oApp.sid, `insert into public.msgr2_work_events (sender, seq, type, envelope_id, envelope) values ('runner', 1, 'x', gen_random_uuid(), '{}')`) ?? '', /permission denied/);
  assert.match(db.asErr(O, oApp.sid, `update public.msgr2_works set state = 'done'`) ?? '', /permission denied/);
  assert.equal(db.as(M, mApp.sid, `select count(*) from public.msgr2_works where room_id = '${DM}'`), '0');
  assert.ok(Number(db.as(M, mApp.sid, `select count(*) from public.msgr2_works where room_id = '${TR}'`)) > 0);
});

test('U5 맞춤 — 중단 읽기는 꺼지면 null·켜지면 {paused, since}, 중단 중 사람 글은 service_paused, 따라잡기는 paused로 답한다', { skip }, () => {
  assert.equal(db.as(M, mApp.sid, 'select public.msgr2_service_pause()'), '');
  db.sql(`insert into public.msgr_settings values ('msgr2_paused', '2026-10-17T06:00:00Z'), ('msgr_paused', '2026-10-16T17:00:00+09:00') on conflict (key) do update set value = excluded.value`);
  try {
    assert.deepEqual(JSON.parse(db.as(M, mApp.sid, 'select public.msgr2_service_pause()')), { paused: true, since: '2026-10-17T06:00:00Z' });
    assert.match(db.asErr(mApp.uid, mApp.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${TR}', 'user', '${M}', '중단 중')`) ?? '', /service_paused/);
    const c = JSON.parse(db.as(M, mApp.sid, 'select public.msgr2_catch_up(null)')); assert.equal(c.paused, true); assert.deepEqual(c.rooms, []);
  } finally { db.sql(`delete from public.msgr_settings where key = 'msgr2_paused'`); }
  // 옛 메신저 스위치(msgr_paused)만 켜져 있으면 v2는 멈추지 않는다
  assert.equal(db.as(M, mApp.sid, 'select public.msgr2_service_pause()'), '', '옛 스위치와 별개');
  db.sql(`delete from public.msgr_settings where key = 'msgr_paused'`);
});

test('U5 맞춤 — 따라잡기는 방마다 최근 200개(more), next_since는 60초보다 오래된 글까지만 올린다(커밋 순서 대비)', { skip }, () => {
  const R = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'private', '긴방') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${R}', 'user', '${M}')`);
  db.sql(`insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, created_at) select '${R}', 'user', '${M}', 'old' || g, now() - interval '10 minutes' from generate_series(1, 230) g`);
  const fresh = Number(db.sql(`insert into public.msgr2_messages (room_id, author_kind, author_user_id, body) values ('${R}', 'user', '${M}', 'fresh') returning id`));
  const c = JSON.parse(db.as(M, mApp.sid, 'select public.msgr2_catch_up(null)'));
  const room = c.rooms.find((r) => r.room_id === R);
  assert.equal(room.messages.length, 200); assert.equal(room.more, true); assert.equal(room.messages.at(-1).id, fresh, '최근 글 포함');
  assert.ok(c.next_since < fresh, 'next_since는 최근 60초 글 앞에서 멈춘다');
  assert.equal(c.next_since, Number(db.sql(`select max(id) from public.msgr2_messages where created_at < now() - interval '60 seconds'`)));
  const again = JSON.parse(db.as(M, mApp.sid, `select public.msgr2_catch_up(${c.next_since})`));
  assert.ok(again.rooms.find((r) => r.room_id === R).messages.some((m) => m.id === fresh), '다음 따라잡기에서 최근 글이 다시 온다(앱이 id로 거른다)');
});

test('U5 맞춤 — 사람 첨부는 msgr2_attachment_add(글, 순번, 이름, mime, 크기)가 행과 경로를 만들고, 같은 순번은 다시 만들지 않으며, 남의 글은 거부', { skip }, () => {
  const mid = say(mApp, TR, '파일 첨부');
  const a = JSON.parse(db.as(M, mApp.sid, `select public.msgr2_attachment_add(${mid}, 0, 'a/b..pdf', 'application/pdf', 10)`));
  assert.equal(a.ok, true); assert.equal(a.existing, false); assert.equal(a.bucket, 'msgr');
  assert.equal(a.path, `${TS}/${TR}/${mid}/0-a_b_pdf`);
  const b = JSON.parse(db.as(M, mApp.sid, `select public.msgr2_attachment_add(${mid}, 0, 'a/b..pdf', 'application/pdf', 10)`));
  assert.equal(b.existing, true); assert.equal(b.attachment_id, a.attachment_id); assert.equal(b.path, a.path);
  assert.equal(db.sql(`select count(*) from public.msgr2_attachments where message_id = ${mid}`), '1');
  assert.match(db.asErr(O, oApp.sid, `select public.msgr2_attachment_add(${mid}, 1, 'x.txt', null, 1)`) ?? '', /msgr2_message_not_found/, '남의 글');
  assert.match(db.asErr(M, mApp.sid, `select public.msgr2_attachment_add(${mid}, 20, 'x.txt', null, 1)`) ?? '', /msgr2_bad_attachment/);
  assert.match(db.asErr(M, mApp.sid, `insert into public.msgr2_attachments (message_id, room_id, storage_path) values (${mid}, '${TR}', 'msgr/${TS}/${TR}/x')`) ?? '', /permission denied/, '직접 넣기는 여전히 막힘');
});

test('offer.peers — 넘김할 수 있는 동료만 싣고(자기 제외·파견 허용으로 거름), guest 일은 빈 배열, 목록 밖 에이전트로의 넘김은 새 일이 되지 않는다', { skip }, () => {
  const offerOf = (id) => JSON.parse(db.sql(`select envelope from public.msgr2_work_events where work_id = '${id}' and type = 'work.offer'`));
  say(oApp, TR, 'peers 주인', [AG]); const ow = lastWork(TR);
  assert.deepEqual(offerOf(ow).data.peers, [{ agent: AG2, name: '비', role: '' }], '주인이 시키면 allow owner인 비도 동료');
  assert.ok(validateEnvelope(offerOf(ow), { from: 'server' }).ok);
  say(mApp, TR, 'peers 멤버', [AG]); const mw = lastWork(TR);
  assert.deepEqual(offerOf(mw).data.peers, [], '멤버가 시킨 일 — 비(allow owner)는 넘김 대상이 아니다');
  // 목록 밖(비)으로 넘김 → 새 일 없음
  assert.equal(accept(mw).ok, true);
  assert.equal(result(mw, { handoffs: [{ agent: AG2, text: '넘겨' }] }).ok, true);
  assert.equal(db.sql(`select count(*) from public.msgr2_works where parent_work_id = '${mw}'`), '0');
  // guest: 손님방에 비를 넣고 파견을 all로 열어도(등급 말고는 막을 것이 없게) 빈 배열
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${GR}', 'agent', '${AG2}'); update public.msgr2_agent_seats set allow = 'all' where agent_id = '${AG2}'`);
  try {
    say(gApp, GR, 'peers 손님', [AG]); const gw = lastWork(GR);
    assert.equal(workRow(gw).tier, 'guest'); assert.deepEqual(offerOf(gw).data.peers, [], 'guest는 빈 배열');
    assert.equal(accept(gw).ok, true); assert.equal(result(gw, { handoffs: [{ agent: AG2, text: '넘겨' }] }).ok, true);
    assert.equal(db.sql(`select count(*) from public.msgr2_works where parent_work_id = '${gw}'`), '0', 'guest 일의 넘김은 새 일이 아니다');
  } finally { db.sql(`update public.msgr2_agent_seats set allow = 'owner' where agent_id = '${AG2}'`); }
});

// 검수 1 #1075 지적 1 — 주인이 못 읽는 방의 문맥이 주인 본체로 가면 안 된다(설계 1-3 "에이전트를 넣는 조건 = 주인이 그 방의 멤버"를 offer 때도)
test('지적 1 — 에이전트 주인이 못 읽는 방(빠진 방·제거된 공간)에서는 offer·문맥이 주인 본체로 가지 않고, 동료 목록에도 안 나온다', { skip }, () => {
  const X = '40000000-0000-4000-8000-0000000000a1'; // 팀 공간 주인(O와 다른 사람)
  const xApp = seedDevice(db, X, 'app');
  const S2 = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', '남의 팀', '${X}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${S2}', '${X}', 'owner'), ('${S2}', '${O}', 'member')`);
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id, allow) values ('${AG}', '${S2}', 'all')`);
  const XG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${X}', 'x', 'g', '엑스') returning id`);
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id, allow) values ('${XG}', '${S2}', 'all')`);
  const P = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${S2}', 'private', 'X만') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${P}', 'user', '${X}'), ('${P}', 'agent', '${AG}'), ('${P}', 'agent', '${XG}')`);
  assert.equal(db.as(O, oApp.sid, `select (public.msgr2_access('${P}')).read`), 'f', 'O는 이 방을 못 읽는다');
  const leaked = (secret) => JSON.stringify(pending(oRun1)).includes(secret) || db.sql(`select count(*) from realtime.sent where topic = 'w:${O}' and payload::text like '%${secret}%'`) !== '0';
  say(xApp, P, 'SECRET-CONTEXT-1'); say(xApp, P, '요약해', [AG]);
  assert.equal(db.sql(`select count(*) from public.msgr2_works where room_id = '${P}' and agent_id = '${AG}'`), '0', 'O의 에이전트에게 offer 없음');
  assert.equal(leaked('SECRET-CONTEXT-1'), false, '문맥이 O 본체로 가지 않는다');
  // X 자신의 에이전트는 된다. 그 offer의 동료 목록에 O의 에이전트(주인이 못 읽음)는 없다
  say(xApp, P, '엑스 해줘', [XG]); const xw = lastWork(P);
  assert.equal(workRow(xw).agent_id, XG);
  const peers = JSON.parse(db.sql(`select envelope->'data'->'peers' from public.msgr2_work_events where work_id = '${xw}' and type = 'work.offer'`));
  assert.ok(!peers.some((p) => p.agent === AG), '주인이 못 읽는 동료는 넘김 대상이 아니다');
  // open 방이면 O가 읽을 수 있어 offer가 된다 → 그 뒤 O를 공간에서 제거하면 다음 멘션부터 offer 없음 + 남은 offer도 따라잡기에서 빠진다
  const OP = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${S2}', 'open', '열린방') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${OP}', 'agent', '${AG}')`);
  say(xApp, OP, '열린방 일', [AG]); const ow = lastWork(OP);
  assert.equal(workRow(ow).agent_id, AG, '읽을 수 있으면 offer');
  assert.ok(pending(oRun1).envelopes.some((e) => e.work === ow));
  db.sql(`update public.msgr2_space_members set removed_at = now() where space_id = '${S2}' and user_id = '${O}'`);
  assert.ok(!pending(oRun1).envelopes.some((e) => e.work === ow), '제거된 뒤에는 남은 offer도 내려주지 않는다');
  say(xApp, OP, 'SECRET-AFTER-REMOVAL'); say(xApp, OP, '또 해줘', [AG]);
  assert.equal(db.sql(`select count(*) from public.msgr2_works where room_id = '${OP}' and agent_id = '${AG}'`), '1', '제거 뒤 새 offer 없음');
  assert.equal(leaked('SECRET-AFTER-REMOVAL'), false);
});

// 검수 1 #1075 지적 2 — 친구 1:1(만든 사람의 개인 공간에 있는 방)이 친구의 따라잡기에서 빠지면 안 된다
test('지적 2 — 남의 개인 공간에 있는 친구 방도 방 멤버의 앱 따라잡기에 온다', { skip }, () => {
  const F = '40000000-0000-4000-8000-0000000000f1'; const fApp = seedDevice(db, F, 'app');
  const FR = db.sql(`insert into public.msgr2_rooms (space_id, kind, pair_key) values ('${PS}', 'direct', 'o-f') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${FR}', 'user', '${O}'), ('${FR}', 'user', '${F}')`);
  say(oApp, FR, 'hi-friend');
  const c = JSON.parse(db.as(F, fApp.sid, 'select public.msgr2_catch_up(null)'));
  const room = c.rooms.find((r) => r.room_id === FR);
  assert.ok(room, JSON.stringify(c).slice(0, 200)); assert.ok(room.messages.some((m) => m.body === 'hi-friend'));
  assert.ok(!c.rooms.some((r) => r.room_id === DM), 'O의 다른 개인 방은 안 온다');
});

test('판정 함수 하나 — 모든 사람 × 모든 방에서 msgr2_access(사람 문맥) = _msgr2_access_for(방, 그 사람)', { skip }, () => {
  const people = [[O, oApp], [M, mApp], [G, gApp]];
  const rooms = db.sql(`select string_agg(id::text, ',') from public.msgr2_rooms`).split(',');
  for (const [uid, dev] of people) {
    const ids = `(values ${rooms.map((r) => `('${r}'::uuid)`).join(',')}) v(id)`; // 사람 문맥에서는 방 표 RLS가 걸리므로 id 목록으로 돈다
    const viaRpc = db.as(uid, dev.sid, `select string_agg((public.msgr2_access(id))::text, '|' order by id) from ${ids}`);
    const direct = db.sql(`select string_agg((public._msgr2_access_for(id, '${uid}'))::text, '|' order by id) from ${ids}`);
    assert.equal(viaRpc, direct, uid);
  }
  assert.ok(rooms.length >= 5);
});
