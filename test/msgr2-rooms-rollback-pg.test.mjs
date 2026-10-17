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
  s.accessBase = db.sql(`select prosrc from pg_proc where proname = '_msgr2_access_for'`);
  db.psql(['-c', roomsText()]); s.applied = snapshot(db);
  s.accessApplied = db.sql(`select prosrc from pg_proc where proname = '_msgr2_access_for'`);
  // 옛 앱이 채널을 지워 생긴 고아 일지(어느 표에도 없는 channel_id) — 되돌림이 멈추지 않고, 행은 그대로 남아야 한다
  const u = '6e000000-0000-4000-8000-000000000001';
  db.sql(`insert into auth.users (id) values ('${u}')`);
  const org = db.sql(`insert into public.msgr_orgs (name, slug, owner_user_id) values ('고아', 'orphan-org', '${u}') returning id`).split('\n').pop();
  const ch = db.sql(`insert into public.msgr_channels (org_id, kind, name, created_by) values ('${org}', 'public', 'c', '${u}') returning id`).split('\n').pop();
  db.sql(`insert into public.msgr_journal_entries (org_id, channel_id, day, line) values ('${org}', '${ch}', '2026-10-18', '기억')`);
  db.sql(`delete from public.msgr_channels where id = '${ch}'`); // U6d 적용 중에는 일지가 cascade로 지워지지 않는다
  s.orphanBefore = db.sql(`select count(*) from public.msgr_journal_entries where channel_id = '${ch}'`);
  db.psql(['-c', readFileSync(DOWN_FILE, 'utf8')]); s.reverted = snapshot(db);
  s.orphanAfter = db.sql(`select count(*) from public.msgr_journal_entries where channel_id = '${ch}'`);
  db.psql(['-c', roomsText()]); s.reapplied = snapshot(db);
});

test('적용하면 옛 FK 4개가 빠지고 트리거 검사가 생기며, 옛 중단 장치 본문이 바뀐다(비교가 헛돌지 않는다)', { skip }, () => {
  assert.ok(s.applied.constraints.some((x) => x.includes(':msgr_org_docs_channel_id_fkey:')), '조직 문서 FK는 그대로');
  for (const c of ['msgr_reports_message_id_fkey', 'msgr_reports_channel_id_fkey', 'msgr_journal_entries_source_msg_id_fkey', 'msgr_journal_entries_channel_id_fkey']) {
    assert.ok(s.base.constraints.some((x) => x.includes(`:${c}:`)), `적용 전 ${c}`);
    assert.ok(!s.applied.constraints.some((x) => x.includes(`:${c}:`)), `적용 뒤 ${c} 없음`);
  }
  assert.ok(s.applied.triggers.some((t) => t.startsWith('msgr_reports:msgr2_ref_message_id')));
  const g = (x) => x.procs.find((p) => p.startsWith('msgr_pause_guard()'));
  assert.notEqual(g(s.applied), g(s.base));
});

test('_msgr2_access_for는 U2 본문에 1:1 차단 한 줄만 더한다(나머지는 바이트 단위로 같다)', { skip }, () => {
  const lines = s.accessApplied.split('\n');
  const added = lines.filter((l) => l.includes('-- U6d: 1:1은 차단'));
  assert.equal(added.length, 1);
  assert.equal(lines.filter((l) => !l.includes('-- U6d: 1:1은 차단')).join('\n'), s.accessBase);
});

test('되돌림 = 적용 전(옛 FK는 같은 이름·규칙의 NOT VALID, 옛 중단 장치 본문·_msgr2_access_for·읽음 직접 쓰기 정책 복원), 고아 일지가 있어도 멈추지 않고 행은 남는다, 다시 적용 = 처음 적용', { skip }, () => {
  assert.equal(s.orphanBefore, '1'); assert.equal(s.orphanAfter, '1');
  const FK = /:(msgr_reports_message_id_fkey|msgr_reports_channel_id_fkey|msgr_journal_entries_source_msg_id_fkey|msgr_journal_entries_channel_id_fkey):/;
  const restored = s.reverted.constraints.filter((c) => FK.test(c));
  assert.equal(restored.length, 4);
  for (const c of restored) assert.match(c, / NOT VALID:false$/, c);
  const norm = (x) => ({ ...x, constraints: x.constraints.map((c) => (FK.test(c) ? c.replace(/ NOT VALID:false$/, ':true') : c)) });
  for (const k of Object.keys(s.base)) assert.deepEqual(norm(s.reverted)[k], s.base[k], k);
  for (const k of Object.keys(s.base)) assert.deepEqual(s.reapplied[k], s.applied[k], k);
});
