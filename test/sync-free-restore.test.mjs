// free 복원 완결 계약(재검수 2026-07-30 HIGH-E·F, 후속 MEDIUM-I) — 행동 테스트(fake storage로 syncCompany 실행).
// 계약: free 기기의 사이클은 클라우드 쓰기가 RLS에 거부돼도 pull이 완결(failed=0)이면 state를 기록하고
// 통과한다 → 다음 사이클부터 syncStateExists=true로 회사가 스킵돼 파일 루프 자체가 안 돌고,
// 삭제 전파(#6)·지운 노트 부활(HIGH-E)·.conflict 증식(MEDIUM-I)이 원천적으로 불가하다.
// 핵심 전제(MEDIUM-I): **모든 free 인구가 state 기록에 도달**해야 "state 부재 = 복원 미완"이 성립한다.
// 쓰기 거부를 실패로 세면 한 번도 성공 동기화한 적 없는 회사가 완결에 못 닿아 술어가 영구 true로 굳는다.
// 소스 스캔(sync-list-cadence)이 배선을, 이 파일이 행동을 잠근다 — MEMORY 교훈: 소스 문자열은
// "분기가 도는지"를 못 본다.
// ⚠ ARGO_ROOT는 sync.mjs(→workspace.mjs) 동적 임포트보다 먼저.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-freerestore-'));
process.env.ARGO_ROOT = ROOT;
const { syncCompany, syncStateExists, _setSyncClientForTest } = await import('../src/sync.mjs');
const { ensureAccountKey, clearAccountKey } = await import('../src/accountkey.mjs');
const { openSecretCompat } = await import('../src/secretbox.mjs');
// 회사 데이터 전체 봉투(v2)가 기본 켜짐(2026-09-06) — free 기기도 account_keys는 본인 행 insert 정책이라 키를 얻는다.
const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });
await ensureAccountKey(fakeKeySb(Buffer.alloc(32, 11).toString('base64')), 'owner-free-restore');

// 임시 루트 정리는 훅으로 — 마지막 테스트 본문에 두면 그 테스트가 먼저 실패할 때 누수되고,
// 뒤에 테스트를 추가하는 순간 루트가 사라진 채로 돈다(분리 검수 LOW).
after(() => { clearAccountKey(); return rm(ROOT, { recursive: true, force: true }); });

const OWNER = 'o';
const WS = 'ws1';
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: hashBuf(buf) });

/** fake storage — download는 제공, upload는 기본 거부(free 모사), remove는 기록만.
    writable를 켜면 업로드가 통한다 → **free→Pro 승격 전이**를 한 회사에서 재현할 수 있다(base 진실성 검증에 필수).
    denyKey(key)로 일부 키만 거부시킬 수 있다 → "매니페스트는 되는데 파일 하나가 실패"처럼
    분류 게이트만 관측 가능한 형태를 만든다(그 형태 없이는 게이트가 소스 스캔으로만 잠긴다). */
