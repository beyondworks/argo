// 메신저 기록 옮기기(src/msgr-archive.mjs·msgr-archive-run.mjs, 0.1.113) — 경우 표 칸마다 행동 시험. 가짜 Supabase는 실제 supabase-js가 붙고 요청 수·바이트를 기록한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
import { fakeMsgr } from './helpers/fake-msgr-archive.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-archive-'));
const A = await import('../src/msgr-archive.mjs');
const R = await import('../src/msgr-archive-run.mjs');
const { paths } = await import('../src/workspace.mjs');
const { EXCLUDE, isMsgrArchiveRel } = await import('../src/sync.mjs');
const V = await import('../app/c/[ws]/settings/msgr-archive-view.mjs');

const ME = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222'; // AI 사용 동의를 거부한 사람이라고 치자(이관은 동의와 무관하게 사람이 읽을 수 있게 남긴다)
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const CREW = 'cccccccc-0000-4000-8000-000000000001';
const noSleep = async () => {};
let seq = 0;
const tmpDir = async (name) => { const d = join(process.env.ARGO_ROOT, `t${++seq}-${name}`); await mkdir(d, { recursive: true }); return d; };

/** 방 다섯 종류(조직 채널·친구 1:1·그룹·에이전트 1:1·보관된 옛 조직 1:1) + 반응·결재·첨부·조직 문서. */
function sampleDb() {
  const ch = (id, o) => ({ id, org_id: null, kind: 'dm', name: null, topic: null, personal_pair: null, created_at: '2026-09-01T00:00:00Z', archived_at: null, ...o });
  const channels = [
    ch('c0000001-0000-4000-8000-000000000001', { org_id: ORG, kind: 'public', name: '일반' }),
    ch('c0000002-0000-4000-8000-000000000002', { personal_pair: `${ME}:${BOB}` }),
    ch('c0000003-0000-4000-8000-000000000003', { name: '주말 모임' }),
    ch('c0000004-0000-4000-8000-000000000004', { personal_pair: `crew:${CREW}`, name: '페퍼' }),
    ch('c0000005-0000-4000-8000-000000000005', { org_id: ORG, archived_at: '2026-10-01T00:00:00Z' }),
  ];
  let id = 0;
  const msg = (channel, o) => ({ id: ++id, channel_id: channel, org_id: null, author_kind: 'user', author_user_id: ME, crew_id: null, kind: 'text', body: '', meta: null, mentions: [], reply_to: null, thread_root: null, created_at: `2026-09-0${(id % 9) + 1}T03:0${id % 10}:00Z`, edited_at: null, ...o });
  const messages = [
    msg(channels[0].id, { org_id: ORG, body: '조직 채널 첫 글' }),
    msg(channels[0].id, { org_id: ORG, author_kind: 'crew', author_user_id: null, crew_id: CREW, kind: 'approval_card', body: '결재 요청: 메일 보내기' }),
    msg(channels[1].id, { author_user_id: BOB, body: '동의 거부자 밥의 글' }),
    msg(channels[2].id, { body: '그룹 글, 첨부 있음' }),
    msg(channels[3].id, { author_kind: 'crew', author_user_id: null, crew_id: CREW, body: '에이전트 답' }),
    msg(channels[4].id, { org_id: ORG, body: '보관된 옛 조직 1:1' }),
    msg(channels[0].id, { org_id: ORG, body: '지운 글', deleted_at: '2026-09-05T00:00:00Z' }),
  ];
  return {
    pause: { paused: true, since: '2026-10-16T17:00:00+09:00' },
    msgr_orgs: [{ id: ORG, name: '비욘드' }],
    msgr_channels: channels,
    msgr_messages: messages,
    msgr_channel_members: [
      { channel_id: channels[1].id, member_kind: 'user', member_id: ME }, { channel_id: channels[1].id, member_kind: 'user', member_id: BOB },
      { channel_id: channels[3].id, member_kind: 'crew', member_id: CREW },
    ],
    msgr_reactions: [{ message_id: 1, user_id: BOB, emoji: '👍', created_at: '2026-09-02T00:00:00Z' }],
    msgr_attachments: [{ message_id: 4, storage_path: `p/${channels[2].id}/4/plan.pdf`, name: 'plan.pdf', mime: 'application/pdf', bytes: 5 }],
    msgr_crew_approvals: [{ message_id: 2, approval_id: 'ap-1', action: '메일 보내기', reason: null, status: 'approved', decided_by: ME, decided_at: '2026-09-03T00:00:00Z' }],
    msgr_org_docs: [{ id: 'd1', org_id: ORG, channel_id: null, path: 'journal/2026-09-01.md', title: '일지', body: '조직 일지 본문', version: 1, updated_at: '2026-09-01T00:00:00Z', updated_by: ME }],
    msgr_crews: [{ id: CREW, display_name: '페퍼' }],
    people: { [ME]: '유건', [BOB]: '밥' },
    files: { [`p/${channels[2].id}/4/plan.pdf`]: Buffer.from('%PDF1') },
  };
}
const roomDirs = async (dir) => (await readdir(join(dir, 'rooms'))).sort();
const jsonlIds = async (file) => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).id);

