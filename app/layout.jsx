import './globals.css';
import { LanguageProvider } from './i18n';
import { ThemeProvider } from './theme';
import BuildWatch from './build-watch';

// 첫 페인트 전에 저장된 테마를 적용 — FOUC 방지 (ThemeProvider의 effect보다 먼저 실행)
const themeBoot = `try{var t=localStorage.getItem('argo-theme');if(t&&t!=='argo')document.documentElement.dataset.theme=t}catch(e){}`;

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
        <script dangerouslySetInnerHTML={{ __html: desktopLinkBridge }} />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
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
