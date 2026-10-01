// 참여 요청에 보일 에이전트 이름(2026-10-01 유건 제보: 친구 화면에 '3d45b1ce' 같은 id 앞 8자리).
// 친구의 개인 에이전트 행은 주인만 읽는다(msgr_crews). 서버 20261001160000부터 msgr_personal_room_crews가 대기 요청이 걸린 크루도 그 방 구성원에게 주므로 보통은 이름이 있다.
// 옛 서버이거나 아직 다시 읽기 전이면 id 조각 대신 요청한 사람 기준의 일상어로 보인다(개인 크루·비회사 크루는 주인만 요청할 수 있어 요청자 = 주인).
export function pendingCrewLabel({ crewId, crews, requesterName, t }) {
  const name = crews?.find((c) => c.id === crewId)?.display_name;
  if (name) return name;
  return requesterName ? t('crew.req.ownerAgent', { name: requesterName }) : t('crew.req.unknown');
}
