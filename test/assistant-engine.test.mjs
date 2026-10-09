// 능동 비서 1단계 — 일정 감시 엔진(src/assistant). 경우 표 C1~C14, W7~W9, D1~D4(V1·리스는 assistant-lease.test.mjs, 스케줄러 배선은 scheduler-tick-wiring.test.mjs).
// 시계·세션·리스·에이전트 존재를 주입하고, 설정(assistant.json)·상태(.assistant/state.json)·회사(company.json)는 임시 ARGO_ROOT의 실제 파일로 돈다.
// 실제 러너·실제 계정·운영 DB를 쓰지 않는다. D1은 가짜 Supabase HTTP(test/helpers/fake-supabase-http.mjs)에 실제 supabase-js로 붙어 요청을 센다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-asst-'));
process.env.ARGO_ENC_VAULT = '0'; // EXCLUDE의 구조적 규칙만 본다(assistant-adjacent-pins.test.mjs 주석)
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGO_SYNC']) delete process.env[k];

const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const T = await import('../src/assistant/tick.mjs');
const { normalizeAssistantConfig, _resetAssistantConfigCacheForTest, sealOf } = await import('../src/assistant/config.mjs');
const { stateFile } = await import('../src/assistant/state.mjs');
const { ASSISTANT_TEXT } = await import('../src/assistant/text.mjs');
const { clientMsgId } = await import('../src/assistant/deliver.mjs');
const { EXCLUDE, isFileLockedRel } = await import('../src/sync.mjs');
const { CHANNEL_EVENTS, channelSends, normalizeMuted } = await import('../src/channel-events.mjs');

const iso = (ms) => new Date(ms).toISOString();
const D = '2026-10-08'; // 목요일
const at = (hm, day = D) => Date.parse(`${day}T${hm}:00+09:00`);
const MIN = 60_000;

let seq = 0;
/** 회사 하나 — 주인 u1, 메신저 켜짐, 비서 켬(페퍼, 서울 시간). cfg:null이면 assistant.json 없음. */
async function company({ cfg = {}, ownerId = 'u1', lang = 'ko', msgr = {} } = {}) {
  const ws = `asst-${++seq}`;
  await createCompany(ws, '비서 테스트', 'owner', ownerId, lang);
  await updateCompany(ws, (c) => ({ msgr: { ...(c.msgr ?? {}), enabled: true, ...msgr } }));
  if (cfg !== null) await writeCfg(ws, { enabled: true, agent: 'pepper', enabledAt: '2026-10-01T00:00:00Z', tz: 'Asia/Seoul', ...cfg });
  return ws;
}
/** 설정 파일 쓰기 — 설정 API(src/assistant/settings.mjs)처럼 company.json 봉인도 같이 적는다(엔진은 봉인이 맞는 켜짐만 돌린다 — config.mjs 머리 주석). */
async function writeCfg(ws, obj) {
  const text = JSON.stringify(obj);
  await writeFile(join(paths(ws).root, 'assistant.json'), text);
  await updateCompany(ws, () => ({ assistantSeal: sealOf(text) }));
}
const ev = (id, start, end, extra = {}) => ({ id, org_id: null, owner: 'u1', title: `일정 ${id}`, location: '', all_day: false, starts_at: iso(start), ends_at: iso(end), rrule: null, exdates: [], attendees: [], ...extra });

// 설계 10절 — 감시기가 부를 수 있는 서버 호출. 3단계(방에서 복구 — src/assistant/recover.mjs)가 읽기 셋을 더했다: 내 개인 크루 행·이미 있는 1:1 방·비서 알림 글.
const ALLOWED_CALLS = new Set(['office_event_list', 'msgr_dm_personal_crew', 'myCrews', 'insertMessage', 'personalCrewsOf', 'personalRoomsOf', 'assistantNotices']);
const seenCalls = new Set();
/** 가짜 서버 — office_event_list(서버처럼 기간에 걸치는 행), 개인 1:1 방 RPC(처음 부를 때 방을 만든다), 내 크루 행, 글 넣기(client_msg_id 유니크 = 23505 → null),
    방에서 복구 읽기 셋(이미 있는 방·그 방의 비서 글 — 실제 서버처럼 넣은 글을 돌려준다). 크루 행에 ws_id가 없으면 지금 회사의 행으로 본다. */
function fakeServer({ events = [], uid = 'u1', crews = [{ id: 'crew-p', org_id: null, slug: 'pepper' }] } = {}) {
  const env = { events, crews, calls: [], inserts: [], now: 0, failRead: false, failRoom: false, failInsert: false, ids: new Set(), rooms: new Set(), session: null };
  const overlaps = (e, from, to) => Date.parse(e.starts_at) < to && (e.rrule ? true : Date.parse(e.ends_at) > from);
  env.session = {
    uid,
    client: {
      async rpc(name, args) {
        env.calls.push({ name, args, at: env.now }); seenCalls.add(name);
        if (name === 'office_event_list') {
          if (env.failRead) return { data: null, error: { message: 'read failed' } };
          const from = Date.parse(args.p_from); const to = Date.parse(args.p_to);
          return { data: { events: env.events.filter((e) => overlaps(e, from, to)).map((e) => ({ ...e })), orgs: [] }, error: null };
        }
        if (name === 'msgr_dm_personal_crew') { if (env.failRoom) return { data: null, error: { message: 'msgr_not_allowed' } }; env.rooms.add(args.crew); return { data: `room-${args.crew}`, error: null }; }
        return { data: null, error: { message: `unexpected rpc ${name}` } };
      },
    },
    db: {
      async myCrews() { env.calls.push({ name: 'myCrews', at: env.now }); seenCalls.add('myCrews'); return env.crews; },
      async insertMessage(row) {
        env.calls.push({ name: 'insertMessage', at: env.now }); seenCalls.add('insertMessage');
        if (env.failInsert) throw new Error('network down');
        if (env.ids.has(row.client_msg_id)) return null;
        env.ids.add(row.client_msg_id);
        env.inserts.push({ ...row, at: env.now, created_at: iso(env.now) });
        return { id: `m${env.inserts.length}` };
      },
      async personalCrewsOf(_u, wsIds) { env.calls.push({ name: 'personalCrewsOf', at: env.now }); seenCalls.add('personalCrewsOf'); return env.crews.filter((c) => c.org_id == null).map((c) => ({ ...c, ws_id: c.ws_id ?? wsIds[0] })); },
      async personalRoomsOf(ids) { env.calls.push({ name: 'personalRoomsOf', at: env.now }); seenCalls.add('personalRoomsOf'); return ids.filter((id) => env.rooms.has(id)).map((id) => ({ id: `room-${id}`, personal_pair: `crew:${id}` })); },
      async assistantNotices(chIds, crewIds, since, limit) {
        env.calls.push({ name: 'assistantNotices', at: env.now }); seenCalls.add('assistantNotices');
        return env.inserts.filter((r) => chIds.includes(r.channel_id) && crewIds.includes(r.crew_id) && r.client_msg_id.startsWith('as:') && r.created_at >= since).reverse().slice(0, limit).map((r) => ({ meta: r.meta, created_at: r.created_at }));
      },
    },
  };
  return env;
}
const depsFor = (env, ws, extra = {}) => ({ ...T.assistantDeps, lease: () => ({ syncOn: false }), session: async () => env.session, agentExists: async () => true, companyIds: async () => [ws], ...extra });
async function run(ws, env, from, to, { deps, hook, step = MIN } = {}) {
  const d = deps ?? depsFor(env, ws);
  const out = [];
  for (let t = from; t <= to; t += step) { env.now = t; if (hook) await hook(t); out.push(await T.runAssistantTick(ws, { now: t, deps: d })); }
  return out;
}
const reads = (env) => env.calls.filter((c) => c.name === 'office_event_list');
const state = async (ws) => JSON.parse(await readFile(stateFile(ws), 'utf8'));
const hhmm = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(11, 16);

