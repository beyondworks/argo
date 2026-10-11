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

/* ───────── 멈춘 에이전트의 이름·얼굴(2026-10-11 '?' 제보) ─────────
 * #941 뒤 무료 계정 에이전트 행은 status='paused'로 남는다. 메신저가 active·available만 읽어 그 에이전트와의 1:1 방 이름이 'dm:?',
 * 방 머리가 '?', 글쓴이가 '에이전트'로 보였다. 표시(이름·얼굴·글쓴이)에는 paused 행도 쓰고, 연결 판단(목록·숫자·멘션·초대·결재 대상·턴)은 지금처럼 active만 쓴다.
 * 조회는 같은 요청에 상태 하나만 더한다(요청 수·주기 그대로 — DB 위생). detached(빠진 에이전트)는 읽지 않는다. */
export const SPACE_CREW_STATUSES = ['active', 'available', 'paused'];

/** 공간 크루 행 나누기 — connected: 연결(active) · available: 내가 꺼 둔(파견 해제) 것 · paused: 멈춘 것 · shown: 이름 찾기용(셋 다, 입력 순서) */
export function splitSpaceCrews(rows, uid) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    connected: list.filter((r) => r?.status === 'active'),
    available: list.filter((r) => r?.status === 'available' && r.owner_user_id === uid),
    paused: list.filter((r) => r?.status === 'paused'),
    shown: list.filter((r) => SPACE_CREW_STATUSES.includes(r?.status)),
  };
}

/** 표시용 찾기 — 연결 판단용 찾기(crewOf)가 모르면 멈춘 행에서. 이름·얼굴·글쓴이·소유자(누가 주인인가) 자리에만 쓴다 */
export function withPaused(crewOf, paused) {
  return (id) => crewOf(id) ?? (paused ?? []).find((c) => c.id === id);
}

/** 1:1 방 머리의 '멈춤' 표시 — 방에 든 에이전트가 한 명이고, 그 에이전트가 연결돼 있지 않고 멈춰 있을 때 그 행. 아니면 null */
export function pausedRoomCrew(channel, roomMembers, { connected = [], paused = [] } = {}) {
  if (channel?.kind !== 'dm') return null;
  const ids = (roomMembers ?? []).filter((m) => m.member_kind === 'crew').map((m) => m.member_id);
  if (ids.length !== 1 || connected.some((c) => c.id === ids[0])) return null;
  return paused.find((c) => c.id === ids[0]) ?? null;
}
