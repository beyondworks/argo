// 회의실 '새 회의' 분기 — 유건 요청 2026-09-02: 기존 회의를 마치지 않고 별개의 새 회의를 열고, 레일에서 오갈 수 있게.
// 처방(B안): 단일 방(room-main.json) 유지 + '진행 중' 보관(.archive/_room-<ts>.json에 open:true, 회의록 없음).
// 새 회의(parkMeeting)=마치기에서 회의록만 뺀 것, 전환(reopenMeeting)=현재 방 자동 보관 후 복원 — 비움/되살림 각인은
// endMeeting·종전 reopen과 같은 계약이라 동기화 병합(mergeThread)에 새 의미가 없다. 여기서 잠그는 것:
//  ① parkMeeting — 보관본 open:true + 방 비움(각인·sid) + 회의록 없음, 빈 방은 무행동
//  ② reopenMeeting(전환) — 현재 방 자동 보관(open:true) → 복원(resumedAt·sid) → 보관본 제거, 빈 방이면 보관 없음
//  ③ listArchivedMeetings — open 노출 + 정렬(진행 중 → 고정 → 최근)
//  ④ 서버 게이트 — 크루 발언 중(마커 신선)이면 새 회의·전환·마치기 전부 ROOM_BUSY, 방·보관본 불변; 낡은 마커는 통과
//  ⑤ 동기화 — 보관 뒤 원격 옛 사본과 병합해도 옛 메시지가 되살아나지 않고, 전환 뒤엔 원격 tombstone을 이긴다.
//     전환 뒤 상대 기기가 든 '방금 보관한 회의' 사본은 되살아나지 않고(분리 검수 HIGH-1), 상대의 새 메시지는 살아남는다
//  ⑥ 라우트 실호출 — POST /room/sessions(새 회의), PATCH reopen(현재 방 있어도 200·parked), 발언 중 409 + errorCode(room_busy)
//  ⑦ 페이지 배선(소스 구간 불변식) — 새 회의 버튼·가드, 레일 진행 중 칩, 배너 분기, ROOM_BUSY 표시 언어, i18n ko/en
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-room-fork-')); // 워크스페이스 임포트보다 먼저
delete process.env.NEXT_PUBLIC_SUPABASE_URL; // AUTH off — 라우트 실호출이 guardCompany를 지나게(apimsg 테스트 관례)
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));