function freeStorage(initial, { writable = false, denyKey = null } = {}) {
  const store = new Map(Object.entries(initial));
  const removed = [];
  const state = { writable };
  const bucket = {
    async download(key) {
      const k = key.split('?')[0]; // 리스 재확인이 붙이는 캐시버스터 대비
      if (!store.has(k)) return { data: null, error: { message: 'Object not found', status: 404 } };
      const buf = store.get(k);
      return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
    },
    async upload(key, blob) {
      if (!state.writable) return { error: { message: 'new row violates row-level security policy', statusCode: '403' } };
      if (denyKey?.(key)) return { error: { message: 'fetch failed' } }; // 진짜 실패(원인 무관 태그가 붙는 경로)
      store.set(key, Buffer.from(await blob.arrayBuffer()));
      return { error: null };
    },
    async remove(keys) { removed.push(...keys); for (const k of keys) store.delete(k); return { error: null }; },
    async list() { return { data: [], error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, store, removed, state };
}

/** cycle()의 free 판정을 그대로 모사한 1사이클 — 배선(cycle이 이 술어를 쓰는지)은 sync-list-cadence의
    소스 스캔이 잠그고, 여기서는 술어가 실제로 뒤집히는지·뒤집힌 뒤 무엇이 멈추는지를 본다.
    (cycle 자체는 export가 안 되고 실 env·러너 프로브를 요구해 단위로 못 태운다.) */
async function freeCycle(wsId, { discovered = false } = {}) {
  const restoring = discovered || !(await syncStateExists(wsId));
  if (!restoring) return { skipped: 'free-plan' };
  return syncCompany(wsId, OWNER, restoring, { freePlan: true });
}

const conflictsIn = async (dir) => (await readdir(dir).catch(() => [])).filter((n) => n.includes('.conflict-'));

test('free 복원: pull 완결이면 쓰기 RLS 거부를 관용하고 state를 기록한다(HIGH-E 종결)', async () => {
  await mkdir(join(ROOT, WS), { recursive: true });
  const note = Buffer.from('# 복원 노트\n');
  const manifest = Buffer.from(JSON.stringify({ files: { 'vault/notes/a.md': meta(note) } }));
  const fake = freeStorage({
    [`${OWNER}/${WS}/__manifest__.json`]: manifest,
    [`${OWNER}/${WS}/vault/notes/a.md`]: note,
  });
  _setSyncClientForTest(fake.client);
  // 복원(pull) — 업로드 전멸 환경에서도 throw 없이 완결돼야 한다
  const r = await syncCompany(WS, OWNER, true, { freePlan: true });
  assert.equal(r.failed, 0, 'pull 실패 없음');
  assert.equal(r.manifestDenied, true, '매니페스트 거부가 관용으로 표기된다');
  assert.equal((await readFile(join(ROOT, WS, 'vault', 'notes', 'a.md'), 'utf8')).includes('복원 노트'), true, '실제 pull');
  assert.equal(await syncStateExists(WS), true, 'state 기록 = 다음 사이클부터 free 스킵(파일 루프 미가동 → 삭제 전파 불가)');
  // 2사이클 실행 단언(분리 검수 LOW) — 술어가 true인 것만 보지 말고, **다음 사이클이 실제로 스킵돼
  // 사용자의 로컬 삭제가 원격으로 전파되지 않는 것**까지 확인한다(#6의 실제 계약).
  await rm(join(ROOT, WS, 'vault', 'notes', 'a.md'));
  const r2 = await freeCycle(WS);
  assert.deepEqual(r2, { skipped: 'free-plan' }, '2사이클은 스킵 — syncCompany가 아예 불리지 않는다');
  assert.deepEqual(fake.removed, [], '원격 삭제(#6)가 발생하지 않았다');
  assert.equal(await syncStateExists(WS), true, '삭제 후에도 스킵 술어 유지');
});

test('관용은 pull 완결일 때만 — pull 실패가 남으면 throw해 복원 미완(state 미기록)으로 재시도된다', async () => {
  const WS2 = 'ws2';
  await mkdir(join(ROOT, WS2), { recursive: true });
  const note = Buffer.from('x');
  // 매니페스트는 파일을 선언하는데 blob이 없다 → pull 실패(failed>0) → 관용 불가
  const manifest = Buffer.from(JSON.stringify({ files: { 'vault/notes/missing.md': meta(note) } }));
  const fake = freeStorage({ [`${OWNER}/${WS2}/__manifest__.json`]: manifest });
  _setSyncClientForTest(fake.client);
  const r = await syncCompany(WS2, OWNER, true, { freePlan: true }).catch((e) => ({ threw: String(e.message) }));
  // 파일 실패는 루프 안 catch(failed++)로 삼켜지고 매니페스트 업로드에서 throw — 어느 쪽이든 state 미기록이 계약
  if (!r.threw) assert.ok((r.failed ?? 0) > 0, 'pull 실패가 집계된다');
  assert.equal(await syncStateExists(WS2), false, 'state 미기록 = 다음 사이클 재시도(복원 미완)');
});

test('관용 미지정(비free 계약)이면 쓰기 거부는 그대로 throw — pro의 실패 가시성 유지', async () => {
  const WS3 = 'ws3';
  await mkdir(join(ROOT, WS3), { recursive: true });
  const fake = freeStorage({ [`${OWNER}/${WS3}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: {} })) });
  _setSyncClientForTest(fake.client);
  await assert.rejects(() => syncCompany(WS3, OWNER, true), /row-level security/);
  assert.equal(await syncStateExists(WS3), false);
});

/* ── 이하 MEDIUM-I: "한 번도 성공 동기화한 적 없는 free 회사"(체험 만료 후 첫 동기화·state 유실·손상).
   수정 전엔 로컬 전용 파일이 있으면 업로드 거부가 failed로 집계돼 관용(failed===0)이 불충족 → throw →
   state 영구 미기록 → 8초마다 재시도. 아래 두 케이스가 그 재현을 회귀로 편입한다. ── */

test('MEDIUM-I: 로컬 전용 파일이 있는 free 첫 동기화 — 쓰기 거부는 실패가 아니라 거부로 집계돼 완결한다', async () => {
  const WS4 = 'ws4';
  await mkdir(join(ROOT, WS4, 'vault', 'notes'), { recursive: true });
  await writeFile(join(ROOT, WS4, 'vault', 'notes', 'local.md'), '# 로컬 전용 노트\n');
  const fake = freeStorage({ [`${OWNER}/${WS4}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: {} })) });
  _setSyncClientForTest(fake.client);

  const r = await freeCycle(WS4, { discovered: true });
  assert.equal(r.failed, 0, 'RLS 거부는 failed로 세지 않는다 — 세면 관용(failed===0)이 막혀 영구 미완');
  assert.equal(r.denied, 1, '거부는 조용히 삼키지 않고 분리 집계해 관측 가능하게 남긴다');
  assert.equal(r.pushed, 0, '실제로 밀린 파일은 없다(거부를 성공으로 위장하지 않는다)');
  assert.equal(await syncStateExists(WS4), true, '완결 도달 = 다음 사이클부터 스킵');

  // 8초 사이클 재시도가 멈춘다 — 이후 사이클은 syncCompany를 부르지 않는다
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await freeCycle(WS4), { skipped: 'free-plan' }, `${i + 2}사이클도 스킵`);
  }
  // 로컬 전용 파일은 base(state)에 없다 → Pro 승격 사이클에 '신규'로 정상 push된다(유실 없음, #189 검수 D)
  const state = JSON.parse(await readFile(join(ROOT, WS4, '.sync-state.json'), 'utf8'));
  assert.equal('vault/notes/local.md' in state.files, false, '거부된 파일은 base에 들어가지 않는다(승격 시 push 대상 유지)');
  assert.equal(await readFile(join(ROOT, WS4, 'vault', 'notes', 'local.md'), 'utf8'), '# 로컬 전용 노트\n', '로컬 원본 불변');
});

