// Execute the shipped Python adapter with a minimal gateway interface; no LLM or user config.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Hermes binds concurrent responses to source claims, keeps thread/channel, and only explicit handoff wakes peers', () => {
  const script = String.raw`
import asyncio, importlib.util, sys, types, tempfile
from pathlib import Path
for name in ['gateway', 'gateway.config', 'gateway.platforms', 'gateway.platforms.base']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['gateway.config'].Platform = str
class Box:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
class Base:
    def __init__(self, **kwargs): self._message_handler = True
    def build_source(self, **kwargs): return Box(**kwargs)
    async def handle_message(self, event):
        await asyncio.sleep(0.001)
        await self.send(event.source.chat_id, '@Peer continue\nMSGR: handoff', metadata={'notify':True})
b = sys.modules['gateway.platforms.base']
b.BasePlatformAdapter = Base
b.MessageEvent = b.SendResult = Box
b.MessageType = Box(TEXT='text')
spec = importlib.util.spec_from_file_location('argo_adapter', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = m.ArgoMsgrAdapter(Box(extra={}))
a._me = {'id':'bot'}
tmp = tempfile.TemporaryDirectory()
a._outbox = Path(tmp.name)
calls = []
async def api(method, params, **kwargs):
    calls.append((method,params)); return {'message_id':99}
a._api = api
source = lambda mid, chat: {'message_id':mid, 'execution_attempt':str(mid), 'text':'start', 'chat':{'id':chat}, 'from':{'id':'user'}, 'peers':[{'id':'peer-id','name':'Peer'}]}
async def check():
    await asyncio.gather(a._dispatch(source(1,'a')), a._dispatch(source(2,'b')))
    assert len(calls) == 2
    for _,p in calls:
        assert p['chat_id'] == ('a' if p['reply_to_message_id'] == 1 else 'b')
        assert p['execution_attempt'] == str(p['reply_to_message_id'])
        assert p['mentions'] == [{'kind':'crew','id':'peer-id'}]
        assert p['text'] == '@Peer continue'
    assert len(a._pending) == 0
    assert not (await a.send('a','duplicate',reply_to='1',metadata={'notify':True})).success
    a._pending[3] = source(3,'a')
    assert (await a.send('a','partial',reply_to='3',metadata={'notify':False})).success
    assert len(calls) == 2
    assert not (await a.send('b','wrong channel',reply_to='3',metadata={'notify':True})).success
    assert len(calls) == 2
    assert (await a.send('a','@Peer thanks\nMSGR: done',reply_to='3',metadata={'notify':True})).success
    assert calls[-1][1]['mentions'] == []
    for text in ['@Peer text',chr(96)*3+'\nMSGR: handoff','> MSGR: handoff','@Peer thanks\nMSGR: done']:
        assert m.relay_reply(text,source(4,'a'))['mentions'] == []
    assert m.relay_reply('@Peer next\nMSGR: handoff',source(4,'a'))['mentions'] == [{'kind':'crew','id':'peer-id'}]
    ambiguous=source(5,'a'); ambiguous['peers'].append({'id':'other','name':'Peer'})
    assert m.relay_reply('@Peer next\nMSGR: handoff',ambiguous)['mentions'] == []
    a._pending[6] = source(6,'a')
    async def fail(method, params, **kwargs): raise OSError('network unavailable')
    a._api = fail
    assert not (await a.send('a','saved result\nMSGR: done',reply_to='6',metadata={'notify':True})).success
    assert len(list(a._outbox.glob('*.json'))) == 1
    # New transport instance drains the saved final answer without invoking handle_message.
    replacement = m.ArgoMsgrAdapter(Box(extra={}))
    replacement._outbox = a._outbox; replacement._api = api
    await replacement._flush_outbox()
    assert calls[-1][1]['text'] == 'saved result'
    assert not list(a._outbox.glob('*.json'))
    a._pending[7] = source(7,'a'); a._api = fail
    assert not (await a.send('a','retained answer',reply_to='7',metadata={'notify':True})).success
    async def revoked(method, params=None, **kwargs):
        if method == 'sendMessage': raise m.ArgoMsgrError(403,'policy revoked')
        return [{'update_id':8,'message':{'text':'new owner request'}}]
    replacement._api = revoked
    await replacement._flush_outbox()
    assert not list(a._outbox.glob('*.json'))
    assert len(list((a._outbox / 'failed').glob('*.json'))) == 1
    assert (await replacement._api('getUpdates'))[0]['update_id'] == 8

asyncio.run(check())
tmp.cleanup()
print('Hermes adapter behavioral checks passed')
`;
  const file=fileURLToPath(new URL('../integrations/hermes-argo-msgr/adapter.py',import.meta.url));
  let result=spawnSync('python3',['-B','-c',script,file],{encoding:'utf8'});
  if(result.error?.code==='ENOENT') result=spawnSync('python',['-B','-c',script,file],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr || String(result.error));
  assert.match(result.stdout,/behavioral checks passed/);
});
