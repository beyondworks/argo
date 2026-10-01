// 시작 스플래시 — 초안 A2 '북극성'(유건 선택 2026-09-29). 그리는 일은 정본 엔진(public/splash/north-star.mjs, 별칭 @argo/splash)이 하고,
// 여기서는 메신저 색과 끝맺음 자리만 정한다. 앱 본체보다 먼저 작은 진입 청크(main.jsx)에서 띄운다(첫 페인트부터 보이게).
// 앱이 준비되면(markAppReady) 최소 0.9초를 채운 뒤 닫고, 신호가 없으면 5초에 닫는다.
// 끝맺음: 데스크톱은 로고의 별이 레일 머리의 ARGO 별(.msgr-brand svg) 자리로 날아가 앉고, 폰은 머리에 Argo 로고가 없어 살짝 떠오르며 사라진다.
// 움직임 줄이기 설정이면 페이드만. 한 페이지 로드에 한 번(앱이 백그라운드에서 돌아올 때는 페이지가 다시 로드되지 않으므로 안 뜬다).
import { startNorthStar } from '@argo/splash';

// 바탕은 iOS LaunchScreen·Android 창 배경·모바일 웹뷰 바탕(tauri.ios/android.conf.json)과 같은 색 — 네이티브 첫 화면에서 끊김 없이 이어진다
const PALETTE = { bg: '#1F1E1B', mark: '#E4E700', rgb: '228, 231, 0', bgRgb: '31, 30, 27', glowA: 0.26, trailA: 0.9 };

let splash = null;
let pendingReadyAt = null;
export function markAppReady() {
  if (splash) splash.ready();
  else if (pendingReadyAt == null) pendingReadyAt = performance.now();
}

export function startSplash({ onClosed } = {}) {
  if (typeof document === 'undefined' || !document.body || splash) return null;
  const phone = !!window.matchMedia?.('(max-width: 720px)').matches;
  // index.html의 정적 바탕(#argo-splash, 색은 src/splash.css)을 이어받는다 — 없으면(테스트·다른 진입점) 엔진이 새로 만든다
  splash = startNorthStar({
    root: document.getElementById('argo-splash'),
    palette: PALETTE,
    phone,
    size: phone ? 'min(30vw, 132px)' : '112px',
    target: phone ? null : () => document.querySelector('.msgr-brand svg'),
    onClosed,
  });
  if (splash && pendingReadyAt != null) splash.ready(pendingReadyAt);
  return splash;
}
