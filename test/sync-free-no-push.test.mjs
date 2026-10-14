// 무료 계정은 클라우드에 내용을 올리지 않는다(2026-10-14 운영 사고 — 무료 계정 1개가 한 시간에 companies POST 400 약 3,200건).
// 원인 재현(v0.1.84): 옛 클라이언트가 가입 14일을 'trial'로 오판 → 매니페스트 업로드 거절이 throw → 바깥 catch가 업로드 보류를 안 걸어
// 매 사이클 파일 전체를 다시 올렸다. 지금 코드는 회사 재시도 대기(companyRetry)로 막히지만, 확정 free 복원 사이클도 파일마다 POST를 보냈다.
// 계약: ① 확정 free는 syncCompanyOnce에서 업로드 호출 0(거절 집계·완결·state는 종전과 같음) ② 400/401/403 거절로 throw하면 10분 보류,
// 네트워크 오류는 종전 재시도 ③ 플랜이 Pro·체험으로 바뀌거나 계정이 바뀌면 보류를 바로 푼다 ④ Pro→무료에서 로컬·원격을 지우지 않는다.
// ⚠ ARGO_ROOT는 sync.mjs 동적 임포트보다 먼저.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-freenopush-'));
process.env.ARGO_ROOT = ROOT;
const { syncCompany, syncStateExists, _setSyncClientForTest, isUploadDenial, noteUploadDenial, DENIAL_STRIKES } = await import('../src/sync.mjs');
const { planResumes } = await import('../src/plan-cache.mjs');
const { ensureAccountKey, clearAccountKey } = await import('../src/accountkey.mjs');
const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });
await ensureAccountKey(fakeKeySb(Buffer.alloc(32, 7).toString('base64')), 'owner-free-nopush');
after(() => { clearAccountKey(); return rm(ROOT, { recursive: true, force: true }); });

const OWNER = 'o';
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: hashBuf(buf) });

/** 가짜 스토리지 — writable이면 업로드가 통하고(Pro), 아니면 RLS 400(무료). 업로드·삭제 호출을 센다. */
function storage(initial = {}, { writable = false } = {}) {
  const store = new Map(Object.entries(initial));
  const calls = { upload: 0, remove: [] };
  const state = { writable };
  const bucket = {
    async download(key) {
      const k = key.split('?')[0];
      if (!store.has(k)) return { data: null, error: { message: 'Object not found', status: 404 } };
      const buf = store.get(k);
      return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
    },
    async upload(key, blob) {
      calls.upload++;
      if (!state.writable) return { error: state.reject ?? { message: 'new row violates row-level security policy', statusCode: '403' } };
      store.set(key, Buffer.from(await blob.arrayBuffer()));
      return { error: null };
    },
    async remove(keys) { calls.remove.push(...keys); for (const k of keys) store.delete(k); return { error: null }; },
    async list() { return { data: [], error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, store, calls, state };
}

async function seed(ws, files) {
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(ROOT, ws, rel, '..'), { recursive: true });
    await writeFile(join(ROOT, ws, rel), body);
  }
}
const LOCAL = { 'company.json': '{"id":"x"}', 'vault/journal/2026-10-14.md': '# 일지', 'chats/a.json': '{"m":[]}', 'agents/yujin.md': '# 유진' };

test('인접 고정: Pro로 올린 뒤 무료로 바뀌어도 로컬 파일은 그대로, 원격 삭제 0', async () => {
  const WS = 'pro-then-free';
  await seed(WS, LOCAL);
  const fake = storage({}, { writable: true });
  _setSyncClientForTest(fake.client);
  const r1 = await syncCompany(WS, OWNER, false, {});
  assert.ok(r1.pushed >= 3, 'Pro 사이클은 올린다');
  const remoteBefore = fake.store.size;
  fake.state.writable = false; // 구독 만료 — 서버가 이제 거절한다
  _setSyncClientForTest(fake.client); // 재시도 대기 초기화(같은 클라이언트)
  await writeFile(join(ROOT, WS, 'vault/journal/2026-10-14.md'), '# 일지 수정');
  // 캐시가 아직 pro라 한 번은 Pro 계약으로 돈다 — 거절은 실패로 보이되 아무것도 지우지 않는다
  await syncCompany(WS, OWNER, false, {}).catch(() => {});
  // 다음 판정은 free — state가 있으므로 바깥 루프가 회사를 건너뛴다(여기서는 술어만 본다)
  assert.equal(await syncStateExists(WS), true);
  for (const [rel] of Object.entries(LOCAL)) assert.ok((await readFile(join(ROOT, WS, rel), 'utf8')).length > 0, `로컬 ${rel} 보존`);
  assert.deepEqual(fake.calls.remove, [], '원격 삭제 0');
  assert.equal(fake.store.size, remoteBefore, '원격 객체 수 그대로');
});

