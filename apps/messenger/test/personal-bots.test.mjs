// 개인 공간 봇 쌍둥이 표시 판정(src/personal-bots.mjs) — 주인에게만 오는 열(ready·org_label)과 옛 서버·친구 행(열 없음)의 경계.
import test from 'node:test';
import assert from 'node:assert/strict';
import { twinRelink, twinOrgLabel, crewAddable } from '../src/personal-bots.mjs';

test('다시 연결 필요는 서버가 ready=false를 준 봇 쌍둥이만', () => {
  assert.equal(twinRelink({ hosting: 'bot', ready: false }), true);
  assert.equal(twinRelink({ hosting: 'bot', ready: true }), false);
  assert.equal(twinRelink({ hosting: 'bot', ready: null }), false, '친구 행(주인 아님)은 ready null — 표시 안 함');
  assert.equal(twinRelink({ hosting: 'bot' }), false, '옛 서버(열 없음)');
  assert.equal(twinRelink({ hosting: 'local', ready: false }), false, 'Argo 크루는 대상 아님');
  assert.equal(twinRelink(null), false);
});

test('조직 이름 라벨은 봇 쌍둥이에 org_label이 있을 때만', () => {
  assert.equal(twinOrgLabel({ hosting: 'bot', org_label: ' Lean ' }), 'Lean');
  assert.equal(twinOrgLabel({ hosting: 'bot', org_label: null }), null);
  assert.equal(twinOrgLabel({ hosting: 'bot', org_label: '  ' }), null);
  assert.equal(twinOrgLabel({ hosting: 'local', org_label: 'Lean' }), null);
});

test('방 추가 후보에서 답할 수 없는 쌍둥이만 뺀다', () => {
  assert.equal(crewAddable({ hosting: 'bot', ready: false }), false);
  assert.equal(crewAddable({ hosting: 'bot', ready: true }), true);
  assert.equal(crewAddable({ hosting: 'local' }), true);
});