beforeEach(() => { T._resetAssistantForTest(); _resetAssistantConfigCacheForTest(); });

/* ── 일정 C1~C14 ── */

test('C1·C2: 14:00 일정 — 13:30 틱에 시작 전 알림 1건(개인 1:1 방, as: 접두), 그 뒤 틱들은 0건', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'), { location: '본사 3층' })] });
  await run(ws, env, at('13:00'), at('14:30'));
  assert.equal(env.inserts.length, 1, env.inserts.map((r) => `${hhmm(r.at)} ${r.body}`).join(' | '));
  const r = env.inserts[0];
  assert.equal(hhmm(r.at), '13:30');
  assert.equal(r.channel_id, 'room-crew-p', '개인 공간 1:1 방');
  assert.equal(r.crew_id, 'crew-p');
  assert.equal(r.client_msg_id, clientMsgId('crew-p', `cal:e1:${iso(at('14:00'))}:pre`), '기준 = 그 키 하나');
  assert.match(r.client_msg_id, /^as:crew-p:[0-9a-f]{32}$/);
  assert.equal(r.body, '[비서] 곧 시작하는 일정\n· 14:00 일정 e1 — 30분 뒤 시작 · 장소: 본사 3층');
  assert.deepEqual(r.meta.assistant.keys, [`cal:e1:${iso(at('14:00'))}:pre`]);
  assert.equal(r.meta.notification, 'assistant');
  assert.equal((await state(ws)).day.instant, 1, '오늘 즉시 알림 수');
});

test('C3: 마지막 읽기 전에 14:00 → 15:00으로 옮김 — 14:30에 1건, 옛 시각 알림 0', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))] });
  await run(ws, env, at('13:00'), at('15:10'), { hook: (t) => { if (t === at('13:10')) env.events = [ev('e1', at('15:00'), at('16:00'))]; } });
  assert.deepEqual(env.inserts.map((r) => hhmm(r.at)), ['14:30']);
  assert.match(env.inserts[0].body, /15:00 일정 e1 — 30분 뒤 시작/);
});

test('C3b: 13:20에 읽은 뒤 13:25에 14:00 → 15:00 — 13:30 확인 읽기에서 0건, 14:30에 1건', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))] });
  await run(ws, env, at('13:20'), at('15:10'), { hook: (t) => { if (t === at('13:25')) env.events = [ev('e1', at('15:00'), at('16:00'))]; } });
  assert.deepEqual(env.inserts.map((r) => hhmm(r.at)), ['14:30']);
  const confirm = reads(env).find((c) => c.at === at('13:30'));
  assert.ok(confirm, '13:30에 확인 읽기');
  assert.deepEqual([confirm.args.p_from, confirm.args.p_to], [iso(at('13:59')), iso(at('14:01'))], '확인 읽기 범위 = 회차 시작 ±1분');
});

test('C4·C4b: 마지막 읽기 전 삭제 → 0건 / 읽기 뒤 15분 안 삭제 → 확인 읽기에서 0건(지난 일정으로도 안 남는다)', async () => {
  const a = await company();
  const envA = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))] });
  await run(a, envA, at('13:00'), at('14:30'), { hook: (t) => { if (t === at('13:10')) envA.events = []; } });
  assert.equal(envA.inserts.length, 0);
  const b = await company();
  const envB = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))] });
  await run(b, envB, at('13:20'), at('21:05'), { hook: (t) => { if (t === at('13:25')) envB.events = []; } });
  assert.equal(envB.inserts.filter((r) => r.meta.assistant.kind === 'pre').length, 0);
  assert.equal(envB.inserts.length, 0, '저녁 묶음에도 지난 일정으로 들어가지 않는다(내일 일정도 없음 → 글 0)');
});

test('C5: 매주 반복(월 14:00), 제외 날짜 1개 — 회차마다 1건, 제외한 날 0건', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('w1', at('14:00', '2026-10-05'), at('15:00', '2026-10-05'), { rrule: 'FREQ=WEEKLY', exdates: ['2026-10-12'] })] });
  for (const day of ['2026-10-05', '2026-10-12', '2026-10-19']) await run(ws, env, at('13:25', day), at('13:35', day));
  const pre = env.inserts.filter((r) => r.meta.assistant.kind === 'pre');
  assert.deepEqual(pre.map((r) => new Date(r.at + 9 * 3600_000).toISOString().slice(0, 16)), ['2026-10-05T13:30', '2026-10-19T13:30']);
});