const { paths } = await import('../src/workspace.mjs');
const { parkMeeting, reopenMeeting, endMeeting, loadRoom, listArchivedMeetings, archiveRoomFile, ROOM_TURN_SLUG } = await import('../src/room.mjs');
const { setTurnStatus, clearTurnStatus } = await import('../src/turn-status.mjs');
const { mergeThread } = await import('../src/sync.mjs');
const { withLock } = await import('../src/mutex.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MSGS = [{ who: 'user', text: '@페퍼 3분기 계획', ts: 1000 }, { who: 'pepper', text: '초안입니다', ts: 1001 }];
const OLD = [{ who: 'user', text: '지난 안건', ts: 10 }, { who: 'pepper', text: '지난 답', ts: 11 }];

async function seed(ws, { room = { messages: MSGS, sid: 3 }, archived = {} } = {}) {
  const p = paths(ws);
  await mkdir(join(p.chats, '.archive'), { recursive: true });
  await writeFile(join(p.root, 'company.json'), JSON.stringify({ name: ws, lang: 'ko' }));
  await writeFile(join(p.chats, 'room-main.json'), JSON.stringify(room));
  for (const [id, body] of Object.entries(archived)) await writeFile(join(p.chats, '.archive', id), JSON.stringify(body));
  return p;
}
const archiveNames = async (p) => (await readdir(join(p.chats, '.archive'))).filter((n) => n.startsWith('_room-')).sort();
const readArchive = async (p, id) => JSON.parse(await readFile(join(p.chats, '.archive', id), 'utf8'));
const buf = (o) => Buffer.from(JSON.stringify(o));
const backdate = async (ws, ageMs) => {
  const f = join(paths(ws).chats, `${ROOM_TURN_SLUG}.status.json`); const s = JSON.parse(await readFile(f, 'utf8'));
  await writeFile(f, JSON.stringify({ ...s, ts: Date.now() - ageMs }));
};

test('① 새 회의: 현재 회의를 open:true로 보관하고 방을 비운다 — 각인·sid는 마치기와 같고 회의록은 없다', async () => {
  const ws = 'fk-park'; const p = await seed(ws);
  assert.deepEqual(await parkMeeting(ws), { parked: true });
  const names = await archiveNames(p);
  assert.equal(names.length, 1, '보관본 1건');
  const arch = await readArchive(p, names[0]);
  assert.equal(arch.open, true, 'open 표식 — 없으면 레일이 마친 회의로 표시하고, 회의록도 없는 유령 회의가 된다');
  assert.deepEqual(arch.messages, MSGS, '대화 원본 그대로');
  const room = await loadRoom(ws);
  assert.deepEqual(room.messages, [], '방 비움');
  assert.equal(room.sid, 4, 'sid 증가 — 돌던 턴의 잔여 발언 무효화(endMeeting과 동일)');
  assert.equal(room.cutTs, 1002, 'cutTs = 본 메시지 최대 ts + 1(resetStamp) — 없으면 동기화가 옛 대화를 되살린다');
  assert.ok(room.resetAt >= 1002, 'resetAt 각인');
  assert.equal(existsSync(p.journal), false, '회의록(vault/journal) 없음 — 새 회의는 마치기가 아니다');
});

test('① 빈 방의 새 회의는 무행동 — 보관본을 만들지 않고 각인도 바꾸지 않는다', async () => {
  const ws = 'fk-park-empty'; const p = await seed(ws, { room: { messages: [], sid: 2, resetAt: 50, cutTs: 50 } });
  assert.deepEqual(await parkMeeting(ws), { parked: false });
  assert.deepEqual(await archiveNames(p), [], '빈 방을 보관하면 빈 유령 회의가 레일에 남는다');
  const room = await loadRoom(ws);
  assert.deepEqual({ sid: room.sid, resetAt: room.resetAt, cutTs: room.cutTs }, { sid: 2, resetAt: 50, cutTs: 50 });
});

test('① 보관본 이름 충돌 회피: 같은 ms 이름이 이미 있으면 ts를 올려 쓴다 — 덮어쓰면 앞 회의가 유실된다(now 주입으로 결정적 재현)', async () => {
  const ws = 'fk-collide'; const p = await seed(ws);
  const now = 1753500000000;
  const a = await archiveRoomFile(ws, { messages: OLD, marker: 'A' }, { open: true, now });
  const b = await archiveRoomFile(ws, { messages: MSGS, marker: 'B' }, { open: true, now });
  const c = await archiveRoomFile(ws, { messages: MSGS, marker: 'C' }, { now }); // 마치기 모양(open 없음)도 같은 규약
  assert.deepEqual([a, b, c], ['_room-1753500000000.json', '_room-1753500000001.json', '_room-1753500000002.json'], '이름이 겹치면 1씩 올린다');
  assert.equal((await readArchive(p, a)).marker, 'A', '앞 보관본 내용 보존 — 덮어쓰기면 회의 유실');
  assert.equal((await readArchive(p, b)).marker, 'B');
  assert.equal((await readArchive(p, c)).open, undefined, '마치기 모양은 open 없음');
  assert.equal((await readArchive(p, b)).open, true);
});

test('② 전환: 현재 회의를 진행 중으로 보관하고 대상 회의를 복원한다 — 보관본 제거·되살림 각인·sid·회의록 없음', async () => {
  const ws = 'fk-switch';
  const p = await seed(ws, {
    room: { messages: MSGS, sid: 3, title: '지금 회의' },
    archived: { '_room-1753500000000.json': { messages: OLD, open: true, title: '지난 회의', resetAt: 5, cutTs: 5 } },
  });
  const r = await reopenMeeting(ws, '_room-1753500000000.json');
  assert.deepEqual(r, { reopened: true, parked: true, messages: 2 });
  const room = await loadRoom(ws);
  assert.deepEqual(room.messages, OLD, '대상 회의가 현재 방');
  assert.equal(room.title, '지난 회의');
  assert.equal(room.sid, 4, 'sid 증가');
  assert.ok(room.resumedAt > 0, '되살림 각인 — 없으면 원격 tombstone이 이겨 다음 병합에서 통째로 잘린다');
  assert.equal(room.open, undefined, 'open은 보관본 표식 — 현재 방에 실리지 않는다');
  assert.equal(room.resetAt, undefined, '보관본의 옛 비움 순서값은 버린다');
  assert.equal(room.cutTs, 1002, '자르는 지점은 보관본의 옛 값(5)이 아니라 현재 방 기준(보관한 회의 마지막 ts+1) — 결정 4');
  const names = await archiveNames(p);
  assert.equal(names.length, 1, '대상 보관본은 제거되고(중복 표시 방지), 종전 현재 회의가 새 보관본으로');
  assert.notEqual(names[0], '_room-1753500000000.json');
  const parked = await readArchive(p, names[0]);
  assert.equal(parked.open, true, '종전 현재 회의는 진행 중으로 — 마친 것이 아니다');
  assert.deepEqual(parked.messages, MSGS); assert.equal(parked.title, '지금 회의');
  assert.equal(existsSync(p.journal), false, '회의록 없음');
});

test('② 현재 방이 비어 있으면 보관 없이 복원만 한다(parked:false)', async () => {
  const ws = 'fk-switch-empty';
  const p = await seed(ws, { room: { messages: [], sid: 1 }, archived: { '_room-1753500000000.json': { messages: OLD, open: true } } });
  assert.deepEqual(await reopenMeeting(ws, '_room-1753500000000.json'), { reopened: true, parked: false, messages: 2 });
  assert.deepEqual(await archiveNames(p), [], '보관본 0건 — 빈 방을 보관하면 빈 유령 회의가 레일에 남는다');
  assert.deepEqual((await loadRoom(ws)).messages, OLD);
});

test('② 없는 대상 id는 현재 방을 보관하기 전에 실패한다 — 방·보관본 불변', async () => {
  const ws = 'fk-switch-missing'; const p = await seed(ws);
  await assert.rejects(() => reopenMeeting(ws, '_room-9999999999999.json'));
  assert.deepEqual(await archiveNames(p), [], '대상 검증 전에 현재 방을 보관하면 실패마다 보관본이 늘어난다');
  const room = await loadRoom(ws); assert.deepEqual(room.messages, MSGS); assert.equal(room.sid, 3);
});

test('③ 레일 목록: open 노출 + 정렬(진행 중 → 고정 → 최근순)', async () => {
  const ws = 'fk-list';
  await seed(ws, { room: { messages: [], sid: 1 }, archived: {
    '_room-1000.json': { messages: OLD },                           // 마침·오래됨
    '_room-2000.json': { messages: OLD, pinned: true },             // 마침·고정
    '_room-3000.json': { messages: OLD },                           // 마침·최근
    '_room-1500.json': { messages: OLD, open: true },               // 진행 중·오래됨
    '_room-2500.json': { messages: OLD, open: true, pinned: true }, // 진행 중·고정
  } });
  const list = await listArchivedMeetings(ws);
  assert.deepEqual(list.map((s) => s.ts), [2500, 1500, 2000, 3000, 1000], '진행 중(고정 우선·최근순) → 고정 → 최근순');
  assert.deepEqual(list.map((s) => s.open), [true, true, false, false, false]);
});

test('④ 서버 게이트: 크루 발언 중(마커 신선)이면 새 회의·전환·마치기 전부 ROOM_BUSY — 방·보관본 불변, 낡은 마커는 통과', async () => {
  const ws = 'fk-gate';
  const p = await seed(ws, { archived: { '_room-1753500000000.json': { messages: OLD } } });
  await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper');
  const busy = (e) => e.code === 'ROOM_BUSY';
  await assert.rejects(() => parkMeeting(ws), busy, '새 회의');
  await assert.rejects(() => reopenMeeting(ws, '_room-1753500000000.json'), busy, '전환');
  await assert.rejects(() => endMeeting(ws), busy, '마치기 — 종전엔 UI 잠금뿐이라 8초 폴링 창의 다른 탭이 도는 발언을 유실시켰다');
  const room = await loadRoom(ws);
  assert.deepEqual(room.messages, MSGS); assert.equal(room.sid, 3);
  assert.deepEqual(await archiveNames(p), ['_room-1753500000000.json'], '거절 시 보관본도 그대로');
  assert.equal(existsSync(p.journal), false);
  await backdate(ws, 5 * 60_000); // 크래시 잔재 — 2분 창 밖이면 게이트가 풀린다
  assert.deepEqual(await parkMeeting(ws), { parked: true });
  await clearTurnStatus(ws, ROOM_TURN_SLUG);
});

test('④ 게이트는 방 락 안에서 판정한다 — 락을 쥔 턴이 마커를 세우는 동안 들어온 새 회의는 락을 기다린 뒤 거절된다(분리 검수 MEDIUM-1)', async () => {
  // 락 밖 판정이면 park가 마커 없는 순간에 게이트를 지나 락을 기다렸다가, 턴이 세운 마커를 못 본 채 방을 보관한다 —
  // 도는 턴의 안건은 보관본으로 밀려나고 그 답변은 sid 불일치로 버려진다(검수 프로브: 원본 ROOM_BUSY / 변이 parked:true).
  const ws = 'fk-gate-lock'; await seed(ws);
  let go; const gate = new Promise((r) => { go = r; });
  const holder = withLock(`thread:${ws}:room-main`, async () => { await gate; await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper'); });
  await sleep(5); // holder가 락을 쥔 뒤
  const park = parkMeeting(ws); // 락 대기 — 게이트가 락 밖이면 지금(마커 없음) 통과해 버린다
  await sleep(5); go(); await holder;
  await assert.rejects(park, (e) => e.code === 'ROOM_BUSY', '락 대기 뒤 판정이어야 턴이 세운 마커를 본다');
  assert.deepEqual((await loadRoom(ws)).messages, MSGS, '방 불변');
  await clearTurnStatus(ws, ROOM_TURN_SLUG);
});

test('⑤ 동기화: 보관 뒤 원격 옛 사본과 병합해도 옛 메시지가 되살아나지 않고, 전환 뒤엔 원격 tombstone을 이긴다', async () => {
  const ws = 'fk-sync'; const p = await seed(ws);
  await parkMeeting(ws);
  const emptied = await loadRoom(ws);
  for (const prefer of ['local', 'remote']) {
    const m = JSON.parse(mergeThread(buf(emptied), buf({ messages: MSGS, sid: 3 }), prefer).toString());
    assert.deepEqual(m.messages, [], `${prefer}: 보관 각인 없이는 원격이 든 옛 대화가 8초 만에 되살아난다(실사용 제보 2026-09-01 계열)`);
  }
  const [parkedId] = await archiveNames(p);
  await reopenMeeting(ws, parkedId);
  const restored = await loadRoom(ws);
  for (const prefer of ['local', 'remote']) {
    const m = JSON.parse(mergeThread(buf(restored), buf({ messages: [], resetAt: emptied.resetAt, cutTs: emptied.cutTs }), prefer).toString());
    assert.equal(m.messages.length, 2, `${prefer}: 되살림 각인이 없으면 원격 tombstone이 이겨 전환한 회의가 통째로 잘린다`);
  }
});

const texts = (m) => m.messages.map((x) => x.text);
test('⑤ 전환: 상대 기기가 아직 든 "방금 보관한 회의" 사본은 되살아나지 않는다(분리 검수 HIGH-1 재현 — 종전 2건 → 4건)', async () => {
  const ws = 'fk-switch-sync';
  await seed(ws, { archived: { '_room-1753500000000.json': { messages: OLD, open: true } } });
  const remote = { messages: MSGS, sid: 3 }; // 클라우드가 든 전환 직전 방(= 이제 진행 중으로 보관된 회의)
  await reopenMeeting(ws, '_room-1753500000000.json');
  const local = await loadRoom(ws);
  assert.equal(local.cutTs, 1002, '전환이 보관한 회의의 마지막 ts+1을 자르는 지점으로 물려받는다');
  for (const prefer of ['local', 'remote']) {
    const m = JSON.parse(mergeThread(buf(local), buf(remote), prefer).toString());
    assert.deepEqual(texts(m), OLD.map((x) => x.text), `${prefer}: 보관한 회의의 대화가 전환한 회의에 섞여 들어온다`);
  }
  // 상대 기기가 전환을 모른 채 보관된 회의에 이어 쓴 새 메시지는 살아남는다(못 본 것을 지우는 쪽이 더 나쁘다 — reset-stamp 트레이드와 동일)
  const stray = { who: 'user', text: 'B의 새 지시', ts: 5000 };
  const m2 = JSON.parse(mergeThread(buf(local), buf({ messages: [...MSGS, stray], sid: 3 }), 'remote').toString());
  assert.deepEqual(texts(m2), [...OLD.map((x) => x.text), 'B의 새 지시'], '옛 사본만 잘리고 새 메시지는 생존');
  // 수렴 뒤 상대가 되살린 회의에 이어 쓴 메시지 — 되살린 회의 자체(cutTs보다 오래된 ts)는 양쪽 다 지켜진다
  const conv = { ...local, messages: [...OLD, { who: 'pepper', text: '이어서', ts: 6000 }] };
  for (const [a, b] of [[local, conv], [conv, local]]) {
    const m3 = JSON.parse(mergeThread(buf(a), buf(b), 'remote').toString());
    assert.deepEqual(texts(m3), [...OLD.map((x) => x.text), '이어서'], '같은 각인끼리는 union — 되살린 회의가 잘리면 안 된다');
  }
  // 상대(원격)가 전환한 쪽이고 로컬이 낡은 기기: 로컬의 옛 사본은 잘리고 로컬의 새 메시지만 남는다
  const m4 = JSON.parse(mergeThread(buf({ messages: [...MSGS, stray], sid: 3 }), buf(local), 'local').toString());
  assert.deepEqual(texts(m4), [...OLD.map((x) => x.text), 'B의 새 지시'], '어느 쪽이 되살린 쪽이든 같은 결과');
});

test('⑤ 마치기 직후(원격 미반영) 다시 열기: 빈 방에서 열어도 직전 비움의 cutTs가 이어져 옛 회의가 돌아오지 않는다(main의 8초 창)', async () => {
  const ws = 'fk-end-reopen-sync';
  const p = await seed(ws);
  await endMeeting(ws); // 회의록 + 보관 + 비움(cutTs 1002)
  const [ended] = await archiveNames(p);
  await reopenMeeting(ws, ended); // 빈 방 — 보관 없이 복원
  const local = await loadRoom(ws);
  assert.equal(local.cutTs, 1002, '직전 비움의 자르는 지점을 잇는다');
  const m = JSON.parse(mergeThread(buf(local), buf({ messages: MSGS, sid: 3 }), 'remote').toString());
  assert.deepEqual(texts(m), MSGS.map((x) => x.text), '되살린 회의는 지키고(같은 내용), 원격 옛 사본과 겹치는 것은 중복 없이');
});

test('⑤ 회귀 0: cutTs 없는 되살림(크루 이어가기 모양)은 종전과 같은 union', () => {
  const local = { messages: OLD, resumedAt: 9000 };            // thread.mjs resumeSession — cutTs 삭제
  const remote = { messages: MSGS, sid: 3 };
  const m = JSON.parse(mergeThread(buf(local), buf(remote), 'remote').toString());
  assert.deepEqual(texts(m), [...OLD, ...MSGS].sort((a, b) => a.ts - b.ts).map((x) => x.text), '자르는 지점이 없으면 상대 쪽도 안 자른다');
});

test('⑥ 라우트 실호출: POST /room/sessions=새 회의, PATCH reopen=현재 방 있어도 전환(200·parked), 발언 중이면 409 + errorCode', async () => {
  const ws = 'fk-route';
  await seed(ws, { archived: { '_room-1753500000000.json': { messages: OLD, open: true } } });
  const sessions = await import('../app/api/companies/[ws]/room/sessions/route.js');
  const room = await import('../app/api/companies/[ws]/room/route.js');
  const P = { params: Promise.resolve({ ws }) };
  const base = `http://127.0.0.1/api/companies/${ws}/room`;
  const call = async (res) => ({ status: res.status, body: await res.json() });
  const patch = (id) => sessions.PATCH(new Request(`${base}/sessions`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, reopen: true }) }), P);
  // 전환 — 현재 방(MSGS)이 있어도 200, parked:true(종전 409)
  const sw = await call(await patch('_room-1753500000000.json'));
  assert.equal(sw.status, 200); assert.deepEqual(sw.body, { reopened: true, parked: true, messages: 2 });
  // 새 회의 — 현재 방(OLD) 보관
  const nw = await call(await sessions.POST(new Request(`${base}/sessions`, { method: 'POST' }), P));
  assert.equal(nw.status, 200); assert.deepEqual(nw.body, { parked: true });
  const list = (await call(await sessions.GET(new Request(`${base}/sessions`), P))).body.sessions;
  assert.equal(list.length, 2); assert.ok(list.every((s) => s.open), '둘 다 진행 중');
  // 발언 중 — 세 라우트 전부 409 + errorCode(화면이 표시 언어 안내로 그린다)
  await reopenMeeting(ws, list[0].id); // 방을 채운다
  await setTurnStatus(ws, ROOM_TURN_SLUG, 'room', 'pepper');
  const b1 = await call(await sessions.POST(new Request(`${base}/sessions`, { method: 'POST' }), P));
  const b2 = await call(await patch(list[1].id));
  const b3 = await call(await room.DELETE(new Request(base, { method: 'DELETE' }), P));
  for (const [name, r] of [['새 회의', b1], ['전환', b2], ['마치기', b3]]) {
    assert.equal(r.status, 409, `${name} 409`);
    assert.equal(r.body.errorCode, 'room_busy', `${name} errorCode(apiError 사전 코드) — 없으면 화면이 서버 문구를 그대로 보여 사전 문구를 못 쓴다`);
    assert.match(r.body.error, /진행 중|still speaking/, `${name} 본문은 #393 DELETE 핀과 같은 표시 언어 문구`);
  }
  await clearTurnStatus(ws, ROOM_TURN_SLUG);
});

