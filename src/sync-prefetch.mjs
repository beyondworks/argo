// 동기화 받기 미리 하기 — 원격 파일 내려받기만 상한 있는 동시 실행으로 앞당기고, 결과는 소비하는 쪽이 정해진 순서대로 꺼내 쓴다.
//
// 왜: 동기화 사이클은 원격 신규·변경 파일을 한 번에 하나씩 받아 파일마다 왕복 지연이 그대로 쌓였다. 새 기기 첫 동기화(VPS, 2026-10-10 실측)가
// 분당 약 65개 — 3,734개 회사를 받는 데 1시간 가까이 걸렸다. 받기(네트워크)만 겹치고 쓰기·판정·집계는 사이클 루프가 종전 순서 그대로 한다.
//
// 지키는 것:
// · 같은 키를 두 번 받지 않는다 — 한 키는 미리 받기가 한 번 시작하거나, 시작 전이면 take가 직접 한 번 받는다(둘 중 하나만).
//   예외는 하나: 동시에 받다가 시간 초과가 나면 그 키를 차례에 혼자 한 번 더 받는다(아래 '느린 회선').
// · 실패는 그 키의 차례에 원래 오류 객체 그대로 던진다(분류·태그 동일). 미리 받는 동안 난 거부는 감싸 두므로 처리 안 된 거부가 생기지 않는다.
// · 동시 개수(concurrency)·앞서 받아 둘 개수(maxAhead)·앞서 받아 둔 크기 합(maxBytes)·지금 받고 있는 크기 합(maxInflightBytes)에 상한.
//   soloBytes보다 큰 파일은 혼자 받는다(다른 받기가 없을 때 시작하고, 받는 동안 다른 것을 시작하지 않는다) — 종전과 같은 속도·같은 시간 초과 여유.
// · 느린 회선(분리 검수 HIGH-1): 클라이언트의 요청 시간 초과(30초)는 본문을 받는 시간까지 포함한다. 여러 개가 회선을 나눠 쓰면 하나씩이면 받았을
//   파일이 시간 초과로 실패한다. 동시에 받던 중 시간 초과(isSlow)가 한 번이라도 나면 남은 받기는 하나씩(concurrency 1)으로 바꾸고, 함께 받던 요청은
//   멈춘 뒤 각자 차례에 하나씩 다시 받으며, 시간 초과로 실패한 그 키도 차례에 혼자 한 번 더 받는다 — 종전(하나씩)이 받는 파일은 이 사이클 안에서 받는다.
//   degraded로 알려 호출부가 회사별로 기억하게 한다(다음 사이클은 하나씩으로 시작).
// · stop() 뒤에는 새로 시작하지 않고, 진행 중인 요청을 멈추며(abort), 받아 둔 결과를 버리고, 요청이 끝날 때까지 기다린다.

