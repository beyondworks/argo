// 메신저 v2 에이전트 얼굴·사진 저장(20261025130000, 0.1.65 결함 3)을 실제 Postgres에서 본다.
// 경우: 주인 앱 기기 얼굴 저장·사진 저장·지우기, 같은 값 다시 = 쓰기 0(xmin), 남의 에이전트·본체 기기·기기 없음·은퇴 에이전트 거절,
// 잘못된 키·모양·남의 폴더 사진 주소 거절, 본체 동기화(face_hash null)가 저장한 얼굴을 지키는지(종전엔 null로 덮음), 되돌림.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-agent-look-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-agent-look-pg.test.mjs';
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261025130000_msgr2_agent_look.down.sql', import.meta.url));
const MIG = fileURLToPath(new URL('../supabase/migrations/20261025130000_msgr2_agent_look.sql', import.meta.url));
const U = { A: 'e2000000-0000-4000-8000-00000000000a', B: 'e2000000-0000-4000-8000-00000000000b' };
const FACE = { v: 2, shape: 3, color: 10 };
const photo = (uid) => `https://proj.supabase.co/storage/v1/object/public/msgr-avatars/avatars/${uid}/crew-x-1.jpg`;
let db, appA, runA, appB; const G = {};

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const agent = (owner, slug, status = 'active') => db.sql('insert into public.msgr2_agents (owner_user_id, ws_id, slug, display_name, status) values (' + q(owner) + ", 'ws', " + q(slug) + ', ' + q(slug) + ', ' + q(status) + ') returning id');
const setLook = (dev, ag, patch) => db.as(dev.uid, dev.sid, `select public.msgr2_agent_set_look(${q(ag)}, ${db.lit(patch)})`);
const setLookErr = (dev, ag, patch) => db.asErr(dev.uid, dev.sid, `select public.msgr2_agent_set_look(${q(ag)}, ${db.lit(patch)})`);
const row = (ag) => JSON.parse(db.sql(`select json_build_object('face', face, 'avatar_url', avatar_url) from public.msgr2_agents where id = ${q(ag)}`));
const sync = (dev, list) => db.as(dev.uid, dev.sid, `select public.msgr2_agent_sync(${db.lit(list)})`);

before(() => {
  if (!DB) return;
  db = setup(DB);
  appA = seedDevice(db, U.A, 'app'); runA = seedDevice(db, U.A, 'runner'); appB = seedDevice(db, U.B, 'app');
  G.A = agent(U.A, 'pepper'); G.B = agent(U.B, 'other'); G.R = agent(U.A, 'old', 'retired');
});

test('주인 앱 기기: 얼굴 저장 → 목록이 읽는 행이 바뀐다, 같은 값 다시 = 쓰기 0', { skip }, () => {
  assert.equal(setLook(appA, G.A, { face: FACE }), 't');
  assert.deepEqual(row(G.A).face, FACE);
  const x = db.xmins('msgr2_agents', `id = ${q(G.A)}`);
  assert.equal(setLook(appA, G.A, { face: FACE }), 'f', '바뀐 것 없음');
  assert.equal(db.xmins('msgr2_agents', `id = ${q(G.A)}`), x, '같은 값은 쓰지 않는다(xmin 그대로)');
});

test('사진: 자기 폴더 주소만 저장, null로 지우기, 얼굴은 그대로', { skip }, () => {
  assert.equal(setLook(appA, G.A, { avatar_url: photo(U.A) }), 't');
  assert.deepEqual(row(G.A), { face: FACE, avatar_url: photo(U.A) });
  assert.equal(setLook(appA, G.A, { avatar_url: null }), 't');
  assert.deepEqual(row(G.A), { face: FACE, avatar_url: null });
  for (const bad of [photo(U.B), 'http://proj.supabase.co/storage/v1/object/public/msgr-avatars/avatars/' + U.A + '/a.jpg', 'https://evil.example/track.png',
    `https://proj.supabase.co/storage/v1/object/public/msgr-avatars/avatars/${U.A}/../${U.B}/a.jpg`, `https://x/${'a'.repeat(600)}/storage/v1/object/public/msgr-avatars/avatars/${U.A}/a.jpg`]) {
    assert.match(setLookErr(appA, G.A, { avatar_url: bad }) ?? '', /msgr2_bad_look/, bad.slice(0, 60));
  }
});

