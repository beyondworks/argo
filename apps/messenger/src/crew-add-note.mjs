// 채널 시트 '에이전트 추가' 패널의 상황 안내 — 한 번에 하나(UX 정리 P1 2026-10-22: 공유·승인·없음·파견·비공개 안내가 최대 5개 쌓였다). 순수(시험에서 그대로 부른다).
// 방 규칙 안내(ch.add.crew.shared — "들어온 에이전트는 누구나 부른다")는 동의가 일어나는 화면이라(2026-09-18) 이 함수와 별개로 늘 둔다.
// 고른 것이 있으면 고른 것에 맞는 안내, 안 골랐으면 목록에 있는 것. 순서: 승인 필요 → 비공개 방의 회사 에이전트(서비스 계정이 함께 들어온다) → 파견.
/** 반환: 'none' | 'approval' | 'company' | 'dispatch' | null */
export function crewAddNoteKey({ rows = 0, picked = 0, pickedApproval = false, anyApproval = false, pickedCompany = false, anyCompany = false, pickedDispatch = false, anyDispatch = false, privateRoom = false } = {}) {
  if (!rows) return 'none';
  if (pickedApproval) return 'approval';
  if (privateRoom && pickedCompany) return 'company';
  if (pickedDispatch) return 'dispatch';
  if (picked > 0) return null; // 고른 것에 해당 안내가 없으면 안내 없음(목록 안내로 되돌아가지 않는다)
  if (anyApproval) return 'approval';
  if (privateRoom && anyCompany) return 'company';
  if (anyDispatch) return 'dispatch';
  return null;
}