test('첫 실행 — 방 다섯 종류·메시지·반응·결재·첨부·조직 문서를 Markdown과 원본 JSON으로 남기고, 요청 수·바이트를 기록한다', async (t) => {
  const fake = await fakeMsgr(sampleDb()); t.after(() => fake.close());
  const dir = await tmpDir('first');
  const st = await A.runArchive({ client: fake.client, uid: ME, dir, sleep: noSleep });
  assert.equal(st.status, 'done');
  assert.equal(st.totals.rooms, 5); assert.equal(st.totals.roomsDone, 5);
  assert.equal(st.totals.messages, 6, '지운 글은 빼고 6개');
  assert.equal(st.totals.attachments, 1);
  const rooms = await roomDirs(dir);
  assert.equal(rooms.length, 5);
  const md = async (prefix) => readFile(join(dir, 'rooms', rooms.find((r) => r.startsWith(prefix)), 'messages.md'), 'utf8');
  const general = await md('일반');
  assert.match(general, /조직 채널 첫 글/);
  assert.match(general, /\*\*유건\*\*/);
  assert.match(general, /\*\*페퍼\*\*/, '에이전트 글은 에이전트 이름으로');
  assert.match(general, /결재 · Approval: 메일 보내기 — approved/);
  assert.match(general, /반응 · Reactions: 👍 1/);
  assert.doesNotMatch(general, /지운 글/);
  assert.match(general, /조직 채널 · Org channel · 비욘드/);
  assert.match(await md('주말 모임'), /\[plan\.pdf\]\(attachments\/4-plan\.pdf\)/);
  assert.equal(await readFile(join(dir, 'rooms', rooms.find((r) => r.startsWith('주말')), 'attachments', '4-plan.pdf'), 'utf8'), '%PDF1');
  assert.match(await md('DM-c0000002'), /동의 거부자 밥의 글/, '동의를 거부한 사람의 글도 사람이 읽을 수 있게 남긴다');
  const archived = JSON.parse(await readFile(join(dir, 'rooms', rooms.find((r) => r.startsWith('DM-c0000005')), 'room.json'), 'utf8'));
  assert.equal(archived.kind, 'orgDmArchived', '보관된 옛 조직 1:1도 가져온다');
  const agentRoom = JSON.parse(await readFile(join(dir, 'rooms', rooms.find((r) => r.startsWith('페퍼')), 'room.json'), 'utf8'));
  assert.equal(agentRoom.kind, 'agentDm');
  const raw = (await readFile(join(dir, 'rooms', rooms.find((r) => r.startsWith('일반')), 'messages.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(raw[1].approval.status, 'approved', '원본 JSON에 결재 행');
  assert.equal(raw[0].reactions[0].emoji, '👍');
  assert.equal(await readFile(join(dir, 'docs', `비욘드-${ORG.slice(0, 8)}`, 'journal', '2026-09-01.md'), 'utf8'), '# 일지\n\n조직 일지 본문\n', 'journal/ 포함 조직 문서');
  assert.match(await readFile(join(dir, 'README.md'), 'utf8'), /메시지 · Messages: 6/);
  // 요청 예산: 조직·방 목록(빈 페이지 포함) + 방마다(메시지 2페이지·반응·첨부·구성원·이름) + 첨부 1 + 문서 — 순차, 기록된 그대로
  const total = fake.count();
  assert.equal(total, st.stats.requests, '실행부가 센 수와 서버가 받은 수가 같다');
  assert.ok(total <= 45, `요청 ${total}회`);
  assert.equal(fake.count((h) => h.table === 'storage'), 1);
  assert.equal(fake.count((h) => /my_plan/.test(h.path)), 0, '무료·Pro 판정을 묻지 않는다 — 두 플랜이 같은 동작');
  assert.ok(fake.bytes() > 0 && fake.bytes() < 20_000, `응답 ${fake.bytes()}바이트`);
  assert.equal(fake.count((h) => h.method !== 'GET' && h.method !== 'POST'), 0, '쓰기 요청 없음(POST는 RPC 읽기뿐)');
  assert.ok(fake.hits.filter((h) => h.method === 'POST').every((h) => h.table?.startsWith('rpc:')), 'POST는 읽기 RPC뿐');
});

test('다시 실행 — 끝난 계정은 요청 0번으로 끝난 상태를 돌려준다(같은 것을 두 번 받지 않는다)', async (t) => {
  const fake = await fakeMsgr(sampleDb()); t.after(() => fake.close());
  const dir = await tmpDir('again');
  await A.runArchive({ client: fake.client, uid: ME, dir, sleep: noSleep });
  const before = fake.count();
  const st = await A.runArchive({ client: fake.client, uid: ME, dir, sleep: noSleep });
  assert.equal(st.status, 'done');
  assert.equal(fake.count(), before, '요청 0번');
});

test('페이지 — 메시지 2500개 방은 1000개씩 키셋으로 받고(서버 최대 행 1000), 빈 페이지에서 멈춘다', async (t) => {
  const db = sampleDb();
  const big = 'c0000009-0000-4000-8000-000000000009';
  db.msgr_channels = [{ id: big, org_id: ORG, kind: 'public', name: '큰방', created_at: '2026-09-01T00:00:00Z', archived_at: null }];
  db.msgr_messages = Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, channel_id: big, org_id: ORG, author_kind: 'user', author_user_id: ME, kind: 'text', body: `m${i + 1}`, created_at: '2026-09-01T00:00:00Z' }));
  db.msgr_reactions = []; db.msgr_attachments = []; db.msgr_org_docs = [];
  const fake = await fakeMsgr(db); t.after(() => fake.close());
  const dir = await tmpDir('paged');
  const st = await A.runArchive({ client: fake.client, uid: ME, dir, sleep: noSleep });
  assert.equal(st.totals.messages, 2500);
  const [room] = await roomDirs(dir);
  const ids = await jsonlIds(join(dir, 'rooms', room, 'messages.jsonl'));
  assert.equal(ids.length, 2500); assert.equal(new Set(ids).size, 2500);
  assert.equal(fake.count((h) => h.table === 'msgr_messages'), 4, '1000·1000·500·빈 페이지');
  assert.equal(fake.count((h) => h.table === 'msgr_reactions'), 13, '200개 묶음 — ceil(1000/200)*2 + ceil(500/200)');
});

