// 능동 비서 엔진(tick.mjs, #894 3단계 위)에 메일 확인을 붙인 것 — 메일만 보는 비서·일정과 같이 보는 비서, 오늘 즉시 알림 수(같은 상한·방에서 복구),
// 아침·저녁 묶음 글의 메일 칸(바깥 글 표지), 유휴 틱의 쓰기·호출. 가짜 메신저 세션·가짜 오피스 메일 출처 — 실제 Gmail·운영 DB를 쓰지 않는다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-asst-mail-engine-'));
process.env.ARGO_ENC_VAULT = '0';
for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGO_SYNC']) delete process.env[k];

const { createCompany, updateCompany, paths } = await import('../src/workspace.mjs');
const T = await import('../src/assistant/tick.mjs');
const M = await import('../src/assistant/mail.mjs');
const { foldNotices } = await import('../src/assistant/recover.mjs');
const { _resetAssistantConfigCacheForTest, sealOf } = await import('../src/assistant/config.mjs');
const { stateFile } = await import('../src/assistant/state.mjs');

const D = '2026-10-08'; // 목요일
const at = (hm, day = D) => Date.parse(`${day}T${hm}:00+09:00`);
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const ACC = '11111111-2222-3333-4444-555555555555';

let seq = 0;
async function company({ calendar = false, mail = true } = {}) {
  const ws = `mail-eng-${++seq}`;
  await createCompany(ws, '메일 엔진', 'owner', 'u1', 'ko');
  await updateCompany(ws, (c) => ({ msgr: { ...(c.msgr ?? {}), enabled: true } }));
  const text = JSON.stringify({ enabled: true, agent: 'pepper', enabledAt: '2026-10-01T00:00:00Z', tz: 'Asia/Seoul', watch: { calendar, mail, tasks: false, deals: false } });
  await writeFile(join(paths(ws).root, 'assistant.json'), text);
  await updateCompany(ws, () => ({ assistantSeal: sealOf(text) }));
  return ws;
}
const mail = (gid, o = {}) => ({ id: `${ACC}.${gid}`, gid, account: ACC, threadId: `t-${gid}`, from: o.from ?? '김대리', addr: o.addr ?? 'kim@abc.co.kr', subject: o.subject ?? 'Hello', snippet: '', at: iso(o.at ?? at('09:05')), labels: o.labels ?? ['INBOX'] });

function world({ events = [] } = {}) {
  const env = { now: 0, inserts: [], ops: [], results: null, mailWrites: 0, mailState: null, events };
  env.session = { uid: 'u1', client: { async rpc(name, args) {
    env.ops.push(name);
    if (name === 'office_event_list') return { data: { events: env.events }, error: null };
    if (name === 'msgr_dm_personal_crew') return { data: `room-${args.crew}`, error: null };
    return { data: [], error: null };
  } }, db: {
    async myCrews() { return [{ id: 'crew-p', org_id: null, slug: 'pepper' }]; },
    async personalCrewsOf() { return [{ id: 'crew-p', org_id: null, slug: 'pepper', ws_id: 'x' }]; },
    async personalRoomsOf() { return []; },
    async assistantNotices() { return []; },
    async myOrgIds() { return []; },
    async insertMessage(row) { if (env.inserts.some((r) => r.client_msg_id === row.client_msg_id)) return null; env.inserts.push({ ...row, at: env.now }); return { id: 500 + env.inserts.length }; },
    async upload() {}, async insertAttachment() {},
  } };
  env.mail = { ...M.mailDeps,
    readState: async () => M.normalizeMailState(env.mailState),
    writeState: async (cid, s) => { env.mailWrites += 1; env.mailState = JSON.parse(JSON.stringify(s)); },
    accounts: async () => { env.ops.push('accounts'); return [{ id: ACC, address: 'me@x.com', status: 'ok' }]; },
    sync: async (entries) => { env.ops.push('sync'); const r = env.results ?? entries.map((e) => ({ account: e.account, historyId: e.since || '100', ...(e.since ? { changed: [] } : { primed: true }) })); env.results = null; return r; },
    thread: async () => { env.ops.push('thread'); return []; }, list: async () => ({ items: [], next: null }),
    customers: async () => [], usage: async () => ({ eq: 0, preps: 0 }), prep: async () => ({ prep: null, why: 'cli_tools' }),
    room: async () => ({ crewId: 'crew-p', channelId: 'room-crew-p' }) };
  return env;
}
const deps = (env, ws, extra = {}) => ({ ...T.assistantDeps, lease: () => ({ syncOn: false }), session: async () => env.session, agentExists: async () => true, companyIds: async () => [ws], mail: env.mail, ...extra });
async function run(ws, env, from, to, { step = MIN, d } = {}) {
  for (let t = from; t <= to; t += step) { env.now = t; await T.runAssistantTick(ws, { now: t, deps: d ?? deps(env, ws) }); }
}
beforeEach(() => { T._resetAssistantForTest(); M._resetMailForTest(); _resetAssistantConfigCacheForTest(); });

