// 능동 비서 3단계 중 위험을 줄이는 부분(feat/assistant-writer) — 경우 표 Q(대기열 확인 읽기)·R(방에서 복구)·K(하루 즉시 알림 상한)·V(버전 섞임).
// 1단계 테스트(assistant-engine.test.mjs)와 같은 방식: 시계·세션·리스를 주입하고 설정·상태·회사는 임시 ARGO_ROOT의 실제 파일로 돈다.
// 가짜 서버는 실제 서버처럼 방마다 따로 센다 — 글의 유니크는 (방, 작성 크루, client_msg_id)이고(supabase/migrations/20260903120000_msgr.sql
// msgr_messages_client_id), 개인 1:1 방은 msgr_dm_personal_crew가 처음 부를 때 만든다(방 찾기 personalRoomsOf는 만들지 않는다).
// "기기 교대"는 같은 프로세스에서 메모리를 비우고(_resetAssistantForTest) 상태 파일을 지우거나 되돌려 흉내 낸다 — 기기마다 상태 파일은 로컬이다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile, rm } from 'node:fs/promises';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-asst-writer-'));
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGO_SYNC']) delete process.env[k];

const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const T = await import('../src/assistant/tick.mjs');
const { _resetAssistantConfigCacheForTest, sealOf } = await import('../src/assistant/config.mjs');
const { stateFile, normalizeState } = await import('../src/assistant/state.mjs');
const { clientMsgId } = await import('../src/assistant/deliver.mjs');
const { ASSISTANT_TEXT } = await import('../src/assistant/text.mjs');

const iso = (ms) => new Date(ms).toISOString();
const D = '2026-10-08'; // 목요일
const at = (hm, day = D) => Date.parse(`${day}T${hm}:00+09:00`);
const MIN = 60_000;
const hhmm = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(11, 16);

let seq = 0;
/** 설정 파일 쓰기 — 설정 API처럼 company.json 봉인도 같이(엔진은 봉인이 맞는 켜짐만 돌린다). */
async function writeCfg(ws, obj) {
  const text = JSON.stringify(obj);
  await writeFile(join(paths(ws).root, 'assistant.json'), text);
  await updateCompany(ws, () => ({ assistantSeal: sealOf(text) }));
}
async function company({ cfg = {}, ownerId = 'u1', lang = 'ko' } = {}) {
  const ws = `wr-${++seq}`;
  await createCompany(ws, '비서 테스트', 'owner', ownerId, lang);
  await updateCompany(ws, (c) => ({ msgr: { ...(c.msgr ?? {}), enabled: true } }));
  if (cfg !== null) await writeCfg(ws, { enabled: true, agent: 'pepper', enabledAt: '2026-10-01T00:00:00Z', tz: 'Asia/Seoul', ...cfg });
  return ws;
}
const ev = (id, start, end, extra = {}) => ({ id, org_id: null, owner: 'u1', title: `일정 ${id}`, location: '', all_day: false, starts_at: iso(start), ends_at: iso(end), rrule: null, exdates: [], attendees: [], ...extra });