test('C6: 시작 20분 전에 새로 만든 일정 — 다음 읽기 때 "N분 뒤 시작" 1건', async () => {
  const ws = await company();
  const env = fakeServer({ events: [] });
  await run(ws, env, at('13:20'), at('14:05'), { hook: (t) => { if (t === at('13:40')) env.events = [ev('n1', at('14:00'), at('14:30'))]; } });
  assert.equal(env.inserts.length, 1);
  assert.equal(hhmm(env.inserts[0].at), '13:50', '13:20부터 15분마다 읽는다 — 13:40에 만든 일정은 13:50 읽기에서 안다');
  assert.match(env.inserts[0].body, /14:00 일정 n1 — 10분 뒤 시작/);
});

test('C7: 종일 일정 — 시작 전 알림 0, 아침 묶음에 "오늘 종일" 1줄', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('d1', at('00:00'), at('00:00', '2026-10-09'), { all_day: true, title: '워크숍' })] });
  await run(ws, env, at('07:58'), at('08:10'));
  assert.equal(env.inserts.length, 1);
  const r = env.inserts[0];
  assert.equal(hhmm(r.at), '08:00');
  assert.equal(r.meta.assistant.kind, 'am');
  assert.equal(r.body, '[비서] 아침 정리 — 10월 8일(목)\n\n오늘 종일\n· 종일 워크숍');
  assert.equal(r.client_msg_id, clientMsgId('crew-p', `sum:am:${D}`), '묶음 기준 = 그 키 하나');
});

test('C8: 21:00 — 내일 일정 3건이면 저녁 묶음에 3줄 / 0건이고 다른 것도 없으면 글 0', async () => {
  const ws = await company();
  const N = '2026-10-09';
  const env = fakeServer({ events: [ev('t1', at('09:00', N), at('10:00', N)), ev('t2', at('13:00', N), at('14:00', N)), ev('t3', at('00:00', N), at('00:00', '2026-10-10'), { all_day: true, title: '휴가' })] });
  await run(ws, env, at('20:58'), at('21:05'));
  assert.equal(env.inserts.length, 1);
  const r = env.inserts[0];
  assert.equal(hhmm(r.at), '21:00');
  assert.equal(r.body, '[비서] 저녁 정리 — 10월 8일(목)\n\n내일 일정 3건 — 10월 9일(금)\n· 종일 휴가\n· 09:00 일정 t1\n· 13:00 일정 t2');
  const ws0 = await company();
  const env0 = fakeServer({ events: [] });
  await run(ws0, env0, at('20:58'), at('21:30'));
  assert.equal(env0.inserts.length, 0);
  assert.equal((await state(ws0)).bundles.pm, D, '넣을 것이 없으면 그날 저녁 묶음은 처리한 것으로(매 틱 다시 고르지 않는다)');
});

test('C9: 조용한 시간(23:00~08:00), 07:30 일정, 예외 아니오 — 밤 글 0, 08:00 묶음에 "이미 시작한 일정"', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('q1', at('07:30'), at('08:30'), { title: '조찬' })] });
  await run(ws, env, at('22:59', '2026-10-07'), at('08:05'));
  const night = env.inserts.filter((r) => r.at >= at('23:00', '2026-10-07') && r.at < at('08:00'));
  assert.equal(night.length, 0, '밤 글 0');
  assert.equal(env.calls.filter((c) => c.at >= at('23:00', '2026-10-07') && c.at < at('08:00')).length, 0, '조용한 시간에는 확인 자체를 하지 않는다(호출 0)');
  const am = env.inserts.find((r) => r.meta.assistant.kind === 'am');
  assert.ok(am, '아침 묶음');
  assert.equal(hhmm(am.at), '08:00');
  assert.match(am.body, /이미 시작한 일정\(조용한 시간 동안\)\n· 07:30 조찬/);
  assert.equal(env.inserts.filter((r) => r.meta.assistant.kind === 'pre').length, 0);
});

test('C10: 같은 상황, 일정 예외 켬 — 07:00에 시작 전 알림 1건', async () => {
  const ws = await company({ cfg: { quiet: { from: '23:00', to: '08:00', calendarAlerts: true } } });
  const env = fakeServer({ events: [ev('q1', at('07:30'), at('08:30'), { title: '조찬' })] });
  await run(ws, env, at('23:00', '2026-10-07'), at('07:20'));
  assert.deepEqual(env.inserts.map((r) => [hhmm(r.at), r.meta.assistant.kind]), [['07:00', 'pre']]);
});

test('C11: 잠자기 09:00~10:00, 09:40 일정 — 10:00 첫 틱 즉시 0, 다음 묶음(21:00)에 "확인 못 한 사이 지난 일정"', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('s1', at('09:40'), at('10:20'), { title: '디자인 리뷰' })] });
  await run(ws, env, at('08:50'), at('08:59'));
  await run(ws, env, at('10:00'), at('10:05'));
  assert.equal(env.inserts.length, 0, '깨어난 첫 틱에 즉시 알림 0');
  assert.equal((await state(ws)).pending.length, 1, '보류 목록에 지난 일정 1건');
  await run(ws, env, at('20:58'), at('21:02'));
  assert.equal(env.inserts.length, 1);
  assert.equal(env.inserts[0].meta.assistant.kind, 'pm');
  assert.match(env.inserts[0].body, /확인 못 한 사이 지난 일정\n· 09:40 디자인 리뷰/);
  assert.equal((await state(ws)).pending.length, 0, '보낸 뒤 보류 목록이 빈다');
});

test('C12: 메신저 로그아웃 / 세션 계정 ≠ 회사 주인 — 서버 호출 0, 상태 "로그인 필요"', async () => {
  for (const sessionOf of [() => null, (env) => ({ ...env.session, uid: 'someone-else' })]) {
    const ws = await company();
    const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))] });
    const s = sessionOf(env);
    await run(ws, env, at('13:25'), at('13:35'), { deps: depsFor(env, ws, { session: async () => s }) });
    assert.equal(env.calls.length, 0);
    assert.equal((await state(ws)).status.code, 'login_required');
  }
});

