// msgr-storage-sweep 순수 부분(엣지 index.ts와 test/msgr-storage-sweep.test.mjs가 같이 쓴다).
// 후보 이름은 DB 함수 msgr_storage_sweep_list가 고른다(방이 없는 객체, 24시간 넘게 첨부 행이 없는 객체). 여기서는 받은 이름만 지운다.
export const BATCH = 200;
export const MAX_ROUNDS = 10;

/** list(n) → 후보 이름 배열, remove(names) → Storage API 삭제. 후보가 끝나거나, 지우기가 실패하거나, 지운 이름이 다시 오면 멈춘다. */
export async function runSweep({ list, remove, batch = BATCH, maxRounds = MAX_ROUNDS }) {
  const done = new Set();
  let removed = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const names = (await list(batch)) ?? [];
    if (!names.length) return { removed, rounds: round, stopped: 'empty' };
    if (names.every((n) => done.has(n))) return { removed, rounds: round, stopped: 'not_progressing' };
    const fresh = names.filter((n) => !done.has(n));
    try { await remove(fresh); } catch { return { removed, rounds: round, stopped: 'remove_failed' }; }
    for (const n of fresh) done.add(n);
    removed += fresh.length;
  }
  return { removed, rounds: maxRounds, stopped: 'max_rounds' };
}

const enc = new TextEncoder();
/** 길이와 무관한 비교(해시 후 XOR) — ls-reconcile과 같은 방식 */
export async function sameSecret(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