/** 가짜 서버 — 방마다 따로 센다. crews = [{ id, org_id, slug, ws_id }]. */
function fakeServer({ events = [], uid = 'u1', crews = [] } = {}) {
  const env = { events, crews, calls: [], inserts: [], attempts: [], dups: [], rooms: new Set(), ids: new Set(), now: 0, failRead: false, failInsert: false, failRecover: false };
  const overlaps = (e, from, to) => Date.parse(e.starts_at) < to && (e.rrule ? true : Date.parse(e.ends_at) > from);
  const call = (name, extra = {}) => env.calls.push({ name, at: env.now, ...extra });
  env.session = {
    uid,
    client: {
      async rpc(name, args) {
        call(name, { args });
        if (name === 'office_event_list') {
          if (env.failRead) return { data: null, error: { message: 'read failed' } };
          const from = Date.parse(args.p_from); const to = Date.parse(args.p_to);
          return { data: { events: env.events.filter((e) => overlaps(e, from, to)).map((e) => ({ ...e })), orgs: [] }, error: null };
        }
        if (name === 'msgr_dm_personal_crew') { env.rooms.add(args.crew); return { data: `room-${args.crew}`, error: null }; } // 방이 없으면 만든다(실제 함수와 같다)
        return { data: null, error: { message: `unexpected rpc ${name}` } };
      },
    },
    db: {
      async myCrews(_u, ws) { call('myCrews'); return env.crews.filter((c) => c.ws_id === ws); },
      async insertMessage(row) {
        call('insertMessage'); env.attempts.push({ at: env.now, room: row.channel_id, id: row.client_msg_id });
        if (env.failInsert) throw new Error('network down');
        const k = `${row.channel_id}|${row.crew_id}|${row.client_msg_id}`;
        if (env.ids.has(k)) { env.dups.push({ at: env.now, id: row.client_msg_id }); return null; } // 23505
        env.ids.add(k);
        env.inserts.push({ ...row, at: env.now, created_at: iso(env.now), seq: env.inserts.length + 1 });
        return { id: env.inserts.length };
      },
      async personalCrewsOf(_u, wsIds) { call('personalCrewsOf'); if (env.failRecover) throw new Error('recover read failed'); return env.crews.filter((c) => c.org_id == null && wsIds.includes(c.ws_id)); },
      async personalRoomsOf(crewIds) { call('personalRoomsOf'); return crewIds.filter((id) => env.rooms.has(id)).map((id) => ({ id: `room-${id}`, personal_pair: `crew:${id}` })); },
      async assistantNotices(ch, crewId, since, limit) {
        call('assistantNotices', { since, limit });
        return env.inserts.filter((r) => r.channel_id === ch && r.crew_id === crewId && r.client_msg_id.startsWith('as:') && r.created_at >= since)
          .sort((a, b) => b.seq - a.seq).slice(0, limit).map((r) => ({ id: r.seq, meta: r.meta, created_at: r.created_at }));
      },
    },
  };
  return env;
}
const crewP = (ws) => ({ id: 'crew-p', org_id: null, slug: 'pepper', ws_id: ws });
const depsFor = (env, ids, extra = {}) => ({ ...T.assistantDeps, lease: () => ({ syncOn: false }), session: async () => env.session, agentExists: async () => true, companyIds: async () => ids, ...extra });
async function run(ws, env, from, to, { deps, ids = [ws], hook, step = MIN } = {}) {
  const d = deps ?? depsFor(env, ids);
  for (let t = from; t <= to; t += step) { env.now = t; if (hook) await hook(t); await T.runAssistantTick(ws, { now: t, deps: d }); }
}
const state = async (ws) => JSON.parse(await readFile(stateFile(ws), 'utf8'));
const named = (env, name) => env.calls.filter((c) => c.name === name).map((c) => hhmm(c.at));
/** 다른 기기로 교대 — 이 기기의 메모리를 비우고(프로세스가 다르다) 상태 파일을 그 기기 것으로 바꾼다(null = 그 기기엔 상태가 없다). */
async function switchDevice(ws, savedState = null) {
  T._resetAssistantForTest(); _resetAssistantConfigCacheForTest();
  if (savedState == null) await rm(stateFile(ws), { force: true });
  else await writeFile(stateFile(ws), savedState);
}
const preId = (crew, id, start) => clientMsgId(crew, `cal:${id}:${iso(start)}:pre`);

beforeEach(() => { T._resetAssistantForTest(); _resetAssistantConfigCacheForTest(); });

/* ── Q 대기열 확인 읽기 — 기기 한 대에서도 남는 위험(#863 2차 검수 LOW, H61) ── */

test('Q1: 배달이 막힌 사이 일정을 14:00 → 15:00으로 옮김 — 다시 보낼 때 확인 읽기로 옛 시각 글 0, 14:30에 15:00 글 1', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))], crews: [crewP(ws)] });
  env.failInsert = true;
  await run(ws, env, at('13:29'), at('13:31'));
  assert.equal((await state(ws)).outbox?.basis, `cal:e1:${iso(at('14:00'))}:pre`, '13:30·13:31 실패 — 대기열에 있다');
  env.events = [ev('e1', at('15:00'), at('16:00'))]; env.failInsert = false;
  await run(ws, env, at('13:32'), at('15:05'));
  assert.deepEqual(env.inserts.map((r) => [hhmm(r.at), r.body]), [['14:30', '[비서] 곧 시작하는 일정\n· 15:00 일정 e1 — 30분 뒤 시작']]);
  assert.ok(env.calls.some((c) => c.name === 'office_event_list' && c.at === at('13:33')), '13:33 다시 보내기 전에 확인 읽기');
});

test('Q2: 배달이 막힌 사이 일정을 지움 — 다시 보내지 않고, 저녁 묶음의 "지난 일정"에도 넣지 않는다', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))], crews: [crewP(ws)] });
  env.failInsert = true;
  await run(ws, env, at('13:29'), at('13:31'));
  env.events = []; env.failInsert = false;
  await run(ws, env, at('13:32'), at('21:05'), { step: MIN });
  assert.equal(env.inserts.length, 0, env.inserts.map((r) => `${hhmm(r.at)} ${r.body}`).join(' | '));
  const st = await state(ws);
  assert.deepEqual([st.outbox, st.pending], [null, []]);
});

