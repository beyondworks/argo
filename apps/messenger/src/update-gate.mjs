// 업데이트 필요 전체 화면의 판정(순수) — 유건 2026-10-27 "막힌 앱에서 업데이트 하라는 안내만 보이게해".
// 서버 최소 버전(argo_min_app_version 'messenger')에 걸리면 연결 상태 기계가 update_required로 멈춘다(link/machine.mjs boot).
// 예전에는 화면 위 안내 줄만 떠서 대화·설정이 그대로 남고, 셸의 조회(어댑터 msgr2 읽기·작업 패널 15초)가 계속 나갔다.
// 이제 앱 루트가 셸을 통째로 내리고 UpdateGate만 그린다 — 셸의 주기 요청·실시간·심박이 모두 정리된다.
// 표지(localStorage)는 "이 앱 버전이 막혔다"만 남긴다. 다음 실행에서도 셸을 올리지 않고 바로 이 화면을 띄운다.
// 화면은 켤 때 최소 버전을 한 번만 다시 묻는다(실행당 1회) — 서버가 값을 낮췄으면 표지를 지우고 셸로 돌아간다.
// 업데이트로 앱 버전이 바뀌면 표지는 다른 버전 것이라 저절로 무효다.
import { belowMin } from './link/policy.mjs';

export const UPDATE_GATE_KEY = 'argo-msgr-update-gate';

/** 이 앱 버전에 걸린 표지가 있나. storage = localStorage 모양(없거나 막혀 있으면 거짓). */
export function updateGateActive(storage, appVersion) {
  try {
    const v = JSON.parse(storage?.getItem?.(UPDATE_GATE_KEY) ?? 'null');
    return !!v && typeof v === 'object' && !!appVersion && v.version === appVersion;
  } catch { return false; }
}

/** 표지를 남긴다(이 앱 버전). 저장이 막혀 있으면 이번 실행에서만 화면이 막는다(루트 상태). */
export function markUpdateGate(storage, appVersion, now = Date.now()) {
  try { storage?.setItem?.(UPDATE_GATE_KEY, JSON.stringify({ version: appVersion, at: now })); } catch { /* 이번 실행만 */ }
}

export function clearUpdateGate(storage) {
  try { storage?.removeItem?.(UPDATE_GATE_KEY); } catch { /* 무시 */ }
}

/** 켤 때 한 번 묻는 최소 버전 응답 → 'blocked' | 'clear'. 확인 실패(오프라인·옛 서버 오류)는 판정을 바꾸지 않는다(막힌 채). */
export function recheckVerdict({ data, error } = {}, appVersion) {
  if (error) return 'blocked';
  return belowMin(appVersion, typeof data === 'string' ? data.trim() : null) ? 'blocked' : 'clear';
}

/** [업데이트] 단추가 하는 일 — 데스크톱은 앱 안 업데이터, 폰은 스토어·설치 파일, 그 밖(브라우저)은 릴리스 페이지. */
export const MSGR_RELEASES_URL = 'https://github.com/beyondworks/argo-messenger/releases/latest';
export const MSGR_IOS_STORE_URL = 'https://apps.apple.com/kr/app/argo-messenger/id6810877561'; // landing/lib/downloads.js MSGR_DL.ios와 같은 값
export const MSGR_ANDROID_APK_URL = `${MSGR_RELEASES_URL}/download/argo-messenger-android.apk`;
export function updateAction({ desktop, ios, android }) {
  if (desktop) return { kind: 'install' };
  if (ios) return { kind: 'open', url: MSGR_IOS_STORE_URL };
  if (android) return { kind: 'open', url: MSGR_ANDROID_APK_URL };
  return { kind: 'open', url: MSGR_RELEASES_URL };
}
