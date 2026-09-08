// CLI 턴 시간 초과의 정직 번역 회귀 테스트 — QA P1-2 고정:
// "리릭비디오가 항상 약 300초 후 ENOENT"(4회 재현) = 기본 timeoutMs 위장. 계약(분리 검수 반영):
//  ① 시간 초과 = 경과>=상한 AND (killed 또는 read 단계) — 상한 직후 도착한 진짜 벤더 오류(401)는
//     문구를 보존해 AUTH_ERR_RE 자가치유가 살아야 한다(검수 M3)
//  ② exec 단계 ENOENT는 기존 "CLI 미설치/PATH" 진단 유지(검수 M2), read 단계만 "응답 없이 종료"
//  ③ 안내는 수신자 인지형 — CLI 크루엔 start_long_task가 없고(검수 H1), 잡 턴엔 자기모순 금지(M4)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-timeout-'));
const { cliTurnFailure, CLI_CHAT_TURN_TIMEOUT_MS } = await import('../src/runners.mjs');

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
  // 제보 2026-09-07: 같은 지시를 그대로 다시 보내 같은 자리에서 반복 실패 — 재시도가 답이 아님을 문구가 먼저 말한다
  assert.match(e.message, /같은 지시를 그대로 다시 보내면 같은 자리에서 다시 멈춥니다/, '재시도 무의미 안내(ko)');
  assert.match(e.message, /Resending the same instruction will stop at the same point/, '재시도 무의미 안내(en)');
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
test('대화 턴 기본 상한 = 30분 — 옛 5분은 긴 사고 과정 모델을 결과 직전에 죽였다(제보 2026-09-07)', () => {
  assert.equal(CLI_CHAT_TURN_TIMEOUT_MS, 30 * 60_000);
  const e = cliTurnFailure(Object.assign(new Error('x'), { killed: true }), 'codex', CLI_CHAT_TURN_TIMEOUT_MS + 500, CLI_CHAT_TURN_TIMEOUT_MS, { stage: 'exec', kind: 'chat' });
  assert.match(e.message, /상한 30분/);
});

test('옛 5분 리터럴 잔존 금지 — externalExec·execCodexAppServer 기본값·벤더 HTTP 세 와이어 기본 상한이 같은 값(30분)', async () => {
  const runners = await readFile(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  assert.match(runners, /export async function externalExec\(\{ runner, model, cwd, prompt, timeoutMs = CLI_CHAT_TURN_TIMEOUT_MS,/, '새 호출부가 인자를 빠뜨려도 5분으로 회귀하지 않게(검수 INFO)');
  const appserver = await readFile(new URL('../src/runners/codex-appserver.mjs', import.meta.url), 'utf8');
  assert.match(appserver, /export async function execCodexAppServer\(\{ model, cwd, prompt, timeoutMs = 30 \* 60_000,/);
  assert.doesNotMatch(runners + appserver, /timeoutMs = 300_000/, '옛 5분 리터럴');
  // 네이티브 엔진(API 키 Claude·GLM·Kimi·OpenRouter·Grok·Gemini·Codex 직결)의 벤더 HTTP 1회 상한 — 옛 10분은 확장 사고를 한 응답 안에서
  // 도는 모델을 끊었다(검수가 잡은 PR 밖 갭 — 같은 증상이 SDK 러너 크루에서 재발할 자리). 세 와이어가 한 상수를 쓴다.
  const { VENDOR_HTTP_TIMEOUT_MS } = await import('../src/engine/http-errors.mjs');
  assert.equal(VENDOR_HTTP_TIMEOUT_MS, CLI_CHAT_TURN_TIMEOUT_MS, 'CLI 턴 상한과 같은 값');
  for (const rel of ['../src/engine/messages-http.mjs', '../src/engine/responses-wire.mjs', '../src/engine/gemini-wire.mjs']) {
    const src = await readFile(new URL(rel, import.meta.url), 'utf8');
    assert.match(src, /timeoutMs = VENDOR_HTTP_TIMEOUT_MS, retry = 1 \}\)/, `${rel}: 기본 상한은 상수에서`);
    assert.doesNotMatch(src, /timeoutMs = 600_000/, `${rel}: 옛 10분 리터럴`);
  }
});

test('배선: chat.mjs — 잡 6시간·대화 CLI_CHAT_TURN_TIMEOUT_MS 상한 + kind가 두 externalExec 호출 모두에 전달', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.match(src, /source === 'job' \? 21_600_000/, '잡 상한 6시간');
  assert.match(src, /envCap > 0 \? envCap : CLI_CHAT_TURN_TIMEOUT_MS\)/, '대화 상한은 runners.mjs 상수 하나에서 — 300_000 리터럴 금지');
  assert.doesNotMatch(src, /: 300_000\);/, '옛 5분 리터럴 잔존 금지');
  assert.equal((src.match(/timeoutMs: cliTimeoutMs/g) ?? []).length, 2, '본 호출 + 강등 재시도 호출');
  assert.equal((src.match(/kind: source === 'job' \? 'job' : 'chat'/g) ?? []).length, 2, 'kind 인지형 안내 배선');
});

