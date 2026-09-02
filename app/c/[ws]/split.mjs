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

/** 페이지 안에서 다른 주 화면으로 옮길 때(커맨더 이동 명령 등) **현재** `?side=`를 그대로 싣는다 — 레이아웃의
    내부 링크(L(href) = withSide(href, sideStr))와 같은 효과를 페이지 코드에서. search = window.location.search
    (테스트에선 문자열 주입, 앞의 '?' 유무 무관). side가 없거나 잘못된 spec이면 href 그대로(빈 '?'도 남기지 않는다).
    단 무효 spec은 여기서 버린다 — 레이아웃 링크는 값을 검증 없이 남기되 어차피 패널을 안 그리므로 사용자 가시 동작은
    같다(유효 spec에서만 두 계산이 문자 그대로 일치). 생 router.push(href)는 side를 떨어뜨려 보조 패널이 닫힌다
    (분리 검수 2026-09-02 LOW-5). */
export function keepSide(href, search) {
  return keepSideExcept(href, search, null);
}

/** keepSide와 같되 현재 side가 spec(예: 방금 해고한 크루 `{ type:'crew', key:slug }`)이면 떨군다 — 사라진 대상을
    가리키는 패널을 다음 화면까지 끌고 가지 않게. spec이 null이면 keepSide와 동일. */
export function keepSideExcept(href, search, spec) {
  const cur = new URLSearchParams(String(search ?? '')).get('side');
  const drop = !parseSide(cur) || (spec && cur === sideParam(spec));
  return withSide(href, drop ? '' : cur);
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
