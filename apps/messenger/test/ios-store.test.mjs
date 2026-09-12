import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnv, parseEnv, uploadPlist } from '../scripts/ios-store.mjs';

test('store build env drops the dev password login and puts the mobile toolchain first on PATH', () => {
  const env = buildEnv({ PATH: '/usr/bin', RUSTUP_HOME: '/tc/rustup', CARGO_HOME: '/tc/cargo' }, parseEnv('VITE_DEV_LOGIN=x\nVITE_API="https://a"\n# c=1\n'));
  assert.equal(env.VITE_DEV_LOGIN, undefined);
  assert.equal(env.VITE_API, 'https://a');
  assert.ok(env.PATH.startsWith('/tc/rustup/toolchains/stable-aarch64-apple-darwin/bin:/tc/cargo/bin:/usr/bin'));
  assert.match(buildEnv({ PATH: '' }).CARGO_HOME, /artifacts[\\/]mobile-native[\\/]cargo$/);
});

test('upload export options target App Store Connect upload for the configured team', () => {
  const plist = uploadPlist('TEAM123');
  for (const needle of ['<string>app-store-connect</string>', '<string>upload</string>', '<string>TEAM123</string>']) assert.ok(plist.includes(needle), needle);
});

import { ipaGate, LOGIN_SCHEME } from '../scripts/ios-store.mjs';
import { readFileSync as rf } from 'node:fs';

test('ipa 게이트: 로그인 복귀 스킴·버전·암호화 면제 셋 다 있어야 통과(실사고 2026-09-11 — 스킴 없는 ipa가 세 버전 나갔다)', () => {
  const ok = { CFBundleURLTypes: [{ CFBundleURLSchemes: [LOGIN_SCHEME] }], CFBundleShortVersionString: '0.1.7', ITSAppUsesNonExemptEncryption: false };
  assert.deepEqual(ipaGate(ok, { version: '0.1.7' }), []);
  assert.match(ipaGate({ ...ok, CFBundleURLTypes: [] }, { version: '0.1.7' })[0], /스킴 없음/);
  assert.match(ipaGate({ ...ok, CFBundleShortVersionString: '0.1.6' }, { version: '0.1.7' })[0], /버전 불일치/);
  assert.match(ipaGate({ ...ok, ITSAppUsesNonExemptEncryption: undefined }, { version: '0.1.7' })[0], /ITSAppUsesNonExemptEncryption/);
});

test('설정 핀: iOS·Android deep-link에 로그인 복귀 스킴이 비어 있으면 안 된다(비면 플러그인이 Info.plist의 스킴을 지운다)', () => {
  const ios = JSON.parse(rf(new URL('../src-tauri/tauri.ios.conf.json', import.meta.url), 'utf8'));
  const android = JSON.parse(rf(new URL('../src-tauri/tauri.android.conf.json', import.meta.url), 'utf8'));
  for (const conf of [ios, android]) assert.ok(conf.plugins['deep-link'].mobile.some((m) => (m.scheme ?? []).includes(LOGIN_SCHEME)), 'deep-link mobile scheme');
});
