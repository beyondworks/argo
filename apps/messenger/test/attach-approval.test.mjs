// 첨부만 보낸 글(MSG-06)·채널 안 결재 카드(MSG-07) — 2026-10-05 분리 검증.
//  MSG-06 올리는 동안 빈 말풍선, 업로드가 전부 실패하면 보낸 사람에게 빈 검은 알약, 남에게 '이 메시지는 삭제되었습니다'가 남았다.
//  MSG-07 승인·거절이 누른 뒤에도 눌리고(진행 표시 없음), 연타하면 이미 처리된 결재에 '결재권자만…' 오류가 떴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageShape, isDiscardedUpload, UPLOAD_GRACE_MS } from '../src/attach-only.mjs';
import { decideApproval, singleFlight } from '../src/approval-display.js';
import { createComposerDelivery, composerTransport } from '../src/composer-delivery.mjs';
import { deliveryCardView } from '../src/delivery-card.mjs';

const T = Date.parse('2026-10-05T05:00:00Z');
const msg = (o = {}) => ({ id: 10, kind: 'text', body: '', mentions: [], reply_to: null, meta: null, deleted_at: null, edited_at: null, created_at: new Date(T).toISOString(), ...o });

test('MSG-06 본문 없는 글은 첨부가 붙기 전까지 빈 말풍선 대신 올리는 중 자리표시', () => {
  assert.equal(messageShape(msg(), { attCount: 0, now: T + 1000 }), 'uploading', '서버 행 직후·첨부 0개');
  assert.equal(messageShape(msg({ pending: true }), { attCount: 0, now: T }), 'uploading', '보내는 중(낙관적 행)');
  assert.equal(messageShape(msg(), { attCount: null, now: T + 1000 }), 'uploading', '첨부를 아직 못 읽음');
  assert.equal(messageShape(msg(), { attCount: 2, now: T + 1000 }), 'files', '첨부가 붙으면 첨부 줄만');
  assert.equal(messageShape(msg({ body: '안녕' }), { attCount: 0, now: T }), 'bubble');
  assert.equal(messageShape(msg({ reply_to: 3 }), { attCount: 0, now: T }), 'bubble', '답글 인용이 있으면 말풍선');
});

test('MSG-06 오래된(2분 넘은) 빈 글은 숨긴다 — 보낸 사람이 올리는 중이면(이 기기가 아는 업로드) 계속 자리표시', () => {
  const old = T + UPLOAD_GRACE_MS + 1;
  assert.equal(messageShape(msg(), { attCount: 0, now: old }), 'hidden');
  assert.equal(messageShape(msg(), { attCount: 0, now: old, uploading: true }), 'uploading', '큰 파일을 오래 올리는 중');
  assert.equal(messageShape(msg(), { attCount: null, now: old }), 'files', '첨부를 못 읽은 오래된 글은 숨기지 않는다(다시 읽기가 채운다)');
});

test('MSG-06 업로드가 전부 실패해 거둔 첨부 글은 모두에게 보이지 않는다 — 사용자가 지운 글은 종전대로 삭제 표시', () => {
  const at = new Date(T + 5000).toISOString();
  const discarded = msg({ deleted_at: at, edited_at: at });
  assert.equal(isDiscardedUpload(discarded), true);
  assert.equal(messageShape(discarded, { attCount: 0, now: T + 6000 }), 'hidden');
  const userDeleted = msg({ body: '', deleted_at: at, edited_at: null });
  assert.equal(isDiscardedUpload(userDeleted), false);
  assert.equal(messageShape(userDeleted, { attCount: 0, now: T + 6000 }), 'bubble', '삭제 표시');
  assert.equal(isDiscardedUpload(msg({ deleted_at: at, edited_at: new Date(T + 1000).toISOString() })), false, '고친 뒤 지운 글');
});