test('MEDIUM-I: 원격·로컬 편집이 겹친 free 첫 동기화 — .conflict 증식이 멈추고 base가 디스크와 일치한다', async () => {
  const WS5 = 'ws5';
  const dir = join(ROOT, WS5, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  const REMOTE = '# 원격본(다른 기기의 편집)\n', LOCAL = '# 로컬 편집본\n';
  const remoteNote = Buffer.from(REMOTE);
  await writeFile(join(dir, 'a.md'), LOCAL);
  const fake = freeStorage({
    [`${OWNER}/${WS5}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: { 'vault/notes/a.md': meta(remoteNote) } })),
    [`${OWNER}/${WS5}/vault/notes/a.md`]: remoteNote,
  });
  _setSyncClientForTest(fake.client);

  // 수정 전엔 사이클마다 .conflict 사본이 1개씩 쌓였다(실측 4사이클 = 4개, base 없는 회사의 모든 .md마다).
  await freeCycle(WS5, { discovered: true });
  const after1 = await conflictsIn(dir);
  assert.equal(after1.length, 1, '충돌 사본은 .md당 정확히 1개(0이면 충돌 분기가 아예 안 돈 것)');
  for (let i = 0; i < 3; i++) await freeCycle(WS5);
  assert.deepEqual(await conflictsIn(dir), after1, '추가 사이클이 사본을 더 만들지 않는다(증식 종결)');
  assert.deepEqual(fake.removed, [], '원격 삭제 없음');

  // ⚠ 핵심 계약(검수 Finding 1) — base는 **디스크에 실제로 있는 것**만 주장해야 한다. 업로드가 로컬 쓰기보다
  // 앞서면 "원격본을 받았다"는 거짓 base가 남고, 다음 사이클이 '로컬만 변경'으로 읽어 로컬본을 원격에 밀어
  // 다른 기기의 편집을 소멸시킨다(격리 재현: 승격 1회에 원격본 유실).
  const base = JSON.parse(await readFile(join(ROOT, WS5, '.sync-state.json'), 'utf8')).files;
  assert.equal(base['vault/notes/a.md'].h, meta(remoteNote).h, 'base는 원격본을 주장한다');
  assert.equal(await readFile(join(dir, 'a.md'), 'utf8'), REMOTE, '그 주장대로 디스크에도 원격본이 있다(거짓 base 금지)');
  assert.equal(await readFile(join(dir, after1[0]), 'utf8'), LOCAL, '로컬 편집은 .conflict 사본으로 보존된다');
  assert.equal('vault/notes/' + after1[0] in base, false, '못 올린 사본은 base에 없다 → 승격 시 신규로 push');

  // Pro 승격 1사이클 — 양쪽 판본이 모두 클라우드에 남아야 한다(어느 쪽도 조용히 소멸하지 않는다)
  fake.state.writable = true;
  await syncCompany(WS5, OWNER, false, {});
  const cloud = [...fake.store.entries()].filter(([k]) => k.includes('vault/notes')).map(([, v]) => openSecretCompat(v).toString()); // 업로드는 v2 봉투(전체 봉투 기본 켜짐) — 관용 개봉 뒤 비교
  assert.ok(cloud.includes(REMOTE), '원격본이 클라우드에 살아있다(유실 금지)');
  assert.ok(cloud.includes(LOCAL), '로컬 편집본도 사본으로 올라간다');
});

test('Pro·미확인 계약(opts 없음)은 쓰기 실패를 관용하지 않는다 — 파일 루프도 포함(실패 가시성)', async () => {
  const WS6 = 'ws6';
  await mkdir(join(ROOT, WS6, 'vault', 'notes'), { recursive: true });
  await writeFile(join(ROOT, WS6, 'vault', 'notes', 'local.md'), '# 로컬 전용\n');
  const fake = freeStorage({ [`${OWNER}/${WS6}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: {} })) });
  _setSyncClientForTest(fake.client);
  await assert.rejects(() => syncCompany(WS6, OWNER, true), /row-level security/);
  assert.equal(await syncStateExists(WS6), false, 'pro는 state 미기록 = 다음 사이클 재시도(조용한 스킵 금지)');
});

