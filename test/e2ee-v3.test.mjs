// E2EE 단계 0 — v3 봉투(사용자 전용 DEK)·기기 키쌍·미지 봉투 안전 보류.
// 핀(PIN): v1/v2·평문 관용 개봉의 현행 동작을 먼저 고정한다(인접 회귀 방지 — 수정보다 먼저).
// 핵심 위험(P0-1의 존재 이유): 'argosecret.'으로 시작하는 미지 세대(v3)를 구식 관용 개봉이
// **평문으로 통과**시키면 로컬 파일이 암호문으로 오염되고 재봉인·전파된다(마커 사고와 동일 계열).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-e2ee-'));
process.env.ARGO_ROOT = ROOT;

const {
  sealSecret, sealSecretV3, openSecret, openSecretCompat, CRED_WITHDRAWN,
} = await import('../src/secretbox.mjs');
const { ensureAccountKey, clearAccountKey } = await import('../src/accountkey.mjs');
const {
  loadDeviceE2ee, dek, setDek, clearDekCache, wrapDekFor, openDekWrap,
  ensureDeviceKeyRegistered, _resetRegisteredForTest,
} = await import('../src/e2ee.mjs');
const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });

/* ── PIN: 현행 관용 개봉 계약 ── */
test('PIN: 평문은 그대로 통과, v2는 개봉, 마커·비봉투는 현행 그대로(무회귀)', async () => {
  clearAccountKey();
  await ensureAccountKey(fakeKeySb(Buffer.alloc(32, 3).toString('base64')), 'o-e2ee-pin');
  try {
    const plain = Buffer.from('그냥 평문 노트');
    assert.deepEqual(openSecretCompat(plain), plain, '평문 passthrough 유지');
    const sealed = sealSecret(plain);
    assert.ok(sealed.toString('utf8', 0, 14) === 'argosecret.v2:', '기본 봉인은 여전히 v2(단계 0 = 동작 불변)');
    assert.deepEqual(openSecretCompat(sealed), plain, 'v2 관용 개봉 유지');
    assert.throws(() => openSecret(CRED_WITHDRAWN), '마커는 여전히 개봉 거부');
  } finally { clearAccountKey(); }
});

/* ── 기기 키 파일 — 생성·안정성·권한 ── */
test('기기 키쌍: 최초 생성 후 재로드에 안정, 파일 0600, DEK는 비어 시작(단계 0 = 동작 불변)', async () => {
  clearDekCache();
  const a = await loadDeviceE2ee();
  const b = await loadDeviceE2ee();
  assert.equal(a.pub, b.pub, '재로드에 키가 바뀌지 않는다(조용한 키 교체 금지)');
  assert.equal(Buffer.from(a.pub, 'base64').length, 32, 'X25519 raw 32B');
  assert.equal(dek(), null, '단계 0 — DEK 미보유가 기본');
  const st = await stat(join(ROOT, '.device-e2ee.json'));
  assert.equal(st.mode & 0o777, 0o600, '개인키 파일은 0600');
});

/* ── v3 왕복 + DEK 없는 보류 ── */
test('v3 봉투: DEK 보유 시 왕복, 미보유 시 명확한 보류 오류(평문 오인 절대 금지)', async () => {
  clearDekCache();
  await loadDeviceE2ee();
  await setDek(Buffer.alloc(32, 9));
  const plain = Buffer.from('회사 기억 — 사용자만 연다');
  const sealed = sealSecretV3(plain);
  assert.equal(sealed.toString('utf8', 0, 14), 'argosecret.v3:', 'v3 MAGIC');
  assert.deepEqual(openSecretCompat(sealed), plain, '관용 개봉이 v3를 연다');
  // DEK 제거 상태 재현 — 별도 임시 루트(키 파일에 dek가 없음)
  const root2 = await mkdtemp(join(tmpdir(), 'argo-e2ee2-'));
  clearDekCache();
  await loadDeviceE2ee({ root: root2 });
  assert.equal(dek(), null);
  assert.throws(() => openSecretCompat(sealed), /열쇠가 없습니다|기기 승인/, 'DEK 없으면 보류 오류 — 평문 통과 금지');
  await rm(root2, { recursive: true, force: true });
});

/* ── 전방 호환 게이트 — 미지 세대의 평문 통과 금지(이 스토리의 핵심 안전 속성) ── */
test('미지 세대(v9)도 관용 개봉을 평문으로 통과하지 못한다 — 보류 오류', () => {
  const fake = Buffer.concat([Buffer.from('argosecret.v9:'), Buffer.alloc(64, 1)]);
  assert.throws(() => openSecretCompat(fake), /미지 봉투 세대|앱 업데이트/, '미래 세대 암호문이 로컬 파일을 오염시키지 않는다');
});

