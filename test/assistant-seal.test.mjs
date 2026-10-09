// 능동 비서 엔진 봉인(#867 — #865 2차 검수 MEDIUM) — 엔진은 company.json 봉인(assistantSeal)이 assistant.json 바이트의 sha256과 맞는 켜짐만 돌린다.
// 경우 표(PR 본문) E1~E6·E9. 설정 API(#865) 없이 봉인을 직접 써서 확인한다(설정 API가 쓸 모양 = 파일 바이트의 sha256, config.mjs sealOf).
// 가짜 서버로 실제 틱(runAssistantTick)을 돌려 "일정 읽기 0·상태 파일 0"까지 본다. 운영 DB·실제 계정·상주 :3001을 쓰지 않는다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-asst-seal-'));
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGO_SYNC']) delete process.env[k];

const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const C = await import('../src/assistant/config.mjs');
const T = await import('../src/assistant/tick.mjs');
const { stateFile } = await import('../src/assistant/state.mjs');

const iso = (ms) => new Date(ms).toISOString();
const at = (hm) => Date.parse(`2026-10-08T${hm}:00+09:00`);
const cfgPath = (ws) => join(paths(ws).root, C.ASSISTANT_FILE);

let seq = 0;
let owner = 'u0'; // 테스트마다 새 주인 — 같은 ARGO_ROOT의 다른 테스트 회사가 "같은 사용자의 다른 회사"로 섞이지 않게
async function mkCompany() {
  const ws = `seal-${++seq}`;
  await createCompany(ws, '봉인 테스트', 'owner', owner, 'ko');
  await updateCompany(ws, (c) => ({ msgr: { ...(c.msgr ?? {}), enabled: true } }));
  return ws;
}
/** 옛 버전(0.1.98 이하) 기기의 에이전트처럼 쓰기 — 파일만 쓰고 봉인은 건드리지 않는다(옛 권한 게이트는 assistant.json을 막지 않았다). */
const agentWrites = (ws, obj) => writeFile(cfgPath(ws), JSON.stringify(obj));
/** 설정 API(#865 settings.mjs writeSealed)가 쓸 모양 — 파일 바이트 + 그 sha256 봉인. 반환 = 파일 원문. */
async function sealedWrite(ws, obj) {
  const text = `${JSON.stringify(obj, null, 2)}\n`;
  await writeFile(cfgPath(ws), text);
  await updateCompany(ws, () => ({ [C.SEAL_FIELD]: C.sealOf(text) }));
  return text;
}
const ON = { enabled: true, agent: 'pepper', enabledAt: '2026-10-01T00:00:00Z', tz: 'Asia/Seoul' };

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
      // 방에서 복구 읽기(3단계 recover.mjs) — 실제 서버처럼 이 크루의 개인 행·이미 있는 방·넣은 글을 돌려준다
      async personalCrewsOf(_u, wsIds) { env.calls.push('personalCrewsOf'); return [{ id: 'crew-p', org_id: null, slug: 'pepper', ws_id: wsIds[0] }]; },
      async personalRoomsOf(ids) { env.calls.push('personalRoomsOf'); return ids.map((id) => ({ id: `room-${id}`, personal_pair: `crew:${id}` })); },
      async assistantNotices(chIds) { env.calls.push('assistantNotices'); return env.inserts.filter((r) => chIds.includes(r.channel_id)).map((r) => ({ meta: r.meta, created_at: null })); },
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
/** console.error 줄 모으기 — 봉인 안 맞음 로그가 프로세스당 한 번인지 본다. */
async function capturingErrors(fn) {
  const lines = []; const orig = console.error;
  console.error = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.error = orig; }
  return lines;
}

let ownerSeq = 0;
beforeEach(() => { owner = `u${++ownerSeq}`; T._resetAssistantForTest(); C._resetAssistantConfigCacheForTest(); });

test('E1: 0.1.98 이하 기기의 에이전트가 봉인 없이 {"enabled":true,"agent":"pepper"}를 씀 — 엔진 꺼짐·일정 읽기 0·상태 파일 0·로그 1줄', async () => {
  const ws = await mkCompany();
  await agentWrites(ws, { enabled: true, agent: 'pepper' }); // 검수 재현(review-2/repro/unsealed-engine.mjs)과 같은 모양
  const env = fakeServer([ev('e1', at('13:40'))]);
  let out;
  const logs = await capturingErrors(async () => { out = await tickRange(ws, env, [ws], at('13:05'), at('13:12')); });
  assert.ok(out.every((r) => r.ran === false && r.why === 'off'), JSON.stringify(out));
  assert.equal(env.calls.length, 0, '일정 읽기·방 열기·글 0');
  assert.equal(existsSync(stateFile(ws)), false, '상태 파일 쓰기 0');
  assert.equal(await C.loadEffectiveAssistantConfig(ws), null);
  assert.equal(logs.filter((l) => l.includes('설정 화면 밖에서 바뀌어 꺼진 것으로 봅니다')).length, 1, `봉인 안 맞음 로그는 한 번 — ${JSON.stringify(logs)}`);
});

