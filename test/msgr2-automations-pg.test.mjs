// 메신저 v2 자동화 일정(20261024100000) — 사람 RPC(앱 기기만)·크론 실행(원래 사람 권한 다시 보기)·유휴 쓰기 0·실패 뒤 다음 회차·실행 기록 30일·되돌림.
// 크론 실행은 기기 세션이 아니다(auth.uid() 없음) — 사람 글 정책·lite_guard·pause_guard가 건너뛰므로 실행 함수가 권한을 직접 본다(S5 우회 경로 아님).
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-automations-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-automations-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261024100000_msgr2_automations.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261024100000_msgr2_automations.down.sql', import.meta.url));
const id = (n) => `d9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = id(1), M = id(2), X = id(3), O = id(4), TS = id(10);
let db, pApp, pRun, mApp, xApp, oApp, PS, A1, XA, R1, TR;

const DAILY = { kind: 'daily', time: '09:00', timezone: 'Asia/Seoul' };
const lit = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const setting = (k, v) => db.sql(v == null ? `delete from public.msgr_settings where key = '${k}'` : `insert into public.msgr_settings (key, value) values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`);
const save = (who, room, agent, { title = '아침 보고', prompt = '어제 한 일을 정리해 줘', schedule = DAILY, automation = null, request = null } = {}) =>
  JSON.parse(db.as(who.uid, who.sid, `select public.msgr2_automation_save(${automation ? `'${automation}'` : 'null'}, '${room}', '${agent}', '${title}', '${prompt}', ${lit(schedule)}, ${request ? `'${request}'` : 'null'})`));
const saveErr = (who, room, agent, schedule = DAILY) => db.asErr(who.uid, who.sid, `select public.msgr2_automation_save(null, '${room}', '${agent}', 't', 'p', ${lit(schedule)}, null)`);
const dispatch = () => Number(db.sql('select public.msgr2_automation_dispatch()')); // 크론 문맥(사람 세션 없음 — service/postgres)
const due = (a) => db.sql(`update public.msgr2_automations set next_run_at = now() - interval '1 minute' where id = '${a}'`);
const auto = (a) => JSON.parse(db.sql(`select row_to_json(x) from public.msgr2_automations x where id = '${a}'`));
const runs = (a) => JSON.parse(db.sql(`select coalesce(json_agg(row_to_json(x) order by created_at), '[]') from public.msgr2_automation_runs x where automation_id = '${a}'`));
const msgCount = (room) => Number(db.sql(`select count(*) from public.msgr2_messages where room_id = '${room}' and author_kind = 'user'`));
const snap = () => [db.xmins('msgr2_automations'), db.xmins('msgr2_automation_runs'), db.xmins('msgr2_messages'), db.xmins('msgr2_works')].join('|');

before(() => {
  if (!DB) return;
  db = setup(DB);
  setting('msgr2_limit_agent_min', '1000'); setting('msgr2_limit_room_min', '1000');
  pApp = seedDevice(db, P, 'app'); pRun = seedDevice(db, P, 'runner'); mApp = seedDevice(db, M, 'app'); xApp = seedDevice(db, X, 'app'); oApp = seedDevice(db, O, 'app');
  // 개인 공간: P + P의 에이전트 A1의 1:1
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${P}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${P}', 'owner')`);
  A1 = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${P}', 'w', 'a1', 'a1') returning id`);
  R1 = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${PS}', 'private', '') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${R1}', 'user', '${P}'), ('${R1}', 'agent', '${A1}')`);
  // 팀 공간: 주인 M, 멤버 X. X의 에이전트 XA가 자리(allow all)로 open 방에 있다
  db.sql(`insert into public.msgr2_spaces (id, kind, name, owner_user_id) values ('${TS}', 'team', '팀', '${M}')`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${TS}', '${M}', 'owner'), ('${TS}', '${X}', 'member')`);
  XA = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${X}', 'w', 'xa', 'xa') returning id`);
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id) values ('${XA}', '${TS}')`);
  TR = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'open', '일반') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${TR}', 'user', '${X}'), ('${TR}', 'agent', '${XA}')`);
});

