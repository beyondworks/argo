import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnv, parseEnv, uploadPlist } from '../scripts/ios-store.mjs';

test('store build env drops the dev password login and puts the mobile toolchain first on PATH', () => {
  const env = buildEnv({ PATH: '/usr/bin', RUSTUP_HOME: '/tc/rustup', CARGO_HOME: '/tc/cargo' }, parseEnv('VITE_DEV_LOGIN=x\nVITE_API="https://a"\n# c=1\n'));
  assert.equal(env.VITE_DEV_LOGIN, undefined);
  assert.equal(env.VITE_API, 'https://a');
  assert.ok(env.PATH.startsWith('/tc/rustup/toolchains/stable-aarch64-apple-darwin/bin:/tc/cargo/bin:/usr/bin'));
  assert.match(buildEnv({ PATH: '' }).CARGO_HOME, /artifacts\/mobile-native\/cargo$/);
});

test('upload export options target App Store Connect upload for the configured team', () => {
  const plist = uploadPlist('TEAM123');
  for (const needle of ['<string>app-store-connect</string>', '<string>upload</string>', '<string>TEAM123</string>']) assert.ok(plist.includes(needle), needle);
});
