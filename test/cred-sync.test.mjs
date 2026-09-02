// credSync(자격 증명 클라우드 동기화 토글) — 행동 테스트.
// 핀(PIN): 토글 도입 전부터 성립하던 인접 행동을 먼저 고정한다(인접 회귀 방지 규칙 — 수정보다 먼저).
//   PIN1 기본 동작: credSync 미지정이면 자격 3종이 봉투로 push된다(현행 유지가 곧 불변식).
//   PIN2 보호 경로: blob이 살아 있으면 매니페스트 항목 유실을 heal로 복원하고 로컬을 지우지 않는다
//        — 회수(마커 upsert) 설계가 구버전 기기 보호를 위해 의존하는 바로 그 경로다.
// T*: credSync=false의 새 행동(회수·불가시·마커 pull 차단·재개)을 syncCompany 호출부 단위로 잠근다.
//
// 격리: ARGO_ROOT를 먼저 세팅한 뒤 동적 import(파일별 별도 프로세스 — sync-integration과 동일 하네스).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-cred-sync-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';
delete process.env.ARGO_SYNC_ALLOW_MASS_DELETE;
// 서비스 모드(셀프호스트 = 자기 인프라) 고정 — PIN/T1~T7은 credSync 토글이 살아 있는 이 모드의
// 의미론이다. 호스티드 모드는 자격이 항상 강제 제외(hostedCredsOff)라 아래 H* 테스트가 따로 잠근다.
// (URL+SERVICE_ROLE만 있고 ANON 없음 → authOn=false → serviceCredsAllowed=true → 서비스 모드)
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://selfhost.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'selfhost-service-key-not-real';
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.ARGO_TENANT_OWNER;
// 호스티드 모드 재현 — env를 지우면 loadSyncCreds가 null이라 hostedCredsOff()=true.
const asHosted = async (fn) => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try { await fn(); } finally { process.env.NEXT_PUBLIC_SUPABASE_URL = url; process.env.SUPABASE_SERVICE_ROLE_KEY = key; }
};

const { syncCompany, _setSyncClientForTest, _tombstonesForTest } = await import('../src/sync.mjs');
const { ensureAccountKey, clearAccountKey } = await import('../src/accountkey.mjs');
const { sealSecret } = await import('../src/secretbox.mjs');

const OWNER = 'o';
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: hashBuf(buf) });
// account_keys 조회 흉내 — v2 봉투 키 확보(enc-vault.test.mjs와 동일 패턴)
const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });
await ensureAccountKey(fakeKeySb(Buffer.alloc(32, 5).toString('base64')), 'owner-cred-sync');

function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const bucket = {
    _removed: [],
    async download(key) {
      if (!store.has(key)) return { data: null, error: { message: 'Object not found', status: 404 } };
      const buf = store.get(key);
      return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
    },
    async upload(key, blob) {
      store.set(key, Buffer.from(await blob.arrayBuffer()));
      return { error: null };
    },
    async remove(keys) {
      for (const k of keys) { store.delete(k); bucket._removed.push(k); }
      return { error: null };
    },
    // Supabase storage list 모사(sync-integration과 동일) — T7의 tombstone 목록 조회가 쓴다.
    async list(prefix) {
      const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
      const names = new Map();
      for (const k of store.keys()) {
        if (!k.startsWith(p)) continue;
        const rest = k.slice(p.length);
        const seg = rest.split('/')[0];
        const isFile = !rest.includes('/');
        if (!names.has(seg) || isFile) names.set(seg, isFile);
      }
      return { data: [...names].map(([name, isFile]) => ({ name, id: isFile ? 'f' : null })) };
    },
  };
  return { _store: store, _bucket: bucket, storage: { from: () => bucket }, createBucket: async () => ({}) };
}

