// 오피스 저장소 서버 정리(분리 검수 MEDIUM 1) — 화면을 아무도 열지 않아도 행 없는 객체·휴지통 30일 파일이 쌓이지 않게.
// 순서: office_storage_sweep(지울 목록 + 지난 자리·OCR 한도 줄 정리) → 버킷별 Storage API 삭제 → office_storage_sweep_done(객체가 없어진 행만 삭제).
// Storage 객체는 SQL로 지우지 않는다(Supabase는 Storage API로만) — 그래서 pg_cron만으로는 끝나지 않고 서비스 키를 가진 서버가 돈다.
// 부르는 곳: api/files/[op].js sweep(Vercel 크론, vercel.json — 하루 1회) · scripts/files-sweep.mjs(서버·VPS cron에서 직접).
// 부하: 하루 1회 — RPC 2 + 버킷별 삭제 요청(한 번에 최대 500개). 객체 원문·경로는 로그에 남기지 않는다(개수만).
const fail = (code) => Object.assign(new Error(code), { code });

/** { url: Supabase 주소, key: 서비스 키 } → { objects, rows } */
export async function sweepStorage({ url, key, limit = 500 }, fetchImpl = fetch) {
  if (!url || !key) throw fail('not_configured');
  const base = String(url).replace(/\/$/, '');
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const rpc = async (fn, body) => {
    const r = await fetchImpl(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw fail('db');
    return r.json();
  };
  const list = (await rpc('office_storage_sweep', { p_limit: limit }))?.objects ?? [];
  const byBucket = new Map();
  for (const o of list) if (['office-files', 'office-docs'].includes(o?.bucket) && typeof o.name === 'string' && o.name) byBucket.set(o.bucket, [...(byBucket.get(o.bucket) ?? []), o.name]);
  for (const [bucket, names] of byBucket) {
    for (let i = 0; i < names.length; i += 500) {
      const r = await fetchImpl(`${base}/storage/v1/object/${bucket}`, { method: 'DELETE', headers, body: JSON.stringify({ prefixes: names.slice(i, i + 500) }) });
      if (!r.ok) throw fail('storage'); // 지우지 못했으면 행 정리를 부르지 않는다(다음 날 다시)
    }
  }
  const done = await rpc('office_storage_sweep_done', {});
  return { objects: list.length, rows: done?.rows ?? 0 };
}
