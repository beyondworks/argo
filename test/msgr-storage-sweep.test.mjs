// 메신저 저장소 정리(supabase/functions/msgr-storage-sweep, 20261011150000 5절) — 방이 없는 객체·24시간 넘게 첨부 행이 없는 객체를
// Storage API로 지운다(SQL 행 삭제는 바이트를 남긴다). 후보는 DB 함수(msgr_storage_sweep_list)가 고르고, 엣지는 받은 이름만 지운다.
// 고정하는 것: 후보가 없으면 지우기 호출 0 / 한 번에 200개씩, 최대 10번 / 지우기가 실패하면 그 자리에서 멈춘다(같은 후보를 무한히 다시 보내지 않게) /
// 같은 이름을 두 번 지우지 않는다 / 비밀이 없거나 틀리면 아무것도 하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runSweep, sameSecret } from '../supabase/functions/msgr-storage-sweep/core.js';

test('후보가 없으면 목록 1번만 읽고 지우기는 0번', async () => {
  const calls = [];
  const r = await runSweep({ list: async () => { calls.push('list'); return []; }, remove: async (n) => { calls.push(['remove', n]); } });
  assert.deepEqual(r, { removed: 0, rounds: 1, stopped: 'empty' });
  assert.deepEqual(calls, ['list']);
});

test('200개씩 지우고, 후보가 끝나면 멈춘다', async () => {
  let left = Array.from({ length: 450 }, (_, i) => `org/ch/${i}/f`);
  const removed = [];
  const r = await runSweep({ list: async (n) => left.slice(0, n), remove: async (names) => { removed.push(names.length); left = left.filter((x) => !names.includes(x)); } });
  assert.deepEqual(removed, [200, 200, 50]);
  assert.equal(r.removed, 450);
  assert.equal(r.stopped, 'empty');
});

test('한 번 실행은 최대 10번(2,000개)까지 — 남은 것은 다음 시간에', async () => {
  let i = 0;
  const r = await runSweep({ list: async (n) => Array.from({ length: n }, () => `x/${i++}`), remove: async () => {} });
  assert.equal(r.rounds, 10);
  assert.equal(r.removed, 2000);
  assert.equal(r.stopped, 'max_rounds');
});

test('지우기가 실패하거나 같은 이름이 다시 오면 멈춘다(무한 재시도 없음)', async () => {
  let n = 0;
  const fail = await runSweep({ list: async () => ['a', 'b'], remove: async () => { n++; throw new Error('storage 500'); } });
  assert.equal(n, 1);
  assert.equal(fail.stopped, 'remove_failed');
  const same = await runSweep({ list: async () => ['a', 'b'], remove: async () => {} });
  assert.equal(same.removed, 2);
  assert.equal(same.stopped, 'not_progressing', '지웠는데도 같은 후보가 오면(Storage가 지우지 못함) 두 번째 바퀴에서 멈춘다');
});

test('비밀 비교 — 같을 때만 참', async () => {
  assert.equal(await sameSecret('Bearer s3', 'Bearer s3'), true);
  assert.equal(await sameSecret('Bearer s3', 'Bearer s4'), false);
  assert.equal(await sameSecret('', 'Bearer s3'), false);
});
