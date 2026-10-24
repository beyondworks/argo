// 메신저 v2 자동화 일정(20261024100000) — #1156 엄격 검수(총괄 2026-10-24) 재현 R1~R7을 단언 시험으로 옮긴 것.
// I-1 기기 하나 폐기, I-2 결재 대기의 리스 만료, 조건별 권한 다시 보기, 입력 검증·상한, 시간대 경계, 동시 크론, 밀린 크론.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-automations-review-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-automations-review-pg.test.mjs';
const id = (n) => `e9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = id(1), M = id(2), X = id(3), G = id(4), TS = id(10);
let db, pApp, pApp2, mApp, xApp, gApp, PS, A1, XA, MA, R1, TR, TPRIV;
const DAILY = { kind: 'daily', time: '09:00', timezone: 'Asia/Seoul' };
const lit = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const setting = (k, v) => db.sql(v == null ? `delete from public.msgr_settings where key = '${k}'` : `insert into public.msgr_settings (key, value) values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`);
const save = (who, room, agent, { title = 't', prompt = 'p', schedule = DAILY } = {}) =>
  JSON.parse(db.as(who.uid, who.sid, `select public.msgr2_automation_save(null, '${room}', '${agent}', '${title}', '${prompt}', ${lit(schedule)}, null)`));
const dispatch = () => Number(db.sql('select public.msgr2_automation_dispatch()'));
const due = (a) => db.sql(`update public.msgr2_automations set next_run_at = now() - interval '1 minute' where id = '${a}'`);
const auto = (a) => JSON.parse(db.sql(`select row_to_json(x) from public.msgr2_automations x where id = '${a}'`));
const runs = (a) => JSON.parse(db.sql(`select coalesce(json_agg(row_to_json(x) order by created_at), '[]') from public.msgr2_automation_runs x where automation_id = '${a}'`));
const msgCount = (room) => Number(db.sql(`select count(*) from public.msgr2_messages where room_id = '${room}' and author_kind = 'user'`));
const off = (a) => db.sql(`update public.msgr2_automations set deleted_at = now(), enabled = false where id = '${a}'`);
const humanInsertErr = (who, room) => db.asErr(who.uid, who.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, kind, body) values ('${room}', 'user', '${who.uid}', 'text', 'hi')`);

before(() => {
  if (!DB) return;
  db = setup(DB);
  setting('msgr2_limit_agent_min', '1000'); setting('msgr2_limit_room_min', '1000');
  pApp = seedDevice(db, P, 'app'); pApp2 = seedDevice(db, P, 'app'); mApp = seedDevice(db, M, 'app'); xApp = seedDevice(db, X, 'app'); gApp = seedDevice(db, G, 'app');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${P}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${P}', 'owner')`);
  A1 = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${P}', 'w', 'a1', 'a1') returning id`);
  R1 = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${PS}', 'private', '') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${R1}', 'user', '${P}'), ('${R1}', 'agent', '${A1}')`);
  db.sql(`insert into public.msgr2_spaces (id, kind, name, owner_user_id) values ('${TS}', 'team', '팀', '${M}')`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role, expires_at) values ('${TS}', '${M}', 'owner', null), ('${TS}', '${X}', 'member', null), ('${TS}', '${G}', 'guest', now() + interval '1 day')`);
  XA = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${X}', 'w', 'xa', 'xa') returning id`);
  MA = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${M}', 'w', 'ma', 'ma') returning id`);
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id) values ('${XA}', '${TS}'), ('${MA}', '${TS}')`);
  TR = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'open', '일반') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${TR}', 'user', '${X}'), ('${TR}', 'user', '${G}'), ('${TR}', 'agent', '${XA}'), ('${TR}', 'agent', '${MA}')`);
  TPRIV = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'private', '비공개') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${TPRIV}', 'user', '${X}'), ('${TPRIV}', 'user', '${M}'), ('${TPRIV}', 'agent', '${MA}')`);
});

const snap = () => [db.xmins('msgr2_automations'), db.xmins('msgr2_automation_runs'), db.xmins('msgr2_messages'), db.xmins('msgr2_works')].join('|');

