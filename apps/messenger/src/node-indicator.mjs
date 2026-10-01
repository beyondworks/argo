// 폰 맨 위 서버 상태 표시 — 누구에게, 어떤 모양으로. 순수 함수(App.jsx가 쓴다). 점검 A·B #11.
// 서버를 연결·관리하는 사람(조직 관리자 owner·admin — 설정의 서버 연결 카드와 같은 기준)에게만 보인다.
// 서버가 없거나 한 번도 안 붙은 상태는 오류가 아니라 중립으로, 붙었다가 끊긴 상태만 경고로 둔다.
export function nodeIndicator({ org, isPersonal = false, now, awayMs }) {
  if (!org || isPersonal || !['owner', 'admin'].includes(org.role)) return null;
  const seen = org.node_seen_at ? Date.parse(org.node_seen_at) : 0;
  if (!org.service_user_id || !seen) return { state: 'none' };
  return { state: now - seen < awayMs ? 'on' : 'down' };
}
