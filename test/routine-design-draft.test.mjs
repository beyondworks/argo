// 루틴 설계 확장 회귀 — "입력한 프롬프트 그대로 사용"(유건 지시 2026-08-05)의 재발 방지.
// 생성 경로가 둘(자연어 초안·직접 입력 확장)이라 규격(PROMPT_DESIGN_SPEC)을 공유하는지도 잠근다
// (#855604d "실행 갈래가 둘이면 갈래마다 세라").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-routinedesign-'));
const { PROMPT_DESIGN_SPEC, refineRoutinePrompt } = await import('../src/routines.mjs');
const { readFile } = await import('node:fs/promises');
const src = await readFile(new URL('../src/routines.mjs', import.meta.url), 'utf8');

test('설계 규격: 목적·단계·산출물·기준 구조와 원문 복사 금지·환각 금지를 명시한다', () => {
  for (const anchor of ['목적', '할 일', '산출물', '기준', '원문 복사 금지', '지어내지 않는다']) {
    assert.ok(PROMPT_DESIGN_SPEC.includes(anchor), `규격에 "${anchor}" 필요`);
  }
});

test('두 생성 경로(DRAFT·REFINE)가 같은 설계 규격을 공유한다', () => {
  const draftBody = src.split('const DRAFT_PROMPT')[1]?.split('const REFINE_PROMPT')[0] ?? '';
  const refineBody = src.split('const REFINE_PROMPT')[1]?.split('export async function refineRoutinePrompt')[0] ?? '';
  assert.ok(draftBody.includes('PROMPT_DESIGN_SPEC'), '자연어 초안이 규격 공유');
  assert.ok(refineBody.includes('PROMPT_DESIGN_SPEC'), '직접 입력 확장이 규격 공유');
});

test('refineRoutinePrompt: 빈 입력은 실행 전에 거부(러너 호출 없음)', async () => {
  await assert.rejects(() => refineRoutinePrompt('no-such-ws', '  ', { lang: 'ko' }), /지시문을 먼저/);
  await assert.rejects(() => refineRoutinePrompt('no-such-ws', '', { lang: 'en' }), /instruction first/);
});

test('배선: parse 라우트가 mode refine을 refineRoutinePrompt로 보낸다', async () => {
  const route = await readFile(new URL('../app/api/companies/[ws]/routines/parse/route.js', import.meta.url), 'utf8');
  assert.ok(/mode === 'refine'/.test(route) && route.includes('refineRoutinePrompt('), 'refine 분기 배선');
  assert.ok(route.includes('draftRoutineFromText('), '기존 자연어 경로 유지');
});
