// 설정 '메신저 연결' 카드 표시 규칙 — JSX 없는 순수 함수(CX-12, 2026-10-05).
// 개인 공간(2026-09-30 유건) 이후 조직 없이도 내 크루가 메신저 개인 공간에 연결된다. 그런데 카드는 조직 등록만 세어 조직이 없으면
// '연결 필요' + '조직을 만들거나 초대받으세요'를 보이고 연결 상태(실행기)를 숨겼다.

export const MESSENGER_PAGE = 'https://argo.ceo/messenger'; // 맥·윈도우·iOS·Android 받기 안내(앱 스토어 포함) 한 곳
export const OFFICE_URL = 'https://argo-office.vercel.app'; // 아르고 오피스(웹) — 설치를 전제하지 않는다(CX-13)

/** 머리 칩 — 'connected'(조직에 등록됨) · 'personal'(조직은 없지만 개인 공간에 연결됨) · 'notConnected' */
export function msgrConnectionChip({ regCount = 0, personalCount = 0 } = {}) {
  if (regCount > 0) return 'connected';
  if (personalCount > 0) return 'personal';
  return 'notConnected';
}

/** 실행기 상태 영역을 보일까 — 조직 여부와 상관없이 로그인했고 크루가 있으면(개인 공간도 실행기가 답한다). */
export function msgrShowRuntime({ signedIn = false, agentCount = 0 } = {}) {
  return !!signedIn && agentCount > 0;
}