test('Q3: 배달이 막힌 사이 제목·장소만 바뀜 — 다시 보낼 때 새 제목으로 1건(같은 client_msg_id)', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))], crews: [crewP(ws)] });
  env.failInsert = true;
  await run(ws, env, at('13:29'), at('13:31'));
  env.events = [ev('e1', at('14:00'), at('15:00'), { title: '거래처 미팅', location: '본사 2층' })]; env.failInsert = false;
  await run(ws, env, at('13:32'), at('13:40'));
  assert.equal(env.inserts.length, 1);
  assert.equal(env.inserts[0].body, '[비서] 곧 시작하는 일정\n· 14:00 거래처 미팅 — 27분 뒤 시작 · 장소: 본사 2층');
  assert.equal(env.inserts[0].client_msg_id, preId('crew-p', 'e1', at('14:00')));
});

test('Q4: 다시 보낼 때 확인 읽기가 실패 — 글 0·대기열 유지·재시도 간격 그대로(1·2·4·5분)·상태 "일정을 읽지 못함", 읽히면 그 글', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))], crews: [crewP(ws)] });
  env.failInsert = true;
  await run(ws, env, at('13:29'), at('13:31'));
  env.failInsert = false; env.failRead = true;
  await run(ws, env, at('13:32'), at('13:40'));
  assert.equal(env.inserts.length, 0, '확인하지 못한 알림은 보내지 않는다');
  const st = await state(ws);
  assert.equal(st.outbox?.basis, `cal:e1:${iso(at('14:00'))}:pre`, '대기열은 그대로');
  assert.equal(st.status.code, 'calendar_error');
  assert.deepEqual(env.calls.filter((c) => c.name === 'office_event_list' && c.at >= at('13:32')).map((c) => hhmm(c.at)), ['13:33', '13:37'], '확인 읽기는 재시도 차례에만(매 틱이 아니다)');
  env.failRead = false;
  await run(ws, env, at('13:41'), at('13:45'));
  assert.deepEqual(env.inserts.map((r) => [hhmm(r.at), r.client_msg_id]), [['13:42', preId('crew-p', 'e1', at('14:00'))]]);
  assert.match(env.inserts[0].body, /14:00 일정 e1 — 18분 뒤 시작/);
});

test('Q5: 대기열이 상태 파일에 남은 채 재시작 + 그 사이 일정 삭제 — 재시작 뒤 그 글을 보내지 않는다', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))], crews: [crewP(ws)] });
  env.failInsert = true;
  await run(ws, env, at('13:29'), at('13:30'));
  assert.ok((await state(ws)).outbox);
  T._resetAssistantForTest(); _resetAssistantConfigCacheForTest(); // 재시작(같은 기기 — 상태 파일 그대로)
  env.events = []; env.failInsert = false;
  await run(ws, env, at('13:35'), at('14:10'));
  assert.equal(env.inserts.length, 0, env.inserts.map((r) => r.body).join(' | '));
  assert.equal((await state(ws)).outbox, null);
});

/* ── R 방에서 복구 — 실행 기기가 바뀌거나 상태가 없는 기기가 맡을 때 이미 보낸 키를 1:1 방의 비서 글에서 읽어 합친다 ── */

test('R1: 리더 A → 상태 없는 B — A가 13:30에 보낸 14:00 알림을 B는 다시 넣으려 하지 않는다(글 넣기 시도 1·23505 0)', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('m1', at('14:00'), at('15:00'), { title: '미팅' })], crews: [crewP(ws)] });
  await run(ws, env, at('13:29'), at('13:30'));
  await switchDevice(ws, null);
  await run(ws, env, at('13:31'), at('14:00'));
  assert.equal(env.inserts.length, 1);
  assert.deepEqual(env.attempts.map((a) => hhmm(a.at)), ['13:30'], 'B는 글 넣기를 시도하지 않는다 — 실행 기기 교대마다 23505가 쌓이지 않는다');
  assert.equal(env.dups.length, 0);
  assert.ok((await state(ws)).sent[`cal:m1:${iso(at('14:00'))}:pre`], 'B의 상태에 A가 보낸 키');
});

test('R2: 상태 없는 B가 낮에 리더가 됨 — A가 08:00에 보낸 아침 묶음을 다시 만들지 않는다(늦은 아침 묶음 0)', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('d1', at('00:00'), at('00:00', '2026-10-09'), { all_day: true, title: '워크숍' })], crews: [crewP(ws)] });
  await run(ws, env, at('07:59'), at('08:01'));
  assert.deepEqual(env.inserts.map((r) => r.meta.assistant.kind), ['am']);
  await switchDevice(ws, null);
  await run(ws, env, at('13:40'), at('13:45'));
  assert.deepEqual(env.attempts.map((a) => hhmm(a.at)), ['08:00'], '늦은 아침 묶음을 만들지 않는다(같은 방이라도 23505 시도 0)');
  assert.equal((await state(ws)).bundles.am, D);
});

