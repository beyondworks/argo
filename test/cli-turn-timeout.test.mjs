// CLI 턴 시간 초과의 정직 번역 회귀 테스트 — QA P1-2 고정:
// "리릭비디오가 항상 약 300초 후 ENOENT"(4회 재현) = 기본 timeoutMs 위장. 계약(분리 검수 반영):
//  ① 시간 초과 = 경과>=상한 AND (killed 또는 read 단계) — 상한 직후 도착한 진짜 벤더 오류(401)는
//     문구를 보존해 AUTH_ERR_RE 자가치유가 살아야 한다(검수 M3)
//  ② exec 단계 ENOENT는 기존 "CLI 미설치/PATH" 진단 유지(검수 M2), read 단계만 "응답 없이 종료"
//  ③ 안내는 수신자 인지형 — CLI 크루엔 start_long_task가 없고(검수 H1), 잡 턴엔 자기모순 금지(M4)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-timeout-'));
const { cliTurnFailure } = await import('../src/runners.mjs');

test('시간 초과(killed): 표면 오류 불문 정직 번역 + CLI 크루 인지형 안내(start_long_task 직접 지시 금지)', () => {
  const e = cliTurnFailure(Object.assign(new Error('러너 실행 실패 (exit ?): 배너 잡음'), { killed: true }), 'codex', 300_500, 300_000, { stage: 'exec', kind: 'chat' });
  assert.ok(e.timedOut);
  assert.match(e.message, /시간 초과.*5분/);
  assert.match(e.message, /장시간 작업 도구가 없으니/, 'CLI 턴엔 그 도구가 없다는 사실 명시(검수 H1)');
  // 러너 중립성(2026-07-30) — 대안으로 특정 벤더만 지목하지 않는다: 장시간 작업 도구는 SDK 러너
  // 공통(Claude·GLM·Kimi·OpenRouter)이므로 안내도 그 집합을 가리켜야 한다.
  // 명단을 통째로 고정하지 않는다 — 러너를 추가할 때마다 이 단언이 red가 되고(실제로 Grok에서
  // 그랬다), 정작 "명단이 낡았다"는 진짜 결함은 못 잡는다. 잠글 것은 **안내의 형태**다.
  assert.match(e.message, /SDK 러너\([^)]*\) 크루에게/, '실행 가능한 대안 안내(러너 중립)');
  assert.match(e.message, /SDK 러너\([^)]*Claude[^)]*\)/, 'SDK 러너 명단이 비어 있으면 안내가 무의미하다');
  assert.match(e.message, /Timed out/, '영어 병기');
});

test('시간 초과(read 단계 ENOENT): kill 뒤 출력 부재 위장의 본체 — 시간 초과로 번역', () => {
  const e = cliTurnFailure(Object.assign(new Error('ENOENT: open last.txt'), { code: 'ENOENT' }), 'codex', 300_400, 300_000, { stage: 'read', kind: 'chat' });
  assert.ok(e.timedOut);
  assert.doesNotMatch(e.message, /ENOENT/);
});

test('잡 턴 시간 초과: 시간 단위 표기 + 쪼개기 안내(자기모순 금지 — 검수 M4)', () => {
  const e = cliTurnFailure(Object.assign(new Error('x'), { killed: true }), 'codex', 21_700_000, 21_600_000, { stage: 'exec', kind: 'job' });
  assert.match(e.message, /장시간 작업.*상한 6시간/, '360분이 아니라 6시간');
  assert.match(e.message, /쪼개서/, '쪼개기 안내');
  assert.doesNotMatch(e.message, /걸어줘|start_long_task/, '이미 잡인 턴에 잡으로 걸라는 자기모순 금지');
});

test('상한 직후 도착한 진짜 벤더 오류(401, killed 아님)는 문구 보존 — 자가치유 생존 계약(검수 M3)', () => {
  const e = cliTurnFailure(Object.assign(new Error('cmd failed'), { stderr: 'API Error: 401 Unauthorized' }), 'codex', 301_000, 300_000, { stage: 'exec', kind: 'chat' });
  assert.doesNotMatch(e.message, /시간 초과/);
  assert.match(String(e.message), /401/, 'AUTH_ERR_RE가 물 수 있게 벤더 문구 보존');
});

test('exec 단계 ENOENT(시간 내): 기존 "CLI 미설치/PATH" 정밀 진단 유지(검수 M2 회귀 방지)', () => {
  const e = cliTurnFailure(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }), 'codex', 4_000, 300_000, { stage: 'exec', kind: 'chat' });
  assert.match(e.message, /러너 CLI를 찾지 못했습니다/, '환경 오류 최다 케이스의 진단 보존');
});

test('read 단계 ENOENT(시간 내): "응답 없이 종료" — 생 ENOENT 노출 금지', () => {
  const e = cliTurnFailure(Object.assign(new Error('ENOENT: open last.txt'), { code: 'ENOENT' }), 'codex', 12_000, 300_000, { stage: 'read', kind: 'chat' });
  assert.equal(e.timedOut, undefined);
  assert.match(e.message, /응답을 남기지 않고 종료/);
  assert.doesNotMatch(e.message, /ENOENT/);
});

// ── 배선 트립와이어 — 상한·kind가 소스별로 externalExec까지 실제로 전달되는지 소스 텍스트로 잠근다
test('배선: chat.mjs — 잡 6시간·대화 5분 상한 + kind가 두 externalExec 호출 모두에 전달', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.match(src, /source === 'job' \? 21_600_000/, '잡 상한 6시간');
  assert.equal((src.match(/timeoutMs: cliTimeoutMs/g) ?? []).length, 2, '본 호출 + 강등 재시도 호출');
  assert.equal((src.match(/kind: source === 'job' \? 'job' : 'chat'/g) ?? []).length, 2, 'kind 인지형 안내 배선');
});

test('배선: runners.mjs — 네 CLI 경로 전부 cliTurnFailure 경유 + codex는 exec/read 두 단계 구분', async () => {
  const src = await readFile(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  for (const r of ['codex', 'gemini', 'antigravity', 'kiro']) {
    assert.match(src, new RegExp(`cliTurnFailure\\(e, '${r}'`), `${r} 경로 번역`);
  }
  assert.match(src, /cliTurnFailure\(e, 'codex', .*\{ stage: 'exec', kind \}/, 'codex exec 단계');
  assert.match(src, /cliTurnFailure\(e, 'codex', .*\{ stage: 'read', kind \}/, 'codex read 단계 — 단계 구분이 M2 진단 보존의 본체');
});
