// 앱이 열릴 때 어느 공간(조직·개인)에서 시작할지 — 순수 함수(App.jsx loadOrgs가 쓴다).
// 규칙은 종전 그대로(지금 공간 유지 → 마지막 공간 → 첫 조직)이고, 조직이 하나도 없는 경우만 달라졌다:
// 조직이 없고 마지막 공간 기록도 없으면 null(빈 조직 화면)이 아니라, 개인 공간에 대화·친구가 있을 때 개인 공간으로 시작한다.
// 아무 기록도 없는 새 사용자는 null — "새 조직 만들기·초대 코드로 들어오기" 안내가 첫 화면이어야 한다(개인 공간은 비어 있고 조직을 만들 길이 숨어 있다).

// 마지막 공간 기록이 "있다"는 것은 그 공간이 지금도 갈 수 있을 때뿐이다 — 개인 공간이거나 지금 조직 목록에 있는 조직. 나간·삭제된 조직의 기록은 없는 것으로 본다.
const usableLast = (last, personal, orgIds) => !!last && (last === personal || orgIds.includes(last));

/** 개인 공간에 내용이 있는지 따로 조회해야 하는가 — 그 조회는 이 한 경우에만 한다(그 외엔 불필요한 호출). */
export function needsPersonalProbe({ personal = '__personal__', cur, orgIds, last }) {
  return !cur && orgIds.length === 0 && !usableLast(last, personal, orgIds);
}

export function pickStartSpace({ personal, cur, orgIds, last, personalHasContent = false }) {
  if (cur === personal || (cur && orgIds.includes(cur))) return cur;
  if (usableLast(last, personal, orgIds)) return last;
  if (orgIds.length > 0) return orgIds[0];
  return personalHasContent ? personal : null;
}
