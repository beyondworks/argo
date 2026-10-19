// 메신저 축소판 A+ 화면 옵트인(2026-10-19). v2 플래그(v2/flag.mjs)가 켜진 때만 의미가 있다 — A+는 v2 서버 위에서 돈다.
// 켜는 법: 빌드 환경변수 VITE_MSGR_APLUS=1 또는 이 기기 localStorage 'argo-msgr-aplus' = '1'. 끄면 지금 v2 셸 그대로.
export const APLUS_FLAG_KEY = 'argo-msgr-aplus';

/** env: import.meta.env.VITE_MSGR_APLUS 값, storage: localStorage 모양. 값이 정확히 '1'일 때만 켠다. */
export function aplusEnabled(env, storage) {
  if (String(env ?? '') === '1') return true;
  try { return storage?.getItem?.(APLUS_FLAG_KEY) === '1'; } catch { return false; }
}
