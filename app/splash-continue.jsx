'use client';
// 북극성 스플래시 2단계 — 데스크톱 부트 화면(public/boot-splash.mjs)이 등장을 끝내고 `#argo-splash`를 붙여 이 화면으로 넘기면,
// layout의 정적 오버레이(#argo-splash-ssr, 첫 페인트부터 같은 자리·크기)를 엔진 오버레이로 바꿔 들고 있다가 앱이 준비되면 닫는다.
// 등장은 1단계에서 이미 재생했으므로 최소 시간 0, 준비 신호가 없으면 5초에 닫는다. 끝맺음: 홈은 로고의 별이 상단바 ARGO 별 자리로
// 날아가 앉고, 로그인(카드가 떠오르는 중)과 표시 배율≠1(좌표가 어긋난다)은 페이드. 일반 브라우저로 열면 해시가 없어 아무것도 안 한다.
import { useEffect } from 'react';
import { startNorthStar, graphitePalette } from '../public/splash/north-star.mjs';

let splash = null;
let pendingReadyAt = null;
/** 화면이 그릴 준비를 마쳤다 — 홈은 회사 목록을 불러온 뒤, 로그인은 마운트 때 부른다. 스플래시가 없으면 아무 일도 없다. */
export function markSplashReady() {
  if (splash) splash.ready();
  else if (pendingReadyAt == null) pendingReadyAt = performance.now();
}

export default function SplashContinue() {
  useEffect(() => {
    const html = document.documentElement;
    if (!html.hasAttribute('data-argo-splash') || splash) return;
    const zoom = parseFloat(html.style.zoom) || 1; // layout zoomBoot — 오버레이도 html 안이라 같이 커진다
    splash = startNorthStar({
      palette: graphitePalette(window),
      hold: true,
      minMs: 0,
      size: `${112 / zoom}px`,
      fullWidth: zoom === 1, // 배율이 걸리면 vw에도 곱해져 밀린다 — layout CSS와 같은 규칙
      target: zoom === 1 ? () => (location.pathname === '/' ? document.querySelector('header.topbar [data-splash-target] path') : null) : null,
    });
    // 같은 자리에 엔진 오버레이가 이미 그려졌으니 정적 오버레이를 숨긴다(React가 그린 노드는 지우지 않는다)
    html.removeAttribute('data-argo-splash');
    if (splash && pendingReadyAt != null) splash.ready(pendingReadyAt);
  }, []);
  return null;
}
