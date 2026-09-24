// A crew can have more than one active entry (provider, preparation, retry).
// Keep every handle: replacing the latest entry orphaned the preceding execution.
// Process-local, as before: a different server process must route cancellation to its owner.
// The registry lives on globalThis: Next bundles this module once per server entry (instrumentation
// = messenger/telegram/routine gateway, and each API route). A module-local Map gave the abort route an
// empty registry for gateway-started turns, so the UI stop button never reached a messenger turn
// (live repro 2026-09-14: /chat/abort → interrupted:false while the crew's ping child kept running).
const active = (globalThis.__argoTurnAbort ??= new Map());
export const turnAbortedError = (cause) => Object.assign(new Error('중단됨'), { aborted: true, ...(cause?.cancellationIncomplete ? { cancellationIncomplete: true, cause } : {}) });

// 중단 사유 — "지금 바로 보내기"가 건 중단인지, 정지 버튼이 건 중단인지(재검수 D, 2026-09-24).
// /chat/abort 요청(사장의 클릭)과 그 중단이 실제로 도달하는 원래 턴의 POST /chat 응답(완전히
// 별개의 두 HTTP 요청)을 이 작은 맵으로만 이어 붙인다 — src/chat.mjs의 중첩 catch·재시도 프레임
// 안까지 사유를 들고 들어가려면 그 파일을 건드려야 해서(대화 코어, 큰 변경) 피한다. 대신 route.js의
// 실패 처리(이미 aborted/cancellationIncomplete를 같은 방식으로 읽는 자리)가 여기서 한 번만 소비한다.
// TTL 없이 마지막 값만 들고 있다 — 소비(take) 즉시 지워 다음(무관한) 실패에 새지 않는다.
const abortReasons = (globalThis.__argoAbortReasons ??= new Map());
export function markAbortReason(wsId, slug, reason) {
  if (!reason) return;
  abortReasons.set(`${wsId}:${slug}`, reason);
}
export function takeAbortReason(wsId, slug) {
  const key = `${wsId}:${slug}`;
  const reason = abortReasons.get(key) ?? null;
  abortReasons.delete(key);
  return reason;
}

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
    if (registration.wasAborted()) throw turnAbortedError(error); // Preserve incomplete cleanup while keeping cancellation terminal.
    throw error;
  } finally { registration.release(); }
}
