import test from 'node:test';
import assert from 'node:assert/strict';
import { dmMentionCrews, setDmRecipient, dmDeliveryMentions, dmUnavailableRecipients } from '../src/dm-delivery.mjs';
import { mentionsFromBody } from '../src/mention-candidates.mjs';
import { createComposerDelivery } from '../src/composer-delivery.mjs';

test('delegation scope is separate from participants and all stays inside DM', () => {
  const participants = [{ id: 'p', display_name: 'Pepper' }];
  const pool = dmMentionCrews(participants, [{ id: 'f', display_name: 'Feynman' }, participants[0]]);
  assert.deepEqual(participants.map((c) => c.id), ['p']);
  assert.deepEqual(pool.map((c) => c.id), ['p', 'f']);
  const toName = (c) => ({ kind: 'crew', id: c.id, name: c.display_name });
  assert.deepEqual(mentionsFromBody('@all', pool.map(toName), [], participants.map(toName)), [{ kind: 'crew', id: 'p' }]);
  assert.deepEqual(mentionsFromBody('@Feynman', pool.map(toName)), [{ kind: 'crew', id: 'f' }]);
  assert.deepEqual(mentionsFromBody('@Stranger', pool.map(toName), [{ kind: 'crew', id: 'x', name: 'Stranger' }]), []);
});

test('explicit recipients survive without @ text, override inline role, and can change role', () => {
  let selected = setDmRecipient([], { id: 'f', display_name: 'Feynman' }, 'to');
  selected = setDmRecipient(selected, { id: 'w', display_name: 'Wolff' }, 'cc');
  selected = setDmRecipient(selected, { id: 'f', display_name: 'Feynman' }, 'cc');
  assert.equal(selected.length, 2);
  assert.deepEqual(dmDeliveryMentions([], selected), [{ kind: 'crew', id: 'f', role: 'cc' }, { kind: 'crew', id: 'w', role: 'cc' }]);
  assert.deepEqual(dmDeliveryMentions([{ kind: 'crew', id: 'f' }], selected), dmDeliveryMentions([], selected));
  const legacy = [{ kind: 'crew', id: 'w' }, { kind: 'crew', id: 'f' }];
  assert.deepEqual(dmDeliveryMentions(legacy), legacy, 'normal legacy execution order unchanged');
});

test('failed delivery retains To/CC snapshot while subsequent draft and recipients are independent', async () => {
  const sent = []; let fail = true;
  const delivery = createComposerDelivery({ message: async (job) => { sent.push(structuredClone(job)); if (fail) throw Error('offline'); return 1; } });
  delivery.setText('Ask for a role');
  delivery.setRecipients(setDmRecipient([], { id: 'f', display_name: 'Feynman' }, 'to'));
  const snapshot = dmDeliveryMentions([], delivery.snapshot().recipients);
  await delivery.send(snapshot);
  assert.deepEqual(delivery.snapshot().recipients, []);
  delivery.setRecipients(setDmRecipient([], { id: 'w', display_name: 'Wolff' }, 'cc'));
  fail = false; await delivery.retry();
  assert.equal(sent[0].clientId, sent[1].clientId);
  assert.deepEqual(sent[0].mentions, sent[1].mentions);
  assert.deepEqual(sent[1].mentions, [{ kind: 'crew', id: 'f', role: 'to' }]);
  assert.equal(delivery.snapshot().recipients[0].id, 'w');
});


test('recipient support fails closed except ordinary messages to existing DM participants', () => {
  const to = { kind: 'crew', id: 'external', role: 'to' };
  const cc = { kind: 'crew', id: 'external', role: 'cc' };
  for (const role of [to, cc, { kind: 'crew', id: 'external' }]) {
    assert.deepEqual(dmUnavailableRecipients([role], [{ id: 'external', delivery_ready: false }]), [role]);
    assert.deepEqual(dmUnavailableRecipients([role], [{ id: 'external' }]), [role]);
    assert.deepEqual(dmUnavailableRecipients([role], []), [role]);
    assert.deepEqual(dmUnavailableRecipients([role], [{ id: 'external', delivery_ready: true }]), []);
  }
  assert.deepEqual(dmUnavailableRecipients([{kind:'crew',id:'partner'}], [], ['partner']), []);
  assert.deepEqual(dmUnavailableRecipients([{kind:'crew',id:'partner',role:'cc'}], [], ['partner']), [{kind:'crew',id:'partner',role:'cc'}]);
});
