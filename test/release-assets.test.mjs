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
    for (const file of [...installers, ...updates, ...updates.map(n => `${n}.sig`), 'argo-server-1.2.3-linux-x64.tar.gz', 'install.sh']) put(file);
    const catalog = JSON.stringify({ schema: 1, runners: { openrouter: { add: [], retire: [], alias: {} } } });
    put('model-catalog.json', catalog);
    const result = releaseManifest(dir, product, '1.2.3');
    assert.equal(Object.keys(result.platforms).length, 3);
    assert.equal(result.platforms['windows-x86_64'].url, `https://github.com/beyondworks/${product === 'argo' ? 'argo-agent' : product}/releases/download/v1.2.3/${updates[2]}`);
    assert.throws(() => releaseManifest(dir, product, '1.2.4'));
    for (const file of [...installers, ...updates, ...updates.map(n => `${n}.sig`), ...(product === 'argo' ? ['argo-server-1.2.3-linux-x64.tar.gz', 'install.sh'] : [])]) {
      unlinkSync(join(dir, file));
      assert.throws(() => releaseManifest(dir, product, '1.2.3'), file);
      put(file, '');
      assert.throws(() => releaseManifest(dir, product, '1.2.3'), `empty ${file}`);
      put(file);
    }
    if (product === 'argo') {
      unlinkSync(join(dir, 'model-catalog.json'));
      assert.throws(() => releaseManifest(dir, product, '1.2.3'));
      for (const invalid of ['', 'invalid JSON', 'null', '{}', JSON.stringify({ schema: 1, runners: [] }), JSON.stringify({ schema: 1, runners: { unknown: {} } }), JSON.stringify({ schema: 1, runners: { openrouter: { add: [{ id: '' }] } } })]) {
        put('model-catalog.json', invalid);
        assert.throws(() => releaseManifest(dir, product, '1.2.3'), `catalog: ${invalid}`);
      }
      put('model-catalog.json', catalog);
    }
    put(`${updates[0]}.sig`, ' \n');
    assert.throws(() => releaseManifest(dir, product, '1.2.3'), /Blank updater signature/);
  });
}
test('per-platform collection requires its signed updater, without other platform files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'argo-release-platform-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of ['argo-macos-intel.dmg', 'argo-x86_64-apple-darwin.app.tar.gz', 'argo-x86_64-apple-darwin.app.tar.gz.sig']) writeFileSync(join(dir, file), 'fixture');
  assert.deepEqual(Object.keys(releaseManifest(dir, 'argo', '1.2.3', 'x86_64-apple-darwin').platforms), ['darwin-x86_64']);
  assert.throws(() => releaseManifest(dir, 'argo', '1.2.3'));
});
