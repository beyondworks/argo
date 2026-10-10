// 하트비트 관리 → 루틴 화면(유건 10/10) — 서버 쪽: 확인 주기(intervalMinutes) 저장·검증·봉인, 기존 설정(주기 없음) = 15분, 엔진이 설정 주기를 따름,
// 일시 정지·다시 켜기, 설정 지우기(DELETE), 일시 정지 중 담당만 바꾸기, 일정 보기 끄기, 옛 버전(0.1.100) 기기와 섞임.
// 경우 표(PR 본문) C1~C18. 라우트는 인증 꺼짐(로컬 모드)으로 실제 호출하고, 파일은 임시 ARGO_ROOT의 실제 파일이다.
// 엔진 칸은 1단계 테스트와 같은 가짜 서버로 실제 틱을 돌려 일정 읽기 횟수(office_event_list)를 센다. 운영 DB·실제 계정·상주 :3001을 쓰지 않는다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-hb-routine-'));
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGO_SYNC']) delete process.env[k];
const { register } = await import('node:module');
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));

const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const C = await import('../src/assistant/config.mjs');
const T = await import('../src/assistant/tick.mjs');
const route = await import('../app/api/companies/[ws]/assistant/route.js');
const V = await import('../app/c/[ws]/crew/[slug]/assistant-view.mjs');

const cfgPath = (ws) => join(paths(ws).root, 'assistant.json');
const raw = async (ws) => readFile(cfgPath(ws), 'utf8');
const cfgOf = async (ws) => JSON.parse(await raw(ws));
const companyText = async (ws) => readFile(paths(ws).company, 'utf8');
const company = async (ws) => JSON.parse(await companyText(ws));

let seq = 0;
let owner = 'u0';
async function mkCompany({ ownerId = owner, name = '하트비트 회사', agents = ['pepper', 'wolff'] } = {}) {
  const ws = `hb-${++seq}`;
  await createCompany(ws, name, 'owner', ownerId, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  for (const a of agents) await writeFile(join(paths(ws).agents, `${a}.md`), `---\nname: ${a === 'pepper' ? '페퍼' : a === 'wolff' ? '울프' : a}\n---\n\n일한다.\n`);
  return ws;
}
const call = async (method, ws, body, headers = {}) => {
  const req = new Request(`http://localhost/api/companies/${ws}/assistant`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const res = await route[method](req, { params: Promise.resolve({ ws }) });
  return { status: res.status, data: await res.json() };
};
const put = (ws, body, headers) => call('PUT', ws, body, headers);
const get = (ws) => call('GET', ws);
const del = (ws, headers) => call('DELETE', ws, undefined, headers);

/* 엔진 — 1단계 테스트와 같은 가짜 서버(일정 읽기만 센다) */
const at = (hm) => Date.parse(`2026-10-08T${hm}:00+09:00`);
function fakeServer({ fail = false } = {}) {
  const env = { calls: [] };
  env.session = {
    uid: owner,
    client: { async rpc(name) {
      env.calls.push(name);
      if (name === 'office_event_list') return fail ? { data: null, error: { message: 'boom' } } : { data: { events: [], orgs: [] }, error: null };
      return { data: null, error: { message: name } };
    } },
    db: {
      async personalCrewsOf() { env.calls.push('personalCrewsOf'); return []; },
      async personalRoomsOf() { return []; },
      async assistantNotices() { return []; },
    },
  };
  return env;
}
const engineDeps = (env, ids) => ({ ...T.assistantDeps, lease: () => ({ syncOn: false }), session: async () => env.session, agentExists: async () => true, companyIds: async () => ids, writeState: async () => {} });
async function reads(ws, env, ids, from, to) {
  for (let t = from; t <= to; t += 60_000) await T.runAssistantTick(ws, { now: t, deps: engineDeps(env, ids) });
  return env.calls.filter((c) => c === 'office_event_list').length;
}

let ownerSeq = 0;
beforeEach(() => { owner = `hb-u${++ownerSeq}`; T._resetAssistantForTest(); C._resetAssistantConfigCacheForTest(); });

test('C1: 기존 켜진 설정(주기 칸 없음 — 0.1.100 이하가 저장) = 15분: 봉인 그대로 켜짐, 보기 15, 엔진은 15분마다 일정을 읽고 파일을 다시 쓰지 않는다', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  // 0.1.100 저장 모양 — 주기 칸 없음. 설정 API처럼 봉인해서 쓴다
  const old = await cfgOf(ws); delete old.intervalMinutes;
  const text = `${JSON.stringify(old, null, 2)}\n`;
  await writeFile(cfgPath(ws), text);
  await updateCompany(ws, () => ({ assistantSeal: C.sealOf(text) }));
  C._resetAssistantConfigCacheForTest();
  const eff = await C.loadEffectiveAssistantConfig(ws);
  assert.deepEqual([eff?.enabled, eff?.intervalMinutes, C.readIntervalMs(eff)], [true, 15, 15 * 60_000], '켜짐 그대로·15분');
  const v = (await get(ws)).data;
  assert.deepEqual([v.config.intervalMinutes, v.current?.ws, v.unsealed], [15, ws, false]);
  assert.deepEqual(v.choices.interval, [10, 15, 30, 60]);
  const env = fakeServer();
  assert.equal(await reads(ws, env, [ws], at('13:00'), at('13:45')), 4, '13:00·13:15·13:30·13:45 — 15분마다(지금과 같은 동작)');
  assert.equal(await raw(ws), text, '엔진·보기는 설정 파일을 다시 쓰지 않는다');
});

test('C2: 주기 30 저장 — 파일 intervalMinutes 30 + 봉인 = 새 바이트, 켬·에이전트·켠 시각 그대로, 엔진은 30분마다 읽는다(다음 틱부터)', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  const before = await cfgOf(ws);
  assert.equal(before.intervalMinutes, 15, '처음 켜면 기본 15분을 적는다');
  const { status, data } = await put(ws, { intervalMinutes: 30 });
  assert.equal(status, 200, JSON.stringify(data));
  const c = await cfgOf(ws);
  assert.deepEqual([c.intervalMinutes, c.enabled, c.agent, c.enabledAt], [30, true, 'pepper', before.enabledAt]);
  assert.equal((await company(ws)).assistantSeal, C.sealOf(await raw(ws)), '봉인 = 파일 바이트');
  assert.equal(data.config.intervalMinutes, 30);
  const env = fakeServer();
  assert.equal(await reads(ws, env, [ws], at('13:00'), at('13:59')), 2, '13:00·13:30');
  for (const n of [10, 60]) {
    await put(ws, { intervalMinutes: n });
    T._resetAssistantForTest();
    const e2 = fakeServer();
    assert.equal(await reads(ws, e2, [ws], at('14:00'), at('14:59')), 60 / n, `${n}분마다`);
  }
});

