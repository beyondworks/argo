// H63(#865 3차 검수 R7) — 비서를 다른 회사로 바꿀 때 이전 회사의 company.json을 다시 쓰면, 다른 기기에서 방금 보관한 그 회사가
// 동기화의 보관 마커 규칙(sync.mjs syncTombstones 3단계: company.json 수정 시각 ≥ 보관 시각이면 "보관 이후 수정" → 마커 철회)에 걸려 되살아났다.
// 실제 설정 저장(src/assistant/settings.mjs)과 실제 보관 마커 동기화(가짜 저장소)를 이어서 돌린다 — company-restore-sync.test.mjs와 같은 하네스.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-asst-archive-'));
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://selfhost.local'; // 서비스 모드(셀프호스트) — company-restore-sync.test.mjs와 같은 하네스
process.env.SUPABASE_SERVICE_ROLE_KEY = 'selfhost-service-key-not-real';
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; delete process.env.ARGO_TENANT_OWNER; delete process.env.ARGO_SYNC;
const W = await import('../src/workspace.mjs');
const { _setSyncClientForTest, _tombstonesForTest } = await import('../src/sync.mjs');
const S = await import('../src/assistant/settings.mjs');
const C = await import('../src/assistant/config.mjs');
const OWNER = 'o';
function fakeStorage() {
  const store = new Map();
  const bucket = {
    async download(key) { return store.has(key) ? { data: { arrayBuffer: async () => new Uint8Array(store.get(key)).buffer }, error: null } : { data: null, error: { message: 'Object not found', status: 404 } }; },
    async upload(key, blob) { store.set(key, Buffer.from(await blob.arrayBuffer())); return { error: null }; },
    async remove(keys) { for (const k of keys) store.delete(k); return { error: null }; },
    async list(prefix) { const p = prefix.endsWith('/') ? prefix : `${prefix}/`; return { data: [...store.keys()].filter((k) => k.startsWith(p) && !k.slice(p.length).includes('/')).map((k) => ({ name: k.slice(p.length), id: 'f' })) }; },
  };
  return { store, storage: { from: () => bucket }, createBucket: async () => ({}) };
}
async function mkCompany(ws) {
  await W.createCompany(ws, ws, 'owner', OWNER, 'ko');
  await mkdir(W.paths(ws).agents, { recursive: true });
  for (const a of ['pepper', 'wolff']) await writeFile(join(W.paths(ws).agents, `${a}.md`), `---\nname: ${a}\n---\n\n일한다.\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const viewDeps = { lease: () => ({ syncOn: false }), deviceSession: () => null, sessionDead: () => false, deviceId: async () => 'dev' };

test('H63: 다른 기기에서 보관한 회사 — 보관 마커가 오기 전(최대 300초)에 이 기기에서 비서를 다른 회사로 바꿔도, 동기화 뒤 보관이 유지된다', async () => {
  const fake = fakeStorage(); _setSyncClientForTest(fake);
  await mkCompany('co-old'); await mkCompany('co-new');
  await S.saveAssistantSettings('co-old', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul', leadMinutes: 15 });
  const companyBefore = await readFile(W.paths('co-old').company, 'utf8');
  const mtimeBefore = (await stat(W.paths('co-old').company)).mtimeMs;
  await sleep(30);
  // 다른 기기가 co-old를 보관해 원격 보관 마커를 올렸다 — 이 기기는 다음 원격 목록 조회(300초 주기)까지 모른다
  fake.store.set(`${OWNER}/.tombstones/co-old.json`, Buffer.from(JSON.stringify({ wsId: 'co-old', at: Date.now() })));
  await sleep(30);
  await S.saveAssistantSettings('co-new', { enabled: true, agent: 'wolff', tz: 'Asia/Seoul' }); // 이 기기에서 비서를 바꿈
  const off = JSON.parse(await readFile(join(W.paths('co-old').root, 'assistant.json'), 'utf8')).enabled;
  const companyAfter = await readFile(W.paths('co-old').company, 'utf8');
  const mtimeAfter = (await stat(W.paths('co-old').company)).mtimeMs;
  C._resetAssistantConfigCacheForTest();
  const engineCfg = await C.loadEffectiveAssistantConfig('co-old');
  const v = await S.assistantSettingsView('co-old', { deps: viewDeps });
  // 동기화가 원격 보관 마커를 읽는다 — 사용자에게 보이는 결과(보관 유지)를 먼저 단언한다
  await _tombstonesForTest.syncTombstones(OWNER);
  assert.equal(existsSync(W.paths('co-old').company), false, '보관이 유지된다(되살아나지 않는다)');
  assert.ok(fake.store.has(`${OWNER}/.tombstones/co-old.json`), '원격 보관 마커를 철회하지 않는다');
  // 왜 유지되나 — 이전 회사의 비서는 꺼지되 company.json은 그대로(봉인을 다시 쓰지 않는다)
  assert.equal(off, false, '이전 비서는 꺼진다');
  assert.equal(companyAfter, companyBefore, 'company.json 내용 그대로');
  assert.equal(mtimeAfter, mtimeBefore, 'company.json 수정 시각 그대로');
  assert.equal(engineCfg?.enabled, false, '엔진도 꺼짐으로 읽는다(꺼진 설정은 봉인을 보지 않는다 — 0.1.99 엔진도 같다)');
  assert.deepEqual([v.config.enabled, v.unsealed, v.current?.ws], [false, false, 'co-new'], '이전 회사 카드: 꺼짐, "화면 밖에서 바뀜" 아님, 지금 비서 = 새 회사');
});

test('H63 뒤 바뀐 점: 꺼진 회사를 다시 켜면 그 회사의 예전 설정값은 이어받지 않고 기본값에서 새로 봉인한다(봉인 안 맞는 파일 — A9와 같은 길)', async () => {
  _setSyncClientForTest(fakeStorage());
  await mkCompany('co-a'); await mkCompany('co-b');
  await S.saveAssistantSettings('co-a', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul', leadMinutes: 15 });
  await S.saveAssistantSettings('co-b', { enabled: true, agent: 'wolff', tz: 'Asia/Seoul' });
  await S.saveAssistantSettings('co-a', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  const text = await readFile(join(W.paths('co-a').root, 'assistant.json'), 'utf8');
  assert.equal(JSON.parse(text).leadMinutes, 30, '15분이 아니라 기본 30분');
  assert.equal(JSON.parse(await readFile(W.paths('co-a').company, 'utf8')).assistantSeal, C.sealOf(text), '다시 켠 내용으로 봉인');
  C._resetAssistantConfigCacheForTest();
  assert.equal((await C.loadEffectiveAssistantConfig('co-a'))?.enabled, true);
  assert.equal(JSON.parse(await readFile(join(W.paths('co-b').root, 'assistant.json'), 'utf8')).enabled, false, '이번엔 co-b가 꺼진다');
});
