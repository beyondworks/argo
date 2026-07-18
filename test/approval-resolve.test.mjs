// 결재 처리 시 크로스채널 버튼 정리 — 어느 창구(웹·대화창·텔레그램·슬랙)에서 승인해도
// approval_resolved 이벤트가 나가고, 푸시 때 저장한 tg 참조가 실려 게이트웨이가 카드를 정리한다.
// 실사용 갭(2026-07-18): 웹에서 승인하면 텔레그램 카드 버튼이 안 사라지던 문제.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-aptest-'));
const { addApproval, resolveApproval, expireApproval, setApprovalMeta, loadApprovals } = await import('../src/approvals.mjs');
const { onNotify } = await import('../src/notify.mjs');

const WS = 'apco';
await mkdir(join(process.env.ARGO_ROOT, WS), { recursive: true });

// emitNotify는 Promise.resolve().then으로 비동기 디스패치 — 이벤트를 수집해 tick 뒤 확인
function captureNotify() {
  const got = [];
  const off = onNotify((e) => got.push(e));
  return { got, off, settle: () => new Promise((r) => setTimeout(r, 20)) };
}

test('resolveApproval: 승인/거절 모두 approval_resolved 이벤트를 낸다', async () => {
  const cap = captureNotify();
  const it = await addApproval(WS, { slug: 'shuri', action: '외부 발송', reason: 't' });
  await resolveApproval(WS, it.id, true);
  await cap.settle();
  const resolved = cap.got.filter((e) => e.type === 'approval_resolved');
  assert.equal(resolved.length, 1, '처리당 이벤트 1건');
  assert.equal(resolved[0].item.id, it.id);
  assert.equal(resolved[0].item.status, 'approved', '상태가 실려 카드 결과 표시에 쓰인다');
  cap.off();
});

test('setApprovalMeta: 저장한 tg 참조가 이후 resolve 이벤트 item에 실린다(웹 승인 정리의 핵심)', async () => {
  const cap = captureNotify();
  const it = await addApproval(WS, { slug: 'pepper', action: '메일 발송', reason: 't' });
  // 게이트웨이 push가 하는 일: 텔레그램 메시지 참조를 결재에 심는다
  await setApprovalMeta(WS, it.id, { tg: { chatId: '555', messageId: 4242 } });
  const stored = (await loadApprovals(WS)).find((a) => a.id === it.id);
  assert.deepEqual(stored.tg, { chatId: '555', messageId: 4242 }, 'tg 참조 저장됨');
  // 웹에서 승인(=resolveApproval) → 이벤트 item에 tg가 실려 게이트웨이가 그 카드를 편집할 수 있다
  await resolveApproval(WS, it.id, false);
  await cap.settle();
  const ev = cap.got.find((e) => e.type === 'approval_resolved' && e.item.id === it.id);
  assert.ok(ev, '이벤트 발생');
  assert.deepEqual(ev.item.tg, { chatId: '555', messageId: 4242 }, '이벤트에 tg 참조가 실린다 → 버튼 정리 가능');
  assert.equal(ev.item.status, 'rejected');
  cap.off();
});

test('expireApproval: 만료도 approval_resolved(⏳)로 죽은 버튼을 정리시킨다', async () => {
  const cap = captureNotify();
  const it = await addApproval(WS, { slug: 'shuri', action: 'X', reason: 't' });
  await setApprovalMeta(WS, it.id, { tg: { chatId: '1', messageId: 9 } });
  const expired = await expireApproval(WS, it.id);
  assert.equal(expired.status, 'expired');
  await cap.settle();
  const ev = cap.got.find((e) => e.type === 'approval_resolved' && e.item.id === it.id);
  assert.ok(ev && ev.item.status === 'expired', '만료 이벤트로 카드 정리');
  cap.off();
});

test('setApprovalMeta: 없는 id는 null(무해)', async () => {
  assert.equal(await setApprovalMeta(WS, 'ap-nope', { tg: {} }), null);
});

test('resolveApproval: 이미 처리된 결재 재처리는 throw(이벤트 중복 방출 없음)', async () => {
  const cap = captureNotify();
  const it = await addApproval(WS, { slug: 'pepper', action: 'Y', reason: 't' });
  await resolveApproval(WS, it.id, true);
  await assert.rejects(() => resolveApproval(WS, it.id, true), /이미 처리/);
  await cap.settle();
  const evs = cap.got.filter((e) => e.type === 'approval_resolved' && e.item.id === it.id);
  assert.equal(evs.length, 1, '중복 방출 없음 — 카드 이중 편집 방지');
  cap.off();
});
