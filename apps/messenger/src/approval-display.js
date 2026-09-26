// 결재 카드 쉬운 문장화(유건 확정 2026-09-26) 표시 재료 — JSX 없는 순수 함수만 모은 파일이다.
// App.jsx는 거대한 단일 파일이라 JSX 문법 때문에 plain node로 직접 import해 실행할 수 없다(이 레포의
// 모든 App.jsx 테스트가 소스를 텍스트로 읽어 정규식으로만 검사해 온 이유). 이 파일은 JSX가 전혀 없어
// node --test가 실제로 import해 호출·검증할 수 있다 — "행동 테스트"를 가능하게 하는 분리다.
//
// 분리 검수 M-2: msgr_crew_approvals.payload는 스키마 검증 없는 jsonb라, plain.purpose 등이 문자열이
// 아닌 값(객체·배열·숫자)으로 들어오면 그걸 그대로 JSX 자식으로 렌더링하는 순간 React가 던져
// 채널 화면 전체가 죽는다. 문자열만 통과시키는 단일 관문을 여기 둔다.

/** 문자열이고 트림 후 비어있지 않을 때만 통과 — 아니면 null(표시하지 않음, 화면 안 죽음). */
export function plainField(v) {
  return (typeof v === 'string' && v.trim()) ? v : null;
}

/** 결재 payload에서 쉬운 문장 3항목을 뽑는다. 값이 문자열이 아니면(손상·조작 데이터) 그 항목만 빠지고,
    셋 다 없으면(또는 전부 비문자열이면) null — 호출부가 원래 action/reason 폴백 카드로 그린다. */
export function approvalPlainFields(payload) {
  const p = payload && typeof payload === 'object' ? payload.plain : null;
  const purpose = plainField(p?.purpose);
  const task = plainField(p?.task);
  const need = plainField(p?.need);
  return (purpose || task || need) ? { purpose, task, need } : null;
}

/** "명령 보기"를 기본으로 펼쳐 둘지 — 고위험 결재는 결재자가 원문을 굳이 클릭하지 않아도 보이게 한다
    (분리 검수 M-1). risk 판정 자체는 approval-risk.mjs의 approvalRisk를 그대로 쓴다(새 판정 금지) —
    이 함수는 그 결과를 "펼침 여부"로 바꾸는 표시 규칙 하나뿐이다. */
export function approvalExpandDefault(ap) {
  return ap?.risk === 'high';
}

/** org_doc 카드 제목 — payload.title이 문자열이 아니어도 화면이 죽지 않게(같은 위험 모양, 분리 검수 M-2). */
export function orgDocTitle(payload, fallback = '') {
  const v = payload?.title;
  return typeof v === 'string' ? v : (fallback || String(v ?? ''));
}

/** 문자 전용 미리보기(알림함 한 줄 등)의 결재 요약 — plain 있으면 세 항목 + "명령: <action>" 한 줄,
    없으면 기존 action/reason. 분리 검수 H-1: plain이 있어도 실제 실행될 문장(action)이 항상 보여야 한다. */
export function approvalOneLineSummary(a, commandLabel) {
  const plain = approvalPlainFields(a?.payload);
  const action = typeof a?.action === 'string' ? a.action : String(a?.action ?? '');
  if (!plain) return a?.reason ? `${action} — ${a.reason}` : action;
  const bits = [plain.purpose, plain.task, plain.need].filter(Boolean).join(' · ');
  return `${bits} — ${commandLabel}: ${action}`;
}