test('Pro의 파일 단위 쓰기 실패는 failed로 남는다 — 분류 게이트의 행동 관측(스위트 초록 함정 방어)', async () => {
  // 위 테스트만으로는 **파일 루프의 opts.freePlan 게이트**가 잠기지 않는다(검수 2R 지적, 자체 확인함):
  // 게이트를 지워도 매니페스트 쪽이 어차피 throw해 결과가 같아 초록이었고, 소스 스캔만이 잡았다.
  // 게이트가 관측되는 유일한 형태 = **매니페스트는 성공하는데 파일 하나가 실패** → 그때 pro는
  // failed=1/denied=0이어야 한다. 게이트를 지우면 failed=0/denied=1이 되어 진짜 실패가 status에서 사라진다.
  const WS7 = 'ws7';
  await mkdir(join(ROOT, WS7, 'vault', 'notes'), { recursive: true });
  await writeFile(join(ROOT, WS7, 'vault', 'notes', 'local.md'), '# 밀다 실패할 파일\n');
  const fake = freeStorage(
    { [`${OWNER}/${WS7}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: {} })) },
    { writable: true, denyKey: (k) => !k.endsWith('__manifest__.json') },
  );
  _setSyncClientForTest(fake.client);
  const r = await syncCompany(WS7, OWNER, false, {}); // pro 계약 — 관용 없음
  assert.equal(r.failed, 1, '쓰기 실패가 failed로 보고된다(거부로 위장하면 운영자가 실패를 못 본다)');
  assert.equal(r.denied, 0, 'pro에는 denied 분류가 없다');
});
