import { spawn } from 'node:child_process';

const PROTOCOL = 'argo-ego-capabilities-v1';
const PROBE = `console.log(JSON.stringify({protocol:${JSON.stringify(PROTOCOL)},taskSpace:typeof taskSpace==='function',profiles:typeof profiles==='function'}));\n`;

/** The documented nodejs entry point can be probed without opening tabs or listing profiles. */
export function detectEgoBrowser({ command = 'ego-browser', env = process.env, timeoutMs = 5000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child; let timer; let done = false; let stdout = ''; let stderr = '';
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawnImpl(command, ['nodejs'], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      finish({ available: false, reason: 'ego_unavailable' });
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish({ available: false, reason: 'ego_probe_timeout' });
    }, timeoutMs);
    child.on('error', () => finish({ available: false, reason: 'ego_unavailable' }));
    child.stdin.on('error', () => finish({ available: false, reason: 'ego_probe_failed' }));
    const receive = (stream, data) => {
      if (stream === 'stdout') stdout += String(data); else stderr += String(data);
      if (stdout.length + stderr.length > 16_384) {
        child.kill();
        finish({ available: false, reason: 'ego_probe_invalid' });
      }
    };
    child.stdout.on('data', (data) => receive('stdout', data));
    // Ego 0.5 writes nodejs console receipts to stderr. Parse only our explicit
    // capability receipt from either stream; never expose surrounding diagnostics.
    child.stderr.on('data', (data) => receive('stderr', data));
    child.on('close', (code) => {
      if (code !== 0) return finish({ available: false, reason: 'ego_probe_failed' });
      const receipts = `${stdout}\n${stderr}`.split(/\r?\n/).flatMap((line) => {
        try { const value = JSON.parse(line); return value?.protocol === PROTOCOL ? [value] : []; } catch { return []; }
      });
      const receipt = receipts.length === 1 ? receipts[0] : null;
      finish(receipt?.taskSpace === true && receipt?.profiles === true
        ? { available: true, profileSelection: true, profileProvisioning: false, profileOwnershipVerification: false }
        : { available: false, reason: 'ego_probe_invalid' });
    });
    child.stdin.end(PROBE);
  });
}

/** Bindings must come from the host's complete trusted registry, never from tool/model input. */
export function validateEgoProfileBindings({ bindings, wsId, slug }) {
  if (!Array.isArray(bindings) || !wsId || !slug) return { valid: false, reason: 'ego_profile_binding_missing' };
  const owners = new Set(); const profiles = new Set(); let selected;
  for (const binding of bindings) {
    if (!binding || typeof binding.wsId !== 'string' || !binding.wsId || typeof binding.slug !== 'string' || !binding.slug
      || typeof binding.profileId !== 'string' || !binding.profileId || binding.profileId !== binding.profileId.trim()) return { valid: false, reason: 'ego_profile_binding_invalid' };
    const owner = JSON.stringify([binding.wsId, binding.slug]);
    if (owners.has(owner) || profiles.has(binding.profileId)) return { valid: false, reason: 'ego_profile_binding_collision' };
    owners.add(owner); profiles.add(binding.profileId);
    if (binding.wsId === wsId && binding.slug === slug) selected = binding;
  }
  return selected ? { valid: true, profileId: selected.profileId } : { valid: false, reason: 'ego_profile_binding_missing' };
}

/** Select before any browser action; never retry an action on another provider. */
export async function selectIsolatedBrowserProvider({ requested = 'chromium', bindings, wsId, slug, probe = detectEgoBrowser } = {}) {
  if (requested !== 'ego') return { provider: 'chromium', isolation: 'agent-profile' };
  const capability = await probe();
  if (!capability.available) return { provider: 'chromium', isolation: 'agent-profile', reason: capability.reason };
  const binding = validateEgoProfileBindings({ bindings, wsId, slug });
  if (!binding.valid) return { provider: 'chromium', isolation: 'agent-profile', reason: binding.reason };
  // Ego v2 documents only profiles() and taskSpace(nameOrId, { profileId }); the
  // latter applies only to NEW spaces. There is no documented provisioning or
  // exclusive profile ownership check. Unique task spaces alone share cookies.
  // Keep the verified Chromium profile path until an actual ego isolation contract exists.
  return { provider: 'chromium', isolation: 'agent-profile', reason: 'ego_profile_ownership_unverifiable' };
}
