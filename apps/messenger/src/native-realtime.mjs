const emptyContext = Object.freeze({
  lang: 'en', sound: 'wood-knock', currentChannel: null, mutedChannelIds: [], orgIds: [], quietFrom: null, quietTo: null,
});

let appContext = emptyContext;
let mountedCoordinator = null;
const nativeTapStreams = new WeakMap();

const nativeSession = (session) => {
  const userId = session?.user?.id;
  const accessToken = session?.access_token;
  const refreshToken = session?.refresh_token;
  if (!userId || !accessToken || !refreshToken) return null;
  return { accessToken, refreshToken, expiresAt: session.expires_at ?? null, userId };
};

const currentContext = () => {
  const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
  const focused = typeof document === 'undefined' || document.hasFocus();
  return { ...appContext, foreground: visible && focused, visible, focused };
};

export async function claimNativeNotification(invoke, { messageId, channelId, title, body, sound }) {
  try {
    const nativeId = String(messageId ?? '').replace(/^(?:r|m):/, 'message:').replace(/^a:/, 'approval:');
    const result = await invoke('native_notify_claim_and_send', { messageId: nativeId, channelId: channelId ?? null, title, body, sound });
    const status = result?.status;
    return { ok: status === 'sent' || status === 'duplicate', status: status ?? 'skipped', ...(result?.error ? { error: result.error } : {}) };
  } catch (error) {
    return { ok: false, status: 'skipped', error: String(error?.message ?? error) };
  }
}

