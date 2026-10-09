// 메일 일괄 선택(유건 10/9) — 선택 막대 동작마다 실제로 바뀔 메일. 메일 화면과 함께 늦게 불러온다(mail-model.js는 첫 화면이 가져가 여기 둔다). 테스트 test/select.test.mjs
/** 초안은 별표·보관이 없다(목록 줄·읽기 화면과 같은 규칙), 이미 보관한 메일은 다시 보관하지 않는다(단일 'e'와 같게), 보관함 보기에서는 보관이 없다 */
export function bulkTargets(list, view) {
  if (view === 'trash') return { read: [], unread: [], star: [], unstar: [], archive: [], trash: [], restore: list.filter((m) => m.folder === 'trash') }; // 휴지통 메일함은 꺼내기만(10/9)
  const mail = list.filter((m) => m.folder !== 'drafts');
  const allStarred = mail.length > 0 && mail.every((m) => m.starred);
  return {
    read: list.filter((m) => m.unread),
    unread: list.every((m) => !m.unread) ? list : [],
    star: allStarred ? [] : mail.filter((m) => !m.starred),
    unstar: allStarred ? mail : [],
    archive: view === 'archive' ? [] : mail.filter((m) => m.folder !== 'archive'),
    trash: mail, // 초안은 '임시 보관함 메일 지우기'(확인 창)가 따로 있다
    restore: [],
  };
}

/** 줄 누르기 — 터치 기기에서 한 통이라도 고른 동안은 열지 않고 넣고 뺀다(Gmail 앱 관례) */
export const rowTapPicks = (picked, touch) => picked > 0 && touch;

/** 휴지통 비우기 대상(10/9) — picked(고른 메일)가 있으면 그중 휴지통 메일을 계정별로 묶고, 없으면 지금 고른 계정(전체면 연결된 계정 모두). 예시 모드는 계정 없음 하나 */
export function purgeTargets({ accounts = [], pick, picked, sample = false }) {
  if (picked) {
    const by = new Map();
    for (const m of picked) if (m.folder === 'trash') { if (!by.has(m.account)) by.set(m.account, []); by.get(m.account).push(m); }
    return [...by].map(([account, mails]) => ({ account, mails, total: mails.length }));
  }
  if (sample) return [{ account: undefined }];
  return (pick === 'all' ? accounts : accounts.filter((a) => a.id === pick)).map((a) => ({ account: a.id }));
}
