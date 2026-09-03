// 디자인 시스템은 Argo 앱의 globals.css **그대로**(별칭 @argo/globals.css) — 토큰·컴포넌트·30여 테마를 한 원천에서.
// 언어·테마 상태도 Argo 앱과 같은 Provider·localStorage 키를 쓴다(argo-lang / argo-theme). 기본 테마만 다르다:
// 메신저는 'linen'(웜 그레이지·차콜 레일 — 시안 2026-09-03 승인). 오리진이 달라 저장값은 실제로 공유되지 않으므로 이 기본값이 첫 페인트를 정한다.
import { createRoot } from 'react-dom/client';
import '@argo/globals.css';
import './styles.css';
import { LanguageProvider } from '@argo/i18n';
import { ThemeProvider } from '@argo/theme';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <LanguageProvider><ThemeProvider defaultTheme="linen"><App /></ThemeProvider></LanguageProvider>,
);
