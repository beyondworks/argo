import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTurn, interruptTurn, withTurnControl } from '../src/turn-abort.mjs';
import { isStopCommand } from '../src/stop-command.mjs';

test('standalone stop commands and negative/content examples', () => {
  for (const text of ['멈춰', '멈춰줘!', '중지해', '중단해주세요', '그만', 'stop', 'Please stop.']) assert.equal(isStopCommand(text),true,text);
  for (const text of ['멈추지마', '중지하는 방법 알려줘', '루틴에서 중지해 라고 답하면', '`stop`', '> stop', '"멈춰"', 'stop the server tomorrow', '이것을 멈춰', '']) assert.equal(isStopCommand(text),false,text);
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
