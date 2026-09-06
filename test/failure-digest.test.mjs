// 실패 서명 다이제스트(재발 방지 5, 2026-09-06) — 순수 묶기·서명·하루 1회 보고·스케줄러 스로틀. 벤더 호출 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { useFakeAccountKey } from './helpers/fake-account-key.mjs';
await useFakeAccountKey();
process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-digest-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-digest-'));
const { errorSignature, digestFailures, runFailureDigest, DIGEST_MIN_COUNT, DIGEST_FILE_NAME } = await import('../src/failure-digest.mjs');
const { tickFailureDigest, DIGEST_TICK_MS } = await import('../src/scheduler.mjs');
const { createCompany, paths } = await import('../src/workspace.mjs');
const { appendEvent, readEvents } = await import('../src/events.mjs');

const T0 = 1_760_000_000_000; const iso = (ms) => new Date(ms).toISOString();
const GROK400 = (id) => `API Error: 400 Invalid request content: Schema validation failed: [standard_violation] /required: null is not of type "array" (invalid-argument) [gen-1788680877-${id}]`; // OpenRouter 요청 id 모양

test('D1. errorSignature(순수) — 요청 id·긴 숫자·경로·따옴표 값을 접어 같은 원인이 같은 열쇠로, HTTP 상태·JSON 타입 이름은 보존', () => {
  assert.equal(errorSignature(GROK400('h50BHaSDkA1SswQUZsNm')), errorSignature(GROK400('Jctnpg2esqDU6gp8p8db')), '요청 id를 접는다');
  assert.equal(errorSignature('x [req_a1b2c3d4e5f6]'), errorSignature('x [req_ffffffffffff]'));
  assert.match(errorSignature(GROK400('x')), /400 Invalid request content: Schema validation failed: \[standard_violation\] \/… null is not of type "array"/);
  assert.equal(errorSignature('models/gemini-3.1-pro-preview is not found for API version v1beta (NOT_FOUND) 1725600000000'), errorSignature('models/gemini-3.1-pro-preview is not found for API version v1beta (NOT_FOUND) 1725699999999'));
  assert.equal(errorSignature('ENOENT: /Users/a/b/c.md'), errorSignature('ENOENT: /Users/x/y/z.md'));
  assert.notEqual(errorSignature('API Error: 401 x'), errorSignature('API Error: 429 x'), '상태 코드는 원인');
  assert.equal(errorSignature(null), '');
});

test('D2. digestFailures(순수) — 24h 창·ok:false 턴·중단 제외·N회 이상만·러너별 분리·많은 순, 크루 목록 수집', () => {
  const ev = [
    ...[1, 2, 3, 4].map((i) => ({ type: 'turn', ok: false, runner: 'grok', slug: `c${i % 2}`, error: GROK400(`id${i}`), ts: iso(T0 - i * 60_000) })),
    { type: 'turn', ok: false, runner: 'glm', slug: 'c9', error: 'API Error: 404 No endpoints found', ts: iso(T0 - 5000) },
    { type: 'turn', ok: false, runner: 'glm', slug: 'c9', error: 'API Error: 404 No endpoints found', ts: iso(T0 - 6000) },
    { type: 'turn', ok: false, runner: 'grok', slug: 'c1', error: GROK400('old'), ts: iso(T0 - 25 * 3600_000) }, // 창 밖
    ...[1, 2, 3].map((i) => ({ type: 'turn', ok: false, runner: 'grok', slug: 'c1', aborted: true, error: '사장 지시로 중단', ts: iso(T0 - i * 1000) })), // 중단 3회 — 실패가 아니라 제외
    ...[1, 2].map((i) => ({ type: 'turn', ok: false, runner: 'kimi', slug: 'k', error: 'API Error: 429 rate limit', ts: iso(T0 - i * 2000) })), // 같은 문구 두 러너 2+2 — 러너 축이 없으면 4로 뭉쳐 보고된다
    ...[1, 2].map((i) => ({ type: 'turn', ok: false, runner: 'glm', slug: 'g', error: 'API Error: 429 rate limit', ts: iso(T0 - i * 2500) })),
    { type: 'turn', ok: true, runner: 'grok', slug: 'c1', ts: iso(T0 - 2000) },
    { type: 'runner-health', runner: 'grok', ok: false, ts: iso(T0 - 3000) },
  ];
  const d = digestFailures(ev, { now: T0 });
  assert.equal(d.length, 1, `glm 404은 2회라 기준(${DIGEST_MIN_COUNT}) 미만, 중단 3회는 제외, 429는 러너별 2+2라 미달`); assert.equal(d[0].runner, 'grok'); assert.equal(d[0].count, 4); assert.deepEqual(d[0].slugs, ['c0', 'c1']); assert.match(d[0].sample, /^API Error: 400/);
  assert.ok(!d.some((g) => /중단/.test(g.signature)), '중단은 실패가 아니다');
  const d2 = digestFailures(ev, { now: T0, minCount: 2 }); assert.equal(d2.length, 4, '기준 2면 grok 400·glm 404·kimi 429·glm 429 — 러너 축 분리(같은 429 문구가 kimi 2·glm 2로 따로)'); assert.equal(d2[0].runner, 'grok');
  assert.equal(d2.filter((g) => /429/.test(g.signature)).length, 2); assert.ok(d2.filter((g) => /429/.test(g.signature)).every((g) => g.count === 2));
  assert.deepEqual(digestFailures([], { now: T0 }), []);
});

