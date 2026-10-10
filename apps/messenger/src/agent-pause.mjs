// 무료 계정 에이전트가 멈춘 이유 안내(유건 2026-10-11 — 서버 msgr_my_agent_pause, 마이그레이션 20261011120000).
// 무료 계정은 최신 Argo 앱이 켜져 있을 때 에이전트 4명까지 메신저에 연결된다. 멈춘 에이전트는 목록에서 빠지므로(#941 그대로) 목록이 비거나 줄어든 이유를 한 줄로 보인다.
// 읽기: 로그인·재연결(syncEpoch) 때 1건 + 폰 에이전트 탭에 들어갈 때 1건(주기 호출 없음). 옛 서버(함수 없음)·일시 오류면 안내 없음.
export async function readAgentPause(db) {
  try {
    const { data, error } = await db.rpc('msgr_my_agent_pause');
    return error ? null : (data ?? null);
  } catch { return null; }
}

/** 안내 한 줄 — { key, vars } 또는 null. 이유: app(옛 앱 — 업데이트 안내) · off(최신 앱이 꺼져 있음) · limit(4명 다 참 — Pro 안내). 멈춘 에이전트가 없으면 안내하지 않는다 */
export function agentPauseNote(info) {
  if (!info || !(Number(info.paused) > 0)) return null;
  const key = { app: 'agents.pause.app', off: 'agents.pause.off', limit: 'agents.pause.limit' }[info.reason];
  return key ? { key, vars: { n: Number(info.paused), limit: Number(info.limit) || 4 } } : null;
}
