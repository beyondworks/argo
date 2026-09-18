// 메시지 즉시성의 판정부. 화면(App.jsx)에서 떼어 둔 이유는 이 규칙들이 회귀가 잘 나는 자리이고,
// 컴포넌트 안에 두면 행동을 테스트로 잠글 수 없기 때문이다.

// 서버 행이 도착한 낙관적 글을 목록에서 걷어낸다. 대조 키는 client_msg_id다 —
// 서버가 붙인 id는 보낸 쪽이 알 수 없으므로 id로는 맞출 수 없다.
export function reconcilePending(pending, rows) {
  const landed = new Set((rows ?? []).map((r) => r?.client_msg_id).filter(Boolean));
  if (!landed.size) return pending;
  return pending.filter((x) => !landed.has(x.clientId));
}

// 메시지 방송 하나를 event 객체로 만든다. 이 함수가 있는 이유는 딱 하나다:
// event.kind는 "무슨 방송인가"(message·approval·reaction·edit)이고 서버 payload의 kind는
// "글 종류"(text·system)다. `{ kind: 'message', ...payload }`처럼 전개를 뒤에 두면 후자가
// 전자를 덮어 수신 분기(event.kind === 'message')가 전부 빗나가고, 글은 10초 폴백 폴에서야
// 그려진다(실측: 수정 전 8.3초, 수정 후 34ms). 구분자는 반드시 전개 **뒤**에 둔다.
export function messageEvent(payload, at = Date.now()) {
  return broadcastEvent('message', { ...payload, msgKind: payload?.kind ?? 'text' }, at);
}

// 모든 방송(approval·reaction·edit 포함)은 이 함수로만 event를 만든다. 지금은 그 payload에
// kind가 없어 순서가 틀려도 멀쩡해 보이지만, 서버가 kind를 싣는 순간 message와 똑같이 죽는다.
// 규칙을 호출부마다 지키게 두지 않고 한 곳에 가둔다.
export function broadcastEvent(kind, payload, at = Date.now()) {
  return { ...payload, kind, at };
}
