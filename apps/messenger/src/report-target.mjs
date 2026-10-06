// 신고할 수 있는 글인가(유건 결정 2026-10-06) — 서버 msgr_report_message(20261006170000)와 같은 기준.
// 진짜 시스템 글(author_kind='system')만 뺀다. 에이전트 명의 글은 kind(text·system·approval_card)와 상관없이 신고할 수 있다 —
// 사람이 자기 에이전트 명의로 "관리자 공지" 같은 안내 글을 쓸 수 있기 때문이다. 자기 사람 글·보내는 중인 글은 뺀다.
export function canReportMessage(m, uid) {
  if (!m || m.pending) return false;
  if (m.author_kind !== 'user' && m.author_kind !== 'crew') return false; // 'system' 포함 — 서버가 쓰는 안내
  if (m.author_kind === 'user' && m.author_user_id === uid) return false; // 자기 글(서버 msgr_report_own)
  return true;
}
