// 홈 '챙길 것'(18차, 유건 결정 3) — 줄 목록을 만드는 순수 함수(test/attention.test.mjs). 화면은 HomeAttention.jsx.

/** 챙길 것 줄 — 0인 것은 빼고 정해진 순서(급한 것 먼저)로. 줄마다 누르면 갈 주소(거르기 조건이 걸린 주소).
 *  due = 할 일 수(core/task-model.js dueCounts, null = 아직 안 읽음) · approvals = 결재 대기 수 · biz = 거래 수(deal-model.js attentionOf().counts, null = 업무 정보 없음·거래처 꺼짐) · bizPending = 업무 정보를 읽는 중.
 *  dueError = 할 일 읽기 실패(기다림이 아니라 실패 — '확인하는 중'에 머물지 않게, 검수 LOW 7).
 *  반환 { rows: [{ key, n, tone, to }], pending, taskFail } — pending이면 '챙길 것이 없습니다'라고 말하지 않는다(아직 모르는 것이 있다) */
export function attentionRows({ due, dueError = false, approvals = 0, biz, bizPending = false }, base) {
  const all = [
    { key: 'overdue', n: due?.overdue, tone: 'danger', to: `${base}/tasks?due=overdue` },
    { key: 'today', n: due?.today, tone: 'warn', to: `${base}/tasks?due=today` },
    { key: 'approvals', n: approvals, tone: 'warn', to: `${base}/approvals` },
    { key: 'late', n: biz?.overdue, tone: 'danger', to: `${base}/business/customers?view=overdue` },
    { key: 'uninvoiced', n: biz?.uninvoiced, tone: 'warn', to: `${base}/business/customers?view=uninvoiced` },
  ];
  return { rows: all.filter((x) => x.n > 0), pending: (!due && !dueError) || !!bizPending, taskFail: !due && !!dueError };
}
