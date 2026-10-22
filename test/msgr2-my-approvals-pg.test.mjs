// 메신저 v2 결재 대기 목록(apps/messenger/src/v2/my-approvals.mjs, UX 정리 P1 2026-10-22) — 실제 loadMyApprovals를 사람 문맥(RLS·열 권한)에서 돌린다.
// 조회 빌더(from·select·eq·in·order·limit)를 같은 뜻의 SQL로 바꾸는 작은 클라이언트를 쓴다(PostgREST 대역). 새 마이그레이션·RPC 없음 — 기존 msgr2_access(room).read와 msgr2_approval_decide만.
// 잠그는 것: 남의 공간 결재는 안 보인다 · 같은 방 멤버라도 주인이 아니면 목록에 없다 · 대기 0건이면 빈 목록(화면은 카드를 숨긴다) · 결정·기한 만료 뒤 목록에서 빠진다 · 일이 없으면 요청 1번.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-my-approvals-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';
import { loadMyApprovals, myApprovalItems } from '../apps/messenger/src/v2/my-approvals.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-my-approvals-pg.test.mjs';
const O = '41000000-0000-4000-8000-000000000001', M = '41000000-0000-4000-8000-000000000002', X = '41000000-0000-4000-8000-000000000003';

let db, oApp, oRun, mApp, xApp, PS, TS, DM, TR, AG;
const seqs = new Map();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** 사람 문맥 조회 클라이언트 — 이 시험이 쓰는 빌더 모양만. 요청마다 calls에 표 이름을 남긴다. */
function sqlClient(who) {
  const calls = [];
  const from = (table) => {
    const q = { cols: '*', where: [], order: '', limit: '' };
    const b = {
      select(cols) { q.cols = cols; return b; },
      eq(k, v) { q.where.push(`${k} = ${lit(v)}`); return b; },
      in(k, arr) { q.where.push(arr.length ? `${k} in (${arr.map(lit).join(', ')})` : 'false'); return b; },
      order(k, { ascending = true } = {}) { q.order = ` order by ${k} ${ascending ? 'asc' : 'desc'}`; return b; },
      limit(n) { q.limit = ` limit ${Number(n)}`; return b; },
      then(res, rej) {
        calls.push(table);
        const sql = `select coalesce(json_agg(t), '[]') from (select ${q.cols} from public.${table}${q.where.length ? ` where ${q.where.join(' and ')}` : ''}${q.order}${q.limit}) t`;
        try { res({ data: JSON.parse(db.as(who.uid, who.sid, sql)), error: null }); } catch (e) { res({ data: null, error: { message: e.message } }); }
        return undefined;
      },
    };
    return b;
  };
  return { from, calls };
}
const list = async (who) => { const c = sqlClient(who); const d = await loadMyApprovals(c, who.uid); return { items: myApprovalItems({ ...d, uid: who.uid }), calls: c.calls }; };

const say = (who, room, body, mentions = []) => db.as(who.uid, who.sid, `insert into public.msgr2_messages (room_id, author_kind, author_user_id, body, mentions) values ('${room}', 'user', '${who.uid}', ${lit(body)}, '{${mentions.join(',')}}') returning id`);
const lastWork = (room) => db.sql(`select id from public.msgr2_works where room_id = '${room}' order by created_at desc, id limit 1`);
const env = (type, work, data) => { const k = work; const s = (seqs.get(k) ?? 0) + 1; seqs.set(k, s);
  return { v: 1, id: randomUUID(), work, seq: s, type, agent: AG, device: oRun.dev, at: new Date().toISOString(), data }; };
const send = (e) => db.send(oRun.uid, oRun.sid, e);
/** 그 방에 일을 만들고 결재 요청까지 — 반환 { work, ap } */
function askApproval(room, { risk = 'high', minutes = 60 } = {}) {
  say(oApp, room, '메일 보내줘', room === DM ? [] : [AG]); const work = lastWork(room); // 팀 방은 @멘션으로 일이 생긴다
  send(env('work.accept', work, {}));
  const ap = randomUUID();
  const r = send(env('work.approval_request', work, { approval_id: ap, action: '메일 발송', risk, summary: '3명에게 발송', effect_key: `mail-${ap.slice(0, 8)}`, expires_at: new Date(Date.now() + minutes * 60e3).toISOString() }));
  assert.equal(r.state, 'awaiting_approval', JSON.stringify(r));
  return { work, ap };
}