test('C13·D3: 리더 아닌 기기(또는 리스 확인 전) — 호출 0, 상태 파일도 열지 않는다. 같은 회사를 리더 기기가 돌리면 알림 1건', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))] });
  const now = at('13:30');
  const leases = [
    { syncOn: true, leader: false, ownedAt: 0, checkedAt: now },              // 다른 기기가 리더
    { syncOn: true, leader: true, ownedAt: 0, checkedAt: now },               // 기본값 leader:true — 획득한 리더십이 아니다
    { syncOn: true, leader: true, ownedAt: now - 30_000, checkedAt: now - 61_000 }, // 깨어난 첫 틱 — 리스 확인이 60초보다 오래됨
  ];
  for (const li of leases) {
    const r = await T.runAssistantTick(ws, { now, deps: depsFor(env, ws, { lease: () => li }) });
    assert.deepEqual(r, { ran: false, why: 'lease' }, JSON.stringify(li));
  }
  assert.equal(env.calls.length, 0);
  assert.equal(existsSync(stateFile(ws)), false, '리더가 아니면 상태 파일도 만들지 않는다');
  const ok = { syncOn: true, leader: true, ownedAt: now - 10_000, checkedAt: now - 5_000 };
  env.now = now;
  await T.runAssistantTick(ws, { now, deps: depsFor(env, ws, { lease: () => ok }) });
  assert.equal(env.inserts.length, 1, '확인된 리더 기기가 보낸다');
});

test('C14: 같은 사용자가 회사 2개에서 비서를 켬 — 나중에 켠 쪽만 실행, 일정 읽기 1벌, 14:00 알림 1번, 다른 쪽 상태 "다른 회사의 비서가 맡고 있음"', async () => {
  const older = await company({ cfg: { enabledAt: '2026-10-01T00:00:00Z' } });
  const newer = await company({ cfg: { enabledAt: '2026-10-02T00:00:00Z' } });
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))] });
  const deps = depsFor(env, null, { companyIds: async () => [older, newer] });
  for (let t = at('13:25'); t <= at('13:35'); t += MIN) {
    env.now = t;
    await T.runAssistantTick(older, { now: t, deps });
    await T.runAssistantTick(newer, { now: t, deps });
  }
  assert.equal(env.inserts.length, 1);
  assert.deepEqual(reads(env).map((c) => hhmm(c.at)), ['13:25', '13:30'], '읽기 1벌(13:25 첫 읽기 + 13:30 확인 읽기) — 두 회사면 두 벌');
  assert.equal((await state(older)).status.code, 'other_company');
  assert.equal(existsSync(stateFile(newer)), true);
});

/* ── 작성·배달 W7~W9 ── */

test('W7: 같은 기기 재시작 — 상태 파일로 이어가고, 리스 확인 전 호출 0, 같은 알림 중복 0', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))] });
  const leader = (t) => ({ syncOn: true, leader: true, ownedAt: t - 10_000, checkedAt: t - 1_000 });
  await run(ws, env, at('13:20'), at('13:30'), { deps: depsFor(env, ws, { lease: () => leader(env.now) }) });
  assert.equal(env.inserts.length, 1);
  T._resetAssistantForTest(); _resetAssistantConfigCacheForTest(); // 프로세스 재시작 — 메모리가 비고 리스는 아직 미획득(기본값 leader:true, ownedAt 0)
  const before = env.calls.length;
  env.now = at('13:31');
  assert.deepEqual(await T.runAssistantTick(ws, { now: env.now, deps: depsFor(env, ws, { lease: () => ({ syncOn: true, leader: true, ownedAt: 0, checkedAt: 0 }) }) }), { ran: false, why: 'lease' });
  assert.equal(env.calls.length, before, '리스 확인 전 호출 0');
  await run(ws, env, at('13:32'), at('14:10'), { deps: depsFor(env, ws, { lease: () => leader(env.now) }) });
  assert.equal(env.inserts.length, 1, '재시작 뒤 같은 14:00 알림을 다시 보내지 않는다(상태 파일의 보낸 키)');
  assert.ok(reads(env).some((c) => c.at === at('13:32')), '재시작 뒤 첫 확인된 틱은 일정을 새로 읽는다');
});

test('W8: 개인 공간 1:1 방을 열 수 없음(개인 행 없음·방 RPC 실패) — 조직 방으로 보내지 않음, 대기열 유지, 새 글 안 만듦, 상태 표시, 열리면 같은 글부터', async () => {
  const ws = await company();
  const env = fakeServer({
    events: [ev('e1', at('14:00'), at('15:00')), ev('e2', at('14:05'), at('15:00'))],
    crews: [{ id: 'crew-org', org_id: 'org-1', slug: 'pepper' }], // 조직 행만 있다
  });
  await run(ws, env, at('13:25'), at('13:40'));
  assert.equal(env.calls.filter((c) => c.name === 'insertMessage').length, 0, '조직 방으로 물러나지 않는다');
  let st = await state(ws);
  assert.equal(st.status.code, 'personal_room_unavailable');
  assert.equal(st.outbox.basis, `cal:e1:${iso(at('14:00'))}:pre`, '대기열은 첫 글 하나 그대로 — 13:35에 생긴 e2 알림은 새 글로 만들지 않는다');
  assert.deepEqual(env.calls.filter((c) => c.name === 'myCrews').map((c) => hhmm(c.at)), ['13:30', '13:31', '13:33', '13:37'], '재시도는 1·2·4분 간격, 그 뒤 5분(매 틱이 아니다)');
  // 방 RPC 실패도 같은 처리
  env.crews = [{ id: 'crew-p', org_id: null, slug: 'pepper' }]; env.failRoom = true;
  await run(ws, env, at('13:41'), at('13:48'));
  assert.equal(env.inserts.length, 0);
  assert.equal((await state(ws)).status.code, 'personal_room_unavailable');
  // 열리면 대기열 글(같은 client_msg_id·같은 본문)부터, 그다음 틱에 다음 알림
  env.failRoom = false;
  await run(ws, env, at('13:49'), at('14:03'));
  assert.equal(env.inserts[0].client_msg_id, clientMsgId('crew-p', `cal:e1:${iso(at('14:00'))}:pre`));
  assert.equal(hhmm(env.inserts[0].at), '13:52', '13:47 실패 뒤 5분');
  assert.match(env.inserts[0].body, /14:00 일정 e1 — 8분 뒤 시작/, '"N분 뒤"는 보내는 순간 기준(대기열에 머문 동안의 거짓 "30분 뒤" 금지)');
  assert.ok(env.inserts.some((r) => /14:05 일정 e2/.test(r.body)), 'e2는 대기열이 빈 뒤에 따로');
  st = await state(ws);
  assert.equal(st.outbox, null);
  assert.equal(st.status.code, 'ok');
});

