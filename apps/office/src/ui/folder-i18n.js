// 폴더 보기 사전 — 기록 화면과 함께 지연 로드된다
export const FOLD_DICT = {
  // 결재함(9/30 core/i18n.js에서 옮김 — 첫 화면 150KB 상한). 위험도 문구 risk.*는 홈 카드도 써서 core에 둔다
  'ap.approve': ['승인', 'Approve'], 'ap.reject': ['거절', 'Reject'], 'ap.command': ['명령 보기', 'View command'], 'ap.empty': ['결재를 기다리는 일이 없습니다', 'Nothing waiting for approval'],
  'ap.decided': ['{result}했습니다', 'Marked as {result}'], 'ap.alreadyN': ['이미 다른 곳에서 정한 {n}건은 건너뜀', '{n} already decided elsewhere — skipped'], 'ap.who': ['결정할 수 있는 사람: 관리자', 'Who can decide: admins'], 'ap.whoLow': ['결정할 수 있는 사람: 에이전트 주인', 'Who can decide: agent owner'],
  'ap.open': ['열어서 확인', 'Open to review'], 'ap.request': ['요청 원문', 'Request'],
  'fold.folders': ['폴더', 'Folders'], 'fold.all': ['전체', 'All'], 'fold.agent': ['에이전트', 'Agent'], 'fold.human': ['사람이 올린 파일', 'Uploaded by people'], 'fold.people': ['사람', 'People'],
  'fold.today': ['오늘', 'Today'], 'fold.yesterday': ['어제', 'Yesterday'], 'fold.week': ['이번 주', 'This week'], 'fold.month': ['이번 달', 'This month'], 'fold.count': ['{n}건', '{n} items'], 'fold.count1': ['{n}건', '{n} item'],
  'fold.empty': ['아직 기록이 없습니다', 'Nothing recorded yet'], 'fold.none': ['이 종류의 파일이 없습니다', 'No files of this type'],
  'fold.kind': ['파일 종류', 'File type'], 'fold.kind.all': ['전체', 'All'], 'fold.kind.doc': ['문서', 'Documents'], 'fold.kind.image': ['이미지', 'Images'], 'fold.kind.other': ['기타', 'Other'],
};
