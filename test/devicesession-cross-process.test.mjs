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
/** attempts > 1이면 null을 받을 때마다 gapMs 쉬고 다시 부른다 — 동기화 주기가 다음 회전을 시도하는 것과 같다(백오프 8초보다 길게). */
function rotateChild(root, startAt, { attempts = 1, gapMs = 9_000 } = {}) {
  const script = `
const { getFreshDeviceSession } = await import(${JSON.stringify(srcUrl('devicesession.mjs'))});
await new Promise((r) => setTimeout(r, Math.max(0, ${startAt} - Date.now())));
let s = null;
for (let i = 0; i < ${attempts} && !s; i++) {
  if (i) await new Promise((r) => setTimeout(r, ${gapMs}));
  s = await getFreshDeviceSession();
}
process.stdout.write('\\n@@' + JSON.stringify({ at: s?.access_token ?? null }) + '\\n');
process.exit(0);`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`rotate child timeout\n${err}`)); }, 110_000);
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

test('#791 HIGH-2 — 회전 응답이 21초 걸려도 같은 refresh 토큰을 다시 보내지 않는다(요청 시간 제한 + auth-js 자동 재시도가 겹치면 "Already Used" → 재로그인)', { timeout: 90_000 }, async () => {
  const fake = await startFakeSupabase({ refreshDelayMs: 21_000 }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-devsess-slow-'));
  seedRoot(root, { url: fake.url, expiresAt: 0 });
  const at = await rotateChild(root, Date.now() + 500);
  assert.equal(fake.count('POST /auth/v1/token'), 1, '회전 요청은 한 번');
  assert.deepEqual(fake.reused, []);
  assert.equal(at, 'at-1');
  assert.equal(JSON.parse(readFileSync(join(root, '.device-session.json'), 'utf8')).refresh_token, 'rt-1');
  assert.equal(existsSync(join(root, '.device-session.json.dead')), false, '사망 마커 없음');
});

test('#791 HIGH-2 — 느린 회전(21초) 동안 다른 프로세스가 기다리다 잠금을 회수하지 않는다(살아 있는 주인은 잠금 시각을 갱신)', { timeout: 120_000 }, async () => {
  const fake = await startFakeSupabase({ refreshDelayMs: 21_000 }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-devsess-slow2-'));
  seedRoot(root, { url: fake.url, expiresAt: 0 });
  const startAt = Date.now() + 1500;
  const [a, b] = await Promise.all([rotateChild(root, startAt), rotateChild(root, startAt + 300)]);
  assert.equal(fake.count('POST /auth/v1/token'), 1);
  assert.deepEqual(fake.reused, []);
  assert.equal(a, 'at-1');
  assert.ok(b === 'at-1' || b === null, `기다린 쪽은 새 세션을 받거나(잠금 해제 뒤) 이번엔 null — 옛 토큰을 보내면 안 된다: ${b}`);
});

test('#791 LOW-4 — 크래시가 남긴 주인 없는 잠금이 있어도 로그인 저장은 실패하지 않는다(회수 30초 < 대기 40초)', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-devsess-orphan-'));
  const { mkdir, utimes } = await import('node:fs/promises');
  const { saveDeviceSession, loadDeviceSession } = await import('../src/devicesession.mjs');
  const lock = join(root, '.device-session.lock');
  await mkdir(lock, { recursive: true });
  const past = new Date(Date.now() - 25_000); await utimes(lock, past, past); // 25초 전 크래시 — 5초 뒤 회수 대상
  const t0 = Date.now();
  await saveDeviceSession({ url: 'http://127.0.0.1:9', anonKey: 'anon', session: { access_token: 'a', refresh_token: 'r', expires_at: 0, user: { id: 'u9', email: '' } } }, { root });
  const took = Date.now() - t0;
  assert.ok(took >= 4_000 && took < 15_000, `회수까지 기다린 시간 ${took}ms`);
  assert.equal(loadDeviceSession({ root }).user.id, 'u9');
  assert.equal(existsSync(lock), false);
});

test('#791 재검수 LOW-a — 회전 응답이 50초 걸려도 끊지 않는다: /token 1회·정상 회전, 기다린 다른 프로세스는 40초 뒤 null(옛 토큰을 보내지 않음)', { timeout: 150_000 }, async () => {
  // 45초 상한이었을 때: 45초에 끊김 → 백오프 → 다음 시도가 이미 서버에서 회전된 rt-0을 다시 보냄 → Already Used → 사망 마커 → 재로그인
  const fake = await startFakeSupabase({ refreshDelayMs: 50_000 }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-devsess-50s-'));
  seedRoot(root, { url: fake.url, expiresAt: 0 });
  const startAt = Date.now() + 1500;
  const [a, b] = await Promise.all([
    rotateChild(root, startAt, { attempts: 2 }), // 회전하는 쪽 — 끊겼으면 9초 뒤 다시 시도(동기화 주기)
    rotateChild(root, startAt + 300), // 기다리는 쪽 — 한 번만
  ]);
  assert.equal(fake.count('POST /auth/v1/token'), 1, '회전 요청은 한 번');
  assert.deepEqual(fake.reused, []);
  assert.equal(a, 'at-1');
  assert.equal(b, null, '잠금 대기 40초가 지나면 이번엔 null — 옛 토큰을 보내지 않는다');
  assert.equal(JSON.parse(readFileSync(join(root, '.device-session.json'), 'utf8')).refresh_token, 'rt-1');
  assert.equal(existsSync(join(root, '.device-session.json.dead')), false, '사망 마커 없음');
});