test('E2: 봉인 맞는 켜짐 파일을 에이전트가 고침(조용한 시간 없앰) — 엔진 꺼짐·호출 0', async () => {
  const ws = await mkCompany();
  await sealedWrite(ws, ON);
  assert.ok(await C.loadEffectiveAssistantConfig(ws), '봉인이 맞으면 켜짐');
  C._resetAssistantConfigCacheForTest();
  await agentWrites(ws, { ...ON, quiet: { from: '00:00', to: '00:00', calendarAlerts: true } });
  const env = fakeServer([ev('e1', at('13:40'))]);
  const out = await tickRange(ws, env, [ws], at('13:05'), at('13:12'));
  assert.ok(out.every((r) => r.why === 'off'), JSON.stringify(out));
  assert.equal(env.calls.length, 0);
});

test('E3: 동기화로 assistant.json이 먼저 오고 company.json 봉인이 다음 사이클에 옴 — 그 사이 틱은 꺼짐(호출·상태 파일 0), 봉인이 오면 그 틱부터 돈다', async () => {
  const ws = await mkCompany();
  const text = `${JSON.stringify(ON, null, 2)}\n`;
  await writeFile(cfgPath(ws), text); // 파일만 먼저 도착
  const env = fakeServer([ev('e1', at('14:00'))]);
  const before = await tickRange(ws, env, [ws], at('13:20'), at('13:22'));
  assert.ok(before.every((r) => r.why === 'off'), JSON.stringify(before));
  assert.equal(env.calls.length, 0);
  assert.equal(existsSync(stateFile(ws)), false, '상태 파일 쓰기 0');
  await updateCompany(ws, () => ({ [C.SEAL_FIELD]: C.sealOf(text) })); // company.json이 다음 사이클에 도착
  await tickRange(ws, env, [ws], at('13:29'), at('13:31'));
  assert.equal(env.inserts.length, 1, '봉인이 오면 그 틱부터 돈다(14:00 일정 30분 전 1건)');
});

test('E4: 같은 주인의 다른 회사에 에이전트가 봉인 없이 더 늦은 켜짐을 심음 — 봉인 맞는 회사가 그대로 맡는다', async () => {
  const a = await mkCompany();
  const b = await mkCompany();
  await sealedWrite(a, ON);
  await agentWrites(b, { ...ON, enabledAt: '2099-01-01T00:00:00Z' });
  const env = fakeServer([ev('e2', at('14:00'))]);
  const out = await tickRange(a, env, [a, b], at('13:25'), at('13:31'));
  assert.equal(env.inserts.length, 1, `A가 그대로 알린다(봉인 없는 B는 다른 회사 비서로 치지 않는다) — ${JSON.stringify(out)}`);
  assert.ok(!out.some((r) => r.why === 'other_company'));
  const outB = await tickRange(b, fakeServer([ev('e3', at('14:00'))]), [a, b], at('13:25'), at('13:26'));
  assert.ok(outB.every((r) => r.why === 'off'), 'B 자신도 꺼짐');
});

test('E5: company.json이 없거나 손상, 봉인 칸이 문자열이 아님 — 꺼짐(돈·일정 읽기를 쓰지 않는 쪽)', async () => {
  const ws = await mkCompany();
  const text = await sealedWrite(ws, ON);
  const seal = C.sealOf(text);
  await updateCompany(ws, () => ({ [C.SEAL_FIELD]: [seal] })); // 문자열 아님
  assert.equal(await C.loadEffectiveAssistantConfig(ws), null, '봉인 칸이 배열');
  await writeFile(paths(ws).company, '{ not json');
  assert.equal(await C.loadEffectiveAssistantConfig(ws), null, 'company.json 손상');
  await rm(paths(ws).company);
  assert.equal(await C.loadEffectiveAssistantConfig(ws), null, 'company.json 없음');
});

test('E6: 봉인 맞는 켜짐(설정 API가 쓸 모양) — 엔진이 켜진 설정으로 읽고 알린다, 같은 내용이면 다시 읽어도 같은 값(캐시)', async () => {
  const ws = await mkCompany();
  const text = await sealedWrite(ws, ON);
  const cfg = await C.loadEffectiveAssistantConfig(ws);
  assert.deepEqual([cfg?.enabled, cfg?.agent, cfg?.seal], [true, 'pepper', C.sealOf(text)]);
  const env = fakeServer([ev('e1', at('14:00'))]);
  await tickRange(ws, env, [ws], at('13:29'), at('13:31'));
  assert.equal(env.inserts.length, 1);
});

test('E9: 꺼짐·파일 없음 — 봉인을 보지 않는다(company.json이 없어도 꺼진 설정을 그대로 돌려줌), 틱 호출 0', async () => {
  const ws = await mkCompany();
  assert.equal(await C.loadEffectiveAssistantConfig(ws), null, '파일 없음 = null(꺼짐)');
  await agentWrites(ws, { enabled: false, agent: 'pepper' });
  await rm(paths(ws).company);
  const logs = await capturingErrors(async () => {
    const cfg = await C.loadEffectiveAssistantConfig(ws);
    assert.equal(cfg?.enabled, false, '꺼진 설정은 봉인과 상관없이 그대로(어차피 꺼짐)');
  });
  assert.deepEqual(logs, [], '꺼짐이면 봉인 안 맞음 로그도 없다');
  const ws2 = await mkCompany();
  await agentWrites(ws2, { enabled: false, agent: 'pepper' });
  const env = fakeServer([ev('e1', at('13:40'))]);
  const out = await tickRange(ws2, env, [ws2], at('13:05'), at('13:07'));
  assert.ok(out.every((r) => r.why === 'off'));
  assert.equal(env.calls.length, 0);
});