/* ── DEK 랩 왕복 — 두 기기 시뮬(기존 기기 → 새 기기) + 위변조 거부 ── */
test('DEK 랩: 새 기기 공개키로 랩 → 새 기기만 개봉, 위변조는 GCM이 거부', async () => {
  // 새 기기 = 별도 루트
  const newRoot = await mkdtemp(join(tmpdir(), 'argo-e2ee-new-'));
  clearDekCache();
  const newDev = await loadDeviceE2ee({ root: newRoot });
  const DEK = Buffer.alloc(32, 7);
  const wrap = wrapDekFor(newDev.pub, DEK);
  assert.ok(wrap.toString('utf8', 0, 15) === 'argokeywrap.v1:', '랩 형식');
  const opened = await openDekWrap(wrap, { root: newRoot });
  assert.deepEqual(opened, DEK, '새 기기가 DEK를 복원한다');
  // 위변조 — 마지막 바이트 뒤집기
  const tampered = Buffer.from(wrap); tampered[tampered.length - 1] ^= 0xff;
  await assert.rejects(async () => openDekWrap(tampered, { root: newRoot }), '위변조 랩은 개봉 거부');
  // 다른 기기(엉뚱한 개인키)는 못 연다
  const otherRoot = await mkdtemp(join(tmpdir(), 'argo-e2ee-other-'));
  clearDekCache();
  await loadDeviceE2ee({ root: otherRoot });
  await assert.rejects(async () => openDekWrap(wrap, { root: otherRoot }), '수신자 아닌 기기는 개봉 불가');
  await rm(newRoot, { recursive: true, force: true });
  await rm(otherRoot, { recursive: true, force: true });
});

/* ── 기기 공개키 등록 배선 — upsert 내용·1회 가드·실패 무해 ── */
test('등록: device_keys upsert(공개키만), 프로세스당 1회, 실패해도 기능 무영향', async () => {
  clearDekCache(); _resetRegisteredForTest();
  await loadDeviceE2ee();
  const rows = [];
  const sb = { from: (t) => ({ upsert: async (row, opts) => { rows.push({ t, row, opts }); return { error: null }; } }) };
  await ensureDeviceKeyRegistered(sb, 'o-reg', 'dev-1');
  await ensureDeviceKeyRegistered(sb, 'o-reg', 'dev-1');
  assert.equal(rows.length, 1, '오너당 1회만');
  assert.equal(rows[0].t, 'device_keys');
  assert.deepEqual(Object.keys(rows[0].row).sort(), ['device_id', 'pubkey', 'user_id'], '공개키 외 아무것도 안 올린다(개인키·DEK 부재)');
  assert.equal(Buffer.from(rows[0].row.pubkey, 'base64').length, 32);
  // 실패 무해 — 테이블 부재 등
  _resetRegisteredForTest();
  const bad = { from: () => ({ upsert: async () => ({ error: { message: 'relation does not exist' } }) }) };
  await ensureDeviceKeyRegistered(bad, 'o-reg2', 'dev-1'); // throw하지 않아야 한다
});

/* ── 크로스 프로세스 최초 생성 경합(분리 검수 HIGH 재현의 회귀 가드) — 진짜 자식 프로세스 2개 ──
   2026-08-14 기기 세션 사고와 동일 계열: 상주(:3001)와 앱 사이드카가 같은 WS_ROOT에서 동시 기동한다.
   락 없던 구현은 10회 중 9회 서로 다른 키를 만들고 한쪽이 디스크와 다른 "고아 키"로 남았다(검수 실측).
   불변식: 어느 프로세스가 이기든, **모든 프로세스의 반환 키 = 디스크의 키** 하나로 수렴한다. */