test('MSG-06 거두기(discard)는 지운 시각을 고친 시각에도 같이 남긴다 — 남의 화면이 사용자가 지운 글과 가른다', async () => {
  const calls = [];
  const mk = { from(table) { const q = { update(v) { calls.push(v); return q; }, eq() { return q; }, select() { return q; }, then(res, rej) { return Promise.resolve({ data: [{ id: 9 }], error: null }).then(res, rej); } }; return q; } };
  await composerTransport(mk, { orgId: 'o', chId: 'c', uid: 'me' }).discard({ messageId: 9 });
  assert.ok(calls[0].deleted_at); assert.equal(calls[0].edited_at, calls[0].deleted_at);
});

const file = (name) => ({ name, size: 4, type: 'image/png' });
const tr = (o = {}) => ({ message: async () => 7, upload: async () => { throw new Error('Fixture upload rejected'); }, attachment: async () => {}, ...o });

test('MSG-06 첨부만 보낸 글이 실패하면 카드는 "첨부를 올리지 못했습니다" + [다시 시도·지우기] — 지우기는 남은 빈 글도 거둔다', async () => {
  const discards = [];
  const d = createComposerDelivery(tr({ discard: async (job) => { discards.push(job.messageId); throw new Error('offline'); } })); // 거두기 실패 → 글이 남는다
  d.setFiles([file('a.png')]); await d.send([]);
  const view = deliveryCardView({ busy: false, job: d.snapshot().job });
  assert.deepEqual([view.titleKey, view.retryKey, view.dismissKey], ['msg.delivery.attachOnlyFailed', 'msg.delivery.retryUpload', 'msg.delivery.discard']);
  d.dismiss(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(discards, [7, 7], '지우기 = 남은 빈 글을 다시 거둔다');
  assert.equal(d.snapshot().job, null); assert.deepEqual(d.snapshot().files, [], '지운 첨부는 입력창으로 돌아오지 않는다');
});

// 분리 검수 L6(2026-10-05): 파일은 올라갔는데 첨부 등록만 실패한 빈 글은 '지우기'가 거두지 않았다(조건이 '하나도 안 올라감') — 2분 뒤 숨지만 안 읽음·폰 아이콘 숫자에 1로 남았다.
test('L6 파일은 올라갔고 첨부 등록만 실패한 빈 글도 지우기가 거둔다 — 등록된 첨부가 0개면', async () => {
  const discards = [];
  const d = createComposerDelivery(tr({ upload: async () => {}, attachment: async () => { throw new Error('insert failed'); }, discard: async (job) => { discards.push(job.messageId); } }));
  d.setFiles([file('a.png')]); await d.send([]);
  assert.equal(d.snapshot().job.files[0].uploaded, true, '파일은 올라갔다');
  d.dismiss(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(discards, [7], '지우기 = 빈 글을 거둔다');
});

test('UX 판독 — "재시도 그만두기"가 보내지 못한 글을 지웠다 → 입력창으로 되돌린다(글·못 올린 파일), 쓰던 글은 그 뒤에', async () => {
  const d = createComposerDelivery(tr({ message: async () => { throw new TypeError('Failed to fetch'); } }));
  d.setText('보낼 글'); await d.send([{ kind: 'crew', id: 'p', name: '페퍼' }]);
  d.setText('새로 쓰던 글');
  const view = deliveryCardView({ busy: false, job: d.snapshot().job });
  assert.equal(view.dismissKey, 'msg.delivery.toComposer');
  d.dismiss();
  assert.equal(d.snapshot().job, null);
  assert.equal(d.snapshot().text, '보낼 글\n새로 쓰던 글');
  assert.deepEqual(d.snapshot().mentions.map((x) => x.id), ['p']);
  const p = createComposerDelivery(tr({ upload: async (job, item) => { if (item.file.name === 'bad.png') throw new Error('too big'); } }));
  p.setText('글과 사진'); p.setFiles([file('ok.png'), file('bad.png')]); await p.send([]);
  p.dismiss();
  assert.equal(p.snapshot().text, '', '글은 이미 올라갔다 — 다시 넣지 않는다');
  assert.deepEqual(p.snapshot().files.map((f) => f.name), ['bad.png'], '못 올린 파일만 입력창으로');
});

test('MSG-07 결정이 0행이면 다시 읽어 이미 결정된 결재는 오류 없이 결과만 — 대기 중인데 0행이면 권한 없음', async () => {
  const update = async () => ({ data: [], error: null });
  assert.deepEqual(await decideApproval({ update, reread: async () => ({ status: 'approved' }) }), { result: 'already', status: 'approved' });
  assert.deepEqual(await decideApproval({ update, reread: async () => ({ status: 'pending' }) }), { result: 'denied' });
  assert.deepEqual(await decideApproval({ update, reread: async () => { throw new Error('Failed to fetch'); } }), { result: 'error', message: 'Failed to fetch' }, '다시 읽기가 네트워크로 실패하면 권한 없음이 아니라 오류(검수 L5)');
  assert.deepEqual(await decideApproval({ update, reread: async () => null }), { result: 'denied' }, '다시 읽어도 안 보이는 결재(RLS) = 권한 없음');
  assert.deepEqual(await decideApproval({ update: async () => ({ data: [{ id: 1 }], error: null }), reread: async () => null }), { result: 'done' });
  assert.deepEqual(await decideApproval({ update: async () => ({ data: null, error: { message: 'boom' } }), reread: async () => null }), { result: 'error', message: 'boom' });
});

test('MSG-07 결정 중에는 다시 눌러도 요청이 한 번만 나간다 — 끝나면 다시 누를 수 있다', async () => {
  let n = 0; let release; const decide = singleFlight(() => { n++; return new Promise((r) => { release = r; }); });
  const a = decide('approved'); const b = decide('approved'); const c = decide('rejected');
  assert.equal(n, 1); assert.equal(await b, undefined); assert.equal(await c, undefined);
  release(); await a;
  decide('approved'); assert.equal(n, 2);
});

// 화면 검수 UL1(2026-10-05): 방 보조 줄의 결재자 조회(msgr_dm_approver)가 실패하면 .error를 안 보고 조용히 '요청 없음'이 됐다 — 참여 요청 막대가 흔적 없이 안 보였다.
test('UL1 참여 요청 읽기 — 결재자 조회·요청 조회가 실패하면 failed(조용히 숨기지 않는다), 함수가 없는 옛 서버는 종전처럼 없음', async () => {
  const { readRoomJoinRequests } = await import('../src/approval-display.js');
  const pending = async () => [{ id: 1, requested_by: 'u-bob' }, { id: 2, requested_by: 'u-me' }];
  assert.deepEqual(await readRoomJoinRequests({ uid: 'u-me', approver: async () => ({ data: 'u-me' }), pending }), { reqs: [{ id: 1, requested_by: 'u-bob' }], failed: false });
  assert.deepEqual(await readRoomJoinRequests({ uid: 'u-me', approver: async () => ({ data: 'u-other' }), pending }), { reqs: [], failed: false }, '결재자가 아니면 없음');
  assert.deepEqual(await readRoomJoinRequests({ uid: 'u-me', approver: async () => ({ data: null, error: { message: 'canceling statement due to statement timeout' } }), pending }), { reqs: [], failed: true });
  assert.deepEqual(await readRoomJoinRequests({ uid: 'u-me', approver: async () => { throw new TypeError('Failed to fetch'); }, pending }), { reqs: [], failed: true });
  assert.deepEqual(await readRoomJoinRequests({ uid: 'u-me', approver: async () => ({ data: 'u-me' }), pending: async () => { throw new Error('Failed to fetch'); } }), { reqs: [], failed: true }, '요청 조회 실패');
  assert.deepEqual(await readRoomJoinRequests({ uid: 'u-me', approver: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.msgr_dm_approver' } }), pending }), { reqs: [], failed: false }, '옛 서버');
});
