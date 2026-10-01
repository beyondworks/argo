// 대화방 시트 에이전트 목록이 비었을 때의 안내 문구 키. 넣기 요청이 대기 중이면 그 요청 행이 이미 보이므로 안내하지 않는다 —
// 방금 요청을 보냈는데 "넣을 수 있는 내 에이전트가 없습니다"가 떠 에이전트가 있는 사람에게 없다고 말했다(검수 F, 2026-10-01).
export function crewListEmptyKey({ crewCount, pendingCount, isPersonal, canAddCrew, scoped }) {
  if (crewCount > 0 || pendingCount > 0) return null;
  if (isPersonal && !canAddCrew) return 'ch.crews.none.personal';
  return scoped ? 'ch.crews.none.scoped' : 'ch.crews.none';
}
