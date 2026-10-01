// 진입 청크(작게) — 시작 스플래시를 먼저 띄우고, 앱 본체(app-root.jsx 이하, 큰 청크)는 그다음에 불러온다.
// 예전에는 1.29MB 단일 번들을 다 해석한 뒤에야 스플래시가 시작돼, 느린 기기에서 로고 없는 빈 바탕이 길었다(설계 §3-3).
// 디자인 시스템은 Argo 앱의 globals.css **그대로**(별칭 @argo/globals.css) — 여기서 불러 head의 <link>로 남긴다(첫 페인트 전에 적용).
// 언어·테마 Provider와 기본 테마('linen')는 app-root.jsx.
import '@argo/globals.css';
import './styles.css';
import { startSplash } from './splash.js'; // 시작 스플래시(북극성) — 앱 본체보다 먼저 첫 화면에
import { pushDiag } from './diag.jsx'; // 빈 화면 대신 오류 문구 + 다시 열기(유건 제보 2026-09-12 알림 탭 → 빈 화면) — 전역 오류 기록을 먼저 건다
import { followThemeBackground } from './webview-bg.js';
import { bootMessenger, renderChunkError } from './boot-entry.mjs';

pushDiag('boot', `start ${location.href.slice(0, 80)}`, navigator.userAgent.slice(0, 80));
// 스플래시 → (모바일) 닫히면 웹뷰 바탕을 테마 색으로 → 앱 본체 청크. 실패하면 빈 화면 대신 안내 + 다시 열기(boot-entry.mjs)
bootMessenger({
  platform: import.meta.env.TAURI_ENV_PLATFORM,
  startSplash,
  followThemeBackground,
  loadApp: () => import('./app-root.jsx'),
  diag: (e) => pushDiag('boot', `app chunk failed: ${e?.message || e}`, String(e?.stack || '').slice(0, 600)),
  onChunkError: () => renderChunkError(),
});