test('배선: 턴을 태우는 라우트의 maxDuration은 호스티드(Vercel Pro) 함수 상한 800 그대로 — CLI 러너는 로컬 프로세스에서만 돌아(호스티드 워커엔 CLI 없음) 두 상한이 한 실행 환경에 겹치지 않는다', async () => {
  for (const rel of ['../app/api/companies/[ws]/chat/route.js', '../app/api/companies/[ws]/room/route.js', '../app/api/companies/[ws]/routines/run/route.js']) {
    const src = await readFile(new URL(rel, import.meta.url), 'utf8');
    const m = src.match(/^export const maxDuration = (\d+);/m);
    assert.ok(m, `${rel} maxDuration`);
    assert.equal(Number(m[1]), 800, `${rel}: 호스티드 함수 상한 = 800(SDK 턴이 5분을 넘어도 HTTP가 먼저 죽지 않게 옛 300에서 올림)`);
  }
});

test('배선: crewmail .claimed 회수는 CLI 상한에서 파생되지 않는다 — .claimed 자기 심박(mtime)과 그 주기의 4배 이상인 회수 창', async () => {
  // 옛 핀(스테일 창 ≥ 3단 × CLI 상한 × 2)은 상한이 30분으로 오르며 3시간이 됐고, 크래시 뒤 쪽지가 3시간 "배달 중"에 갇혔다(제보 2026-09-08).
  // 진행 판정은 소유 프로세스의 자기 심박(mtime)이 맡는다. 행동은 test/crewmail.test.mjs가 잠그고, 여기는 존재·비율 수준만 본다(소스 문자열 정확 일치 핀 금지 — 레포 교훈).
  const src = await readFile(new URL('../src/crewmail.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /CLAIM_STALE_MS/, '고정 스테일 창 상수가 되살아나면 안 된다');
  const m = src.match(/^const CLAIM_RECLAIM_MS = (.+);/m);
  assert.ok(m, 'CLAIM_RECLAIM_MS');
  const reclaim = Function(`return (${m[1]})`)();
  assert.ok(reclaim <= 10 * 60_000, `회수 창 ${reclaim / 60_000}분 — 10분 이내(제보의 '1시간' 계급 재발 방지)`);
  const hb = src.match(/^let CLAIM_HEARTBEAT_MS = (.+);/m);
  assert.ok(hb, 'CLAIM_HEARTBEAT_MS');
  assert.ok(reclaim >= 4 * Function(`return (${hb[1]})`)(), '회수 창은 자기 심박 주기의 4배 이상(정체·짧은 잠자기 흡수)');
  assert.match(src, /now - mtimeMs > CLAIM_RECLAIM_MS/, '회수 판정은 mtime(자기 심박)');
  assert.match(src, /setInterval\([^\n]*touchClaim\(claimedPath\)[^\n]*CLAIM_HEARTBEAT_MS/, '선점분 자기 심박(존재 수준)');
  assert.doesNotMatch(src, /getTurnStatus/, '남의 상태 파일(크루당 하나)에 회수 판정을 얹지 않는다 — 분리 검수 HIGH-2');
});

test('배선: runners.mjs — 세 CLI 경로 전부 cliTurnFailure 경유 + codex는 exec/read 두 단계 구분', async () => {
  const src = await readFile(new URL('../src/runners.mjs', import.meta.url), 'utf8');
  for (const r of ['codex', 'gemini', 'antigravity']) {
    assert.match(src, new RegExp(`cliTurnFailure\\(e, '${r}'`), `${r} 경로 번역`);
  }
  assert.match(src, /cliTurnFailure\(e, 'codex', .*\{ stage: 'exec', kind \}/, 'codex exec 단계');
  assert.match(src, /cliTurnFailure\(e, 'codex', .*\{ stage: 'read', kind \}/, 'codex read 단계 — 단계 구분이 M2 진단 보존의 본체');
});