test('확정 무료 첫 동기화(원격 비어 있음) — 업로드 호출 0, 거절 집계·state 기록은 종전과 같다', async () => {
  const WS = 'free-new';
  await seed(WS, LOCAL);
  const fake = storage();
  _setSyncClientForTest(fake.client);
  const r = await syncCompany(WS, OWNER, true, { freePlan: true });
  assert.equal(fake.calls.upload, 0, '무료는 내용 POST를 보내지 않는다');
  assert.equal(r.failed, 0);
  assert.ok(r.denied >= 3, '거절로 집계(설정 화면의 업그레이드 안내가 그대로 뜬다)');
  assert.equal(r.pushed, 0);
  assert.equal(await syncStateExists(WS), true, '완결 — 다음 사이클부터 건너뜀');
});

test('확정 무료 복원(원격 매니페스트 있음) — pull은 그대로, 업로드 호출 0', async () => {
  const WS = 'free-restore';
  await seed(WS, { 'company.json': '{"id":"y"}', 'vault/notes/local-only.md': '# 로컬' });
  const note = Buffer.from('# 원격 노트\n');
  const fake = storage({
    [`${OWNER}/${WS}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: { 'vault/notes/r.md': meta(note) } })),
    [`${OWNER}/${WS}/vault/notes/r.md`]: note,
  });
  _setSyncClientForTest(fake.client);
  const r = await syncCompany(WS, OWNER, true, { freePlan: true });
  assert.equal(fake.calls.upload, 0);
  assert.equal(r.pulled, 1);
  assert.equal(r.manifestDenied, true, '매니페스트 거부 관용 표기 유지');
  assert.match(await readFile(join(ROOT, WS, 'vault/notes/r.md'), 'utf8'), /원격 노트/);
  assert.equal(await readFile(join(ROOT, WS, 'vault/notes/local-only.md'), 'utf8'), '# 로컬', '로컬 전용 파일 보존');
  assert.deepEqual(fake.calls.remove, []);
});

test('확정 무료 복원 중 pull 실패 — 재시도는 남지만 업로드 호출은 0', async () => {
  const WS = 'free-flaky';
  await seed(WS, { 'company.json': '{"id":"z"}', 'chats/a.json': '{}' });
  const note = Buffer.from('x');
  const fake = storage({
    [`${OWNER}/${WS}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: { 'vault/notes/flaky.md': meta(note) } })),
    [`${OWNER}/${WS}/vault/notes/flaky.md`]: note,
  });
  const bucket = fake.client.storage.from(), download = bucket.download.bind(bucket);
  bucket.download = async (key, o) => (key.includes('flaky.md') ? { data: null, error: { message: 'fetch failed', status: 500 } } : download(key, o));
  _setSyncClientForTest(fake.client);
  await syncCompany(WS, OWNER, true, { freePlan: true }).catch(() => {});
  assert.equal(fake.calls.upload, 0);
  assert.equal(await syncStateExists(WS), false, '복원 미완 — 다음 재시도에서 pull만 다시');
});

test('Pro·미확인 계약은 종전대로 실제로 올린다(무료 생략이 새지 않는다)', async () => {
  const WS = 'pro-push';
  await seed(WS, LOCAL);
  const fake = storage({}, { writable: true });
  _setSyncClientForTest(fake.client);
  const r = await syncCompany(WS, OWNER, false, {});
  assert.ok(fake.calls.upload >= 4, '파일 + 매니페스트');
  assert.equal(r.pushed, fake.calls.upload - 1);
});