test('R3: 상태가 있는 A가 B의 리더 기간 뒤 돌아옴 — B가 알린 회차는 "지난 일정"에 다시 넣지 않고, 아무도 알리지 못한 회차만 저녁 묶음에', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('10:40'), at('11:00')), ev('e2', at('11:45'), at('12:30'))], crews: [crewP(ws)] });
  await run(ws, env, at('09:58'), at('10:00'));
  const aState = await readFile(stateFile(ws), 'utf8'); // A의 상태(확인 범위 09:58)
  await switchDevice(ws, null); // B가 10:01~11:00 리더
  await run(ws, env, at('10:01'), at('11:00'));
  assert.deepEqual(env.inserts.map((r) => [hhmm(r.at), r.meta.assistant.kind]), [['10:10', 'pre']], 'B가 10:40 회차를 알렸다');
  await switchDevice(ws, aState); // 11:00~12:00 아무도 안 돌고, A가 12:00에 돌아온다
  await run(ws, env, at('12:00'), at('12:02'));
  await run(ws, env, at('20:59'), at('21:01'));
  const pm = env.inserts.filter((r) => r.meta.assistant.kind === 'pm');
  assert.equal(pm.length, 1);
  assert.match(pm[0].body, /확인 못 한 사이 지난 일정\n· 11:45 일정 e2/);
  assert.doesNotMatch(pm[0].body, /10:40 일정 e1/, 'B가 이미 알린 회차');
});

test('R4: 비서를 회사 1(페퍼)에서 회사 2(울프)로 바꿈 — 회사 1이 보낸 14:00 알림·아침 묶음을 회사 2의 방에 다시 보내지 않는다(두 방 알림 0)', async () => {
  const ws1 = await company();
  const ws2 = await company({ cfg: { enabled: false, agent: 'wolff' } });
  const env = fakeServer({
    events: [ev('e1', at('14:00'), at('15:00')), ev('d1', at('00:00'), at('00:00', '2026-10-09'), { all_day: true, title: '워크숍' })],
    crews: [crewP(ws1), { id: 'crew-w', org_id: null, slug: 'wolff', ws_id: ws2 }],
  });
  const ids = [ws1, ws2];
  await run(ws1, env, at('07:59'), at('08:01'), { ids });
  await run(ws1, env, at('13:29'), at('13:30'), { ids });
  assert.deepEqual(env.inserts.map((r) => [r.channel_id, r.meta.assistant.kind]), [['room-crew-p', 'am'], ['room-crew-p', 'pre']]);
  // 13:40 회사 2로 바꿈 — 설정 API처럼 회사 1은 끄고(에이전트는 적어 둔다) 회사 2는 지금 켠다
  await writeFile(join(paths(ws1).root, 'assistant.json'), JSON.stringify({ enabled: false, agent: 'pepper', tz: 'Asia/Seoul' }));
  await writeCfg(ws2, { enabled: true, agent: 'wolff', enabledAt: iso(at('13:40')), tz: 'Asia/Seoul' });
  T._resetAssistantForTest(); _resetAssistantConfigCacheForTest();
  await run(ws2, env, at('13:40'), at('14:00'), { ids });
  assert.deepEqual(env.inserts.filter((r) => r.channel_id === 'room-crew-w').map((r) => `${hhmm(r.at)} ${r.body}`), [], '회사 2의 방에 같은 일정 0');
});

test('R4b: 쉬던 회사가 틈 없이 다시 맡음 — 회사 2(울프)가 비서였다가 회사 1(페퍼)을 켜 쉬는 동안 회사 1이 보낸 알림을, 회사 1을 끈 다음 틱에 회사 2가 다시 보내지 않는다', async () => {
  const ws1 = await company({ cfg: { enabled: false } });
  const ws2 = await company({ cfg: { agent: 'wolff', enabledAt: '2026-10-01T00:00:00Z' } });
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))], crews: [crewP(ws1), { id: 'crew-w', org_id: null, slug: 'wolff', ws_id: ws2 }] });
  const deps = depsFor(env, [ws1, ws2]);
  const both = async (from, to) => { for (let t = from; t <= to; t += MIN) { env.now = t; await T.runAssistantTick(ws1, { now: t, deps }); await T.runAssistantTick(ws2, { now: t, deps }); } };
  await both(at('13:20'), at('13:24')); // 회사 2가 비서 — 첫 틱에 복구까지 마쳤다
  await writeCfg(ws1, { enabled: true, agent: 'pepper', enabledAt: iso(at('13:25')), tz: 'Asia/Seoul' }); // 회사 1로 바꿈(나중에 켠 쪽이 맡는다)
  _resetAssistantConfigCacheForTest();
  await both(at('13:25'), at('13:35'));
  assert.equal((await state(ws2)).status.code, 'other_company', '회사 2는 쉬는 중');
  assert.deepEqual(env.inserts.map((r) => [hhmm(r.at), r.channel_id]), [['13:30', 'room-crew-p']]);
  await writeFile(join(paths(ws1).root, 'assistant.json'), JSON.stringify({ enabled: false, agent: 'pepper', tz: 'Asia/Seoul' })); // 회사 1 끄기
  _resetAssistantConfigCacheForTest();
  await both(at('13:36'), at('13:59')); // 회사 2는 매분 돌고 있었다 — 틈(gap)이 없다
  assert.deepEqual(env.inserts.map((r) => [hhmm(r.at), r.channel_id]), [['13:30', 'room-crew-p']], '회사 2의 방에 14:00 알림 0');
});