// 소스 핀은 주석을 벗기고 본다 — 주석 속 문구가 앵커에 걸리면 fail-open(레포 관례)
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^\S\n])\/\/[^\n]*/gm, (m) => m.replace(/[^\n]/g, ' '));

test('⑦ 페이지 배선: 새 회의 버튼·가드, 레일 진행 중 칩, 배너 분기, ROOM_BUSY 표시 언어(소스 구간 불변식)', async () => {
  const page = stripComments(await readFile(new URL('../app/c/[ws]/room/page.jsx', import.meta.url), 'utf8'));
  // 새 회의 핸들러 — 마치기와 같은 가드, POST /room/sessions, 항해일지 갱신 없음(회의록을 안 썼다)
  const nm = page.slice(page.indexOf('async function newMeeting() {'), page.indexOf('const mention = input.match'));
  assert.match(nm, /^async function newMeeting\(\) \{\s*\n\s*if \(busy \|\| serverBusy\) return;/, '가드 — 도는 발언이 sid 불일치로 버려진다');
  assert.match(nm, /fetch\(`\/api\/companies\/\$\{ws\}\/room\/sessions`, \{ method: 'POST' \}\)/, '새 회의 = POST /room/sessions');
  assert.match(nm, /if \(!r\.ok\) throw routeError\(d\);/, '오류는 표시 언어 매핑을 거친다');
  assert.doesNotMatch(nm, /argo:refresh/, '회의록이 없으니 항해일지 갱신도 없다');
  // 헤더 — 새 회의 버튼이 마치기 옆에, 같은 잠금
  const hdr = page.slice(page.indexOf("t('room.header')"), page.indexOf("<div style={{ position: 'relative', minHeight: 0"));
  assert.match(hdr, /disabled=\{busy \|\| serverBusy\} onClick=\{newMeeting\}>\{t\('room\.new'\)\}/, '새 회의 버튼 + 잠금');
  assert.match(hdr, /disabled=\{busy \|\| serverBusy\} onClick=\{endMeeting\}>\{t\('room\.end'\)\}/, '마치기 버튼은 종전 그대로');
  // 레일 — 진행 중 칩 + play 버튼 라벨 분기·잠금
  assert.match(page, /\{s\.open && <span[^\n]*>\{t\('room\.sessions\.open'\)\}<\/span>\}/, '진행 중 칩');
  assert.match(page, /title=\{s\.open \? t\('room\.sessions\.switch'\) : t\('room\.sessions\.reopen'\)\}/, 'play 버튼 라벨 분기');
  assert.match(page, /disabled=\{reopening === s\.id \|\| busy \|\| serverBusy\}/, 'play 버튼 잠금 — 안 될 버튼은 잠근다');
  // 배너 — 진행 중/마침 문구 분기 + 전환 버튼
  assert.match(page, /const viewingOpen = !!viewing && !!sessions\.find\(\(s\) => s\.id === viewing\)\?\.open;/);
  assert.match(page, /\{viewingOpen \? t\('room\.sessions\.openReadonly'\) : t\('room\.sessions\.readonly'\)\}/, '배너 문구 분기');
  assert.match(page, /onClick=\{\(\) => doReopen\(\{ id: viewing \}\)\}>\{viewingOpen \? t\('room\.sessions\.switchShort'\) : t\('room\.sessions\.reopenShort'\)\}/, '배너 전환/열기 버튼');
  // ROOM_BUSY → 사전 문구(표시 언어). 마치기·전환·새 회의 세 경로가 같은 매핑을 탄다
  assert.match(page, /const routeError = \(d, fallback = ''\) => new Error\(d\?\.errorCode === 'room_busy' \? t\('room\.busyGate'\) : \(d\?\.error \|\| fallback\)\);/);
  // 호출 지점별 앵커(개수 단언은 이전형 변이에 초록) — 마치기·새 회의(위 nm)·전환 세 자리 각각
  const em = page.slice(page.indexOf('async function endMeeting() {'), page.indexOf('async function newMeeting() {'));
  assert.match(em, /if \(!r\.ok\) throw routeError\(d\);/, '마치기 오류도 표시 언어 매핑(409 ROOM_BUSY가 새로 생겼다)');
  const dr = page.slice(page.indexOf('async function doReopen(sess) {'), page.indexOf('useEffect(load, [ws]);'));
  assert.match(dr, /^async function doReopen\(sess\) \{\s*\n\s*if \(reopening \|\| busy \|\| serverBusy\) return;/, '전환 가드');
  assert.match(dr, /setError\(routeError\(await r\.json\(\)\.catch\(\(\) => \(\{\}\)\), t\('room\.reopenFail'\)\)\.message\)/, '전환 오류 표시 언어 매핑');
});

test('⑦ i18n: 새 키 ko/en 모두 등록 — 한국어 모드에 영어가 새지 않는다', async () => {
  const src = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  for (const k of ['room.new', 'room.busyGate', 'room.sessions.open', 'room.sessions.switch', 'room.sessions.switchShort', 'room.sessions.reopenShort', 'room.sessions.openReadonly']) {
    const m = src.match(new RegExp(`^\\s*'${k.replace(/\./g, '\\.')}':\\s*\\['([^']*)',\\s*'([^']*)'\\]`, 'm'));
    assert.ok(m, `${k} 사전 등록`);
    assert.ok(/[가-힣]/.test(m[1]) && !/[가-힣]/.test(m[2]), `${k} ko에 한글·en에 한글 없음`);
  }
});
