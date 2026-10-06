// 2차 분리 검수 MEDIUM-1(2026-10-05): L5 복구 신호가 설계(스키마 어긋남 잡 시간당 12회)보다 훨씬 자주 시도를 만들었다 —
// (a) DEFER 하나(msgr.mjs busyCrew DEFER는 DB 왕복 없이 반환)로도 복구 신호가 나가 5분 간격이 60초마다 풀렸다(42703 잡 3개 + 20초마다 성공 잡: 200초에 잡당 4회 동시),
// (b) 같은 크루의 막힌 잡끼리 busyCrew DEFER가 forget(n)으로 실패 횟수를 지워 1초 간격부터 다시 시작했다(잡 3개 180초 46회).
// 잠그는 행동: ① 복구 신호는 핸들러가 DEFER 아닌 정상 반환을 했을 때만 ② 마지막 오류가 스키마 어긋남인 잡은 신호로 풀리지 않는다(마이그레이션을 기다리는 것이지 연결이 막힌 것이 아니다)
// ③ DEFER는 그 잡의 실패 횟수를 지우지 않는다(1차 L4의 "DEFER면 지운다"를 되돌린다 — DEFER는 DB 확인 없이 돌아올 수 있어 연속 실패를 끊은 증거가 못 된다).
// 시간 축소: retryBaseMs를 5분으로 두면 첫 실패 뒤 간격이 5분이라, 이 테스트 시간(≈10초) 안의 두 번째 시도는 전부 '복구 신호가 풀어서' 생긴 것이다.
// 3차 검수 F1(2026-10-05): 고정 sleep + 동시 상한 2 때문에 막힌 잡 s3가 첫 성공 잡과 같은 틱에 집혀 s3의 첫 실패보다 성공이 먼저 끝나면 신호가 s1·s2만 풀고 60초 제한이 걸려
// 대조군이 부하에서 자주 실패했다(순차 5/6). 이제 ① 동시 상한을 8로 열어(메신저 큐와 같은 폭) 세 잡이 같은 틱에 모두 집히고 ② 성공 잡은 세 잡의 첫 실패를 '관찰한 뒤에만' 넣으며
// ③ 기다림은 전부 조건 대기(until)다 — 시계가 느려져도 순서가 바뀌지 않는다. 고정 시간은 '아무 일도 안 일어남'을 보여 줄 때의 관찰 창(OBSERVE_MS)뿐이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-qrate-'));
const Q = await import('../src/gateway/queue.mjs');
const { enqueueJob, startQueueWorker, DEFER } = Q;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 조건이 참이 될 때까지 기다린다 — 시간 초과면 실패 이유를 담아 던진다(느린 머신에서도 순서만 지키면 통과). */
async function until(pred, what, ms = 60_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return; await sleep(50); } throw new Error(`시간 안에 ${what}에 닿지 못했다`); }
const OBSERVE_MS = 3000; // '일어나지 않음'을 보는 관찰 창 — 폴 주기(1초)의 세 배: 신호가 났다면 이 안에 다음 틱 시도가 생긴다
const err = (code, message = `x (${code})`) => Object.assign(new Error(message), { code });
const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };

/** 막힌 잡 3개(s1~s3) + 다른 잡 — 막힌 잡이 던지는 오류(stuckError)와 다른 잡의 반응(mode: 'ok' 성공 | 'defer' DEFER)을 바꿔 가며 시도 수를 센다.
    단계: ① 막힌 잡 셋의 첫 실패를 모두 관찰 ② 다른 잡을 넣어 반응을 관찰 — 반환 시점에 워커는 계속 돈다(호출부가 관찰 창을 두고 stop()). */
