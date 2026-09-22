// codex 자격·조달 락 회귀 3종(감사 2026-09-22 K25·K26·K27) — 모두 실제 모듈 경로를 태우는 행동 테스트.
// K26: 베이스 홈(~/.argo/codex-home) auth.json 심링크가 막힌 Windows(개발자 모드 아님)에서 턴 홈에 자격이 안 들어가
//      host codex 전 턴이 401 "Missing bearer or basic authentication in header"로 죽던 것.
// K27: 복사 모드 회수 판정이 mtime 비교라(copyFile은 mtime 미보존) 갱신 안 한 병렬 사본이 원본을 덮고,
//      정작 회전된 사본의 회수가 건너뛰어져 회전 토큰이 사라지던 것("refresh token already used").
// K25: 조달 락 잔재 판정이 15분이라 연결 직후 앱이 죽으면 15분간 첫 대화가 120초 대기 뒤 거짓 문구로 죽던 것.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

// 격리 HOME — CODEX_TOOL_DIR는 모듈 로드 시 homedir()로 고정되므로 import보다 먼저 심는다(실데이터 미접촉).
const HOME = await mkdtemp(join(tmpdir(), 'argo-codex-k25-27-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME; // 윈도우 os.homedir()는 USERPROFILE을 읽는다
const { codexHome, importCodexAuth, recoverCodexAuth, provisionCodexCli } = await import('../src/runners/codex.mjs');

// Windows(개발자 모드 아님)의 심링크 EPERM을 흉내 — 내장 모듈 바인딩을 바꿔 codex.mjs의 symlink가 실제로 던지게 한다.
const fsp = createRequire(import.meta.url)('node:fs/promises');
const realSymlink = fsp.symlink;
function denySymlink(on) {
  fsp.symlink = on ? async () => { throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' }); } : realSymlink;
  syncBuiltinESMExports();
}

test('K26 심링크가 막힌 환경: host 로그인 자격이 턴 홈에 들어가고, host 재로그인도 다음 턴에 반영된다', async () => {
  await mkdir(join(HOME, '.codex'), { recursive: true });
  await writeFile(join(HOME, '.codex', 'auth.json'), '{"tokens":{"access":"HOST1"}}');
  denySymlink(true);
  try {
    const base = await codexHome();
    const turn1 = await mkdtemp(join(tmpdir(), 'argo-codex-turn-'));
    await importCodexAuth(base, turn1);
    assert.match(await readFile(join(turn1, 'auth.json'), 'utf8').catch(() => ''), /HOST1/, '자격 없는 턴 홈 = codex 401');
    // 사용자가 host codex로 다시 로그인 — 다음 턴은 새 자격을 써야 한다(낡은 복사본에 묶이면 안 된다)
    await writeFile(join(HOME, '.codex', 'auth.json'), '{"tokens":{"access":"HOST2"}}');
    const turn2 = await mkdtemp(join(tmpdir(), 'argo-codex-turn-'));
    await importCodexAuth(await codexHome(), turn2);
    assert.match(await readFile(join(turn2, 'auth.json'), 'utf8').catch(() => ''), /HOST2/, 'host 재로그인이 반영돼야 한다');
  } finally {
    denySymlink(false);
  }
});

test('K27 병렬 복사 턴: 갱신 안 한 사본은 원본을 덮지 않고, 회전된 사본은 회수된다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-codex-k27-'));
  const base = join(dir, 'base'); const t1 = join(dir, 't1'); const t2 = join(dir, 't2');
  for (const d of [base, t1, t2]) await mkdir(d, { recursive: true });
  await writeFile(join(base, 'auth.json'), '{"tokens":{"refresh":"R0"}}');
  const past = Date.now() / 1000 - 3600; // 원본은 한참 전에 쓰였다(프로덕션 모양)
  await utimes(join(base, 'auth.json'), past, past);
  denySymlink(true); // 복사 폴백 경로(Windows)
  let h1, h2;
  try {
    h1 = await importCodexAuth(base, t1);
    h2 = await importCodexAuth(base, t2);
  } finally {
    denySymlink(false);
  }
  assert.equal(h1.mode, 'copy');
  assert.equal(h2.mode, 'copy');
  await writeFile(h1.dst, '{"tokens":{"refresh":"R1"}}'); // 턴 1의 CLI가 토큰을 회전했다
  // 턴 2는 먼저 끝났고 CLI가 자격을 건드리지 않았다 — 되돌릴 게 없다
  assert.equal(await recoverCodexAuth(h2), false, '갱신 안 한 사본이 원본을 덮으면 안 된다');
  assert.equal(await recoverCodexAuth(h1), true, '회전된 사본은 회수돼야 한다');
  assert.match(await readFile(join(base, 'auth.json'), 'utf8'), /R1/, '회전된 refresh 토큰이 원본에 남아야 다음 턴이 산다');
});

const LOCK = join(HOME, '.argo', 'tools', 'codex-cli.lockd');

test('K25 죽은 보유자의 락 잔재(3분 전)는 곧바로 회수 — 120초 대기·거짓 "다른 프로세스" 문구 없음', { timeout: 30_000 }, async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network disabled (test)'); };
  try {
    await mkdir(LOCK, { recursive: true }); // 연결 직후 앱이 죽어 남은 잔재
    const t = Date.now() / 1000 - 180;
    await utimes(LOCK, t, t);
    const t0 = Date.now();
    let msg = '';
    try { await provisionCodexCli(); } catch (e) { msg = String(e.message); }
    const dt = Date.now() - t0;
    assert.ok(dt < 20_000, `잔재 락 때문에 ${dt}ms 대기했다`);
    assert.doesNotMatch(msg, /다른 프로세스에서 진행 중/);
    assert.match(msg, /network disabled|다운로드/, `진짜 원인이 드러나야: ${msg.slice(0, 80)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('K25 살아 있는 보유자는 다운로드 중에도 락을 갱신한다 — 대기자가 잔재로 오판하지 않게', { timeout: 40_000 }, async () => {
  const realFetch = globalThis.fetch;
  let release;
  globalThis.fetch = () => new Promise((_, rej) => { release = rej; }); // 다운로드가 오래 걸리는 중
  try {
    const p = provisionCodexCli().catch((e) => e);
    for (let i = 0; i < 100 && !(existsSync(LOCK) && release); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(LOCK), '전제: 락 보유 중');
    const old = Date.now() / 1000 - 300;
    await utimes(LOCK, old, old); // 심박이 없으면 이 mtime이 그대로 남는다
    await new Promise((r) => setTimeout(r, 16_000));
    const age = Date.now() - (await stat(LOCK)).mtimeMs;
    assert.ok(age < 20_000, `보유 중인데 락 mtime이 ${Math.round(age / 1000)}초 전 — 심박 없음`);
    release(new Error('stop (test)'));
    await p;
    assert.equal(existsSync(LOCK), false, '끝나면 락을 푼다');
  } finally {
    globalThis.fetch = realFetch;
  }
});