test('중단 후 재개 — 서버 오류로 멈추면 failed, 다시 실행하면 이어서 받고 같은 줄을 두 번 쓰지 않는다(상태 저장 전에 멈춘 경우 포함)', async (t) => {
  const db = sampleDb();
  const big = 'c0000009-0000-4000-8000-000000000009';
  db.msgr_channels = [{ id: big, org_id: ORG, kind: 'public', name: '큰방', created_at: '2026-09-01T00:00:00Z', archived_at: null }];
  db.msgr_messages = Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, channel_id: big, org_id: ORG, author_kind: 'user', author_user_id: ME, kind: 'text', body: `m${i + 1}`, created_at: '2026-09-01T00:00:00Z' }));
  db.msgr_reactions = []; db.msgr_attachments = []; db.msgr_org_docs = [];
  let down = false; let msgPages = 0;
  const fake = await fakeMsgr(db, { fault: (h) => { if (h.table === 'msgr_messages' && ++msgPages === 3) down = true; return down ? 503 : null; } }); t.after(() => fake.close());
  const dir = await tmpDir('resume');
  const slept = [];
  const st1 = await A.runArchive({ client: fake.client, uid: ME, dir, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(st1.status, 'failed');
  assert.deepEqual(slept, A.BACKOFF_MS, '1·2·4·8초 백오프 네 번 뒤 멈춘다');
  assert.equal(st1.totals.messages, 2000);
  assert.equal(fake.count((h) => h.table === 'msgr_messages'), 2 + 1 + A.BACKOFF_MS.length, '성공 2페이지 + 실패 1 + 재시도 4 — supabase-js 내장 재시도가 겹치지 않는다');
  // 줄은 썼는데 상태 저장 전에 앱이 꺼진 것처럼 커서를 지운다 — jsonl 마지막 줄이 커서가 된다
  const stFile = join(dir, '_state.json');
  const saved = JSON.parse(await readFile(stFile, 'utf8'));
  saved.rooms[big].lastId = null; await writeFile(stFile, JSON.stringify(saved));
  down = false;
  const st2 = await A.runArchive({ client: fake.client, uid: ME, dir, sleep: noSleep });
  assert.equal(st2.status, 'done');
  const [room] = await roomDirs(dir);
  const ids = await jsonlIds(join(dir, 'rooms', room, 'messages.jsonl'));
  assert.equal(ids.length, 2500, '줄 수 = 메시지 수'); assert.equal(new Set(ids).size, 2500, '중복 0');
  assert.match(await readFile(join(dir, 'rooms', room, 'messages.md'), 'utf8'), /m2500/);
});

