// 결재 후속 배달(S4) — 카드가 "담당 크루가 이어서 보고합니다"라고 약속하고 영원히 무소식이던
// 데드엔드(실사용 제보 2026-07-30)의 배선을 잠근다. followUp 자체는 실 러너가 필요해 여기선
// 배선(방송 2경로 + 게이트웨이 소비)을 소스로 잠그고, 라이브는 S6 통합검증이 담당한다(정직 표기).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { emitNotify, onNotify } from '../src/notify.mjs';

test('notify 왕복: approval_followup 이벤트가 핸들러에 그대로 도달한다', async () => {
  const got = [];
  const off = onNotify((e) => { if (e.type === 'approval_followup') got.push(e); });
  emitNotify({ type: 'approval_followup', wsId: 'w1', item: { id: 'ap-x', tg: { chatId: 7 } }, reply: '보고: files/제안서.pptx' });
  await new Promise((r) => setTimeout(r, 10)); // emitNotify는 마이크로태스크로 팬아웃
  off();
  assert.equal(got.length, 1);
  assert.equal(got[0].item.tg.chatId, 7);
  assert.match(got[0].reply, /files\/제안서\.pptx/);
});

test('배선: followUp이 성공·실패 양 경로에서 방송하고, 게이트웨이가 원 채널로 sendTgReply 한다', async () => {
  const aa = await readFile(new URL('../src/approval-actions.mjs', import.meta.url), 'utf8');
  assert.equal(aa.split("emitNotify({ type: 'approval_followup'").length - 1, 2, '성공+실패 두 경로 방송');
  const gw = await readFile(new URL('../src/gateway.mjs', import.meta.url), 'utf8');
  assert.match(gw, /event\.type === 'approval_followup'/, '게이트웨이 소비부');
  const block = gw.split("event.type === 'approval_followup'")[1]?.slice(0, 500) ?? '';
  assert.match(block, /it\?\.tg\?\.chatId && all\.telegram\.token/, '결재 카드가 온 방으로만');
  assert.match(block, /sendTgReply\(/, 'sendTgReply 경유 — 본문 속 파일 경로가 자동 첨부(S2)되는 경로');
});
