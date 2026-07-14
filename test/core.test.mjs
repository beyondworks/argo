// 회귀 테스트 — 가장 위험한 로직(데이터 유실·동기화 충돌·리스·페어링)에 방어선을 친다.
// 실행: npm test (node --test). 외부 의존 없이 순수·파일 단위만 검증(Supabase·SDK 미호출).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hkdfSync, createCipheriv, randomBytes } from 'node:crypto';

import { writeJsonAtomic, readJson, readJsonLenient } from '../src/jsonstore.mjs';
import { mergeLedger, isLedger, isText, isThread } from '../src/sync.mjs';
import { isDue } from '../src/routines.mjs';
import { createPairing, bindPairing, claimPairing } from '../app/api/auth/pair/store.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'argo-test-'));

/* ── jsonstore: 원자성·손상 안전 (D1) ── */
test('writeJsonAtomic 왕복', async () => {
  const d = await tmp();
  const f = join(d, 'x.json');
  await writeJsonAtomic(f, { a: 1, ko: '한글' });
  assert.deepEqual(await readJson(f, {}), { a: 1, ko: '한글' });
  await rm(d, { recursive: true, force: true });
});

test('readJson: ENOENT는 fallback, 손상은 throw+백업', async () => {
  const d = await tmp();
  const f = join(d, 'x.json');
  // 부재 → fallback
  assert.deepEqual(await readJson(f, { seed: true }), { seed: true });
  // 손상 → throw + .corrupt 백업 (조용한 리셋 금지)
  await writeFile(f, '{ broken json');
  await assert.rejects(() => readJson(f, {}), (e) => e.corrupt === true);
  const names = await readdir(d);
  assert.ok(names.some((n) => n.includes('.corrupt-')), '손상 파일이 .corrupt로 백업되어야 함');
  // 원본은 치워졌다(다음 로드는 fallback) — 하지만 데이터는 백업에 살아있음
  await rm(d, { recursive: true, force: true });
});

test('readJsonLenient: 손상도 fallback으로 관용(캐시성)', async () => {
  const d = await tmp();
  const f = join(d, 's.json');
  await writeFile(f, 'not json');
  assert.deepEqual(await readJsonLenient(f, { x: 0 }), { x: 0 });
  await rm(d, { recursive: true, force: true });
});

test('writeJsonAtomic는 부분쓰기로 원본을 오염시키지 않는다(rename 원자성)', async () => {
  const d = await tmp();
  const f = join(d, 'x.json');
  await writeJsonAtomic(f, { v: 1 });
  // 동시에 여러 번 써도 항상 완전한 JSON (tmp→rename이라 중간상태 노출 없음)
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeJsonAtomic(f, { v: i })));
  const parsed = JSON.parse(await readFile(f, 'utf8')); // 파싱 실패 없어야 함
  assert.equal(typeof parsed.v, 'number');
  await rm(d, { recursive: true, force: true });
});

/* ── sync: 원장 병합·파일 분류 (D2/D3) ── */
test('mergeLedger: 두 기기 append 행 합집합(유실 없음)', () => {
  const a = Buffer.from('{"t":1}\n{"t":2}\n');
  const b = Buffer.from('{"t":1}\n{"t":3}\n'); // t:1 공통, t:2/t:3 각자
  const m = mergeLedger(a, b).toString().trim().split('\n');
  assert.equal(m.length, 3, '공통 1 + 각자 1씩 = 3행');
  assert.ok(m.includes('{"t":2}') && m.includes('{"t":3}'), '양쪽 고유 행 보존');
});

test('mergeLedger: 빈 입력 안전', () => {
  assert.equal(mergeLedger(Buffer.from(''), Buffer.from('')).length, 0);
  assert.equal(mergeLedger(Buffer.from('{"a":1}\n'), Buffer.from('')).toString().trim(), '{"a":1}');
});

test('파일 분류', () => {
  assert.ok(isLedger('usage.jsonl') && isLedger('events.jsonl'));
  assert.ok(!isLedger('company.json'));
  assert.ok(isText('vault/notes/x.md') && !isText('x.json'));
  assert.ok(isThread('chats/seo-jihyun.json') && !isThread('chats/.archive/x.json') && !isThread('company.json'));
});

