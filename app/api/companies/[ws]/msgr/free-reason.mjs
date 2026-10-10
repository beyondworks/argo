// 무료 계정이 연결한 에이전트가 멈춘 채 남았을 때 이유 고르기(유건 2026-10-11 — 서버 msgr_my_agent_pause, 마이그레이션 20261011120000).
// route.js(설정 카드의 연결)가 쓴다. 이 화면은 최신 앱 자신이다 — 서버가 이 기기의 새 앱 심박을 아직 못 받았으면(옛 앱이 브리지를 꺼 둔 회사)
// 심박 한 번(beatNow)을 보내고 다시 본다. 첫 새 앱 심박이 그 자리에서 주인의 멈춘 에이전트를 재개한다(전부 멈춘 상태면 최근 대화 순 4명).
// 옛 서버(함수 없음)면 종전 판정(is_pro → msgr_pro_required).
export const FREE_REASON_CODE = { limit: 'msgr_free_agent_limit', app: 'msgr_app_update_required', off: 'msgr_app_update_required' };

/** → { code: apimsg 코드 | null, beaten: 심박을 보냈나(보냈으면 부르는 쪽이 행을 다시 읽는다) } */
export async function freeAgentReason(client, { beatNow = async () => false } = {}) {
  const read = async () => { const { data, error } = await client.rpc('msgr_my_agent_pause'); return error ? null : (data ?? null); };
  let info = await read();
  if (!info) { const { data: pro, error } = await client.rpc('is_pro'); return { code: !error && pro === false ? 'msgr_pro_required' : null, beaten: false }; }
  let beaten = false;
  if (info.reason === 'app' || info.reason === 'off') {
    beaten = await beatNow().catch(() => false);
    if (beaten) info = (await read()) ?? info;
  }
  return { code: FREE_REASON_CODE[info.reason] ?? null, beaten };
}