test('R3b: 다른 기기가 이미 묶음으로 알린 지난 일정은 내 보류 목록에서도 뺀다 — 다음 날 아침 묶음에 다시 나오지 않는다', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('s1', at('09:40'), at('10:20'), { title: '디자인 리뷰' })], crews: [crewP(ws)] });
  await run(ws, env, at('08:40'), at('08:45'));
  const bState = await readFile(stateFile(ws), 'utf8'); // B(확인 범위 08:40)
  await switchDevice(ws, null); // A — 08:50부터, 09:00~10:00 잠자기 → 09:40 회차는 A의 보류 목록에
  await run(ws, env, at('08:50'), at('08:59'));
  await run(ws, env, at('10:00'), at('10:05'));
  const aState = await readFile(stateFile(ws), 'utf8');
  assert.equal(JSON.parse(aState).pending.length, 1);
  await switchDevice(ws, bState); // B가 10:30부터 맡아 같은 회차를 찾고 21:00 저녁 묶음으로 알린다
  await run(ws, env, at('10:30'), at('21:01'));
  assert.deepEqual(env.inserts.map((r) => [hhmm(r.at), r.meta.assistant.kind]), [['21:00', 'pm']]);
  await switchDevice(ws, aState); // A가 돌아와 다음 날 아침까지
  await run(ws, env, at('21:10'), at('21:12'));
  await run(ws, env, at('07:59', '2026-10-09'), at('08:01', '2026-10-09'));
  assert.equal(env.inserts.length, 1, env.inserts.map((r) => `${hhmm(r.at)} ${r.body}`).join(' | '));
  assert.equal(env.dups.length, 0, 'A는 B가 보낸 저녁 묶음을 다시 넣으려 하지 않는다(23505 0)');
  assert.deepEqual((await state(ws)).pending, []);
});

test('R5: 방에서 복구 읽기가 실패 — 그 틱은 전처럼 진행(같은 방은 DB가 중복을 막는다), 5분 뒤 다시 읽고 매 틱 읽지 않는다', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))], crews: [crewP(ws)] });
  env.failRecover = true;
  await run(ws, env, at('13:25'), at('13:33'));
  assert.deepEqual(env.inserts.map((r) => hhmm(r.at)), ['13:30'], '복구를 못 해도 알림은 나간다');
  env.failRecover = false;
  await run(ws, env, at('13:34'), at('13:50'));
  assert.deepEqual(named(env, 'personalCrewsOf'), ['13:25', '13:30', '13:35'], '실패 뒤 5분마다, 성공하면 그만');
});

test('R6: 대기열 글을 그사이 다른 기기가 이미 보냄 — 넣기 시도 0(23505 0). 묶음이면 그 안의 보낸 적 없는 지난 일정은 다음 묶음으로', async () => {
  // 시작 전 알림
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))], crews: [crewP(ws)] });
  env.failInsert = true;
  await run(ws, env, at('13:29'), at('13:30'));
  const aState = await readFile(stateFile(ws), 'utf8');
  env.failInsert = false;
  await switchDevice(ws, null);
  await run(ws, env, at('13:31'), at('13:32'));
  assert.equal(env.inserts.length, 1, 'B가 보냈다');
  await switchDevice(ws, aState);
  await run(ws, env, at('13:40'), at('13:45'));
  assert.equal(env.dups.length, 0, 'A는 대기열 글을 다시 넣지 않는다');
  assert.equal((await state(ws)).outbox, null);
  // 아침 묶음 — A의 묶음에는 밤사이 지난 일정(07:30)이 있고, 상태 없는 B의 아침 묶음에는 없다
  const ws2 = await company();
  const env2 = fakeServer({ events: [ev('q1', at('07:30'), at('08:30'), { title: '조찬' }), ev('d1', at('00:00'), at('00:00', '2026-10-09'), { all_day: true, title: '워크숍' })], crews: [crewP(ws2)] });
  await run(ws2, env2, at('22:59', '2026-10-07'), at('22:59', '2026-10-07'));
  env2.failInsert = true;
  await run(ws2, env2, at('08:00'), at('08:01'));
  assert.equal((await state(ws2)).outbox?.kind, 'am');
  const a2 = await readFile(stateFile(ws2), 'utf8');
  env2.failInsert = false;
  await switchDevice(ws2, null);
  await run(ws2, env2, at('08:02'), at('08:03'));
  const morning = env2.inserts.filter((r) => r.at >= at('08:00')); // 22:59의 글은 전날 저녁 묶음(내일 일정)
  assert.deepEqual(morning.map((r) => r.meta.assistant.kind), ['am']);
  assert.doesNotMatch(morning[0].body, /조찬/, 'B의 아침 묶음엔 A만 아는 지난 일정이 없다');
  await switchDevice(ws2, a2);
  await run(ws2, env2, at('08:10'), at('08:12'));
  await run(ws2, env2, at('20:59'), at('21:01'));
  assert.equal(env2.dups.length, 0, 'A는 묶음을 다시 넣지 않는다');
  const pm = env2.inserts.filter((r) => r.meta.assistant.kind === 'pm' && r.at >= at('08:00'));
  assert.equal(pm.length, 1);
  assert.match(pm[0].body, /이미 시작한 일정\(조용한 시간 동안\)\n· 07:30 조찬/, 'A만 알던 지난 일정은 저녁 묶음으로 — 잃지 않는다');
});

