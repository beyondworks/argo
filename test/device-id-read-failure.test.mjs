// K71 — .device-id를 못 읽은 이유가 "없음"이 아닌데(권한·잠김) 새 ID를 만들어 쓰면 기기 신원이 바뀌어
// 동기화 리스·세션 소유 판정이 어긋난다. 빈 파일이면 빈 문자열 ID가 나와서도 안 된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, chmod } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// WS_ROOT·캐시는 모듈 평가 시점에 고정된다 — 경우마다 새 루트로 새 모듈 인스턴스를 띄운다.
let n = 0;
async function freshWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'argo-devid-'));
  process.env.ARGO_ROOT = root;
  const mod = await import(`../src/workspace.mjs?case=${++n}`);
  return { root, getDeviceId: mod.getDeviceId };
}

test('빈 .device-id는 빈 ID가 아니라 새 ID로 채운다', async () => {
  const { root, getDeviceId } = await freshWorkspace();
  await writeFile(join(root, '.device-id'), '');
  const id = await getDeviceId();
  assert.ok(id.length > 0, '빈 문자열 ID 금지');
  assert.equal((await readFile(join(root, '.device-id'), 'utf8')).trim(), id, '파일에 기록');
});

const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0;
test('읽기 권한 오류는 신원을 새로 만들지 않고 드러낸다(복구되면 원래 ID)', { skip: !canDenyRead && 'root·Windows는 chmod 000으로 읽기 거부를 만들 수 없다' }, async () => {
  const { root, getDeviceId } = await freshWorkspace();
  const f = join(root, '.device-id');
  await writeFile(f, 'mac-orig1234\n');
  await chmod(f, 0o000);
  try {
    await assert.rejects(getDeviceId(), (e) => e.code === 'EACCES');
    await assert.rejects(getDeviceId(), (e) => e.code === 'EACCES', '두 번째 호출도 꾸며낸 ID를 돌려주지 않는다');
  } finally {
    await chmod(f, 0o600);
  }
  assert.equal(await getDeviceId(), 'mac-orig1234', '권한이 돌아오면 원래 신원');
  assert.equal((await readFile(f, 'utf8')).trim(), 'mac-orig1234', '원래 파일을 덮어쓰지 않았다');
});
