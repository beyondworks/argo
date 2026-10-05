// 홈 '챙길 것'(18차) 사전 — HomeAttention.jsx가 스스로 등록한다(지연 청크). 모듈 이름(mod.attention)은 홈 격자에 먼저 필요해 core/i18n.js에 있다.
export const ATTN_DICT = {
  'home.attn.overdue': ['마감 지난 할 일', 'Overdue to-dos'],
  'home.attn.today': ['오늘 마감 할 일', 'To-dos due today'],
  'home.attn.approvals': ['결재 대기', 'Waiting for approval'],
  'home.attn.late': ['입금이 늦은 거래', 'Late payments'],
  'home.attn.uninvoiced': ['계산서를 안 보낸 거래', 'Not invoiced yet'],
  'home.attn.n': ['{n}건', '{n}'],
  'home.attn.none': ['챙길 것이 없습니다', 'Nothing needs attention'],
  'home.attn.loading': ['확인하는 중…', 'Checking…'],
  'home.attn.taskFail': ['할 일을 불러오지 못했습니다', 'Couldn’t load to-dos'],
  'home.attn.retry': ['다시 시도', 'Try again'],
  'home.attn.bizFail': ['거래 정보를 불러오지 못해 입금·계산서는 빠졌습니다', 'Couldn’t load deals, so payments and invoices aren’t shown'],
};
