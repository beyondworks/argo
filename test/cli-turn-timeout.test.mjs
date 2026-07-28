// CLI 턴 시간 초과의 정직 번역 회귀 테스트 — QA P1-2 고정:
// "리릭비디오가 항상 약 300초 후 ENOENT"(4회 재현) = 기본 timeoutMs 위장. 두 갈래를 잠근다:
//  ① cliTurnFailure — kill 발화(경과>=상한)면 표면 오류 불문 '시간 초과 + start_long_task 안내'
//  ② 배선 — 잡(source:'job') 턴은 6시간 상한, 대화 턴은 5분(+env 조정)이 externalExec에 전달된다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-timeout-'));
const { cliTurnFailure } = await import('../src/runners.mjs');

test('cliTurnFailure: kill 발화(경과>=상한)면 표면 오류 불문 정직한 시간 초과', () => {
  for (const surface of [
    Object.assign(new Error('러너 실행 실패 (exit ?): 배너 잡음'), { killed: true }),
    Object.assign(new Error("ENOENT: no such file or directory, open '.../last.txt'"), { code: 'ENOENT' }),
    new Error('아무 표면 오류'),
  ]) {
    const e = cliTurnFailure(surface, 'codex', 300_500, 300_000);
    assert.ok(e.timedOut, '시간 초과 표식');
    assert.match(e.message, /시간 초과.*5분/, '상한 분 표기');
    assert.match(e.message, /start_long_task/, '장시간 작업 경로 안내(설계 §크루 도구)');
    assert.match(e.message, /Timed out/, '영어 병기(bilingual 관례)');
  }
});

test('cliTurnFailure: 시간 초과 아닌 ENOENT는 "응답 없이 종료"로 — 생 ENOENT 노출 금지', () => {
  const e = cliTurnFailure(Object.assign(new Error('ENOENT: open last.txt'), { code: 'ENOENT' }), 'codex', 12_000, 300_000);
  assert.equal(e.timedOut, undefined);
  assert.match(e.message, /응답을 남기지 않고 종료/);
  assert.doesNotMatch(e.message, /ENOENT/, '내부 코드 미노출');
});

test('cliTurnFailure: 시간 초과 아닌 일반 오류는 apiError 번역으로 위임', () => {
  const e = cliTurnFailure(Object.assign(new Error('x'), { stderr: 'API Error: 401 Unauthorized' }), 'codex', 8_000, 300_000);
  assert.doesNotMatch(e.message, /시간 초과/);
  assert.ok(String(e.message).length > 0);
});

// ── 배선 트립와이어 — 상한이 소스별로 externalExec까지 실제로 전달되는지 소스 텍스트로 잠근다
test('배선: chat.mjs — 잡 턴 6시간·대화 턴 5분 상한이 두 externalExec 호출 모두에 전달', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.match(src, /source === 'job' \? 21_600_000/, '잡 상한 6시간(설계 §실행 — 워커 경로)');
  assert.equal((src.match(/timeoutMs: cliTimeoutMs/g) ?? []).length, 2, '본 호출 + 게이트 모델 강등 재시도 호출 양쪽');
});

test('배선: runners.mjs — 세 CLI 경로 전부 cliTurnFailure 번역을 지난다(생 apiError 직행 금지)', async () => {
  const src = await readFile(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  for (const r of ['codex', 'gemini', 'antigravity']) {
    assert.match(src, new RegExp(`cliTurnFailure\\(e, '${r}'`), `${r} 경로 번역`);
  }
  // codex는 readFile(출력 회수)까지 번역 — kill 후 last.txt 부재의 생 ENOENT 경로가 위장의 본체였다
  assert.equal((src.match(/cliTurnFailure\(e, 'codex'/g) ?? []).length, 2, 'codex는 exec+readFile 두 지점');
});
