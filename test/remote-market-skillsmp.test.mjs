// SkillsMP 추천 목록 결함(2026-10-14 총괄 재현) — skillsmp.com/api/skills가 limit 1~48만 받는다(limit=100·50 → 400 INVALID_LIMIT, 48 → 200).
// 추천(topRemoteSkills)이 limit=100으로 스타순 두 페이지를 불러 매번 400이었고, 실패·빈 결과가 10분 캐시에 그대로 고정될 수 있었다.
// 가짜 fetch가 실제 서버 규칙(limit>48 → 400)을 따른다 — 운영 코드에 시험용 주소 설정을 만들지 않는다.
//  ① 추천은 limit ≤ 48로만 부르고, 스타순 풀이 종전과 같은 규모(약 200행)라 저자당 2개로 20개를 채운다
//  ② 오류(400·시간 초과·망 오류) 때 마지막 성공 결과를 TTL이 지나도 계속 쓴다. 그마저 없으면 오류를 던진다(라우트가 정직한 문구)
//  ③ 실패·불완전 결과는 캐시에 넣지 않는다 — 다음 요청이 바로 다시 시도한다
//  ④ 검색도 같은 규칙(같은 질의의 옛 성공 결과 재사용)
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
let mode = 'ok'; // ok | down | starsFail | hang
const calls = [];
let inflight = 0, maxInflight = 0; // 실측: 동시 3개 이상이면 503이 섞인다
function fakeSkills(page, n, prefix) {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${page}-${i}`, name: `${prefix}${page}-${i}`, author: `author-${prefix}-${page}-${i}`, description: 'd', stars: 100000 - page * 100 - i, githubUrl: 'https://github.com/a/b' }));
}
const hang = (opts) => new Promise((_, reject) => { // 원격이 매달림 — 중단 신호가 와야만 끝난다
  const sig = opts?.signal; if (sig?.aborted) return reject(sig.reason);
  sig?.addEventListener('abort', () => reject(sig.reason), { once: true });
});
let npmCalls = 0;
globalThis.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname === 'api.npmjs.org') { npmCalls++; if (mode === 'hang') return hang(opts); return Response.json({ downloads: 1000 + npmCalls }); }
  if (u.hostname !== 'skillsmp.com') return realFetch(url, opts);
  calls.push(u.search);
  if (mode === 'hang') return hang(opts);
  inflight++; maxInflight = Math.max(maxInflight, inflight);
  try {
  await new Promise((r) => setTimeout(r, 5));
  if (inflight > 2) return new Response('{}', { status: 503 });
  if (mode === 'down') throw new TypeError('fetch failed');
  if (mode === 'starsFail' && !u.searchParams.get('search')) return new Response('{}', { status: 400 });
  const limit = u.searchParams.get('limit');
  if (limit !== null && !(Number.isInteger(+limit) && +limit >= 1 && +limit <= 48)) {
    return new Response(JSON.stringify({ error: 'Invalid limit; expected one integer between 1 and 48', code: 'INVALID_LIMIT' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const n = Math.min(+(limit ?? 20), 48);
  if (u.searchParams.get('search')) return Response.json({ skills: fakeSkills(0, Math.min(n, 6), `q-${u.searchParams.get('search')}`).map((s, i) => ({ ...s, stars: 500 - i })) }); // 카테고리 검색은 스타순 상위보다 별이 적다(실제와 같은 모양)
  return Response.json({ skills: fakeSkills(+(u.searchParams.get('page') ?? 1), n, 'star') });
  } finally { inflight--; }
};

const M = await import('../src/remote-market.mjs');
const TTL = 10 * 60 * 1000;
beforeEach(() => { mode = 'ok'; calls.length = 0; maxInflight = 0; npmCalls = 0; M._resetRemoteMarketCache?.(); M._setRemoteMarketTiming?.({ batchDeadlineMs: 20_000, failCooldownMs: 90_000 }); });
const COOLDOWN = 90_000;
const later = (ms) => mock.timers.enable({ apis: ['Date'], now: Date.now() + ms });

test('① 추천 — limit ≤ 48로만 부르고 20개를 채운다(스타순 풀 약 200행)', async () => {
  const r = await M.topRemoteSkills();
  assert.equal(r.length, 20, `추천이 ${r.length}개 — 스타순 요청이 400으로 빠졌다`);
  for (const q of calls) { const l = new URLSearchParams(q).get('limit'); if (l !== null) assert.ok(+l <= 48, `limit=${l}`); }
  const starRows = calls.filter((q) => q.includes('sortBy=stars') && !q.includes('search=')).length;
  assert.ok(starRows * 48 >= 190, `스타순 풀이 줄었다(${starRows}페이지)`);
});

test('② 오류 때 마지막 성공 결과를 TTL이 지나도 계속 쓴다', async () => {
  const good = await M.topRemoteSkills();
  mock.timers.enable({ apis: ['Date'], now: Date.now() + TTL + 60_000 }); // TTL 지남
  try {
    mode = 'down';
    const again = await M.topRemoteSkills();
    assert.deepEqual(again, good, '망 오류인데 옛 성공 결과를 버렸다');
  } finally { mock.timers.reset(); }
});

test('② 옛 결과도 없으면 오류를 던진다(라우트가 오류 문구를 보인다)', async () => {
  mode = 'down';
  await assert.rejects(M.topRemoteSkills(), /원격|fetch|연결|불러오지/);
});

test('③ 실패는 캐시에 넣지 않는다 — 회복하면 쿨다운 뒤 다음 요청이 채운다', async () => {
  mode = 'down';
  await assert.rejects(M.topRemoteSkills());
  mode = 'ok';
  later(COOLDOWN + 1000);
  try { assert.equal((await M.topRemoteSkills()).length, 20, '실패가 캐시에 고정됐다'); } finally { mock.timers.reset(); }
});

test('④ 검색 — 같은 질의의 옛 성공 결과를 오류 때 재사용, 없으면 오류', async () => {
  const good = await M.searchRemoteSkills('seo');
  assert.ok(good.length > 0);
  mock.timers.enable({ apis: ['Date'], now: Date.now() + TTL + 60_000 });
  try {
    mode = 'down';
    assert.deepEqual(await M.searchRemoteSkills('seo'), good);
    await assert.rejects(M.searchRemoteSkills('never-searched'));
  } finally { mock.timers.reset(); }
});

test('③ 일부 실패(스타순만 400) — 받은 만큼 보여 주되 캐시하지 않아, 회복하면 다음 요청이 스타순을 다시 불러 채운다', async () => {
  mode = 'starsFail';
  const part = await M.topRemoteSkills();
  assert.ok(part.length > 0, '일부 결과도 버렸다');
  assert.ok(part.every((s) => !s.id.startsWith('star-')), '스타순 실패인데 스타순 결과가 섞였다');
  mode = 'ok';
  later(COOLDOWN + 1000);
  const before = calls.length;
  let full; try { full = await M.topRemoteSkills(); } finally { mock.timers.reset(); }
  assert.ok(calls.slice(before).some((q) => q.includes('sortBy=stars') && !q.includes('search=')), '일부 결과가 캐시에 고정돼 다시 부르지 않았다');
  assert.ok(full.some((s) => s.id.startsWith('star-')), '회복 뒤에도 스타순 결과가 없다');
});

test('⑤ 동시 요청은 2개까지 — 3개 이상이면 503을 섞는 서버에서도 추천이 20개(실측 규칙)', async () => {
  const r = await M.topRemoteSkills();
  assert.ok(maxInflight <= 2, `동시 ${maxInflight}개를 보냈다`);
  assert.equal(r.length, 20);
});

test('⑥ 원격이 매달려도 묶음 마감 안에 끝난다 — 스킬 추천(옛 결과 없으면 오류, 있으면 옛 결과)·MCP 추천', async () => {
  M._setRemoteMarketTiming({ batchDeadlineMs: 300 });
  mode = 'hang';
  let t0 = Date.now();
  await assert.rejects(M.topRemoteSkills(), /초 안에 끝나지 않았습니다|시작하지 못했습니다/);
  assert.ok(Date.now() - t0 < 2000, `스킬 추천이 ${Date.now() - t0}ms 걸렸다 — 마감이 없다`);
  t0 = Date.now();
  await assert.rejects(M.topRemoteMcp());
  assert.ok(Date.now() - t0 < 2000, `MCP 추천이 ${Date.now() - t0}ms 걸렸다`);
  // 옛 결과가 있으면 마감 뒤 그것을 돌려준다
  M._resetRemoteMarketCache(); mode = 'ok';
  const good = await M.topRemoteSkills();
  later(10 * 60 * 1000 + 1000);
  try { mode = 'hang'; t0 = Date.now(); assert.deepEqual(await M.topRemoteSkills(), good); assert.ok(Date.now() - t0 < 2000); } finally { mock.timers.reset(); }
});

test('⑦ 실패 쿨다운 — 실패 뒤 쿨다운 동안은 원격 호출 0건(옛 결과 없으면 같은 오류, 있으면 옛 결과), 쿨다운 뒤에는 다시 부른다', async () => {
  mode = 'down';
  await assert.rejects(M.topRemoteSkills());
  const n = calls.length;
  await assert.rejects(M.topRemoteSkills());
  await assert.rejects(M.topRemoteSkills());
  assert.equal(calls.length, n, '쿨다운 중에 원격을 다시 불렀다');
  later(COOLDOWN + 1000);
  try { await assert.rejects(M.topRemoteSkills()); assert.ok(calls.length > n, '쿨다운 뒤에도 다시 부르지 않는다'); } finally { mock.timers.reset(); }
  // 옛 결과가 있는 경우
  M._resetRemoteMarketCache(); mode = 'ok';
  const good = await M.topRemoteSkills();
  later(10 * 60 * 1000 + 1000);
  try {
    mode = 'down';
    assert.deepEqual(await M.topRemoteSkills(), good);
    const m = calls.length;
    assert.deepEqual(await M.topRemoteSkills(), good);
    assert.equal(calls.length, m, '옛 결과가 있어도 쿨다운 중 원격을 다시 불렀다');
  } finally { mock.timers.reset(); }
});

test('⑧ 같은 키 동시 요청은 한 묶음만 원격으로 보낸다', async () => {
  const [a, b, c] = await Promise.all([M.topRemoteSkills(), M.topRemoteSkills(), M.topRemoteSkills()]);
  assert.deepEqual(a, b); assert.deepEqual(b, c);
  assert.equal(calls.length, 14, `요청 ${calls.length}건 — 묶음(스타순 4 + 카테고리 10)이 겹쳐 나갔다`);
});