test('D3. runFailureDigest — 반복 실패는 failure-digest 이벤트 1행(서명당 24h 1회), 상태 파일 기록, 새 서명은 즉시, 24h 뒤 재보고, 아무것도 안 바꿈(자격·턴)', async () => {
  const ws = 'digest1'; await createCompany(ws, '다이제스트', '사장');
  for (let i = 0; i < 3; i++) await appendEvent(ws, { type: 'turn', ok: false, runner: 'grok', slug: 'crew', error: GROK400(`id${i}`) });
  const r1 = await runFailureDigest(ws); assert.equal(r1.length, 1); assert.equal(r1[0].count, 3);
  let ev = await readEvents(ws); let digests = ev.filter((e) => e.type === 'failure-digest');
  assert.equal(digests.length, 1); assert.equal(digests[0].runner, 'grok'); assert.equal(digests[0].count, 3); assert.match(digests[0].sample, /required: null/); assert.deepEqual(digests[0].crews, ['crew']);
  const state = JSON.parse(await readFile(join(paths(ws).root, DIGEST_FILE_NAME), 'utf8')); assert.equal(Object.keys(state).length, 1);
  // 같은 서명 재실행(더 늘어도) — 24h 안엔 추가 행 없음
  await appendEvent(ws, { type: 'turn', ok: false, runner: 'grok', slug: 'crew', error: GROK400('id9') });
  assert.deepEqual(await runFailureDigest(ws), []); assert.equal((await readEvents(ws)).filter((e) => e.type === 'failure-digest').length, 1, '서명당 하루 1행');
  // 새 서명(다른 러너)은 즉시
  for (let i = 0; i < 3; i++) await appendEvent(ws, { type: 'turn', ok: false, runner: 'glm', slug: 'crew', error: 'API Error: 404 No endpoints found that support tool use' });
  const r2 = await runFailureDigest(ws); assert.equal(r2.length, 1); assert.equal(r2[0].runner, 'glm');
  // 24h 뒤엔 같은 서명 재보고(그때까지 창 안에 남아 있다면) — now를 미래로: 창(24h)도 함께 움직이므로 창을 넓혀 확인
  const r3 = await runFailureDigest(ws, { now: Date.now() + 25 * 3600_000, windowMs: 48 * 3600_000 }); assert.equal(r3.length, 2, '24h 경과 뒤 재보고');
  assert.equal((await readEvents(ws)).filter((e) => e.type === 'failure-digest').length, 4);
});

test('D4. 스케줄러 틱 — 회사별 시간당 1회(프로세스 내 스로틀), runFn은 fire-and-forget이라 틱을 막지 않는다', async () => {
  const calls = []; const runFn = async (cid) => { calls.push(cid); };
  const lastRun = new Map();
  assert.equal(tickFailureDigest('c1', { runFn, now: T0, lastRun }), true);
  assert.equal(tickFailureDigest('c1', { runFn, now: T0 + DIGEST_TICK_MS - 1, lastRun }), false, '1시간 안 재호출 없음');
  assert.equal(tickFailureDigest('c2', { runFn, now: T0 + 1, lastRun }), true, '다른 회사는 독립');
  assert.equal(tickFailureDigest('c1', { runFn, now: T0 + DIGEST_TICK_MS, lastRun }), true);
  await new Promise((r) => setTimeout(r, 5)); assert.deepEqual(calls, ['c1', 'c2', 'c1']);
  const src = await readFile(new URL('../src/scheduler.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(cloudLeader\) tickFailureDigest\(cid\);/, '틱이 배선돼 있다(클라우드 리더만)');
});
