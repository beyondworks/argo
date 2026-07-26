// 설치파일 다운로드 링크 — **단일 출처**. 클라이언트(StarModal·Nav·DownloadSection·InstallSection)와
// 서버(스타 시작·콜백 라우트)가 전부 여기서 가져온다.
//
// 왜 한 곳인가: 예전엔 StarModal·콜백 라우트·설치 섹션이 각자 URL을 갖고 있었고, 인텔 링크만
// v0.1.6에 하드코딩된 채 남아 **같은 랜딩 안에서 두 경로가 서로 다른 파일을 주는** 상태가 됐다
// (인텔 재지원 v0.1.27 이후에도 모달은 6버전 전 dmg를 내려줌 — 2026-07-26 발견). 링크를 늘리려면
// 여기만 고친다.
//
// 파일명은 release.yml이 매 릴리스 고정명으로 발행하므로 버전을 URL에 박지 않는다(latest 포인터).
export const RELEASES = 'https://github.com/beyondworks/argo-agent/releases/latest';
export const BASE = `${RELEASES}/download`;

export const DL = {
  silicon: `${BASE}/argo-macos-apple-silicon.dmg`,
  intel: `${BASE}/argo-macos-intel.dmg`, // 인텔 맥 v0.1.27부터 재지원 — latest에 자산이 있다
  win: `${BASE}/argo-windows-setup.exe`,
};
