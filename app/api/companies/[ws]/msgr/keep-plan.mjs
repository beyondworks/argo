// 무료 계정이 유지할 에이전트 적용 — 라우트(keep 갈래)의 판정만 떼어 낸 순수 함수(분리 검수 L6: 소스 문자열이 아니라 행동으로 시험한다).
// 입력: keep = ['회사:이름', …], add = 연결 흐름에서 이 조직에 새로 연결하려는 slug, ws, personal, orgId, agents = 이 회사 에이전트 카드,
//       existing = 이 조직에 이미 있는 내 행 slug 집합(개인 공간이면 무시), scope = 이 범위(조직 또는 개인 공간)의 내 행(id·slug·status)
// 출력: { error } 또는 { keys, inserts: [slug], act: [행 id] }
//   - 새로 넣는 행 = add ∩ 고른 이 회사 에이전트 ∖ 이미 있는 행 — '유지할 에이전트 바꾸기'(add 없음)는 새 조직 등록을 만들지 않는다(L2). 개인 공간은 넣지 않는다(미러가 만든다)
//   - 카드 확인은 새로 넣는 것만 — 지운 에이전트의 남은 행은 '유지'할 수 있다(L1)
//   - 함께 연결할 파견 해제(available) 행 = add에 든 것만 — 사람이 해제한 행을 '바꾸기'가 켜지 않는다
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KEEP_MAX_KEYS = 20;

export function keepPlan({ keep, add = [], ws, personal = false, orgId = null, agents = [], existing = new Set(), scope = [] }) {
  const keys = [...new Set((Array.isArray(keep) ? keep : []).filter((k) => typeof k === 'string' && /^[^:]+:[^:]+$/.test(k)))];
  if (!keys.length || keys.length > KEEP_MAX_KEYS || (!personal && !UUID.test(String(orgId ?? '')))) return { error: 'msgr_bad_request' };
  const here = keys.filter((k) => k.startsWith(`${ws}:`)).map((k) => k.slice(ws.length + 1));
  const adds = Array.isArray(add) ? here.filter((s) => add.includes(s)) : [];
  const known = new Set(agents.map((a) => a.slug));
  const inserts = personal ? [] : adds.filter((s) => !existing.has(s));
  if (inserts.some((s) => !known.has(s))) return { error: 'msgr_crew_not_found' };
  const act = scope.filter((r) => adds.includes(r.slug) && r.status === 'available').map((r) => r.id);
  return { keys, inserts, act };
}
