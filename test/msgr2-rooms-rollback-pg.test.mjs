// 메신저 v2 U6d 되돌림(운영 순서 판) — 옛 msgr 전체 + msgr2(U6d 전까지)를 적용한 DB에 U6d를 적용했다가 되돌리면 적용 전과 같다
// (public 함수 서명·본문·권한, 트리거, 열, 정책, 제약(FK 이름·규칙·검증), 인덱스). 옛 중단 장치 본문·옛 FK 복원을 여기서 잠근다.
// msgr2만 적용한 판의 되돌림은 test/msgr2-rooms-pg.test.mjs 첫 시험이 본다.
// 실행: bash scripts/billing-pg-drill.sh test/msgr2-rooms-rollback-pg.test.mjs
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { setupBase, migText } from './helpers/msgr2-work-pg.mjs';
import { ROOMS_FILE, DOWN_FILE, roomsText, snapshot } from './helpers/msgr2-rooms-cases.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'ARGO_PG_TEST_URL 미설정 — bash scripts/billing-pg-drill.sh test/msgr2-rooms-rollback-pg.test.mjs';
const mig = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
let db; const s = {};

before(() => {
  if (!DB) return;
  db = setupBase(DB);
  const base = ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260929110000_plan_no_trial.sql'];
  const files = [...base, ...readdirSync(mig).filter((x) => /^\d+_msgr.*\.sql$/.test(x) && x < ROOMS_FILE)].sort();
  for (const f of files) db.psql(['-c', migText(f).replace(/^create extension if not exists pg_net;$/m, '')]);
  s.base = snapshot(db);
  db.psql(['-c', roomsText()]); s.applied = snapshot(db);
  db.psql(['-c', readFileSync(DOWN_FILE, 'utf8')]); s.reverted = snapshot(db);
  db.psql(['-c', roomsText()]); s.reapplied = snapshot(db);
});

test('적용하면 옛 FK 5개가 빠지고 트리거 검사가 생기며, 옛 중단 장치 본문이 바뀐다(비교가 헛돌지 않는다)', { skip }, () => {
  for (const c of ['msgr_reports_message_id_fkey', 'msgr_reports_channel_id_fkey', 'msgr_journal_entries_source_msg_id_fkey', 'msgr_journal_entries_channel_id_fkey', 'msgr_org_docs_channel_id_fkey']) {
    assert.ok(s.base.constraints.some((x) => x.includes(`:${c}:`)), `적용 전 ${c}`);
    assert.ok(!s.applied.constraints.some((x) => x.includes(`:${c}:`)), `적용 뒤 ${c} 없음`);
  }
  assert.ok(s.applied.triggers.some((t) => t.startsWith('msgr_reports:msgr2_ref_message_id')));
  const g = (x) => x.procs.find((p) => p.startsWith('msgr_pause_guard()'));
  assert.notEqual(g(s.applied), g(s.base));
});

test('되돌림 = 적용 전(옛 FK·옛 중단 장치 본문·읽음 직접 쓰기 정책 복원), 다시 적용 = 처음 적용', { skip }, () => {
  for (const k of Object.keys(s.base)) assert.deepEqual(s.reverted[k], s.base[k], k);
  for (const k of Object.keys(s.base)) assert.deepEqual(s.reapplied[k], s.applied[k], k);
});
