// 회의 다시 열기 회귀 가드 — 실사용 요청 2026-07-26 "보관한 회의를 다시 열어서 이어갈 수 있는 기능은 없나요".
// 회의 대화는 유실이 치명적이라(2026-07-25 "회의실 대화가 사라진다" 신고 계열) 되살리는 경로도
// 파괴 방향으로 어긋나지 않는지까지 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-reopen-test-'));
const { paths } = await import('../src/workspace.mjs');
const { reopenMeeting, listArchivedMeetings, loadRoom } = await import('../src/room.mjs');

const MSGS = [{ who: 'user', text: '@페퍼 3분기 계획', ts: 1 }, { who: 'pepper', text: '초안입니다', ts: 2 }];

async function seed(ws, { archived = { '_room-1753500000000.json': MSGS }, room = { messages: [], sid: 4 } } = {}) {
  const p = paths(ws);
  await mkdir(join(p.chats, '.archive'), { recursive: true });
  for (const [id, messages] of Object.entries(archived)) {
    await writeFile(join(p.chats, '.archive', id), JSON.stringify({ messages, title: '3분기 계획' }));
  }
  await writeFile(join(p.chats, 'room-main.json'), JSON.stringify(room));
  return p;
}

test('보관 회의를 되살리면 대화·제목이 그대로 오고 레일에서 빠진다(중복 방지)', async () => {
  const ws = 'reo-ok';
  const p = await seed(ws);
  const r = await reopenMeeting(ws, '_room-1753500000000.json');
  assert.deepEqual(r, { reopened: true, messages: 2 });
  const room = await loadRoom(ws);
  assert.equal(room.messages.length, 2, '대화가 그대로 돌아와야 한다');
  assert.equal(room.title, '3분기 계획', '회의명 보존');
  assert.equal((await listArchivedMeetings(ws)).length, 0, '레일에 남으면 같은 회의가 두 곳에 보인다');
  void p;
});

test('sid를 올린다 — 빈 방에서 돌던 잔여 턴이 되살린 회의에 유령으로 끼지 않게', async () => {
  const ws = 'reo-sid';
  await seed(ws, { room: { messages: [], sid: 4 } });
  await reopenMeeting(ws, '_room-1753500000000.json');
  assert.equal((await loadRoom(ws)).sid, 5, 'sid가 그대로면 진행 중이던 턴의 발언이 끼어든다');
});

test('진행 중인 회의가 있으면 거절하고 현재 대화를 건드리지 않는다', async () => {
  const ws = 'reo-busy';
  await seed(ws, { room: { messages: [{ who: 'user', text: '진행 중', ts: 9 }], sid: 1 } });
  await assert.rejects(
    () => reopenMeeting(ws, '_room-1753500000000.json'),
    (e) => e.code === 'ROOM_BUSY',
    '자동으로 덮으면 사장이 의도하지 않은 일지 적재가 생긴다',
  );
  const room = await loadRoom(ws);
  assert.equal(room.messages.length, 1, '거절했는데 현재 회의가 바뀌었다 — 유실 경로');
  assert.equal(room.messages[0].text, '진행 중');
  assert.equal((await listArchivedMeetings(ws)).length, 1, '거절 시 보관본도 그대로여야 한다');
});

test('없는 회의 id는 방을 건드리기 전에 실패한다', async () => {
  const ws = 'reo-missing';
  await seed(ws, { room: { messages: [], sid: 2 } });
  await assert.rejects(() => reopenMeeting(ws, '_room-9999999999999.json'));
  const room = await loadRoom(ws);
  assert.equal(room.messages.length, 0);
  assert.equal(room.sid, 2, '실패했는데 sid가 올랐다면 방을 먼저 건드린 것이다');
});

test('빈 보관 회의는 열지 않는다 — 되살릴 내용이 없다', async () => {
  const ws = 'reo-empty';
  await seed(ws, { archived: { '_room-1753500000000.json': [] } });
  await assert.rejects(() => reopenMeeting(ws, '_room-1753500000000.json'));
});
