// 알림 식별자 = "종류:글id@채널id"(D52) — 배너 클릭을 받은 네이티브(notify_mac.rs)가 이 문자열을 그대로 돌려주면 여기서 채널을 꺼낸다.
// 같은 식별자는 OS가 한 알림으로 바꿔 끼우므로 글 id는 그대로 둔다(종전 "r:<id>" 규칙 유지).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const notifyTag = (kind, id, channelId) => (UUID.test(String(channelId ?? '')) ? `${kind}:${id}@${channelId}` : `${kind}:${id}`);
export function notifyChannel(identifier) {
  const s = String(identifier ?? ''); const at = s.lastIndexOf('@');
  const ch = at >= 0 ? s.slice(at + 1) : '';
  return UUID.test(ch) ? ch : null;
}
