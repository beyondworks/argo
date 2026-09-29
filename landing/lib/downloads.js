// 설치파일 다운로드 링크 — **단일 출처**. Nav·DownloadSection·InstallSection이 전부 여기서 가져온다.
// 2026-09-07: 스타 게이트(StarModal·/api/star)와 릴리스 *페이지* 경유를 걷어냈다 — 다운로드 버튼은
// 어떤 경로로도 GitHub 페이지로 가지 않고 설치파일 바이트만 준다(유건 지시: 소스 레포 프라이빗 전환).
// argo-agent는 릴리스 자산만 있는 배포 레포라 공개 유지 — 아래 직링크는 파일 응답(302 → S3)이다.
//
// 왜 한 곳인가: 예전엔 StarModal·콜백 라우트·설치 섹션이 각자 URL을 갖고 있었고, 인텔 링크만
// v0.1.6에 하드코딩된 채 남아 **같은 랜딩 안에서 두 경로가 서로 다른 파일을 주는** 상태가 됐다
// (인텔 재지원 v0.1.27 이후에도 모달은 6버전 전 dmg를 내려줌 — 2026-07-26 발견). 링크를 늘리려면
// 여기만 고친다.
//
// 파일명은 release.yml이 매 릴리스 고정명으로 발행하므로 버전을 URL에 박지 않는다(latest 포인터).
export const BASE = 'https://github.com/beyondworks/argo-agent/releases/latest/download';

export const DL = {
  silicon: `${BASE}/argo-macos-apple-silicon.dmg`,
  intel: `${BASE}/argo-macos-intel.dmg`, // 인텔 맥 v0.1.27부터 재지원 — latest에 자산이 있다
  win: `${BASE}/argo-windows-setup.exe`,
};

// mac에서 Intel 감지 — WebGL 렌더러 문자열(Chrome 계열에서 유효, Safari는 둘 다 'Apple GPU' → Silicon 기본)
function isIntelMac() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return /intel/i.test(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)));
  } catch { return false; }
}

/** 접속 기기에 맞는 설치파일 타깃 추정 */
export function detectTarget() {
  if (typeof navigator === 'undefined') return 'silicon';
  if (/windows/i.test(navigator.userAgent)) return 'win';
  return isIntelMac() ? 'intel' : 'silicon';
}

/** mac 전용 버튼용 — Windows에서 눌러도 mac 파일을 준다 */
export function detectMacTarget() {
  if (typeof navigator === 'undefined') return 'silicon';
  return isIntelMac() ? 'intel' : 'silicon';
}