export async function attachNativeNotificationTaps({ listen, invoke, onTap }) {
  let active = true;
  const stream = nativeTapStreams.get(invoke) ?? { deliver: null, pending: null };
  nativeTapStreams.set(invoke, stream);
  const seen = new Set();
  const deliver = (tap) => {
    if (!active || typeof tap?.channelId !== 'string' || !tap.channelId) return;
    const key = `${tap.channelId}:${tap.messageId ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    onTap(tap);
  };
  const consume = async () => {
    if (!active) return;
    try {
      const tap = await invoke('native_notification_pending_tap');
      if (!tap) return;
      if (stream.deliver) stream.deliver(tap);
      else stream.pending = tap;
    } catch { /* no pending tap or native command unavailable */ }
  };
  stream.deliver = deliver;
  const unlisten = await listen('native-notification-tap', consume);
  if (stream.pending) { stream.deliver(stream.pending); stream.pending = null; }
  await consume();
  return () => {
    if (!active) return;
    active = false;
    if (stream.deliver === deliver) stream.deliver = null;
    unlisten();
  };
}

export function createNativeSessionApplier({ native, applySession }) {
  let generation = 0;
  let active = true;
  return {
    apply(next) {
      const current = ++generation;
      if (next) {
        applySession(next);
        return native.then((runtime) => runtime?.handleAuth('SIGNED_IN', next)).catch(() => {});
      }
      return native.then((runtime) => runtime?.handleAuth('SIGNED_OUT', null))
        .catch(() => {})
        .finally(() => { if (active && current === generation) applySession(null); });
    },
    dispose() { active = false; generation += 1; },
  };
}

export async function mountNativeNotificationTaps({ enabled, onTap }) {
  if (!enabled) return () => {};
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  return attachNativeNotificationTaps({ listen, invoke, onTap });
}

export function createNativeRealtimeCoordinator({ enabled, auth, invoke, supabaseUrl, anonKey, lang, getContext }) {
  let active = null;
  let sessionSync = null;
  let chain = Promise.resolve();
  const enqueue = (task) => {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  };
  const restoreJsRefresh = () => { auth.startAutoRefresh(); };
  const stopActive = async (restore) => {
    const previous = active;
    active = null;
    if (previous) {
      try { await invoke('native_realtime_stop', { generation: previous.generation }); } catch { /* native is already unavailable */ }
    }
    if (restore) restoreJsRefresh();
  };
  const start = async (session) => {
    const parsed = nativeSession(session);
    if (!enabled || !parsed) { await stopActive(true); return null; }
    if (active?.userId === parsed.userId) return active;
    if (active) await stopActive(false);
    try {
      const snapshot = await invoke('native_realtime_start', {
        supabaseUrl, anonKey, lang, session: parsed, context: getContext(),
      });
      if (!Number.isInteger(snapshot?.generation) || snapshot?.userId !== parsed.userId) {
        restoreJsRefresh();
        return null;
      }
      active = { generation: snapshot.generation, userId: parsed.userId, accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
      auth.stopAutoRefresh();
      return active;
    } catch {
      restoreJsRefresh();
      return null;
    }
  };
  let authEpoch = 0; // 로그아웃·계정 전환마다 올린다 — 큐 밖에서 읽은 세션이 그 뒤에 도착하면 버린다
  const handleAuthNow = async (event, session) => {
    if (event === 'SIGNED_OUT' || !session) { authEpoch += 1; await stopActive(true); return; }
    const userId = session.user?.id;
    if (active?.userId === userId) return;
    authEpoch += 1;
    await start(session);
  };
  const updateContextNow = async () => {
    if (!active) return;
    try { await invoke('native_realtime_update', { generation: active.generation, context: getContext() }); }
    catch { await stopActive(true); }
  };
  // 네이티브가 /auth/v1/token 영구 거부(400·401)를 받고 스스로 멈췄다(native_realtime.rs report_rejected).
  // 갱신 주인을 JS로 돌린다: JS 자동 갱신이 자기 토큰으로 다시 해 보고, 그것도 거부면 auth-js가 SIGNED_OUT을 내
  // 로그아웃 경로로 간다. 거부된 토큰과 그때의 authEpoch를 돌려줘 큐 밖에서 resumeAfterRejection이 이어받게 한다.
  const handleNativeRejectedNow = async (payload) => {
    if (!active || payload?.generation !== active.generation) return null;
    const rejected = { refreshToken: active.refreshToken, epoch: authEpoch };
    await stopActive(true);
    return rejected;
  };
  // JS가 이미 더 새 토큰을 들고 있으면(JS가 먼저 갱신해 네이티브 토큰이 뒤처진 경우) 그 세션으로 네이티브를 다시 띄운다.
  // getSession은 SIGNED_OUT 구독자를 기다릴 수 있어 큐 밖에서 부른다(큐 안이면 handleAuth('SIGNED_OUT')와 서로 기다린다).
  const resumeAfterRejection = async (rejected) => {
    if (!rejected) return;
    const { data } = await auth.getSession();
    const session = data?.session;
    if (!session?.refresh_token || session.refresh_token === rejected.refreshToken) return;
    await enqueue(() => (rejected.epoch === authEpoch && !active ? handleAuthNow('SIGNED_IN', session) : undefined));
  };
  const reconcileNow = async () => {
    if (!active) return null;
    try {
      const snapshot = await invoke('native_realtime_snapshot');
      if (snapshot?.generation !== active.generation || snapshot?.userId !== active.userId) return null;
      if (snapshot?.status === 'rejected') return await handleNativeRejectedNow({ generation: active.generation }); // 숨긴 창이 거부 이벤트를 놓친 경우
      await handleNativeSessionNow(await invoke('native_realtime_current_session'));
      await updateContextNow();
    } catch { await stopActive(true); }
    return null;
  };
  const handleNativeSessionNow = async (payload) => {
    if (!active || payload?.generation !== active.generation) return;
    if (!payload.accessToken || !payload.refreshToken) return;
    if (payload.accessToken === active.accessToken && payload.refreshToken === active.refreshToken) return;
    active = { ...active, accessToken: payload.accessToken, refreshToken: payload.refreshToken };
    sessionSync = { generation: active.generation, stop: null };
    try {
      const { error } = await auth.setSession({ access_token: payload.accessToken, refresh_token: payload.refreshToken });
      if (error) throw error;
      if (active?.generation === sessionSync.generation) auth.stopAutoRefresh();
    } catch {
      if (active?.generation === sessionSync.generation) await stopActive(true);
    } finally { sessionSync = null; }
  };
  return {
    handleAuth: (event, session) => {
      // auth-js awaits SIGNED_OUT subscribers inside setSession; native cleanup
      // must complete there without waiting behind the setSession queue item.
      if (sessionSync && event === 'SIGNED_OUT') {
        sessionSync.stop ??= handleAuthNow(event, session);
        return sessionSync.stop;
      }
      return enqueue(() => handleAuthNow(event, session));
    },
    handleNativeSession: (payload) => enqueue(() => handleNativeSessionNow(payload)),
    handleNativeRejected: (payload) => enqueue(() => handleNativeRejectedNow(payload)).then(resumeAfterRejection),
    updateContext: () => enqueue(updateContextNow),
    reconcile: () => enqueue(reconcileNow).then(resumeAfterRejection),
    stop: () => enqueue(() => stopActive(true)),
  };
}

export function attachNativeRealtimeLifecycle(coordinator, win = window, doc = document) {
  const onFocus = () => { coordinator.reconcile().catch(() => {}); };
  const onBlur = () => { coordinator.updateContext().catch(() => {}); };
  const onVisibility = () => {
    const action = doc.visibilityState === 'visible' ? coordinator.reconcile() : coordinator.updateContext();
    action.catch(() => {});
  };
  win.addEventListener('focus', onFocus);
  win.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}

export function updateNativeRealtimeContext(next) {
  appContext = { ...appContext, ...next };
  mountedCoordinator?.updateContext().catch(() => {});
}

export async function mountNativeRealtime({ enabled, auth, supabaseUrl, anonKey, lang }) {
  if (!enabled) return null;
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  const coordinator = createNativeRealtimeCoordinator({ enabled, auth, invoke, supabaseUrl, anonKey, lang, getContext: currentContext });
  mountedCoordinator = coordinator;
  const detachLifecycle = attachNativeRealtimeLifecycle(coordinator);
  const unlisten = await listen('native-realtime-session', ({ payload }) => { coordinator.handleNativeSession(payload).catch(() => {}); });
  const unlistenRejected = await listen('native-realtime-auth-rejected', ({ payload }) => { coordinator.handleNativeRejected(payload).catch(() => {}); });
  return {
    handleAuth: coordinator.handleAuth,
    stop: async () => {
      if (mountedCoordinator === coordinator) mountedCoordinator = null;
      detachLifecycle();
      unlisten();
      unlistenRejected();
      await coordinator.stop();
    },
  };
}
