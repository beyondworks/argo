// Argo 패밀리 — 세 제품은 같은 마크 도형을 다른 재료로 그린다(본체 프레스코 · 메신저 평면 단색 · 오피스 연필).
// 스위처·마크 색·상단 CTA가 이 목록 하나를 본다. 순서 = 스위처 순서.
export const PRODUCTS = [
  { id: 'argo', href: '/', name: 'Argo' },
  { id: 'messenger', href: '/messenger', name: 'Messenger' },
  { id: 'office', href: '/office', name: 'Office', live: false }, // 공개 전(유건 10/2: 메신저까지만 배포, 오피스는 더 다듬는다) — true로 바꾸면 스위처·패밀리 카드·/office·사이트맵에 다시 나온다
];

/** 지금 공개한 제품만 — 스위처·패밀리 카드·사이트맵이 쓴다 */
export const LIVE = PRODUCTS.filter((p) => p.live !== false);
export const isLive = (id) => LIVE.some((p) => p.id === id);

export function productOf(pathname = '/') {
  return PRODUCTS.find((p) => p.href !== '/' && pathname.startsWith(p.href))?.id ?? 'argo';
}
