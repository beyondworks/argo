// 버전 4파일 범프 회귀 테스트 — 릴리스 드릴의 반쪽 범프 사고 방지(G007):
// Cargo.lock은 앱 크레이트(name="app") 블록만 갈고, 같은 버전 문자열의 타 크레이트는 불변이어야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVersions, checkVersions, bumpVersions } from '../scripts/bump-version.mjs';

async function fixture(v = '0.1.31') {
  const root = await mkdtemp(join(tmpdir(), 'argo-bump-'));
  await mkdir(join(root, 'src-tauri'), { recursive: true });
  await writeFile(join(root, 'package.json'), `{\n  "name": "argo",\n  "version": "${v}"\n}\n`);
  await writeFile(join(root, 'src-tauri', 'tauri.conf.json'), `{\n  "productName": "argo",\n  "version": "${v}"\n}\n`);
  await writeFile(join(root, 'src-tauri', 'Cargo.toml'), `[package]\nname = "app"\nversion = "${v}"\nedition = "2021"\n`);
  // 함정 재현: 같은 버전 문자열을 가진 타 크레이트(serde)가 앞에 온다 — 앱 블록만 갈려야 한다
  await writeFile(join(root, 'src-tauri', 'Cargo.lock'), `# lock\n[[package]]\nname = "serde"\nversion = "${v}"\n\n[[package]]\nname = "app"\nversion = "${v}"\ndependencies = []\n`);
  return root;
}

test('checkVersions: 4파일 일치 → 버전 반환, 불일치 → 파일별 명시 throw', async () => {
  const root = await fixture();
  assert.equal(await checkVersions(root), '0.1.31');
  await writeFile(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "app"\nversion = "0.1.30"\n');
  await assert.rejects(() => checkVersions(root), /Cargo\.toml=0\.1\.30/, '어느 파일이 다른지 표시');
});

test('bumpVersions: 4파일 동시 범프 + 타 크레이트 불변 + 사후 재검증', async () => {
  const root = await fixture();
  const r = await bumpVersions('0.1.32', root);
  assert.deepEqual(r, { from: '0.1.31', to: '0.1.32' });
  const v = await readVersions(root);
  assert.deepEqual([...new Set(Object.values(v))], ['0.1.32'], '4파일 전부');
  const lock = await readFile(join(root, 'src-tauri', 'Cargo.lock'), 'utf8');
  assert.match(lock, /name = "serde"\nversion = "0\.1\.31"/, '같은 버전 문자열의 타 크레이트는 불변(함정 방어)');
  assert.match(lock, /name = "app"\nversion = "0\.1\.32"/, '앱 크레이트만 범프');
});

test('bumpVersions: 형식 오류·동일 버전·반쪽 상태에서의 범프는 거부', async () => {
  const root = await fixture();
  await assert.rejects(() => bumpVersions('v0.1.32', root), /형식 오류/);
  await assert.rejects(() => bumpVersions('0.1.31', root), /이미/);
  await writeFile(join(root, 'package.json'), '{\n  "version": "0.1.30"\n}\n');
  await assert.rejects(() => bumpVersions('0.1.32', root), /불일치/, '반쪽 상태 위에 겹쳐 쓰지 않는다');
});
