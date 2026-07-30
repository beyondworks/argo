// 산출물 구역·칩 허용 판정 — **순수 상수/함수만**(node:fs 금지). ui.jsx(클라이언트 번들)가
// vault-links를 통해 임포트하므로, fs가 딸린 artifacts.mjs에서 분리했다(분리 검수 후 빌드 실측:
// node:fs/path가 webpack 클라이언트 번들로 끌려가 next build가 죽었다).
export const SERVE_PREFIXES = ['projects/', 'files/', '_imported/'];

/** 칩으로 내보낼 수 있는 rel인가 — md는 뷰어(vault?doc=)가 vault 전역을 열 수 있으니 journal/만
    제외(일지는 전용 칩). 비md는 files API 서빙 접두만 — 목록 밖이면 눌러도 400이다.
    강화(분리 검수 LOW): journal 비교는 케이스폴딩(macOS 무시 FS에서 Journal/ 우회 방지),
    `..` 세그먼트·백슬래시는 생산 경로가 못 만들지만 심층 방어로 거부. */
export function servableArtifact(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\')) return false;
  if (rel.split('/').some((seg) => seg === '..' || seg === '')) return false;
  if (rel.toLowerCase().startsWith('journal/')) return false;
  if (rel.endsWith('.md')) return true;
  return SERVE_PREFIXES.some((p) => rel.startsWith(p));
}
