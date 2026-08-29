// "이게 뭐예요?" 쉬운 설명의 러너 독립 실행 — 실사용 제보(2026-08-29, GLM만 연결) 회귀 가드.
// 이전 결함: explainItem이 SDK query를 직접 호출(러너 결정·env 주입 없음, 모델 하드코딩)해
// GLM만 연결한 사용자에게 호스트의 만료된 Claude 로그인 오류가 설명으로 표시·캐시됐다.
// 게이트: runOneShot 경유(주입 seam으로 실증 — 직접 SDK 호출로 되돌아가면 fake가 안 불려 red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-explain-'));
process.env.ARGO_ROOT = ROOT; // EXPLAIN_FILE(디스크 캐시)이 임시 루트를 가리키도록 선세팅 후 import

const { explainItem, _setOneShotForTest } = await import('../src/remote-market.mjs');

const GOOD = JSON.stringify({ what: '쉬운 설명', when: ['이럴 때'], examples: ['이렇게'], caution: '' });

test('배선: explainItem은 runOneShot 경유로 회사 러너를 탄다(wsId·프롬프트·모델 전달) + 성공만 캐시', async () => {
  const calls = [];
  _setOneShotForTest(async (wsId, prompt, opts) => { calls.push({ wsId, prompt, opts }); return { runner: 'glm', text: GOOD }; });
  try {
    const r = await explainItem('w1', { kind: 'skill', title: '딥 리서치', desc: '다단 폴백 웹 조사' }, 'ko');
    assert.equal(r.easy.what, '쉬운 설명');
    assert.equal(calls.length, 1, '원샷 경유 1회');
    assert.equal(calls[0].wsId, 'w1', '회사 컨텍스트가 러너 결정에 전달된다');
    assert.ok(calls[0].prompt.includes('딥 리서치'), '항목 정보가 프롬프트에 실린다');
    assert.equal(calls[0].opts.model, 'claude-haiku-4-5-20251001', 'claude 러너 한정 속도 우선 모델(타 러너는 oneshot이 각자 기본 모델로)');
    assert.equal(calls[0].opts.lang, 'ko');
    const r2 = await explainItem('w1', { kind: 'skill', title: '딥 리서치', desc: '다단 폴백 웹 조사' }, 'ko');
    assert.equal(r2.easy.what, '쉬운 설명');
    assert.equal(calls.length, 1, '파싱 성공분은 캐시 — 재호출 없음');
  } finally { _setOneShotForTest(null); }
});

test('정직 오류: 러너 실패는 삼키지 않고 던지며(카드에 원인 표시), 오류는 캐시되지 않는다', async () => {
  let mode = 'fail';
  let ok = 0;
  _setOneShotForTest(async () => {
    if (mode === 'fail') throw new Error('AI 러너가 하나도 연결돼 있지 않습니다 — 설정 → AI 연결에서 연결해 주세요.');
    ok++; return { runner: 'glm', text: GOOD };
  });
  try {
    await assert.rejects(
      () => explainItem('w1', { kind: 'mcp', name: 'notion' }, 'ko'),
      /러너가 하나도 연결돼 있지 않습니다/,
      '오류 원문을 설명으로 위장하지 않는다(이전 결함: 인증 오류가 설명 카드·캐시에 실림)',
    );
    mode = 'ok';
    const r = await explainItem('w1', { kind: 'mcp', name: 'notion' }, 'ko');
    assert.equal(r.easy.what, '쉬운 설명');
    assert.equal(ok, 1, '실패가 캐시되지 않아 다음 열람이 정상 재시도된다');
  } finally { _setOneShotForTest(null); }
});

test('비JSON 응답: 폴백으로 보여주되 캐시하지 않는다(형식 이탈이 설명으로 굳지 않게)', async () => {
  let n = 0;
  _setOneShotForTest(async () => { n++; return { runner: 'glm', text: '그냥 원문 텍스트' }; });
  try {
    const r = await explainItem('w1', { kind: 'mcp', name: 'raw-mcp' }, 'ko');
    assert.equal(r.easy.what, '그냥 원문 텍스트');
    await explainItem('w1', { kind: 'mcp', name: 'raw-mcp' }, 'ko');
    assert.equal(n, 2, '폴백은 미캐시 — 재열람이 재시도한다');
  } finally { _setOneShotForTest(null); }
});

test('옛 시그니처 차단: wsId 없이 부르면 조용한 오동작 대신 명시적으로 던진다', async () => {
  await assert.rejects(() => explainItem({ kind: 'skill', title: 'x' }, 'ko'), /wsId/);
});

test.after(async () => { await rm(ROOT, { recursive: true, force: true }); });
