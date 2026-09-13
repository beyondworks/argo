import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { detectEgoBrowser, validateEgoProfileBindings, selectIsolatedBrowserProvider } from '../src/engine/ego-browser-provider.mjs';

function cliStub(receipt, { code = 0, hang = false, stream = 'stdout' } = {}) {
  let invocation; let script = ''; let killed = false;
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { killed = true; };
    child.stdin.on('data', (data) => { script += String(data); });
    child.stdin.on('finish', () => {
      if (hang) return;
      child[stream].write(receipt);
      child.emit('close', code);
    });
    return child;
  };
  return { spawnImpl, invocation: () => invocation, script: () => script, killed: () => killed };
}

test('documented CLI probe detects capabilities without enumerating profiles or creating spaces', async () => {
  const cli = cliStub('{"protocol":"argo-ego-capabilities-v1","taskSpace":true,"profiles":true}\n[ego-browser:notice] update available\n');
  const result = await detectEgoBrowser({ spawnImpl: cli.spawnImpl });
  assert.equal(result.available, true);
  assert.equal(result.profileOwnershipVerification, false);
  assert.deepEqual(cli.invocation().args, ['nodejs']);
  assert.equal(cli.invocation().options.shell, false);
  const receipts = [];
  runInNewContext(cli.script(), {
    profiles: () => { throw new Error('Must not list private profiles'); },
    taskSpace: () => { throw new Error('Must not create browser spaces'); },
    console: { log: (receipt) => receipts.push(JSON.parse(receipt)) },
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].profiles, true);
});

test('Ego console receipts on stderr are accepted without returning diagnostics', async () => {
  const cli = cliStub('[ego-browser:notice] update available\n{"protocol":"argo-ego-capabilities-v1","taskSpace":true,"profiles":true}\n', { stream: 'stderr' });
  assert.deepEqual(await detectEgoBrowser({ spawnImpl: cli.spawnImpl }), {
    available: true, profileSelection: true, profileProvisioning: false, profileOwnershipVerification: false,
  });
});

test('missing, failed, malformed and timed-out CLI probes fail closed', async () => {
  assert.equal((await detectEgoBrowser({ spawnImpl: () => { throw new Error('ENOENT'); } })).reason, 'ego_unavailable');
  for (const receipt of ['not json', '{"protocol":"argo-ego-capabilities-v1","taskSpace":true}']) {
    assert.equal((await detectEgoBrowser({ spawnImpl: cliStub(receipt).spawnImpl })).available, false);
  }
  assert.equal((await detectEgoBrowser({ spawnImpl: cliStub('', { code: 1 }).spawnImpl })).reason, 'ego_probe_failed');
  const hanging = cliStub('', { hang: true });
  assert.equal((await detectEgoBrowser({ spawnImpl: hanging.spawnImpl, timeoutMs: 5 })).reason, 'ego_probe_timeout');
  assert.equal(hanging.killed(), true);
});

test('complete profile registry rejects cross-agent and cross-company cookie sharing', () => {
  const one = { wsId: 'company-a', slug: 'shuri', profileId: 'profile-a' };
  for (const other of [{ ...one, slug: 'carmack' }, { ...one, wsId: 'company-b' }, { ...one, profileId: 'profile-b' }]) {
    assert.equal(validateEgoProfileBindings({ bindings: [one, other], wsId: one.wsId, slug: one.slug }).reason, 'ego_profile_binding_collision');
  }
  assert.deepEqual(validateEgoProfileBindings({ bindings: [one, { ...one, slug: 'carmack', profileId: 'profile-b' }], wsId: one.wsId, slug: one.slug }), { valid: true, profileId: 'profile-a' });
});

test('provider selection uses isolated Chromium when ego is absent or ownership is unverifiable', async () => {
  let probes = 0;
  const probe = async () => { probes++; return { available: true }; };
  assert.equal((await selectIsolatedBrowserProvider({ probe })).provider, 'chromium');
  assert.equal(probes, 0);
  const scope = { wsId: 'company-a', slug: 'shuri' };
  const result = await selectIsolatedBrowserProvider({ requested: 'ego', ...scope, bindings: [{ ...scope, profileId: 'profile-a' }], probe });
  assert.deepEqual(result, { provider: 'chromium', isolation: 'agent-profile', reason: 'ego_profile_ownership_unverifiable' });
  assert.equal((await selectIsolatedBrowserProvider({ requested: 'ego', probe: async () => ({ available: false, reason: 'ego_unavailable' }) })).reason, 'ego_unavailable');
});
