import './globals.css';
import { LanguageProvider } from './i18n';
import { ThemeProvider } from './theme';
import BuildWatch from './build-watch';

// 첫 페인트 전에 저장된 테마를 적용 — FOUC 방지 (ThemeProvider의 effect보다 먼저 실행)
const themeBoot = `try{var t=localStorage.getItem('argo-theme')||'graphite';if(t!=='argo')document.documentElement.dataset.theme=t}catch(e){}`;

// Windows 판별 — globals.css의 [data-os='win'] 폰트 오버라이드용(실사용 제보 2026-08-29:
// 힌팅 없는 Pretendard가 Windows 표준 해상도에서 흐리고, mono 스택 한글은 굴림계로 떨어짐).
// 테마 부트와 같은 이유로 첫 페인트 전에 박는다. 맥·리눅스는 미부여 = CSS 경로 불변.
const osBoot = `try{if(navigator.userAgent.indexOf('Windows')>-1)document.documentElement.dataset.os='win'}catch(e){}`;

// 표시 배율 — 큰 모니터(QHD·4K 100% 배율)에서 요소가 작게 보인다는 제보(2026-08-29).
// 페이지 전체를 zoom으로 비례 확대해 레이아웃·여백 관계는 그대로 유지한다(개별 크기 조정 아님 —
// 유건 제약). 저장값(argo-zoom, cmd +·-·0로 조절 — i18n.jsx 전역 단축키)이 있으면 그것을,
// 없으면 뷰포트 폭으로 자동 판정(1800px 미만 = 1.0 → 기존 화면 무변화). 배율 1은 스타일
// 미설정과 동일해 종전 렌더와 완전히 같다. 자동 판정 함수는 cmd+0 리셋이 재사용한다.
const zoomBoot = `try{var d=document.documentElement;window.__argoAutoZoom=function(){var w=window.innerWidth||0;return w>=2400?1.25:w>=1800?1.1:1};var z=parseFloat(localStorage.getItem('argo-zoom'));if(!(z>=0.7&&z<=2))z=window.__argoAutoZoom();if(z!==1){d.style.setProperty('--z',z);d.style.zoom=z}}catch(e){}`;

// 데스크톱(Tauri) 웹뷰는 target=_blank·window.open을 조용히 무시한다 — 외부 오리진 링크 클릭을
// 가로채 시스템 브라우저로 연다(러너 OAuth 로그인 페이지·키 발급·결제 링크 전부). 브라우저에선 개입 없음.
// 같은 오리진(localhost 앱) 링크는 세션 쿠키가 외부 브라우저로 안 넘어가므로 건드리지 않는다.
const desktopLinkBridge = `document.addEventListener('click',function(e){try{var o=window.__TAURI__&&window.__TAURI__.opener;if(!o||!o.openUrl)return;var t=e.target;var a=t&&t.closest?t.closest('a[href]'):null;if(!a)return;var u=new URL(a.href,location.href);if((u.protocol==='http:'||u.protocol==='https:')&&u.origin!==location.origin){e.preventDefault();o.openUrl(u.href)}}catch(err){}},true)`;

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
        {/* Pretendard는 자체 호스팅(globals.css @font-face + public/fonts) — 오프라인·CDN 차단에도 본문 한글 유지 */}
        <link rel="preload" href="/fonts/PretendardVariable.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body><ThemeProvider><LanguageProvider><BuildWatch />{children}</LanguageProvider></ThemeProvider></body>
    </html>
  );
}