test('거절: 남의 에이전트·본체 기기·은퇴 에이전트·잘못된 키와 모양', { skip }, () => {
  assert.match(setLookErr(appB, G.A, { face: FACE }) ?? '', /msgr2_not_owner/);
  assert.match(setLookErr(runA, G.A, { face: FACE }) ?? '', /msgr2_app_device_required/, '앱 기기만');
  assert.match(setLookErr({ uid: U.A, sid: null }, G.A, { face: FACE }) ?? '', /msgr2_app_device_required/, '기기 없음');
  assert.match(setLookErr(appA, G.R, { face: FACE }) ?? '', /msgr2_not_owner/, '은퇴');
  for (const bad of [{}, { display_name: 'x' }, { face: 'blue' }, { face: { pad: 'x'.repeat(300) } }, { avatar_url: 3 }]) {
    assert.match(setLookErr(appA, G.A, bad) ?? '', /msgr2_bad_look/, JSON.stringify(bad).slice(0, 40));
  }
  assert.deepEqual(row(G.B).face, null, '남의 행은 그대로');
});

test('본체 동기화: face_hash null(JSON null)을 보내도 저장한 얼굴을 지킨다 — 이름·역할은 종전대로 바뀐다', { skip }, () => {
  setLook(appA, G.A, { face: FACE });
  const before = db.xmins('msgr2_agents', `id = ${q(G.A)}`);
  assert.equal(sync(runA, [{ ws_id: 'ws', slug: 'pepper', display_name: 'pepper', role_text: '', face: null }]), '0', '바뀐 것 없음 = 쓰기 0');
  assert.equal(db.xmins('msgr2_agents', `id = ${q(G.A)}`), before);
  assert.equal(sync(runA, [{ ws_id: 'ws', slug: 'pepper', display_name: '페퍼', role_text: '총괄' }]), '1', 'face 키 없음(SQL null)');
  assert.deepEqual(row(G.A).face, FACE);
  assert.equal(db.sql(`select display_name || '/' || role_text from public.msgr2_agents where id = ${q(G.A)}`), '페퍼/총괄');
  const other = { v: 2, shape: 1, color: 2 };
  sync(runA, [{ ws_id: 'ws', slug: 'pepper', display_name: '페퍼', role_text: '총괄', face: other }]);
  assert.deepEqual(row(G.A).face, other, '본체가 얼굴을 보내면 그 값');
});

test('되돌림: 함수가 사라지고 동기화는 종전 본문(null로 덮음), 사진 칸은 남는다 — 다시 적용하면 원상', { skip }, () => {
  setLook(appA, G.A, { face: FACE, avatar_url: photo(U.A) });
  db.psql(['-v', 'ON_ERROR_STOP=1', '-f', DOWN]);
  assert.equal(db.sql("select count(*) from pg_proc where proname = 'msgr2_agent_set_look'"), '0');
  assert.equal(db.sql("select count(*) from information_schema.columns where table_name = 'msgr2_agents' and column_name = 'avatar_url'"), '1');
  assert.equal(row(G.A).avatar_url, photo(U.A), '사진 주소는 남긴다');
  sync(runA, [{ ws_id: 'ws', slug: 'pepper', display_name: '페퍼', role_text: '총괄', face: null }]);
  assert.equal(row(G.A).face, null, '종전 본문: null로 덮는다(되돌림이 종전과 같음을 확인)');
  db.psql(['-v', 'ON_ERROR_STOP=1', '-c', readFileSync(MIG, 'utf8')]);
  assert.equal(setLook(appA, G.A, { face: FACE }), 't');
});