test('I-1 기기 하나 폐기(msgr2_device_revoke — 세대는 그대로) 뒤에는 그 기기가 건 일정이 글 0·blocked(session_revoked)·끔, 살아 있는 기기에서 다시 켜면 돈다', { skip }, () => {
  const a = save(pApp2, R1, A1, { title: '폐기', prompt: '폐기된 기기가 건 지시' });
  assert.equal(db.as(P, pApp.sid, `select public.msgr2_device_revoke('${pApp2.dev}')`), 't', '다른 앱 기기에서 폐기');
  assert.match(humanInsertErr(pApp2, R1) ?? 'ok', /row-level security|permission denied/, '전제: 폐기된 기기는 사람 글을 못 넣는다');
  assert.equal(db.sql(`select coalesce((select gen from public.msgr2_user_gen where user_id = '${P}'), 0)`), '0', '전제: 기기 하나 폐기는 세대를 올리지 않는다');
  due(a.id); const n0 = msgCount(R1);
  assert.equal(dispatch(), 1);
  assert.equal(msgCount(R1), n0, '폐기한 기기가 건 일정으로 글을 넣지 않는다');
  assert.deepEqual(runs(a.id).map((r) => [r.status, r.error]), [['blocked', 'session_revoked']]);
  assert.equal(auto(a.id).enabled, false);
  assert.equal(JSON.parse(db.as(P, pApp.sid, `select public.msgr2_automation_set_enabled('${a.id}', true)`)).owner_device, pApp.dev, '살아 있는 기기에서 다시 켜면 그 기기로');
  due(a.id); assert.equal(dispatch(), 1); assert.equal(msgCount(R1), n0 + 1, '다시 켠 뒤에는 돈다');
  off(a.id);
});

test('I-2 결재 대기인데 리스가 끝난 일(결과 모름)은 기다리지 않는다 — 다음 회차가 돌고 앞 기록은 failed(stalled)', { skip }, () => {
  const a = save(pApp, R1, A1, { title: '결재', prompt: '결재 확인' }); due(a.id);
  assert.equal(dispatch(), 1);
  const [r] = runs(a.id);
  db.sql(`update public.msgr2_works set state = 'awaiting_approval', lease_until = now() - interval '1 hour' where id = '${r.work_id}'`);
  due(a.id);
  assert.equal(dispatch(), 1);
  assert.deepEqual(runs(a.id).map((x) => [x.status, x.error]), [['failed', 'stalled'], ['queued', null]]);
  off(a.id);
});

test('I-2 핀: 리스가 살아 있는 정상 결재 대기는 계속 기다린다(쓰기 0)', { skip }, () => {
  const a = save(pApp, R1, A1, { title: '결재 대기', prompt: '정상 결재' }); due(a.id);
  assert.equal(dispatch(), 1);
  const [r] = runs(a.id);
  db.sql(`update public.msgr2_works set state = 'awaiting_approval', lease_until = now() + interval '10 minutes' where id = '${r.work_id}'`);
  due(a.id); const s = snap();
  assert.equal(dispatch(), 0, '결재를 기다리는 동안 다음 회차를 쌓지 않는다');
  assert.equal(snap(), s, '쓰기 0');
  assert.deepEqual(runs(a.id).map((x) => x.status), ['running'], '결재 대기 = 진행 중(기록 1개)');
  off(a.id);
});

test('조건별 권한 다시 보기(R3) — 만들 때 통과 → 조건이 깨지면 다음 실행은 글 0·blocked·끔', { skip }, () => {
  const out = [];
  const caseRun = (name, who, room, agent, breakIt, restore) => {
    const a = save(who, room, agent, { title: name, prompt: name });
    breakIt(); due(a.id); const n0 = msgCount(room);
    dispatch();
    const r = runs(a.id).at(-1);
    out.push([name, r?.status, r?.error, msgCount(room) - n0, auto(a.id).enabled]);
    restore?.(); off(a.id);
  };
  caseRun('손님 기한 만료', gApp, TR, XA, () => db.sql(`update public.msgr2_space_members set expires_at = now() - interval '1 minute' where space_id = '${TS}' and user_id = '${G}'`),
    () => db.sql(`update public.msgr2_space_members set expires_at = now() + interval '1 day' where space_id = '${TS}' and user_id = '${G}'`));
  caseRun('비공개 방에서 빠짐', xApp, TPRIV, MA, () => db.sql(`update public.msgr2_room_members set removed_at = now() where room_id = '${TPRIV}' and member_id = '${X}'`),
    () => db.sql(`update public.msgr2_room_members set removed_at = null where room_id = '${TPRIV}' and member_id = '${X}'`));
  caseRun('자리 해제', xApp, TR, MA, () => db.sql(`update public.msgr2_agent_seats set removed_at = now() where agent_id = '${MA}' and space_id = '${TS}'`),
    () => db.sql(`update public.msgr2_agent_seats set removed_at = null where agent_id = '${MA}' and space_id = '${TS}'`));
  caseRun('자리 범위 owner로', xApp, TR, MA, () => db.sql(`update public.msgr2_agent_seats set allow = 'owner' where agent_id = '${MA}' and space_id = '${TS}'`),
    () => db.sql(`update public.msgr2_agent_seats set allow = 'all' where agent_id = '${MA}' and space_id = '${TS}'`));
  caseRun('방 에이전트 막음', xApp, TR, XA, () => db.sql(`update public.msgr2_rooms set agent_policy = 'blocked' where id = '${TR}'`),
    () => db.sql(`update public.msgr2_rooms set agent_policy = 'allowed' where id = '${TR}'`));
  caseRun('에이전트 방에서 빠짐', xApp, TR, XA, () => db.sql(`update public.msgr2_room_members set removed_at = now() where room_id = '${TR}' and member_id = '${XA}'`),
    () => db.sql(`update public.msgr2_room_members set removed_at = null where room_id = '${TR}' and member_id = '${XA}'`));
  caseRun('에이전트 비활성', xApp, TR, XA, () => db.sql(`update public.msgr2_agents set status = 'paused' where id = '${XA}'`),
    () => db.sql(`update public.msgr2_agents set status = 'active' where id = '${XA}'`));
  caseRun('방 보관', xApp, TR, XA, () => db.sql(`update public.msgr2_rooms set archived_at = now() where id = '${TR}'`),
    () => db.sql(`update public.msgr2_rooms set archived_at = null where id = '${TR}'`));
  caseRun('lite 켜짐(팀 방)', xApp, TR, XA, () => setting('msgr2_lite', 'on'), () => setting('msgr2_lite', 'off'));
  caseRun('공간 삭제', xApp, TR, XA, () => db.sql(`update public.msgr2_spaces set deleted_at = now() where id = '${TS}'`),
    () => db.sql(`update public.msgr2_spaces set deleted_at = null where id = '${TS}'`));
  const why = { '손님 기한 만료': 'permission_revoked', '비공개 방에서 빠짐': 'permission_revoked', '자리 해제': 'permission_revoked', '자리 범위 owner로': 'permission_revoked',
    '방 에이전트 막음': 'agent_unavailable', '에이전트 방에서 빠짐': 'agent_unavailable', '에이전트 비활성': 'agent_unavailable', '방 보관': 'permission_revoked', 'lite 켜짐(팀 방)': 'lite_only', '공간 삭제': 'permission_revoked' };
  assert.deepEqual(out, Object.entries(why).map(([name, e]) => [name, 'blocked', e, 0, false]));
});

