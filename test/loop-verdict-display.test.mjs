// 1:1 화면 — 루프 루틴 답 끝의 판정 표지(`LOOP: continue` 등)는 루프 엔진이 읽는 내부 표지라 화면에서 뺀다(유건 확인 2026-10-02).
// 저장된 기록과 루프 판정(parseLoopVerdict)은 그대로다. 제거는 판정과 **같은 정규식·같은 '마지막 줄' 규칙**(src/loop-verdict.mjs)을 써서
// 엔진이 표지로 읽는 줄만 빠진다. 표지를 만드는 문구(loopVerdictLine — 루프 프로토콜 지시문)가 바뀌면 이 테스트가 실패한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripLoopVerdict, loopVerdictLine, parseLoopVerdict as pureParse } from '../src/loop-verdict.mjs';
import { parseLoopVerdict, LOOP_VERDICT_RE } from '../src/routines.mjs';
import { crewReplyText } from '../app/c/[ws]/crew/[slug]/inbound-card.mjs';
import { routineHead, loopHead } from '../src/inbound-marks.mjs';

test('표지를 만드는 문구와 엔진 판정·화면 제거가 같은 형식 — 형식이 바뀌면 여기서 실패', () => {
  for (const [v, rest] of [['continue', ''], ['done', ' 모든 항목 점검 완료'], ['blocked', ' 배포 승인이 필요함']]) {
    const reply = `오늘 몫을 끝냈습니다.\n${loopVerdictLine(v, rest)}`;
    assert.equal(parseLoopVerdict(reply).verdict, v, v);
    assert.equal(parseLoopVerdict(reply).missing, false, v);
    assert.equal(stripLoopVerdict(reply), '오늘 몫을 끝냈습니다.', v);
  }
  assert.equal(loopVerdictLine('continue'), 'LOOP: continue');
  assert.equal(parseLoopVerdict, pureParse); // 엔진과 화면이 같은 함수
  assert.match('LOOP: done ok', LOOP_VERDICT_RE);
});

test('표지 줄만 빠진다 — 백틱·대소문자·끝 공백·마침표 변형도 판정이 읽는 그대로', () => {
  assert.equal(stripLoopVerdict('## 보고\n- 매출 +8%\n\n`LOOP: blocked 결재 필요`  \n\n'), '## 보고\n- 매출 +8%');
  assert.equal(stripLoopVerdict('끝\nloop: DONE.'), '끝');
  assert.equal(stripLoopVerdict('LOOP: continue'), '');
});

test('본문 중간·마지막이 아닌 비슷한 글은 남는다(엔진도 마지막 줄만 판정)', () => {
  const mid = 'LOOP: continue 라고 적으면 다음 회차로 넘어갑니다.\n그 뒤에 설명이 이어집니다.';
  assert.equal(stripLoopVerdict(mid), mid);
  assert.equal(parseLoopVerdict(mid).missing, true);
  const inline = '마지막 줄은 `LOOP: done` 형식을 쓰세요 라고 안내했습니다';
  assert.equal(stripLoopVerdict(inline), inline);
  assert.equal(stripLoopVerdict('표지 없음'), '표지 없음');
  assert.equal(stripLoopVerdict(''), '');
});

test('화면 연결 — 루프 루틴 지시 바로 뒤 크루 답만 뺀다, 일반 대화·루틴(루프 아님) 뒤는 그대로', () => {
  const reply = { who: 'crew', text: '매출 정리 완료\nLOOP: continue' };
  const loopTurn = { who: 'user', via: 'routine', text: `${routineHead('아침 보고', 'ko')} 정리하라${loopHead('ko')} 이것은 반복 루프의 1회차다.` };
  assert.equal(crewReplyText(loopTurn, reply), '매출 정리 완료');
  assert.equal(crewReplyText({ who: 'user', text: '루프 표지 형식이 뭐야?' }, reply), reply.text);
  assert.equal(crewReplyText({ who: 'user', via: 'routine', text: `${routineHead('일간', 'ko')} 정리하라` }, reply), reply.text);
  assert.equal(crewReplyText(undefined, reply), reply.text);
});
