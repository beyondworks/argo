// 답변 본문 속 vault 상대 링크 → 실제 열리는 URL(순수) — 제보 2026-07-30의 마지막 조각.
// 프롬프트는 크루에게 "경로를 알려라"고 시키는데, 렌더러가 상대 href를 전부 '#'로 죽여
// (XSS 방어) 그 경로가 화면에서 클릭 불가였다(탐색 G7). 화이트리스트 재작성으로 방어는
// 유지하고 산출물만 살린다: md → vault 뷰어, 비md → files API(서빙 접두 = artifacts.mjs와
// 동일 목록 — 칩·첨부·링크가 같은 구역을 본다).
// 그림(제보 2026-10-05 "페퍼 아바타를 이미지로 첨부해줘"에 화면이 비었다)도 같은 판정으로 살린다 — vaultImageSrc.
import { SERVE_PREFIXES } from './artifact-zones.mjs'; // 순수 모듈 — 클라 번들에 fs가 끌려오지 않게(빌드 실측)

/** <img>로 그릴 수 있는 형식 — files API가 정확한 MIME으로 주는 래스터만. svg는 octet-stream(의도 — 스크립트 표면)이라 <img>가 못 그린다. */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** marked가 넘긴 href·src → vault 기준 rel 또는 null(판정 불가). marked는 &를 &amp;로, 비ASCII·공백을 %인코딩(encodeURI)해서 준다 —
    풀지 않으면 한글 경로가 다시 인코딩돼(%25ED…) files API가 404였다(격리 서버 재현 2026-10-08). 풀고 나서 판정하므로 %2e%2e(..)도 걸린다.
    깨진 %(파일명에 든 날 %)는 marked가 그대로 두니 날값으로 판정한다. */
export function vaultRel(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let rel = raw.replace(/&amp;/g, '&').trim();
  try { rel = decodeURIComponent(rel); } catch { /* 깨진 % — 날값 그대로 */ }
  rel = rel.replace(/^\.\//, '').replace(/^vault\//, '');
  if (!rel || /[\\\u0000-\u001f\u007f]/.test(rel) || rel.split('/').some((seg) => seg === '..' || seg === '' || seg === '.')) return null; // 탈출·빈 세그먼트·제어 문자
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return null; // 스킴 있는 값은 여기 소관이 아니다(기존 차단 유지)
  return rel;
}

const filesUrl = (wsId, rel) => `/api/companies/${encodeURIComponent(wsId)}/files?rel=${encodeURIComponent(rel)}`;

/** href(마크다운 상대 링크) → 열리는 URL 또는 null(서빙 불가 — 호출부가 '#'로). */
export function rewriteVaultHref(href, wsId) {
  if (!wsId) return null;
  const rel = vaultRel(href);
  if (!rel) return null;
  const w = encodeURIComponent(wsId);
  if (rel.endsWith('.md') && !rel.toLowerCase().startsWith('journal/')) return `/c/${w}/vault?doc=${encodeURIComponent(rel)}`;
  if (SERVE_PREFIXES.some((p) => rel.startsWith(p))) return filesUrl(wsId, rel);
  return null;
}

/** 마크다운 그림 src → files API 주소 또는 null(호출부가 태그를 지운다). 서빙 구역(projects/·files/·_imported/) 안 래스터 그림만 —
    외부 http·data·프로토콜 상대 주소는 vaultRel이 스킴·빈 세그먼트로 거르고, 구역 밖·탈출은 여기서 걸러진다.
    ver(그 답의 시각)를 주면 &v=로 붙인다 — 브라우저는 한 문서 안에서 같은 주소의 그림을 서버에 다시 묻지 않고 재사용해서, 같은 경로를
    덮어쓴 뒤 온 새 답도 옛 그림을 그렸다(IMG 1차 검수 MEDIUM, 격리 실측: files API를 no-cache+ETag로 바꾼 뒤에도 새 답 256px=옛 그림,
    새로고침 뒤에만 32px). 답마다 주소가 달라 새 답은 그때의 파일을 받는다. 라우트는 v를 읽지 않는다(pdf 미리보기 inline=1과 같은 방식). */
export function vaultImageSrc(src, wsId, ver = null) {
  if (!wsId) return null;
  const rel = vaultRel(src);
  if (!rel || !SERVE_PREFIXES.some((p) => rel.startsWith(p))) return null;
  if (!IMAGE_EXTS.has(rel.split('.').pop().toLowerCase())) return null;
  return ver == null || ver === '' ? filesUrl(wsId, rel) : `${filesUrl(wsId, rel)}&v=${encodeURIComponent(String(ver))}`;
}

/** 본문 그림 주소 → 이 회사 files API가 서빙하는 rel 또는 null — 크게 보기 창이 연다. 다른 회사 주소·구역 밖·탈출은 null. */
export function vaultFileRel(url, wsId) {
  if (!wsId || typeof url !== 'string') return null;
  let u;
  try { u = new URL(url.replace(/&amp;/g, '&'), 'http://argo.local'); } catch { return null; }
  if (u.origin !== 'http://argo.local' || u.pathname !== `/api/companies/${encodeURIComponent(wsId)}/files`) return null;
  const rel = u.searchParams.get('rel');
  return rel && vaultRel(encodeURIComponent(rel)) === rel && SERVE_PREFIXES.some((p) => rel.startsWith(p)) ? rel : null;
}
