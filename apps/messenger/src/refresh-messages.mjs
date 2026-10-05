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
    const got = await fetchPage(cursor, pageSize);
    rows.push(...got);
    if (got.length < pageSize) return { rows, more: false };
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
