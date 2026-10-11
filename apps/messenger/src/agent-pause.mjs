// 무료 계정 에이전트가 멈춘 이유 안내(유건 2026-10-11 — 서버 msgr_my_agent_pause, 마이그레이션 20261011120000).
// 무료 계정은 최신 Argo 앱이 켜져 있을 때 에이전트 4명까지 메신저에 연결된다. 멈춘 에이전트는 목록에서 빠지므로(#941 그대로) 목록이 비거나 줄어든 이유를 한 줄로 보인다.
// 읽기: 로그인·재연결(syncEpoch) 때 1건 + 폰 에이전트 탭에 들어갈 때 1건(주기 호출 없음). 옛 서버(함수 없음)·일시 오류면 안내 없음.
export async function readAgentPause(db) {
  try {
    const { data, error } = await db.rpc('msgr_my_agent_pause');
    return error ? null : (data ?? null);
  } catch { return null; }
}

/** 안내 한 줄 — { key, vars } 또는 null. 이유: app(옛 앱 — 업데이트 안내) · off(최신 앱이 꺼져 있음) · limit(4명 다 참 — Pro 안내, iOS는 사실만). 멈춘 에이전트가 없으면 안내하지 않는다.
    ios — iOS 빌드(platform.js isIos): 결제를 권하는 문장을 뺀 문구(App Store 3.1.1, #944와 같은 원칙) */
export function agentPauseNote(info, { ios = false } = {}) {
  if (!info || !(Number(info.paused) > 0)) return null;
  const key = { app: 'agents.pause.app', off: 'agents.pause.off', limit: ios ? 'agents.pause.limit.ios' : 'agents.pause.limit' }[info.reason];
  return key ? { key, vars: { n: Number(info.paused), limit: Number(info.limit) || 4 } } : null;
}

/** 교체 안내(검수 #945 MEDIUM-1) — 무료 계정 4명이 찬 상태에서 연결하면 서버가 가장 오래 대화하지 않은 에이전트를 멈추고 연결한다.
    방금 연결한 에이전트 때문에 멈춘 에이전트 이름들(서버 msgr_agent_swap_notes, 5분 안). 연결 직후 한 번만 부른다. 옛 서버·오류면 빈 목록. */
export async function readSwapNames(db, crewIds) {
  try {
    if (!crewIds?.length) return [];
    const { data, error } = await db.rpc('msgr_agent_swap_notes', { p_crews: crewIds });
    return error ? [] : [...new Set((data ?? []).map((r) => r.victim_name).filter(Boolean))];
  } catch { return []; }
}