test('W8b: 시작이 지나도록 못 보낸 시작 전 알림 — 대기열에서 빼고 지난 일정으로 다음 묶음에(거짓 "N분 뒤 시작" 금지)', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))] });
  env.failInsert = true;
  await run(ws, env, at('13:25'), at('14:20'));
  assert.equal(env.inserts.length, 0);
  const st = await state(ws);
  assert.equal(st.outbox, null);
  assert.deepEqual(st.pending.map((p) => [p.key, p.reason]), [[`cal:e1:${iso(at('14:00'))}:pre`, 'gap']]);
  env.failInsert = false;
  await run(ws, env, at('21:00'), at('21:01'));
  assert.match(env.inserts[0].body, /확인 못 한 사이 지난 일정\n· 14:00 일정 e1/);
});

test('W9: 메신저 알림 끈 목록에 assistant — 글 0, 서버 호출 0', async () => {
  const ws = await company({ msgr: { mutedEvents: ['assistant'] } });
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))] });
  await run(ws, env, at('13:00'), at('21:10'), { step: 5 * MIN });
  assert.equal(env.calls.length, 0);
  assert.equal((await state(ws)).status.code, 'muted');
  assert.equal(channelSends('msgr', { enabled: true }, 'assistant'), true, '끈 목록이 비면 보낸다');
  assert.deepEqual(normalizeMuted('msgr', ['assistant']), ['assistant'], '끄기가 저장에서 살아남는다');
});

/* ── 1차 분리 검수(#863) 반영 — 읽기 실패·혼자 보내는 시작 전 알림·묶음 기한·쉬기·쓰기 횟수·23505 ── */

test('읽기 실패 — 낡은 사본으로 지난 일정·묶음을 만들지 않는다: 밤에 생긴 07:30 일정은 다음 성공한 읽기가 찾아 아침 묶음에, 밤에 지운 일정은 알리지 않는다', async () => {
  // 밤사이 새로 생긴 일정 + 08:00 첫 읽기 실패 → 다음 15분 차례(08:15)에 다시 읽어 그 사이를 본다(설계 6절 — 확인 범위는 처리한 것으로만 옮긴다)
  const a = await company();
  const envA = fakeServer({ events: [] });
  await run(a, envA, at('22:50', '2026-10-07'), at('22:59', '2026-10-07'));
  envA.events = [ev('n1', at('07:30'), at('08:30'), { title: '밤에 잡힌 조찬' })];
  envA.failRead = true;
  await run(a, envA, at('07:58'), at('08:05'));
  assert.equal(envA.inserts.length, 0, '읽지 못한 동안 묶음을 만들지 않는다');
  assert.equal((await state(a)).status.code, 'calendar_error');
  envA.failRead = false;
  await run(a, envA, at('08:06'), at('08:20'));
  const amA = envA.inserts.filter((r) => r.meta.assistant.kind === 'am');
  assert.deepEqual(amA.map((r) => hhmm(r.at)), ['08:15'], '실패 뒤 다음 15분 차례에 다시 읽고 그때 아침 묶음');
  assert.match(amA[0].body, /이미 시작한 일정\(조용한 시간 동안\)\n· 07:30 밤에 잡힌 조찬/);
  // 22:50에 읽은 07:30 일정을 밤사이 지움 + 08:00 읽기 실패 → 낡은 사본으로 "이미 시작한 일정"을 만들지 않는다
  const b = await company();
  const envB = fakeServer({ events: [ev('d1', at('07:30'), at('08:30'), { title: '취소된 조찬' })] });
  await run(b, envB, at('22:50', '2026-10-07'), at('22:59', '2026-10-07'));
  envB.events = [];
  envB.failRead = true;
  await run(b, envB, at('07:58'), at('08:05'));
  envB.failRead = false;
  await run(b, envB, at('08:06'), at('08:20'));
  const morning = envB.inserts.filter((r) => r.at >= at('08:00'));
  assert.equal(morning.length, 0, '지운 일정을 알리지 않는다: ' + morning.map((r) => r.body).join(' | '));
});

test('시작 전 알림은 묶음 차례에도 혼자 보낸다(설계 7절 — 기준 = 키 하나): 묶음에 "곧 시작" 줄 없음, 상태 없는 새 리더가 같은 회차를 다시 보내도 DB가 한 번만', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('s1', at('08:20'), at('09:00'), { title: '스탠드업' }), ev('d1', at('00:00'), at('00:00', '2026-10-09'), { all_day: true, title: '워크숍' })] });
  await run(ws, env, at('07:59'), at('08:01'));
  assert.deepEqual(env.inserts.map((r) => [hhmm(r.at), r.meta.assistant.kind]), [['08:00', 'am'], ['08:00', 'pre']]);
  assert.equal(env.inserts[0].body, '[비서] 아침 정리 — 10월 8일(목)\n\n오늘 종일\n· 종일 워크숍', '묶음에는 곧 시작 줄이 없다 — 늦게 나가도 거짓 "N분 뒤"가 생기지 않는다');
  assert.equal(env.inserts[1].client_msg_id, clientMsgId('crew-p', `cal:s1:${iso(at('08:20'))}:pre`));
  assert.equal(env.inserts[1].body, '[비서] 곧 시작하는 일정\n· 08:20 스탠드업 — 20분 뒤 시작');
  // 리더 교체 — 기기 A가 13:30에 14:00 알림을 보낸 뒤, 이 회사 상태가 없는 기기 B가 13:31에 리더가 된다(낮의 아침 묶음 차례에 그 회차를 다시 넣지 않는다)
  const ws2 = await company();
  const env2 = fakeServer({ events: [ev('m1', at('14:00'), at('15:00'), { title: '미팅' })] });
  await run(ws2, env2, at('13:29'), at('13:30'));
  T._resetAssistantForTest(); _resetAssistantConfigCacheForTest();
  await rm(stateFile(ws2), { force: true });
  await run(ws2, env2, at('13:31'), at('13:33'));
  assert.equal(env2.inserts.filter((r) => /미팅/.test(r.body)).length, 1, env2.inserts.map((r) => `${hhmm(r.at)} ${r.body}`).join(' | '));
});