test('메일만 보는 비서(일정 끔) — 즉시 몫은 1:1 방 묶음 글, 오늘 즉시 알림 수에 키로 센다, 저녁 21:00 묶음 글은 메일 칸만으로(바깥 글 표지)', async () => {
  const ws = await company({ calendar: false, mail: true });
  const env = world();
  await run(ws, env, at('09:00'), at('09:00'));
  env.results = [{ account: ACC, historyId: '110', changed: [mail('a', { subject: '세금계산서 발행 요청' }), mail('n', { from: 'Stripe', addr: 'news@stripe.com', subject: 'Weekly', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] })] }];
  await run(ws, env, at('09:10'), at('09:10'));
  assert.equal(env.inserts.length, 1);
  assert.match(env.inserts[0].body, /^\[비서\] 확인할 것 하나\n1\. 계약·입금 메일 — 김대리/);
  assert.equal(env.inserts[0].channel_id, 'room-crew-p');
  assert.equal(env.inserts[0].meta.assistant.outside, true);
  const st = JSON.parse(await readFile(stateFile(ws), 'utf8'));
  assert.equal(st.day.instant, 1);
  assert.ok(st.day.keys.some((k) => k.startsWith('mailbatch:')));
  assert.ok(st.sent[`mail:${ACC}:a`] > 0, '보낸 키는 엔진 상태에도(방에서 복구와 같이)');
  await run(ws, env, at('21:00'), at('21:00'));
  const pm = env.inserts.at(-1);
  assert.match(pm.body, /^\[비서\] 저녁 정리 — 10월 8일\(목\)\n\n메일\n· 뉴스레터 1건\(Stripe\)/);
  assert.equal(pm.meta.assistant.kind, 'pm');
  assert.equal(pm.meta.assistant.outside, true, '메일 줄이 든 정리 글 — 방 문맥에는 표지 줄');
  assert.deepEqual(env.mailState.evening, [], '넣은 저녁 몫은 비운다(파일에도)');
  await run(ws, env, at('21:01'), at('21:05'));
  assert.equal(env.inserts.filter((r) => r.meta.assistant.kind === 'pm').length, 1, '저녁 묶음은 한 번');
});

test('일정과 같이 보는 비서 — 시작 전 알림은 그대로, 메일 즉시 몫과 같은 하루 상한 수, 저녁 묶음에 내일 일정 + 메일 칸', async () => {
  const ws = await company({ calendar: true, mail: true });
  const ev = (id, s) => ({ id, org_id: null, owner: 'u1', title: `일정 ${id}`, location: '', all_day: false, starts_at: iso(s), ends_at: iso(s + 3600e3), rrule: null, exdates: [], attendees: [] });
  const env = world({ events: [ev('e1', at('10:00')), ev('e2', at('10:00', '2026-10-09'))] });
  await run(ws, env, at('09:00'), at('09:00'));
  env.results = [{ account: ACC, historyId: '110', changed: [mail('a', { subject: '계약서 검토 부탁' }), mail('o', { from: '이과장', subject: '점심' })] }];
  await run(ws, env, at('09:10'), at('09:31'));
  assert.deepEqual(env.inserts.map((r) => r.meta.assistant.kind), ['mail_batch', 'pre']);
  const st = JSON.parse(await readFile(stateFile(ws), 'utf8'));
  assert.equal(st.day.instant, 2, '메일 즉시 1 + 시작 전 1');
  await run(ws, env, at('21:00'), at('21:00'));
  const pm = env.inserts.at(-1);
  assert.match(pm.body, /내일 일정 1건/);
  assert.match(pm.body, /메일\n· 그 밖의 새 메일 1건\(이과장\)/);
  assert.equal(pm.meta.assistant.outside, true);
});

test('유휴 — 새 메일 없는 한 시간: 메일 확인은 10분마다 sync 1번(평일 업무 시간), 메신저 글(DB 쓰기) 0·메일 상태 파일 쓰기 0', async () => {
  const ws = await company({ calendar: false, mail: true });
  const env = world();
  await run(ws, env, at('09:00'), at('09:00'));
  const writes = env.mailWrites; env.ops = [];
  await run(ws, env, at('09:01'), at('10:00'));
  assert.equal(env.ops.filter((o) => o === 'sync').length, 6, '09:10·…·10:00');
  assert.equal(env.ops.filter((o) => o !== 'sync').length, 0, '계정·스레드 다시 읽기 0');
  assert.equal(env.inserts.length, 0);
  assert.equal(env.mailWrites, writes, '메일 상태 파일 쓰기 0');
});

test('메일을 고르지 않은 비서 — 메일 호출 0(일정만 — #894 엔진 그대로)', async () => {
  const ws = await company({ calendar: true, mail: false });
  const env = world();
  await run(ws, env, at('09:00'), at('09:30'));
  assert.ok(!env.ops.some((o) => ['sync', 'accounts', 'thread'].includes(o)));
});

test('방에서 복구 — 다른 기기가 보낸 메일 즉시 알림도 오늘 수에 센다(meta.assistant.instant·dayKey), 한도 밖 목록 글은 세지 않는다', () => {
  const now = at('12:00');
  const rows = [
    { created_at: iso(at('09:10')), meta: { notification: 'assistant', assistant: { kind: 'mail_batch', keys: [`mail:${ACC}:a`], instant: true, dayKey: `mailbatch:mail:${ACC}:a` } } },
    { created_at: iso(at('09:20')), meta: { notification: 'assistant', assistant: { kind: 'mail_reply', keys: [`mail:${ACC}:b`], instant: true, dayKey: `mailreply:mail:${ACC}:b` } } },
    { created_at: iso(at('10:00')), meta: { notification: 'assistant', assistant: { kind: 'mail_batch', keys: [`mail:${ACC}:c`] } } },
  ];
  const rec = foldNotices(rows, { now, tz: 'Asia/Seoul' });
  assert.equal(rec.todayPre.length, 2);
  assert.ok(rec.sent[`mail:${ACC}:c`] > 0, '보낸 키는 모두');
});
