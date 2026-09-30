// Argo 패밀리 — 세 제품은 같은 마크 도형을 다른 재료로 그린다(본체 프레스코 · 메신저 평면 단색 · 오피스 연필).
// 스위처·마크 색·상단 CTA가 이 목록 하나를 본다. 순서 = 스위처 순서.
export const PRODUCTS = [
  { id: 'argo', href: '/', name: 'Argo' },
  { id: 'messenger', href: '/messenger', name: 'Messenger' },
  { id: 'office', href: '/office', name: 'Office' },
];

export function productOf(pathname = '/') {
  return PRODUCTS.find((p) => p.href !== '/' && pathname.startsWith(p.href))?.id ?? 'argo';
}