test('묶음 기한 — 저녁 묶음 시각까지 못 보낸 아침 묶음은 버리고 그 안의 지난 일정은 저녁 묶음으로 / 끈 채 이틀 지나 다시 켜면 지난 묶음 0', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('q1', at('07:30'), at('08:30'), { title: '조찬' }), ev('d1', at('00:00'), at('00:00', '2026-10-09'), { all_day: true, title: '워크숍' })] });
  await run(ws, env, at('22:59', '2026-10-07'), at('22:59', '2026-10-07'));
  env.failInsert = true;
  await run(ws, env, at('08:00'), at('20:55'), { step: 5 * MIN });
  assert.equal((await state(ws)).outbox?.kind, 'am', '아침 묶음이 대기열에 있다');
  env.failInsert = false;
  await run(ws, env, at('21:00'), at('21:02'));
  const today = env.inserts.filter((r) => r.at >= at('08:00'));
  assert.deepEqual(today.map((r) => [hhmm(r.at), r.meta.assistant.kind]), [['21:00', 'pm']], '기한 지난 아침 묶음은 보내지 않는다');
  assert.match(today[0].body, /^\[비서\] 저녁 정리 — 10월 8일\(목\)/);
  assert.match(today[0].body, /이미 시작한 일정\(조용한 시간 동안\)\n· 07:30 조찬/, '아침 묶음 안의 지난 일정은 보류 목록으로 돌아와 저녁 묶음에');
  assert.doesNotMatch(today[0].body, /오늘 종일/, '"오늘 종일"은 아침 묶음 몫 — 저녁에 옮겨 쓰지 않는다');
  // 아침 묶음이 대기열에 있는 채 끄고, 이틀 뒤 다시 켬 — 꺼짐은 파일을 열지 않으므로(D2) 기한이 지난 글을 버린다
  const ws2 = await company();
  const env2 = fakeServer({ events: [ev('d2', at('00:00'), at('00:00', '2026-10-09'), { all_day: true, title: '워크숍' })] });
  env2.failInsert = true;
  await run(ws2, env2, at('07:59'), at('08:02'));
  assert.equal((await state(ws2)).outbox?.kind, 'am');
  await writeCfg(ws2, { enabled: false, agent: 'pepper', tz: 'Asia/Seoul' });
  _resetAssistantConfigCacheForTest();
  await run(ws2, env2, at('08:03'), at('08:05'));
  await writeCfg(ws2, { enabled: true, agent: 'pepper', enabledAt: '2026-10-10T01:00:00Z', tz: 'Asia/Seoul' });
  _resetAssistantConfigCacheForTest();
  env2.failInsert = false; env2.events = [];
  await run(ws2, env2, at('10:05', '2026-10-10'), at('10:10', '2026-10-10'));
  assert.equal(env2.inserts.length, 0, '이틀 전 묶음을 보내지 않는다: ' + env2.inserts.map((r) => r.body).join(' | '));
  assert.equal((await state(ws2)).outbox, null);
});

test('쉬기에 들어가면(일정 보기 끔·다른 회사가 맡음) 대기열·보류 목록을 비운다 — 다시 맡았을 때 쉬기 전 글이 나가지 않는다', async () => {
  // 일정 보기 끔(idle)
  const ws = await company();
  const env = fakeServer({ events: [ev('q1', at('07:30'), at('08:30'), { title: '조찬' })] });
  await run(ws, env, at('22:59', '2026-10-07'), at('22:59', '2026-10-07'));
  env.failInsert = true;
  await run(ws, env, at('08:00'), at('08:02'));
  assert.equal((await state(ws)).outbox?.kind, 'am');
  const cfgFile = join(paths(ws).root, 'assistant.json');
  const base = JSON.parse(await readFile(cfgFile, 'utf8'));
  await writeCfg(ws, { ...base, watch: { calendar: false } });
  _resetAssistantConfigCacheForTest();
  await run(ws, env, at('08:03'), at('08:04'));
  let st = await state(ws);
  assert.deepEqual([st.outbox, st.pending], [null, []], '일정 보기를 끄면 대기열·보류가 빈다');
  await writeCfg(ws, base);
  _resetAssistantConfigCacheForTest();
  env.failInsert = false;
  await run(ws, env, at('08:05'), at('08:10'));
  assert.equal(env.inserts.filter((r) => r.at >= at('08:00')).length, 0, '다시 켠 뒤 쉬기 전 글이 나가지 않는다');
  // 다른 회사가 맡음(other_company)
  const older = await company({ cfg: { enabledAt: '2026-10-01T00:00:00Z' } });
  const newer = await company({ cfg: { enabled: false } });
  const env2 = fakeServer({ events: [ev('q2', at('07:30'), at('08:30'), { title: '조찬' })] });
  const deps2 = depsFor(env2, null, { companyIds: async () => [older, newer] });
  await run(older, env2, at('22:59', '2026-10-07'), at('22:59', '2026-10-07'), { deps: deps2 });
  env2.failInsert = true;
  await run(older, env2, at('08:00'), at('08:02'), { deps: deps2 });
  assert.equal((await state(older)).outbox?.kind, 'am');
  await writeCfg(newer, { enabled: true, agent: 'pepper', enabledAt: '2026-10-02T00:00:00Z', tz: 'Asia/Seoul' });
  _resetAssistantConfigCacheForTest();
  await run(older, env2, at('08:03'), at('08:04'), { deps: deps2 });
  st = await state(older);
  assert.equal(st.status.code, 'other_company');
  assert.deepEqual([st.outbox, st.pending], [null, []], '다른 회사가 맡으면 이 회사의 대기열·보류가 빈다');
  await writeCfg(newer, { enabled: false, agent: 'pepper', tz: 'Asia/Seoul' });
  _resetAssistantConfigCacheForTest();
  env2.failInsert = false;
  await run(older, env2, at('08:05'), at('08:10'), { deps: deps2 });
  assert.equal(env2.inserts.filter((r) => r.at >= at('08:00')).length, 0);
});

