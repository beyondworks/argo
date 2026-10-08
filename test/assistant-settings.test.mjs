// 능동 비서 2단계 — 설정 API(app/api/companies/[ws]/assistant)·설정 쓰기(src/assistant/settings.mjs)·봉인(config.mjs loadEffectiveAssistantConfig).
// 경우 표(PR 본문): A1~A12, V3, D7, S2(상태 판정의 서버 쪽). 라우트는 인증 꺼짐(로컬 모드)으로 실제 호출하고, 파일은 임시 ARGO_ROOT의 실제 파일이다.
// 엔진 칸(A7·A8·V3)은 1단계 테스트와 같은 가짜 서버로 실제 틱을 돌려 "호출 0"까지 본다. 운영 DB·실제 계정·상주 :3001을 쓰지 않는다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-asst-set-'));
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGO_SYNC']) delete process.env[k];
const { register } = await import('node:module');
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));

const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const C = await import('../src/assistant/config.mjs');
const S = await import('../src/assistant/settings.mjs');
const T = await import('../src/assistant/tick.mjs');
const { stateFile } = await import('../src/assistant/state.mjs');
const route = await import('../app/api/companies/[ws]/assistant/route.js');
const V = await import('../app/c/[ws]/crew/[slug]/assistant-view.mjs');

const NOW = Date.parse('2026-10-08T13:00:00+09:00');
const cfgPath = (ws) => join(paths(ws).root, 'assistant.json');
const raw = async (ws) => readFile(cfgPath(ws), 'utf8');
const cfgOf = async (ws) => JSON.parse(await raw(ws));
const company = async (ws) => JSON.parse(await readFile(paths(ws).company, 'utf8'));