test('경합: 두 독립 프로세스가 동시에 최초 생성해도 같은 키로 수렴한다(고아 키 금지)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const script = join(ROOT, 'race-child.mjs');
  const { writeFile: wf } = await import('node:fs/promises');
  await wf(script, `
    process.env.ARGO_ROOT = process.argv[2];
    const { loadDeviceE2ee } = await import(${JSON.stringify(new URL('../src/e2ee.mjs', import.meta.url).href)});
    const s = await loadDeviceE2ee();
    console.log(s.pub);
  `);
  for (let round = 0; round < 5; round++) {
    const raceRoot = await mkdtemp(join(tmpdir(), 'argo-e2ee-race-'));
    const [a, b] = await Promise.all([
      run(process.execPath, [script, raceRoot]),
      run(process.execPath, [script, raceRoot]),
    ]);
    const pubA = a.stdout.trim(), pubB = b.stdout.trim();
    const disk = JSON.parse(await readFile(join(raceRoot, '.device-e2ee.json'), 'utf8')).pub;
    assert.equal(pubA, disk, `round ${round}: 프로세스 A의 키가 디스크와 일치(고아 키 없음)`);
    assert.equal(pubB, disk, `round ${round}: 프로세스 B의 키가 디스크와 일치(고아 키 없음)`);
    await rm(raceRoot, { recursive: true, force: true });
  }
});

/* ── sync 통합: v3 원격 파일 + DEK 미보유 기기 = 보류(불가시 홀드) — 오염·오삭제 없음 ── */
test('sync 홀드: DEK 없는 기기가 v3 원격 파일을 만나면 failed 보류 — 로컬 미기록·원격 미삭제', async () => {
  const { syncCompany, _setSyncClientForTest } = await import('../src/sync.mjs');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  // 송신측 DEK로 v3 봉인 → 수신측(이 프로세스)은 DEK 캐시를 비워 "승인 전 기기" 재현
  clearDekCache();
  await loadDeviceE2ee();
  await setDek(Buffer.alloc(32, 5));
  const cipher = sealSecretV3(Buffer.from('# 다른 기기의 E2EE 노트\n'));
  clearDekCache();
  const root3 = await mkdtemp(join(tmpdir(), 'argo-e2ee-hold-'));
  process.env.ARGO_ROOT_IGNORED = root3; // (주석용) — syncCompany는 모듈 로드 시 고정된 WS_ROOT(ROOT)를 쓴다
  await loadDeviceE2ee(); // ROOT의 키 파일에는 dek가 저장돼 있으므로, 캐시만 비우면 안 된다 —
  // 위 setDek가 ROOT 파일에 dek를 남겼다. 승인 전 기기를 정확히 재현하려면 dek 없는 키 파일이어야
  // 하므로 파일을 dek 없이 되돌린다.
  const cur = JSON.parse(await readFile(join(ROOT, '.device-e2ee.json'), 'utf8'));
  delete cur.dek;
  await writeFile(join(ROOT, '.device-e2ee.json'), JSON.stringify(cur), { mode: 0o600 });
  clearDekCache();
  await loadDeviceE2ee();
  assert.equal(dek(), null, '전제: 이 기기는 DEK 미보유(승인 전)');

  const wsId = 'e2ee-hold';
  const wsRoot = join(ROOT, wsId);
  await mkdir(join(wsRoot, 'vault'), { recursive: true });
  await writeFile(join(wsRoot, '.sync-state.json'), JSON.stringify({ files: {}, ts: 1000 }));
  const key = (rel) => `o/${wsId}/${rel}`;
  const store = new Map([
    [key('__manifest__.json'), Buffer.from(JSON.stringify({ files: { 'vault/note.md': { m: 2000, s: cipher.length, h: 'x'.repeat(16) } } }))],
    [key('vault/note.md'), cipher],
  ]);
  const bucket = {
    _removed: [],
    async download(k) {
      if (!store.has(k)) return { data: null, error: { message: 'Object not found', status: 404 } };
      const buf = store.get(k);
      return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
    },
    async upload(k, blob) { store.set(k, Buffer.from(await blob.arrayBuffer())); return { error: null }; },
    async remove(keys) { for (const k of keys) { store.delete(k); bucket._removed.push(k); } return { error: null }; },
    async list() { return { data: [] }; },
  };
  _setSyncClientForTest({ _store: store, storage: { from: () => bucket }, createBucket: async () => ({}) });
  const r = await syncCompany(wsId, 'o');
  assert.ok(r.failed >= 1, 'v3 파일은 보류(failed) — 다음 사이클 재시도(DEK 도착·업데이트가 해소)');
  assert.ok(!existsSync(join(wsRoot, 'vault', 'note.md')), '암호문·평문 어느 쪽도 로컬에 기록되지 않는다(오염 차단)');
  assert.ok(store.has(key('vault/note.md')), '원격 원본은 그대로(오삭제 없음)');
  assert.equal(bucket._removed.length, 0, 'remove 미발생');
  await rm(root3, { recursive: true, force: true });
});

test.after(async () => { clearAccountKey(); clearDekCache(); await rm(ROOT, { recursive: true, force: true }); });
