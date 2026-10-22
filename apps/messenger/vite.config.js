import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { cloudConfigProblem } from './scripts/cloud-config-gate.mjs';

// 공유 순수 모듈은 별칭으로(복사 금지 — 사본 드리프트). 루트 워크스페이스 전환은 후속(lockfile·CI 파장).
const shared = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
// 메신저 v2 화면은 발행 빌드에서 기본으로 켠다(0.1.64, 공개 계획서 S5) — 데스크톱 CI·iOS·Android가 모두 vite build를 거치므로 여기 한 곳에서 정한다.
// A+ 화면은 0.1.65부터 기본 끔(2026-10-22 유건 결정 — 결재·계정 삭제·신고·차단 등이 빠져 있다). 이 기기 localStorage 'argo-msgr-aplus' = '1' 또는 VITE_MSGR_APLUS=1 빌드로만 켠다.
// 이미 값이 있으면(예: VITE_MSGR_V2=0으로 옛 화면 빌드) 그대로 둔다. dev 서버는 종전처럼 localStorage·환경변수로만 켠다. 사람 채팅 자체는 서버 스위치(msgr2_people)가 연다.
export const RELEASE_UI_DEFAULTS = { VITE_MSGR_V2: '1' };
export default defineConfig(({ command, mode }) => {
  const fileEnv = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  // 설정 파일(.env*)이나 환경변수에 값이 없을 때만 기본값을 넣는다 — 둘 중 하나에 0이 있으면 그 값이 이긴다
  if (command === 'build') for (const [k, v] of Object.entries(RELEASE_UI_DEFAULTS)) if (fileEnv[k] === undefined) process.env[k] ??= v;
  // 발행 빌드 관문 — 서버 주소 없이 나가는 앱 차단(scripts/cloud-config-gate.mjs)
  const problem = cloudConfigProblem({ command, platform: process.env.TAURI_ENV_PLATFORM, env: { ...fileEnv, ...process.env } });
  if (problem) throw new Error(problem);
  return {
  plugins: [react()],
  // React 사본 하나로(실사고 2026-09-07 v0.1.0: @argo/* 별칭이 루트 node_modules의 react를, 메신저 코드는 apps/messenger의
  // react를 들고 와 빌드에 React가 둘 실렸다 → "Cannot read properties of null (reading 'useState')"로 첫 발행 설치본이 빈 화면.
  // dev는 사전 번들이 가려 안 보였다 — 프로덕션 번들 실측이 필수인 이유).
  resolve: { dedupe: ['react', 'react-dom'], alias: {
    '@argo/slash-match': shared('app/c/[ws]/slash-match.mjs'),
    '@argo/globals.css': shared('app/globals.css'), // 디자인 시스템 정본 — 토큰·컴포넌트·테마 전부(사본 금지)
    '@argo/theme': shared('app/theme.jsx'),          // ThemeProvider·THEMES·DEFAULT_THEME(graphite) — localStorage 'argo-theme' 공유
    '@argo/ui': shared('app/ui.jsx'),                // Icon·Avatar·Markdown·DropUp·imeGuardWith
    '@argo/i18n': shared('app/i18n.jsx'),            // LangProvider(ui.jsx가 요구) + 테마 라벨
    '@argo/graph2d-core': shared('app/c/[ws]/graph2d-core.mjs'), // 그래프 구성(순수) — 3D 기억 그래프(graph3d.jsx)가 같은 구성을 쓴다(본체 2D 렌더러는 쓰지 않는다)
    '@argo/splash': shared('public/splash/north-star.mjs'), // 북극성 시작 스플래시 엔진 — 지금은 메신저만 쓴다(본체 부트 화면은 배·파도로 되돌림). 정본 위치는 public/ 그대로
  } },
  server: { host: process.env.TAURI_DEV_HOST || false, strictPort: true, fs: { allow: [shared('.')] } },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
};
});
