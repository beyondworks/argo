// 주인에게 보이는 '관리자가 내보냄' 안내(U2 G3·G4, 2026-10-14). 기록 정본은 서버 msgr_crew_dispatch_log(사람이 누를 때만 1행).
// 카드를 열 때 한 번만 읽는다 — 주기 조회 없음. 표가 없는 옛 서버(PGRST205·42P01)나 읽기 거절이면 안내를 그리지 않는다.
export const ADMIN_REMOVED_DAYS = 7;

export function adminRemovedNotice(row, { now = Date.now(), days = ADMIN_REMOVED_DAYS, channelName = null } = {}) {
  if (!row || row.event !== 'removed_by_admin' || !row.at) return null;
  const at = Date.parse(row.at);
  if (!Number.isFinite(at) || now - at > days * 86_400_000) return null;
  return { key: channelName ? 'crew.removedByAdmin' : 'crew.removedByAdmin.noName', channel: channelName, at: row.at };
}

export async function readAdminRemoved(supabase, crewId) {
  const r = await supabase.from('msgr_crew_dispatch_log').select('channel_id, event, at').eq('crew_id', crewId).eq('event', 'removed_by_admin').order('at', { ascending: false }).limit(1);
  if (r.error || !r.data?.length) return null;
  const row = r.data[0];
  const ch = await supabase.from('msgr_channels').select('name, kind').eq('id', row.channel_id).limit(1);
  const c = !ch.error && ch.data?.[0];
  return { row, channelName: c ? `${c.kind === 'private' ? '' : '#'}${c.name}` : null };
}
