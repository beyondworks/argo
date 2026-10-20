// 메신저 v2 화면이 읽는 서버 자료(U6). 실시간·보내기는 연결 상태 기계(src/link/machine.mjs)가 맡고, 여기서는 화면을 열 때·사건이 왔을 때 한 번씩 읽는다(주기 조회 없음).
// 표·RPC 이름: U1(msgr2_spaces·space_members·rooms·room_members·agents·messages·attachments), U2(msgr2_works·approvals, msgr2_work_status·msgr2_work_cancel·msgr2_approval_decide).
const PAGE = 50;

const ok = (r) => { if (r?.error) throw Object.assign(new Error(r.error.message || 'request failed'), { code: r.error.code, status: r.status }); return r?.data ?? null; };

/** 공간 목록 재료: 내 개인 공간 id(없으면 서버가 만든다), 볼 수 있는 공간, 내 멤버십. */
export async function loadSpaces(client, uid) {
  const personalId = ok(await client.rpc('msgr2_my_personal_space'));
  const spaces = ok(await client.from('msgr2_spaces').select('id, kind, name, owner_user_id, deleted_at')) || [];
  const members = ok(await client.from('msgr2_space_members').select('space_id, role, removed_at, expires_at').eq('user_id', uid)) || [];
  return { personalId, spaces, members };
}

/** 공간의 방(보관하지 않은 것)과 방 멤버(사람·에이전트), 그 공간에서 보이는 에이전트. */
export async function loadRooms(client, spaceId) {
  const rooms = ok(await client.from('msgr2_rooms').select('id, space_id, kind, name, pair_key, agent_policy, archived_at, created_at').eq('space_id', spaceId).is('archived_at', null)) || [];
  const ids = rooms.map((r) => r.id);
  const members = ids.length ? ok(await client.from('msgr2_room_members').select('room_id, member_kind, member_id, removed_at').in('room_id', ids).is('removed_at', null)) || [] : [];
  const agentIds = [...new Set(members.filter((m) => m.member_kind === 'agent').map((m) => m.member_id))];
  const agents = agentIds.length ? ok(await client.from('msgr2_agents').select('id, owner_user_id, display_name, slug, role_text, status').in('id', agentIds)) || [] : [];
  return { rooms, members, agents };
}

/** 방 열기: 최근 글(PAGE개, before면 그 앞), 그 글들의 첨부, 그 방의 일·승인. */
export async function loadRoom(client, roomId, { before = null } = {}) {
  let q = client.from('msgr2_messages').select('id, room_id, topic_id, author_kind, author_user_id, author_agent_id, kind, body, meta, reply_to, client_msg_id, work_id, created_at, edited_at, deleted_at').eq('room_id', roomId);
  if (before != null) q = q.lt('id', before);
  const rows = ok(await q.order('id', { ascending: false }).limit(PAGE + 1)) || [];
  const more = rows.length > PAGE;
  const messages = rows.slice(0, PAGE).reverse();
  const mids = messages.map((m) => m.id);
  const attachments = mids.length ? ok(await client.from('msgr2_attachments').select('id, message_id, room_id, name, mime, bytes, storage_path').in('message_id', mids)) || [] : [];
  const { works, approvals } = before == null ? await loadWorks(client, roomId) : { works: [], approvals: [] };
  return { messages, attachments, works, approvals, more };
}

/** 방의 일과 승인(카드). 일은 최근 100개 — 오래된 일은 그 글을 불러올 때 같이 보인다(U6 미룸: 일 페이지). */
export async function loadWorks(client, roomId) {
  const works = ok(await client.from('msgr2_works').select('id, room_id, topic_id, agent_id, owner_user_id, root_user_id, source_message_id, parent_work_id, from_kind, from_id, state, expires_at, lease_until, has_result, late, error_code, created_at, updated_at').eq('room_id', roomId).order('created_at', { ascending: false }).limit(100)) || [];
  const wids = works.map((w) => w.id);
  const approvals = wids.length ? ok(await client.from('msgr2_approvals').select('id, work_id, room_id, action, risk, summary, card_message_id, state, expires_at, decided_by, decided_at, created_at').in('work_id', wids)) || [] : [];
  return { works, approvals };
}

/** 결과 모르는 효과 등 일 하나의 지금 상태(msgr2_work_status). 카드를 펼칠 때만. */
export async function workStatus(client, workId) { return ok(await client.rpc('msgr2_work_status', { p_work: workId })); }
export async function cancelWork(client, workId) { return ok(await client.rpc('msgr2_work_cancel', { p_work: workId })); }
export async function decideApproval(client, approvalId, decision) { return ok(await client.rpc('msgr2_approval_decide', { p_approval: approvalId, p_decision: decision })); }

/** 글 본문의 @이름을 방 에이전트 id로(서버는 방 멤버인 에이전트만 본다, 20개까지). */
export function mentionsOf(body, agents) {
  const text = String(body || '');
  const out = [];
  for (const a of agents) {
    const names = [a.display_name, a.slug].filter(Boolean);
    if (names.some((n) => new RegExp(`(^|\\s)@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|\\s|[.,!?])`, 'u').test(text))) out.push(a.id);
  }
  return [...new Set(out)].slice(0, 20);
}
