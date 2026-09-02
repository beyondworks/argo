// 회의 다시 열기 회귀 가드 — 실사용 요청 2026-07-26 "보관한 회의를 다시 열어서 이어갈 수 있는 기능은 없나요".
// 회의 대화는 유실이 치명적이라(2026-07-25 "회의실 대화가 사라진다" 신고 계열) 되살리는 경로도
// 파괴 방향으로 어긋나지 않는지까지 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { existsSync } from 'node:fs';
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
  assert.deepEqual(r, { reopened: true, parked: false, messages: 2 }); // parked — 현재 방이 비어 있어 보관 없음(새 회의 분기 계약)
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

// 종전 계약("현재 회의가 있으면 409 거절")은 새 회의 분기(2026-09-02)로 폐지 — 거절 근거였던 "자동으로 마치면
// 의도하지 않은 일지 적재"가 '진행 중 보관'(회의록 없음)에는 해당이 없다. 새 계약: 현재 회의를 진행 중으로 보관하고 연다.
test('진행 중인 회의가 있으면 그 회의를 "진행 중"으로 보관하고 연다 — 회의록은 남기지 않는다', async () => {
  const ws = 'reo-busy';
  const p = await seed(ws, { room: { messages: [{ who: 'user', text: '진행 중', ts: 9 }], sid: 1 } });
  const r = await reopenMeeting(ws, '_room-1753500000000.json');
  assert.deepEqual(r, { reopened: true, parked: true, messages: 2 });
  const room = await loadRoom(ws);
  assert.deepEqual(room.messages.map((m) => m.text), ['@페퍼 3분기 계획', '초안입니다'], '되살린 회의가 현재 방');
  assert.equal(room.open, undefined, '진행 중 표식은 보관본의 것 — 현재 방에 실려 오면 안 된다');
  const list = await listArchivedMeetings(ws);
  assert.equal(list.length, 1, '보관본 1건 = 방금 보관된 "진행 중" 회의(되살린 것은 레일에서 빠진다)');
  assert.equal(list[0].open, true, '진행 중 표식 — 레일이 마친 회의와 구분한다');
  assert.equal(list[0].topic, '진행 중', '보관된 것은 종전 현재 회의');
  assert.equal(existsSync(p.journal), false, '회의록(일지)을 남기면 안 된다 — 마치기가 아니라 보관이다');
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
