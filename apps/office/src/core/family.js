// 아르고 패밀리(아르고·메신저·오피스) 주소 — 오피스에서 다른 앱으로 가는 길(10/5 연결성 CX-01·02).
// 메신저는 로그인 콜백 말고는 딥 링크를 받지 않는다(apps/messenger/src/mobile-auth.mjs) — 특정 대화를 여는 주소 규칙이 생기기 전까지는 받는 곳(랜딩)으로 보낸다.
// 둘 다 운영 랜딩(landing/app/messenger·download)이고 응답 200을 확인했다(2026-10-05). download는 메신저의 'Argo 앱 받기'와 같은 곳(가격·결제 링크 없는 페이지).
export const FAMILY = { messenger: 'https://argo.ceo/messenger', download: 'https://argo.ceo/download', privacy: 'https://argo.ceo/privacy' }; // privacy = 메신저 동의 화면과 같은 개인정보처리방침
