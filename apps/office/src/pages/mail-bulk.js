// 메일 일괄 선택(유건 10/9) — 선택 막대 동작마다 실제로 바뀔 메일. 메일 화면과 함께 늦게 불러온다(mail-model.js는 첫 화면이 가져가 여기 둔다). 테스트 test/select.test.mjs
/** 초안은 별표·보관이 없다(목록 줄·읽기 화면과 같은 규칙), 이미 보관한 메일은 다시 보관하지 않는다(단일 'e'와 같게), 보관함 보기에서는 보관이 없다 */
export function bulkTargets(list, view) {
  const mail = list.filter((m) => m.folder !== 'drafts');
  const allStarred = mail.length > 0 && mail.every((m) => m.starred);
  return {
    read: list.filter((m) => m.unread),
    unread: list.every((m) => !m.unread) ? list : [],
    star: allStarred ? [] : mail.filter((m) => !m.starred),
    unstar: allStarred ? mail : [],
    archive: view === 'archive' ? [] : mail.filter((m) => m.folder !== 'archive'),
  };
}

/** 줄 누르기 — 터치 기기에서 한 통이라도 고른 동안은 열지 않고 넣고 뺀다(Gmail 앱 관례) */
export const rowTapPicks = (picked, touch) => picked > 0 && touch;
