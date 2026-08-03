import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedLocalHost } from '../app/allowed-local-host.mjs';

test('로컬 무인증 Host: 루프백은 설정 없이 허용한다', () => {
  assert.equal(isAllowedLocalHost('localhost:3000', ''), true);
  assert.equal(isAllowedLocalHost('127.0.0.1:3000', ''), true);
  assert.equal(isAllowedLocalHost('[::1]:3000', ''), true);
});

test('로컬 무인증 Host: 환경변수의 정확한 LAN 주소만 추가 허용한다', () => {
  const configured = '192.168.45.49:3000, 100.125.155.44:3000';
  assert.equal(isAllowedLocalHost('192.168.45.49:3000', configured), true);
  assert.equal(isAllowedLocalHost('100.125.155.44:3000', configured), true);
  assert.equal(isAllowedLocalHost('192.168.45.49:3999', configured), false);
  assert.equal(isAllowedLocalHost('evil.example:3000', configured), false);
});