test('R7·R8: 로그아웃이면 복구 호출 0 / 조용한 시간에 켜지면 복구는 08:00 첫 틱에', async () => {
  const ws = await company();
  const env = fakeServer({ events: [], crews: [crewP(ws)] });
  await run(ws, env, at('13:25'), at('13:30'), { deps: depsFor(env, [ws], { session: async () => null }) });
  assert.equal(env.calls.length, 0);
  assert.equal((await state(ws)).status.code, 'login_required');
  const ws2 = await company();
  const env2 = fakeServer({ events: [], crews: [crewP(ws2)] });
  await run(ws2, env2, at('23:30', '2026-10-07'), at('08:01'), { step: 5 * MIN });
  assert.deepEqual(named(env2, 'personalCrewsOf'), ['08:00'], '조용한 시간에는 호출 0');
});

test('R9(모양): 복구는 같은 주인의 비서 방만 — 꺼진 회사도 에이전트가 적혀 있으면 그 방을 읽고, 다른 주인의 회사·방이 없는 크루는 읽지 않는다', async () => {
  const ws1 = await company();
  const off = await company({ cfg: { enabled: false, agent: 'wolff' } });
  const stranger = await company({ ownerId: 'u9', cfg: { enabled: false, agent: 'kim' } });
  const env = fakeServer({ events: [], crews: [crewP(ws1), { id: 'crew-w', org_id: null, slug: 'wolff', ws_id: off }, { id: 'crew-org', org_id: 'org-1', slug: 'pepper', ws_id: ws1 }] });
  env.rooms.add('crew-w');
  const seen = [];
  const s0 = env.session;
  env.session = { ...s0, db: { ...s0.db, async personalCrewsOf(u, wsIds) { seen.push(['crews', [...wsIds].sort()]); return s0.db.personalCrewsOf(u, wsIds); }, async personalRoomsOf(cids) { seen.push(['rooms', [...cids].sort()]); return s0.db.personalRoomsOf(cids); }, async assistantNotices(ch, cid, since, limit) { seen.push(['notices', ch, cid, limit]); return s0.db.assistantNotices(ch, cid, since, limit); } } };
  await run(ws1, env, at('10:00'), at('10:00'), { ids: [ws1, off, stranger] });
  assert.deepEqual(seen, [['crews', [off, ws1].sort()], ['rooms', ['crew-p', 'crew-w']], ['notices', 'room-crew-w', 'crew-w', 300]], '방이 있는 크루만, 방 하나씩');
  assert.equal(env.calls.find((c) => c.name === 'assistantNotices').since, iso(at('10:00') - 14 * 86_400_000), '최근 14일');
});

