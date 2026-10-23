// 로그인 화면으로 떨어진 이유(검수 D10: 세션 만료로 로그인 화면에 떨어져도 아무 안내가 없었다).
// 이벤트(SIGNED_OUT)로는 못 잡는다 — 앱을 다시 열 때 supabase-js는 클라이언트 초기화 중에 갱신을 시도하고, 실패하면 앱이 구독하기 전에
// SIGNED_OUT을 내 버린다(앱은 INITIAL_SESSION null만 받는다 — 로컬 스택 실측). 그래서 "로그인해 있었다" 표시를 남겨 두고,
// 세션 없이 들어왔을 때 표시가 있으면 만료로 본다. 사용자가 누른 로그아웃(pending)·계정 삭제(deleting)는 제외.
// 앱을 다시 열 때·쓰는 중 갱신 실패·모바일 복귀(session recovery)가 모두 applySession 한 자리를 지난다.
export const SIGNED_IN_MARK = 'msgr-signed-in';

/** 세션이 바뀔 때마다 부른다. 반환: 'expired'(안내를 띄운다) | 'signedIn'(만료 안내를 지운다) | null */
export function sessionTransition(store, next, { pending = false, deleting = false } = {}) {
  let had = false;
  try { had = store?.getItem(SIGNED_IN_MARK) === '1'; } catch { /* 저장 불가 — 안내 없이 진행 */ }
  if (next) {
    try { store?.setItem(SIGNED_IN_MARK, '1'); } catch { /* 저장 불가 */ }
    return 'signedIn';
  }
  try { store?.removeItem(SIGNED_IN_MARK); } catch { /* 저장 불가 */ }
  return had && !pending && !deleting ? 'expired' : null;
}

/** 다시 로그인했을 때 남길 안내(순수). 로그인 화면에 이유를 적은 안내 — 세션 만료(auth.sessionExpired)와 signOutNotice로 띄운 것
    (v2 '보안을 위해 다시 로그인'·기기 폐기·모든 기기 로그아웃, screenKey) — 는 지운다: 로그인한 뒤 빨간 토스트로 남았다(유건 사용 검수 2026-10-23 F8).
    로그아웃 중에 생긴 실패 안내(push.logout.* — 로그인이 남아 있을 때 띄운다)는 그대로 둔다. */
export const noticeAfterSignIn = (cur, screenKey = null) => (cur === 'auth.sessionExpired' || (screenKey && cur === screenKey) ? '' : cur);
