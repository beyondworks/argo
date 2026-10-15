// D8 — 첫 조직 목록: 한 번에 하나, 실패 뒤에만 재시도(5→10→20→40→60초, 10회 상한), 회복 신호 즉시 한 번, 로그인 만료는 자동 재시도 없음, 느린 응답은 끊지 않음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOrgsLoader, orgsLoadError, orgsRetryDelay, ORGS_RETRY_MAX } from '../src/orgs-load.mjs';

function clock() { // 가짜 시계 — 예약을 시각순으로 돌린다
  let now = 0; const q = new Map(); let id = 0;
  return { setTimer: (fn, ms) => { q.set(++id, { at: now + ms, fn }); return id; }, clearTimer: (k) => q.delete(k),
    async advance(ms) { const end = now + ms; for (;;) { const due = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; q.delete(due[0]); now = due[1].at; due[1].fn(); await flush(); } now = end; },
    pending: () => q.size, now: () => now };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const deferred = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };

test('인접 핀: 정상 빠른 응답 — 조회 1번, 바로 ready, 늦어요·다시 시도 없음, 남는 예약 0', async () => {
  const c = clock(); let calls = 0; const states = [];
  const L = makeOrgsLoader({ run: async () => { calls++; }, onState: (s) => states.push(s), ...c });
  await L.start(); await flush();
  assert.equal(calls, 1); assert.equal(L.state().phase, 'ready');
  assert.ok(states.every((s) => !s.slow && !(s.phase === 'loading' && s.retryUi)));
  await c.advance(120_000); assert.equal(calls, 1, '성공 뒤 추가 조회 0'); assert.equal(c.pending(), 0);
  L.signal(); L.retry(); await flush(); assert.equal(calls, 1, '성공 뒤 회복 신호·다시 시도는 무시(목록은 App 종전 흐름)');
});

test('실패 뒤 자동 재시도 간격 5→10→20→40→60초, 10회 뒤 멈춤', async () => {
  const c = clock(); const at = [];
  const L = makeOrgsLoader({ run: async () => { at.push(c.now()); throw new Error('TypeError: Failed to fetch'); }, onState: () => {}, ...c });
  await L.start(); await flush();
  await c.advance(15 * 60_000);
  const gaps = at.slice(1).map((v, i) => v - at[i]);
  assert.equal(at.length, ORGS_RETRY_MAX + 1, '첫 시도 + 재시도 10회');
  assert.equal(L.state().phase, 'error'); assert.equal(L.state().kind, 'offline'); assert.equal(c.pending(), 0, '상한 뒤 예약 0');
  assert.deepEqual([orgsRetryDelay(1), orgsRetryDelay(2), orgsRetryDelay(3), orgsRetryDelay(4), orgsRetryDelay(5), orgsRetryDelay(9), orgsRetryDelay(11)], [5000, 10000, 20000, 40000, 60000, 60000, null]);
  assert.deepEqual(gaps, [5000, 10000, 20000, 40000, 60000, 60000, 60000, 60000, 60000, 60000], `간격: ${gaps}`);
});

test('두 번 실패 뒤 성공하면 열린다(수정 전에는 영원히 불러오는 중)', async () => {
  const c = clock(); let n = 0;
  const L = makeOrgsLoader({ run: async () => { n++; if (n <= 2) throw new Error('TypeError: Failed to fetch'); }, onState: () => {}, ...c });
  await L.start(); await flush(); await c.advance(5_000); await c.advance(10_000);
  assert.equal(n, 3); assert.equal(L.state().phase, 'ready');
});

test('회복 신호는 실패 상태에서만 즉시 한 번 — 연달아 와도 진행 중이면 합쳐진다', async () => {
  const c = clock(); let n = 0; let gate = deferred();
  const L = makeOrgsLoader({ run: () => { n++; return n === 1 ? Promise.reject(new Error('TypeError: Failed to fetch')) : gate.p; }, onState: () => {}, ...c });
  await L.start(); await flush(); assert.equal(n, 1); assert.equal(L.state().phase, 'error');
  L.signal(); L.signal(); L.signal(); L.retry(); await flush();
  assert.equal(n, 2, '신호 셋 + 다시 시도 = 조회 1');
  gate.res(); await flush(); assert.equal(L.state().phase, 'ready');
  await c.advance(120_000); assert.equal(n, 2, '당겨진 예약은 지워졌다');
});

