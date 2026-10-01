// 기기 세션 회전의 프로세스 간 잠금 — 설계 2-2 조건 1(2026-10-01).
// 앱 사이드카·argo CLI·상주가 같은 데이터 루트를 쓰면 만료 직전에 둘이 같은 refresh 토큰으로 동시에 회전한다. 한 프로세스 안의 잠금
// (withLock — mutex.mjs)은 다른 프로세스를 모른다. GoTrue는 재사용 간격(10초) 밖 재사용을 세션 가족 폐기로 처리한다(2026-09-03 실사고).
// 가짜 GoTrue는 그보다 엄격하게 한 번 쓴 토큰을 바로 거절한다(간격 0초) — 재사용이 한 번이라도 나면 이 테스트가 잡는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, childEnv, srcUrl } from './helpers/sync-child.mjs';

const fakes = [];
after(async () => { for (const f of fakes) await f.close(); });

/** 자식 하나 — startAt(epoch ms)까지 기다렸다가 getFreshDeviceSession()을 부르고 받은 access token을 돌려준다. */
function rotateChild(root, startAt) {
  const script = `
const { getFreshDeviceSession } = await import(${JSON.stringify(srcUrl('devicesession.mjs'))});
await new Promise((r) => setTimeout(r, Math.max(0, ${startAt} - Date.now())));
const s = await getFreshDeviceSession();
process.stdout.write('\\n@@' + JSON.stringify({ at: s?.access_token ?? null }) + '\\n');
process.exit(0);`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`rotate child timeout\n${err}`)); }, 45_000);
    p.on('exit', () => {
      clearTimeout(t);
      const line = out.split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`no result\n${out}\n${err}`));
      resolve(JSON.parse(line.slice(2)).at);
    });
  });
}

test('두 프로세스가 같은 만료 세션을 동시에 회전 → 토큰 재사용 0, 회전은 한 번, 둘 다 같은 새 세션을 받는다', async () => {
  // 회전 응답을 400ms 늦춰 두 요청이 겹치는 창을 넓힌다(잠금이 없으면 두 번째가 같은 rt-0을 보낸다)
  const fake = await startFakeSupabase({ refreshDelayMs: 400 }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-devsess-xproc-'));
  seedRoot(root, { url: fake.url, expiresAt: 0 }); // 만료 — 첫 사용에 회전(CLI 로그인 직후와 같은 상태)
  const startAt = Date.now() + 1500; // 두 자식의 모듈 로드가 끝난 뒤 같은 순간에 출발
  const [a, b] = await Promise.all([rotateChild(root, startAt), rotateChild(root, startAt)]);
  assert.deepEqual(fake.reused, [], `재사용된 refresh 토큰: ${fake.reused.join(',')}`);
  assert.equal(fake.issued(), 1, '회전은 한 번 — 잠금을 기다린 쪽은 디스크를 다시 읽어 새 세션을 쓴다');
  assert.equal(a, 'at-1');
  assert.equal(b, 'at-1');
  const disk = JSON.parse(readFileSync(join(root, '.device-session.json'), 'utf8'));
  assert.equal(disk.refresh_token, 'rt-1');
  assert.equal(existsSync(join(root, '.device-session.json.dead')), false, '사망 마커가 없어야 한다(재로그인 요구 안 함)');
  assert.equal(existsSync(join(root, '.device-session.lock')), false, '잠금은 끝나면 지운다');
});

test('평소(만료 60초 전이 아님)에는 프로세스 간 잠금을 만들지 않는다 — 읽기 경로에 파일 I/O를 늘리지 않음', async () => {
  const fake = await startFakeSupabase(); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-devsess-fast-'));
  seedRoot(root, { url: fake.url }); // 만료 1시간 뒤
  process.env.ARGO_ROOT = root;
  const { getFreshDeviceSession } = await import('../src/devicesession.mjs');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, '.device-session.lock')); // 다른 프로세스가 잠금을 쥔 상태여도
  const t0 = Date.now();
  const s = await getFreshDeviceSession({ root });
  assert.equal(s.access_token, 'h.p.s');
  assert.ok(Date.now() - t0 < 1000, '평소 경로는 잠금을 기다리지 않는다');
  assert.equal(fake.count('POST /auth/v1/token'), 0);
});