test('C3: 잘못된 주기 — 5·20·0·"30x"·null·문자 → 400 assistant_interval_invalid, 파일·봉인 그대로', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  const text = await raw(ws); const seal = (await company(ws)).assistantSeal;
  for (const bad of [5, 20, 0, '30x', null, 'fast', 9.5]) {
    const { status, data } = await put(ws, { intervalMinutes: bad });
    assert.equal(status, 400, String(bad));
    assert.equal(data.errorCode, 'assistant_interval_invalid', String(bad));
  }
  assert.equal(await raw(ws), text);
  assert.equal((await company(ws)).assistantSeal, seal);
  assert.equal((await put(ws, { intervalMinutes: '30' })).status, 200, '숫자 문자열은 받는다(화면 select 값)');
});

test('C4·C5: 옛 버전과 섞임 — 옛 화면처럼 주기 칸 없이 다른 칸만 저장해도 주기 30 유지, 새 버전의 모르는 주기(45)는 켜짐 그대로·엔진 15분·다른 칸 저장에도 유지', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  await put(ws, { intervalMinutes: 30 });
  await put(ws, { leadMinutes: 15 }); // 0.1.100 화면의 저장 모양(주기 칸을 모른다)
  assert.deepEqual([(await cfgOf(ws)).intervalMinutes, (await cfgOf(ws)).leadMinutes], [30, 15]);
  // 앞으로의 버전이 고를 수 있는 값(45) — 이 버전은 모르는 값. 봉인은 바이트라 켜짐은 그대로이고 엔진은 기본 15분으로 돈다
  const cur = await cfgOf(ws); cur.intervalMinutes = 45;
  const text = `${JSON.stringify(cur, null, 2)}\n`;
  await writeFile(cfgPath(ws), text);
  await updateCompany(ws, () => ({ assistantSeal: C.sealOf(text) }));
  C._resetAssistantConfigCacheForTest();
  const eff = await C.loadEffectiveAssistantConfig(ws);
  assert.deepEqual([eff?.enabled, C.readIntervalMs(eff)], [true, 15 * 60_000]);
  assert.equal((await put(ws, { eveningAt: '20:00' })).status, 200, '모르는 값이 있어도 다른 칸 저장은 막히지 않는다');
  assert.equal((await cfgOf(ws)).intervalMinutes, 45, '이 버전이 모르는 값을 기본값으로 덮지 않는다');
  assert.equal((await get(ws)).data.config.intervalMinutes, 15, '보기는 엔진과 같은 값(15)');
});

