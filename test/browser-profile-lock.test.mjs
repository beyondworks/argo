// 프로필 잠금 회수 — 고객 제보 2026-09-15("다른 Argo 인스턴스가 프로필을 쓰고 있다"가 12시간 뒤에도 반복).
// 실측 원인: Argo가 SIGTERM·SIGKILL로 끝나면 크롬 자식이 살아남아(청소는 정상 종료에만 돈다) 프로필 잠금을
// 영구히 쥔다. 아래 실크롬 테스트는 그 상태를 진짜로 만들어(부모가 즉시 끝나 ppid 1이 되는 크롬) 회수를 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readlink } from 'node:fs/promises';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession, closeAllBrowsers, findChrome, lockHolderPid, reclaimOrphanChrome } from '../src/engine/browser-tools.mjs';

const lockErr = new Error('브라우저가 뜨자마자 종료됐습니다(code 21) — stderr: Failed to create /p/SingletonLock: File exists (17)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('lockHolderPid: 이 호스트의 잠금만 판정한다', () => {
  assert.equal(lockHolderPid('mac.local-4242', 'mac.local'), 4242);
  assert.equal(lockHolderPid('other.local-4242', 'mac.local'), 0, '다른 호스트의 잠금은 생사를 알 수 없다');
  assert.equal(lockHolderPid('mac.local-1', 'mac.local'), 0, 'pid 1은 크롬 보유자가 아니다');
  assert.equal(lockHolderPid('', 'mac.local'), 0);
});

test('reclaimOrphanChrome: 고아(부모 없음)만 종료하고, 산 인스턴스·다른 오류는 건드리지 않는다', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'argo-lockunit-'));
  const link = join(profile, 'SingletonLock');
  await spawnLink('host-777', link);
  const killed = [];
  const opts = (info) => ({ inspect: async () => info, kill: (pid) => killed.push(pid), host: 'host', platform: 'darwin' });

  assert.equal(await reclaimOrphanChrome(profile, lockErr, opts({ ppid: 1, command: `chrome --user-data-dir=${profile}` })), true, '고아 크롬은 회수한다');
  assert.deepEqual(killed, [777]);

  killed.length = 0;
  assert.equal(await reclaimOrphanChrome(profile, lockErr, opts({ ppid: 900, command: `chrome --user-data-dir=${profile}` })), false, '부모가 살아 있는 크롬 = 다른 Argo 인스턴스의 것');
  assert.equal(await reclaimOrphanChrome(profile, lockErr, opts({ ppid: 1, command: 'chrome --user-data-dir=/남의/프로필' })), false, '이 프로필의 크롬이 아니다');
  assert.equal(await reclaimOrphanChrome(profile, lockErr, opts(null)), false, '이미 죽은 잠금 — 크롬이 스스로 가져간다');
  assert.equal(await reclaimOrphanChrome(profile, new Error('CDP 연결 실패'), opts({ ppid: 1, command: `chrome --user-data-dir=${profile}` })), false, '잠금과 무관한 오류');
  assert.equal(await reclaimOrphanChrome(profile, lockErr, { ...opts({ ppid: 1, command: `chrome --user-data-dir=${profile}` }), platform: 'win32' }), false, '윈도우는 이 심볼릭 링크를 쓰지 않는다');
  assert.deepEqual(killed, [], '위 경우들에서는 아무도 종료하지 않는다');
  await rm(profile, { recursive: true, force: true });
});

test('실크롬: 고아 크롬이 프로필 잠금을 쥔 상태에서도 다음 기동이 살아난다', { skip: !findChrome() && 'No Chromium installed' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-lockrepro-'));
  const env = { ...process.env, ARGO_ROOT: join(root, 'workspaces'), ARGO_BROWSER_HEADLESS: '1' };
  const profile = BrowserSession.profileDir('co-lock', env);
  const bin = findChrome();
  // 부모가 즉시 끝나는 크롬 = ppid 1 고아(Argo가 SIGTERM으로 죽은 뒤 남는 것과 같은 상태)
  spawn('/bin/sh', ['-c', `"$0" --user-data-dir="$1" --headless=new --no-first-run --no-default-browser-check --remote-debugging-port=0 about:blank >/dev/null 2>&1 & exit 0`, bin, profile], { detached: true, stdio: 'ignore' }).unref();
  // SingletonLock은 "<호스트>-<pid>"를 가리키는 **끊어진** 심볼릭 링크다 — existsSync는 false를 준다(readlink로 본다).
  const link = join(profile, 'SingletonLock');
  let target = '';
  for (let i = 0; i < 100 && !target; i++) { target = await readlink(link).catch(() => ''); if (!target) await sleep(100); }
  assert.ok(target, '고아 크롬이 프로필 잠금을 잡았다');
  const orphanPid = lockHolderPid(target);
  assert.ok(orphanPid > 1, `잠금 보유자 pid를 읽는다: ${orphanPid}`);
  try {
    const s = await BrowserSession.get('co-lock', { env, headless: true });
    assert.equal(s.alive, true, '고아를 회수하고 정상 기동한다');
    assert.notEqual(s.child.pid, orphanPid);
  } finally {
    try { process.kill(orphanPid, 'SIGKILL'); } catch { /* 회수가 이미 종료함 */ }
    await closeAllBrowsers().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

/** 심볼릭 링크 한 개 만들기(크롬의 SingletonLock 모양) */
async function spawnLink(target, path) {
  const { symlink } = await import('node:fs/promises');
  await symlink(target, path).catch(() => {});
}
