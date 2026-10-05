// 회사 셸 조회 실패 처리 — JSX 없는 순수 함수(node --test가 직접 import해 검증한다).
// F3(2026-10-05): 회사 정보 조회가 한 번만 실패해도(순단·401·500) 화면 전체가 '회사를 찾을 수 없습니다'로 바뀌었다.

/** 진짜 없음인가 — 서버가 404 company_not_found(authmsg.mjs 코드)라고 말한 경우만. 상태 숫자만 보지 않는다(프록시 404 등). */
export function isCompanyMissing(err) {
  return err?.data?.errorCode === 'company_not_found';
}

/** 조회 실패 뒤 셸 상태 — 진짜 없음이면 '찾을 수 없음' 화면, 그 밖은 이미 보던 화면을 그대로 두고(다음 폴·다시 시도에서 회복),
    처음부터 받은 것이 없으면 '불러오지 못함 + 다시 시도' 화면. */
export function nextCompanyData(prev, err) {
  if (isCompanyMissing(err)) return { missing: true };
  if (prev?.company) return prev;
  return { loadError: true };
}
