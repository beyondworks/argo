// 기기 간 동기화 E2E 관문의 핵심 칸만 node --test로 — K1(CLI 단독)·K3(앱과 CLI 동시)·S-custC(옛 판이 남은 자격으로 잠금을 쥔 고객 C 근접).
// 판마다 standalone 빌드가 필요해 수 분이 걸린다. 기본 시험 목록(test/*.test.mjs)에는 들지 않는다(이름이 .e2e.mjs) — 사람이 직접 돌린다:
//   E2E_SYNC_DEVICES=1 node --test test/sync-devices-core.e2e.mjs                    (새 판 = HEAD, 옛 판 = v0.1.120)
//   E2E_SYNC_DEVICES=1 E2E_NEW=<ref|빌드 폴더> E2E_OLD=<ref> node --test test/sync-devices-core.e2e.mjs
// 전체 칸은 `node scripts/e2e-sync-devices.mjs --new <ref>`(약 1시간).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const on = process.env.E2E_SYNC_DEVICES === '1';
test('기기 간 동기화 핵심 칸(K1·K3·S-custC)이 실제 실행본에서 PASS', { skip: !on && 'E2E_SYNC_DEVICES=1일 때만(빌드가 필요한 사람용 관문)', timeout: 40 * 60_000 }, () => {
  const out = mkdtempSync(join(tmpdir(), 'argo-e2e-core-out-'));
  const script = fileURLToPath(new URL('../scripts/e2e-sync-devices.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--new', process.env.E2E_NEW || 'HEAD', '--old', process.env.E2E_OLD || 'v0.1.120', '--cells', 'core', '--out', out], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.leftProcesses, 0, '띄운 프로세스가 남았다');
  assert.deepEqual(summary.failed, [], `${r.stdout.split('\n').filter((l) => l.startsWith('[e2e]') || l.startsWith('e2e-sync-devices')).join('\n')}`);
  assert.equal(r.status, 0);
});
