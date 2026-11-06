// 진행 단계 라벨(stageLabel): 대화·회의실 진행 줄이 "undefined…"로 나오던 결함(895a354a, v0.1.103부터)을 잠근다.
//
// app/i18n.jsx는 'use client' JSX 파일이라 plain node ESM이 못 읽는다. msg-time-format.test.mjs와 같이
// 사전·tr·stageLabel 소스를 뽑아 new Function으로 실행해 진짜 반환값을 단언한다(문자열 매칭 아님).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(ROOT, 'app/i18n.jsx'), 'utf8');
const pick = (re, name) => {
  const m = re.exec(src);
  assert.ok(m, `${name}를 소스에서 못 찾음 — 이름·시그니처가 바뀌었을 수 있다`);
  return m[0].replace(/^export /, '');
};
const parts = [
  pick(/^const DICT = \{[\s\S]*?^\};/m, 'DICT'),
  pick(/^export function tr\(lang, key, vars\) \{[\s\S]*?^\}/m, 'tr'),
  pick(/^const STAGE_CODES = new Set\(.*\);$/m, 'STAGE_CODES'),
  pick(/^export function stageLabel\(t, stage, detail = ''\) \{[\s\S]*?^\}/m, 'stageLabel'),
];
// eslint-disable-next-line no-new-func
const { tr, stageLabel, STAGE_CODES, DICT } = new Function(`${parts.join('\n')}\nreturn { tr, stageLabel, STAGE_CODES, DICT };`)();

const codes = [...STAGE_CODES];
const plain = codes.filter((c) => c !== 'runner');
const tOf = (lang) => (key, vars) => tr(lang, key, vars);
const progressLine = (lang, stage, detail) => tr(lang, 'chat.stageEllipsis', { stage: stageLabel(tOf(lang), stage, detail) });

test('옆 동작 고정: 알 수 없는 단계는 원문, 빈 단계는 빈 글자', () => {
  const t = tOf('ko');
  assert.equal(stageLabel(t, '옛 한국어 라벨'), '옛 한국어 라벨');
  assert.equal(stageLabel(t, 'unknown_code', 'x'), 'unknown_code');
  assert.equal(stageLabel(t, ''), '');
  assert.equal(stageLabel(t, null), '');
  assert.equal(stageLabel(t, undefined), '');
});

test('사전: 알려진 단계 코드마다 한국어·영어 문구가 모두 있다', () => {
  assert.ok(codes.length >= 13, '단계 코드 집합을 못 읽음');
  for (const c of codes) {
    const row = DICT[`chat.stage.${c}`];
    assert.ok(row, `사전에 chat.stage.${c}가 없음`);
    assert.ok(row[0] && row[1], `chat.stage.${c}의 ko·en 중 비어 있는 쪽이 있음`);
  }
});

for (const lang of ['ko', 'en']) {
  const col = lang === 'en' ? 1 : 0;

  test(`${lang}: 러너 밖의 모든 단계 코드는 사전 문구로 번역된다`, () => {
    for (const c of plain) assert.equal(stageLabel(tOf(lang), c, '파일.md'), DICT[`chat.stage.${c}`][col], c);
  });

  test(`${lang}: runner 단계는 러너 이름을 넣어 보여 준다`, () => {
    assert.equal(stageLabel(tOf(lang), 'runner', 'Codex'), DICT['chat.stage.runner'][col].replace('{name}', 'Codex'));
  });

  test(`${lang}: runner 단계에 러너 이름이 없어도 "undefined"나 자리표시자가 보이지 않는다`, () => {
    for (const detail of [undefined, null, '']) { // 상태 파일의 detail은 null일 수 있다
      const label = stageLabel(tOf(lang), 'runner', detail);
      assert.equal(typeof label, 'string');
      assert.doesNotMatch(label, /undefined|null|\{name\}/);
    }
  });

  test(`${lang}: 진행 줄(chat.stageEllipsis)에 "undefined"가 나오지 않는다`, () => {
    for (const c of codes) {
      const line = progressLine(lang, c, 'Codex');
      assert.doesNotMatch(line, /undefined/, `${c} → ${line}`);
      assert.ok(line.endsWith('…') && line.length > 1, `${c} → ${line}`);
    }
  });
}
