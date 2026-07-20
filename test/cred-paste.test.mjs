// 붙여넣기 자격 자기치유 회귀 테스트(실사용 2026-07-20 신고) — 터미널 80칸에서 줄바꿈된 108자
// setup-token 복사본(개행 혼입)이 접두사 형식검사를 통과한 채 무효로 저장되던 문제.
// 유효 토큰의 검증 엔드포인트 200 통과는 키체인 토큰으로 라이브 실측 확인됨(2026-07-20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-pastetest-'));
const { normalizePastedCred, oauthFormatError, verifyRunnerCred } = await import('../src/runners.mjs');

test('normalizePastedCred: 줄바꿈·공백 혼입 토큰을 한 줄로 복원(자기치유)', () => {
  // 실사고 재현 — 108자 토큰이 터미널 80칸에서 두 줄로 갈라진 복사본
  const full = `sk-ant-oat01-${'A'.repeat(95)}`;
  const wrapped = `${full.slice(0, 80)}\n${full.slice(80)}`;
  assert.equal(normalizePastedCred(wrapped), full, 'LF 혼입 복원 — 이전엔 접두사만 보고 통과, 깨진 채 저장');
  assert.equal(normalizePastedCred(`${full.slice(0, 80)}\r\n  ${full.slice(80)}  `), full, 'CRLF+들여쓰기 복원');
  assert.equal(normalizePastedCred(`  ${full}  `), full, '양끝 공백 트림');
  assert.equal(normalizePastedCred('sk-ant-api03 -xx yy'), 'sk-ant-api03-xxyy', '내부 공백 전부 제거(키는 공백 미포함)');
});

test('normalizePastedCred: JSON 블롭은 trim만 — 문자열 값 보존', () => {
  const blob = '{"tokens": {"access_token": "a b"}}'; // 내부 공백이 의미 있는 형식
  assert.equal(normalizePastedCred(`  ${blob}\n`), blob, "'{' 시작은 내부 미변형");
  assert.equal(normalizePastedCred(null), '', 'null 안전');
  assert.equal(normalizePastedCred(undefined), '', 'undefined 안전');
});

test('통합: 줄바꿈 혼입 토큰 → 정규화 후 형식검사 통과 + 검증 게이트 도달', async () => {
  const full = `sk-ant-oat01-${'B'.repeat(95)}`;
  const wrapped = `${full.slice(0, 80)}\n${full.slice(80)}`;
  // 정규화 전: 형식검사는 통과하지만(접두사 멀쩡) 값은 깨져 있다 — 이게 함정의 전반부였다
  assert.equal(oauthFormatError('claude', wrapped, 'ko'), null, '정규화 전에도 접두사 검사는 통과(함정 재현)');
  const v = normalizePastedCred(wrapped);
  assert.equal(v, full, '정규화가 함정을 해소');
  // 정규화된 값이 실검증(HTTP)에 도달하는지 — fetch 모킹으로 유효 응답 재현
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"data":[]}', { status: 200 });
  try {
    assert.deepEqual(await verifyRunnerCred('claude', 'oauth', v), { ok: true }, '온전한 토큰 = 검증 통과(라이브 실측과 동형)');
  } finally { globalThis.fetch = real; }
});
