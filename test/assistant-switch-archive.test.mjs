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

test('L3: 비서를 다른 회사로 옮겼다 되돌리면 알림 시각·내일 요약·조용한 시간·예외를 이어받는다(꺼진 파일의 inherit = 화면 초깃값) — 끌 때 company.json은 그대로(H63 유지)', async () => {
  _setSyncClientForTest(fakeStorage());
  await mkCompany('co-a'); await mkCompany('co-b');
  await S.saveAssistantSettings('co-a', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul', ...CUSTOM });
  const companyA = await readFile(W.paths('co-a').company, 'utf8');
  await S.saveAssistantSettings('co-b', { enabled: true, agent: 'wolff', tz: 'Asia/Seoul' });
  assert.equal(await readFile(W.paths('co-a').company, 'utf8'), companyA, '끌 때 company.json 그대로');
  const off = await readCfg('co-a');
  assert.deepEqual(Object.keys(off).sort(), ['agent', 'enabled', 'inherit'], '꺼짐·에이전트(방에서 복구용)·이어받을 값만 — 켠 시각·볼 것은 없다(봉인과 다시 맞춰질 수 없는 모양)');
  assert.deepEqual([off.enabled, off.agent, off.inherit], [false, 'pepper', { leadMinutes: 15, eveningAt: '20:00', quiet: CUSTOM.quiet, dailyCap: 10, tz: 'Asia/Seoul' }]);
  const v = await S.assistantSettingsView('co-a', { deps: viewDeps });
  assert.deepEqual([v.config.enabled, v.unsealed, v.config.leadMinutes, v.config.eveningAt, v.config.quiet], [false, false, 15, '20:00', CUSTOM.quiet], '꺼진 카드의 초깃값 = inherit');
  await S.saveAssistantSettings('co-a', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' }); // 화면에서 되돌림
  const back = await readCfg('co-a');
  assert.deepEqual([back.enabled, back.leadMinutes, back.eveningAt, back.morningAt, back.quiet, back.watch], [true, 15, '20:00', '07:00', CUSTOM.quiet, { calendar: true, mail: false, tasks: false, deals: false }], '이어받는다(기본 30분·21:00·23~08 아님), 볼 것은 처음처럼 일정만');
  assert.equal('inherit' in back, false, '다시 켠 파일에는 inherit를 남기지 않는다');
  assert.equal(JSON.parse(await readFile(W.paths('co-a').company, 'utf8')).assistantSeal, C.sealOf(await readFile(cfgFile('co-a'), 'utf8')), '다시 켠 내용으로 새 봉인');
  assert.equal((await readCfg('co-b')).enabled, false, '이번엔 co-b가 꺼진다');
  C._resetAssistantConfigCacheForTest();
  assert.equal((await C.loadEffectiveAssistantConfig('co-a'))?.enabled, true);
});

test('L3 보안 ①④: 옮겨서 꺼진 이전 회사 파일의 enabled만 true로 바꿔도(에이전트 파일 도구) 봉인이 안 맞아 엔진·화면 모두 꺼짐 — 지금 비서를 꺼도 이전 회사가 저절로 켜지지 않는다', async () => {
  _setSyncClientForTest(fakeStorage());
  await mkCompany('co-c'); await mkCompany('co-d');
  await S.saveAssistantSettings('co-c', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul', ...CUSTOM }, { now: Date.parse('2026-10-08T09:00:00+09:00') });
  await S.saveAssistantSettings('co-d', { enabled: true, agent: 'wolff', tz: 'Asia/Seoul' }, { now: Date.parse('2026-10-08T10:00:00+09:00') });
  await writeFile(cfgFile('co-c'), sealedText({ ...(await readCfg('co-c')), enabled: true })); // 한 글자 바꾸기
  C._resetAssistantConfigCacheForTest();
  assert.equal(await C.loadEffectiveAssistantConfig('co-c'), null, '① 엔진: 봉인이 안 맞는 켜짐 = 꺼짐');
  let v = await S.assistantSettingsView('co-c', { deps: viewDeps });
  assert.deepEqual([v.unsealed, v.config.enabled, v.current?.ws], [true, false, 'co-d'], '① 화면: "설정 화면 밖에서 바뀜", 지금 비서 = co-d');
  await S.saveAssistantSettings('co-d', { enabled: false }); // 사용자가 지금 비서를 끔
  C._resetAssistantConfigCacheForTest();
  const T = await import('../src/assistant/tick.mjs');
  T._resetAssistantForTest();
  const deps = { ...T.assistantDeps, lease: () => ({ syncOn: false }), companyIds: async () => ['co-c', 'co-d'], agentExists: async () => true, session: async () => { throw new Error('호출되면 안 된다'); } };
  assert.deepEqual(await T.runAssistantTick('co-c', { now: Date.parse('2026-10-08T11:00:00+09:00'), deps }), { ran: false, why: 'off' }, '④ 이전 회사 비서가 저절로 살아나지 않는다(호출 0)');
  v = await S.assistantSettingsView('co-c', { deps: viewDeps });
  assert.equal(v.current, null, '④ 화면: 지금 비서 없음');
});

test('L3 보안 ②③: inherit 칸을 고쳐도 엔진은 꺼짐·화면에서 켜기 전엔 효력 없음, 값 검증에 걸리면 통째로 기본값, 볼 것은 이어받지 않는다 / 0.1.99가 끈 파일(봉인 맞는 꺼짐)은 그대로 이어받는다', async () => {
  _setSyncClientForTest(fakeStorage());
  await mkCompany('co-e'); await mkCompany('co-f');
  await S.saveAssistantSettings('co-f', { enabled: true, agent: 'wolff', tz: 'Asia/Seoul', ...CUSTOM });
  await S.saveAssistantSettings('co-e', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' }); // co-f를 끈다
  const off = await readCfg('co-f');
  await writeFile(cfgFile('co-f'), sealedText({ ...off, watch: { calendar: true, mail: true }, inherit: { ...off.inherit, leadMinutes: 60, quiet: { from: '00:00', to: '00:00', calendarAlerts: true }, dailyCap: 99 } }));
  C._resetAssistantConfigCacheForTest();
  const cfgF = await C.loadEffectiveAssistantConfig('co-f');
  assert.equal(cfgF?.enabled, false, '② 엔진: 꺼짐(inherit는 엔진이 보지 않는다)');
  assert.equal((await S.assistantSettingsView('co-f', { deps: viewDeps })).current?.ws, 'co-e', '② 지금 비서는 그대로');
  assert.deepEqual((await S.assistantSettingsView('co-f', { deps: viewDeps })).config.quiet, { from: '23:00', to: '08:00', calendarAlerts: false }, '② 값 검증에 걸린 inherit(조용한 시간 없앰)는 초깃값으로도 안 쓴다');
  await S.saveAssistantSettings('co-f', { enabled: true, agent: 'wolff', tz: 'Asia/Seoul' }); // ③ 화면에서 켬
  const f = await readCfg('co-f');
  assert.deepEqual([f.leadMinutes, f.quiet.from, f.dailyCap, f.watch.mail], [30, '23:00', 10, false], '③ 검증에 걸린 inherit는 통째로 기본값, 볼 것은 일정만');
  // 0.1.99가 끈 파일 — 켠 시각을 지우고 꺼짐으로 다시 봉인(0.1.99 settings.mjs 그대로) → 봉인 맞는 파일이라 그대로 이어받는다
  await S.saveAssistantSettings('co-e', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul', ...CUSTOM });
  const { enabledAt: _drop, ...rest } = await readCfg('co-e');
  const text099 = sealedText({ ...rest, enabled: false });
  await writeFile(cfgFile('co-e'), text099); await W.updateCompany('co-e', () => ({ assistantSeal: C.sealOf(text099) }));
  await S.saveAssistantSettings('co-e', { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  assert.deepEqual([(await readCfg('co-e')).leadMinutes, (await readCfg('co-e')).quiet], [15, CUSTOM.quiet]);
});
