// 메신저 v2 기기 등록 Pro 관문(20261020201700, #1128 검수) — 실제 Postgres에서 본다.
// ① 무료 계정의 새 기기 등록 = msgr2_pro_required(42501), 행 0 ② Pro 새 등록 통과 ③ 무료가 된 계정의 기존 행 갱신은 통과(갑자기 끊기지 않게)
// ④ 관문 스위치(msgr2_pro_gate = off)면 무료도 통과 ⑤ 되돌림 파일을 적용하면 무료 새 등록이 다시 통과(되돌림이 정확)
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-device-pro-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setup, seedDevice } from './helpers/msgr2-work-pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-device-pro-pg.test.mjs';
const MIG = fileURLToPath(new URL('../supabase/migrations/20261020201700_msgr2_device_pro.sql', import.meta.url));
const DOWN = fileURLToPath(new URL('../scripts/rollback/20261020201700_msgr2_device_pro.down.sql', import.meta.url));
const P = 'c7000000-0000-4000-8000-000000000001'; // Pro
const F = 'c7000000-0000-4000-8000-000000000002'; // 무료

let db;
const setting = (k, v) => db.sql(v == null ? `delete from public.msgr_settings where key = '${k}'` : `insert into public.msgr_settings values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`);
/** GoTrue에 살아 있는 새 세션(방금 로그인) — 새 행 분기를 탄다 */
const session = (uid) => { db.sql(`insert into auth.users (id) values ('${uid}') on conflict do nothing`); return db.sql(`insert into auth.sessions (id, user_id, created_at) values (gen_random_uuid(), '${uid}', now()) returning id`); };
const REG = (kind) => `select public.msgr2_device_register('${kind}', '${kind === 'app' ? 'messenger' : 'desktop'}', '0.1.200', ${kind === 'app' ? 'null, null' : '1, 1'}, ${kind === 'app' ? 'null' : "array['claude']"}, null)`;
const rows = (sid) => Number(db.sql(`select count(*) from public.msgr2_devices where session_id = '${sid}'`));

before(() => {
  if (!DB) return;
  db = setup(DB);
  db.sql('create table if not exists auth.sessions (id uuid primary key, user_id uuid not null, created_at timestamptz not null default now())'); // 시험 DB에는 GoTrue 표가 없다(msgr2-device-pg와 같은 최소 판)
  db.psql(['-c', readFileSync(fileURLToPath(new URL(`../supabase/migrations/${readdirSync(fileURLToPath(new URL('../supabase/migrations/', import.meta.url))).find((f) => f.endsWith('_msgr_app_min_version.sql'))}`, import.meta.url)), 'utf8')]); // 등록이 부르는 argo_min_app_version
  db.sql(`create table if not exists public.test_pro (uid uuid primary key);
    create or replace function public.is_pro_for(p uuid) returns boolean language sql stable as $$ select exists (select 1 from public.test_pro where uid = p) $$;
    insert into public.test_pro values ('${P}') on conflict do nothing`);
  setting('msgr2_pro_gate', null); // 운영 기본(켬)
});

test('무료 새 기기 등록은 msgr2_pro_required, 행 0 — runner·app 둘 다', { skip }, () => {
  for (const kind of ['runner', 'app']) {
    const sid = session(F);
    const e = db.asErr(F, sid, REG(kind)) ?? '';
    assert.match(e, /msgr2_pro_required/, `${kind}: 거부`);
    assert.equal(rows(sid), 0, `${kind}: 행이 생기지 않는다`);
  }
});

test('Pro 새 기기 등록은 통과(행 1)', { skip }, () => {
  for (const kind of ['runner', 'app']) {
    const sid = session(P);
    const j = JSON.parse(db.as(P, sid, REG(kind)));
    assert.ok(j.device_id, `${kind}: device_id`);
    assert.equal(rows(sid), 1);
  }
});

test('무료가 된 계정의 기존 행 갱신은 통과 — 갑자기 끊기지 않는다', { skip }, () => {
  const d = seedDevice(db, F, 'runner'); // Pro일 때 만든 행이 있다고 본다
  const j = JSON.parse(db.as(d.uid, d.sid, REG('runner')));
  assert.equal(j.device_id, d.dev, '같은 행');
});

test('관문 스위치 off면 무료 새 등록도 통과', { skip }, () => {
  setting('msgr2_pro_gate', 'off');
  try {
    const sid = session(F);
    assert.ok(JSON.parse(db.as(F, sid, REG('runner'))).device_id);
  } finally { setting('msgr2_pro_gate', null); }
});

test('되돌림 = Pro 확인 없는 20261020200100 정의, 다시 적용하면 거부로 돌아온다', { skip }, () => {
  db.psql(['-c', readFileSync(DOWN, 'utf8')]);
  const s1 = session(F);
  assert.ok(JSON.parse(db.as(F, s1, REG('runner'))).device_id, '되돌린 뒤 무료 새 등록 통과');
  db.psql(['-c', readFileSync(MIG, 'utf8')]);
  const s2 = session(F);
  assert.match(db.asErr(F, s2, REG('runner')) ?? '', /msgr2_pro_required/, '다시 적용하면 거부');
});
