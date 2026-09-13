import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchMessengerAutomations } from '../src/gateway/msgr-automations.mjs';
test('scheduler uses server-owned due-time RPC and preserves database results', async () => {
  const runs = [{ id: 'run', status: 'queued' }];
  const client = { rpc: async (name,args) => { assert.equal(name,'msgr_automation_dispatch_due'); assert.deepEqual(args,{p_ws:'test'}); return {data:runs}; } };
  assert.deepEqual(await dispatchMessengerAutomations(client,'test'),{available:true,runs});
});
test('old database has an explicit unavailable state, operational errors are not hidden', async () => {
  assert.deepEqual(await dispatchMessengerAutomations({rpc:async()=>({error:{code:'PGRST202'}})},'test'),{available:false,runs:[]});
  await assert.rejects(dispatchMessengerAutomations({rpc:async()=>({error:{code:'42501',message:'forbidden'}})},'test'),/forbidden/);
});
