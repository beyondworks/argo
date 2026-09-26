import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTurn, interruptTurn, withTurnControl } from '../src/turn-abort.mjs';
import { isStopCommand } from '../src/stop-command.mjs';

test('standalone stop commands and negative/content examples', () => {
  for (const text of ['멈춰', '멈춰줘!', '중지해', '중단해주세요', '그만', 'stop', 'Please stop.', '지금 하던 작업 멈춰줘', '작업 중지해줘', '현재 진행 중인 작업을 중단해주세요', '지금 멈춰']) assert.equal(isStopCommand(text),true,text);
  for (const text of ['멈추지마', '중지하는 방법 알려줘', '루틴에서 중지해 라고 답하면', '`stop`', '> stop', '"멈춰"', 'stop the server tomorrow', '이것을 멈춰', '지금 하던 작업 멈추지 마', '작업 중지하는 방법 알려줘', '작업 중지해줘 그리고 메일 보내', '지금 다른 작업 멈춰', '작업 중지해줘?', '']) assert.equal(isStopCommand(text),false,text);
});
test('all current handles are interrupted without touching a different crew or future instruction', async()=>{
  const calls=[];
  const group=Symbol('execution');
  const a=registerTurn('ws','a',()=>calls.push('a1'),{group});
  const b=registerTurn('ws','a',()=>calls.push('a2'),{group});
  const other=registerTurn('ws','b',()=>calls.push('b'));
  await interruptTurn('ws','a'); assert.deepEqual(calls,['a1','a2']); assert.ok(a.wasAborted()&&b.wasAborted()); assert.equal(other.wasAborted(),false);
  a.release();b.release();other.release();assert.equal(await interruptTurn('ws','a'),false);
});
test('cancelled lifetime rejects retry and tool continuation before new execution',async()=>{
  let calls=0;
  await assert.rejects(withTurnControl('ws','a',null,async(control)=>{
    await interruptTurn('ws','a');
    return withTurnControl('ws','a',control,()=>{calls++;});
  }),e=>e.aborted===true);
  assert.equal(calls,0);
});


test('source selection and logical groups preserve independent same-crew work',async()=>{
 const calls=[];
 const otherDm=registerTurn('ws','crew',()=>calls.push('other DM'),{source:'messenger'});
 const routine=registerTurn('ws','crew',()=>calls.push('routine'),{source:'routine'});
 const firstChat=registerTurn('ws','crew',()=>calls.push('older chat'));
 const group=Symbol('current');
 const setup=registerTurn('ws','crew',()=>calls.push('setup'),{group});
 const provider=registerTurn('ws','crew',()=>calls.push('provider'),{group});
 await interruptTurn('ws','crew',{source:'chat'});
 assert.deepEqual(calls,['setup','provider']);
 for(const entry of [otherDm,routine,firstChat])assert.equal(entry.wasAborted(),false);
 for(const entry of [otherDm,routine,firstChat,setup,provider])entry.release();
});


test('a preparation error after cancellation stays terminal instead of retryable',async()=>{
 await assert.rejects(withTurnControl('ws','preparing',null,async()=>{
  await interruptTurn('ws','preparing');throw new Error('transport failure');
 }),e=>e.aborted===true);
});
test('incomplete process cleanup survives cancellation lifetime wrapping',async()=>{
 await assert.rejects(withTurnControl('ws','incomplete',null,async()=>{
  await interruptTurn('ws','incomplete');
  throw Object.assign(new Error('child cleanup uncertain'),{aborted:true,cancellationIncomplete:true});
 }),e=>e.aborted===true&&e.cancellationIncomplete===true);
});

test('registry is shared across bundled module copies (gateway turn vs abort route) — stop reaches messenger turns', async () => {
  // Next builds src/turn-abort.mjs into instrumentation.js and into each route bundle separately;
  // a query string forces a second module instance here the same way.
  const copyA = await import('../src/turn-abort.mjs?bundle=gateway');
  const copyB = await import('../src/turn-abort.mjs?bundle=abort-route');
  const calls = [];
  const reg = copyA.registerTurn('ws-x', 'pepper', () => calls.push('stopped'), { source: 'messenger' });
  assert.equal(await copyB.interruptTurn('ws-x', 'pepper', { source: 'messenger' }), true, 'abort route copy must see the gateway copy registration');
  assert.deepEqual(calls, ['stopped']);
  assert.equal(reg.wasAborted(), true);
  reg.release();
  assert.equal(await copyB.interruptTurn('ws-x', 'pepper'), false, 'released registration is gone from the shared registry');
});

// 크루 작업 중단 검수 2026-09-26 M-1: 텔레그램 브리지(src/gateway.mjs)와 결재 후속(approval-actions.mjs)도
// chat(..., {source:'messenger'})를 쓴다 — 같은 크루의 메신저 잡과 같은 source 아래 동시에 살아 있을 수 있다.
// tag 없이는 "최신 같은 source"를 멈춰 엉뚱한 턴(텔레그램)이 죽는다. tag를 주면 정확히 그 실행만 멈춘다.
test('a tagged stop targets exactly its own execution and leaves a concurrent same-source turn (e.g. Telegram) running', async () => {
  const calls = [];
  const telegramTurn = registerTurn('ws-tag', 'seoyun', () => calls.push('telegram-stopped'), { source: 'messenger' }); // started first, no tag (legacy caller)
  const msgrTurn = registerTurn('ws-tag', 'seoyun', () => calls.push('messenger-stopped'), { source: 'messenger', tag: 41 }); // messenger job for source_msg_id 41
  try {
    assert.equal(await interruptTurn('ws-tag', 'seoyun', { source: 'messenger', tag: 41 }), true);
    assert.deepEqual(calls, ['messenger-stopped'], '태그가 맞는 실행만 멈춘다 — 텔레그램 턴은 그대로');
    assert.equal(msgrTurn.wasAborted(), true);
    assert.equal(telegramTurn.wasAborted(), false, '동시에 살아 있는 텔레그램 턴은 건드리지 않는다');
  } finally { telegramTurn.release(); msgrTurn.release(); }
});

test('a stale/mismatched tag aborts nothing instead of falling back to "the latest turn"', async () => {
  const calls = [];
  const reg = registerTurn('ws-tag2', 'seoyun', () => calls.push('stopped'), { source: 'messenger', tag: 41 });
  try {
    assert.equal(await interruptTurn('ws-tag2', 'seoyun', { source: 'messenger', tag: 99 }), false, '이미 끝났거나 다른 메시지의 중단 요청은 무시');
    assert.deepEqual(calls, []);
    assert.equal(reg.wasAborted(), false);
  } finally { reg.release(); }
});

test('an untagged stop (desktop stop button, no source_msg_id) still hits the latest same-source turn as before', async () => {
  const calls = [];
  const reg = registerTurn('ws-tag3', 'seoyun', () => calls.push('stopped'), { source: 'messenger', tag: 41 });
  try {
    assert.equal(await interruptTurn('ws-tag3', 'seoyun', { source: 'messenger' }), true, '태그를 안 주면 종전 동작(최신 같은 source)');
    assert.deepEqual(calls, ['stopped']);
  } finally { reg.release(); }
});
