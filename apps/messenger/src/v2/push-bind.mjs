// 메신저 v2 휴대폰 푸시 토큰 → 연결 상태 기계(R3, 2026-10-19 축소판 A+). 순수(시험에서 가짜 기계·가짜 토큰으로 부른다).
// v2 앱은 옛 msgr_push_register를 부르지 않는다 — 토큰은 v2 기기 행(msgr2_device_register의 p_push_token)에만 싣는다.
// 토큰은 회전하므로 로그인 때와 앱 재개마다 다시 묻는다. 서버에 실린 값과 같으면 기계가 요청 없이 끝낸다(machine.setPushToken).

/** machine: setPushToken을 가진 기계, getToken(prompt) → { token } | { status }, observeResume(fn) → 해제 함수. 해제 함수를 돌려준다. */
export function bindV2Push({ machine, getToken, observeResume = () => () => {} }) {
  let live = true;
  const run = () => Promise.resolve().then(() => getToken(true)).then((r) => { if (live && r?.token) machine?.setPushToken?.(r.token); }, () => { /* 권한 거부·플러그인 없음 — 알림만 없다 */ });
  void run();
  const stop = observeResume(() => { void run(); });
  return () => { live = false; stop?.(); };
}
