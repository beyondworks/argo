// next/headers 대역 — 요청 스코프 밖(node --test)에서 인증 켜짐 가드(app/auth.mjs guardCompany)를 실제로 호출하기 위한 것.
// 쿠키 없는 요청(데스크톱 웹뷰·게스트)과 같다: sb-* 쿠키가 없으니 GoTrue 왕복은 하지 않고, 기기 세션·게스트 폴백으로 내려간다.
export async function cookies() { return { getAll: () => [], get: () => undefined }; }
