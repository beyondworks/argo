// A crew can have more than one active entry (provider, preparation, retry).
// Keep every handle: replacing the latest entry orphaned the preceding execution.
// Process-local, as before: a different server process must route cancellation to its owner.
// The registry lives on globalThis: Next bundles this module once per server entry (instrumentation
// = messenger/telegram/routine gateway, and each API route). A module-local Map gave the abort route an
// empty registry for gateway-started turns, so the UI stop button never reached a messenger turn
// (live repro 2026-09-14: /chat/abort → interrupted:false while the crew's ping child kept running).
const active = (globalThis.__argoTurnAbort ??= new Map());
// Steer state per execution group: messages that arrive while the turn is still booting (no engine has attached its
// channel yet) wait here and are handed over on attach. Once an engine attached, a group without a channel is closing.
const steerState = (globalThis.__argoTurnSteer ??= new Map()); // group → { pending: string[], attached: boolean }
export const turnAbortedError = (cause) => Object.assign(new Error('중단됨'), { aborted: true, ...(cause?.cancellationIncomplete ? { cancellationIncomplete: true, cause } : {}) });

// tag: an optional caller-chosen id (e.g. the messenger source message id) that narrows interruptTurn to one
// specific execution instead of "the latest same-source one" — two independent same-source turns for the same
// wsId:slug (a messenger job and a Telegram turn both tag source:'messenger') must not cancel each other
// (crew stop 검수 2026-09-26 M-1). Retries/tool continuations inherit the same tag via the shared control object.
export function registerTurn(wsId, slug, interrupt, { group = Symbol('turn'), source = 'chat', tag = null } = {}) {
  const key = `${wsId}:${slug}`;
  const entries = active.get(key) ?? new Set();
  const entry = { interrupt, aborted: false, group, source, tag, steer: null };
  entries.add(entry); active.set(key, entries);
  return {
    group, source, tag,
    wasAborted: () => entry.aborted,
    // steer(text) → Promise<boolean>: delivers a captain message into this running execution (true = accepted).
    setSteer: (fn) => {
      entry.steer = fn;
      if (!fn) return;
      const st = steerState.get(group) ?? { pending: [], attached: false };
      st.attached = true; steerState.set(group, st);
      for (const text of st.pending.splice(0)) Promise.resolve(fn(text)).catch(() => {});
    },
    // 이 시도가 실패해 같은 실행 그룹 안에서 재시도할 때 — 이 시도가 받은 끼워 넣기(이미 모델에 실은 것 포함 — 재시도는 원 지시부터
    // 다시 한다)를 그룹에 되돌려, 재시도 엔진이 통로를 다는 순간 다시 넘긴다. 그사이 온 것도 그룹에 보관된다(죽은 시도로 가지 않는다).
    detachSteer: (accepted = []) => {
      entry.steer = null;
      const st = steerState.get(group) ?? { pending: [], attached: false };
      st.attached = false; st.pending.unshift(...accepted); steerState.set(group, st);
    },
    release: () => {
      entries.delete(entry);
      if (![...entries].some((e) => e.group === group)) steerState.delete(group);
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

/** Deliver a message into the latest running execution of this crew for `source` without stopping it.
    Returns false when nothing running accepts it (no turn, turn already closing) — the caller keeps the message queued. */
export async function steerTurn(wsId, slug, { source = 'chat', tag = null, text } = {}) {
  // tag(사장 턴의 turnId)가 있으면 정확히 그 실행만 — 같은 크루에 결재 후속 턴(source 'chat')이 뒤에 붙어 있어도 거기로 새지 않는다
  const candidates = [...(active.get(`${wsId}:${slug}`) ?? [])].filter(e => e.source === source && !e.aborted && (tag == null || e.tag === tag));
  const latest = candidates.at(-1);
  if (!latest) return false;
  const target = candidates.filter(e => e.group === latest.group && e.steer).at(-1);
  if (!target) {
    // Booting (engine not attached yet): hold it for the engine. Attached but no channel: the turn is closing.
    const st = steerState.get(latest.group) ?? { pending: [], attached: false };
    if (st.attached) return false;
    st.pending.push(String(text ?? '')); steerState.set(latest.group, st);
    return true;
  }
  try { return (await target.steer(String(text ?? ''))) === true; } catch { return false; }
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
