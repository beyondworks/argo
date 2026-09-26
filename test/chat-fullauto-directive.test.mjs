// 풀 오토 모드(요구사항 1·2·3) — 크루 지시문(commonDirectives)·request_approval 설명·
// use_connector 설명이 fullAuto 여부로만 갈리는지 잠근다. runChat이 fullAuto를 계산하는 방식
// (companyFullAuto && !guest)은 src/chat.mjs를 코드로 확인했다(행동 테스트는 이 꺼짐/켜짐 인자
// 자체를 직접 주므로 guest 판정 배선까지는 재지 않는다 — 그건 connector-fullauto-live.test.mjs와
// msgr-guest-turn 계열이 진다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-fullauto-directive-'));
const { commonDirectives, connectorToolDescription, makeCrewServer } = await import('../src/chat.mjs');

test('기본값(fullAuto 생략) — 문구가 종전과 동일(회귀 없음)', () => {
  const ko = commonDirectives({ hasTools: true, lang: 'ko' });
  const en = commonDirectives({ hasTools: true, lang: 'en' });
  assert.match(ko, /되돌리기 어렵거나 회사 밖으로 나가는 행동\(발송·게시·구매·삭제·계약 등\)은 승인 없이 절대 실행하지 마라\./);
  assert.match(en, /Never execute actions that are hard to reverse or leave the company/);
  assert.doesNotMatch(ko, /풀 오토/);
  assert.doesNotMatch(en, /full auto mode/);
});

test('fullAuto:true — 결재 예외(삭제·구매결제·민감 정보)만 남고 나머지는 결재 없이 실행하라고 지시한다', () => {
  const ko = commonDirectives({ hasTools: true, lang: 'ko', fullAuto: true });
  const en = commonDirectives({ hasTools: true, lang: 'en', fullAuto: true });
  assert.match(ko, /풀 오토 모드가 켜져 있다/);
  assert.match(ko, /삭제, 돈이 나가는 일\(구매·결제·구독\), 민감 정보 변경/);
  assert.match(en, /full auto mode is on/);
  assert.match(en, /deletion, anything that spends money/);
  // request_approval 자체는 여전히 언급 — 예외 3계급은 그 도구로 올리라는 지시가 남아 있어야 한다
  assert.match(ko, /request_approval/);
  assert.match(en, /request_approval/);
});

test('fullAuto:true + 커넥터 연결 — connectorLine도 같은 예외만 걸린다고 안내한다', () => {
  const ko = commonDirectives({ hasTools: true, lang: 'ko', fullAuto: true, connectors: [{ id: 'gmail', status: 'connected' }] });
  const off = commonDirectives({ hasTools: true, lang: 'ko', fullAuto: false, connectors: [{ id: 'gmail', status: 'connected' }] });
  assert.match(ko, /풀 오토 모드라 그 밖의 쓰기.*결재 없이 실행/);
  assert.doesNotMatch(off, /풀 오토 모드라 그 밖의 쓰기/);
  assert.match(off, /회사 밖으로 나가는 쓰기\(발송·게시·생성·수정·삭제\)는 결재를 먼저 올려라/);
});

test('connectorToolDescription — fullAuto 인자 기본값은 false(기존 호출부 무변경 보장)', () => {
  const d = connectorToolDescription([{ id: 'gmail', status: 'connected', tools: ['send'], more: 0 }], 'ko');
  assert.match(d, /request_approval로 결재를 먼저 올려라/);
  assert.doesNotMatch(d, /풀 오토/);
  const on = connectorToolDescription([{ id: 'gmail', status: 'connected', tools: ['send'], more: 0 }], 'ko', true);
  assert.match(on, /풀 오토 모드가 켜져 있어/);
});

test('makeCrewServer — request_approval 도구 설명이 fullAuto로만 갈린다', async () => {
  // sdkTool로 만든 도구는 서버 내부 상태라 공개 API로 못 읽는다 — sink를 넘겨 실제 등재된 정의를
  // 그대로 읽는다(native-engine 계열 테스트와 같은 패턴).
  const sinkOff = [];
  makeCrewServer('ws-x', 'crew-a', '크루A', [], 0, [], null, 'ko', [], '', sinkOff, null, false);
  const sinkOn = [];
  makeCrewServer('ws-x', 'crew-a', '크루A', [], 0, [], null, 'ko', [], '', sinkOn, null, true);
  const descOf = (sink) => sink.find((d) => d.name === 'request_approval')?.description ?? '';
  assert.doesNotMatch(descOf(sinkOff), /풀 오토/, 'fullAuto:false인데 문구가 바뀌었다');
  assert.match(descOf(sinkOn), /풀 오토 모드가 켜져 있고/, 'fullAuto:true인데 문구가 안 바뀌었다');
  assert.match(descOf(sinkOn), /삭제, 돈이 나가는 일/, '예외 3계급 안내가 빠졌다');
});
