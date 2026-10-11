// 설정 '메신저 연결' 카드 조회 결과 나누기 — 라우트(route.js)와 카드 판정(settings/msgr-card.mjs msgrCardView)이 같은 모양을 쓰는지
// node --test가 직접 잠글 수 있게 순수 함수로 뺐다(UL10, 2026-10-05).
/** msgr_crews 내 행 전체 → { crews: 조직 등록 행, personalCount: 활성 개인 공간 행 수, personal: 개인 공간 행 }. 개인 행(org NULL)은 조직 연결·해제 판정(crews)에는
    쓰지 않는다(CX-12). personal은 조직이 없는 사용자의 개인 공간 줄(멈춘 에이전트 연결 — 검수 스택 화면 4차, 2026-10-11)에 쓴다. */
export function splitCardRows(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const personal = all.filter((r) => r.org_id == null);
  return { crews: all.filter((r) => r.org_id != null), personalCount: personal.filter((r) => r.status === 'active').length, personal };
}
