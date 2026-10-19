// 메신저 v2 초대 취소 방송(20261018061300) — 사람 지정 초대를 취소하면 받는 사람 v2:u:에 'invite'(revoked) 사건 한 번. 실제 Postgres(운영 순서 전체 마이그레이션 판).
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-invite-revoke-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { setupFull, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-invite-revoke-pg.test.mjs';
const O = '61300000-0000-4000-8000-000000000001'; // 공간 주인(초대한 사람)
const N = '61300000-0000-4000-8000-000000000002'; // 받는 사람
const M = '61300000-0000-4000-8000-000000000003'; // 다른 받는 사람(거절·수락)
let db, d, TEAM;
const J = (who, q) => JSON.parse(db.as(who.uid, who.sid, `select (${q})::text`));
const V = (who, q) => db.as(who.uid, who.sid, `select (${q})::text`);
const sentTo = (uid) => JSON.parse(db.sql(`select coalesce(json_agg(json_build_object('event', event, 'payload', payload) order by id), '[]') from realtime.sent where topic = 'v2:u:${uid}'`));
const invitesTo = (uid) => sentTo(uid).filter((x) => x.event === 'invite');

before(() => {
  if (!DB) return;
  db = setupFull(DB);
  db.sql(`insert into public.msgr_settings (key, value) values ('msgr2_lite', 'off') on conflict (key) do update set value = excluded.value`); // A+ 1:1 밖 막기를 끈다 — 팀 초대 기능 시험
  d = { O: seedDevice(db, O, 'app'), N: seedDevice(db, N, 'app'), M: seedDevice(db, M, 'app') };
  TEAM = V(d.O, `public.msgr2_space_create('팀 취소', 'team-revoke')`);
});

test('사람 지정 초대를 취소하면 받는 사람에게 invite 사건(revoked) 한 번 — 받는 사람 초대함에서도 빠진다', { skip }, () => {
  const inv = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', '${N}')`);
  assert.equal(invitesTo(N).length, 1, '만들 때 한 번(기존 동작)');
  assert.equal(JSON.parse(db.as(N, d.N.sid, `select coalesce(json_agg(t), '[]')::text from public.msgr2_my_invites() t`)).length, 1);
  assert.equal(V(d.O, `public.msgr2_invite_revoke('${inv.invite_id}')`), 'true');
  const got = invitesTo(N);
  assert.equal(got.length, 2);
  assert.deepEqual(got[1].payload, { invite_id: inv.invite_id, space_id: TEAM, revoked: true });
  assert.equal(JSON.parse(db.as(N, d.N.sid, `select coalesce(json_agg(t), '[]')::text from public.msgr2_my_invites() t`)).length, 0, '셸이 다시 읽으면 빠진다');
  assert.equal(V(d.O, `public.msgr2_invite_revoke('${inv.invite_id}')`), 'false', '이미 취소');
  assert.equal(invitesTo(N).length, 2, '이미 취소면 방송 없음');
});

test('보내지 않는 때: 링크 초대(받는 사람 없음)·이미 거절한 초대·이미 수락한 초대 — 취소는 그대로 된다', { skip }, () => {
  const before = db.sql('select count(*) from realtime.sent');
  const link = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', null, '{}'::uuid[], 5)`);
  assert.equal(V(d.O, `public.msgr2_invite_revoke('${link.invite_id}')`), 'true');
  assert.equal(db.sql('select count(*) from realtime.sent'), before, '링크 초대: 방송 0');
  const dec = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', '${M}')`);
  assert.equal(V(d.M, `public.msgr2_invite_decline('${dec.code}')`), 'true');
  const m0 = invitesTo(M).length;
  assert.equal(V(d.O, `public.msgr2_invite_revoke('${dec.invite_id}')`), 'true');
  assert.equal(invitesTo(M).length, m0, '거절한 초대: 방송 없음');
  const mem = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', '${M}')`);
  J(d.M, `public.msgr2_invite_accept('${mem.code}')`);
  const m1 = invitesTo(M).length;
  assert.equal(V(d.O, `public.msgr2_invite_revoke('${mem.invite_id}')`), 'true');
  assert.equal(invitesTo(M).length, m1, '수락한 초대: 방송 없음');
});

test('권한은 그대로: 받는 사람·남은 취소하지 못한다(방송 0)', { skip }, () => {
  const inv = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', '${N}')`);
  const n0 = invitesTo(N).length;
  assert.match(db.asErr(N, d.N.sid, `select public.msgr2_invite_revoke('${inv.invite_id}')`) ?? '', /msgr2_invite_not_found/);
  assert.equal(invitesTo(N).length, n0);
});

test('되돌림: 040000 정의로 — 취소해도 방송 없음, 취소 자체는 된다', { skip }, async () => {
  const { readFileSync } = await import('node:fs');
  const down = readFileSync(new URL('../scripts/rollback/20261018061300_msgr2_invite_revoke_signal.down.sql', import.meta.url), 'utf8');
  const r = db.raw(['-v', 'ON_ERROR_STOP=1', '-c', down]);
  assert.equal(r.status, 0, r.stderr);
  const inv = J(d.O, `public.msgr2_invite_create('${TEAM}', 'member', '${N}')`);
  const n0 = invitesTo(N).length;
  assert.equal(V(d.O, `public.msgr2_invite_revoke('${inv.invite_id}')`), 'true');
  assert.equal(invitesTo(N).length, n0, '되돌린 뒤 방송 없음');
});