test('상태 파일은 바뀐 때만 쓴다 — 켜진 채 새 항목 없이 1시간이면 쓰기 5회 이하(첫 틱 1 + 15분마다 확인 범위 1)', async () => {
  const ws = await company();
  const env = fakeServer({ events: [] });
  let writes = 0;
  const d = depsFor(env, ws, { writeState: async (cid, st) => { writes += 1; return T.assistantDeps.writeState(cid, st); } });
  await run(ws, env, at('10:00'), at('11:00'), { deps: d });
  assert.ok(writes >= 1 && writes <= 5, `쓰기 ${writes}회(61틱)`);
});

test('23505(같은 client_msg_id가 이미 있음) — 보낸 것으로 기록하고 대기열을 비워, 같은 글을 다시 시도하지 않고 다음 알림을 막지 않는다', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00')), ev('e2', at('14:10'), at('15:00'))] });
  const k1 = `cal:e1:${iso(at('14:00'))}:pre`;
  env.ids.add(clientMsgId('crew-p', k1)); // 다른 기기(또는 응답만 끊긴 첫 시도)가 먼저 넣었다
  await run(ws, env, at('13:29'), at('13:45'));
  const st = await state(ws);
  assert.ok(st.sent[k1], '이미 있는 글의 키를 보낸 것으로 기록');
  assert.equal(st.outbox, null);
  assert.equal(st.status.code, 'ok');
  assert.deepEqual(env.inserts.map((r) => [hhmm(r.at), r.client_msg_id]), [['13:40', clientMsgId('crew-p', `cal:e2:${iso(at('14:10'))}:pre`)]], '다음 알림은 제때');
  assert.equal(env.calls.filter((c) => c.name === 'insertMessage').length, 2, '같은 글을 다시 시도하지 않는다(13:30 1회 + 13:40 1회)');
});

/* ── 버전 섞임·DB D1~D4 ── */

test('D1: 새 항목 0으로 1시간 — Supabase 쓰기 0(실제 supabase-js → 가짜 HTTP, 읽기는 일정 RPC와 처음 한 번의 방에서 복구), 상태 파일은 동기화 제외, 대화 기록 쓰기 0', async () => {
  const { startFakeSupabase } = await import('./helpers/fake-supabase-http.mjs');
  const { createClient } = await import('@supabase/supabase-js');
  const { makeDb } = await import('../src/gateway/msgr.mjs');
  const fake = await startFakeSupabase({ userId: 'u1' });
  try {
    const client = createClient(fake.url, 'anon-fake', { auth: { persistSession: false, autoRefreshToken: false } });
    const session = { client, db: makeDb(client), uid: 'u1' };
    const ws = await company();
    const chatsBefore = await readdir(paths(ws).chats).catch(() => []);
    const deps = depsFor({}, ws, { session: async () => session });
    for (let t = at('10:00'); t <= at('11:00'); t += MIN) await T.runAssistantTick(ws, { now: t, deps });
    const hits = fake.hits.map((h) => h.k);
    const calReads = hits.filter((k) => k === 'POST /rest/v1/rpc/office_event_list');
    assert.ok(calReads.length >= 4 && calReads.length <= 6, `읽기는 15분마다(${calReads.length}회): ${hits.join(', ')}`);
    // 3단계: 처음 맡는 틱에 방에서 복구 읽기 한 번(크루 행 → 행이 없으면 방·글 읽기 0). 그 밖의 요청은 없다(글·방·저장소 쓰기 0)
    assert.deepEqual(hits.filter((k) => k !== 'POST /rest/v1/rpc/office_event_list'), ['GET /rest/v1/msgr_crews'], '일정 읽기 RPC와 방에서 복구 읽기(GET) 한 번 말고는 아무 요청도 없다');
    assert.equal(EXCLUDE('.assistant/state.json'), true, '상태 파일은 동기화 업로드 대상이 아니다');
    assert.equal(EXCLUDE('.assistant'), true);
    assert.deepEqual(await readdir(paths(ws).chats).catch(() => []), chatsBefore, '대화 기록 파일 변화 0');
  } finally { await fake.close(); }
});

test('D2: 비서 꺼짐(assistant.json 없음 / enabled false / 에이전트 없음) — 호출 0, 상태 파일 0', async () => {
  for (const cfg of [null, { enabled: false }, { agent: '' }]) {
    const ws = await company({ cfg });
    const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))] });
    const out = await run(ws, env, at('13:25'), at('13:35'));
    assert.ok(out.every((r) => r.why === 'off'), JSON.stringify(cfg));
    assert.equal(env.calls.length, 0);
    assert.equal(existsSync(join(paths(ws).root, '.assistant')), false);
  }
});

