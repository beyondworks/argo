// E2EE P1 — 복구 코드·자기 랩 회수(claim)·v3 전량 봉인·열쇠 없는 기기 보류·재봉인(reseal).
// 행동 테스트: syncCompany·e2ee 프리미티브를 실제로 돌린다(소스 문자열 단언 금지 규율).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-e2ee-p1-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';

const { syncCompany, _setSyncClientForTest } = await import('../src/sync.mjs');
const {
  loadDeviceE2ee, dek, setDek, clearDekCache, wrapDekFor, pubFingerprint,
  generateRecoveryCode, normalizeRecoveryCode, deriveRecoveryKek, wrapDekWithKek, openDekWithKek,
  tryClaimDek, _resetClaimForTest,
} = await import('../src/e2ee.mjs');

const OWNER = 'o';
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: hashBuf(buf) });

function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const bucket = {
    async download(k) {
      if (!store.has(k)) return { data: null, error: { message: 'Object not found', status: 404 } };
      const buf = store.get(k);
      return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
    },
    async upload(k, blob) { store.set(k, Buffer.from(await blob.arrayBuffer())); return { error: null }; },
    async remove(keys) { for (const k of keys) store.delete(k); return { error: null }; },
    async list() { return { data: [] }; },
  };
  return { _store: store, storage: { from: () => bucket }, createBucket: async () => ({}) };
}

/* ── 복구 코드 — 생성·정규화·왕복·오입력 거부 ── */
test('복구 코드: 왕복 성공, 관용 입력(소문자·구분자·O/I 동형) 수용, 오입력은 정직 거부', () => {
  const code = generateRecoveryCode();
  assert.match(code, /^[0-9A-Z]{8}(-[0-9A-Z]{8}){3}$/, 'Crockford 8자×4');
  const salt = Buffer.alloc(16, 2).toString('base64');
  const DEK = Buffer.alloc(32, 4);
  const wrap = wrapDekWithKek(deriveRecoveryKek(code, salt), DEK);
  // 관용 입력 — 소문자·공백, O→0 동형(코드에 0이 있으면 O로 쳐도 같음)
  const sloppy = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'O');
  assert.deepEqual(openDekWithKek(deriveRecoveryKek(sloppy, salt), wrap), DEK, '관용 정규화로 왕복');
  assert.equal(normalizeRecoveryCode('i1-Lo'), '1110', '동형 문자 정규화');
  const wrong = deriveRecoveryKek(code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A'), salt);
  assert.throws(() => openDekWithKek(wrong, wrap), /복구 코드가 맞지 않습니다/, '오입력은 GCM 거부 → 정직 문구');
});

/* ── 지문 — SAS 대조 코드 ── */
test('지문: 6자리 hex, 키가 다르면 지문이 다르다(서버 바꿔치기 대조 가능)', async () => {
  clearDekCache();
  const a = await loadDeviceE2ee();
  const fp = pubFingerprint(a.pub);
  assert.match(fp, /^[0-9A-F]{6}$/);
  assert.notEqual(fp, pubFingerprint(Buffer.alloc(32, 1).toString('base64')));
});

/* ── claim — 서버의 내 랩 회수로 잠김 해제 ── */
test('claim: wrapped_deks의 내 랩을 회수해 DEK 확보, 랩 없으면 false·스로틀 동작', async () => {
  const claimRoot = await mkdtemp(join(tmpdir(), 'argo-p1-claim-'));
  clearDekCache(); _resetClaimForTest();
  const me = await loadDeviceE2ee({ root: claimRoot });
  const DEK = Buffer.alloc(32, 6);
  const wrapB64 = wrapDekFor(me.pub, DEK).toString('base64');
  const sb = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { wrap: wrapB64 }, error: null }) }) }) }) };
  assert.equal(await tryClaimDek(sb, 'dev-x', { root: claimRoot, force: true }), true, '랩 회수 성공');
  assert.deepEqual(dek(), DEK, 'DEK 확보');
  // 없는 경우
  clearDekCache(); _resetClaimForTest();
  const root2 = await mkdtemp(join(tmpdir(), 'argo-p1-claim2-'));
  await loadDeviceE2ee({ root: root2 });
  const empty = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
  assert.equal(await tryClaimDek(empty, 'dev-x', { root: root2, force: true }), false, '랩 없으면 false');
  assert.equal(await tryClaimDek(empty, 'dev-x', { root: root2 }), false, '스로틀 — 즉시 재시도는 건너뜀');
  await rm(claimRoot, { recursive: true, force: true });
  await rm(root2, { recursive: true, force: true });
});

/* ── sync 통합: DEK 보유 = 전량 v3 봉인(파일+매니페스트) ── */
test('v3 전환: DEK 보유 기기의 push는 파일·매니페스트 전부 v3 봉투로 나간다', async () => {
  clearDekCache();
  await loadDeviceE2ee();
  await setDek(Buffer.alloc(32, 8));
  const wsId = 'p1-seal';
  const wsRoot = join(ROOT, wsId);
  await mkdir(join(wsRoot, 'vault'), { recursive: true });
  await writeFile(join(wsRoot, 'vault', 'memo.md'), '# 사용자만 여는 기억\n');
  await writeFile(join(wsRoot, '.sync-state.json'), JSON.stringify({ files: {}, ts: 1000 }));
  const fake = fakeStorage({ [`${OWNER}/${wsId}/__manifest__.json`]: Buffer.from('{"files":{}}') });
  _setSyncClientForTest(fake);
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.failed, 0);
  const blob = fake._store.get(`${OWNER}/${wsId}/vault/memo.md`);
  assert.equal(blob.toString('utf8', 0, 14), 'argosecret.v3:', '파일이 v3 봉투');
  const man = fake._store.get(`${OWNER}/${wsId}/__manifest__.json`);
  assert.equal(man.toString('utf8', 0, 14), 'argosecret.v3:', '매니페스트도 v3 — 열쇠 없는 기기의 게이트');
});

