// 앱 본체 — main.jsx(진입)가 스플래시를 띄운 뒤 동적으로 불러온다.
// 언어·테마 상태는 Argo 앱과 같은 Provider·localStorage 키를 쓴다(argo-lang / argo-theme). 기본 테마만 다르다:
// 메신저는 'linen'(웜 그레이지·차콜 레일 — 시안 2026-09-03 승인). 오리진이 달라 저장값은 실제로 공유되지 않으므로 이 기본값이 첫 페인트를 정한다.
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '@argo/i18n';
import { ThemeProvider } from '@argo/theme';
import App from './App.jsx';
import { RootBoundary } from './diag.jsx';

createRoot(document.getElementById('root')).render(
  <RootBoundary><LanguageProvider><ThemeProvider defaultTheme="linen"><App /></ThemeProvider></LanguageProvider></RootBoundary>,
);
