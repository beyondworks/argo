// 메신저 v2 — 내가 결정할 결재 대기 목록(UX 정리 P1, 2026-10-22). 폰 결재 카드·결재 페이지·채팅 탭 맨 위·데스크톱 결재 단추가 같은 목록을 쓴다.
// v2 셸에서는 옛 표(msgr_crew_approvals)를 v2 연결기가 'none'(빈 결과)으로 돌려 결재 카드가 늘 "없음"이었다 — 그 자리를 이 목록이 채운다.
// 읽기만 한다(새 RPC·쓰기 없음): 내가 주인인 결재 대기 일(msgr2_works) → 그 일의 대기 결재(msgr2_approvals) → 방·공간. RLS는 기존 msgr2_access(room).read.
// 결정할 수 있는지는 방 안 일 카드와 같은 판정(work-card.mjs workCard().canDecide — 서버 msgr2_approval_decide와 같은 조건)으로 고른다.
import { workCard } from './work-card.mjs';

const AP_COLS = 'id, work_id, room_id, action, risk, summary, card_message_id, state, expires_at, decided_by, decided_at, created_at';
const WORK_COLS = 'id, room_id, topic_id, agent_id, owner_user_id, root_user_id, source_message_id, state, expires_at, lease_until, has_result, late, error_code, created_at, updated_at';
const ok = (r) => { if (r?.error) throw Object.assign(new Error(r.error.message || 'request failed'), { code: r.error.code, status: r.status }); return r?.data ?? null; };

/** 서버 자료. 결재 대기 일이 없으면 요청 1번으로 끝난다(있으면 결재·방·공간 3번 더). 주기 조회 없음 — 화면을 열 때·결재 사건 때만 부른다. */
export async function loadMyApprovals(client, uid) {
  const empty = { works: [], approvals: [], rooms: [], spaces: [] };
  if (!uid) return empty;
  const works = ok(await client.from('msgr2_works').select(WORK_COLS).eq('owner_user_id', uid).eq('state', 'awaiting_approval').order('created_at', { ascending: false }).limit(40)) || [];
  if (!works.length) return empty;
  const approvals = ok(await client.from('msgr2_approvals').select(AP_COLS).in('work_id', works.map((w) => w.id)).eq('state', 'pending')) || [];
  if (!approvals.length) return { ...empty, works };
  const roomIds = [...new Set(works.map((w) => w.room_id))];
  const rooms = ok(await client.from('msgr2_rooms').select('id, space_id, kind, name').in('id', roomIds)) || [];
  const spaceIds = [...new Set(rooms.map((r) => r.space_id))];
  const spaces = spaceIds.length ? ok(await client.from('msgr2_spaces').select('id, kind, name').in('id', spaceIds)) || [] : [];
  return { works, approvals, rooms, spaces };
}

/**
 * 화면 줄(옛 loadApprovals 줄 모양) — 결정할 수 있는 결재만, 최신이 위.
 * org_id는 팀 공간이면 공간 id, 개인 공간이면 null(공간 이름을 붙이지 않는다). v2 = true가 결정 경로(msgr2_approval_decide)를 고른다.
 */
export function myApprovalItems({ works = [], approvals = [], rooms = [], spaces = [], uid, now = Date.now() } = {}) {
  const roomOf = new Map(rooms.map((r) => [r.id, r])); const spaceOf = new Map(spaces.map((s) => [s.id, s]));
  const out = [];
  for (const w of works) {
    const ap = approvals.filter((a) => a.work_id === w.id).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (!ap || !workCard({ work: w, approval: ap, uid, now }).canDecide) continue;
    const sp = spaceOf.get(roomOf.get(w.room_id)?.space_id);
    out.push({ key: `v2ap:${ap.id}`, kind: 'approval', v2: true, id: ap.id, workId: w.id, apKind: 'action', status: 'pending',
      org_id: sp && sp.kind !== 'personal' ? sp.id : null, channel_id: w.room_id, crew_id: w.agent_id,
      action: ap.action, reason: ap.summary, risk: ap.risk, payload: null, at: ap.created_at, crewOwnerId: w.owner_user_id, policy: null });
  }
  return out.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

/** 'works' 사건(일 표지)을 받았을 때 결재 목록을 다시 읽을지 — 결재 대기로 바뀐 내 일이 있거나, 지금 목록에 있는 일이 바뀌었을 때만(그 밖의 일 사건은 요청 0). */
export function approvalsNeedReload(incoming = [], items = [], uid) {
  const listed = new Set(items.filter((it) => it.v2).map((it) => it.workId));
  return incoming.some((w) => listed.has(w.id) || (w.state === 'awaiting_approval' && (w.owner_user_id == null || w.owner_user_id === uid)));
}