before(() => {
  if (!DB) return;
  db = setup(DB);
  db.sql(`create table if not exists public.msgr_settings (key text primary key, value text);
    insert into public.msgr_settings values ('msgr2_limit_agent_min', '1000'), ('msgr2_limit_room_min', '1000') on conflict (key) do update set value = excluded.value`);
  oApp = seedDevice(db, O, 'app'); oRun = seedDevice(db, O, 'runner'); mApp = seedDevice(db, M, 'app'); xApp = seedDevice(db, X, 'app');
  PS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${O}') returning id`);
  TS = db.sql(`insert into public.msgr2_spaces (kind, name, owner_user_id) values ('team', '팀', '${O}') returning id`);
  const XS = db.sql(`insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', '${X}') returning id`);
  db.sql(`insert into public.msgr2_space_members (space_id, user_id, role) values ('${PS}', '${O}', 'owner'), ('${TS}', '${O}', 'owner'), ('${TS}', '${M}', 'member'), ('${XS}', '${X}', 'owner')`);
  AG = db.sql(`insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name) values ('${O}', 'w', 'a', '에이') returning id`);
  db.sql(`insert into public.msgr2_agent_seats (agent_id, space_id, allow) values ('${AG}', '${TS}', 'all')`);
  DM = db.sql(`insert into public.msgr2_rooms (space_id, kind, pair_key) values ('${PS}', 'direct', 'o-a') returning id`);
  TR = db.sql(`insert into public.msgr2_rooms (space_id, kind, name) values ('${TS}', 'private', '팀방') returning id`);
  db.sql(`insert into public.msgr2_room_members (room_id, member_kind, member_id) values
    ('${DM}', 'user', '${O}'), ('${DM}', 'agent', '${AG}'), ('${TR}', 'user', '${O}'), ('${TR}', 'user', '${M}'), ('${TR}', 'agent', '${AG}')`);
});

test('대기 0건 — 빈 목록, 요청은 일 조회 1번뿐(결재·방·공간을 읽지 않는다)', { skip }, async () => {
  const { items, calls } = await list(oApp);
  assert.deepEqual(items, []);
  assert.deepEqual(calls, ['msgr2_works']);
});

test('내 결재 대기 — 개인 1:1은 공간 없이(org_id null), 팀 방은 그 공간 id, 최신이 위, 결정 줄 모양', { skip }, async () => {
  const a = askApproval(DM); const b = askApproval(TR, { risk: 'low' });
  const { items, calls } = await list(oApp);
  assert.deepEqual(calls, ['msgr2_works', 'msgr2_approvals', 'msgr2_rooms', 'msgr2_spaces'], '결재가 있을 때만 4번');
  assert.deepEqual(items.map((it) => it.id), [b.ap, a.ap], '최신이 위');
  const [team, personal] = items;
  assert.equal(team.org_id, TS); assert.equal(personal.org_id, null);
  assert.equal(team.channel_id, TR); assert.equal(team.crew_id, AG); assert.equal(team.workId, b.work);
  assert.equal(team.v2, true); assert.equal(team.kind, 'approval'); assert.equal(team.crewOwnerId, O);
  assert.equal(personal.risk, 'high'); assert.equal(personal.action, '메일 발송'); assert.equal(personal.reason, '3명에게 발송');
});

test('RLS·주인 — 같은 팀 방 멤버는 결재 행을 읽을 수 있어도 목록에 없고(결정은 주인만), 공간 밖 사람은 행 자체가 안 보인다', { skip }, async () => {
  assert.ok(Number(db.as(M, mApp.sid, `select count(*) from public.msgr2_approvals where room_id = '${TR}' and state = 'pending'`)) > 0, '방 멤버는 RLS로 읽힌다(카드 표시용)');
  assert.deepEqual((await list(mApp)).items, [], '주인이 아니면 목록 0');
  assert.equal(db.as(X, xApp.sid, 'select count(*) from public.msgr2_approvals'), '0', '공간 밖 사람은 결재 행 0(RLS)');
  assert.equal(db.as(X, xApp.sid, `select count(*) from public.msgr2_works where owner_user_id = '${O}'`), '0', '남의 일도 0');
  assert.deepEqual((await list(xApp)).items, []);
});

test('결정 뒤 — 승인·거절한 결재는 목록에서 빠지고 남은 것만 보인다', { skip }, async () => {
  const before0 = (await list(oApp)).items;
  assert.ok(before0.length >= 2);
  const [first, second] = before0;
  assert.equal(db.as(O, oApp.sid, `select public.msgr2_approval_decide('${first.id}', 'approve')`), 'approved');
  let now = (await list(oApp)).items.map((it) => it.id);
  assert.ok(!now.includes(first.id), '승인한 결재는 빠진다'); assert.ok(now.includes(second.id));
  assert.equal(db.as(O, oApp.sid, `select public.msgr2_approval_decide('${second.id}', 'reject')`), 'rejected');
  now = (await list(oApp)).items.map((it) => it.id);
  assert.ok(!now.includes(second.id), '거절한 결재도 빠진다');
});

test('기한이 지난 결재 — 서버 행이 아직 pending이어도 목록에 없다(결정 함수도 expired)', { skip }, async () => {
  const { ap } = askApproval(DM);
  assert.ok((await list(oApp)).items.some((it) => it.id === ap));
  db.sql(`update public.msgr2_approvals set expires_at = now() - interval '1 second' where id = '${ap}'`);
  assert.ok(!(await list(oApp)).items.some((it) => it.id === ap));
  assert.equal(db.as(O, oApp.sid, `select public.msgr2_approval_decide('${ap}', 'approve')`), 'expired');
});

test('읽기만 — 목록을 여러 번 읽어도 결재·일 표에 쓰기 0(xmin 그대로)', { skip }, async () => {
  askApproval(TR);
  const snap = () => ['msgr2_works', 'msgr2_approvals'].map((t) => db.xmins(t)).join('|');
  const s0 = snap();
  for (let i = 0; i < 3; i++) await list(oApp);
  assert.equal(snap(), s0);
});
