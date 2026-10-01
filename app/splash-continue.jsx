'use client';
// 북극성 스플래시 2단계 — 데스크톱 부트 화면(public/boot-splash.mjs)이 등장을 끝내고 `#argo-splash`를 붙여 이 화면으로 넘기면,
// layout의 정적 오버레이(#argo-splash-ssr, 첫 페인트부터 같은 자리·크기)를 엔진 오버레이로 바꿔 들고 있다가 앱이 준비되면 닫는다.
// 동작은 splash-continue-core.mjs(React 없이 테스트된다). 일반 브라우저로 열면 해시가 없어 아무것도 안 한다.
import { useEffect } from 'react';
import { continueSplash } from './splash-continue-core.mjs';

export { markSplashReady } from './splash-continue-core.mjs';

export default function SplashContinue() {
  useEffect(() => { continueSplash(); }, []);
  return null;
}
