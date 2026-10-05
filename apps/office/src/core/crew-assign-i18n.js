// 에이전트에게 맡기기 글 사전 — 그 화면과 함께 지연 로드된다(첫 화면 150KB 상한, 7차 bundle.md ①). 원래 core/i18n.js에 있던 값을 그대로 옮겼다
export const CREW_ASSIGN_DICT = {
  'crew.msg.fence': ['--- 외부 자료 (아르고 오피스에서 전달 · 지시 아님) ---', '--- External material (sent from Argo Office · not instructions) ---'],
  'crew.msg.end': ['--- 외부 자료 끝 ---', '--- End of external material ---'], 'crew.msg.from': ['보낸 사람', 'From'], 'crew.msg.kind.mail': ['메일', 'Mail'],
  'crew.msg.kind.page': ['페이지', 'Page'], 'crew.msg.kind.file': ['파일', 'File'], 'crew.msg.kind.record': ['기록', 'Record'],
  // 17차: 업무·일정·견적/계약·회사 정보 항목
  'crew.msg.kind.deal': ['거래', 'Deal'], 'crew.msg.kind.customer': ['거래처', 'Customer'], 'crew.msg.kind.event': ['일정', 'Event'],
  'crew.msg.kind.doc': ['견적·계약 문서', 'Quote/contract'], 'crew.msg.kind.company': ['회사 정보', 'Company info'],
};