/** keys = 소비 순서(중복 없음). fetchOne(key, signal) = 실제 받기(signal은 멈추기용, 없을 수 있다). take(key)는 그 키의 결과(받은 값 또는 같은 오류)를 돌려준다. (export: 회귀 테스트용) */
export function createPrefetch(keys, fetchOne, {
  concurrency = 8, maxAhead = 16, maxBytes = 32 * 2 ** 20, maxInflightBytes = 2 ** 20, soloBytes = 512 * 2 ** 10,
  sizeOf = () => 0, isSlow = () => false,
} = {}) {
  const order = new Map(keys.map((k, i) => [k, i]));
  const slots = new Map(); // 시작했고 아직 꺼내 가지 않은 자리: index → { size, done, ctrl, conc }
  let next = 0; // 다음에 시작할 자리
  let floor = 0; // 이 앞자리는 시작하지 않는다(소비가 지나갔다)
  let inflight = 0, inflightBytes = 0, solo = 0, held = 0, stopped = false, degraded = false;
  let idle = null, stopping = null; // stop() 대기 — 진행 중인 요청이 모두 끝나면 푼다
  const settle = () => { if (inflight === 0 && idle) { idle(); idle = null; } };
  /** 자리를 버린다 — 진행 중이면 멈춘다(그 결과는 아무도 쓰지 않는다). */
  const release = (i, abort = true) => {
    const s = slots.get(i); if (!s) return;
    slots.delete(i); held -= s.size;
    if (abort && !s.settled) s.ctrl.abort();
  };
  const pump = () => {
    while (!stopped && !degraded && inflight < concurrency && slots.size < maxAhead) {
      if (next < floor) next = floor;
      if (next >= keys.length) break;
      const size = sizeOf(keys[next]);
      if (slots.size > 0 && held + size > maxBytes) break; // 앞서 받아 둔 크기 상한 — 비어 있으면 큰 파일 하나는 혼자 받는다
      if (inflight > 0 && (solo > 0 || size > soloBytes || inflightBytes + size > maxInflightBytes)) break; // 지금 받는 크기 상한·큰 파일은 혼자
      const i = next++;
      const isSolo = size > soloBytes;
      held += size; inflight++; inflightBytes += size; if (isSolo) solo++;
      const ctrl = new AbortController();
      const slot = { size, ctrl, conc: concurrency, settled: false };
      slot.done = Promise.resolve()
        .then(() => fetchOne(keys[i], ctrl.signal))
        .then((value) => ({ ok: true, value }), (error) => {
          if (slot.conc > 1 && !ctrl.signal.aborted && isSlow(error)) degrade(i); // 알아챈 그 자리에서 바꾼다 — 다음 받기를 옛 동시 수로 시작하지 않게
          return { ok: false, error };
        })
        .finally(() => { slot.settled = true; inflight--; inflightBytes -= size; if (isSolo) solo--; settle(); pump(); });
      slots.set(i, slot);
    }
  };
  /** take가 직접 받는 한 번 — 진행 중 수에 넣어 미리 받기가 그 사이 동시 상한을 넘겨 시작하지 않게 한다. */
  const direct = async (key) => {
    inflight++;
    try { return await fetchOne(key); } finally { inflight--; settle(); pump(); }
  };
  /** 느린 회선 — 남은 받기는 종전처럼 하나씩(앞서 받기 없이 take가 차례에 직접), 함께 회선을 쓰던 요청은 멈춘다(각자 차례에 다시 받는다). except = 알아챈 자리. */
  const degrade = (except) => {
    if (degraded) return;
    degraded = true; concurrency = 1;
    for (const j of [...slots.keys()]) if (j !== except && !slots.get(j).settled) release(j);
  };
  pump();
  return {
    async take(key) {
      const i = order.get(key);
      if (i === undefined || stopped) return fetchOne(key); // 미리 받기 대상이 아니다 — 종전처럼 바로 받는다
      for (const j of [...slots.keys()]) if (j < i) release(j); // 소비가 건너뛴 자리 — 쓰지 않을 결과는 버린다
      if (floor < i) floor = i;
      pump(); // 앞자리를 비웠으니 이 자리가 아직이면 지금 시작한다
      const slot = slots.get(i);
      floor = i + 1; // 이 자리는 이제 미리 받기가 다시 시작하지 않는다
      if (!slot) return direct(key); // 시작 전이거나(동시 상한) 느린 회선으로 멈춘 자리 — 이 키는 직접 한 번 받는다
      let r = await slot.done;
      release(i, false);
      if (!r.ok && slot.conc > 1 && isSlow(r.error)) { // 여럿이 회선을 나눠 쓰다 시간 초과 — (이미 하나씩으로 바뀌었다) 이 키를 혼자 다시 받는다
        degrade(i);
        r = await direct(key).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
      }
      pump();
      if (!r.ok) throw r.error;
      return r.value;
    },
    /** 새로 시작하지 않고, 진행 중인 요청을 멈추고, 받아 둔 결과를 버린 뒤, 요청이 끝날 때까지 기다린다(사이클이 도중에 보류될 때·루프가 끝날 때). */
    stop() {
      if (!stopping) {
        stopped = true;
        for (const j of [...slots.keys()]) release(j);
        stopping = inflight === 0 ? Promise.resolve() : new Promise((resolve) => { idle = resolve; });
      }
      return stopping;
    },
    get degraded() { return degraded; },
    get stats() { return { inflight, inflightBytes, held, ahead: slots.size, concurrency }; }, // (회귀 테스트용)
  };
}
