// 지금 이 화면을 보고 있는 기기를 서버에 알린다 — PC를 보는 동안 폰 알림이 겹치지 않게(유건 2026-09-16).
// 규칙은 하나다: **보이고 초점이 있을 때만** 심박을 남긴다. 자리를 뜨면 기록이 낡아 폰 알림이 저절로 살아난다.
export const PRESENCE_MS = 60_000; // 심박 주기. 서버 판정 창(2분)의 절반 — 한 번 걸러도 살아 있는 것으로 읽힌다.

/** 지금 화면 앞인가 — 문서가 보이고 창에 초점이 있다. 둘 중 하나라도 아니면 심박을 쉰다. */
export const isWatching = (doc = document) => doc.visibilityState === 'visible' && doc.hasFocus();

/** 심박 시작. 반환값을 부르면 멈춘다. source = 'desktop' | 'web' | 'mobile'. */
export function startPresence({ supabase, source, interval = PRESENCE_MS, doc = document, win = window } = {}) {
  let stopped = false;
  const ping = () => {
    if (stopped || !isWatching(doc)) return;
    supabase.rpc('msgr_presence_ping', { source }).then?.(() => {}, () => {}); // 실패는 무시 — 알림 억제는 있으면 좋은 것이지 필수 경로가 아니다
  };
  ping();
  const timer = setInterval(ping, interval);
  const onWake = () => ping(); // 창으로 돌아오면 바로 한 번(2분을 기다리지 않는다)
  win.addEventListener('focus', onWake);
  doc.addEventListener('visibilitychange', onWake);
  return () => { stopped = true; clearInterval(timer); win.removeEventListener('focus', onWake); doc.removeEventListener('visibilitychange', onWake); };
}
