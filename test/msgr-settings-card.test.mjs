// CX-12·CX-13(2026-10-05 연결성 검수): 설정 메신저 카드가 개인 공간 이전 기준이라 조직이 없으면 '연결 필요'·'조직을 만드세요'만
// 보이고 실행기 연결 상태를 숨겼다. 본체 어디에도 오피스로 가는 길이 없었다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msgrConnectionChip, msgrShowRuntime, OFFICE_URL, MESSENGER_PAGE } from '../app/c/[ws]/settings/msgr-card.mjs';

test('조직이 없어도 개인 공간에 연결된 크루가 있으면 "개인 공간 연결됨" — 연결 필요로 보이지 않는다', () => {
  assert.equal(msgrConnectionChip({ regCount: 0, personalCount: 3 }), 'personal');
  assert.equal(msgrConnectionChip({ regCount: 2, personalCount: 3 }), 'connected');
  assert.equal(msgrConnectionChip({ regCount: 0, personalCount: 0 }), 'notConnected');
});

test('실행기 연결 상태는 조직 여부와 상관없이 보인다(로그인 + 크루 있음)', () => {
  assert.equal(msgrShowRuntime({ signedIn: true, agentCount: 2 }), true);
  assert.equal(msgrShowRuntime({ signedIn: true, agentCount: 0 }), false);
  assert.equal(msgrShowRuntime({ signedIn: false, agentCount: 2 }), false);
});

test('진입 링크는 https 고정 주소 — 오피스(웹)·메신저 받기 안내 한 곳', () => {
  assert.equal(new URL(OFFICE_URL).protocol, 'https:');
  assert.equal(new URL(MESSENGER_PAGE).protocol, 'https:');
});
