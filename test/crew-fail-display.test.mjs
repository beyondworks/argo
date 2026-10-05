// UX-A02(2026-10-05): '러너 없음' 실패 줄이 말줄임으로 잘려 다음 행동이 안 보이고, 영어 화면에도 한국어가 나왔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isNoRunnerFailure } from '../app/c/[ws]/crew/[slug]/fail-display.mjs';

test('러너 없음 실패(ko·en·제공 종료)를 알아보고, 다른 실패는 건드리지 않는다', () => {
  assert.equal(isNoRunnerFailure('AI 러너가 하나도 연결돼 있지 않습니다. 설정 → AI 연결에서 Claude·Codex 중 하나를 연결한 뒤 다시 말을 걸어 주세요.'), true);
  assert.equal(isNoRunnerFailure('No AI runner is connected. Connect one in Settings → AI connections (Claude, Codex), then try again.'), true);
  assert.equal(isNoRunnerFailure('연결된 러너는 더 이상 제공되지 않습니다. 설정 → …'), true);
  assert.equal(isNoRunnerFailure('The connected runner is no longer offered. Connect another runner …'), true);
  assert.equal(isNoRunnerFailure('rate limit exceeded'), false);
  assert.equal(isNoRunnerFailure(undefined), false);
});

test('엔진 원문 머리와 맞는지 — 엔진(src/chat.mjs)이 문장을 바꾸면 여기서 먼저 드러난다(계약 대조)', () => {
  const src = readFileSync(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  for (const head of ['AI 러너가 하나도 연결돼 있지 않습니다', 'No AI runner is connected', '연결된 러너는 더 이상 제공되지 않습니다', 'The connected runner is no longer offered']) {
    assert.ok(src.includes(`\`${head}`), `엔진 원문이 "${head}"로 시작해야 화면이 알아본다`);
  }
});