let seq = 0;
let owner = 'u0'; // 테스트마다 새 주인 — 같은 ARGO_ROOT의 다른 테스트 회사가 "같은 사용자의 다른 회사"로 섞이지 않게(beforeEach)
/** 회사 — 주인 ownerId(기본 = 이 테스트의 주인), 에이전트 카드 agents(이름 표시용). */
async function mkCompany({ ownerId = owner, name = '비서 회사', agents = ['pepper', 'wolff'] } = {}) {
  const ws = `set-${++seq}`;
  await createCompany(ws, name, 'owner', ownerId, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  for (const a of agents) await writeFile(join(paths(ws).agents, `${a}.md`), `---\nname: ${a === 'pepper' ? '페퍼' : a === 'wolff' ? '울프' : a}\n---\n\n일한다.\n`);
  return ws;
}
const call = async (method, ws, body, headers = {}) => {
  const req = new Request(`http://localhost/api/companies/${ws}/assistant`, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const res = await (method === 'GET' ? route.GET(req, { params: Promise.resolve({ ws }) }) : route.PUT(req, { params: Promise.resolve({ ws }) }));
  return { status: res.status, data: await res.json() };
};
const put = (ws, body, headers) => call('PUT', ws, body, headers);
const get = (ws) => call('GET', ws);
/** 옛 버전 기기의 에이전트처럼 쓰기 — 파일만 쓰고 봉인은 건드리지 않는다(옛 권한 게이트는 assistant.json을 막지 않았다). */
const agentWrites = (ws, obj) => writeFile(cfgPath(ws), JSON.stringify(obj));

/* 엔진 — 1단계 테스트(assistant-engine.test.mjs)와 같은 가짜 서버(필요한 만큼만) */
const iso = (ms) => new Date(ms).toISOString();
const at = (hm) => Date.parse(`2026-10-08T${hm}:00+09:00`);
function fakeServer(events) {
  const env = { calls: [], inserts: [] };
  env.session = {
    uid: owner,
    client: { async rpc(name, args) {
      env.calls.push(name);
      if (name === 'office_event_list') return { data: { events: events.filter((e) => Date.parse(e.starts_at) < Date.parse(args.p_to) && Date.parse(e.ends_at) > Date.parse(args.p_from)), orgs: [] }, error: null };
      if (name === 'msgr_dm_personal_crew') return { data: `room-${args.crew}`, error: null };
      return { data: null, error: { message: name } };
    } },
    db: {
      async myCrews() { env.calls.push('myCrews'); return [{ id: 'crew-p', org_id: null, slug: 'pepper' }]; },
      async insertMessage(row) { env.calls.push('insertMessage'); env.inserts.push(row); return { id: `m${env.inserts.length}` }; },
    },
  };
  return env;
}
const ev = (id, start) => ({ id, org_id: null, owner, title: `일정 ${id}`, location: '', all_day: false, starts_at: iso(start), ends_at: iso(start + 3600_000), rrule: null, exdates: [], attendees: [] });
const engineDeps = (env, ids) => ({ ...T.assistantDeps, lease: () => ({ syncOn: false }), session: async () => env.session, agentExists: async () => true, companyIds: async () => ids });
async function tickRange(ws, env, ids, from, to) {
  const out = [];
  for (let t = from; t <= to; t += 60_000) out.push(await T.runAssistantTick(ws, { now: t, deps: engineDeps(env, ids) }));
  return out;
}

let ownerSeq = 0;
beforeEach(() => { owner = `u${++ownerSeq}`; T._resetAssistantForTest(); C._resetAssistantConfigCacheForTest(); });

/* ── 켜기·끄기·바꾸기 ── */

test('A1: 처음 켜기 — assistant.json(켬·에이전트·켠 시각·일정만 보기·아침=조용한 시간 끝) + company.json 봉인 = 파일 바이트 sha256, 엔진이 켜진 설정으로 읽는다', async () => {
  const ws = await mkCompany();
  const { status, data } = await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  assert.equal(status, 200, JSON.stringify(data));
  const c = await cfgOf(ws);
  assert.equal(c.enabled, true);
  assert.equal(c.agent, 'pepper');
  assert.ok(Date.parse(c.enabledAt) > 0, '켠 시각');
  assert.deepEqual(c.watch, { calendar: true, mail: false, tasks: false, deals: false }, '처음 켜면 일정만 — 메일·할 일·거래는 사용자가 따로 켜기 전에는 읽지 않는다');
  assert.equal(c.morningAt, c.quiet.to, '아침 정리 = 조용한 시간 끝');
  assert.deepEqual([c.leadMinutes, c.eveningAt, c.quiet.from, c.quiet.to, c.quiet.calendarAlerts, c.dailyCap, c.tz], [30, '21:00', '23:00', '08:00', false, 10, 'Asia/Seoul'], '설계 3절 기본값');
  assert.equal((await company(ws)).assistantSeal, C.sealOf(await raw(ws)), '봉인 = 파일 내용의 sha256');
  const eff = await C.loadEffectiveAssistantConfig(ws);
  assert.equal(eff?.enabled, true, '엔진이 켜진 것으로 읽는다');
  assert.deepEqual([data.current?.ws, data.current?.agent, data.current?.name, data.current?.company], [ws, 'pepper', '페퍼', '비서 회사'], '보기: 지금 비서');
  assert.equal(data.unsealed, false);
});

test('A2: 끄기 — 꺼짐·켠 시각 지움·봉인 갱신. 끈 뒤 옛 켜진 내용을 그대로 되돌려 써도(옛 기기 에이전트) 엔진은 꺼짐·호출 0', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  const onText = await raw(ws);
  const { status, data } = await put(ws, { enabled: false });
  assert.equal(status, 200);
  const c = await cfgOf(ws);
  assert.deepEqual([c.enabled, c.agent, 'enabledAt' in c], [false, 'pepper', false]);
  assert.equal((await company(ws)).assistantSeal, C.sealOf(await raw(ws)), '끈 내용으로 다시 봉인');
  assert.equal(data.current, null);
  await writeFile(cfgPath(ws), onText); // 옛 기기의 에이전트가 끄기 전 파일을 그대로 되돌림
  C._resetAssistantConfigCacheForTest();
  assert.equal(await C.loadEffectiveAssistantConfig(ws), null);
  const env = fakeServer([ev('e1', at('13:40'))]);
  const out = await tickRange(ws, env, [ws], at('13:05'), at('13:12'));
  assert.ok(out.every((r) => r.why === 'off'), JSON.stringify(out));
  assert.equal(env.calls.length, 0, '호출 0');
  assert.equal((await get(ws)).data.unsealed, true, '설정 화면: 설정 화면 밖에서 바뀜');
});

test('A3: 사용자당 1명 — 다른 회사(같은 주인)에서 켜면 이전 비서는 꺼지고(봉인 갱신) 다른 주인의 비서는 그대로', async () => {
  const a = await mkCompany({ name: '회사 A' });
  const b = await mkCompany({ name: '회사 B' });
  const other = await mkCompany({ ownerId: `${owner}-other`, name: '남의 회사' });
  await put(a, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  await put(other, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  assert.equal((await get(b)).data.current?.ws, a, '바꾸기 전: 지금 비서 = 회사 A');
  const { status, data } = await put(b, { enabled: true, agent: 'wolff', tz: 'Asia/Seoul' });
  assert.equal(status, 200);
  assert.deepEqual([data.current?.ws, data.current?.agent, data.current?.name], [b, 'wolff', '울프']);
  const ca = await cfgOf(a);
  assert.equal(ca.enabled, false, '이전 비서는 꺼진다');
  assert.equal(ca.agent, 'pepper', '에이전트는 적어 둔다');
  assert.equal((await company(a)).assistantSeal, C.sealOf(await raw(a)), '꺼진 내용으로 봉인 — 꺼짐이 화면 밖 변경으로 보이지 않는다');
  assert.equal((await get(a)).data.unsealed, false);
  assert.equal((await cfgOf(other)).enabled, true, '다른 주인의 회사는 손대지 않는다');
});

test('A4: 같은 회사의 다른 에이전트로 바꾸기 — 에이전트·켠 시각이 바뀐다, 켜기를 다시 눌러도 켠 시각은 지금으로', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  const before = await cfgOf(ws);
  await new Promise((r) => setTimeout(r, 5));
  await put(ws, { enabled: true, agent: 'wolff' });
  const after = await cfgOf(ws);
  assert.equal(after.agent, 'wolff');
  assert.ok(Date.parse(after.enabledAt) > Date.parse(before.enabledAt), '새 비서 = 새로 켠 시각');
  await new Promise((r) => setTimeout(r, 5));
  await put(ws, { enabled: true, agent: 'wolff' });
  assert.ok(Date.parse((await cfgOf(ws)).enabledAt) > Date.parse(after.enabledAt), '켜기·바꾸기는 마지막 선택 — 이미 켜져 있어도 켠 시각을 지금으로(다른 기기에서 켠 비서보다 이 선택이 맡게)');
});

test('A5: 값 바꾸기(켠 상태) — 알림 10분·저녁 20:00·조용한 시간 22~07·예외 켬이 저장되고 켬·에이전트·켠 시각은 그대로', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  const before = await cfgOf(ws);
  const { status, data } = await put(ws, { leadMinutes: 10, eveningAt: '20:00', quiet: { from: '22:00', to: '07:00', calendarAlerts: true } });
  assert.equal(status, 200, JSON.stringify(data));
  const c = await cfgOf(ws);
  assert.deepEqual([c.leadMinutes, c.eveningAt, c.quiet, c.morningAt], [10, '20:00', { from: '22:00', to: '07:00', calendarAlerts: true }, '07:00']);
  assert.deepEqual([c.enabled, c.agent, c.enabledAt, c.tz], [true, 'pepper', before.enabledAt, 'Asia/Seoul']);
  assert.deepEqual([data.config.leadMinutes, data.config.eveningAt, data.config.quiet.to], [10, '20:00', '07:00'], '보기도 새 값');
  await put(ws, { quiet: { to: '06:30' } });
  const c2 = await cfgOf(ws);
  assert.deepEqual([c2.quiet.from, c2.quiet.to, c2.quiet.calendarAlerts, c2.morningAt], ['22:00', '06:30', true, '06:30'], '칸 하나만 보내면 나머지는 그대로');
});

test('A6: 잘못된 값 — 400 + errorCode, 파일·봉인 그대로', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  const text = await raw(ws); const seal = (await company(ws)).assistantSeal;
  const cases = [
    [{ leadMinutes: 7 }, 'assistant_lead_invalid'],
    [{ eveningAt: '25:00' }, 'assistant_time_invalid'],
    [{ quiet: { from: '08:00', to: '08:00' } }, 'assistant_quiet_empty'],
    [{ eveningAt: '23:30' }, 'assistant_evening_in_quiet'], // 조용한 시간 23:00~08:00 안
    [{ eveningAt: '07:30', quiet: { from: '23:00', to: '09:00' } }, 'assistant_evening_in_quiet'],
    [{ eveningAt: '11:00', quiet: { from: '12:00', to: '13:00' } }, 'assistant_evening_before_morning'], // 저녁은 조용한 시간 밖이지만 아침(13:00) ≥ 저녁(11:00)
    [{ enabled: true, agent: 'nobody' }, 'assistant_agent_not_found'],
    [{ enabled: true }, 'assistant_agent_not_found'],
    [{ enabled: true, agent: '../x' }, 'assistant_agent_not_found'],
    ['[1]', 'assistant_bad_request'],
  ];
  for (const [body, code] of cases) {
    const { status, data } = await put(ws, body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(data.errorCode, code, JSON.stringify(body));
    assert.ok(data.error && !/^assistant_/.test(data.error), '사람 문구');
  }
  assert.equal(await raw(ws), text, '파일 그대로');
  assert.equal((await company(ws)).assistantSeal, seal, '봉인 그대로');
});

test('A11: CSRF — 다른 사이트에서 온 저장 요청은 거절(파일 없음)', async () => {
  const ws = await mkCompany();
  const { status } = await put(ws, { enabled: true, agent: 'pepper' }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(status, 403);
  assert.equal(existsSync(cfgPath(ws)), false);
});

test('A13: 다른 회사의 비서를 끄다가 한 회사에서 오류(그 회사 assistant.json 자리가 폴더) — 이 회사 켜기는 저장되고 PUT 200(보기), 나머지 회사는 그대로 끄고, 오류는 기록', async () => {
  const broken = await mkCompany({ name: '고장 난 회사' });
  const prev = await mkCompany({ name: '이전 비서 회사' });
  const ws = await mkCompany({ name: '새 비서 회사' });
  await put(prev, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  await mkdir(cfgPath(broken), { recursive: true }); // 읽으면 EISDIR(코드 없는 오류) — 순서와 상관없이 그 회사만 실패한다
  const logs = [];
  const realErr = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };
  let res;
  try { res = await put(ws, { enabled: true, agent: 'wolff', tz: 'Asia/Seoul' }); } finally { console.error = realErr; }
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual([res.data.config.enabled, res.data.current?.ws, res.data.current?.agent], [true, ws, 'wolff'], '화면은 오류 문구가 아니라 켜진 보기를 받는다');
  assert.equal((await cfgOf(ws)).enabled, true);
  assert.equal((await cfgOf(prev)).enabled, false, '고장 난 회사 뒤·앞의 다른 회사도 끈다(한 회사 오류로 멈추지 않는다)');
  assert.ok(logs.some((l) => l.includes(broken)), `실패한 회사를 기록: ${JSON.stringify(logs)}`);
});

test('A14: 코드 없는 서버 오류(파일 읽기 실패)는 500 — 400(요청 잘못)으로 보이지 않는다', async () => {
  const ws = await mkCompany();
  await mkdir(cfgPath(ws), { recursive: true }); // 이 회사의 assistant.json 자리가 폴더 → 읽기 EISDIR
  const { status, data } = await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  assert.equal(status, 500, JSON.stringify(data));
  assert.equal(data.errorCode, undefined); // 코드 있는 검증 오류가 그대로 400인 것은 A6
});

/* ── 봉인 — 옛 버전 기기의 에이전트가 assistant.json을 쓴 경우 ── */

test('A7: 옛 기기 에이전트가 봉인 없이 assistant.json에 켜짐을 씀 — 엔진 꺼짐·호출 0·상태 파일 0, 다른 회사의 진짜 비서를 쉬게 하지도 못한다', async () => {
  const ws = await mkCompany();
  await agentWrites(ws, { enabled: true, agent: 'pepper', enabledAt: '2026-10-01T00:00:00Z', tz: 'Asia/Seoul' });
  const env = fakeServer([ev('e1', at('13:40'))]);
  const out = await tickRange(ws, env, [ws], at('13:05'), at('13:12'));
  assert.ok(out.every((r) => r.why === 'off'), JSON.stringify(out));
  assert.equal(env.calls.length, 0, '일정 읽기·글 0');
  assert.equal(existsSync(stateFile(ws)), false);
  const v = (await get(ws)).data;
  assert.deepEqual([v.unsealed, v.current, v.config.enabled], [true, null, false], '설정 화면: 꺼짐 + 설정 화면 밖에서 바뀜');
  // 진짜 비서(설정 API로 켬)가 있는 회사 A, 같은 주인의 회사 B에 에이전트가 더 늦은 켠 시각으로 심음 → A가 그대로 맡는다
  const a = await mkCompany();
  const b = await mkCompany();
  await put(a, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  await agentWrites(b, { enabled: true, agent: 'pepper', enabledAt: '2099-01-01T00:00:00Z', tz: 'Asia/Seoul' });
  T._resetAssistantForTest(); C._resetAssistantConfigCacheForTest();
  const env2 = fakeServer([ev('e2', at('14:00'))]);
  await tickRange(a, env2, [a, b], at('13:25'), at('13:31'));
  assert.equal(env2.inserts.length, 1, 'A가 그대로 알린다(봉인 없는 B는 다른 회사 비서로 치지 않는다)');
  assert.equal((await get(a)).data.current?.ws, a);
});

test('A8: 봉인된 파일을 에이전트가 고침(조용한 시간 없앰) — 엔진 꺼짐, 설정 화면 "화면 밖에서 바뀜"', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  const c = await cfgOf(ws);
  await agentWrites(ws, { ...c, quiet: { from: '00:00', to: '00:00', calendarAlerts: true } });
  assert.equal(await C.loadEffectiveAssistantConfig(ws), null);
  const env = fakeServer([ev('e1', at('13:40'))]);
  const out = await tickRange(ws, env, [ws], at('13:05'), at('13:12'));
  assert.ok(out.every((r) => r.why === 'off'));
  assert.equal(env.calls.length, 0);
  assert.equal((await get(ws)).data.unsealed, true);
});

test('A9: 봉인이 안 맞는 파일에서 다시 켜기 — 화면 밖 칸(watch.mail·심은 칸)은 버리고 기본값에서 새로 봉인', async () => {
  const ws = await mkCompany();
  await agentWrites(ws, { enabled: true, agent: 'pepper', watch: { calendar: true, mail: true }, quiet: { from: '00:00', to: '00:00' }, leadMinutes: 60, planted: 'x' });
  const { status } = await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  assert.equal(status, 200);
  const c = await cfgOf(ws);
  assert.deepEqual(c.watch, { calendar: true, mail: false, tasks: false, deals: false }, '심은 메일 보기를 다시 봉인하지 않는다');
  assert.equal('planted' in c, false);
  assert.deepEqual([c.leadMinutes, c.quiet.from, c.quiet.to], [30, '23:00', '08:00'], '화면에 안 보이던 값 대신 기본값');
  assert.equal((await get(ws)).data.unsealed, false);
});

test('A10: 봉인이 맞는 파일에서 저장 — 이 화면이 다루지 않는 칸(나중 단계가 저장한 칸·볼 것)은 그대로', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  // 새 버전 기기(4·6단계)가 봉인해 저장한 칸이라고 치고 — 설정 API의 쓰기 경로처럼 봉인
  const c = await cfgOf(ws);
  const text = `${JSON.stringify({ ...c, watch: { ...c.watch, mail: true }, mailSource: 'intranet:x', mute: [{ id: 'm1', scope: 'from', match: 'a@b.c' }] }, null, 2)}\n`;
  await writeFile(cfgPath(ws), text); await updateCompany(ws, () => ({ assistantSeal: C.sealOf(text) }));
  await put(ws, { leadMinutes: 15 });
  const after = await cfgOf(ws);
  assert.equal(after.leadMinutes, 15);
  assert.equal(after.watch.mail, true, '옛 화면이 새 버전이 켠 메일 보기를 끄지 않는다');
  assert.equal(after.mailSource, 'intranet:x');
  assert.deepEqual(after.mute, [{ id: 'm1', scope: 'from', match: 'a@b.c' }]);
});

test('V3: 동기화로 assistant.json이 먼저 오고 company.json 봉인이 늦게 옴 — 그 사이 틱은 꺼짐(호출·쓰기 0), 봉인이 오면 켜짐', async () => {
  const src = await mkCompany();
  await put(src, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  const text = await raw(src); const seal = (await company(src)).assistantSeal;
  await put(src, { enabled: false }); // 보내는 쪽 회사는 치운다(같은 주인의 다른 회사로 섞이지 않게)
  const dst = await mkCompany(); // 받는 기기의 같은 회사라고 치고
  await writeFile(cfgPath(dst), text); // 파일만 먼저 도착
  const env = fakeServer([ev('e1', at('14:00'))]);
  const before = await tickRange(dst, env, [dst], at('13:20'), at('13:22'));
  assert.ok(before.every((r) => r.why === 'off'), JSON.stringify(before));
  assert.equal(env.calls.length, 0);
  assert.equal(existsSync(stateFile(dst)), false, '상태 파일 쓰기 0');
  await updateCompany(dst, () => ({ assistantSeal: seal })); // company.json이 다음 사이클에 도착
  await tickRange(dst, env, [dst], at('13:29'), at('13:31'));
  assert.equal(env.inserts.length, 1, '봉인이 오면 그 틱부터 돈다');
});

/* ── 보기(상태) — 서버 쪽 판정 ── */

test('S2(서버): 로그인·끈 목록·실행 기기·상태 파일 — 실행 기기가 이 기기일 때만 마지막 확인·오늘 알림 수', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  const deps = (over = {}) => ({ lease: () => ({ syncOn: false }), deviceSession: () => null, sessionDead: () => false, deviceId: async () => 'Geony-Mac-Pro-c40da337', ...over });
  let v = await S.assistantSettingsView(ws, { now: NOW, deps: deps() });
  assert.deepEqual([v.status.login, v.status.runner, v.status.device, v.status.muted], [false, 'this_device', 'Geony-Mac-Pro', false], '기기 세션 없음 = 로그인 필요');
  v = await S.assistantSettingsView(ws, { now: NOW, deps: deps({ deviceSession: () => ({ user: { id: owner } }) }) });
  assert.equal(v.status.login, true, '기기 세션 계정 = 회사 주인');
  v = await S.assistantSettingsView(ws, { now: NOW, deps: deps({ deviceSession: () => ({ user: { id: 'u9' } }) }) });
  assert.equal(v.status.login, false, '다른 계정');
  v = await S.assistantSettingsView(ws, { now: NOW, deps: deps({ deviceSession: () => ({ user: { id: owner } }), sessionDead: () => true }) });
  assert.equal(v.status.login, false, '세션 파일은 주인 계정이지만 갱신이 거절돼 죽은 상태 — 엔진처럼 로그인 필요');
  // 상태 파일(엔진이 쓴 모양) — 오늘 날짜면 알림 수, 다른 날이면 0
  await mkdir(join(paths(ws).root, '.assistant'), { recursive: true });
  await writeFile(stateFile(ws), JSON.stringify({ v: 1, sent: { k: 1 }, pending: [], outbox: null, cal: { coveredUntil: NOW, readAt: NOW - 60_000 }, bundles: { am: '', pm: '' }, day: { date: '2026-10-08', instant: 3 }, status: { code: 'calendar_error', at: NOW } }));
  v = await S.assistantSettingsView(ws, { now: NOW, deps: deps() });
  assert.deepEqual([v.status.code, v.status.readAt, v.status.instantToday], ['calendar_error', NOW - 60_000, 3]);
  assert.equal('sent' in v.status, false, '보낸 키·대기열 본문은 내보내지 않는다');
  v = await S.assistantSettingsView(ws, { now: Date.parse('2026-10-09T09:00:00+09:00'), deps: deps() });
  assert.equal(v.status.instantToday, 0, '날이 바뀌면 0');
  // 다른 기기가 실행 / 옛 버전 기기가 실행 — 이 기기 상태 파일은 보이지 않는다
  const holder = (assistant) => ({ syncOn: true, leader: false, ownedAt: 0, checkedAt: NOW, holder: { deviceId: 'Office-PC-1a2b3c4d', assistant, ts: NOW - 10_000 } });
  v = await S.assistantSettingsView(ws, { now: NOW, deps: deps({ lease: () => holder(2) }) });
  assert.deepEqual([v.status.runner, v.status.device, v.status.code, v.status.readAt], ['other_device', 'Office-PC', null, 0]);
  v = await S.assistantSettingsView(ws, { now: NOW, deps: deps({ lease: () => holder(0) }) });
  assert.equal(v.status.runner, 'runner_outdated', '실행 기기가 옛 버전(리스 글에 비서 엔진 번호 없음)');
  v = await S.assistantSettingsView(ws, { now: NOW, deps: deps({ lease: () => holder(1) }) });
  assert.equal(v.status.runner, 'runner_outdated', '실행 기기가 봉인을 안 보는 1단계 빌드(엔진 번호 1, #867) — 옛 버전으로 본다');
  // 메신저 알림 종류에서 비서를 끔
  await updateCompany(ws, (c) => ({ msgr: { ...(c.msgr ?? {}), mutedEvents: ['assistant'] } }));
  v = await S.assistantSettingsView(ws, { now: NOW, deps: deps() });
  assert.equal(v.status.muted, true);
});

test('S2b: 기기 세션이 죽은 상태(만료 + 갱신 거절 사망 마커, 파일은 남음) — 엔진은 login_required, 설정 화면도 "로그인 필요"(실제 파일·기본 판정)', async () => {
  const ws = await mkCompany();
  await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
  const sessFile = join(process.env.ARGO_ROOT, '.device-session.json');
  const deadFile = `${sessFile}.dead`;
  const rt = 'rt-test-dead';
  const writeSession = (expiresInSec) => writeFile(sessFile, JSON.stringify({ url: 'http://127.0.0.1:9', anonKey: 'anon-test', access_token: 'at-test', refresh_token: rt, expires_at: Math.floor(Date.now() / 1000) + expiresInSec, user: { id: owner, email: 'dead@example.invalid' } }), { mode: 0o600 });
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (...a) => { n += 1; return realFetch(...a); };
  try {
    await writeSession(-3600);
    await writeFile(deadFile, JSON.stringify({ at: new Date().toISOString(), lastAt: new Date().toISOString(), count: 1, kind: 'revoked', reason: 'Invalid Refresh Token: Refresh Token Not Found', tokenTag: createHash('sha256').update(rt).digest('hex').slice(0, 16) }));
    // 엔진 — 실제 기기 세션 경로(msgr.sessionClient → getFreshDeviceSession). 사망 게이트가 같은 토큰을 다시 보내지 않아 null
    const r = await T.runAssistantTick(ws, { now: NOW, deps: { ...T.assistantDeps, lease: () => ({ syncOn: false }), companyIds: async () => [ws], agentExists: async () => true } });
    assert.deepEqual([r.ran, r.why], [true, 'login']);
    assert.equal(JSON.parse(await readFile(stateFile(ws), 'utf8')).status?.code, 'login_required');
    // 설정 화면 — 라우트 GET(기본 판정, 회전 없음)
    const { data } = await get(ws);
    assert.equal(data.status.login, false, `세션 파일이 남아 있어도 죽은 세션은 로그인 아님: ${JSON.stringify(data.status)}`);
    assert.deepEqual(V.statusNotes(data, ws, 'pepper'), ['login_required'], '비서 탭에 경고 줄');
    // 사망 마커가 남아 있어도 세션이 살아 있으면(만료 전 — 다른 경로가 새 토큰을 받아 둔 경우) 로그인으로 본다
    await writeSession(3600);
    assert.equal((await get(ws)).data.status.login, true);
  } finally {
    globalThis.fetch = realFetch;
    await rm(sessFile, { force: true });
    await rm(deadFile, { force: true });
  }
  assert.equal(n, 0, '엔진 틱·보기 모두 네트워크 0(죽은 토큰을 다시 보내지 않는다)');
});

test('D7: 설정 화면 읽기·저장은 네트워크 호출 0(로컬 파일만 — Supabase 요청 0)', async () => {
  const ws = await mkCompany();
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (...a) => { n += 1; return realFetch(...a); };
  try {
    await put(ws, { enabled: true, agent: 'pepper', tz: 'Asia/Seoul' });
    await put(ws, { leadMinutes: 15 });
    await get(ws);
    await put(ws, { enabled: false });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(n, 0);
});