test('R11: 잠자기·재시작 뒤 복구는 지난 복구 뒤(오늘 글은 전부)만 읽는다 — 같은 글을 매번 14일치 내려받지 않는다. 읽는 방이 바뀌면 다시 14일', async () => {
  const ws = await company();
  const env = fakeServer({ events: [], crews: [crewP(ws)] });
  env.rooms.add('crew-p');
  env.now = at('09:00');
  await env.session.db.insertMessage({ channel_id: 'room-crew-p', author_kind: 'crew', crew_id: 'crew-p', client_msg_id: clientMsgId('crew-p', 'sum:am:2026-10-08'), body: 'x', meta: { notification: 'assistant', assistant: { v: 1, kind: 'am', keys: ['sum:am:2026-10-08'] } } });
  const since = () => env.calls.filter((c) => c.name === 'assistantNotices').map((c) => c.since);
  await run(ws, env, at('10:00'), at('10:00')); // 처음 — 14일
  await run(ws, env, at('11:00'), at('11:00')); // 잠자기 뒤 — 오늘 0시(지난 복구 끝 09:00 − 10분보다 이르다)
  await run(ws, env, at('08:30', '2026-10-09'), at('08:30', '2026-10-09')); // 다음 날 — 지난 복구 끝 09:00 − 10분(오늘 0시보다 이르다)
  assert.deepEqual(since(), [iso(at('10:00') - 14 * 86_400_000), iso(at('00:00')), iso(at('08:50'))]);
  T._resetAssistantForTest(); _resetAssistantConfigCacheForTest(); // 재시작 — 상태 파일의 끝을 이어 쓴다
  await run(ws, env, at('09:00', '2026-10-09'), at('09:00', '2026-10-09'));
  assert.equal(since().at(-1), iso(at('08:50')));
  const st = await state(ws);
  assert.equal(st.rec.to, at('09:00'), '지난 복구에서 본 마지막 글(서버 시각)');
  await writeCfg(ws, { enabled: true, agent: 'wolff', enabledAt: '2026-10-01T00:00:00Z', tz: 'Asia/Seoul' }); // 에이전트를 바꿈 — 읽는 방이 바뀐다
  T._resetAssistantForTest(); _resetAssistantConfigCacheForTest();
  env.crews.push({ id: 'crew-w', org_id: null, slug: 'wolff', ws_id: ws }); env.rooms.add('crew-w');
  await run(ws, env, at('09:30', '2026-10-09'), at('09:30', '2026-10-09'));
  assert.equal(since().at(-1), iso(at('09:30', '2026-10-09') - 14 * 86_400_000), '방이 바뀌면 14일');
});

/* ── K 하루 즉시 알림 상한(설계 9절) — 일정 시작 전 알림은 미루지도 버리지도 않고 바로 보낸다. 상한에 처음 걸린 글 끝에 한 줄 ── */

const tail = (n) => `\n오늘 즉시 알림이 ${n}건을 넘어 이후는 목록으로만 보내요.`;

test('K1·K7: 상한 3, 일정 5개 — 1~3번째(정확히 상한) 꼬리 없음, 4번째(상한+1) 꼬리 한 줄(대기열에서 다시 보내도 유지), 5번째 꼬리 없음, 모두 제때', async () => {
  const ws = await company({ cfg: { dailyCap: 3 } });
  const hours = ['10:00', '11:00', '12:00', '13:00', '14:00'];
  const env = fakeServer({ events: hours.map((h, i) => ev(`k${i + 1}`, at(h), at(h) + 30 * MIN)), crews: [crewP(ws)] });
  await run(ws, env, at('09:29'), at('12:29'));
  env.failInsert = true; // 4번째(12:30)는 한 번 막혔다가 다시 나간다 — 꼬리가 그대로여야 한다
  await run(ws, env, at('12:30'), at('12:30'));
  env.failInsert = false;
  await run(ws, env, at('12:31'), at('13:31'));
  assert.deepEqual(env.inserts.map((r) => hhmm(r.at)), ['09:30', '10:30', '11:30', '12:31', '13:30'], '상한 뒤에도 미루거나 버리지 않고 바로');
  const bodies = env.inserts.map((r) => r.body);
  for (const i of [0, 1, 2, 4]) assert.ok(!bodies[i].includes('오늘 즉시 알림이'), `${i + 1}번째: 꼬리 없음 — ${bodies[i]}`);
  assert.equal(bodies[3], `[비서] 곧 시작하는 일정\n· 13:00 일정 k4 — 29분 뒤 시작${tail(3)}`);
  assert.equal(env.inserts[3].meta.assistant.capNote, true, '꼬리를 붙인 글이라는 표시(다른 기기가 방에서 복구할 때 다시 붙이지 않게)');
  const st = await state(ws);
  assert.deepEqual([st.day.date, st.day.instant, st.day.capNoted], [D, 5, true]);
});

test('K2·K4: 기본 상한 10 — 11번째에 꼬리, 날짜가 바뀌면 0부터 다시', async () => {
  const ws = await company();
  const mk = (day) => Array.from({ length: 11 }, (_, i) => ev(`${day}-${i}`, at(`${String(9 + i).padStart(2, '0')}:00`, day), at(`${String(9 + i).padStart(2, '0')}:20`, day)));
  const D2 = '2026-10-09';
  const env = fakeServer({ events: [...mk(D), ...mk(D2)], crews: [crewP(ws)] });
  await run(ws, env, at('08:29'), at('19:31'), { step: MIN });
  await run(ws, env, at('08:29', D2), at('19:31', D2), { step: MIN });
  const withTail = env.inserts.filter((r) => r.body.includes('오늘 즉시 알림이'));
  assert.deepEqual(withTail.map((r) => [new Date(r.at + 9 * 3600_000).toISOString().slice(0, 16), r.body.endsWith(tail(10))]), [[`${D}T18:30`, true], [`${D2}T18:30`, true]]);
  assert.equal(env.inserts.filter((r) => r.meta.assistant.kind === 'pre').length, 22);
});