test('C6·C8: 일시 정지(스위치 끄기) → 다시 켜기 — 설정(주기·알림 시각) 그대로, 보기 상태 paused → on', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul', intervalMinutes: 60, leadMinutes: 10 });
  const off = (await put(ws, { enabled: false })).data;
  assert.equal(V.heartbeatState(off, ws), 'paused');
  assert.deepEqual([off.config.agent, off.config.agentName, off.config.intervalMinutes, off.config.leadMinutes], ['pepper', '페퍼', 60, 10]);
  assert.equal(await C.loadEffectiveAssistantConfig(ws).then((c) => c?.enabled), false);
  const env = fakeServer();
  assert.equal(await reads(ws, env, [ws], at('13:00'), at('13:10')), 0, '꺼 둔 동안 호출 0');
  const on = (await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' })).data;
  assert.equal(V.heartbeatState(on, ws), 'on');
  assert.deepEqual([on.config.intervalMinutes, on.config.leadMinutes], [60, 10], '다시 켜면 그 설정으로');
});

test('C7: 설정 지우기(DELETE) — offFile({enabled:false, agent}) + 봉인 비움(지우기 전 켜짐 바이트를 되돌려 써도 꺼짐), 보기 none, 엔진 호출 0, 다시 켜면 기본값부터. 없을 때·이미 지웠을 때는 쓰기 0', async () => {
  const ws = await mkCompany();
  const none = await mkCompany();
  assert.equal((await del(none)).status, 200);
  assert.equal(existsSync(cfgPath(none)), false, '파일이 없으면 만들지 않는다');
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul', intervalMinutes: 30, leadMinutes: 10, mail: true });
  const onBytes = await raw(ws);
  const { status, data } = await del(ws);
  assert.equal(status, 200, JSON.stringify(data));
  assert.deepEqual(await cfgOf(ws), { enabled: false, agent: 'pepper' }, '꺼짐과 에이전트만(방에서 복구용) — 이어받을 값 없음');
  assert.equal((await company(ws)).assistantSeal, null, '봉인을 비운다(분리 검수 M1)');
  assert.deepEqual([V.heartbeatState(data, ws), data.config.agent, data.unsealed, data.current], ['none', null, false, null]);
  const text = await raw(ws); const coText = await companyText(ws);
  assert.equal((await del(ws)).status, 200);
  assert.deepEqual([await raw(ws), await companyText(ws)], [text, coText], '이미 지운 모양이면 다시 쓰지 않는다(파일 2개 모두)');
  // 지우기 전 켜짐 바이트를 그대로 되돌려 써도(옛 버전 기기의 에이전트) 봉인이 비어 꺼짐 — 메일도 읽지 않는다
  await writeFile(cfgPath(ws), onBytes);
  C._resetAssistantConfigCacheForTest();
  assert.equal(await C.loadEffectiveAssistantConfig(ws), null, '되돌린 켜짐 파일도 꺼짐');
  assert.equal((await get(ws)).data.current, null);
  await writeFile(cfgPath(ws), text);
  const env = fakeServer();
  assert.equal(await reads(ws, env, [ws], at('13:00'), at('13:10')), 0);
  // 지운 파일의 enabled만 true로 바꿔도(옛 기기 에이전트) 봉인과 맞지 않아 꺼짐
  await writeFile(cfgPath(ws), JSON.stringify({ enabled: true, agent: 'pepper' }));
  C._resetAssistantConfigCacheForTest();
  assert.equal(await C.loadEffectiveAssistantConfig(ws), null);
  const again = (await put(ws, { enabled: true, agent: 'wolff', tz: 'Asia/Seoul' })).data;
  assert.deepEqual([again.config.agent, again.config.intervalMinutes, again.config.leadMinutes], ['wolff', 15, 30], '다시 켜면 기본값부터');
  // CSRF — 다른 사이트에서 온 지우기는 막는다
  const before = await raw(ws);
  assert.notEqual((await del(ws, { 'sec-fetch-site': 'cross-site' })).status, 200);
  assert.equal(await raw(ws), before);
});

