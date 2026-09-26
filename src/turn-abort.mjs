// A crew can have more than one active entry (provider, preparation, retry).
// Keep every handle: replacing the latest entry orphaned the preceding execution.
// Process-local, as before: a different server process must route cancellation to its owner.
// The registry lives on globalThis: Next bundles this module once per server entry (instrumentation
// = messenger/telegram/routine gateway, and each API route). A module-local Map gave the abort route an
// empty registry for gateway-started turns, so the UI stop button never reached a messenger turn
// (live repro 2026-09-14: /chat/abort → interrupted:false while the crew's ping child kept running).
const active = (globalThis.__argoTurnAbort ??= new Map());
export const turnAbortedError = (cause) => Object.assign(new Error('중단됨'), { aborted: true, ...(cause?.cancellationIncomplete ? { cancellationIncomplete: true, cause } : {}) });

// tag: an optional caller-chosen id (e.g. the messenger source message id) that narrows interruptTurn to one
// specific execution instead of "the latest same-source one" — two independent same-source turns for the same
// wsId:slug (a messenger job and a Telegram turn both tag source:'messenger') must not cancel each other
// (crew stop 검수 2026-09-26 M-1). Retries/tool continuations inherit the same tag via the shared control object.
export function registerTurn(wsId, slug, interrupt, { group = Symbol('turn'), source = 'chat', tag = null } = {}) {
  const key = `${wsId}:${slug}`;
  const entries = active.get(key) ?? new Set();
  const entry = { interrupt, aborted: false, group, source, tag };
  entries.add(entry); active.set(key, entries);
  return {
    group, source, tag,
    wasAborted: () => entry.aborted,
    release: () => {
      entries.delete(entry);
      if (!entries.size && active.get(key) === entries) active.delete(key);
    },
  };
}

export async function interruptTurn(wsId, slug, { source, tag } = {}) {
  const candidates = [...(active.get(`${wsId}:${slug}`) ?? [])].filter(e => !source || e.source === source);
  // A tag pins the target to one exact execution — no "latest" fallback, so a stale/mismatched tag aborts nothing
  // rather than guessing another turn (e.g. a messenger stop request must never touch a live Telegram turn).
  const entries = tag != null ? candidates.filter(e => e.tag === tag) : (() => {
    const latest = candidates.at(-1);
    return candidates.filter(e => e.group === latest?.group);
  })();
  // One logical execution only: its setup/provider/retry handles share this group (and, when set, this tag).
  // Concurrent routines or other private conversations on the same crew remain active.
  // Mark all entries before awaiting any interrupt: a provider can finish synchronously.
  for (const entry of entries) entry.aborted = true;
  await Promise.all(entries.map(async (entry) => { try { await entry.interrupt(); } catch { /* already ended */ } }));
  return entries.length > 0;
}

/** The same cancellation lifetime covers setup, retries and tool-result continuations. */
export async function withTurnControl(wsId, slug, inherited, run, { source = 'chat', tag = null } = {}) {
  if (inherited) { inherited.check(); return run(inherited); }
  const registration = registerTurn(wsId, slug, () => {}, { source, tag });
  const control = { group: registration.group, source, tag, check() { if (registration.wasAborted()) throw turnAbortedError(); } };
  try {
    const result = await run(control);
    control.check(); // interrupt may return a normal final result instead of throwing
    return result;
  } catch (error) {
    if (registration.wasAborted()) throw turnAbortedError(error); // Preserve incomplete cleanup while keeping cancellation terminal.
    throw error;
  } finally { registration.release(); }
}
