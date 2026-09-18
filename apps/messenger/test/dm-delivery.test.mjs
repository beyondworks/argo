import test from 'node:test';
import assert from 'node:assert/strict';
import { dmMentionCrews, mentionPopupCrews, setDmRecipient, dmDeliveryMentions, dmUnavailableRecipients, relayCaptionKey, relayToLabel, relayToNames } from '../src/dm-delivery.mjs';
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

test('relay caption prefers the forwarding crew, then the known origin DM name, else a generic key', () => {
  assert.deepEqual(relayCaptionKey({ via_name: 'Pepper' }, 'Feynman'), { key: 'dm.relay.from', vars: { name: 'Pepper' } }, 'via_name wins even if the origin DM name is also known');
  assert.deepEqual(relayCaptionKey({ via_name: null }, 'Feynman'), { key: 'dm.relay.from', vars: { name: 'Feynman' } }, 'falls back to the origin DM name when no crew forwarded it');
  assert.deepEqual(relayCaptionKey({ via_name: null }, null), { key: 'dm.relay.fromOther' }, 'name-free only when neither is known');
});

test('relay_to labels mark CC with the given role label, To stays plain', () => {
  const to = { crew_id: 'f', channel_id: 'ch1', role: 'to', name: 'Feynman' };
  const cc = { crew_id: 'w', channel_id: 'ch2', role: 'cc', name: 'Wolff' };
  assert.equal(relayToLabel(to, 'CC'), 'Feynman');
  assert.equal(relayToLabel(cc, 'CC'), 'Wolff (CC)');
  assert.equal(relayToNames([to, cc], 'CC'), 'Feynman, Wolff (CC)');
});

test('relay_to helpers fail closed on malformed data instead of throwing', () => {
  assert.equal(relayToLabel(null, 'CC'), '', 'null entry');
  assert.equal(relayToLabel({ role: 'cc' }, 'CC'), '', 'missing name');
  assert.equal(relayToNames(undefined, 'CC'), '', 'undefined list');
  assert.equal(relayToNames({}, 'CC'), '', 'non-array list (e.g. a stray object in meta.relay_to)');
  assert.equal(relayToNames([{ role: 'to' }, { role: 'cc', name: 'Wolff' }], 'CC'), 'Wolff (CC)', 'blank labels are dropped, not left as empty items');
});

test('@ 팝업 후보 — 대화방에서는 그 방에 들어온 에이전트만, 방 밖 에이전트는 빠진다(본문 @이름 해석 풀에는 남는다)', () => {
  // 유건 제보(2026-09-18): 다빈치만 있는 방 "다빈치, crystal"에서 @를 치면 방 밖 알프레드·비스트·…까지 떴다.
  const room = [{ id: 'davinci', display_name: '다빈치' }];
  const outside = [{ id: 'alfred', display_name: '알프레드' }, { id: 'beast', display_name: '비스트' }];
  assert.deepEqual(mentionPopupCrews({ isDm: true, roomCrews: room, usable: [...room, ...outside] }).map((c) => c.id), ['davinci']);
  assert.deepEqual(mentionPopupCrews({ isDm: true, roomCrews: null, usable: outside }), [], '방 구성을 모르면 아무도 띄우지 않는다');
  // 방 밖 에이전트를 받는이로 부르는 길(본문 @이름 해석)은 그대로다
  assert.deepEqual(dmMentionCrews(room, outside).map((c) => c.id), ['davinci', 'alfred', 'beast']);
  // 채널은 종전대로 — 방 구성이 있으면 그것, 없으면 쓸 수 있는 전체
  assert.deepEqual(mentionPopupCrews({ isDm: false, roomCrews: null, usable: outside }).map((c) => c.id), ['alfred', 'beast']);
  assert.deepEqual(mentionPopupCrews({ isDm: false, roomCrews: room, usable: outside }).map((c) => c.id), ['davinci']);
});
