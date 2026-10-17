// 본체 부품의 v2 토픽 × U2b 토픽 권한(…_msgr2_realtime_storage.sql)을 실제 Postgres에서 맞춰 본다.
// 본체가 실제로 쓰는 값만 쓴다: 등록 인자는 src/agent-link-host.mjs runnerRegisterArgs, 토픽 이름은 packages/agent-link/link.mjs topicWork·topicProgress
// (= 약속 TOPICS 정본). 이 둘이 서버 정책과 어긋나면 본체가 v2:w:를 못 받아 일이 오지 않는다 — 그 어긋남을 여기서 잡는다.
// 건너뜀: ARGO_PG_TEST_URL 미설정. 실행: bash scripts/billing-pg-drill.sh test/agent-link-topics-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, seedDevice, migText } from './helpers/msgr2-work-pg.mjs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runnerRegisterArgs } from '../src/agent-link-host.mjs';
import { topicWork, topicProgress } from '../packages/agent-link/link.mjs';
import { APP_VERSION } from '../src/app-version.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/agent-link-topics-pg.test.mjs';
let db;
const O = randomUUID(); const M = randomUUID();
const lit = (v) => (v === null || v === undefined ? 'null' : Array.isArray(v) ? `array[${v.map((x) => `'${x}'`).join(',')}]::text[]` : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

before(() => {
  if (!DB) return;
  db = setup(DB);
  // 기기 등록은 그 세션이 auth.sessions에 있어야 받는다(U3) — 준비 함수에 없는 대역만 더한다(agent-link-register-pg와 같은 모양)
  // 등록 함수가 부르는 최소 앱 버전 함수(argo_min_app_version) — 준비 함수는 U1·U3·U2·U2b만 적용한다
  db.psql(['-c', migText(readdirSync(fileURLToPath(new URL('../supabase/migrations/', import.meta.url))).find((f) => f.endsWith('_msgr_app_min_version.sql')))]);
  db.sql(`create table if not exists auth.sessions (id uuid primary key, user_id uuid not null, created_at timestamptz not null default now())`);
  for (const id of [O, M]) db.sql(`insert into auth.users (id) values ('${id}') on conflict do nothing`);
});

/** 본체가 보내는 등록 인자 그대로(이름 있는 인자) 그 세션으로 부른다 → 등록된 세션 id */
function registerLikeArgo(uid) {
  const sid = randomUUID();
  db.sql(`insert into auth.sessions (id, user_id) values ('${sid}', '${uid}') on conflict do nothing`);
  const args = runnerRegisterArgs({ appVersion: APP_VERSION, runners: ['claude'] });
  const named = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
  const out = db.as(uid, sid, `select public.msgr2_device_register(${named})::text`);
  assert.ok(JSON.parse(out.split('\n').filter(Boolean).pop()).device_id, `등록 실패: ${out}`);
  return sid;
}

test('본체 등록 인자로 등록한 runner 기기는 부품이 구독하는 토픽(topicWork = v2:w:<본인>)을 받는다 — 남의 것·앱 기기·옛 w:는 못 받는다', { skip }, () => {
  const sid = registerLikeArgo(O);
  assert.equal(topicWork(O), `v2:w:${O}`);
  assert.equal(db.canListen(O, sid, topicWork(O)), true, '본체가 자기 v2:w:를 받는다');
  assert.equal(db.canListen(O, sid, topicWork(M)), false, '남의 v2:w:');
  const app = seedDevice(db, O, 'app');
  assert.equal(db.canListen(O, app.sid, topicWork(O)), false, '앱 기기는 본체 토픽을 못 받는다');
  assert.equal(db.canListen(O, sid, `w:${O}`), false, '옛 w: 토픽은 v2 정책 밖(기기 확인 없는 옛 정책에 기대지 않는다)');
});

test('폐기한 runner 기기는 topicWork를 받지 못한다', { skip }, () => {
  const sid = registerLikeArgo(M);
  assert.equal(db.canListen(M, sid, topicWork(M)), true);
  db.sql(`update public.msgr2_devices set revoked_at = now() where session_id = '${sid}'`);
  assert.equal(db.canListen(M, sid, topicWork(M)), false);
});

test('진행 토픽 이름(topicProgress)은 서버 정책이 보는 v2:wk:<일> 모양이다', { skip }, () => {
  const w = randomUUID();
  assert.equal(topicProgress(w), `v2:wk:${w}`);
  // 일이 없는 토픽은 아무도 못 받는다(방을 읽는 사람만 — 정책 판정 전체는 msgr2-realtime-storage-pg)
  const sid = registerLikeArgo(O);
  assert.equal(db.canListen(O, sid, topicProgress(w)), false);
});
