// 답변 본문 속 vault 상대 링크 → 실제 열리는 URL(순수) — 제보 2026-07-30의 마지막 조각.
// 프롬프트는 크루에게 "경로를 알려라"고 시키는데, 렌더러가 상대 href를 전부 '#'로 죽여
// (XSS 방어) 그 경로가 화면에서 클릭 불가였다(탐색 G7). 화이트리스트 재작성으로 방어는
// 유지하고 산출물만 살린다: md → vault 뷰어, 비md → files API(서빙 접두 = artifacts.mjs와
// 동일 목록 — 칩·첨부·링크가 같은 구역을 본다).
import { SERVE_PREFIXES } from './artifact-zones.mjs'; // 순수 모듈 — 클라 번들에 fs가 끌려오지 않게(빌드 실측)

/** href(마크다운 상대 링크) → 열리는 URL 또는 null(서빙 불가 — 호출부가 '#'로).
    marked가 &를 &amp;로 이스케이프한 상태로 들어온다 — 복원 후 판정. */
export function rewriteVaultHref(href, wsId) {
  if (!wsId || typeof href !== 'string' || !href) return null;
  let rel = href.replace(/&amp;/g, '&').trim();
  rel = rel.replace(/^\.\//, '').replace(/^vault\//, '');
  if (!rel || rel.includes('\\') || rel.split('/').some((seg) => seg === '..' || seg === '')) return null; // 탈출·빈 세그먼트
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return null; // 스킴 있는 값은 여기 소관이 아니다(기존 차단 유지)
  const w = encodeURIComponent(wsId);
  if (rel.endsWith('.md') && !rel.startsWith('journal/')) return `/c/${w}/vault?doc=${encodeURIComponent(rel)}`;
  if (SERVE_PREFIXES.some((p) => rel.startsWith(p))) return `/api/companies/${w}/files?rel=${encodeURIComponent(rel)}`;
  return null;
}
