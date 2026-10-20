// 메신저 v2 화면 옵트인 플래그(U6). 기본(꺼짐)은 지금 앱 그대로 — 켜진 때만 v2 셸을 그린다.
// 켜는 법: 빌드 환경변수 VITE_MSGR_V2=1 또는 이 기기 localStorage 'argo-msgr-v2' = '1'. 끄는 법: 값을 지운다.
// 본체(U4)의 옵트인 선례(src/agent-link-flags.mjs ARGO_AGENT_LINK=1)와 같은 모양 — 값이 정확히 '1'일 때만 켠다.
export const V2_FLAG_KEY = 'argo-msgr-v2';

/** env: import.meta.env.VITE_MSGR_V2 값, storage: localStorage 모양(없거나 막혀 있으면 꺼짐). */
export function v2Enabled(env, storage) {
  if (String(env ?? '') === '1') return true;
  try { return storage?.getItem?.(V2_FLAG_KEY) === '1'; } catch { return false; }
}
