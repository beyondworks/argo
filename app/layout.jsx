import './globals.css';
import { LanguageProvider } from './i18n';
import { ThemeProvider } from './theme';

// 첫 페인트 전에 저장된 테마를 적용 — FOUC 방지 (ThemeProvider의 effect보다 먼저 실행)
const themeBoot = `try{var t=localStorage.getItem('argo-theme');if(t&&t!=='argo')document.documentElement.dataset.theme=t}catch(e){}`;

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
      <body><ThemeProvider><LanguageProvider>{children}</LanguageProvider></ThemeProvider></body>
    </html>
  );
}
