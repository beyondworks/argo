// 앱 버전은 src/app-version.mjs 한 곳에서 읽는다(2026-10-11, #945 작업 중 발견).
// 사고: 설치본 0.1.101에서 러너 턴 프로브 지문·codex OAuth 헤더의 앱 버전이 늘 '0.0.0'이었다. 번들(webpack)이 `createRequire(import.meta.url)`의
// import.meta.url을 빌드 기기의 절대 경로(file:///Users/runner/work/argo/argo/src/…)로 바꿔 넣어, 사용자 기기에서는 package.json을 못 찾았다.
// 그래서 번들은 next.config가 넣는 NEXT_PUBLIC_APP_VERSION(상단바 버전과 같은 값)을, 번들 밖(argo CLI·시험)은 패키지 루트의 package.json을 쓴다.
// 여기서 잠그는 것:
//   ① 번들 문맥(NEXT_PUBLIC_APP_VERSION이 있으면) — 소비자 셋(메신저 기기 심박·러너 턴 프로브 지문·codex 헤더)이 모두 그 값을 쓴다.
//   ② 번들 밖 — package.json 버전. 단독 CLI 트리(argo-cli/package.json + src/)·앱 server 트리 모양에서도 트리의 package.json을 읽는다.
//   ③ 버전을 읽는 자리가 다시 흩어지지 않는다 — import.meta.url 기준으로 package.json을 읽는 코드는 app-version.mjs뿐이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-app-version-'));

/** 새 node 프로세스에서 세 소비자가 쓰는 앱 버전을 읽는다 — 모듈 최상위 상수라 env는 프로세스 시작 때 정해야 한다 */
function consumers(env = {}) {
  const code = `
    const { APP_VERSION } = await import('./src/gateway/msgr.mjs');
    const rh = await import('./src/runner-health.mjs');
    const { codexHeaders } = await import('./src/runners/codex-oauth.mjs');
    const ua = codexHeaders({ access_token: 'x' })['user-agent'];
    console.log(JSON.stringify({ msgr: APP_VERSION, ua, probeHash: rh.turnProbeHash() }));
    console.log(JSON.stringify({ hashes: Object.fromEntries(${JSON.stringify(['9.8.7', PKG])}.map((v) => [v, rh.turnProbeHash(rh.probeToolSpecs(), v)])) }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, ARGO_ROOT, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [a, b] = r.stdout.trim().split('\n').slice(-2).map((l) => JSON.parse(l));
  return { ...a, ...b };
}

test('① 번들 문맥(NEXT_PUBLIC_APP_VERSION) — 기기 심박·턴 프로브 지문·codex 헤더가 모두 그 버전', () => {
  const c = consumers({ NEXT_PUBLIC_APP_VERSION: '9.8.7' });
  assert.equal(c.msgr, '9.8.7');
  assert.equal(c.ua, 'Argo/9.8.7');
  assert.equal(c.probeHash, c.hashes['9.8.7'], '턴 프로브 지문의 기본 버전이 번들 버전이어야 앱 업데이트 뒤 프로브가 다시 나간다');
});

test('② 번들 밖(env 없음) — 셋 모두 package.json 버전', () => {
  const c = consumers();
  assert.equal(c.msgr, PKG);
  assert.equal(c.ua, `Argo/${PKG}`);
  assert.equal(c.probeHash, c.hashes[PKG]);
});

test('② 단독 CLI·앱 server 트리 모양 — 트리 루트의 package.json 버전을 읽는다', async () => {
  // stage-cli-dist는 argo-cli/package.json에 {version}을 쓰고 src를 통째로 복사한다. 앱 server 트리도 루트 package.json + src/ 구조다.
  const tree = await mkdtemp(join(tmpdir(), 'argo-app-version-tree-'));
  mkdirSync(join(tree, 'src'), { recursive: true });
  copyFileSync(join(ROOT, 'src', 'app-version.mjs'), join(tree, 'src', 'app-version.mjs'));
  writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: 'argo', version: '7.7.7', private: true, type: 'module' }));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./src/app-version.mjs'); console.log(String(m.APP_VERSION));"],
    { cwd: tree, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '7.7.7', r.stderr);
});

test('③ import.meta.url 기준으로 package.json을 읽는 코드는 src/app-version.mjs 하나뿐', () => {
  // 번들에서 import.meta.url은 빌드 기기 경로가 된다 — 이 방식으로 버전을 읽는 사본이 새로 생기면 설치본에서 다시 '0.0.0'·null이 된다.
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.(mjs|js|jsx)$/.test(e.name) ? [join(d, e.name)] : []));
  const pat = [/createRequire\(\s*import\.meta\.url\s*\)\s*\(\s*['"][^'"]*package\.json['"]/, /new URL\(\s*['"][^'"]*package\.json['"]\s*,\s*import\.meta\.url\s*\)/];
  const hits = walk(join(ROOT, 'src')).filter((f) => pat.some((p) => p.test(readFileSync(f, 'utf8')))).map((f) => relative(ROOT, f).split('\\').join('/'));
  assert.deepEqual(hits, ['src/app-version.mjs']);
});