test('만들기는 앱 기기 세션만 — 본체(runner) 세션·남의 에이전트·잘못된 일정은 거부', { skip }, () => {
  assert.match(saveErr(pRun, R1, A1), /msgr2_app_device_required/, '본체 세션은 일정을 만들지 못한다(S5)');
  assert.match(saveErr(oApp, R1, A1), /msgr_automation_forbidden/, '방에 없는 사람');
  assert.match(saveErr(pApp, R1, A1, { kind: 'interval', minutes: 1, timezone: 'UTC' }), /msgr_automation_invalid_schedule/, '5분 미만 간격');
  const a = save(pApp, R1, A1, { request: id(900) });
  assert.equal(a.enabled, true); assert.equal(a.space_id, PS); assert.ok(Date.parse(a.next_run_at) > Date.now());
  assert.equal(save(pApp, R1, A1, { request: id(900) }).id, a.id, '같은 요청은 같은 행(멱등)');
  // 읽기: 방을 읽는 사람만
  assert.equal(db.as(P, pApp.sid, `select count(*) from public.msgr2_automations where id = '${a.id}'`), '1');
  assert.equal(db.as(O, oApp.sid, `select count(*) from public.msgr2_automations where id = '${a.id}'`), '0', '방 밖 사람은 못 읽는다');
  assert.match(db.asErr(P, pApp.sid, `update public.msgr2_automations set enabled = false where id = '${a.id}'`), /permission denied/, '표 직접 쓰기 권한 없음 — RPC만');
  db.sql(`update public.msgr2_automations set deleted_at = now() where id = '${a.id}'`);
});

test('크론: 할 일이 없으면 쓰기 0, 때가 되면 만든 사람 이름의 지시 글 1개 → 일 1개, 진행 중이면 다음 분은 건너뛴다', { skip }, () => {
  const a = save(pApp, R1, A1, { title: '정리', prompt: '정리해 줘' });
  const before0 = snap();
  assert.equal(dispatch(), 0); assert.equal(dispatch(), 0);
  assert.equal(snap(), before0, '유휴 쓰기 0(xmin 불변)');
  due(a.id);
  const n0 = msgCount(R1);
  assert.equal(dispatch(), 1);
  assert.equal(msgCount(R1), n0 + 1, '지시 글 1개');
  const m = JSON.parse(db.sql(`select row_to_json(x) from (select author_user_id, mentions, body, meta, client_msg_id from public.msgr2_messages where room_id = '${R1}' order by id desc limit 1) x`));
  assert.equal(m.author_user_id, P); assert.deepEqual(m.mentions, [A1]); assert.equal(m.body, '정리해 줘'); assert.equal(m.meta.automation_id, a.id);
  const [r] = runs(a.id);
  assert.equal(r.status, 'queued'); assert.equal(r.trigger, 'schedule'); assert.ok(r.work_id, '그 글로 생긴 일이 기록에 이어진다');
  assert.equal(db.sql(`select source_message_id = (select id from public.msgr2_messages where client_msg_id = 'automation:${r.id}') from public.msgr2_works where id = '${r.work_id}'`), 't');
  const after = auto(a.id);
  assert.ok(Date.parse(after.next_run_at) > Date.now(), '다음 회차로 넘어간다'); assert.equal(after.last_status, 'queued');
  // 진행 중인 일이 있으면 때가 돼도 쌓지 않는다(쓰기 0)
  due(a.id); const s1 = snap();
  assert.equal(dispatch(), 0); assert.equal(snap(), s1, '진행 중 — 건너뜀, 쓰기 0');
  // 일이 끝나면 기록이 따라간다
  db.sql(`update public.msgr2_works set state = 'running' where id = '${r.work_id}'`);
  assert.equal(runs(a.id)[0].status, 'running');
  db.sql(`update public.msgr2_works set state = 'done' where id = '${r.work_id}'`);
  assert.equal(runs(a.id)[0].status, 'completed'); assert.equal(auto(a.id).last_status, 'completed');
  assert.equal(dispatch(), 1, '끝난 뒤에는 밀린 회차를 한 번 돈다');
  assert.equal(runs(a.id).length, 2);
  db.sql(`update public.msgr2_automations set deleted_at = now(), enabled = false where id = '${a.id}'`);
});