test('첨부 실패 — 하나를 못 받아도 나머지는 끝내고 partial, 다시 받기는 못 받은 첨부만 받는다', async (t) => {
  const db = sampleDb();
  let storageDown = true;
  const fake = await fakeMsgr(db, { fault: (h) => (storageDown && h.path.startsWith('/storage/') ? 500 : null) }); t.after(() => fake.close());
  const dir = await tmpDir('attach');
  const st1 = await A.runArchive({ client: fake.client, uid: ME, dir, sleep: noSleep });
  assert.equal(st1.status, 'partial');
  assert.equal(st1.failed.length, 1);
  assert.equal(st1.totals.messages, 6, '메시지는 모두 받았다');
  const rooms = await roomDirs(dir);
  assert.match(await readFile(join(dir, 'rooms', rooms.find((r) => r.startsWith('주말')), 'messages.md'), 'utf8'), /plan\.pdf \(받지 못함 · not downloaded\)/);
  storageDown = false;
  const before = fake.count((h) => h.table === 'msgr_messages');
  const st2 = await A.runArchive({ client: fake.client, uid: ME, dir, sleep: noSleep });
  assert.equal(st2.status, 'done'); assert.equal(st2.failed.length, 0);
  assert.equal(fake.count((h) => h.table === 'msgr_messages'), before, '끝난 방의 메시지는 다시 묻지 않는다');
  assert.ok(existsSync(join(dir, st1.failed[0].file)), '못 받은 첨부를 받았다');
});

test('첨부 서버가 멈춤 — 연달아 3번 실패하면 남은 첨부는 요청 없이 못 받음으로 남긴다(실패도 요청 예산 안)', async (t) => {
  const db = sampleDb();
  const room = db.msgr_channels[2].id;
  db.msgr_attachments = Array.from({ length: 10 }, (_, i) => ({ message_id: 4, storage_path: `p/${room}/4/f${i}.txt`, name: `f${i}.txt`, mime: 'text/plain', bytes: 1 }));
  const fake = await fakeMsgr(db, { fault: (h) => (h.table === 'storage' ? 502 : null) }); t.after(() => fake.close());
  const dir = await tmpDir('storage-down');
  const st = await A.runArchive({ client: fake.client, uid: ME, dir, sleep: noSleep });
  assert.equal(st.status, 'partial'); assert.equal(st.failed.length, 10);
  assert.equal(fake.count((h) => h.table === 'storage'), A.ATTACH_DOWN_AFTER * (1 + A.BACKOFF_MS.length), '3개 × 5번 = 15번, 나머지 7개는 0번');
});

test('권한 없는 방 — 서버가 거부(403)하면 그 방만 건너뛰고 전체는 끝난다. RLS가 숨긴 방은 처음부터 목록에 없다', async (t) => {
  const db = sampleDb();
  const denied = db.msgr_channels[2].id;
  const fake = await fakeMsgr(db, { fault: (h) => (h.table === 'msgr_messages' && h.url.includes(denied) ? 403 : null) }); t.after(() => fake.close());
  const dir = await tmpDir('denied');
  const st = await A.runArchive({ client: fake.client, uid: ME, dir, sleep: noSleep });
  assert.equal(st.status, 'done');
  assert.equal(st.totals.messages, 5, '거부된 방의 글 1개만 빠진다');
  assert.equal(fake.count((h) => h.table === 'msgr_messages' && h.url.includes(denied)), 1, '권한 거부는 재시도하지 않는다');
});

