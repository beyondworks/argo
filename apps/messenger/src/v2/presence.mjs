// 메신저 v2 에이전트 접속 표시(2026-10-25 메신저 0.1.65 결함 2 근본 수정) — 본체가 v2:pr:<주인>에 track한 상태를 화면의 켜짐으로 바꾼다.
// 본체 한 대 = Presence key 하나(기기 id), 값 { v: 1, agents: [에이전트 id] }. 같은 주인의 기기 여럿은 합친다. DB 요청 없음(Realtime Presence).
// 옛 본체(track 없음)와 섞이면 그 주인의 채널은 비어 있다 — 비어 있어도 '꺼짐'이 아니라 '모름'으로 본다(personal-bots.mjs crewPresence).

/** 화면이 동시에 듣는 주인 채널 상한 — 내 에이전트 주인(나) 먼저, 나머지는 보이는 목록 순. */
export const PRESENCE_OWNERS_MAX = 12;

/** presenceState() → 켜진 에이전트 id 집합. 모양이 다른 값(옛 본체·다른 약속)은 버린다. */
export function presenceAgents(state) {
  const out = new Set();
  for (const metas of Object.values(state ?? {})) {
    for (const m of Array.isArray(metas) ? metas : []) {
      if (m?.v !== 1 || !Array.isArray(m.agents)) continue;
      for (const id of m.agents.slice(0, 500)) if (typeof id === 'string' && id) out.add(id);
    }
  }
  return out;
}

/** 들을 주인 목록 — v2 에이전트 행의 주인(중복 없음), 나 먼저, 상한. */
export function presenceOwners(rows, uid, max = PRESENCE_OWNERS_MAX) {
  const seen = new Set(); const out = [];
  const add = (o) => { if (o && !seen.has(o) && out.length < max) { seen.add(o); out.push(o); } };
  if ((rows ?? []).some((r) => r?._v2 && r.owner_user_id === uid)) add(uid);
  for (const r of rows ?? []) if (r?._v2) add(r.owner_user_id);
  return out;
}