test('C10: 일시 정지 중 담당만 바꾸기(PUT {agent}) — 에이전트만 바뀌고 꺼진 채, 다른 회사 하트비트는 그대로. 없는 에이전트는 400', async () => {
  const a = await mkCompany({ name: '회사 A' });
  const b = await mkCompany({ name: '회사 B' });
  await put(b, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  await put(a, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' }); // A가 맡고 B는 꺼짐
  await put(a, { enabled: false });
  await put(b, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' }); // 다시 B가 맡음 — A는 꺼 둔 채(봉인)
  const bText = await raw(b);
  const { status, data } = await put(a, { agent: 'wolff' });
  assert.equal(status, 200, JSON.stringify(data));
  const c = await cfgOf(a);
  assert.deepEqual([c.enabled, c.agent], [false, 'wolff']);
  assert.equal(await raw(b), bText, '켜지 않으니 다른 회사를 끄지 않는다');
  assert.deepEqual([V.heartbeatState(data, a), data.current?.ws, data.config.agentName], ['other', b, '울프']);
  const bad = await put(a, { agent: 'nobody' });
  assert.deepEqual([bad.status, bad.data.errorCode], [400, 'assistant_agent_not_found']);
  assert.equal((await put(a, { agent: '../x' })).data.errorCode, 'assistant_agent_not_found');
});

test('C9b: 일정 보기 끄기(calendar:false) — watch.calendar false, 메일도 안 보면 엔진은 쉰다(일정 읽기 0). 잘못된 값은 400', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  const { data } = await put(ws, { calendar: false });
  assert.equal((await cfgOf(ws)).watch.calendar, false);
  assert.equal(data.config.calendar, false);
  const env = fakeServer();
  assert.equal(await reads(ws, env, [ws], at('13:00'), at('13:10')), 0, '볼 것이 없으면 호출 0(idle)');
  assert.equal((await put(ws, { calendar: 'no' })).data.errorCode, 'assistant_bad_request');
  await put(ws, { calendar: true });
  assert.equal((await cfgOf(ws)).watch.calendar, true);
  // 처음 켤 때 메일을 고르면(사용자 선택) 메일 알림으로
  const ws2 = await mkCompany();
  await put(ws2, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul', mail: true, calendar: true });
  assert.deepEqual((await cfgOf(ws2)).watch, { calendar: true, mail: true, tasks: false, deals: false });
});

test('C16: 일정 읽기 실패 뒤 쉼 = 확인 주기와 15분 중 짧은 쪽 — 30분이면 15분 뒤, 10분이면 10분 뒤 다시', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul', intervalMinutes: 30 });
  const env = fakeServer({ fail: true });
  assert.equal(await reads(ws, env, [ws], at('13:00'), at('13:14')), 1, '13:00 실패 뒤 13:14까지 0');
  assert.equal(await reads(ws, env, [ws], at('13:15'), at('13:16')), 2, '13:15에 다시(60분 주기여도 실패는 15분 뒤 — 새 일정을 오래 놓치지 않게)');
  await put(ws, { intervalMinutes: 10 });
  T._resetAssistantForTest();
  const e2 = fakeServer({ fail: true });
  assert.equal(await reads(ws, e2, [ws], at('14:00'), at('14:09')), 1, '10분 주기 — 실패 뒤 10분 안 0');
  assert.equal(await reads(ws, e2, [ws], at('14:10'), at('14:10')), 2, '14:10에 다시');
});

test('C12(화면 판정): heartbeatState·statusNotes(회사 기준) — on / other / paused / none', () => {
  const view = (o = {}) => ({ config: { enabled: false, agent: null }, current: null, status: { login: true, runner: 'this_device' }, ...o });
  assert.equal(V.heartbeatState(view(), 'a'), 'none');
  assert.equal(V.heartbeatState(view({ config: { enabled: false, agent: 'p' } }), 'a'), 'paused');
  assert.equal(V.heartbeatState(view({ current: { ws: 'a' } }), 'a'), 'on');
  assert.equal(V.heartbeatState(view({ current: { ws: 'b' }, config: { enabled: false, agent: 'p' } }), 'a'), 'other');
  assert.deepEqual(V.statusNotes(view({ config: { enabled: true, agent: 'p' }, current: { ws: 'b' } }), 'a'), ['other_company'], '이 회사 켜짐인데 다른 회사가 맡음');
  assert.deepEqual(V.statusNotes(view({ current: { ws: 'a' }, status: { login: false, runner: 'no_runner' } }), 'a'), ['login_required']);
  assert.deepEqual(V.numChoices([10, 15, 30, 60], 45), [10, 15, 30, 45, 60], '목록 밖 저장값도 선택지에');
});
