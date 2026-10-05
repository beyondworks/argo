export async function refreshMessageWindow({ firstId, throughId, pageSize, fetchPage }) {
  if (throughId == null) return [];
  let cursor = firstId == null ? '0' : String(BigInt(firstId) - 1n);
  const rows = [];
  while (BigInt(cursor) < BigInt(throughId)) {
    const page = await fetchPage(cursor, throughId, pageSize);
    if (!page.length) break;
    const next = page.at(-1).id;
    if (BigInt(next) <= BigInt(cursor)) throw new Error('Refresh cursor did not advance');
    rows.push(...page); cursor = String(next);
    if (page.length < pageSize) break;
  }
  return rows;
}

/** 끊긴 동안·가려진 동안 쌓인 글 따라잡기(afterId 뒤, 오래된 것부터). 한 쪽(pageSize)만 읽으면 100개에서 멈춰 최신 글이 안 보였다(MSG-02).
    쪽이 꽉 차면 마지막 id 뒤를 이어 읽고, maxPages쪽을 읽고도 남았으면 more=true — 부르는 쪽은 최신 쪽으로 옮기고 사이는 이전 기록 불러오기에 맡긴다.
    평소(쪽이 덜 참)는 요청 한 번이라 글 방송마다 부르는 경로의 호출 수는 그대로다. */
export async function readMissed({ afterId, pageSize, maxPages = 5, fetchPage }) {
  const rows = []; let cursor = afterId;
  for (let page = 0; page < maxPages; page++) {
    const last = page === maxPages - 1; // 마지막 쪽은 하나 더 물어 남은 글이 있는지 본다 — 정확히 상한만큼 밀렸을 때 다 읽고도 버리던 것(검수 L3)
    const got = await fetchPage(cursor, last ? pageSize + 1 : pageSize);
    if (last && got.length > pageSize) return { rows: [...rows, ...got.slice(0, pageSize)], more: true };
    rows.push(...got);
    if (got.length < pageSize || last) return { rows, more: false };
    const next = got.at(-1).id;
    if (BigInt(next) <= BigInt(cursor)) throw new Error('Catch-up cursor did not advance');
    cursor = next;
  }
  return { rows, more: true };
}

export function mergeRefreshedMessages(current, fresh, firstId, throughId) {
  const first = BigInt(firstId ?? 0); const last = BigInt(throughId ?? 0);
  return [...current.filter(m => BigInt(m.id) < first), ...fresh, ...current.filter(m => BigInt(m.id) > last)];
}

/** 따라잡기를 한 번에 하나로(검수 L3 — 글 방송마다 부르는 조회가 겹쳐 같은 글을 여러 번 읽고, 500개 넘게 밀리면 '최신으로 옮겼다' 안내가 겹친 수만큼 떴다).
    도는 중에 온 요청은 끝난 뒤 한 번으로 모은다(그 사이 온 글을 놓치지 않게). 돌려준 함수는 지금 도는 따라잡기의 약속을 돌려준다. */
export function createCatchUp(run) {
  let busy = null; let again = false;
  return function catchUp() {
    if (busy) { again = true; return busy; }
    busy = (async () => { try { do { again = false; await run(); } while (again); } finally { busy = null; } })();
    return busy;
  };
}
