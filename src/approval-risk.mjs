// 결재 위험 등급(부록 H-1). 고위험 = 회사 밖으로 나가거나 되돌리기 어려운 행동(발송·게시·결제·삭제·계약·배포).
// 코드가 보장하는 판정: 커넥터 쓰기(kind 'connector')는 항상 고위험, 자유 문장 결재(kind 'action')는 키워드로.
// ponytail: 키워드 휴리스틱(미탐은 저위험으로 흐른다). 러너가 도구 인자로 위험 등급을 신고하게 되면 "신고 OR 키워드"로 올린다 — 신고로 낮추지는 못하게.
export const RISK_LEVELS = Object.freeze(['low', 'high']);
const HIGH_KINDS = new Set(['connector', 'org_doc']); // org_doc(조직 문서 제안)은 문서 범위의 관리자가 승인해야 한다(부록 G-4)
const LOW_KINDS = new Set(['profile', 'hire', 'loop']); // 회사 안 행동(프로필·영입·루프 재개) — 문장에 '삭제'가 있어도 밖으로 나가지 않는다
const HIGH_RE = /발송|보내|전송|송금|이체|출금|결제|지불|구매|주문|삭제|지우|폐기|게시|공개|배포|업로드|계약|서명|해지|환불|\b(send|e-?mail|mail|post|publish|deploy|pay(ment)?|purchase|buy|order|wire|transfer|withdraw|delete|remove|erase|drop|contract|sign|cancel|refund|upload)\b/i;

export function approvalRisk({ kind = 'action', action = '', reason = '' } = {}) {
  if (HIGH_KINDS.has(kind)) return 'high';
  if (LOW_KINDS.has(kind)) return 'low';
  return HIGH_RE.test(`${action}\n${reason}`) ? 'high' : 'low';
}
