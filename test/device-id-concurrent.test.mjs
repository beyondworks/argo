// 첫 실행 기기 ID 경쟁(2026-10-15) — .device-id가 없는 루트에서 getDeviceId 첫 호출 둘이 겹치면 각자 새 ID를 만들어
// 한 프로세스가 두 신원을 가졌다. 큐 워커(me)와 적재(dev)가 갈려 첫 메신저 잡이 '다른 기기 사본'으로 실행 없이 지워졌다(msgr-busy-hold 멈춤).
// 잠그는 것: 동시 호출은 한 ID·파일과 같음 / 진행 중 실패는 함께 실패하고 다음 호출은 다시 시도(약속이 막히지 않음) / 쓰기 실패 뒤 복구.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, chmod } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let n = 0;
async function freshWorkspace() { // WS_ROOT·캐시는 모듈 평가 때 고정 — 경우마다 새 루트·새 모듈 인스턴스(device-id-read-failure.test.mjs와 같은 요령)
  const root = await mkdtemp(join(tmpdir(), 'argo-devid-conc-'));
  process.env.ARGO_ROOT = root;
  const mod = await import(`../src/workspace.mjs?conc=${++n}`);
  return { root, getDeviceId: mod.getDeviceId };
}
const canDeny = process.platform !== 'win32' && process.getuid?.() !== 0;

test('빈 루트에서 동시에 20번 불러도 ID는 하나이고 .device-id 파일 값과 같다', async () => {
  const { root, getDeviceId } = await freshWorkspace();
  const ids = await Promise.all(Array.from({ length: 20 }, () => getDeviceId()));
  assert.equal(new Set(ids).size, 1, `한 프로세스 안 신원은 하나: ${[...new Set(ids)]}`);
  assert.equal((await readFile(join(root, '.device-id'), 'utf8')).trim(), ids[0]);
  assert.equal(await getDeviceId(), ids[0], '그 뒤 호출도 같은 ID');
});

test('진행 중인 읽기가 실패하면 함께 기다리던 호출도 실패하고, 다음 호출은 다시 읽는다', { skip: !canDeny && 'root·Windows는 chmod로 읽기 거부를 만들 수 없다' }, async () => {
  const { root, getDeviceId } = await freshWorkspace();
  const f = join(root, '.device-id');
  await writeFile(f, 'mac-orig1234\n'); await chmod(f, 0o000);
  try {
    const rs = await Promise.allSettled([getDeviceId(), getDeviceId(), getDeviceId()]);
    assert.ok(rs.every((r) => r.status === 'rejected' && r.reason?.code === 'EACCES'), '꾸며낸 ID 없이 모두 실패');
  } finally { await chmod(f, 0o600); }
  assert.equal(await getDeviceId(), 'mac-orig1234', '실패한 약속에 묶이지 않고 다시 읽어 원래 신원');
});

test('파일을 쓰지 못하면(루트 쓰기 금지) 함께 실패하고, 쓰기가 돌아오면 한 ID로 만든다', { skip: !canDeny && 'root·Windows는 chmod로 쓰기 거부를 만들 수 없다' }, async () => {
  const { root, getDeviceId } = await freshWorkspace();
  await chmod(root, 0o500);
  try {
    const rs = await Promise.allSettled([getDeviceId(), getDeviceId()]);
    assert.ok(rs.every((r) => r.status === 'rejected'), '쓰기 실패는 숨기지 않는다');
  } finally { await chmod(root, 0o700); }
  const ids = await Promise.all([getDeviceId(), getDeviceId()]);
  assert.equal(new Set(ids).size, 1);
  assert.equal((await readFile(join(root, '.device-id'), 'utf8')).trim(), ids[0]);
});
