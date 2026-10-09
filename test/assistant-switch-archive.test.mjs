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

const cfgFile = (ws) => join(W.paths(ws).root, 'assistant.json');
const readCfg = async (ws) => JSON.parse(await readFile(cfgFile(ws), 'utf8'));
const sealedText = (obj) => `${JSON.stringify(obj, null, 2)}\n`; // 설정 API가 쓰는 모양(settings.mjs writeSealed)
const CUSTOM = { leadMinutes: 15, eveningAt: '20:00', quiet: { from: '22:00', to: '07:00', calendarAlerts: true } };

test('L3: 비서를 다른 회사로 옮겼다 되돌리면 알림 시각·내일 요약·조용한 시간·예외를 이어받는다(봉인된 꺼짐) — 끌 때 company.json은 그대로(H63 유지)', async () => {
  _setSyncClientForTest(fakeStorage());
  await mkCompany('co-a'); await mkCompany('co-b');
  await S.saveAssistantSettings('co-a', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul', ...CUSTOM });
  const companyA = await readFile(W.paths('co-a').company, 'utf8');
  const onBytes = await readFile(cfgFile('co-a'), 'utf8');
  await S.saveAssistantSettings('co-b', { enabled: true, agent: 'wolff', tz: 'Asia/Seoul' });
  assert.equal(await readFile(W.paths('co-a').company, 'utf8'), companyA, '끌 때 company.json 그대로');
  const off = await readCfg('co-a');
  assert.deepEqual(Object.keys(off), Object.keys(JSON.parse(onBytes)), '칸·순서 그대로(켠 시각도 남긴다) — enabled만 false');
  assert.equal(sealedText({ ...off, enabled: true }), onBytes, 'enabled만 되돌리면 봉인된 바이트와 같다');
  const v = await S.assistantSettingsView('co-a', { deps: viewDeps });
  assert.deepEqual([v.config.enabled, v.unsealed, v.config.leadMinutes, v.config.eveningAt, v.config.quiet], [false, false, 15, '20:00', CUSTOM.quiet], '꺼진 카드에도 저장한 값이 보인다');
  await S.saveAssistantSettings('co-a', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' }); // 되돌림
  const back = await readCfg('co-a');
  assert.deepEqual([back.enabled, back.leadMinutes, back.eveningAt, back.morningAt, back.quiet], [true, 15, '20:00', '07:00', CUSTOM.quiet], '이어받는다(기본 30분·21:00·23~08 아님)');
  assert.equal(JSON.parse(await readFile(W.paths('co-a').company, 'utf8')).assistantSeal, C.sealOf(await readFile(cfgFile('co-a'), 'utf8')), '다시 켠 내용으로 새 봉인');
  assert.equal((await readCfg('co-b')).enabled, false, '이번엔 co-b가 꺼진다');
  C._resetAssistantConfigCacheForTest();
  assert.equal((await C.loadEffectiveAssistantConfig('co-a'))?.enabled, true);
});

test('L3 안전: 꺼진 파일을 바이트 그대로 켜짐으로 되살려도(옛 기기 에이전트) 예전 봉인된 켜짐(예전 켠 시각)일 뿐 — 엔진·화면은 켠 시각이 늦은 지금 비서를 고른다', async () => {
  _setSyncClientForTest(fakeStorage());
  await mkCompany('co-c'); await mkCompany('co-d');
  await S.saveAssistantSettings('co-c', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul', ...CUSTOM }, { now: Date.parse('2026-10-08T09:00:00+09:00') });
  await S.saveAssistantSettings('co-d', { enabled: true, agent: 'wolff', tz: 'Asia/Seoul' }, { now: Date.parse('2026-10-08T10:00:00+09:00') });
  const off = await readCfg('co-c');
  await writeFile(cfgFile('co-c'), sealedText({ ...off, enabled: true })); // 봉인 그대로, 파일만 켜짐으로
  C._resetAssistantConfigCacheForTest();
  assert.equal((await C.loadEffectiveAssistantConfig('co-c'))?.enabled, true, '봉인이 맞는 예전 켜짐이다');
  const T = await import('../src/assistant/tick.mjs');
  T._resetAssistantForTest();
  const deps = { ...T.assistantDeps, lease: () => ({ syncOn: false }), companyIds: async () => ['co-c', 'co-d'], agentExists: async () => true, session: async () => { throw new Error('호출되면 안 된다'); } };
  assert.deepEqual(await T.runAssistantTick('co-c', { now: Date.parse('2026-10-08T11:00:00+09:00'), deps }), { ran: true, why: 'other_company' }, '켠 시각이 늦은 co-d가 맡는다 — co-c는 쉰다(호출 0)');
  assert.equal((await S.assistantSettingsView('co-c', { deps: viewDeps })).current?.ws, 'co-d');
});

test('L3 버전 섞임: 0.1.99가 끈 파일(켠 시각 지움 + 꺼짐으로 다시 봉인)도 다시 켜면 이어받는다 / 봉인과 무관하게 바뀐 꺼짐 파일은 기본값', async () => {
  _setSyncClientForTest(fakeStorage());
  await mkCompany('co-e'); await mkCompany('co-f');
  await S.saveAssistantSettings('co-e', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul', ...CUSTOM });
  const { enabledAt: _drop, ...rest } = await readCfg('co-e'); // 0.1.99 settings.mjs의 끄기 그대로
  const text099 = sealedText({ ...rest, enabled: false });
  await writeFile(cfgFile('co-e'), text099); await W.updateCompany('co-e', () => ({ assistantSeal: C.sealOf(text099) }));
  await S.saveAssistantSettings('co-e', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  assert.deepEqual([(await readCfg('co-e')).leadMinutes, (await readCfg('co-e')).quiet], [15, CUSTOM.quiet]);
  // 꺼진 파일을 에이전트가 고침(값을 바꿈) — enabled를 되돌려도 봉인과 맞지 않는다 → 이어받지 않는다
  await S.saveAssistantSettings('co-f', { enabled: true, agent: 'wolff', tz: 'Asia/Seoul', ...CUSTOM });
  await S.saveAssistantSettings('co-e', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' }); // co-f를 끈다(봉인된 꺼짐)
  await writeFile(cfgFile('co-f'), sealedText({ ...(await readCfg('co-f')), quiet: { from: '00:00', to: '00:00', calendarAlerts: true }, watch: { calendar: true, mail: true } }));
  await S.saveAssistantSettings('co-f', { enabled: true, agent: 'wolff', tz: 'Asia/Seoul' });
  const f = await readCfg('co-f');
  assert.deepEqual([f.leadMinutes, f.quiet.from, f.watch.mail], [30, '23:00', false], '고친 꺼짐은 기본값에서 새로 봉인(A9와 같은 길)');
});