test('크론: 원래 사람의 권한을 실행 시점에 다시 본다 — Pro가 끝남·팀에서 내보냄이면 글 0·blocked·자동화 끔', { skip }, () => {
  db.sql(`create table if not exists public.test_pro (uid uuid primary key);
    create or replace function public.is_pro_for(p uuid) returns boolean language sql stable as $$ select exists (select 1 from public.test_pro where uid = p) $$;
    insert into public.test_pro values ('${P}'), ('${X}') on conflict do nothing`);
  setting('msgr2_pro_gate', 'on');
  try {
    const a = save(pApp, R1, A1, { title: 'Pro', prompt: 'pro 확인' });
    db.sql(`delete from public.test_pro where uid = '${P}'`); due(a.id);
    const n0 = msgCount(R1);
    assert.equal(dispatch(), 1);
    assert.equal(msgCount(R1), n0, 'Pro가 끝난 사람 이름으로 글을 넣지 않는다');
    assert.equal(runs(a.id)[0].status, 'blocked'); assert.equal(runs(a.id)[0].error, 'pro_required');
    assert.equal(auto(a.id).enabled, false, '자동화를 끈다(매 회차 재시도하지 않음)');
    assert.match(db.asErr(P, pApp.sid, `select public.msgr2_automation_set_enabled('${a.id}', true)`), /msgr2_pro_required/, '다시 켜기는 지금 권한이 있어야');
    db.sql(`insert into public.test_pro values ('${P}')`);
    assert.equal(JSON.parse(db.as(P, pApp.sid, `select public.msgr2_automation_set_enabled('${a.id}', true)`)).enabled, true);
    db.sql(`update public.msgr2_automations set deleted_at = now(), enabled = false where id = '${a.id}'`);

    // 팀: X가 만든 자동화 → 주인 M이 X를 내보냄 → 크론은 글을 넣지 않는다(S2·S3와 같은 판정)
    const t = save(xApp, TR, XA, { title: '팀', prompt: '팀 보고' });
    assert.equal(db.as(M, mApp.sid, `select public.msgr2_space_member_remove('${TS}', '${X}')`), 't');
    due(t.id); const tn = msgCount(TR);
    assert.equal(dispatch(), 1);
    assert.equal(msgCount(TR), tn, '내보낸 사람 이름으로 팀 방에 글이 들어가지 않는다');
    assert.equal(runs(t.id)[0].error, 'permission_revoked'); assert.equal(auto(t.id).enabled, false);
    assert.equal(db.as(M, mApp.sid, `select count(*) from public.msgr2_automations where id = '${t.id}'`), '1', '남은 멤버는 기록을 본다');
  } finally { setting('msgr2_pro_gate', 'off'); }
});

test('크론 함수는 사람 세션으로 부를 수 없고, 중단 스위치가 켜지면 쓰기 0', { skip }, () => {
  assert.match(db.asErr(P, pApp.sid, 'select public.msgr2_automation_dispatch()'), /permission denied|msgr_automation_forbidden/);
  const a = save(pApp, R1, A1, { title: '중단', prompt: '중단 확인' }); due(a.id);
  setting('msgr2_paused', 'on');
  try { const s = snap(); assert.equal(dispatch(), 0); assert.equal(snap(), s, '중단 중 쓰기 0'); } finally { setting('msgr2_paused', null); }
  assert.equal(dispatch(), 1, '재개하면 밀린 회차를 한 번');
  db.sql(`update public.msgr2_automations set deleted_at = now(), enabled = false where id = '${a.id}'`);
});

test('한 행이 실패해도 다른 행은 돈다 — 실패는 기록에 남고 다음 회차까지 기다린다(매분 재시도 없음)', { skip }, () => {
  db.sql(`create or replace function public.test_boom() returns trigger language plpgsql as $$ begin if new.body = 'boom' then raise exception 'boom 비밀 지시'; end if; return new; end $$;
    create trigger test_boom before insert on public.msgr2_messages for each row execute function public.test_boom()`);
  try {
    const bad = save(pApp, R1, A1, { title: '실패', prompt: 'boom' });
    const good = save(pApp, R1, A1, { title: '성공', prompt: '성공 확인' });
    due(bad.id); due(good.id);
    assert.equal(dispatch(), 1, '성공한 행만 센다');
    assert.equal(runs(good.id).length, 1);
    const [r] = runs(bad.id); const b = auto(bad.id);
    assert.equal(r.status, 'failed'); assert.equal(r.error, 'dispatch_failed', '오류 원문(지시 내용)은 남기지 않는다');
    assert.equal(b.enabled, true); assert.ok(Date.parse(b.next_run_at) > Date.now(), '다음 회차로 넘긴다');
    const s = snap(); assert.equal(dispatch(), 0); assert.equal(snap(), s, '바로 다음 분은 쓰기 0');
    for (const x of [bad, good]) db.sql(`update public.msgr2_automations set deleted_at = now(), enabled = false where id = '${x.id}'`);
  } finally { db.sql('drop trigger if exists test_boom on public.msgr2_messages; drop function if exists public.test_boom()'); }
});

