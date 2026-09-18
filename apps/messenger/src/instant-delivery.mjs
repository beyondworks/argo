// 메시지 즉시성의 판정부. 화면(App.jsx)에서 떼어 둔 이유는 이 규칙들이 회귀가 잘 나는 자리이고,
// 컴포넌트 안에 두면 행동을 테스트로 잠글 수 없기 때문이다.

// 방송 payload만으로 글을 그릴 수 있는지 판정한다.
// 서버가 여윈 payload(본문 없음)를 보내는 동안에는 null을 돌려 조회 경로로 떨어뜨린다 —
// 이 폴백이 있어야 마이그레이션 적용 전과 구버전 서버에서도 메시지가 보인다.
export function rowFromBroadcast(payload) {
  if (!payload || typeof payload.body !== 'string' || !payload.id || !payload.created_at) return null;
  return {
    id: payload.id,
    author_kind: payload.author_kind ?? 'user',
    author_user_id: payload.author_user_id ?? null,
    crew_id: payload.crew_id ?? null,
    kind: payload.msgKind ?? 'text', // 글 종류. event.kind는 '무슨 방송인가'라 여기 쓰면 안 된다
    body: payload.body,
    mentions: payload.mentions ?? [],
    reply_to: payload.reply_to ?? null,
    created_at: payload.created_at,
    edited_at: null,
    deleted_at: null,
    meta: payload.meta ?? null,
    client_msg_id: payload.client_msg_id ?? null,
  };
}

// 서버 행이 도착한 낙관적 글을 목록에서 걷어낸다. 대조 키는 client_msg_id다 —
// 서버가 붙인 id는 보낸 쪽이 알 수 없으므로 id로는 맞출 수 없다.
export function reconcilePending(pending, rows) {
  const landed = new Set((rows ?? []).map((r) => r?.client_msg_id).filter(Boolean));
  if (!landed.size) return pending;
  return pending.filter((x) => !landed.has(x.clientId));
}

// 같은 글이 방송 둘로 온다: org:<조직>(여윈 것)과 ch:<채널>(본문 실은 것).
// 본문 실은 방송을 최근에 받았다면 여윈 쌍둥이를 보고 조회하지 않는다.
// 이미 목록에 있는 글도 다시 읽지 않는다. 본문 방송이 끊기면 trustMs 뒤 조회로 돌아온다.
export function shouldFetchOnEvent({ eventId, hasBody, msgIds, chLiveAt, now, trustMs }) {
  if (hasBody) return false;
  if (eventId && msgIds?.has?.(eventId)) return false;
  return now - chLiveAt > trustMs;
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
