// 크루 이름 유일성 — 신고 2026-07-26 "이름 지정 없이 3명 영입했더니 전부 서윤"(QA P1-1).
// 원인: 영입 프롬프트가 로스터를 안 넘겨 같은 조건에서 같은 고빈도 이름이 나오는 필연.
// 방어 2겹 중 1겹(프롬프트 제외 목록)과 로스터 원천(existingNames)을 잠근다.
// 사후 가드(이름만 재요청)는 runOneShot(실 LLM)이 필요해 단위로 못 태운다 — 통합 검증에서.
// ⚠ ARGO_ROOT는 persona.mjs(→workspace.mjs) 동적 임포트보다 먼저(thread-artifacts와 동일 규칙).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-names-'));
process.env.ARGO_ROOT = ROOT;
const { CARD_PROMPT, existingNames } = await import('../src/persona.mjs');

test('CARD_PROMPT: 자동 생성이면 기존 이름 제외 목록이 양 언어 프롬프트에 실린다', () => {
  const ko = CARD_PROMPT('마케팅 담당', undefined, 'ko', ['서윤', '지훈']);
  assert.match(ko, /이미 있으니 제외: 서윤, 지훈/);
  const en = CARD_PROMPT('marketing', undefined, 'en', ['Ava', 'Noah']);
  assert.match(en, /NOT any of these existing names: Ava, Noah/);
  // 이름 지정 영입은 제외 목록 무관 — 사장의 선택을 손대지 않는다
  const named = CARD_PROMPT('마케팅 담당', '서윤', 'ko', ['서윤']);
  assert.match(named, /"서윤" 그대로/);
  assert.doesNotMatch(named, /제외:/);
  // 로스터가 비면(첫 영입) 제외 문구 자체가 없다 — 프롬프트 비대화 방지
  assert.doesNotMatch(CARD_PROMPT('기획', undefined, 'ko', []), /제외:/);
});

test('existingNames: agents/ 카드 frontmatter의 표시 이름을 모은다(부재 시 빈 배열)', async () => {
  assert.deepEqual(await existingNames('no-such-co'), [], 'agents/ 부재 = 첫 영입');
  await mkdir(join(ROOT, 'demo', 'agents'), { recursive: true });
  await writeFile(join(ROOT, 'demo', 'agents', 'seoyun.md'), '---\nname: 서윤\nslug: seoyun\nrole: 기획\n---\n\n# 서윤 — 기획\n');
  await writeFile(join(ROOT, 'demo', 'agents', 'beast.md'), '---\nname: 비스트\nslug: beast\nrole: 개발\n---\n\n# 비스트 — 개발\n');
  const names = await existingNames('demo');
  assert.deepEqual(names.sort(), ['비스트', '서윤']);
  await rm(ROOT, { recursive: true, force: true });
});
