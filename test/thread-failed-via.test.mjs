// 실패 턴 보존 + via 출처표식 — 전수리뷰 2026-07-30 #1(성공 후에만 저장 → 실패 턴 무증상 증발)과
// 신고 2026-07-28("쪽지·위임·루틴이 사장 발화로 보임")의 회귀 가드.
// ⚠ ARGO_ROOT는 thread.mjs(→workspace.mjs) 동적 임포트보다 먼저(thread-artifacts와 동일 규칙).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-failedvia-'));
process.env.ARGO_ROOT = ROOT;
const { appendTurn, loadThread } = await import('../src/thread.mjs');

test('appendTurn: failed 턴은 사장 지시문만 사유와 함께 남고 크루 메시지가 없다', async () => {
  await mkdir(join(ROOT, 'demo', 'chats'), { recursive: true });
  await appendTurn('demo', 'crew-f', { userMsg: '보고서 만들어줘', failed: '중단됨' });
  const t = await loadThread('demo', 'crew-f');
  assert.equal(t.messages.length, 1, '실패 턴은 user 1건만(크루 답변 없음)');
  assert.equal(t.messages[0].who, 'user');
  assert.equal(t.messages[0].failed, '중단됨');
});

test('appendTurn: via 출처표식이 사장 메시지에 보존된다(직접 지시는 필드 자체가 없다)', async () => {
  await appendTurn('demo', 'crew-v', { userMsg: '(동료 비스트의 쪽지) 검토 부탁', reply: '확인했다', handover: null, sessionId: null, via: 'crewmail' });
  await appendTurn('demo', 'crew-v', { userMsg: '직접 지시', reply: '넵', handover: null, sessionId: null });
  const t = await loadThread('demo', 'crew-v');
  const users = t.messages.filter((m) => m.who === 'user');
  assert.equal(users[0].via, 'crewmail');
  assert.equal('via' in users[1], false, '직접 지시는 via 미기록(사장 말풍선 유지)');
  assert.equal(t.messages.length, 4, '정상 턴은 user+crew 2건씩 — 기존 동작 불변');
  await rm(ROOT, { recursive: true, force: true });
});
