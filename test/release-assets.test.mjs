import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseManifest } from '../scripts/release-assets.mjs';

for (const product of ['argo', 'argo-messenger']) {
  test(`${product}: all platforms required, nonempty signatures and installers, correct manifest URLs`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'argo-release-assets-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const put = (name, value = 'fixture') => writeFileSync(join(dir, name), value);
    const installers = ['macos-apple-silicon.dmg', 'macos-intel.dmg', 'windows-setup.exe'].map(n => `${product}-${n}`);
    const updates = [`${product}-aarch64-apple-darwin.app.tar.gz`, `${product}-x86_64-apple-darwin.app.tar.gz`, `${product}_1.2.3_x64-setup.exe`];
    // argo 명령 단독 설치 자산(맥·윈도우) + 해시 파일 — argo만(메신저는 없음)
    const cli = product === 'argo' ? ['macos-arm64.tar.gz', 'macos-x64.tar.gz', 'windows-x64.zip'].map(n => `argo-cli-1.2.3-${n}`) : [];
    for (const file of [...installers, ...updates, ...updates.map(n => `${n}.sig`), 'argo-server-1.2.3-linux-x64.tar.gz', 'install.sh', 'install.ps1', ...cli]) put(file);
    const magic = (f) => Buffer.from(f.endsWith('.zip') ? '504b0304' : '1f8b0800', 'hex');
    for (const file of cli) { put(file, magic(file)); put(`${file}.sha256`, `${'a'.repeat(64)}  ${file}\n`); }
    const catalog = JSON.stringify({ schema: 1, runners: { openrouter: { add: [], retire: [], alias: {} } } });
    put('model-catalog.json', catalog);
    const result = releaseManifest(dir, product, '1.2.3');
    assert.equal(Object.keys(result.platforms).length, 3);
    assert.equal(result.platforms['windows-x86_64'].url, `https://github.com/beyondworks/${product === 'argo' ? 'argo-agent' : product}/releases/download/v1.2.3/${updates[2]}`);
    assert.throws(() => releaseManifest(dir, product, '1.2.4'));
    for (const file of [...installers, ...updates, ...updates.map(n => `${n}.sig`), ...(product === 'argo' ? ['argo-server-1.2.3-linux-x64.tar.gz', 'install.sh', 'install.ps1', ...cli] : [])]) {
      unlinkSync(join(dir, file));
      assert.throws(() => releaseManifest(dir, product, '1.2.3'), file);
      put(file, '');
      assert.throws(() => releaseManifest(dir, product, '1.2.3'), `empty ${file}`);
      put(file, cli.includes(file) ? magic(file) : 'fixture');
    }
    if (product === 'argo') {
      unlinkSync(join(dir, 'model-catalog.json'));
      assert.throws(() => releaseManifest(dir, product, '1.2.3'));
      for (const invalid of ['', 'invalid JSON', 'null', '{}', JSON.stringify({ schema: 1, runners: [] }), JSON.stringify({ schema: 1, runners: { unknown: {} } }), JSON.stringify({ schema: 1, runners: { openrouter: { add: [{ id: '' }] } } })]) {
        put('model-catalog.json', invalid);
        assert.throws(() => releaseManifest(dir, product, '1.2.3'), `catalog: ${invalid}`);
      }
      put('model-catalog.json', catalog);
      for (const file of cli) { // 해시 파일이 없거나 형식이 다르면 막는다 — 설치 스크립트가 해시 확인에 실패해 설치가 안 된다
        unlinkSync(join(dir, `${file}.sha256`));
        assert.throws(() => releaseManifest(dir, product, '1.2.3'), `${file}.sha256`);
        put(`${file}.sha256`, 'not a checksum');
        assert.throws(() => releaseManifest(dir, product, '1.2.3'), /Bad checksum file/);
        put(`${file}.sha256`, `${'a'.repeat(64)}  ${file}\n`);
        put(file, 'not an archive'); // 이름만 맞고 형식이 다른 자산(예: GNU tar가 만든 .zip)
        assert.throws(() => releaseManifest(dir, product, '1.2.3'), /Not a (zip|gzip) archive/);
        put(file, magic(file));
      }
    }
    put(`${updates[0]}.sig`, ' \n');
    assert.throws(() => releaseManifest(dir, product, '1.2.3'), /Blank updater signature/);
  });
}
test('per-platform collection requires its signed updater, without other platform files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'argo-release-platform-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of ['argo-macos-intel.dmg', 'argo-x86_64-apple-darwin.app.tar.gz', 'argo-x86_64-apple-darwin.app.tar.gz.sig']) writeFileSync(join(dir, file), 'fixture');
  writeFileSync(join(dir, 'argo-cli-1.2.3-macos-x64.tar.gz'), Buffer.from('1f8b0800', 'hex'));
  writeFileSync(join(dir, 'argo-cli-1.2.3-macos-x64.tar.gz.sha256'), `${'b'.repeat(64)}  argo-cli-1.2.3-macos-x64.tar.gz\n`);
  assert.deepEqual(Object.keys(releaseManifest(dir, 'argo', '1.2.3', 'x86_64-apple-darwin').platforms), ['darwin-x86_64']);
  assert.throws(() => releaseManifest(dir, 'argo', '1.2.3'));
});

// 설정 핀: 수동 실행의 server_only는 데스크톱 빌드만 건너뛰고, 발행(release 잡)은 태그 실행이면서 build·server가 성공했을 때만 한다(#773 검수 L7)
test('release.yml: server_only가 태그 발행 흐름을 바꾸지 않는다', async () => {
  const { readFileSync } = await import('node:fs');
  const y = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const job = name => y.split(/\n  (?=[a-z-]+:\n)/).find(b => b.startsWith(`${name}:\n`)); // 최상위 잡 단위로 자른다
  assert.match(job('build'), /\n    if: github\.event_name != 'workflow_dispatch' \|\| !inputs\.server_only\n/);
  const release = job('release');
  assert.match(release, /\n    needs: \[build, server\]\n/);
  assert.match(release, /\n    if: success\(\) && startsWith\(github\.ref, 'refs\/tags\/v'\)\n/);
});
