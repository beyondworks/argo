import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relayReply } from '../integrations/openclaw-argo-msgr/src/api.js';
import { messengerRecipientText, parseMessengerDisposition } from '../src/gateway/msgr-handoff.mjs';
import { mentionsIn } from '../src/gateway/msgr.mjs';

const peers = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];
const cases = [
  ['legacy To', '@Alpha next\nMSGR: handoff', peers, [{ kind: 'crew', id: 'a' }]],
  ['explicit CC', '@Alpha answer\nCC: @Beta\nMSGR: handoff', peers, [{ kind: 'crew', id: 'a' }, { kind: 'crew', id: 'b', role: 'cc' }]],
  ['case insensitive', '@alpha answer\ncc: @BETA\nMSGR: handoff', peers, [{ kind: 'crew', id: 'a' }, { kind: 'crew', id: 'b', role: 'cc' }]],
  ['done cancels', '@Alpha answer\nCC: @Beta\nMSGR: done', peers, []],
  ['missing disposition', '@Alpha answer\nCC: @Beta', peers, []],
  ['unknown recipient', '@Unknown next\nCC: @Missing\nMSGR: handoff', peers, []],
  ['ambiguous name', '@Alpha next\nMSGR: handoff', [...peers, { id: 'c', name: 'ALPHA' }], []],
  ['quoted CC', '@Alpha answer\n> CC: @Beta\nMSGR: handoff', peers, [{ kind: 'crew', id: 'a' }]],
  ['fenced CC', '@Alpha answer\n```\nCC: @Beta\n```\nMSGR: handoff', peers, [{ kind: 'crew', id: 'a' }]],
  ['CC only is passive', 'CC: @Beta\nMSGR: handoff', peers, [{ kind: 'crew', id: 'b', role: 'cc' }]],
  ['CC overrides To', '@Alpha next\nCC: @Alpha\nMSGR: handoff', peers, [{ kind: 'crew', id: 'a', role: 'cc' }]],
  ['quoted To', '> @Beta next\n@Alpha answer\nMSGR: handoff', peers, [{ kind: 'crew', id: 'a' }]],
];

for (const [name, body, roster, expected] of cases) test(`OpenClaw delivery roles: ${name}`, () => {
  assert.deepEqual(relayReply(body, { peers: roster }).execution.mentions, expected);
});

test('resident and packaged adapters classify the same recipients', () => {
  for(const [name,body,roster,expected] of cases){
    const parsed=parseMessengerDisposition(body);
    if(parsed.disposition!=='handoff')continue;
    const parts=messengerRecipientText(parsed.text);
    const local=roster.map(p=>({...p,display_name:p.name}));
    const copied=mentionsIn(parts.cc,local,'self');
    const copiedIds=new Set(copied.map(p=>p.id));
    const actual=[...mentionsIn(parts.to,local,'self').filter(p=>!copiedIds.has(p.id)),...copied.map(p=>({...p,role:'cc'}))];
    assert.deepEqual(actual,expected,name);
  }
});

test('Hermes delivery roles match the same wire cases', () => {
  const script = String.raw`
import importlib.util,json,sys,types
for name in ['gateway','gateway.config','gateway.platforms','gateway.platforms.base']:
    sys.modules[name]=types.ModuleType(name)
sys.modules['gateway.config'].Platform=str
base=sys.modules['gateway.platforms.base']
base.BasePlatformAdapter=object
base.MessageEvent=base.SendResult=base.MessageType=object
spec=importlib.util.spec_from_file_location('adapter',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
rows=json.load(sys.stdin)
print(json.dumps([m.relay_reply(text,{'peers':peers})['mentions'] for _,text,peers,_ in rows]))
`;
  const result = spawnSync('python3', ['-c', script, fileURLToPath(new URL('../integrations/hermes-argo-msgr/adapter.py', import.meta.url))], { input: JSON.stringify(cases), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), cases.map((row) => row[3]));
});
