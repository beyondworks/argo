// 결재 결과 카드(1:1 화면) — 펼친 본문·요약에 크루에게 하는 지시문 꼬리("결과를 사용자에게 한두 줄로 보고하라." 등)가 보이지 않는다
// (본체 분리 검수 L5, 2026-10-03). 지시문은 approval-actions.mjs가 inbound-marks.mjs의 함수로 만들고, 화면은 같은 상수로 뗀다.
// 모델에게 가는 문자열은 한 글자도 바뀌면 안 된다 — 아래 OLD는 바꾸기 전 approval-actions.mjs의 템플릿을 그대로 옮긴 것이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-approval-card-'));
const { createCompany } = await import('../src/workspace.mjs');
const { _followUpForTest } = await import('../src/approval-actions.mjs');
const { inboundCard, plainPreview } = await import('../app/c/[ws]/crew/[slug]/inbound-card.mjs');

const WS = 'apcard';
await createCompany(WS, '결재사', 'captain');

// 바꾸기 전 템플릿(2026-10-02 커밋 d64bceb9의 approval-actions.mjs followUp에서 그대로) — 사실 문장 / 지시문 꼬리로 나눠 둔다
const OLD = [
  { name: '적용 승인', item: { kind: 'connector', action: 'a · b', payload: { serverId: 'x', tool: 'y' } }, approve: true,
    fact: '(사장 결재) "a · b" 이(가) 승인되었고 시스템이 처리했다 — 실행 취소 — 결재 내용(a · b)과 실행 대상(x · y)이 다르다. 사장에게 다시 올려라.',
    order: '\n결과를 사용자에게 한두 줄로 보고하라. 다시 실행하려 하지 마라(이미 처리됨).' },
  { name: '조직 문서 승인', item: { kind: 'org_doc', action: '휴가 규칙' }, approve: true,
    fact: '(관리자 결재) 조직 문서 제안 "휴가 규칙" 이(가) 승인되어 서버가 문서에 반영했다.',
    order: ' 사용자에게 한두 줄로 보고하라. 문서를 다시 쓰거나 제안하지 마라(이미 반영됨).' },
  { name: '조직 문서 거절', item: { kind: 'org_doc', action: '휴가 규칙' }, approve: false,
    fact: '(관리자 결재) 조직 문서 제안 "휴가 규칙" 이(가) 거절되었다. 반영되지 않았다',
    order: ' — 대안이 있으면 한두 줄로 정리하라.' },
  { name: '능력 승인', item: { kind: 'capability', action: '웹 검색' }, approve: true,
    fact: '(사장 결재) "웹 검색" 이(가) 승인되어 능력이 켜졌다.',
    order: ' 직전에 받은 요청을 이어서 실행하고 결과를 보고하라.' },
  { name: '능력 거절', item: { kind: 'capability', action: '웹 검색' }, approve: false,
    fact: '(사장 결재) "웹 검색" 이(가) 거절되었다.',
    order: ' 그 능력 없이 가능한 대안을 한두 줄로 정리하라.' },
  { name: '일반 승인', item: { kind: 'external', action: '메일 발송' }, approve: true,
    fact: '(사장 결재) 요청한 "메일 발송" 이(가) 승인되었다.',
    order: ' 이제 실행하고 결과를 보고하라.' },
  { name: '일반 거절', item: { kind: 'external', action: '메일 발송' }, approve: false,
    fact: '(사장 결재) 요청한 "메일 발송" 이(가) 거절되었다.',
    order: ' 실행하지 말고, 대안이 있으면 한두 줄로 정리하라.' },
];

/** 실제 followUp을 돌려 모델에게 가는 메시지를 받는다(가짜 러너 — 실제 모델 호출 없음) */
async function sentMessage(item, approve) {
  let got = null;
  await _followUpForTest(WS, { id: `ap-${Math.random().toString(36).slice(2, 8)}`, slug: 'alpha', ...item }, approve, {
    runChat: async (_ws, _slug, msg) => { got = msg; return { reply: '보고했습니다', handover: null, sessionId: null }; },
  });
  return got;
}

test('모델에게 가는 결재 후속 메시지는 바꾸기 전과 한 글자도 다르지 않다(7가지 모양)', async () => {
  for (const c of OLD) assert.equal(await sentMessage(c.item, c.approve), c.fact + c.order, c.name);
});

test('결재 결과 카드 — 펼친 본문·요약에는 사실 문장만, 크루에게 하는 지시문 꼬리는 없다', async () => {
  for (const c of OLD) {
    const card = inboundCard({ who: 'user', text: await sentMessage(c.item, c.approve) });
    assert.equal(card.kind, 'approval', c.name);
    const fact = c.fact.replace(/^\((사장|관리자) 결재\) /, '');
    assert.equal(card.body, fact, c.name);
    assert.doesNotMatch(plainPreview(card.body).text, /보고하라|정리하라|하지 마라/, c.name);
  }
});

test('지시문 꼬리를 못 알아보면 머리말 뒤 문장을 그대로 둔다(숨기지 않는다)', () => {
  const card = inboundCard({ who: 'user', text: '(사장 결재) 요청한 "x" 이(가) 승인되었다. 새 형식의 꼬리.' });
  assert.equal(card.body, '요청한 "x" 이(가) 승인되었다. 새 형식의 꼬리.');
});