/* ── routines: 이중 실행 방지 dedup (스케줄러) ── */
test('isDue: 시각 일치 + 같은 분 재실행 차단', () => {
  const now = new Date('2026-07-12T09:00:30');
  const base = { enabled: true, schedule: { type: 'daily', time: '09:00' } };
  assert.equal(isDue(base, now), true, '09:00에 실행');
  assert.equal(isDue({ ...base, schedule: { type: 'daily', time: '09:01' } }, now), false, '다른 분 아님');
  assert.equal(isDue({ ...base, enabled: false }, now), false, '비활성');
  // 이미 이 분에 실행됨 → 차단(이중 과금 방지)
  assert.equal(isDue({ ...base, lastRun: now.toISOString() }, now), false, '같은 분 재실행 차단');
});

test('isDue: 주간은 요일까지', () => {
  const sun = new Date('2026-07-12T17:00:10'); // 일요일
  const wk = { enabled: true, schedule: { type: 'weekly', time: '17:00', dow: 5 } }; // 금요일
  assert.equal(isDue(wk, sun), false, '금요일 아님');
  assert.equal(isDue({ ...wk, schedule: { ...wk.schedule, dow: 0 } }, sun), true, '일요일 일치');
});

/* ── 페어링: verifier로 세션 탈취 차단 (L2 보안) ── */
test('claimPairing: verifier 불일치는 회수 불가(탈취 차단)', () => {
  createPairing('code-abc', 'verifier-xyz');
  bindPairing('code-abc', { access_token: 'A', refresh_token: 'R' });
  // 코드만 아는 공격자(verifier 모름) → expired로 숨김
  assert.equal(claimPairing('code-abc', 'wrong-verifier').status, 'expired');
  // 정당한 앱(verifier 일치) → 회수 성공
  const ok = claimPairing('code-abc', 'verifier-xyz');
  assert.equal(ok.status, 'ready');
  assert.equal(ok.session.access_token, 'A');
  // 1회 소비 후 재회수 불가
  assert.equal(claimPairing('code-abc', 'verifier-xyz').status, 'expired');
});

test('claimPairing: 봉인 전엔 pending', () => {
  createPairing('code-2', 'ver-2');
  assert.equal(claimPairing('code-2', 'ver-2').status, 'pending');
});

/* ─── secretbox — 시크릿 봉투 암호화 v2 (계정 키 파생) + v1 레거시 열기 (M-2c Task 3) ─── */
import { sealSecret, openSecret, isSecretRel, cryptoOn } from '../src/secretbox.mjs';

test('secretbox — 파일 대상 판별', () => {
  assert.ok(isSecretRel('connections.json') && isSecretRel('.secrets.json'));
  assert.ok(!isSecretRel('company.json') && !isSecretRel('chats/duri.json'));
});