/* ── sync 통합: 열쇠 없는 기기는 그 회사 동기화가 통째로 안전 보류 ── */
test('잠김: DEK 없는 기기는 v3 매니페스트 개봉이 보류로 떨어져 회사 동기화 전체가 멈춘다(오염·오삭제 없음)', async () => {
  // 위 테스트가 올린 v3 상태를 그대로 사용하되, DEK 없는 기기를 재현
  const wsId = 'p1-locked';
  const sealRoot = await mkdtemp(join(tmpdir(), 'argo-p1-lock-'));
  // 송신측: DEK 보유 상태로 원격에 v3 회사 구성
  clearDekCache();
  await loadDeviceE2ee();
  await setDek(Buffer.alloc(32, 8));
  const wsRootA = join(ROOT, wsId);
  await mkdir(join(wsRootA, 'vault'), { recursive: true });
  await writeFile(join(wsRootA, 'vault', 'a.md'), '# v3\n');
  await writeFile(join(wsRootA, '.sync-state.json'), JSON.stringify({ files: {}, ts: 1000 }));
  const fake = fakeStorage({ [`${OWNER}/${wsId}/__manifest__.json`]: Buffer.from('{"files":{}}') });
  _setSyncClientForTest(fake);
  await syncCompany(wsId, OWNER);
  // 수신측(잠김): DEK 없는 키 파일로 전환 — ROOT의 dek를 지워 승인 전 기기 재현
  const cur = JSON.parse(await readFile(join(ROOT, '.device-e2ee.json'), 'utf8'));
  delete cur.dek;
  await writeFile(join(ROOT, '.device-e2ee.json'), JSON.stringify(cur), { mode: 0o600 });
  clearDekCache();
  await loadDeviceE2ee();
  assert.equal(dek(), null, '전제: 잠김 기기');
  // 로컬을 비운 새 회사 폴더처럼 만들어 pull 시도 상황 재현
  await rm(join(wsRootA, 'vault'), { recursive: true, force: true });
  await mkdir(join(wsRootA, 'vault'), { recursive: true });
  await assert.rejects(
    () => syncCompany(wsId, OWNER),
    /매니페스트|열쇠|앱 업데이트/,
    '매니페스트 게이트 — 회사 단위 보류(파일 단위 오염·오삭제 원천 차단)',
  );
  assert.ok(!existsSync(join(wsRootA, 'vault', 'a.md')), '로컬에 아무것도 기록되지 않는다');
  assert.ok(fake._store.has(`${OWNER}/${wsId}/vault/a.md`), '원격도 그대로');
  await rm(sealRoot, { recursive: true, force: true });
});

/* ── reseal: 무변경 파일도 1회 강제 push로 blob이 v3로 교체(메타·base 불변) ── */
test('reseal: 켠 직후 옛 평문 blob이 v3로 되덮이고 메타·base는 불변(타 기기 diff 무영향)', async () => {
  clearDekCache();
  // DEK 재보유(위 테스트가 파일에서 dek를 지웠으므로 다시 세팅)
  await loadDeviceE2ee();
  await setDek(Buffer.alloc(32, 8));
  const wsId = 'p1-reseal';
  const wsRoot = join(ROOT, wsId);
  const note = Buffer.from('# 예전 평문 노트\n');
  await mkdir(join(wsRoot, 'vault'), { recursive: true });
  await writeFile(join(wsRoot, 'vault', 'old.md'), note);
  await writeFile(join(wsRoot, '.sync-state.json'), JSON.stringify({ files: { 'vault/old.md': meta(note) }, ts: 1000 }));
  const fake = fakeStorage({
    [`${OWNER}/${wsId}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: { 'vault/old.md': meta(note) } })),
    [`${OWNER}/${wsId}/vault/old.md`]: note, // 옛 평문이 클라우드에 남아 있는 상태
  });
  _setSyncClientForTest(fake);
  const r = await syncCompany(wsId, OWNER, false, { reseal: true });
  assert.equal(r.failed, 0);
  const blob = fake._store.get(`${OWNER}/${wsId}/vault/old.md`);
  assert.equal(blob.toString('utf8', 0, 14), 'argosecret.v3:', '옛 평문이 v3로 되덮임');
  const st = JSON.parse(await readFile(join(wsRoot, '.sync-state.json'), 'utf8'));
  assert.equal(st.files['vault/old.md'].h, meta(note).h, 'base 해시(평문 기준) 불변 — 타 기기 diff 무영향');
  // 대비군: reseal 없이는 무변경 파일이 push되지 않는다(비용·의미 없음)
  const before = fake._store.get(`${OWNER}/${wsId}/vault/old.md`);
  await syncCompany(wsId, OWNER);
  assert.deepEqual(fake._store.get(`${OWNER}/${wsId}/vault/old.md`), before, 'reseal 아닌 사이클은 재업로드 없음');
});

test.after(async () => { clearDekCache(); await rm(ROOT, { recursive: true, force: true }); });