test('isUploadDenial — 400·403 RLS 거절만, 401·토큰 문제처럼 보이는 400·네트워크 오류·무료는 아니다', () => {
  const up = (status, message = 'new row violates row-level security policy') => Object.assign(new Error(message), { uploadFailed: true, status });
  assert.equal(isUploadDenial(up(400), false), true);
  assert.equal(isUploadDenial(up(403), false), true);
  assert.equal(isUploadDenial(up(401), false), false, '401 — 인증 문제');
  assert.equal(isUploadDenial(up(400, 'Bucket not found'), false), false, '만료 토큰에 이 스토리지가 돌려주는 400(#835)');
  assert.equal(isUploadDenial(up(400, 'jwt expired'), false), false);
  assert.equal(isUploadDenial(up(403, 'invalid signature'), false), false);
  assert.equal(isUploadDenial(up(null, 'fetch failed'), false), false, '네트워크 오류 — 오프라인→온라인 복구를 늦추지 않는다');
  assert.equal(isUploadDenial(up(500), false), false);
  assert.equal(isUploadDenial(up(403), true), false, '확정 무료는 이미 건너뜀 경로');
  assert.equal(isUploadDenial(new Error('pull'), false), false, '쓰기 아닌 오류');
});

test('noteUploadDenial — 같은 회사 RLS 거절이 연달아 2번일 때만 10분 보류, 만료 토큰·성공은 연속을 끊는다', () => {
  assert.equal(DENIAL_STRIKES, 2);
  const rls = Object.assign(new Error('new row violates row-level security policy'), { uploadFailed: true, status: 403 });
  const expired = Object.assign(new Error('Bucket not found'), { uploadFailed: true, status: 400 });
  const m = new Map();
  assert.equal(noteUploadDenial(m, 'a', expired, false), false, '만료 토큰 400 — 보류 없음(다음 사이클에 토큰 갱신 뒤 바로 올라간다)');
  assert.equal(noteUploadDenial(m, 'a', expired, false), false, '만료 토큰이 이어져도 보류 없음');
  assert.equal(noteUploadDenial(m, 'a', rls, false), false, 'RLS 첫 번째 — 아직');
  assert.equal(noteUploadDenial(m, 'a', rls, false), true, 'RLS 두 번째 연속 — 10분 보류');
  assert.equal(m.has('a'), false, '보류를 건 뒤 셈을 비운다');
  assert.equal(noteUploadDenial(m, 'b', rls, false), false);
  assert.equal(noteUploadDenial(m, 'b', expired, false), false, '사이에 끼인 토큰 오류가 연속을 끊는다');
  assert.equal(noteUploadDenial(m, 'b', rls, false), false, '다시 첫 번째');
  assert.equal(noteUploadDenial(m, 'c', rls, false), false);
  assert.equal(noteUploadDenial(m, 'd', rls, false), false, '회사마다 따로 센다');
  assert.equal(noteUploadDenial(m, 'c', rls, true), false, '무료 판정이면 세지 않는다');
});

test('만료 토큰 400은 throw에 실려도 권한 거절로 안 본다 — 토큰 갱신 뒤 다음 사이클에 바로 올라간다', async () => {
  const WS = 'expired-then-ok';
  await seed(WS, { 'company.json': '{"id":"e"}', 'chats/a.json': '{}' });
  const fake = storage({ [`${OWNER}/${WS}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: {} })) });
  fake.state.reject = { message: 'Bucket not found', statusCode: '400' }; // 사이클 도중 토큰 만료(#835 실측 모양)
  _setSyncClientForTest(fake.client);
  const strikes = new Map();
  const e = await syncCompany(WS, OWNER, false, {}).then(() => null, (x) => x);
  assert.ok(e?.uploadFailed);
  assert.equal(e.status, 400);
  assert.equal(noteUploadDenial(strikes, WS, e, false), false, '10분 보류 없음');
  fake.state.writable = true; fake.state.reject = null; // 토큰 갱신 — 서버가 다시 받아 준다
  _setSyncClientForTest(fake.client); // 회사 재시도 대기(배포본과 같은 30초)를 지난 다음 사이클
  const before = fake.calls.upload;
  const r = await syncCompany(WS, OWNER, false, {});
  assert.ok(fake.calls.upload > before && r.pushed >= 1, '바로 올라간다');
});

test('진짜 RLS 거절은 두 사이클 연속이면 10분 보류 — 실제 throw 모양으로', async () => {
  const WS = 'rls-twice';
  await seed(WS, { 'company.json': '{"id":"r"}', 'chats/a.json': '{}' });
  const fake = storage({ [`${OWNER}/${WS}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: {} })) });
  const strikes = new Map();
  const results = [];
  for (let i = 0; i < 2; i++) {
    _setSyncClientForTest(fake.client); // 회사 재시도 대기(30초)를 지난 사이클
    const e = await syncCompany(WS, OWNER, false, {}).then(() => null, (x) => x);
    results.push(noteUploadDenial(strikes, WS, e, false));
  }
  assert.deepEqual(results, [false, true]);
});

