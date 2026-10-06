// 설정 '메신저 연결' 카드 조회 결과 나누기 — 라우트(route.js)와 카드 판정(settings/msgr-card.mjs msgrCardView)이 같은 모양을 쓰는지
// node --test가 직접 잠글 수 있게 순수 함수로 뺐다(UL10, 2026-10-05).
/** msgr_crews 내 행 전체 → { crews: 조직 등록 행, personalCount: 활성 개인 공간 행 수 }. 개인 행(org NULL)은 연결·해제 판정(crews)에는 쓰지 않고
    "개인 공간에 연결됨" 표시에만 쓴다(CX-12). */
export function splitCardRows(rows) {
  const all = Array.isArray(rows) ? rows : [];
  return { crews: all.filter((r) => r.org_id != null), personalCount: all.filter((r) => r.org_id == null && r.status === 'active').length };
}