test('입력 검증·상한(R4) — 남의 방·남의 에이전트·잘못된 일정·글자 수·남의 자동화는 거부, 살아 있는 자동화 50개 상한', { skip }, () => {
  const e = (who, q) => (db.asErr(who.uid, who.sid, q) ?? 'OK').split('\n')[0];
  const sv = (who, room, agent, title, prompt, sched) => e(who, `select public.msgr2_automation_save(null, '${room}', '${agent}', ${title}, ${prompt}, ${lit(sched)}, null)`);
  assert.match(sv(pApp, TR, XA, "'t'", "'p'", DAILY), /msgr_automation_forbidden/, '남의 방');
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values ('${R1}', 'agent', '${XA}') on conflict do nothing`);
  assert.match(sv(pApp, R1, XA, "'t'", "'p'", DAILY), /msgr_automation_forbidden/, '개인 공간의 남의 에이전트');
  db.sql(`update public.msgr2_room_members set removed_at = now() where room_id = '${R1}' and member_id = '${XA}'`);
  assert.match(sv(pApp, R1, A1, "repeat('x', 121)", "'p'", DAILY), /title_check/);
  assert.match(sv(pApp, R1, A1, "'t'", "repeat('x', 18001)", DAILY), /prompt_check/);
  assert.match(sv(pApp, R1, A1, "'   '", "'p'", DAILY), /title_check/, '빈 제목(공백만)');
  for (const bad of [{ kind: 'daily', time: '24:00', timezone: 'Asia/Seoul' }, { kind: 'daily', time: '09:00', timezone: 'Mars/Base' }, { kind: 'weekly', time: '09:00', timezone: 'Asia/Seoul', weekdays: [0] }])
    assert.match(sv(pApp, R1, A1, "'t'", "'p'", bad), /msgr_automation_invalid_schedule/, JSON.stringify(bad));
  assert.match(e(mApp, `select public.msgr2_automation_set_enabled('${id(999)}', false)`), /msgr_automation_forbidden/, '없는·남의 자동화');
  db.sql(`update public.msgr2_automations set deleted_at = now(), enabled = false where created_by = '${P}' and deleted_at is null`);
  for (let i = 0; i < 50; i++) save(pApp, R1, A1, { title: `n${i}` });
  assert.match(sv(pApp, R1, A1, "'t'", "'p'", DAILY), /msgr2_limit/, '51번째');
  db.sql(`update public.msgr2_automations set deleted_at = now(), enabled = false where created_by = '${P}' and deleted_at is null`);
  assert.equal(sv(pApp, R1, A1, "'t'", "'p'", DAILY), 'OK', '지운 것은 세지 않는다');
  db.sql(`update public.msgr2_automations set deleted_at = now(), enabled = false where created_by = '${P}' and deleted_at is null`);
});

test('시간대 경계(R5) — KST 하루·요일·월말·연말, 일광절약(없는 시각은 다음 날, 겹치는 시각은 그날 한 번)', { skip }, () => {
  const q = (s, at) => db.sql(`select to_char(public._msgr2_automation_next(${lit(s)}, '${at}'::timestamptz) at time zone 'Asia/Seoul', 'YYYY-MM-DD Dy HH24:MI')`);
  const utc = (s, at) => db.sql(`select to_char(public._msgr2_automation_next(${lit(s)}, '${at}'::timestamptz) at time zone 'UTC', 'YYYY-MM-DD HH24:MI')`);
  assert.equal(q(DAILY, '2026-10-24 08:30+09'), '2026-10-24 Sat 09:00');
  assert.equal(q(DAILY, '2026-10-24 09:00+09'), '2026-10-25 Sun 09:00', '정각 바로 그 시각이면 다음 날(같은 회차 두 번 없음)');
  assert.equal(q({ kind: 'daily', time: '00:00', timezone: 'Asia/Seoul' }, '2026-10-24 15:30Z'), '2026-10-26 Mon 00:00', 'UTC 전날이어도 KST 날짜 기준');
  assert.equal(q({ kind: 'weekly', time: '09:00', timezone: 'Asia/Seoul', weekdays: [1] }, '2026-10-25 16:00Z'), '2026-10-26 Mon 09:00', 'UTC 일요일 = KST 월요일');
  assert.equal(q({ kind: 'daily', time: '23:30', timezone: 'Asia/Seoul' }, '2026-10-31 23:45+09'), '2026-11-01 Sun 23:30', '월말');
  assert.equal(q({ kind: 'weekly', time: '09:00', timezone: 'Asia/Seoul', weekdays: [5] }, '2026-12-31 10:00+09'), '2027-01-01 Fri 09:00', '연말');
  assert.equal(utc({ kind: 'daily', time: '02:30', timezone: 'America/New_York' }, '2027-03-13 12:00-05'), '2027-03-15 06:30', '없는 시각(서머타임 시작일)은 건너뛴다');
  assert.equal(utc({ kind: 'daily', time: '01:30', timezone: 'America/New_York' }, '2026-10-31 12:00-04'), '2026-11-01 06:30');
  assert.equal(utc({ kind: 'daily', time: '01:30', timezone: 'America/New_York' }, '2026-11-01 06:30Z'), '2026-11-02 06:30', '겹치는 시각은 그날 한 번');
});

test('동시 크론(R6) — 같은 자동화를 두 크론이 겹쳐 잡아도 글 1개·기록 1개, 실패 기록 없음(for update · skip locked)', { skip }, async () => {
  const a = save(pApp, R1, A1, { title: '동시', prompt: 'slowmo' });
  db.sql(`create or replace function public.test_slow() returns trigger language plpgsql as $$ begin if new.body = 'slowmo' then perform pg_sleep(2); end if; return new; end $$;
    create trigger test_slow before insert on public.msgr2_messages for each row execute function public.test_slow()`);
  try {
    due(a.id); const n0 = msgCount(R1);
    const run = () => new Promise((res) => { const p = spawn('psql', [DB, '-X', '-A', '-t', '-q', '-c', 'select public.msgr2_automation_dispatch()']); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { o += d; }); p.on('close', () => res(o.trim())); });
    const [x, y] = await Promise.all([run(), new Promise((r) => setTimeout(r, 300)).then(run)]);
    assert.equal(Number(x) + Number(y), 1, `두 크론 합쳐 1회(${x}, ${y})`);
    assert.equal(msgCount(R1) - n0, 1, '글 1개');
    assert.deepEqual(runs(a.id).map((r) => [r.trigger, r.status, r.error]), [['schedule', 'queued', null]], '실패 기록 없음');
    assert.equal(auto(a.id).last_status, 'queued');
  } finally { db.sql('drop trigger if exists test_slow on public.msgr2_messages; drop function if exists public.test_slow()'); off(a.id); }
});

test('밀린 크론(R7) — 5분 간격이 1시간 밀려도 한 번만 돌고 다음 회차는 지금부터 5분 뒤', { skip }, () => {
  const a = save(pApp, R1, A1, { title: '밀림', prompt: '밀림', schedule: { kind: 'interval', minutes: 5, timezone: 'UTC' } });
  db.sql(`update public.msgr2_automations set next_run_at = now() - interval '60 minutes' where id = '${a.id}'`);
  const n0 = msgCount(R1);
  assert.equal(dispatch(), 1); assert.equal(dispatch(), 0);
  assert.equal(msgCount(R1) - n0, 1, '따라잡기로 한꺼번에 쏘지 않는다');
  assert.equal(db.sql(`select round(extract(epoch from next_run_at - now())/60) from public.msgr2_automations where id = '${a.id}'`), '5');
  off(a.id);
});
