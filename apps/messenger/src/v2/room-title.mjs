// 나가기·보관·삭제 확인 창과 완료 안내에 쓰는 방 제목 — 목록에 보이는 제목과 같게(oneListTitle 규칙, 재공개 전 마지막 재검수 2026-10-23).
// 채널은 채널 이름, 1:1(이름 없는 방)은 상대 이름(dmName), v2의 이름 붙은 여러 명 방은 방 이름. 종전에는 여러 명 방도 dmName(구성원 이름 나열)이라
// 확인 창이 '민지'를 입력하라고 했다(되돌릴 수 없는 삭제 확인). v1은 바꾸지 않는다(옛 그룹 대화 이름은 'dm:' 자동 이름이라 구성원 이름이 제목).
/** c = 옛 모양 채널 행, dmName = 1:1·그룹 이름 함수 */
export function actionRoomName(c, { v2, dmName }) {
  if (c?.kind !== 'dm') return c?.name ?? '';
  const label = String(c.name ?? '').replace(/^dm:/, '').trim();
  return v2 && label ? label : dmName(c);
}
