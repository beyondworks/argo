// 결재 카드 표시 규칙 — JSX 없는 순수 함수만 모은 파일이다. app/*.jsx는 JSX 문법 때문에 plain node로
// 직접 import해 실행할 수 없어(이 레포의 모든 .jsx 테스트가 소스를 텍스트로 읽어 정규식으로만 검사해
// 온 이유), 표시 "결정 로직"만 여기로 빼서 node --test가 실제로 import해 호출·검증할 수 있게 한다.
// apps/messenger/src/approval-display.js와 같은 계약(두 앱이 별도 런타임이라 파일은 따로 둔다).

/** "명령 보기"를 기본으로 펼쳐 둘지 — 고위험 결재는 결재자가 원문을 굳이 클릭하지 않아도 보이게 한다
    (분리 검수 M-1). risk 판정 자체는 src/approval-risk.mjs의 approvalRisk를 그대로 쓴다(새 판정 금지) —
    API 라우트(app/api/companies/[ws]/approvals/route.js)가 이미 그 결과를 approvals 배열의 risk 필드로
    실어 보낸다. 이 함수는 그 값을 "펼침 여부"로 바꾸는 표시 규칙 하나뿐이다. */
export function approvalExpandDefault(a) {
  return a?.risk === 'high';
}
