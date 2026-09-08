// 동시 실행 상한 — 회의실 동시 발언(room.mjs)과 크루 우편 동시 배달(crewmail.mjs)이 같은 실행기를 쓴다.
// crewmail이 room.mjs를 임포트하면 room → chat → …의 무거운 순환이 생기므로 여기로 뺐다(room.mjs는 재수출해 기존 소비자를 지킨다).

/** items를 limit개씩 동시에, 순서대로 착수. 결과는 {ok, v|e}로 정착(한 항목의 실패가 나머지를 끊지 않는다). */
export async function runLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
