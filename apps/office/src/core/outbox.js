// 보낼 목록(outbox) — 저장 버튼 없이 모든 변경이 뒤에서 저장된다(유건 2026-09-26, 노션 방식).
// 변경은 화면에 먼저 반영되고 여기에 쌓인다. 저장소(IndexedDB)에 남으므로 탭을 닫거나 오프라인이어도 잃지 않는다.
// - 같은 key의 아직 안 보낸 변경은 마지막 값 하나로 합친다(글자마다 DB를 다시 쓰지 않는다 — TOAST 사고 9/16).
// - 보내는 중인 변경에는 합치지 않는다(둘 중 하나가 사라진다).
// - 일시 오류는 그 자리에서 멈추고 같은 멱등 id로 재시도(순서 보존, 두 번 적용 없음).
// - 영구 오류(transient === false, 예: 권한 거절)는 빼고 onRejected로 알려 화면을 되돌린다.
const uid = () => (globalThis.crypto?.randomUUID?.() ?? `op-${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function createOutbox({ store, send, onState = () => {}, onRejected = () => {} }) {
  let queue = [];
  let running = null;
  let state = 'idle';
  const setState = (s) => { if (s !== state) { state = s; onState(s); } };
  const save = () => store.set(queue.map(({ sending, ...op }) => op));

  async function run() {
    while (queue.length) {
      const op = queue[0];
      op.sending = true;
      try {
        await send(op);
        queue.shift();
        await save();
      } catch (err) {
        op.sending = false;
        if (err?.transient === false) { queue.shift(); await save(); onRejected(op, err); continue; }
        op.tries = (op.tries ?? 0) + 1;
        await save();
        setState('retrying');
        return false;
      }
    }
    setState('idle');
    return true;
  }

  return {
    state: () => state,
    pending: () => queue.length,
    has: (key) => queue.some((op) => op.key === key),
    tries: () => queue[0]?.tries ?? 0,
    async load() {
      queue = (await store.get()) ?? [];
      if (queue.length) setState('pending');
    },
    async enqueue({ key, payload }) {
      const last = queue.findLast((op) => op.key === key);
      if (last && !last.sending) { last.payload = payload; last.at = Date.now(); }
      else queue.push({ id: uid(), key, payload, at: Date.now(), tries: 0 });
      setState('pending');
      await save();
    },
    /** 한 번에 하나의 전송 루프만 — 이미 돌고 있으면 그 결과를 기다린다. true = 목록이 비었다 */
    async flush() {
      running ??= run().finally(() => { running = null; });
      return running;
    },
  };
}

/**
 * 브라우저용 자동 전송 — 입력이 멈추면(delay) 보내고, 계속 입력 중이어도 maxWait마다 보낸다.
 * 일시 오류면 1초부터 두 배씩(최대 30초) 기다렸다 다시, 온라인이 되면 바로 다시.
 */
export function autoFlush(outbox, { delay = 800, maxWait = 5000 } = {}) {
  let idle = null, cap = null, retry = null;
  const go = async () => {
    clearTimeout(idle); clearTimeout(cap); idle = cap = null;
    const done = await outbox.flush();
    if (!done && outbox.pending()) {
      clearTimeout(retry);
      retry = setTimeout(go, Math.min(30_000, 1000 * 2 ** Math.max(0, outbox.tries() - 1)));
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('online', go);
  return {
    /** enqueue 직후 부른다 */
    poke() {
      clearTimeout(idle);
      idle = setTimeout(go, delay);
      cap ??= setTimeout(go, maxWait);
    },
    now: go,
  };
}
