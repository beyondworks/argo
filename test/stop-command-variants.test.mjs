// K48 — 정지 명령의 띄어쓰기·존댓말 변형이 정지로 인식되지 않으면 새 턴이 겹쳐 시작된다(chat route·크루 화면이 같은 판정을 쓴다).
// 산문·부정문은 여전히 정지가 아니다(stop-control.test.mjs가 잠근 계약과 함께 본다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStopCommand } from '../src/stop-command.mjs';

test('띄어쓰기·존댓말 변형도 정지 명령이다', () => {
  for (const text of ['멈춰 주세요', '멈춰요', '멈춰 줘', '중지해 주세요', '중지해요', '중단해요', '중단해 줘', '그만 해', '그만해요', '그만 하세요', 'stop it', 'Stop it please.', '지금 하던 작업 멈춰 주세요', '작업을 중지해 주세요']) {
    assert.equal(isStopCommand(text), true, text);
  }
});

test('부정문·산문은 변형이 늘어도 정지가 아니다', () => {
  for (const text of ['멈추지 마세요', '작업을 멈추지 말고 계속해', '멈춰 주세요 그리고 메일 보내', '그만 해도 돼?', '중지해 주세요라고 답하면 돼', 'stop it from crashing', '중단해요?', '그만 하지 마']) {
    assert.equal(isStopCommand(text), false, text);
  }
});