test('빈 계정 — 방이 없어도 끝난 상태와 README를 남긴다', async (t) => {
  const fake = await fakeMsgr({ pause: { paused: true } }); t.after(() => fake.close());
  const dir = await tmpDir('empty');
  const st = await A.runArchive({ client: fake.client, uid: ME, dir, sleep: noSleep });
  assert.equal(st.status, 'done'); assert.equal(st.totals.rooms, 0);
  assert.match(await readFile(join(dir, 'README.md'), 'utf8'), /방 · Rooms: 0/);
  assert.ok(fake.count() <= 3, `요청 ${fake.count()}회`);
});

test('중단 스위치 — 켜짐 {paused:true}, 꺼짐 null, 옛 서버(PGRST202)·오프라인은 꺼짐으로 본다', async (t) => {
  assert.equal(A.msgrShutdownOn({ paused: true, since: 'x' }), true);
  assert.equal(A.msgrShutdownOn(null), false);
  assert.equal(A.msgrShutdownOn({ paused: false }), false);
  const on = await fakeMsgr({ pause: { paused: true, since: '2026-10-16T17:00:00+09:00' } }); t.after(() => on.close());
  assert.deepEqual(await A.readPause(on.client), { paused: true, since: '2026-10-16T17:00:00+09:00', error: null });
  const old = await fakeMsgr({ pause: 'missing' }); t.after(() => old.close());
  const r = await A.readPause(old.client);
  assert.equal(r.paused, false); assert.equal(r.error, 'PGRST202');
  const { createClient } = await import('@supabase/supabase-js');
  const offline = createClient('http://127.0.0.1:9', 'k', { auth: { persistSession: false, autoRefreshToken: false } });
  const o = await A.readPause(offline);
  assert.equal(o.paused, false); assert.ok(o.error, '오프라인은 오류와 함께 꺼짐');
});

test('스위치 캐시 — 10분 안에는 다시 묻지 않고, 읽기 실패는 1분 뒤 다시 묻는다', async (t) => {
  A._resetPauseCache();
  const fake = await fakeMsgr({ pause: { paused: true } }); t.after(() => fake.close());
  let now = 0;
  await A.pauseState(fake.client, { now: () => now });
  now = A.PAUSE_TTL_MS - 1; await A.pauseState(fake.client, { now: () => now });
  assert.equal(fake.count((h) => h.table === 'rpc:msgr_service_pause'), 1);
  now = A.PAUSE_TTL_MS + 1; await A.pauseState(fake.client, { now: () => now });
  assert.equal(fake.count((h) => h.table === 'rpc:msgr_service_pause'), 2);
  A._resetPauseCache();
  const { createClient } = await import('@supabase/supabase-js');
  const offline = createClient('http://127.0.0.1:9', 'k', { auth: { persistSession: false, autoRefreshToken: false } });
  now = 0; const a = await A.pauseState(offline, { now: () => now });
  now = 30_000; const b = await A.pauseState(offline, { now: () => now });
  assert.equal(a, b, '1분 안에는 같은 실패 값');
  A._resetPauseCache();
});

async function company(id, o) {
  const p = paths(id); await mkdir(p.root, { recursive: true });
  await writeFile(join(p.root, 'company.json'), JSON.stringify({ id, name: id, created: o.created ?? '2026-09-01', ownerId: o.ownerId, msgr: o.msgr ?? {} }));
}

test('자동 실행 — 스위치 켜짐 + 기록 없음이면 한 번 받고, 끝난 뒤에는 스위치도 읽지 않는다(요청 0). 꺼짐·오프라인이면 기록을 남기지 않는다', async (t) => {
  A._resetPauseCache();
  await company('auto-a', { ownerId: ME, msgr: { enabled: true } });
  const fake = await fakeMsgr(sampleDb()); t.after(() => fake.close());
  const c = { uid: ME, client: fake.client };
  const companies = async () => [{ id: 'auto-a', ownerId: ME, msgr: { enabled: true }, created: '2026-09-01' }];
  // 꺼짐
  fake.db.pause = null;
  assert.equal((await R.maybeAutoArchive({ session: async () => c, companies })).reason, 'notPaused');
  assert.equal(fake.count((h) => h.table && !h.table.startsWith('rpc:')), 0, '꺼져 있으면 데이터 요청 0');
  assert.equal(existsSync(join(process.env.ARGO_ROOT, '.msgr-archive.json')), false, '기록 없음');
  // 켜짐
  A._resetPauseCache(); fake.db.pause = { paused: true };
  const r = await R.maybeAutoArchive({ session: async () => c, companies, run: (args) => A.runArchive({ ...args, sleep: noSleep }) });
  assert.equal(r.ran, true); assert.equal(r.ws, 'auto-a');
  const dir = join(paths('auto-a').root, '.msgr-archive');
  assert.equal((await A.readArchiveState(dir)).status, 'done');
  const after = fake.count();
  A._resetPauseCache();
  assert.equal((await R.maybeAutoArchive({ session: async () => c, companies })).reason, 'already');
  assert.equal(fake.count(), after, '끝난 계정은 요청 0');
  // 로그인 안 함
  assert.equal((await R.maybeAutoArchive({ session: async () => null, companies })).reason, 'noSession');
});

