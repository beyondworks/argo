/** Reconcile after returning to the foreground or reconnecting; never fire during initial mount. */
export function observeMobileResume(onResume, {
  document: doc = globalThis.document,
  window: win = globalThis.window,
  debounceMs = 150,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
} = {}) {
  let wasVisible = doc.visibilityState === 'visible';
  let pending = null;
  let disposed = false;
  const available = () => doc.visibilityState === 'visible' && win.navigator.onLine !== false;
  const clear = () => { if (pending !== null) cancel(pending); pending = null; };
  const enqueue = () => {
    clear();
    if (!available()) return;
    pending = schedule(() => {
      pending = null;
      if (!disposed && available()) onResume();
    }, debounceMs);
  };
  const visibility = () => {
    const visible = doc.visibilityState === 'visible';
    if (visible && !wasVisible) enqueue();
    if (!visible) clear();
    wasVisible = visible;
  };
  const online = () => enqueue();
  doc.addEventListener('visibilitychange', visibility);
  win.addEventListener('online', online);
  win.addEventListener('offline', clear);
  return () => {
    disposed = true;
    clear();
    doc.removeEventListener('visibilitychange', visibility);
    win.removeEventListener('online', online);
    win.removeEventListener('offline', clear);
  };
}
