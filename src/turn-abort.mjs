// A crew can have more than one active entry (provider, preparation, retry).
// Keep every handle: replacing the latest entry orphaned the preceding execution.
// Process-local, as before: a different server process must route cancellation to its owner.
const active = new Map();
export const turnAbortedError = () => Object.assign(new Error('중단됨'), { aborted: true });

export function registerTurn(wsId, slug, interrupt, { group = Symbol('turn'), source = 'chat' } = {}) {
  const key = `${wsId}:${slug}`;
  const entries = active.get(key) ?? new Set();
  const entry = { interrupt, aborted: false, group, source };
  entries.add(entry); active.set(key, entries);
  return {
    group, source,
    wasAborted: () => entry.aborted,
    release: () => {
      entries.delete(entry);
      if (!entries.size && active.get(key) === entries) active.delete(key);
    },
  };
}

export async function interruptTurn(wsId, slug, { source } = {}) {
  const candidates = [...(active.get(`${wsId}:${slug}`) ?? [])].filter(e => !source || e.source === source);
  const latest = candidates.at(-1);
  const entries = candidates.filter(e => e.group === latest?.group);
  // One logical execution only: its setup/provider/retry handles share this group.
  // Concurrent routines or other private conversations on the same crew remain active.
  // Mark all entries before awaiting any interrupt: a provider can finish synchronously.
  for (const entry of entries) entry.aborted = true;
  await Promise.all(entries.map(async (entry) => { try { await entry.interrupt(); } catch { /* already ended */ } }));
  return entries.length > 0;
}

/** The same cancellation lifetime covers setup, retries and tool-result continuations. */
export async function withTurnControl(wsId, slug, inherited, run, { source = 'chat' } = {}) {
  if (inherited) { inherited.check(); return run(inherited); }
  const registration = registerTurn(wsId, slug, () => {}, { source });
  const control = { group: registration.group, source, check() { if (registration.wasAborted()) throw turnAbortedError(); } };
  try {
    const result = await run(control);
    control.check(); // interrupt may return a normal final result instead of throwing
    return result;
  } catch (error) {
    control.check(); // A setup or transport failure after stop must not become retryable.
    throw error;
  } finally { registration.release(); }
}
