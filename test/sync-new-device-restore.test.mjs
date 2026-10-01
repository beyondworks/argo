// 새 기기 첫 복원 — 회사 폴더가 아직 없는 상태(실측 2026-09-30, argo CLI 첫 로그인).
// 폴더 부재가 walk 실패('' = 루트)로 기록돼 원격 3,401개가 전부 "로컬 unknown"으로 보류됐고, 오류도 없어
// CLI는 "회사가 없습니다"를 띄웠다. 다음 발견 주기(5분) 뒤에야 받았다. 기존 복원 테스트는 전부 폴더를 먼저 만들어 이 경로를 못 봤다.
// 인접 핀: 복원이 아닌 기존 회사의 루트 읽기 실패는 여전히 삭제 보류(walk 실패발 대량 유실 방어).
// ⚠ ARGO_ROOT는 sync.mjs(→workspace.mjs) 동적 임포트보다 먼저.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-newdev-'));
process.env.ARGO_ROOT = ROOT;
const { syncCompany, _setSyncClientForTest } = await import('../src/sync.mjs');
const { ensureAccountKey, clearAccountKey } = await import('../src/accountkey.mjs');
const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });
await ensureAccountKey(fakeKeySb(Buffer.alloc(32, 7).toString('base64')), 'owner-newdev');
after(() => { clearAccountKey(); return rm(ROOT, { recursive: true, force: true }); });

const OWNER = 'o';
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: createHash('sha1').update(buf).digest('hex').slice(0, 16) });
function storage(initial) {
  const store = new Map(Object.entries(initial)); const removed = [];
  const bucket = {
    async download(key) { const k = key.split('?')[0]; return store.has(k) ? { data: { arrayBuffer: async () => new Uint8Array(store.get(k)).buffer }, error: null } : { data: null, error: { message: 'Object not found', status: 404 } }; },
    async upload(key, blob) { store.set(key, Buffer.from(await blob.arrayBuffer())); return { error: null }; },
    async remove(keys) { removed.push(...keys); for (const k of keys) store.delete(k); return { error: null }; },
    async list() { return { data: [], error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, store, removed };
}

test('새 기기 복원 — 회사 폴더가 없어도 첫 동기화에서 원격 파일을 받는다', async () => {
  const WS = 'fresh1';
  const co = Buffer.from(JSON.stringify({ id: WS, name: '복원 회사', ownerId: OWNER }));
  const note = Buffer.from('# 노트\n');
  const f = storage({
    [`${OWNER}/${WS}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: { 'company.json': meta(co), 'vault/notes/a.md': meta(note) } })),
    [`${OWNER}/${WS}/company.json`]: co,
    [`${OWNER}/${WS}/vault/notes/a.md`]: note,
  });
  _setSyncClientForTest(f.client);
  await assert.rejects(stat(join(ROOT, WS)), '전제: 폴더가 없다');
  const r = await syncCompany(WS, OWNER, true);
  assert.equal(r.pulled, 2, '첫 사이클에 받는다(5분 뒤 다음 발견을 기다리지 않는다)');
  assert.equal(JSON.parse(await readFile(join(ROOT, WS, 'company.json'), 'utf8')).name, '복원 회사');
  assert.deepEqual(f.removed, []);
});

test('인접 핀 — 복원이 아닌 기존 회사는 폴더 목록을 못 읽으면 원격을 지우지 않는다(walk 실패 보류 유지)', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'POSIX 권한 비트 필요' }, async () => {
  const WS = 'existing1';
  const note = Buffer.from('# 기존\n');
  const f = storage({
    [`${OWNER}/${WS}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: { 'vault/notes/a.md': meta(note) } })),
    [`${OWNER}/${WS}/vault/notes/a.md`]: note,
  });
  _setSyncClientForTest(f.client);
  const { mkdir, writeFile, chmod } = await import('node:fs/promises');
  const dir = join(ROOT, WS);
  await mkdir(dir, { recursive: true });
  // base에는 a.md가 있고 로컬 목록은 읽을 수 없다(0300: 통과만) — 목록 부재를 "로컬 삭제"로 읽으면 원격을 지운다.
  await writeFile(join(dir, '.sync-state.json'), JSON.stringify({ files: { 'vault/notes/a.md': meta(note) }, ts: 1 }));
  await chmod(dir, 0o300);
  try {
    const r = await syncCompany(WS, OWNER, false);
    assert.deepEqual(f.removed, [], '원격 삭제 없음');
    assert.equal(r.deletedR, 0);
  } finally { await chmod(dir, 0o700); }
});
