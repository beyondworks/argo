import './globals.css';
import { LanguageProvider } from './i18n';
import { ThemeProvider } from './theme';
import BuildWatch from './build-watch';
import SplashContinue from './splash-continue';
import { GRAPHITE, LOGO_VIEWBOX, SAIL_D, STAR_D } from '../public/splash/north-star.mjs';

// 첫 페인트 전에 저장된 테마를 적용 — FOUC 방지 (ThemeProvider의 effect보다 먼저 실행)
const themeBoot = `try{var t=localStorage.getItem('argo-theme')||'graphite';if(t!=='argo')document.documentElement.dataset.theme=t}catch(e){}`;

// Windows 판별 — globals.css의 [data-os='win'] 폰트 오버라이드용(실사용 제보 2026-08-29:
// 힌팅 없는 Pretendard가 Windows 표준 해상도에서 흐리고, mono 스택 한글은 굴림계로 떨어짐).
// 테마 부트와 같은 이유로 첫 페인트 전에 박는다. 맥·리눅스는 미부여 = CSS 경로 불변.
const osBoot = `try{if(navigator.userAgent.indexOf('Windows')>-1)document.documentElement.dataset.os='win'}catch(e){}`;

// 표시 배율 — 큰 모니터(QHD·4K 100% 배율)에서 요소가 작게 보인다는 제보(2026-08-29).
// 페이지 전체를 zoom으로 비례 확대해 레이아웃·여백 관계는 그대로 유지한다(개별 크기 조정 아님 —
// 유건 제약). 기본 배율은 100%. 저장값(argo-zoom, cmd +·-·0 또는 설정 화면으로 조절 — i18n.jsx)이
// 있을 때만 적용한다. 예전의 뷰포트 폭 자동 판정(1800px↑ 1.2 …)은 "기본이 120%로 잡힌다" 제보로
// 2026-09-14 제거 — 큰 모니터에서도 사용자가 직접 올린 배율만 쓴다.
const zoomBoot = `try{var d=document.documentElement;var z=parseFloat(localStorage.getItem('argo-zoom'));if(z>=0.7&&z<=2&&z!==1){d.style.setProperty('--z',z);d.style.zoom=z}}catch(e){}`;

// 데스크톱(Tauri) 웹뷰는 target=_blank·window.open을 조용히 무시한다 — 외부 오리진 링크 클릭을
// 가로채 시스템 브라우저로 연다(러너 OAuth 로그인 페이지·키 발급·결제 링크 전부). 브라우저에선 개입 없음.
// 같은 오리진(localhost 앱) 링크는 세션 쿠키가 외부 브라우저로 안 넘어가므로 건드리지 않는다.
const desktopLinkBridge = `document.addEventListener('click',function(e){try{var o=window.__TAURI__&&window.__TAURI__.opener;if(!o||!o.openUrl)return;var t=e.target;var a=t&&t.closest?t.closest('a[href]'):null;if(!a)return;var u=new URL(a.href,location.href);if((u.protocol==='http:'||u.protocol==='https:')&&u.origin!==location.origin){e.preventDefault();o.openUrl(u.href)}}catch(err){}},true)`;

// 북극성 스플래시 2단계 — 데스크톱 부트 화면(public/boot.js)은 등장 모션을 끝낸 뒤 `#argo-splash`를 붙여 이리로 온다.
// 첫 페인트 전에 표시(html[data-argo-splash])를 붙이고 해시는 바로 지운다 — 남겨 두면 BuildWatch의 새로고침 때 스플래시가 다시 뜬다.
// 표시가 있을 때만 body의 정적 오버레이(#argo-splash-ssr)가 보이고, SplashContinue가 같은 자리의 엔진 오버레이로 바꿔 들었다가 닫는다.
// 스크립트가 끝내 안 돌면(하이드레이션 실패 등) 8초 뒤 CSS만으로 사라지고, 그동안도 클릭은 통과시킨다(반대 검토 #3).
// 색은 graphite — 시스템 밝기를 따른다(부트 화면 boot.css와 같은 값, 정본 public/splash/north-star.mjs GRAPHITE).
// 로고 크기는 표시 배율(--z)로 나눠 부트 화면과 같은 실제 크기를 유지한다(반대 검토 #6).
const splashBoot = `try{if(location.hash==='#argo-splash'){document.documentElement.dataset.argoSplash='1';history.replaceState(history.state,'',location.pathname+location.search)}}catch(e){}`;
const splashCss = `#argo-splash-ssr{display:none}`
  + `html[data-argo-splash] #argo-splash-ssr{display:grid;place-items:center;position:fixed;inset:0;z-index:2147483000;background:${GRAPHITE.light.bg};color:${GRAPHITE.light.mark};pointer-events:none;animation:argoSplashGone .3s 8s forwards}`
  // 가로 100vw — 고전 스크롤바 화면에서도 가운데가 부트 화면과 같은 자리. 표시 배율(zoomBoot가 html style에 zoom을 쓴다)이 걸리면 vw에도 배율이 곱해지므로 뺀다
  + `html[data-argo-splash]:not([style*="zoom"]) #argo-splash-ssr{right:auto;width:100vw}`
  + `@media (prefers-color-scheme:dark){html[data-argo-splash] #argo-splash-ssr{background:${GRAPHITE.dark.bg};color:${GRAPHITE.dark.mark}}}`
  + `#argo-splash-ssr svg{display:block;width:calc(112px / var(--z, 1));height:calc(112px / var(--z, 1))}`
  + `@keyframes argoSplashGone{to{opacity:0;visibility:hidden}}`;

// 글로벌 타깃 — 탭 제목·SEO는 영어 기본(서버 metadata라 t() 자동전환 불가). 앱 UI는 argo-lang로 한/영 전환된다.
export const metadata = {
  title: 'Argo — AI crew on one ship',
  description: 'Hire expert AI crew with one prompt; your company sails on folder-based memory.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
        <script dangerouslySetInnerHTML={{ __html: osBoot }} />
        <script dangerouslySetInnerHTML={{ __html: zoomBoot }} />
        <script dangerouslySetInnerHTML={{ __html: desktopLinkBridge }} />
        <script dangerouslySetInnerHTML={{ __html: splashBoot }} />
        <style dangerouslySetInnerHTML={{ __html: splashCss }} />
        {/* Pretendard는 자체 호스팅(globals.css @font-face + public/fonts) — 오프라인·CDN 차단에도 본문 한글 유지 */}
        <link rel="preload" href="/fonts/PretendardVariable.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body>
        <div id="argo-splash-ssr" aria-hidden="true">
          <svg viewBox={LOGO_VIEWBOX}><path d={SAIL_D} fill="currentColor" /><path d={STAR_D} fill="currentColor" /></svg>
        </div>
        <SplashContinue />
        <ThemeProvider><LanguageProvider><BuildWatch />{children}</LanguageProvider></ThemeProvider>
      </body>
    </html>
  );
}