async function scenario(WS, { stuckError, mode }) {
  await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });
  const attempts = { s1: 0, s2: 0, s3: 0 }; const seen = { other: 0 };
  for (const s of ['s1', 's2', 's3']) await enqueueJob(WS, 'msgr', `1${s.slice(1)}-${s}`, { s, createdAt: new Date().toISOString() });
  const stop = startQueueWorker(WS, 'msgr', async (job) => {
    if (job.s) { attempts[job.s]++; throw stuckError(); }
    seen.other++;
    if (mode === 'defer') return DEFER; // 같은 크루가 바빠서 차례를 미룸 — DB 왕복 없음
  }, { retryBaseMs: 300_000, maxInflight: 8 });
  try {
    await quiet(async () => {
      await until(() => attempts.s1 >= 1 && attempts.s2 >= 1 && attempts.s3 >= 1, '막힌 잡 셋의 첫 실패');
      if (mode === 'defer') {
        await enqueueJob(WS, 'msgr', '50-busy', { t: 1, createdAt: new Date().toISOString() });
        await until(() => seen.other >= 2, 'DEFER 두 번'); // DEFER는 3초 백오프로 돌아온다
      } else {
        for (let i = 0; i < 3; i++) { await enqueueJob(WS, 'msgr', `9${i}-ok`, { t: 1, createdAt: new Date().toISOString() }); await until(() => seen.other >= i + 1, `성공 ${i + 1}번`); }
      }
    });
  } catch (e) { stop(); throw e; }
  return { attempts, seen, stop };
}
/** 관찰 창 동안 지켜본 뒤 워커를 멈추고 시도 수 사본을 돌려준다 — 신호가 났다면 이 안에 다음 틱 시도가 생긴다. */
async function observe(r) { try { await sleep(OBSERVE_MS); return { ...r.attempts }; } finally { r.stop(); } }

test('시나리오 A — 스키마 어긋남(42703)으로 막힌 잡 3개 + 다른 잡이 계속 성공해도 막힌 잡의 5분 간격은 풀리지 않는다', async () => {
  const r = await scenario('qrate-a', { stuckError: () => err('42703', 'column x does not exist'), mode: 'ok' });
  const attempts = await observe(r);
  assert.ok(r.seen.other >= 3, `다른 잡은 성공했다(${r.seen.other}건)`);
  assert.deepEqual(attempts, { s1: 1, s2: 1, s3: 1 }, '성공이 이어져도 스키마 어긋남 잡은 5분 간격을 지킨다 — 신호로 풀리면 잡당 2회 이상');
});

test('시나리오 B — DEFER(DB 왕복 없는 반환)만 계속 나와도 막힌 잡의 간격은 풀리지 않는다 — 스키마 어긋남·일반 일시 오류 모두', async () => {
  const skew = await scenario('qrate-b1', { stuckError: () => err('42703'), mode: 'defer' });
  const skewAttempts = await observe(skew);
  assert.ok(skew.seen.other >= 2, `DEFER가 반복됐다(${skew.seen.other}회)`);
  assert.deepEqual(skewAttempts, { s1: 1, s2: 1, s3: 1 });
  const plain = await scenario('qrate-b2', { stuckError: () => new Error('fetch failed'), mode: 'defer' });
  const plainAttempts = await observe(plain);
  assert.ok(plain.seen.other >= 2);
  assert.deepEqual(plainAttempts, { s1: 1, s2: 1, s3: 1 }, 'DEFER는 연결이 살아 있다는 증거가 아니다 — 일반 일시 오류 잡도 풀리지 않는다');
});

test('대조군 — 일반 일시 오류(코드 없음)로 막힌 잡은 다른 잡의 실제 성공 뒤에 풀린다(L5 의도 그대로) — 워커당 한 번', async () => {
  const r = await scenario('qrate-c', { stuckError: () => new Error('fetch failed'), mode: 'ok' });
  try { await until(() => r.attempts.s1 >= 2 && r.attempts.s2 >= 2 && r.attempts.s3 >= 2, '막힌 잡 셋의 두 번째 시도'); } catch (e) { r.stop(); throw e; } // 첫 성공이 신호를 내 셋 모두 풀린다 — 조건 대기라 느려도 통과
  const attempts = await observe(r);
  assert.deepEqual(attempts, { s1: 2, s2: 2, s3: 2 }, '첫 성공 뒤 한 번 풀리고, 60초 안에는 다시 풀리지 않는다');
});
