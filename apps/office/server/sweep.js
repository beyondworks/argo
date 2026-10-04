// 오피스 저장소 서버 정리(분리 검수 MEDIUM 1) — 화면을 아무도 열지 않아도 휴지통 30일 파일·만료된 올리기 자리·등록 안 된 객체가 R2에 쌓이지 않게.
// 순서: office_storage_sweep(휴지통 30일 기록 삭제 + 대상 객체를 deleting으로 + 지울 키 목록) → R2 삭제(동시 8개) → r2_object_forget(지운 키의 행만).
// 지우지 못한 키는 행이 deleting으로 남아 다음 날 다시 지운다(파일 기록을 잃지 않고, 객체만 남는 일도 없게). R2 DeleteObject는 무료 동작이다.
// 부르는 곳: api/files/[op].js sweep(Vercel 크론, vercel.json — 하루 1회) · scripts/files-sweep.mjs(서버·VPS cron에서 직접).
// 부하: 하루 1회 — RPC 2 + 지울 객체 수만큼 R2 DELETE(한 번에 최대 limit개). 키·서명은 로그에 남기지 않는다(개수만).
import { eachLimited } from './r2.js';

const fail = (code) => Object.assign(new Error(code), { code });

/** { url: Supabase 주소, key: 서비스 키, r2: r2Client } → { objects(지운 수), left(못 지운 수), rows(지운 행 수) } */
export async function sweepStorage({ url, key, r2, limit = 500 }, fetchImpl = fetch) {
  if (!url || !key || !r2) throw fail('not_configured');
  const base = String(url).replace(/\/$/, '');
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const rpc = async (fn, body) => {
    const r = await fetchImpl(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw fail('db');
    return r.json();
  };
  const out = await rpc('office_storage_sweep', { p_limit: limit });
  const keys = (out?.keys ?? []).filter((k) => typeof k === 'string' && k);
  const done = await eachLimited(keys, 8, (k) => r2.del(k));
  const gone = keys.filter((k) => done.get(k));
  const rows = gone.length ? await rpc('r2_object_forget', { p_keys: gone }) : 0;
  return { objects: gone.length, left: keys.length - gone.length, rows: Number(rows) || 0, links: Number(out?.links) || 0 }; // links: 지운 만료·끊은 공유 링크 행(15차)
}
