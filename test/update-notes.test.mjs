import test from 'node:test';
import assert from 'node:assert/strict';
import { UPDATE_NOTES_STORAGE_KEY, stableVersion, updateNotesFor, shouldShowUpdateNotes, isEditingElement,
  readUpdateNotesVersion, acknowledgeUpdateNotesVersion } from '../app/update-notes-state.mjs';

const eligible = { current: '0.1.88', bundleVersion: '0.1.88', ready: true, loaded: true };
const store = (initial = null) => {
  let value = initial; const writes = [];
  return { getItem: (key) => { assert.equal(key, UPDATE_NOTES_STORAGE_KEY); return value; },
    setItem: (key, next) => { assert.equal(key, UPDATE_NOTES_STORAGE_KEY); writes.push(next); value = next; }, writes };
};

test('only exact, safe, stable x.y.z versions with authored notes are eligible', () => {
  for (const version of ['0.1.88', '1.10.0', '10.0.1']) assert.equal(stableVersion(version), true);
  for (const version of ['', null, 1, 'v0.1.88', '0.1', '01.1.88', '0.1.88-rc.1', '0.1.88+dev', ' 0.1.88', '99999999999999999999.1.0']) {
    assert.equal(stableVersion(version), false, String(version));
  }
  assert.equal(updateNotesFor('0.1.88', '0.1.88').length, 4);
  assert.deepEqual(updateNotesFor('0.1.87', '0.1.88'), []);
  assert.deepEqual(updateNotesFor('0.1.89', '0.1.89'), []);
  assert.deepEqual(updateNotesFor('0.1.88-rc.1', '0.1.88-rc.1'), []);
});

test('first visit and skipped versions show current notes; acknowledged or downgraded versions do not', () => {
  assert.equal(shouldShowUpdateNotes(eligible), true);
  assert.equal(shouldShowUpdateNotes({ ...eligible, ackVersion: '0.1.1' }), true);
  assert.equal(shouldShowUpdateNotes({ ...eligible, ackVersion: '0.1.88' }), false);
  assert.equal(shouldShowUpdateNotes({ ...eligible, ackVersion: '0.1.100' }), false);
  assert.equal(shouldShowUpdateNotes({ ...eligible, ackVersion: 'bad marker' }), true);
  assert.equal(shouldShowUpdateNotes({ ...eligible, current: '0.1.87' }), false);
});

test('busy, hidden, editing, overlay and session dismissal defer display without acknowledgement', () => {
  for (const flag of ['blocked', 'hidden', 'editing', 'overlay', 'dismissed']) {
    assert.equal(shouldShowUpdateNotes({ ...eligible, [flag]: true }), false, flag);
  }
  for (const flag of ['ready', 'loaded']) assert.equal(shouldShowUpdateNotes({ ...eligible, [flag]: false }), false, flag);
  for (const element of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(isEditingElement(element), true);
  }
  assert.equal(isEditingElement(null), false);
  assert.equal(isEditingElement({ tagName: 'BUTTON' }), false);
});

test('web marker is written only by explicit acknowledgement and never moved backwards', async () => {
  const storage = store();
  assert.equal(await readUpdateNotesVersion({ isApp: false, storage }), null);
  assert.deepEqual(storage.writes, []);
  await acknowledgeUpdateNotesVersion('0.1.88', { isApp: false, storage });
  assert.equal(await readUpdateNotesVersion({ isApp: false, storage }), '0.1.88');
  await acknowledgeUpdateNotesVersion('0.1.88', { isApp: false, storage });
  assert.deepEqual(storage.writes, ['0.1.88']);
  const newer = store('0.1.100');
  await acknowledgeUpdateNotesVersion('0.1.88', { isApp: false, storage: newer });
  assert.deepEqual(newer.writes, []);
  await assert.rejects(acknowledgeUpdateNotesVersion('0.1.89', { isApp: false, storage }), /No update notes/);
});

test('native uses exact commands and waits for successful acknowledgement, with no web fallback', async () => {
  const calls = []; const storage = store();
  let finish;
  const invoke = (command, args) => {
    calls.push([command, args]);
    return command === 'read_update_notes_version' ? Promise.resolve('0.1.87') : new Promise((resolve) => { finish = resolve; });
  };
  assert.equal(await readUpdateNotesVersion({ isApp: true, invoke, storage }), '0.1.87');
  let acknowledged = false;
  const pending = acknowledgeUpdateNotesVersion('0.1.88', { isApp: true, invoke, storage }).then(() => { acknowledged = true; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  finish('0.1.88'); await pending;
  assert.equal(acknowledged, true);
  assert.deepEqual(calls, [['read_update_notes_version', undefined], ['acknowledge_update_notes_version', { version: '0.1.88' }]]);
  assert.deepEqual(storage.writes, []);
  await assert.rejects(acknowledgeUpdateNotesVersion('0.1.88', { isApp: true, invoke: async () => undefined }), /not saved/);
  await assert.rejects(readUpdateNotesVersion({ isApp: true, invoke: async () => 'bad marker' }), /Invalid native/);
});

test('native and web storage failures reject instead of claiming a saved acknowledgement', async () => {
  const storage = store();
  const invoke = async () => { throw new Error('native unavailable'); };
  await assert.rejects(readUpdateNotesVersion({ isApp: true, invoke, storage }), /native unavailable/);
  await assert.rejects(acknowledgeUpdateNotesVersion('0.1.88', { isApp: true, invoke, storage }), /native unavailable/);
  assert.deepEqual(storage.writes, []);
  await assert.rejects(readUpdateNotesVersion({ isApp: false, storage: { getItem() { throw new Error('storage blocked'); } } }), /storage blocked/);
  await assert.rejects(acknowledgeUpdateNotesVersion('0.1.88', { isApp: false,
    storage: { getItem: () => null, setItem() { throw new Error('storage full'); } } }), /storage full/);
});
