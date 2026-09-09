import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessengerDisposition, messengerHandoffHint } from '../src/gateway/msgr-handoff.mjs';

test('실제 다음 작업 전달의 마지막 판정 줄만 제거한다', () => {
  assert.deepEqual(parseMessengerDisposition('@베타 초안의 출처를 확인해 주세요.\nMSGR: handoff'), {
    text: '@베타 초안의 출처를 확인해 주세요.', disposition: 'handoff',
  });
  assert.deepEqual(parseMessengerDisposition('검토 결과입니다.\r\nMSGR: done   \r\n\t  '), {
    text: '검토 결과입니다.', disposition: 'done',
  });
});

test('완료 판정은 숫자나 자연어의 완료 표현을 해석하지 않는다', () => {
  for (const text of ['**6** — 끝이다. @슈리', '@슈리 감사해요. 검토 완료.', '@Shuri done, thank you.', '@베타 다음 단계를 진행해 주세요.']) {
    assert.deepEqual(parseMessengerDisposition(text), { text, disposition: null });
  }
  assert.deepEqual(parseMessengerDisposition('@슈리 감사해요.\nMSGR: done'), {
    text: '@슈리 감사해요.', disposition: 'done',
  });
});

test('마커가 없거나 잘못된 값이면 본문을 고치거나 판정을 추론하지 않는다', () => {
  for (const text of ['', '  ', 'MSGR: stop', 'MSGR: DONE', 'MSGR: done 이후', 'MSGR: done\n실제 마지막 답변']) {
    assert.deepEqual(parseMessengerDisposition(text), { text, disposition: null });
  }
  assert.deepEqual(parseMessengerDisposition(null), { text: '', disposition: null });
});

test('인라인·인용·들여쓴 코드의 마커를 현재 턴 판정으로 읽지 않는다', () => {
  for (const text of ['설명: MSGR: done', '> MSGR: done', '    MSGR: done', '\tMSGR: done', '`MSGR: done`', '"MSGR: done"']) {
    assert.deepEqual(parseMessengerDisposition(text), { text, disposition: null });
  }
});

test('닫히지 않은 코드 펜스 내부의 마지막 마커를 읽지 않는다', () => {
  for (const text of ['```text\nMSGR: done', '~~~text\r\nMSGR: handoff', '````\n```\nMSGR: done', '~~~\n```\nMSGR: done', '```\n```not-a-close\nMSGR: done']) {
    assert.deepEqual(parseMessengerDisposition(text), { text, disposition: null });
  }
});

test('닫힌 코드·인용 다음 독립 줄의 판정은 읽는다', () => {
  for (const text of ['```text\nMSGR: done\n```', '~~~~\nMSGR: handoff\n~~~~~', '> MSGR: done']) {
    assert.deepEqual(parseMessengerDisposition(`${text}\nMSGR: handoff`), { text, disposition: 'handoff' });
  }
});

test('이전 본문 안 판정은 보존하고 마지막 독립 줄만 현재 판정으로 쓴다', () => {
  const text = '이전 결과:\nMSGR: done\n@베타 새 요청의 출처를 확인해 주세요.';
  assert.deepEqual(parseMessengerDisposition(`${text}\nMSGR: handoff`), { text, disposition: 'handoff' });
});

test('빈 답변도 명시 판정은 전달한다', () => {
  assert.deepEqual(parseMessengerDisposition('MSGR: done'), { text: '', disposition: 'done' });
});

test('한·영 공통 지침은 중간 넘김과 완료를 구분하고 누락·충돌 규칙을 설명한다', () => {
  for (const lang of ['ko', 'en']) {
    const hint = messengerHandoffHint(lang);
    assert.match(hint, /MSGR: handoff/);
    assert.match(hint, /MSGR: done/);
    assert.match(hint, /send_to_crew/);
    assert.match(hint, /@/);
  }
  assert.equal(messengerHandoffHint(), messengerHandoffHint('ko'));
});