test('K3: 상한을 기기 교대에도 센다 — A가 3건(상한 3) 보낸 뒤 상태 없는 B의 첫 알림에 꼬리, A가 이미 꼬리를 붙였으면 B는 붙이지 않는다', async () => {
  const ws = await company({ cfg: { dailyCap: 3 } });
  const hours = ['10:00', '11:00', '12:00', '13:00', '14:00'];
  const env = fakeServer({ events: hours.map((h, i) => ev(`k${i + 1}`, at(h), at(h) + 30 * MIN)), crews: [crewP(ws)] });
  await run(ws, env, at('09:29'), at('11:31'));
  await switchDevice(ws, null);
  await run(ws, env, at('12:00'), at('12:31'));
  assert.equal(env.inserts[3].body.endsWith(tail(3)), true, `B의 첫 알림 = 오늘 4번째: ${env.inserts[3].body}`);
  assert.equal((await state(ws)).day.instant, 4);
  await switchDevice(ws, null);
  await run(ws, env, at('13:00'), at('13:31'));
  assert.equal(env.inserts.length, 5);
  assert.equal(env.inserts[4].body.includes('오늘 즉시 알림이'), false, 'C의 알림(5번째) — 꼬리는 하루 한 번');
});

test('K5: 꼬리 문구 ko/en — 영어 회사는 영어 꼬리', async () => {
  assert.deepEqual(ASSISTANT_TEXT['tail.cap'], ['오늘 즉시 알림이 {n}건을 넘어 이후는 목록으로만 보내요.', 'More than {n} instant alerts today — the rest come as a plain list.']);
  const ws = await company({ lang: 'en', cfg: { dailyCap: 1 } });
  const env = fakeServer({ events: [ev('x1', at('10:00'), at('10:30')), ev('x2', at('11:00'), at('11:30'))], crews: [crewP(ws)] });
  await run(ws, env, at('09:29'), at('10:31'));
  assert.deepEqual(env.inserts.map((r) => r.body), [
    '[Assistant] Starting soon\n· 10:00 일정 x1 — starts in 30 min',
    '[Assistant] Starting soon\n· 11:00 일정 x2 — starts in 30 min\nMore than 1 instant alerts today — the rest come as a plain list.',
  ]);
});

/* ── V 버전 섞임 ── */

test('V4: 옛 버전(엔진 2, 0.1.99) 기기가 보낸 글 모양(meta.assistant.keys)도 복구된다 — 이 PR 전 엔진이 쓴 글을 그대로 넣어 확인', async () => {
  const ws = await company();
  const env = fakeServer({ events: [ev('e1', at('14:00'), at('15:00'))], crews: [crewP(ws)] });
  env.rooms.add('crew-p');
  const key = `cal:e1:${iso(at('14:00'))}:pre`;
  env.now = at('13:30');
  await env.session.db.insertMessage({ // 0.1.99 deliver.mjs insertNotice가 만든 행 모양 그대로
    channel_id: 'room-crew-p', author_kind: 'crew', crew_id: 'crew-p', kind: 'text', reply_to: null, thread_root: null,
    client_msg_id: clientMsgId('crew-p', key), body: '[비서] 곧 시작하는 일정\n· 14:00 일정 e1 — 30분 뒤 시작', mentions: [],
    meta: { disposition: 'done', notification: 'assistant', assistant: { v: 1, kind: 'pre', keys: [key], items: [{ key, source: 'calendar', eventId: 'e1', at: iso(at('14:00')) }] } },
  });
  env.attempts.length = 0;
  await run(ws, env, at('13:31'), at('13:59'));
  assert.deepEqual([env.attempts.length, env.dups.length, env.inserts.length], [0, 0, 1]);
});

test('V5: 새 상태 칸(day.capNoted)은 정규화가 읽고, 옛 칸만 있는 상태 파일도 그대로 읽힌다', () => {
  assert.deepEqual(normalizeState({ day: { date: D, instant: 4, capNoted: true } }).day, { date: D, instant: 4, capNoted: true });
  assert.deepEqual(normalizeState({ day: { date: D, instant: 4 } }).day, { date: D, instant: 4, capNoted: false }, '0.1.99가 쓴 상태 파일');
  assert.deepEqual(normalizeState({ day: { date: D, instant: 4, capNoted: 'yes' } }).day.capNoted, false);
});