async function setup(wsId, { localFiles = {}, state = {}, remoteFiles = {}, remoteBlobs = {} }) {
  const wsRoot = join(ROOT, wsId);
  await mkdir(join(wsRoot, 'vault'), { recursive: true });
  for (const [rel, buf] of Object.entries(localFiles)) {
    const full = join(wsRoot, ...rel.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, buf);
  }
  await writeFile(join(wsRoot, '.sync-state.json'), JSON.stringify({ files: state, ts: 1000 }));
  const store = { [`${OWNER}/${wsId}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: remoteFiles })) };
  for (const [rel, buf] of Object.entries(remoteBlobs)) store[`${OWNER}/${wsId}/${rel}`] = buf;
  const fake = fakeStorage(store);
  _setSyncClientForTest(fake);
  return { wsRoot, fake };
}

const manifest = (fake, wsId) => JSON.parse(fake._store.get(`${OWNER}/${wsId}/__manifest__.json`).toString());
const SECRETS = Buffer.from(JSON.stringify({ claude: { key: 'sk-test-not-real' } }));
const CONNS = Buffer.from(JSON.stringify({ telegram: { token: 'tg-test-not-real' }, slack: {} }));
const MCP = Buffer.from(JSON.stringify({ servers: { x: { command: 'node', env: { T: 'v' } } } }));

/* ── PIN1: 서비스 모드 기본 동작(credSync 미지정) — 자격 3종이 봉투로 push된다 ── */
test('PIN1: 서비스 모드(셀프호스트)는 토글 미지정 시 자격 3종이 봉투 암호문으로 push된다', async () => {
  const wsId = 'pin-push';
  const note = Buffer.from('# note\n');
  const { fake } = await setup(wsId, {
    localFiles: { '.secrets.json': SECRETS, 'connections.json': CONNS, 'mcp.json': MCP, 'vault/a.md': note },
  });
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.failed, 0);
  const man = manifest(fake, wsId);
  for (const rel of ['.secrets.json', 'connections.json', 'mcp.json']) {
    assert.ok(man.files[rel], `${rel} 매니페스트에 실림`);
    const blob = fake._store.get(`${OWNER}/${wsId}/${rel}`);
    assert.ok(blob.toString('utf8', 0, 14) === 'argosecret.v2:', `${rel} 은 항상 봉투로 나간다`);
  }
  assert.ok(man.files['vault/a.md'], '일반 파일도 정상 push');
});

/* ── PIN2: 보호 경로 — blob 생존이면 heal(항목 복원), 로컬 자격을 지우지 않는다 ── */
test('PIN2: 자격 blob이 살아 있으면 매니페스트 항목 유실을 heal로 복원 — 로컬 자격 보존', async () => {
  const wsId = 'pin-heal';
  const sealed = sealSecret(SECRETS);
  // 로컬·base엔 자격이 있고(무변경), 매니페스트엔 항목이 없다. blob은 살아 있다(내용 무관 — 실존이 판별자).
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { '.secrets.json': SECRETS },
    state: { '.secrets.json': meta(SECRETS) },
    remoteFiles: {},
    remoteBlobs: { '.secrets.json': sealed },
  });
  const r = await syncCompany(wsId, OWNER);
  assert.ok(existsSync(join(wsRoot, '.secrets.json')), '로컬 자격 파일이 지워지지 않는다');
  assert.equal(r.deletedL, 0, '로컬 삭제 0');
  assert.equal(r.healed, 1, 'heal 1건(항목 복원)');
  assert.ok(manifest(fake, wsId).files['.secrets.json'], '매니페스트 항목 복원');
});

/* ── T1: credSync off — 클라우드 사본을 마커로 회수, 매니페스트·base에서 내림, 로컬은 그대로 ── */
test('T1: noSecrets — 원격 자격 암호문이 마커로 덮이고(remove 아님) 매니페스트·base에서 내려간다', async () => {
  const wsId = 'cs-withdraw';
  const note = Buffer.from('# keep\n');
  const sealed = { '.secrets.json': sealSecret(SECRETS), 'connections.json': sealSecret(CONNS), 'mcp.json': sealSecret(MCP) };
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { '.secrets.json': SECRETS, 'connections.json': CONNS, 'mcp.json': MCP, 'vault/keep.md': note },
    state: {
      '.secrets.json': meta(SECRETS), 'connections.json': meta(CONNS), 'mcp.json': meta(MCP), 'vault/keep.md': meta(note),
    },
    remoteFiles: {
      '.secrets.json': meta(SECRETS), 'connections.json': meta(CONNS), 'mcp.json': meta(MCP), 'vault/keep.md': meta(note),
    },
    remoteBlobs: { ...sealed, 'vault/keep.md': note },
  });
  const r = await syncCompany(wsId, OWNER, false, { noSecrets: true });
  assert.equal(r.withdrawn, 3, '자격 3종 회수');
  assert.equal(r.failed, 0);
  assert.equal(fake._bucket._removed.length, 0, 'blob remove는 절대 나가지 않는다(미반영 기기 보호 불변식)');
  const man = manifest(fake, wsId);
  for (const rel of ['.secrets.json', 'connections.json', 'mcp.json']) {
    assert.ok(!man.files[rel], `${rel} 매니페스트에서 내려감`);
    const blob = fake._store.get(`${OWNER}/${wsId}/${rel}`);
    assert.ok(blob && blob.toString() === 'argosecret.v2:credSync-off', `${rel} blob이 마커로 덮임(암호문 소멸·실존 유지)`);
    assert.ok(existsSync(join(wsRoot, ...rel.split('/'))), `${rel} 로컬 파일은 그대로(로그아웃 없음)`);
  }
  assert.ok(man.files['vault/keep.md'], '일반 파일 동기화는 계속된다');
  const st = JSON.parse(await readFile(join(wsRoot, '.sync-state.json'), 'utf8'));
  assert.ok(!st.files['.secrets.json'] && !st.files['connections.json'] && !st.files['mcp.json'], 'base에서도 내려감');
});

/* ── T2: 회수 이후의 정상 상태 — 다음 사이클은 회수 0·push 0(재업로드 없음) ── */
test('T2: 회수 완료 상태의 다음 사이클 — 재회수·재업로드 없이 조용히 지나간다', async () => {
  const wsId = 'cs-steady';
  const MARKER = Buffer.from('argosecret.v2:credSync-off');
  const { fake } = await setup(wsId, {
    localFiles: { '.secrets.json': SECRETS },  // 로컬 자격은 남아 있다(이 기기는 계속 로그인 상태)
    state: {},                                  // 회수 사이클이 base에서 내렸다
    remoteFiles: {},                            // 매니페스트에도 없다
    remoteBlobs: { '.secrets.json': MARKER },   // 마커만 실존
  });
  const r = await syncCompany(wsId, OWNER, false, { noSecrets: true });
  assert.equal(r.withdrawn ?? 0, 0, '재회수 없음');
  assert.equal(r.pushed, 0, '로컬 자격 재업로드 없음(불가시)');
  assert.equal(fake._store.get(`${OWNER}/${wsId}/.secrets.json`).toString(), MARKER.toString(), '마커 유지');
});

/* ── T3: 토글 미반영 기기(구버전 코드 경로와 동일) — 마커 실존이 heal을 태워 로컬 자격 보존 ── */
test('T3: 미반영 기기 — 매니페스트 부재 + 마커 blob 실존이면 rmLocal이 아니라 heal(로컬 자격 생존)', async () => {
  const wsId = 'cs-oldpath';
  const MARKER = Buffer.from('argosecret.v2:credSync-off');
  // 미반영 기기 시점: 로컬 자격 + base 무변경, 원격은 회수 완료(매니페스트 부재·마커 실존).
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { '.secrets.json': SECRETS },
    state: { '.secrets.json': meta(SECRETS) },
    remoteFiles: {},
    remoteBlobs: { '.secrets.json': MARKER },
  });
  const r = await syncCompany(wsId, OWNER); // opts 없음 = 토글 미반영(구버전 동작과 동일 분기)
  assert.ok(existsSync(join(wsRoot, '.secrets.json')), '로컬 자격 파일 생존 — 오삭제 없음');
  assert.equal(r.deletedL, 0);
  assert.equal(r.healed, 1, 'heal 분기(항목 복원) — blob 실존이 삭제 오판을 막는다');
});

/* ── T4: 미반영 기기의 마커 pull 차단 — 로컬에 마커 내용을 쓰지 않는다 ── */
test('T4: 미반영 기기 — 매니페스트에 항목이 있고 blob이 마커면 pull을 보류(로컬에 junk 미기록)', async () => {
  const wsId = 'cs-markerpull';
  const MARKER = Buffer.from('argosecret.v2:credSync-off');
  // heal된 항목이 매니페스트에 남은 창(다른 미반영 기기가 복원) + blob은 마커. 이 기기 로컬엔 자격 없음(신규).
  const { wsRoot } = await setup(wsId, {
    localFiles: {},
    state: {},
    remoteFiles: { 'mcp.json': meta(MARKER), '.secrets.json': meta(MARKER) },
    remoteBlobs: { 'mcp.json': MARKER, '.secrets.json': MARKER },
  });
  const r = await syncCompany(wsId, OWNER); // 토글 미반영 기기
  assert.ok(!existsSync(join(wsRoot, 'mcp.json')), 'mcp.json에 마커 junk를 쓰지 않는다(관용 개봉 우회 차단)');
  assert.ok(!existsSync(join(wsRoot, '.secrets.json')), '.secrets.json 미기록');
  assert.ok(r.failed >= 2, '보류 집계 — 토글이 도착하면 불가시로 수렴');
});

/* ── T5: 다시 켜기 — 로컬 자격이 신규로 push되어 마커를 실암호문으로 되덮는다 ── */
test('T5: credSync 재활성 — 회수됐던 자격이 봉투로 재push된다(마커 → 암호문)', async () => {
  const wsId = 'cs-reenable';
  const MARKER = Buffer.from('argosecret.v2:credSync-off');
  const { fake } = await setup(wsId, {
    localFiles: { '.secrets.json': SECRETS },
    state: {},                                 // 회수 사이클이 내려 base 없음
    remoteFiles: {},
    remoteBlobs: { '.secrets.json': MARKER },
  });
  const r = await syncCompany(wsId, OWNER); // 토글 다시 켬(= opts 없음)
  assert.equal(r.pushed, 1, '신규 push 재개');
  const blob = fake._store.get(`${OWNER}/${wsId}/.secrets.json`);
  assert.equal(blob.toString('utf8', 0, 14), 'argosecret.v2:', '마커가 실봉투로 되덮임');
  assert.ok(manifest(fake, wsId).files['.secrets.json'], '매니페스트 복귀');
});

/* ── T6: 마커 upsert 실패 사이클 — 항목 유지·remove 미발생·브레이크 미발화(다음 사이클 재시도) ── */
test('T6: 마커 업로드 실패 — real-delete로 넘어가지 않고 항목을 남겨 재시도한다', async () => {
  const wsId = 'cs-upfail';
  const sealed = sealSecret(SECRETS);
  const { fake } = await setup(wsId, {
    localFiles: { '.secrets.json': SECRETS },
    state: { '.secrets.json': meta(SECRETS) },
    remoteFiles: { '.secrets.json': meta(SECRETS) },
    remoteBlobs: { '.secrets.json': sealed },
  });
  const bucket = fake.storage.from();
  const orig = bucket.upload.bind(bucket);
  const patched = {
    ...bucket,
    async upload(key, blob) {
      if (key.endsWith('.secrets.json')) return { error: { message: 'boom 500' } };
      return orig(key, blob);
    },
  };
  _setSyncClientForTest({ ...fake, storage: { from: () => patched } });
  const r = await syncCompany(wsId, OWNER, false, { noSecrets: true });
  assert.equal(r.withdrawn ?? 0, 0, '회수 실패로 집계 0');
  assert.equal(r.failed, 0, '회수 블록의 자체 try/catch — failed로 새지 않는다(분리 검수 LOW-2)');
  assert.equal(r.denied ?? 0, 0, 'freePlan 관용 집계(denied)로도 새지 않는다');
  assert.equal(fake._bucket._removed.length, 0, 'remove 미발생(오삭제 경로 차단)');
  assert.ok(fake._store.get(`${OWNER}/${wsId}/.secrets.json`).equals(sealed), '원 암호문 그대로(다음 사이클 재시도)');
  assert.ok(manifest(fake, wsId).files['.secrets.json'], '항목 유지 — blob만 남는 부활 오판 상태를 안 만든다');
});

/* ── T7: 보관 전파 경로도 옵트아웃을 지킨다(분리 검수 HIGH-1 — 호출부 단위 게이트) ── */
test('T7: 원격 tombstone 보관 전파의 마지막 push가 credSync:false 회사의 자격을 되올리지 않는다', async () => {
  const wsId = 'cs-tomb';
  const note = Buffer.from('# last-edit\n');
  // 회수 완료 상태의 회사: 로컬엔 자격+미push 노트, base·원격 매니페스트엔 자격 없음, blob은 마커.
  const { fake } = await setup(wsId, {
    localFiles: {
      'company.json': Buffer.from(JSON.stringify({ id: wsId, ownerId: OWNER, credSync: false })),
      '.secrets.json': SECRETS,
      'vault/last.md': note,
    },
    state: {},
    remoteFiles: {},
    remoteBlobs: { '.secrets.json': Buffer.from('argosecret.v2:credSync-off') },
  });
  // 다른 기기의 보관 신호 — 회사 수정 시각보다 나중이어야 전파 분기에 진입한다.
  fake._store.set(`${OWNER}/.tombstones/${wsId}.json`, Buffer.from(JSON.stringify({ wsId, at: Date.now() + 60_000 })));
  const tombs = await _tombstonesForTest.syncTombstones(OWNER);
  assert.ok(tombs.has(wsId), '보관 전파됨');
  assert.ok(!existsSync(join(ROOT, wsId)), '회사가 보관 처리됨 — 이후 cycle 대상이 아니므로 이 push가 마지막 기회였다');
  const man = manifest(fake, wsId);
  assert.ok(man.files['vault/last.md'], '미push 편집(일반 파일)은 마지막 push로 고립을 면한다');
  assert.ok(!man.files['.secrets.json'], '자격은 매니페스트로 되올라가지 않는다(옵트아웃 우회 금지)');
  const blob = fake._store.get(`${OWNER}/${wsId}/.secrets.json`);
  assert.ok(blob && blob.toString() === 'argosecret.v2:credSync-off', '자격 blob은 마커 그대로(암호문 재업로드 없음)');
});

/* ── H1: 호스티드 강제(유건 지시 2026-08-29) — 선택권이 아니라 구조: opts 없이도 자격은 절대 안 올라간다 ── */
test('H1: 호스티드 모드는 opts·credSync와 무관하게 자격을 push하지 않고 기존 클라우드 사본을 회수한다', async () => {
  const wsId = 'h-forced';
  const note = Buffer.from('# data\n');
  const sealed = sealSecret(SECRETS);
  // credSync 필드가 아예 없는 평범한 회사 + 클라우드에 과거 버전이 올린 자격 암호문이 남아 있는 상태.
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { '.secrets.json': SECRETS, 'vault/data.md': note },
    state: { '.secrets.json': meta(SECRETS) },
    remoteFiles: { '.secrets.json': meta(SECRETS) },
    remoteBlobs: { '.secrets.json': sealed },
  });
  await asHosted(async () => {
    const r = await syncCompany(wsId, OWNER); // opts 없음 — 강제는 함수 내부 게이트
    assert.equal(r.withdrawn, 1, '과거 사본이 자동 회수된다(마커 덮어쓰기)');
    assert.equal(r.pushed, 1, '일반 파일(vault/data.md)만 push된다');
    assert.equal(fake._bucket._removed.length, 0, 'remove 미발생(구버전 보호 불변식 유지)');
  });
  const man = manifest(fake, wsId);
  assert.ok(!man.files['.secrets.json'], '자격은 매니페스트에 없다');
  assert.ok(man.files['vault/data.md'], '회사 데이터 동기화는 그대로');
  assert.equal(fake._store.get(`${OWNER}/${wsId}/.secrets.json`).toString(), 'argosecret.v2:credSync-off', '암호문이 마커로 소거(활성 사본)');
  assert.ok(existsSync(join(wsRoot, '.secrets.json')), '로컬 자격은 유지(이 기기 로그인 보존)');
});

/* ── H2: 호스티드에서 credSync:true를 명시해도 우회 불가(강제가 토글보다 우선) ── */
test('H2: 호스티드는 credSync:true(포함 의사)도 무시한다 — 토글은 서비스 모드 전용 선택권', async () => {
  const wsId = 'h-noopt';
  const { fake } = await setup(wsId, {
    localFiles: { 'company.json': Buffer.from(JSON.stringify({ id: wsId, ownerId: OWNER, credSync: true })), '.secrets.json': SECRETS },
  });
  await asHosted(async () => {
    const r = await syncCompany(wsId, OWNER, false, { noSecrets: false }); // 호출부가 false를 명시해도
    assert.equal(r.failed, 0);
  });
  assert.ok(!manifest(fake, wsId).files['.secrets.json'], '자격 미push — 함수 내부 강제라 호출부·필드로 우회 불가');
  assert.ok(!fake._store.has(`${OWNER}/${wsId}/.secrets.json`), '자격 blob 자체가 생기지 않는다');
});

test.after(async () => { clearAccountKey(); await rm(ROOT, { recursive: true, force: true }); });