test('planResumes — 계정이 바뀌거나 Pro·체험으로 올라가면 보류를 푼다, 같은 판정 반복은 안 푼다', () => {
  assert.equal(planResumes(null, { key: 'u|o', plan: 'free' }), true, '첫 조회(기동) — 비울 것이 없어 무해');
  assert.equal(planResumes({ key: 'u|o', plan: 'free' }, { key: 'u|o', plan: 'pro' }), true, '무료→Pro');
  assert.equal(planResumes({ key: 'u|o', plan: null }, { key: 'u|o', plan: 'pro' }), true, '미확인→Pro');
  assert.equal(planResumes({ key: 'u|o', plan: 'free' }, { key: 'u|o', plan: 'trial' }), true);
  assert.equal(planResumes({ key: 'u|o', plan: 'pro' }, { key: 'v|o', plan: 'pro' }), true, '계정 전환');
  assert.equal(planResumes({ key: 'u|o', plan: 'pro' }, { key: 'u|o', plan: 'pro' }), false, '10분마다 같은 Pro');
  assert.equal(planResumes({ key: 'u|o', plan: 'pro' }, { key: 'u|o', plan: 'free' }), false, 'Pro→무료는 풀 것이 아님');
  assert.equal(planResumes({ key: 'u|o', plan: 'free' }, { key: 'u|o', plan: null }), false);
});

test('배선(cycle은 export되지 않는다) — 바깥 catch가 noteUploadDenial로 보류를 걸고, 플랜 조회가 planResumes로 보류를 푼다', () => {
  const src = readFileSync(new URL('../src/sync.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(noteUploadDenial\(denialStrikes, wsId, e, freePlan\)\) \{ uploadBackoff\.set\(wsId/, '바깥 catch의 보류');
  assert.match(src, /const r = await syncCompany\(wsId, owner, restoring,[^\n]*\n\s*if \(r\.skipped !== 'retry-backoff'\) denialStrikes\.delete\(wsId\);/, '결과를 돌려주면 연속을 끊는다');
  assert.match(src, /if \(planResumes\(lastPlanSeen\(\), \{ key: planKey, plan: ent\.plan \}\)\) \{ uploadBackoff\.clear\(\); companyRetry\.clear\(\); denialStrikes\.clear\(\); \}/, '플랜 전이 때 보류 해제');
  assert.match(src, /const upload = opts\.freePlan \? freePlanUpload : uploadToCloud;/, 'syncCompanyOnce의 무료 업로드 생략');
});

test('거절 throw에는 HTTP 상태가 실린다 — 바깥 보류(isUploadDenial)가 거절과 네트워크 오류를 가르는 재료', async () => {
  const WS = 'denied-status';
  await seed(WS, { 'company.json': '{"id":"d"}', 'chats/a.json': '{}' });
  const fake = storage({ [`${OWNER}/${WS}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: {} })) });
  _setSyncClientForTest(fake.client);
  const e = await syncCompany(WS, OWNER, false, {}).then(() => null, (x) => x);
  assert.ok(e?.uploadFailed, 'Pro·미확인 계약은 거절을 throw');
  assert.equal(e.status, 403);
  assert.equal(isUploadDenial(e, false), true, '이 throw는 권한 거절로 센다');
});
