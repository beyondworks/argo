// 디자인 시스템은 Argo 앱의 globals.css **그대로**(별칭 @argo/globals.css) — 토큰·컴포넌트·30여 테마를 한 원천에서.
// 언어·테마 상태도 Argo 앱과 같은 Provider·localStorage 키를 쓴다(argo-lang / argo-theme) → 두 앱이 같은 룩으로 움직인다.
import { createRoot } from 'react-dom/client';
import '@argo/globals.css';
import './styles.css';
import { LanguageProvider } from '@argo/i18n';
import { ThemeProvider } from '@argo/theme';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <LanguageProvider><ThemeProvider><App /></ThemeProvider></LanguageProvider>,
);
