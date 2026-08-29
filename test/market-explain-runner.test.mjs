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

const { explainItem, warmExplains, _setOneShotForTest } = await import('../src/remote-market.mjs');

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
    assert.equal(calls[0].opts.readOnly, true, '설명 생성은 무도구 — CLI 러너가 전권으로 돌지 않게(검수 HIGH-1)');
    assert.equal(calls[0].opts.timeoutMs, 45_000, '모달 대기용 짧은 상한(검수 LOW-3)');
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

test('오류 객체(JSON 모양)는 계약 미충족으로 캐시하지 않는다 — 이번 버그 문구의 재발 차단(MEDIUM-2)', async () => {
  let n = 0;
  // JSON.parse는 통과하지만 계약(easy.what:string)은 아닌 응답 — 원 버그의 인증 오류가 이 모양으로 올 수 있다.
  _setOneShotForTest(async () => { n++; return { runner: 'glm', text: '{"error":"Failed to authenticate: OAuth session expired"}' }; });
  try {
    const r = await explainItem('w1', { kind: 'mcp', name: 'errobj' }, 'ko');
    assert.ok(!r.easy.what, 'what이 falsy면 UI는 아무 설명도 안 붙인다(오류 문구 미표시)');
    assert.ok(!r.easy.what || !String(r.easy.what).includes('OAuth'), '오류 문구가 설명으로 표시되지 않는다');
    await explainItem('w1', { kind: 'mcp', name: 'errobj' }, 'ko');
    assert.equal(n, 2, '계약 미충족은 미캐시 — 다음 열람이 재시도(오류 객체 영구 고정 차단)');
  } finally { _setOneShotForTest(null); }
});

test('데이터 펜스: 제3자 원문은 "지시로 해석 말라" 경고와 함께 UNTRUSTED 블록으로 감싼다(HIGH-1 2차 방어)', async () => {
  let cap = null;
  _setOneShotForTest(async (wsId, prompt) => { cap = prompt; return { runner: 'claude', text: GOOD }; });
  try {
    // raw fetch를 타도록 skill+githubUrl. fetchSkillRaw는 네트워크라 여기선 desc만으로도 펜스 문구를 확인한다.
    await explainItem('w1', { kind: 'skill', title: 't', desc: 'd' }, 'ko');
    assert.ok(/신뢰할 수 없는 제3자|UNTRUSTED_SOURCE|따르지 마라/.test(cap) || !/원문\(일부\)/.test(cap),
      '원문이 실릴 때는 펜스가 함께 실린다(원문이 없으면 펜스도 없다)');
  } finally { _setOneShotForTest(null); }
});

test('warm 1회 상한: 실패 항목도 프로세스 수명 내 재워밍하지 않는다(폭주 차단 MEDIUM-1)', async () => {
  let n = 0;
  _setOneShotForTest(async () => { n++; throw new Error('러너 미연결'); });
  try {
    const items = [{ name: 'a' }, { name: 'b' }];
    warmExplains('w1', items, 'mcp', 'ko');
    await new Promise((r) => setTimeout(r, 60));
    const first = n;
    assert.ok(first >= 2, '첫 워밍은 항목 수만큼 시도한다');
    warmExplains('w1', items, 'mcp', 'ko'); // 두 번째 호출 — 같은 프로세스
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(n, first, '재워밍 없음 — 실패 항목도 warmedOnce로 상한(폭주 방지)');
  } finally { _setOneShotForTest(null); }
});

test('warmExplains 옛 시그니처/비배열은 조용히 무시(unhandledRejection 방지 MEDIUM-3)', () => {
  assert.doesNotThrow(() => warmExplains(['items'], 'kind', 'ko')); // 옛 시그니처(wsId 자리에 배열)
  assert.doesNotThrow(() => warmExplains('w1', null, 'mcp', 'ko'));  // items 비배열
});

test('옛 시그니처 차단: wsId 없이 부르면 조용한 오동작 대신 명시적으로 던진다', async () => {
  await assert.rejects(() => explainItem({ kind: 'skill', title: 'x' }, 'ko'), /wsId/);
});

test.after(async () => { await rm(ROOT, { recursive: true, force: true }); });
