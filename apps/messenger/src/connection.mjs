// 연결 끊김 막대의 근거 — 브라우저가 아는 연결 상태(navigator.onLine)와 online/offline 이벤트.
// 실시간 구독의 끊김(rt_down)은 잠깐씩 흔들리며 재연결하므로 막대 근거로 쓰지 않는다. cb는 처음 한 번 현재 상태로 불리고 바뀔 때마다 불린다.
export function watchOnline(cb, win = globalThis.window) {
  const now = () => win?.navigator?.onLine !== false;
  const on = () => cb(now());
  cb(now());
  const doc = win?.document; // 백그라운드 중 놓친 online/offline 이벤트 — 다시 보일 때 한 번 더 읽는다(#793 검수 LOW-4)
  win?.addEventListener?.('online', on); win?.addEventListener?.('offline', on); doc?.addEventListener?.('visibilitychange', on);
  return () => { win?.removeEventListener?.('online', on); win?.removeEventListener?.('offline', on); doc?.removeEventListener?.('visibilitychange', on); };
}
