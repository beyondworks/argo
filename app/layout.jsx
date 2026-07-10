import './globals.css';
import { LanguageProvider } from './i18n';
import { ThemeProvider } from './theme';

// 첫 페인트 전에 저장된 테마를 적용 — FOUC 방지 (ThemeProvider의 effect보다 먼저 실행)
const themeBoot = `try{var t=localStorage.getItem('argo-theme');if(t&&t!=='argo')document.documentElement.dataset.theme=t}catch(e){}`;

export const metadata = {
  title: 'Argo — 한 배에 오른 AI 크루',
  description: '프롬프트 한 줄로 전문 AI 크루를 영입하고, 회사가 폴더 단위 기억으로 항해합니다.',
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
