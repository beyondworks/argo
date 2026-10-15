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
 * 개인 공간: msgr_personal_room_crews가 원래 paused 행을 준다(버리지 않을 뿐 — 요청 그대로).
 * 조직 공간: 목록 조회(loadOrg — 열기·복귀·재연결·새로고침마다)는 active·available 그대로 둔다(전송량, #950 분리 검수). 이름이 필요한 모르는 id만
 *   readPausedCrewNames로 따로 한 번 읽어 세션 동안 기억한다(crewNameAsker — 사람 이름 askName → flushNames와 같은 방식, 계산 열 없음). */
export const SPACE_CREW_STATUSES = ['active', 'available', 'paused']; // 나누기 기준(조직 목록 조회에는 쓰지 않는다)

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
export function withPaused(crewOf, paused, onMiss = null) {
  return (id) => { const c = crewOf(id) ?? (paused ?? []).find((x) => x.id === id); if (!c && id && onMiss) onMiss(id); return c; };
}

/** 이름 조회 열 — 계산 열(접속 시각 msgr_crew_seen)·명령 목록 없이 표시에 필요한 것만 */
export const CREW_NAME_COLS = 'id, owner_user_id, display_name, role_text, status, face, avatar_url';
/** 모르는 크루 id의 표시용 행 — 멈춘(paused) 행만 돌려준다(빠진 detached 등은 종전대로 대체 문구). 옛 서버(face 열 없음)면 face 없이 한 번 더. 오류·던짐이면 [] */
/** 한 요청에 싣는 id 수 — uuid 100개 ≈ URL 4KB(서버 URL 한도 8~16KB 안쪽) */
export const CREW_NAME_CHUNK = 100;
export async function readPausedCrewNames(db, ids) {
  const out = [];
  for (let i = 0; i < (ids?.length ?? 0); i += CREW_NAME_CHUNK) {
    const part = ids.slice(i, i + CREW_NAME_CHUNK);
    try {
      let r = await db.from('msgr_crews').select(CREW_NAME_COLS).in('id', part);
      if (r.error && /face/i.test(r.error.message ?? '')) r = await db.from('msgr_crews').select(CREW_NAME_COLS.replace(', face', '')).in('id', part);
      if (!r.error) out.push(...(r.data ?? []).filter((c) => c?.status === 'paused'));
    } catch { /* 이 묶음만 건너뛴다 */ }
  }
  return out;
}
/** 모르는 크루 id를 모아 한 번에 묻는다 — 같은 id는 세션 동안 다시 묻지 않는다(답이 비거나 실패해도). schedule은 다음 틱에 flush를 부른다 */
export function crewNameAsker(read, onRows, schedule = (f) => setTimeout(f, 0)) {
  const asked = new Set(); let wanted = new Set(); let timer = false;
  const flush = () => {
    timer = false;
    const ids = [...wanted].filter((id) => !asked.has(id)); wanted = new Set(); if (!ids.length) return;
    ids.forEach((id) => asked.add(id));
    Promise.resolve().then(() => read(ids)).then((rows) => { if (rows?.length) onRows(rows); }, () => {});
  };
  return {
    ask(id) { if (!id || asked.has(id) || wanted.has(id)) return; wanted.add(id); if (!timer) { timer = true; schedule(flush); } },
    asked,
  };
}

/** 1:1 방 머리의 '멈춤' 표시 — 방에 든 에이전트가 한 명이고, 그 에이전트가 연결돼 있지 않고 멈춰 있을 때 그 행. 아니면 null */
export function pausedRoomCrew(channel, roomMembers, { connected = [], paused = [] } = {}) {
  if (channel?.kind !== 'dm') return null;
  const ids = (roomMembers ?? []).filter((m) => m.member_kind === 'crew').map((m) => m.member_id);
  if (ids.length !== 1 || connected.some((c) => c.id === ids[0])) return null;
  return paused.find((c) => c.id === ids[0]) ?? null;
}

/** 멈춘 에이전트가 든 방의 안내(2026-10-15 — 운영 실측: 답 없는 개인 1:1 5건이 모두 멈춘 에이전트, 글은 저장되지만 답도 안내도 없었다).
    roomCrewIds = 방의 에이전트 구성원 id. people = 방의 사람 수(나 포함). pause = msgr_my_agent_pause 결과(readAgentPause — 없으면 null).
    → null(멈춘 에이전트 없음) 또는 { crews, block, solo, head, reason, action }.
    block — 나와 내 멈춘 에이전트 둘뿐인 1:1이면 보내기를 막는다(입력창 자리에 안내 — 보관한 1:1과 같은 자리). solo인데 남의 에이전트면 입력창 위 머리 줄만.
    사람이 더 있는 방은 이번에 그리지 않는다(채널 안내는 다음 발행).
    reason — 내 에이전트일 때만 계정 이유(agentPauseNote와 같은 문구). action — 'runner'(실행기 켜기·업데이트) · null */
export function pausedRoomNotice({ channel, roomCrewIds = [], connected = [], paused = [], people = 0, uid = null, pause = null, ios = false } = {}) {
  if (!channel) return null;
  const ids = [...new Set(roomCrewIds ?? [])];
  const crews = ids.filter((id) => !connected.some((c) => c.id === id)).map((id) => paused.find((c) => c.id === id)).filter(Boolean);
  if (!crews.length) return null;
  const mine = crews.every((c) => c.owner_user_id === uid);
  const solo = channel.kind === 'dm' && ids.length === 1 && people <= 1; // 나와 그 에이전트 둘뿐인 1:1
  const block = mine && solo; // 남의 에이전트는 막지 않는다 — 다시 켜져도 crew_sync가 주인에게만 가서 이 화면이 풀리지 않는다(검수 #1032). 머리 줄만 보인다
  const head = { key: crews.length === 1 ? 'agents.paused.room' : 'agents.paused.room.many', vars: { name: crews.map((c) => c.display_name).join(', ') } };
  const note = mine ? agentPauseNote(pause, { ios }) : null;
  const action = note && pause.reason !== 'limit' ? 'runner' : null; // 실행기 꺼짐·옛 실행기 — 실행기 단추. 무료 한도의 [바꾸기]는 다음 발행(2026-10-15 범위 축소)
  return { crews, block, solo, head, reason: note, action };
}