test('로그인 만료(401)는 자동 재시도하지 않고, 토큰 갱신 신호에 한 번 다시 읽는다', async () => {
  const c = clock(); let n = 0;
  const L = makeOrgsLoader({ run: async () => { n++; if (n === 1) throw Object.assign(new Error('JWT expired'), { status: 401, code: 'PGRST301' }); }, onState: () => {}, ...c });
  await L.start(); await flush(); assert.equal(L.state().kind, 'auth');
  await c.advance(600_000); assert.equal(n, 1, '자동 재시도 0');
  L.signal(); await flush(); assert.equal(n, 2); assert.equal(L.state().phase, 'ready');
});

test('느린 응답: 8초에 slow, 20초에 retryUi, 요청은 끊지 않고 30초에 성공하면 연다(추가 조회 0)', async () => {
  const c = clock(); let n = 0; const gate = deferred();
  const L = makeOrgsLoader({ run: () => { n++; return gate.p; }, onState: () => {}, ...c });
  L.start(); await flush();
  await c.advance(7_999); assert.equal(L.state().slow, false);
  await c.advance(1); assert.equal(L.state().slow, true); assert.equal(L.state().retryUi, false);
  await c.advance(12_000); assert.equal(L.state().retryUi, true);
  L.retry(); await flush(); assert.equal(n, 1, '진행 중 [다시 시도]는 새 조회를 보내지 않는다');
  await c.advance(10_000); gate.res(); await flush();
  assert.equal(L.state().phase, 'ready'); assert.equal(n, 1);
});

test('오류 분류: 오프라인·fetch 실패 → offline, 세션 갱신 중 → refreshing, 401·PGRST301·JWT expired → auth, 5xx·그 밖 → server', () => {
  assert.equal(orgsLoadError({ message: 'x', status: 500 }, false), 'offline');
  assert.equal(orgsLoadError({ message: 'TypeError: Failed to fetch', status: 0 }), 'offline');
  assert.equal(orgsLoadError({ message: 'Load failed' }), 'offline');
  assert.equal(orgsLoadError({ message: 'JWT expired', status: 401 }), 'auth');
  assert.equal(orgsLoadError({ message: 'x', code: 'PGRST301' }), 'auth');
  // 검수 2 #1039: anon-guard SESSION_REFRESHING(D50)은 로그인이 살아 있고 토큰 갱신만 잠시 실패한 것 — 'auth'로 보면 [다시 로그인] → signOut이 저장 초안을 지운다
  assert.equal(orgsLoadError({ message: 'msgr_session_refreshing' }), 'refreshing'); // 갱신 중 전용 문구(D8 재검수 미룸 — '인터넷 연결 없음'이 아니다). 자동 재시도는 오프라인과 같다
  assert.equal(orgsLoadError({ message: 'TypeError: msgr_session_refreshing', status: 0 }), 'refreshing');
  assert.equal(orgsLoadError({ message: 'msgr_session_refreshing' }, false), 'offline', '브라우저가 오프라인이면 오프라인이 먼저');
  assert.equal(orgsLoadError({ message: 'whatever', status: 401 }), 'auth');
  assert.equal(orgsLoadError({ message: 'upstream error', status: 503 }), 'server');
  assert.equal(orgsLoadError({ message: 'permission denied', status: 403 }), 'server');
});

test('검수 2 #1039: 세션 갱신 중(SESSION_REFRESHING) 실패는 자동 재시도 대상 — [다시 로그인] 화면이 아니다', async () => {
  const c = clock(); let n = 0;
  const L = makeOrgsLoader({ run: async () => { n++; if (n === 1) throw new Error('TypeError: msgr_session_refreshing'); }, onState: () => {}, ...c });
  await L.start(); await flush(); assert.equal(L.state().kind, 'refreshing');
  await c.advance(5_000); assert.equal(n, 2, '자동 재시도(오프라인과 같은 간격)'); assert.equal(L.state().phase, 'ready');
});

test('문구: 갱신 중 전용 문구가 ko·en에 있고 "인터넷 연결"을 말하지 않는다', async () => {
  const { t } = await import('../src/i18n.js');
  for (const lang of ['ko', 'en']) { const v = t('orgs.load.refreshing', lang); assert.ok(v && v !== 'orgs.load.refreshing', lang); }
  assert.doesNotMatch(t('orgs.load.refreshing', 'ko'), /인터넷/); assert.doesNotMatch(t('orgs.load.refreshing', 'en'), /offline/i);
});