test('봉투 v2 — 계정 키 왕복, v1 레거시 열기, 위변조 거부', async () => {
  // v2 왕복: 계정 키 캐시를 fake로 채움
  clearAccountKey();
  const store2 = new Map();
  await ensureAccountKey(fakeSb(store2), 'u-crypt');
  assert.equal(cryptoOn(), true);
  const sealed = sealSecret(Buffer.from('{"bot":"tok"}'));
  assert.equal(sealed.subarray(0, 14).toString(), 'argosecret.v2:');
  assert.equal(openSecret(sealed).toString(), '{"bot":"tok"}');
  // 암호문에 평문 미노출
  assert.equal(sealed.toString('latin1').includes('{"bot":"tok"}'), false);
  // 위변조 거부
  const bad = Buffer.from(sealed); bad[bad.length - 1] ^= 0xff;
  assert.throws(() => openSecret(bad));
  // 봉투 아닌 버퍼 거부
  assert.throws(() => openSecret(Buffer.from('not-a-box')));
  // v1 레거시 열기: 서비스 키 HKDF로 v1 봉투를 수제 조립 → openSecret이 해독
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-legacy-service-key';
  const lk = Buffer.from(hkdfSync('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY, 'argo-secret-sync-v1', 'secretbox', 32));
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', lk, iv);
  const ct = Buffer.concat([c.update(Buffer.from('legacy-secret')), c.final()]);
  const v1 = Buffer.concat([Buffer.from('argosecret.v1:'), iv, c.getAuthTag(), ct]);
  assert.equal(openSecret(v1).toString(), 'legacy-secret');
  // 계정 키 없으면 cryptoOn false + seal throw
  clearAccountKey();
  assert.equal(cryptoOn(), false);
  assert.throws(() => sealSecret(Buffer.from('x')));
});

/* ── 페어링: 연결 코드 인코더/파서 (M-1 자가완결 자격) ── */
import { makePairCode, parsePairCode } from '../src/pairing.mjs';

test('페어링 코드 — 왕복', () => {
  const creds = { url: 'https://example.supabase.co', key: 'service-key-123', owner: 'owner-abc' };
  const code = makePairCode(creds);
  assert.ok(code.startsWith('argo-pair.v1.'));
  assert.deepEqual(parsePairCode(code), creds);
});

test('페어링 코드 — 형식 불일치·필드 누락 거부', () => {
  assert.throws(() => parsePairCode('garbage'));
  assert.throws(() => parsePairCode('argo-pair.v1.' + Buffer.from('{"u":"x"}').toString('base64url'))); // k,o 누락
  assert.throws(() => parsePairCode(''));
  assert.throws(() => makePairCode({ url: 'x', key: '', owner: 'y' })); // 누락 값
});

/* ── 동기화 자격 단일 출처 (M-1 기기 페어링 — Task 2) ── */
import { loadSyncCreds, saveSyncCreds, credsEpoch } from '../src/synccreds.mjs';

test('동기화 자격 — env 우선, 파일 폴백, 저장 후 epoch 증가', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-test-'));
  try {
    // env 우선
    const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://e.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'ek', ARGO_SYNC_OWNER: 'eo' };
    assert.deepEqual(loadSyncCreds({ root, env }), { url: 'https://e.supabase.co', key: 'ek', owner: 'eo' });
    // env 없고 파일 없음 → null
    assert.equal(loadSyncCreds({ root, env: {} }), null);
    // 저장 → 파일 폴백 + epoch 증가 + 0600
    const e0 = credsEpoch();
    await saveSyncCreds({ url: 'https://f.supabase.co', key: 'fk', owner: 'fo' }, { root });
    assert.equal(credsEpoch(), e0 + 1);
    assert.deepEqual(loadSyncCreds({ root, env: {} }), { url: 'https://f.supabase.co', key: 'fk', owner: 'fo' });
    const st = await stat(join(root, '.sync-credentials.json'));
    assert.equal(st.mode & 0o777, 0o600);
    // 누락 값 저장 거부
    await assert.rejects(() => saveSyncCreds({ url: 'x', key: '', owner: 'y' }, { root }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('동기화 자격 — 손상된 파일은 null (경고만, throw 없음)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-test-'));
  try {
    await writeFile(join(root, '.sync-credentials.json'), '이것은 유효한 JSON이 아니다{{{');
    assert.equal(loadSyncCreds({ root, env: {} }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('동기화 자격 — 존재하지 않는 하위 경로 root에도 저장 성공(mkdir recursive)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'argo-test-'));
  const root = join(base, 'nested', 'deeper');
  try {
    await saveSyncCreds({ url: 'https://n.supabase.co', key: 'nk', owner: 'no' }, { root });
    assert.deepEqual(loadSyncCreds({ root, env: {} }), { url: 'https://n.supabase.co', key: 'nk', owner: 'no' });
  } finally { await rm(base, { recursive: true, force: true }); }
});

/* ── 기기 세션 — 로그인=연동 (M-2 Task 2) ── */
import { loadDeviceSession, saveDeviceSession, clearDeviceSession, getFreshDeviceSession, deviceEpoch } from '../src/devicesession.mjs';

test('기기 세션 — 저장/로드/삭제, 0600, 손상 안전', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-test-'));
  try {
    assert.equal(loadDeviceSession({ root }), null);
    const session = { access_token: 'at1', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-1', email: 'a@b.c' } };
    const e0 = deviceEpoch();
    await saveDeviceSession({ url: 'https://x.supabase.co', anonKey: 'anon', session }, { root });
    assert.equal(deviceEpoch(), e0 + 1);
    const sess = loadDeviceSession({ root });
    assert.equal(sess.user.id, 'u-1');
    assert.equal(sess.refresh_token, 'rt1');
    const st = await stat(join(root, '.device-session.json'));
    assert.equal(st.mode & 0o777, 0o600);
    // 만료가 먼 세션은 네트워크 없이 그대로 반환
    const fresh = await getFreshDeviceSession({ root });
    assert.equal(fresh.access_token, 'at1');
    // 필수값 누락 거부
    await assert.rejects(() => saveDeviceSession({ url: 'x', anonKey: 'a', session: { access_token: 'q' } }, { root }));
    // 삭제
    await clearDeviceSession({ root });
    assert.equal(loadDeviceSession({ root }), null);
    // 손상 파일 → null (경고는 stderr — 값 미출력)
    await writeFile(join(root, '.device-session.json'), '{broken');
    assert.equal(loadDeviceSession({ root }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('기기 세션 회전 — 성공 시 회전된 토큰 저장 + epoch 증가 + 디스크 영속', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-test-'));
  try {
    const session = { access_token: 'at1', refresh_token: 'rt1', expires_at: 0, user: { id: 'u-1', email: 'a@b.c' } };
    await saveDeviceSession({ url: 'https://x.supabase.co', anonKey: 'anon', session }, { root });
    const e0 = deviceEpoch();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const fakeClient = {
      auth: {
        refreshSession: async () => ({
          data: { session: { access_token: 'at2', refresh_token: 'rt2', expires_at: future, user: { id: 'u-1', email: 'a@b.c' } } },
          error: null,
        }),
      },
    };
    const fresh = await getFreshDeviceSession({ root, _mkClient: () => fakeClient });
    assert.equal(fresh.access_token, 'at2');
    assert.equal(deviceEpoch(), e0 + 1);
    // persist()가 캐시를 비우므로 이 호출은 디스크에서 다시 읽는다 — rt2가 실제로 영속됐는지 확인
    const reloaded = loadDeviceSession({ root });
    assert.equal(reloaded.refresh_token, 'rt2');
    assert.equal(reloaded.access_token, 'at2');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('기기 세션 회전 — 실패 시 null 반환 + 기존 세션 파일 보존', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-test-'));
  try {
    const session = { access_token: 'at1', refresh_token: 'rt1', expires_at: 0, user: { id: 'u-1', email: 'a@b.c' } };
    await saveDeviceSession({ url: 'https://x.supabase.co', anonKey: 'anon', session }, { root });
    const fakeClient = { auth: { refreshSession: async () => ({ data: null, error: { message: 'boom' } }) } };
    const fresh = await getFreshDeviceSession({ root, _mkClient: () => fakeClient });
    assert.equal(fresh, null);
    // 회전 실패는 persist를 호출하지 않는다 — 재로그인 전까지 기존 rt1 세션 그대로
    const reloaded = loadDeviceSession({ root });
    assert.equal(reloaded.refresh_token, 'rt1');
    assert.equal(reloaded.access_token, 'at1');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('기기 세션 — 회전 대기 중 저장 요청은 같은 락 뒤로 큐잉되어 최종 파일이 저장 세션', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-test-'));
  try {
    const initial = { access_token: 'at1', refresh_token: 'rt1', expires_at: 0, user: { id: 'u-1', email: 'a@b.c' } };
    await saveDeviceSession({ url: 'https://x.supabase.co', anonKey: 'anon', session: initial }, { root });

    let resolveRefresh;
    const pending = new Promise((resolve) => { resolveRefresh = resolve; });
    const fakeClient = { auth: { refreshSession: () => pending } };

    // p1: 락을 먼저 잡고 refreshSession 응답을 기다리는 중 (아직 미해결)
    const p1 = getFreshDeviceSession({ root, _mkClient: () => fakeClient });
    // p2: 그 사이 새 로그인이 저장을 시도 — 같은 락 키(devsess:root)라 p1 뒤로 큐잉되어야 함
    const newLogin = { access_token: 'atN', refresh_token: 'rtN', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-2', email: 'b@c.d' } };
    const p2 = saveDeviceSession({ url: 'https://y.supabase.co', anonKey: 'anon2', session: newLogin }, { root });

    // 이제 refresh 응답 도착 → p1이 회전 저장을 마친 뒤에야 p2(save)가 실행됨
    resolveRefresh({
      data: { session: { access_token: 'at2', refresh_token: 'rt2', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u-1', email: 'a@b.c' } } },
      error: null,
    });
    await Promise.all([p1, p2]);

    // 락 직렬화 덕분에 회전-스테일 쓰기가 새 로그인 세션을 덮어쓰지 않는다 — 최종 파일 = save 세션
    const final = loadDeviceSession({ root });
    assert.equal(final.refresh_token, 'rtN');
    assert.equal(final.user.id, 'u-2');
  } finally { await rm(root, { recursive: true, force: true }); }
});

/* ── 계정 키 — get-or-create + 동기 캐시 (M-2c Task 2) ── */
import { ensureAccountKey, accountKey, clearAccountKey } from '../src/accountkey.mjs';

// fake supabase — from('account_keys') 체인 최소 구현
function fakeSb(store) {
  return {
    from: () => ({
      select: () => ({ eq: (_c, uid) => ({ maybeSingle: async () => ({ data: store.get(uid) ? { key_b64: store.get(uid) } : null, error: null }) }) }),
      insert: async (row) => {
        if (store.has(row.user_id)) return { error: { code: '23505', message: 'duplicate key' } };
        store.set(row.user_id, row.key_b64);
        return { error: null };
      },
    }),
  };
}

test('계정 키 — 생성·재사용·경합·캐시', async () => {
  clearAccountKey();
  const store = new Map();
  // 최초: 생성 + 캐시
  const k1 = await ensureAccountKey(fakeSb(store), 'u-1');
  assert.equal(k1.length, 32);
  assert.equal(accountKey().equals(k1), true);
  assert.equal(store.size, 1);
  // 재호출: 캐시 (store 접근 불필요 — 같은 버퍼)
  const k2 = await ensureAccountKey(fakeSb(store), 'u-1');
  assert.equal(k2.equals(k1), true);
  // 다른 기기 시뮬레이션: 캐시 비우고 다시 — 기존 행 재사용(새 키 생성 아님)
  clearAccountKey();
  const k3 = await ensureAccountKey(fakeSb(store), 'u-1');
  assert.equal(k3.equals(k1), true);
  // 삽입 경합: 빈 캐시 + select는 null이지만 insert가 23505 → 재조회로 승자 키 채택
  clearAccountKey();
  let first = true;
  const racing = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => {
        if (first) { first = false; return { data: null, error: null }; } // 첫 조회는 비어 보임
        return { data: { key_b64: store.get('u-1') }, error: null };      // 재조회는 승자 키
      } }) }),
      insert: async () => ({ error: { code: '23505', message: 'duplicate key' } }),
    }),
  };
  const k4 = await ensureAccountKey(racing, 'u-1');
  assert.equal(k4.equals(k1), true);
  // 오너 없음 → null, 캐시 없음
  clearAccountKey();
  assert.equal(await ensureAccountKey(fakeSb(store), null), null);
  assert.equal(accountKey(), null);
});

/* ── 요금제 게이트 — plan 조회 fail-safe + 강제 스위치 (M-2d Task 2) ── */
import { fetchPlan, syncEntitled } from '../src/entitlement.mjs';

function fakePlanSb(rows) {
  return { from: () => ({ select: () => ({ eq: (_c, uid) => ({ maybeSingle: async () => rows.error ? { data: null, error: rows.error } : { data: rows[uid] ? { plan: rows[uid] } : null, error: null } }) }) }) };
}

test('entitlement — 부재 free·존재 pro·오류 free·강제 게이트', async () => {
  assert.equal(await fetchPlan(fakePlanSb({ 'u-p': 'pro' }), 'u-p'), 'pro');
  assert.equal(await fetchPlan(fakePlanSb({}), 'u-x'), 'free');            // 행 부재
  assert.equal(await fetchPlan(fakePlanSb({ error: { message: 'boom' } }), 'u-x'), 'free'); // 오류 fail-safe
  assert.equal(await fetchPlan(fakePlanSb({}), null), 'free');             // 오너 없음
  const prev = process.env.ARGO_ENFORCE_PLAN;
  try {
    delete process.env.ARGO_ENFORCE_PLAN;                                  // 강제 off(기본)
    assert.deepEqual(await syncEntitled(fakePlanSb({}), 'u-x'), { ok: true, plan: 'free' });
    process.env.ARGO_ENFORCE_PLAN = '1';                                   // 강제 on
    assert.deepEqual(await syncEntitled(fakePlanSb({}), 'u-x'), { ok: false, plan: 'free' });
    assert.deepEqual(await syncEntitled(fakePlanSb({ 'u-p': 'pro' }), 'u-p'), { ok: true, plan: 'pro' });
  } finally {
    if (prev === undefined) delete process.env.ARGO_ENFORCE_PLAN; else process.env.ARGO_ENFORCE_PLAN = prev;
  }
});