test('오프라인 — 스위치를 못 읽으면 받지 않고 기록도 남기지 않는다(다음 앱 시작 때 다시 확인)', async (t) => {
  A._resetPauseCache();
  const { createClient } = await import('@supabase/supabase-js');
  const c = { uid: '33333333-3333-4333-8333-333333333333', client: createClient('http://127.0.0.1:9', 'k', { auth: { persistSession: false, autoRefreshToken: false } }) };
  const r = await R.maybeAutoArchive({ session: async () => c, companies: async () => [{ id: 'auto-a', ownerId: c.uid }] });
  assert.equal(r.reason, 'pauseUnknown');
  const reg = JSON.parse(await readFile(join(process.env.ARGO_ROOT, '.msgr-archive.json'), 'utf8').catch(() => '{}'));
  assert.equal(reg[c.uid], undefined);
  A._resetPauseCache();
});

test('여러 회사 — 이 계정이 주인인 회사에만, 메신저가 켜진 회사 먼저·그다음 가장 먼저 만든 회사. 한 계정은 한 회사에 한 벌', async (t) => {
  const cs = [
    { id: 'other', ownerId: BOB, msgr: { enabled: true }, created: '2026-01-01' },
    { id: 'newer', ownerId: ME, created: '2026-09-02' },
    { id: 'older', ownerId: ME, created: '2026-08-01' },
  ];
  assert.equal(A.pickCompany(cs, ME), 'older', '남의 회사는 고르지 않는다');
  assert.equal(A.pickCompany([...cs, { id: 'live', ownerId: ME, msgr: { enabled: true }, created: '2026-10-01' }], ME), 'live');
  assert.equal(A.pickCompany(cs.slice(0, 1), ME), null, '내 회사가 없으면 받지 않는다');
  // 등록부: auto-a에 받은 계정은 다른 회사에서 시작해도 같은 곳(auto-a)을 가리킨다
  const target = await R.archiveTarget(ME, { ws: "somewhere-else" });
  assert.equal(target.ws, "auto-a");
  const st = await R.archiveStatus(ME, 'somewhere-else', { companies: async () => [] });
  assert.equal(st.here, false); assert.equal(st.ws, 'auto-a'); assert.equal(st.status, 'done');
});

test('같은 회사를 다른 계정이 쓰면 폴더를 나눈다(.msgr-archive-<uid8>) — 두 계정 기록을 섞지 않는다', async (t) => {
  const root = paths('auto-a').root;
  assert.equal(await A.archiveDirFor(root, ME), join(root, '.msgr-archive'));
  assert.equal(await A.archiveDirFor(root, BOB), join(root, `.msgr-archive-${BOB.slice(0, 8)}`));
});

test('여러 기기·동기화 — 보관 폴더는 올리지 않고 diff에서도 보이지 않는다(기기마다 서버에서 한 번 받는다)', (t) => {
  // 전체 암호화 스위치를 끈다 — 켜져 있고 키가 없으면 EXCLUDE가 어느 파일에나 참이라(키 없음 = 이번 사이클 불가시) 이 규칙을 시험할 수 없다
  const prevEnc = process.env.ARGO_ENC_VAULT; process.env.ARGO_ENC_VAULT = '0';
  t.after(() => { if (prevEnc === undefined) delete process.env.ARGO_ENC_VAULT; else process.env.ARGO_ENC_VAULT = prevEnc; });
  assert.equal(EXCLUDE('vault/notes/x.md'), false, '다른 파일은 올린다(대조군)');
  assert.equal(EXCLUDE('.msgr-archive/rooms/x/messages.md'), true);
  assert.equal(EXCLUDE(`.msgr-archive-${BOB.slice(0, 8)}/README.md`), true);
  assert.equal(isMsgrArchiveRel('.msgr-archive/_state.json'), true);
  assert.equal(isMsgrArchiveRel('vault/.msgr-archive/x.md'), false, '최상위만');
  assert.equal(isMsgrArchiveRel('msgr-archive/x.md'), false, '점이 없는 사용자 폴더는 그대로');
});

