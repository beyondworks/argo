// 2026-09-23 유건 제보(스크린샷): 전달된 글·인용 한 줄에 "(부재중 대기분 · 215분 전 지시)"와 **·## 기호가 그대로 보였다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAwayNote, plainPreview } from '../src/msg-text.mjs';

test('부재중 안내는 첫 줄일 때만 떼어 낸다(ko·en)', () => {
  assert.deepEqual(splitAwayNote('(부재중 대기분 · 215분 전 지시)\n**완료.** 본문'), { note: '부재중 대기분 · 215분 전 지시', text: '**완료.** 본문' });
  assert.deepEqual(splitAwayNote('(Handled after being away · asked 3 min ago)\nok'), { note: 'Handled after being away · asked 3 min ago', text: 'ok' });
  assert.equal(splitAwayNote('앞말 (부재중 대기분 · 2분 전 지시)\nx').note, '', '본문 중간은 사람이 쓴 글이라 건드리지 않는다');
  assert.equal(splitAwayNote('(부재중 대기분 · 2분 전 지시)').note, '', '줄바꿈 없는 한 줄은 본문 자체');
  assert.deepEqual(splitAwayNote(null), { note: '', text: '' });
});

test('한 줄 미리보기 — 안내·마크다운 기호를 걷고 글자는 남긴다', () => {
  assert.equal(plainPreview('(부재중 대기분 · 215분 전 지시)\n**완료. 근본원인은** 수신\n\n## 실측한 진짜 원인\n`getUpdates` 호출'),
    '완료. 근본원인은 수신 실측한 진짜 원인 getUpdates 호출');
  assert.equal(plainPreview('- 하나\n- [링크](https://x.y) 둘\n> 인용\n1. 셋'), '하나 링크 둘 인용 셋');
  assert.equal(plainPreview('```py\nprint(1)\n```'), 'print(1)');
  assert.equal(plainPreview('2*3 = 6, a * b, *기울임*'), '2*3 = 6, a * b, 기울임');
  assert.equal(plainPreview('x'.repeat(200)).length, 120);
});
