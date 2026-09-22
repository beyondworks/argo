// GPT-6 Astra — ChatGPT 구독 codex에서 실제 응답 확인(2026-09-22, 깨끗한 CODEX_HOME에서 codex exec -m gpt-6-astra → provider openai, "OK").
// 유건 결정(2026-09-22): 목록에 추가하되 기본은 GPT-5.6 Sol 유지. 러너 전환 시 models[0]이 기본 선택이라 Astra를 맨 앞에 두면 기본이 바뀐다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNNERS, CODEX_DEFAULT_MODEL } from '../src/runners/catalog.mjs';

test('Codex 모델 목록에 GPT-6 Astra가 있다(목록에 없으면 서버가 요청 모델을 기본값으로 바꾼다)', () => {
  const astra = RUNNERS.codex.models.find((m) => m.id === 'gpt-6-astra');
  assert.ok(astra, 'gpt-6-astra가 codex 모델 목록에 없다');
  assert.equal(astra.label, 'GPT-6 Astra');
});

test('Astra 추가 뒤에도 Codex 기본 모델은 GPT-5.6 Sol — 서버 기본값과 러너 전환 기본값(models[0])이 같다', () => {
  assert.equal(CODEX_DEFAULT_MODEL, 'gpt-5.6-sol');
  assert.equal(RUNNERS.codex.models[0].id, CODEX_DEFAULT_MODEL);
});