test('동의 거부자 글·다른 사람 글 — 에이전트 파일 도구·셸이 보관 폴더를 못 읽고, 기억 색인 폴더 밖에 있다', async (t) => {
  const { makePermissionGate } = await import('../src/permission-gate.mjs');
  const root = paths('auto-a').root;
  await mkdir(join(root, 'vault', 'notes'), { recursive: true });
  const gate = makePermissionGate('auto-a', 'pepper', root);
  const deny = async (tool, input) => assert.equal((await gate(tool, input)).behavior, 'deny', `${tool} ${JSON.stringify(input)}`);
  await deny('Read', { file_path: '.msgr-archive/README.md' });
  await deny('Read', { file_path: join(root, '.msgr-archive', 'README.md') });
  await deny('Grep', { pattern: '밥', path: '.msgr-archive' });
  await deny('Glob', { pattern: '**/*.md', path: '.msgr-archive' });
  await deny('Bash', { command: 'cat .msgr-archive/rooms/*/messages.md' });
  await deny('Bash', { command: `grep -r 밥 ${join(root, `.msgr-archive-${BOB.slice(0, 8)}`)}` });
  assert.equal((await gate('Read', { file_path: 'vault/notes/x.md' })).behavior, 'allow', '자기 책상은 그대로');
  const { listDocs } = await import('../src/hub.mjs');
  const docs = await listDocs('auto-a');
  assert.ok(!docs.some((d) => String(d.rel ?? d.path ?? '').includes('msgr-archive')), '기억 목록에 보관 폴더가 없다');
});

test('설정 화면 표시 — 스위치 꺼짐+기록 없음은 숨김, 진행 중 2초 조회, 실패·일부·끊김은 다시 받기, 끝나면 단추 없음, 다른 회사면 위치 안내', () => {
  assert.equal(V.archiveView(null).show, false);
  assert.equal(V.archiveView({ signedIn: true, paused: false, status: 'none' }).show, false);
  const none = V.archiveView({ signedIn: true, paused: true, status: 'none' });
  assert.equal(none.show, true); assert.equal(none.retry, true);
  assert.equal(V.archiveView({ signedIn: true, paused: true, status: 'running', totals: { rooms: 5, roomsDone: 2 } }).polling, true);
  for (const s of ['failed', 'partial', 'interrupted']) assert.equal(V.archiveView({ signedIn: true, paused: true, status: s }).retry, true, s);
  assert.equal(V.archiveView({ signedIn: true, paused: true, status: 'done' }).retry, false);
  assert.equal(V.archiveView({ signedIn: true, paused: false, status: 'failed' }).retry, false, '스위치가 꺼지면 다시 받기도 없다(서버 POST와 같은 조건)');
  assert.equal(V.archiveView({ signedIn: true, paused: true, status: 'done', here: false }).here, false);
  assert.equal(V.archiveLabelKey('partial'), 'settings.msgrArchive.partial');
  // 완료 안내 — 한 번 닫으면 같은 완료는 다시 안 보인다
  const done = { signedIn: true, status: 'done', dir: '/x/.msgr-archive', finishedAt: '2026-10-16T09:00:00Z' };
  assert.equal(V.showArchiveNotice(done, null), true);
  assert.equal(V.showArchiveNotice(done, V.archiveNoticeKey(done)), false);
  assert.equal(V.showArchiveNotice({ ...done, status: 'running' }, null), false);
});

test('사전 — 이관 문구는 ko·en 둘 다 있다', async (t) => {
  const src = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  const keys = ['title', 'none', 'running', 'interrupted', 'done', 'partial', 'failed', 'elsewhere', 'where', 'private', 'start', 'retry', 'open', 'err'].map((k) => `settings.msgrArchive.${k}`)
    .concat(['msgrArchive.notice', 'msgrArchive.noticePartial', 'msgrArchive.noticeSettings']);
  for (const k of keys) assert.match(src, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', ["'].+["']\\],$`, 'm'), k);
});
