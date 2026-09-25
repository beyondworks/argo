// Tauri 발행 빌드(tauri build → beforeBuildCommand → vite build, TAURI_ENV_PLATFORM이 설정됨)는 클라우드 서버 주소·공개 키가 있어야 한다.
// 실사고 2026-09-25: 발행 워크트리에 로컬 설정 파일이 없어 iOS 0.1.39가 서버 주소 없이 TestFlight에 올라가 "서버 설정이 없습니다" 화면만 떴다.
// 데스크톱 CI는 이미 같은 검사를 한다(release-messenger.yml) — 로컬 모바일 빌드도 같은 관문을 지나게 vite 설정에서 막는다.
const REQUIRED = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];

export function cloudConfigProblem({ command, platform, env }) {
  if (command !== 'build' || !platform) return null; // 개발 서버·Tauri 밖 빌드는 셀프호스트 설정 화면이 정상 동작
  const missing = REQUIRED.filter((k) => !String(env[k] ?? '').trim());
  return missing.length ? `[cloud-config-gate] Tauri ${platform} 발행 빌드에 ${missing.join(', ')} 없음 — 앱이 서버 없이 나간다. apps/messenger의 로컬 설정 파일이나 환경변수를 확인하세요` : null;
}
