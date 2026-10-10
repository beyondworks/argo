// msgr-storage-sweep — 메신저 저장소 정리(20261011150000 5절). pg_cron(msgr-storage-sweep, 1시간마다) → msgr_storage_sweep_kick() → 여기.
// 후보(방이 없는 msgr 객체, 24시간 넘게 첨부 행이 없는 객체)를 DB 함수 msgr_storage_sweep_list(서비스 역할 전용)로 받아 Storage API로 지운다 —
// SQL로 storage.objects 행만 지우면 저장소 바이트가 남는다. kick이 후보가 있을 때만 부르므로 유휴 시 호출 0.
// 호출 인증: Authorization: Bearer MSGR_STORAGE_SWEEP_SECRET(엣지 시크릿 = msgr_settings.storage_sweep_secret). 시크릿이 없으면 500(닫힘).
// 배포: verify_jwt 끔(pg_cron은 사용자 JWT가 없다 — 위 비밀로 막는다). 한 번에 최대 10 × 200개.
import { runSweep, sameSecret } from './core.js';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method', { status: 405 });
  const secret = Deno.env.get('MSGR_STORAGE_SWEEP_SECRET');
  if (!secret) return new Response('sweep not configured', { status: 500 });
  if (!(await sameSecret(req.headers.get('authorization') ?? '', `Bearer ${secret}`))) return new Response('unauthorized', { status: 401 });
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const H = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  const list = async (n: number) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/msgr_storage_sweep_list`, { method: 'POST', headers: H, body: JSON.stringify({ p_limit: n }) });
    if (!r.ok) throw new Error(`list ${r.status}`);
    const rows = await r.json();
    return (Array.isArray(rows) ? rows : []).map((x: unknown) => (typeof x === 'string' ? x : (x as Record<string, string>)?.msgr_storage_sweep_list)).filter(Boolean);
  };
  const remove = async (names: string[]) => {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/msgr`, { method: 'DELETE', headers: H, body: JSON.stringify({ prefixes: names }) });
    if (!r.ok) throw new Error(`remove ${r.status}`);
  };
  try {
    const out = await runSweep({ list, remove });
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e).slice(0, 200) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
