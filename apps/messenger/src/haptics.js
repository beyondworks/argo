// 짧은 진동(앱 느낌 통일 초안 승인 2026-09-29) — 길게 누르기·끌어 집기(중간), 당겨서 새로고침 기준선·보내기(가볍게).
// 모바일 앱에서만 울린다. 데스크톱·브라우저는 아무것도 하지 않는다. 플러그인은 처음 쓸 때 한 번만 불러온다.

// platform.js의 isMobileNative와 같은 판정 — 그 파일은 import.meta.env를 바로 읽어 노드 테스트(long-press)에서 못 불러온다
const isMobileNative = ['ios', 'android'].includes(import.meta.env?.TAURI_ENV_PLATFORM) && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let plugin = null;
export function haptic(kind = 'light') {
  if (import.meta.env?.DEV && typeof window !== 'undefined') (window.__argoHaptics ??= []).push(kind); // 개발 서버 확인용 기록(발행본에는 없다)
  if (!isMobileNative) return;
  (plugin ??= import('@tauri-apps/plugin-haptics').catch(() => null))
    .then((m) => m?.impactFeedback(kind))
    .catch(() => {}); // 진동 실패는 동작을 막지 않는다
}
