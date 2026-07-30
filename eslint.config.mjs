// no-undef 게이트(전수리뷰 2026-07-30 #2) — gateway listAgents 임포트 누락(크루 쪽지 브리핑 100%
// 무음 실패)이 이 규칙 하나로 잡혔을 종류다. 목적은 "정의 안 된 식별자" 단 하나 — 스타일 규칙은
// 넣지 않는다(스타일 게이트는 리뷰·검수의 몫, 린트 소음은 게이트 무시 습관을 만든다).
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.next/**', 'desktop/**', 'landing/**', 'demo-video/**', 'supabase/functions/**', 'workspaces/**', '.omc/**', '.fablize/**'] },
  {
    // '*.mjs' = 루트 런타임 파일(instrumentation-node·next.config·demo) — instrumentation-node는
    // 스케줄러·게이트웨이·동기화를 부팅하는 상주 진입점이라, 여기가 빠지면 게이트가 겨냥한
    // "무음 실패" 클래스의 한복판이 구멍이다(분리 검수 MEDIUM — 변이 시험으로 미탐 확인).
    files: ['src/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs', '*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-undef': 'error' },
  },
  {
    // public/은 브라우저(데스크톱 셸 부팅 스크립트) — app 트리와 같은 전역으로 커버(같은 검수).
    files: ['app/**/*.js', 'app/**/*.jsx', 'app/**/*.mjs', 'middleware.js', 'public/**/*.js'],
    languageOptions: {
      // 'latest' — 버전 고정(2024)은 신형 구문 유입 시 no-undef 미탐이 아니라 파싱 에러로 죽는다.
      ecmaVersion: 'latest', sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      // Next는 서버·클라 파일이 한 트리에 혼재 — 양쪽 전역을 합친다(no-undef의 목적은 오탈자·임포트
      // 누락이지 환경 경계 검증이 아니다. 환경 경계는 번들러·런타임이 잡는다).
      globals: { ...globals.browser, ...globals.node },
    },
    rules: { 'no-undef': 'error' },
  },
];