test('지금 실행: 사람 문맥(사람 글 관문을 그대로 지남), 같은 요청은 한 번, 본체 세션은 거부', { skip }, () => {
  const a = save(pApp, R1, A1, { title: '지금', prompt: '지금 해 줘' });
  const n0 = msgCount(R1);
  const r1 = JSON.parse(db.as(P, pApp.sid, `select public.msgr2_automation_run_now('${a.id}', '${id(901)}')`));
  const r2 = JSON.parse(db.as(P, pApp.sid, `select public.msgr2_automation_run_now('${a.id}', '${id(901)}')`));
  assert.equal(r1.id, r2.id); assert.equal(r1.trigger, 'manual'); assert.ok(r1.work_id);
  assert.equal(msgCount(R1), n0 + 1, '같은 요청은 글 1개');
  assert.match(db.asErr(P, pRun.sid, `select public.msgr2_automation_run_now('${a.id}', null)`), /msgr2_app_device_required/);
  assert.match(db.asErr(O, oApp.sid, `select public.msgr2_automation_run_now('${a.id}', null)`), /msgr_automation_forbidden/, '남의 자동화');
  assert.match(db.asErr(P, pApp.sid, `select public.msgr2_automation_save('${a.id}', '${TR}', '${A1}', 't', 'p', ${lit(DAILY)}, null)`), /channel_immutable|forbidden/, '방은 바꾸지 못한다');
  assert.equal(db.as(P, pApp.sid, `select public.msgr2_automation_delete('${a.id}')`), 't');
  assert.equal(db.as(P, pApp.sid, `select count(*) from public.msgr2_automations where id = '${a.id}' and deleted_at is null`), '0');
});

test('보존: 실행 기록 30일 정리 문장은 30일 지난 기록만 지운다(자동화·글은 그대로)', { skip }, () => {
  const stmt = /\$c\$(delete from public\.msgr2_automation_runs[^$]+)\$c\$/.exec(readFileSync(MIG, 'utf8'))?.[1];
  assert.ok(stmt, '크론 정리 문장');
  const a = save(pApp, R1, A1, { title: '보존', prompt: '보존 확인' });
  db.sql(`insert into public.msgr2_automation_runs (automation_id, scheduled_for, trigger, status, created_at) values
    ('${a.id}', now() - interval '31 days', 'manual', 'completed', now() - interval '31 days'), ('${a.id}', now() - interval '29 days', 'manual', 'completed', now() - interval '29 days')`);
  const m0 = db.sql('select count(*) from public.msgr2_messages');
  db.sql(stmt);
  assert.equal(runs(a.id).length, 1, '29일 기록만 남는다');
  assert.equal(db.sql('select count(*) from public.msgr2_messages'), m0);
  assert.equal(auto(a.id).id, a.id);
  db.sql(`update public.msgr2_automations set deleted_at = now(), enabled = false where id = '${a.id}'`);
});

test('되돌림 파일을 적용하면 표·함수·트리거가 없고, 다시 적용하면 돈다', { skip }, () => {
  db.psql(['-v', 'ON_ERROR_STOP=1', '-f', DOWN]);
  assert.equal(db.sql(`select to_regclass('public.msgr2_automations') is null and to_regprocedure('public.msgr2_automation_dispatch()') is null
    and not exists (select 1 from pg_trigger where tgname = 'msgr2_automation_work_state')`), 't');
  db.sql(`update public.msgr2_works set state = 'done' where state <> 'done'`); // 트리거 없이 일 상태가 바뀌어도 오류 없음
  db.psql(['-v', 'ON_ERROR_STOP=1', '-c', readFileSync(MIG, 'utf8')]);
  const a = save(pApp, R1, A1, { title: '다시', prompt: '다시 확인' }); due(a.id);
  assert.equal(dispatch(), 1);
});
