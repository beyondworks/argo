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

export function mergeRefreshedMessages(current, fresh, firstId, throughId) {
  const first = BigInt(firstId ?? 0); const last = BigInt(throughId ?? 0);
  return [...current.filter(m => BigInt(m.id) < first), ...fresh, ...current.filter(m => BigInt(m.id) > last)];
}
