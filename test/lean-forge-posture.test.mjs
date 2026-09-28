import test from 'node:test';
import assert from 'node:assert/strict';
import { LEAN_FORGE_POSTURE, leanForgePosture } from '../src/prompts/lean-forge-posture.mjs';

test('lean-forge posture preserves ko/en language and can be explicitly disabled', () => {
  const previous = process.env.ARGO_LEAN_FORGE;
  const legacy = process.env.ARGO_CASTRA;
  try {
    delete process.env.ARGO_LEAN_FORGE;
    delete process.env.ARGO_CASTRA;
    assert.match(leanForgePosture(), /답변은 한국어로 한다/);
    assert.equal(leanForgePosture('ko'), leanForgePosture());
    assert.equal(leanForgePosture('en'), `${LEAN_FORGE_POSTURE}\n\n`);
    process.env.ARGO_LEAN_FORGE = '0';
    assert.equal(leanForgePosture('ko'), '');
    assert.equal(leanForgePosture('en'), '');
    process.env.ARGO_LEAN_FORGE = '1';
    assert.equal(leanForgePosture('en'), `${LEAN_FORGE_POSTURE}\n\n`);
    process.env.ARGO_CASTRA = '0';
    assert.equal(leanForgePosture('en'), `${LEAN_FORGE_POSTURE}\n\n`);
    delete process.env.ARGO_LEAN_FORGE;
    assert.equal(leanForgePosture('en'), '', 'legacy opt-out remains effective until explicitly overridden');
  } finally {
    if (previous === undefined) delete process.env.ARGO_LEAN_FORGE;
    else process.env.ARGO_LEAN_FORGE = previous;
    if (legacy === undefined) delete process.env.ARGO_CASTRA;
    else process.env.ARGO_CASTRA = legacy;
  }
});

test('lean-forge includes ordered phases and evidence without claiming unavailable enforcement', () => {
  const phases = ['### SETTLE', '### BUILD', '### PROVE', '### REPORT'];
  const offsets = phases.map((phase) => LEAN_FORGE_POSTURE.indexOf(phase));
  assert.ok(offsets.every((offset, i) => offset >= 0 && (i === 0 || offset > offsets[i - 1])));
  assert.match(LEAN_FORGE_POSTURE, /Ponytail/);
  assert.match(LEAN_FORGE_POSTURE, /This prompt does not activate/);
  assert.match(LEAN_FORGE_POSTURE, /company language take precedence/);
  assert.match(LEAN_FORGE_POSTURE, /Re-editing invalidates evidence/);
  assert.match(LEAN_FORGE_POSTURE, /Never route around a denial/);
  assert.doesNotMatch(LEAN_FORGE_POSTURE, /(?:castra|xastra)_runtime\.py|forge_settle|forge_verify|TYPESAFE_API_KEY|\/castra\b|\/ponytail\b/);
});
