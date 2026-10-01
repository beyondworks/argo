// 북극성 스플래시 2단계(Next 첫 화면)의 동작부 — React 없이 돌아가게 분리했다(test/north-star-splash.test.mjs가 가짜 DOM으로 그대로 돌린다).
// app/splash-continue.jsx(마운트 effect)와 홈·로그인 화면(markSplashReady)이 이 모듈 하나를 같이 쓴다.
import { startNorthStar, graphitePalette } from '../public/splash/north-star.mjs';

// 2단계 최대 대기 — 준비 신호가 안 와도 이때 닫는다. 등장은 부트 화면에서 이미 재생했고, 첫 화면을 오래 가리지 않게
// 메신저(5초, timing.mjs 기본값)보다 짧게 둔다(검수 #792 결정 2026-10-01). 기본값은 메신저와 공유라 여기서만 넘긴다.
export const STAGE2_MAX_MS = 2000;

let splash = null;
let pendingReadyAt = null;

/** 화면이 그릴 준비를 마쳤다 — 홈은 회사 목록(또는 오류)이 온 뒤, 로그인은 마운트 때 부른다. 스플래시가 없으면 시각만 기억한다. */
export function markSplashReady(now = () => performance.now()) {
  if (splash) splash.ready();
  else if (pendingReadyAt == null) pendingReadyAt = now();
}

/** 홈 화면의 준비 판정 — 회사 목록이 왔거나(빈 목록 포함) 불러오기에 실패했으면 준비. */
export const homeSplashReady = (companies, error) => companies !== null || !!error;

/**
 * 부트 화면이 `#argo-splash`로 넘겨 표시(html[data-argo-splash])가 붙어 있으면, layout의 정적 오버레이 자리에 엔진 오버레이를 띄우고
 * 정적 오버레이를 숨긴다(React가 그린 노드는 지우지 않는다). 등장은 끝났으므로 hold·최소 0·최대 STAGE2_MAX_MS.
 * 끝맺음: 홈은 로고의 별이 상단바 ARGO 별 자리로 날아가 앉고, 로그인과 표시 배율≠1(좌표가 어긋난다)은 페이드.
 */
export function continueSplash({ doc = globalThis.document, win = globalThis.window, start = startNorthStar } = {}) {
  const html = doc.documentElement;
  if (splash || !html.hasAttribute('data-argo-splash')) return null;
  const zoom = parseFloat(html.style.zoom) || 1; // layout zoomBoot — 오버레이도 html 안이라 같이 커진다
  splash = start({
    doc, win,
    palette: graphitePalette(win),
    hold: true,
    minMs: 0,
    maxMs: STAGE2_MAX_MS,
    size: `${112 / zoom}px`,
    fullWidth: zoom === 1, // 배율이 걸리면 vw에도 곱해져 밀린다 — layout CSS와 같은 규칙
    target: zoom === 1 ? () => (win.location.pathname === '/' ? doc.querySelector('header.topbar [data-splash-target] path') : null) : null,
  });
  // 같은 자리에 엔진 오버레이가 그려졌으니 정적 오버레이를 숨긴다
  html.removeAttribute('data-argo-splash');
  if (splash && pendingReadyAt != null) splash.ready(pendingReadyAt);
  return splash;
}

/** 테스트 전용 — 모듈 상태를 비운다. */
export function __resetSplashContinue() { splash = null; pendingReadyAt = null; }
