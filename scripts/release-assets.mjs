#!/usr/bin/env node
// One artifact contract for CI and manual workflow_dispatch publication.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateOverlay } from '../src/runners/catalog-remote.mjs';

export function releaseManifest(dir, product, version, target) {
  assert(['argo', 'argo-messenger'].includes(product), 'Unknown release product');
  assert(/^\d+\.\d+\.\d+$/.test(version), 'Expected a release version without v');
  const files = readdirSync(dir);
  const nonempty = name => { assert(statSync(join(dir, name)).isFile() && statSync(join(dir, name)).size > 0, `Empty asset: ${name}`); return name; };
  const pick = re => { const found = files.filter(f => re.test(f)); assert.equal(found.length, 1, `Expected one asset matching ${re}, found ${found.length}`); return nonempty(found[0]); };
  const repo = product === 'argo' ? 'argo-agent' : 'argo-messenger';
  const base = `https://github.com/beyondworks/${repo}/releases/download/v${version}`;
  const platforms = {};
  const targets = [
    ['aarch64-apple-darwin', 'darwin-aarch64', 'macos-apple-silicon.dmg'],
    ['x86_64-apple-darwin', 'darwin-x86_64', 'macos-intel.dmg'],
    ['x86_64-pc-windows-msvc', 'windows-x86_64', 'windows-setup.exe'],
  ];
  assert(!target || targets.some(t => t[0] === target), 'Unknown release target');
  for (const [rust, platform, installer] of targets) {
    if (target && target !== rust) continue;
    nonempty(`${product}-${installer}`);
    const name = platform.startsWith('darwin')
      ? nonempty(`${product}-${rust}.app.tar.gz`)
      : pick(new RegExp(`^${product}_${version.replaceAll('.', '\\.')}_(?:x64)-setup\\.exe$`));
    const signature = readFileSync(join(dir, nonempty(`${name}.sig`)), 'utf8').trim();
    assert(signature.length > 0, `Blank updater signature: ${name}`);
    platforms[platform] = { url: `${base}/${name}`, signature };
  }
  if (!target && product === 'argo') {
    nonempty(`argo-server-${version}-linux-x64.tar.gz`);
    nonempty('install.sh');
    const catalog = JSON.parse(readFileSync(join(dir, nonempty('model-catalog.json')), 'utf8'));
    assert(!Array.isArray(catalog?.runners) && validateOverlay(catalog), 'Invalid model-catalog.json schema');
  }
  return { version, pub_date: new Date().toISOString(), platforms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [dir, product, version, target] = process.argv.slice(2);
  const manifest = releaseManifest(resolve(dir), product, version.replace(/^v/, ''), target);
  if (!target) writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Release assets OK: ${product} ${manifest.version} (${Object.keys(manifest.platforms).join(', ')})`);
}
