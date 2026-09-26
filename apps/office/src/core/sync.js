// 보낼 목록을 앱에 연결한다 — 브라우저 IndexedDB에 목록을 두고, 입력이 멈추면(0.8초·최대 5초) 보낸다.
// 전송: 서버 연결 전에는 "이 기기에 받아 두기"(아무 데도 보내지 않고 성공). 서버 연결 단계에서 이 함수만 Supabase 전송으로 바꾼다.
import { get, set } from 'idb-keyval';
import { createOutbox, autoFlush } from './outbox.js';
import { setSyncState } from './save.js';

const KEY = 'argo-office-outbox';

/** 실제 전송은 core/transport.js가 등록한다(가게 상태를 읽어야 해서 여기서 직접 부르면 순환 참조가 된다). 등록 전에는 이 기기에만 둔다. */
let transport = async () => {};
let rejected = (op, err) => console.warn('[office] change rejected by server', op.key, err?.message);
export function setTransport(send, onRejected) { transport = send; if (onRejected) rejected = onRejected; }

export const outbox = createOutbox({
  store: { get: () => get(KEY), set: (v) => set(KEY, v) },
  send: (op) => transport(op).catch((e) => { throw e?.transient === undefined ? Object.assign(e, { transient: true }) : e; }),
  onState: setSyncState,
  onRejected: (op, err) => rejected(op, err),
});
const auto = autoFlush(outbox);
outbox.load().then(() => auto.now());

/** 변경 하나를 보낼 목록에 넣는다. 같은 key의 아직 안 보낸 변경은 마지막 값으로 합쳐진다. */
export async function queue(key, payload) {
  await outbox.enqueue({ key, payload });
  auto.poke();
}
/** 로그인이 확인된 직후 등 — 기다리지 않고 바로 보낸다 */
export const flushNow = () => auto.now();