test('D4: 에이전트가 파일 쓰기·셸로 assistant.json·비서 상태를 바꾸려 함 — 거부', async () => {
  const ws = await company();
  const root = paths(ws).root;
  const { makePermissionGate } = await import('../src/permission-gate.mjs');
  const gate = makePermissionGate(ws, 'pepper', root, null, 'ko', []);
  const deny = async (tool, input) => (await gate(tool, input)).behavior;
  assert.equal(await deny('Write', { file_path: join(root, 'assistant.json'), content: '{"enabled":true}' }), 'deny', '파일 쓰기로 메일 읽기·알림을 켜고 끄지 못한다');
  assert.equal(await deny('Edit', { file_path: join(root, 'assistant.json'), old_string: 'a', new_string: 'b' }), 'deny');
  assert.equal(await deny('Bash', { command: `echo '{"enabled":false}' > assistant.json` }), 'deny');
  assert.equal(await deny('Write', { file_path: join(root, '.assistant', 'state.json'), content: '{}' }), 'deny', '보낸 키·대기열을 고쳐 알림을 침묵시키지 못한다');
  assert.equal(await deny('Bash', { command: 'cat .assistant/state.json' }), 'deny');
  assert.equal(await deny('Bash', { command: 'rm -rf .assistant' }), 'deny', '폴더째 지우기(보낸 키·대기열 초기화)도 막는다');
  assert.equal(await deny('Bash', { command: `cat ${join(root, '.assistant', 'state.json')}` }), 'deny', '절대 경로');
  // 셸 확장으로 이름을 쪼개는 모양 — 경계 정규식이 앞뒤를 공백·따옴표·경로 구분자만 보던 때(6f1a8911) 통과했다(총괄 실측 10/8). 무경계 부분 문자열 시절에는 막혔다.
  // 끝 점 — Windows는 경로 이름 끝의 점을 지워 `.assistant.\\state.json`이 같은 폴더를 가리킨다(10/8 두 번째 보안 검토)
  for (const command of ['cat {.assistant,}/state.json', 'mv f .assistant{,}/state.json', 'cat x{,/.assistant}/state.json', 'cat .assistant?/state.json', 'printf x | tee -a :.assistant/state.json', 'cp f ~.assistant/x', 'type .assistant.\\state.json', 'del .assistant..\\state.json', 'cat .assistant./state.json']) {
    assert.equal(await deny('Bash', { command }), 'deny', command);
  }
  // 이름의 일부로 쓰인 경우는 그대로 통과(#863 1차 검수 MEDIUM — 남의 코드베이스 오차단)
  for (const command of ['python3 -c "print(client.beta.assistants.list())"', 'ls src/Chat.Assistant.tsx', 'grep -n message.assistant app.js', 'echo x.assistant .assistants', 'node -e "o.assistant.content"', 'ls .assistant.bak']) {
    assert.equal(await deny('Bash', { command }), 'allow', command);
  }
  assert.equal(await deny('Write', { file_path: join(root, 'vault', 'notes', 'assistant-ideas.md'), content: 'x' }), 'allow', '책상의 일반 문서는 그대로');
  assert.equal(isFileLockedRel('assistant.json'), true, '동기화도 같은 프로세스 간 잠금으로 쓴다');
});

/* ── 순수 모듈 ── */

test('설정 정규화 — 기본 꺼짐, 모르는 값은 기본값, 아침 ≥ 저녁이면 기본값', () => {
  const d = normalizeAssistantConfig(undefined);
  assert.equal(d.enabled, false);
  assert.equal(d.agent, null);
  assert.deepEqual([d.leadMinutes, d.morningAt, d.eveningAt, d.dailyCap], [30, '08:00', '21:00', 10]);
  assert.deepEqual(d.quiet, { from: '23:00', to: '08:00', calendarAlerts: false });
  assert.equal(normalizeAssistantConfig({ enabled: 'true' }).enabled, false, '켜짐은 true일 때만');
  assert.equal(normalizeAssistantConfig({ leadMinutes: 45 }).leadMinutes, 30);
  assert.equal(normalizeAssistantConfig({ leadMinutes: 15 }).leadMinutes, 15);
  assert.deepEqual([normalizeAssistantConfig({ morningAt: '22:00', eveningAt: '21:00' }).morningAt, normalizeAssistantConfig({ morningAt: '22:00' }).eveningAt], ['08:00', '21:00']);
  assert.equal(normalizeAssistantConfig({ dailyCap: 31 }).dailyCap, 10);
  assert.equal(normalizeAssistantConfig({ agent: '../x' }).agent, null);
  assert.equal(normalizeAssistantConfig({ tz: 'Mars/Base' }).tz, null);
  assert.equal(normalizeAssistantConfig({ tz: 'Asia/Seoul' }).tz, 'Asia/Seoul');
});

test('템플릿 문구 — 모든 키에 한국어·영어가 다 있다, 영어 회사는 영어 글', async () => {
  for (const [k, v] of Object.entries(ASSISTANT_TEXT)) {
    assert.ok(Array.isArray(v) && v.length === 2 && v[0].trim() && v[1].trim(), `${k}: ko/en 둘 다`);
  }
  const ws = await company({ lang: 'en' });
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'), { title: 'Client call', location: 'HQ' })] });
  await run(ws, env, at('13:29'), at('13:31'));
  assert.equal(env.inserts[0].body, '[Assistant] Starting soon\n· 14:00 Client call — starts in 30 min · at HQ');
});

test('메신저 알림 종류에 assistant — 이 채널이 보내는 전부를 열거한다(끄면 감시기가 글을 만들지 않는다)', () => {
  assert.ok(CHANNEL_EVENTS.msgr.includes('assistant'));
  assert.equal(CHANNEL_EVENTS.telegram.includes('assistant'), false, '텔레그램·슬랙은 비서 글을 보내지 않는다');
  assert.equal(CHANNEL_EVENTS.slack.includes('assistant'), false);
});

test('tickAssistant — 기다리지 않고, 같은 회사가 돌고 있으면 건너뛰고, 동기 예외도 던지지 않는다', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const set = new Set();
  let calls = 0;
  const run1 = () => { calls += 1; return gate; };
  assert.equal(T.tickAssistant('c1', { run: run1, set }), true);
  assert.equal(T.tickAssistant('c1', { run: run1, set }), false, '진행 중이면 건너뜀');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1);
  release(); await new Promise((r) => setTimeout(r, 5));
  assert.equal(set.has('c1'), false, '끝나면 풀린다');
  assert.doesNotThrow(() => T.tickAssistant('c2', { run: () => { throw new Error('sync boom'); }, set }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(set.has('c2'), false, '예외로 끝나도 풀린다');
});

test('허용 목록 — 이 파일의 모든 틱에서 감시기가 부른 서버 호출은 정해진 것뿐(설계 10절 "알림만")', () => {
  assert.ok(seenCalls.size > 0);
  for (const name of seenCalls) assert.ok(ALLOWED_CALLS.has(name), `허용 목록 밖 호출: ${name}`);
});
