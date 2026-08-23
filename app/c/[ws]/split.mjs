// 좌우 2분할(보조 패널) — 상태는 URL 쿼리 `?side=<spec>` 하나뿐이다. 전역 상태·컨텍스트 없음.
// spec: `crew:<slug>` | `doc:<rel>`. 순수 함수라 node 테스트가 그대로 임포트한다.

const TYPES = new Set(['crew', 'doc']);

/** `?side=` 값 → { type, key } | null(없음·잘못된 spec). key는 디코딩된 원문(한글 slug 그대로). */
export function parseSide(str) {
  if (typeof str !== 'string' || !str) return null;
  const i = str.indexOf(':');
  if (i <= 0) return null;
  const type = str.slice(0, i);
  const key = str.slice(i + 1);
  if (!TYPES.has(type) || !key) return null;
  return { type, key };
}

/** { type, key } → `?side=` 값(인코딩 전 원문). parseSide(sideParam(x))가 x로 돌아온다. */
export function sideParam(side) {
  if (!side || !TYPES.has(side.type) || !side.key) return '';
  return `${side.type}:${side.key}`;
}

/** href에 side 쿼리를 싣는다(기존 쿼리·해시 보존). sideStr이 비면 side 쿼리를 제거한다. */
export function withSide(href, sideStr) {
  const hashAt = href.indexOf('#');
  const hash = hashAt >= 0 ? href.slice(hashAt) : '';
  const base = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const qAt = base.indexOf('?');
  const path = qAt >= 0 ? base.slice(0, qAt) : base;
  const params = new URLSearchParams(qAt >= 0 ? base.slice(qAt + 1) : '');
  if (sideStr) params.set('side', sideStr);
  else params.delete('side');
  const q = params.toString();
  return `${path}${q ? `?${q}` : ''}${hash}`;
}
