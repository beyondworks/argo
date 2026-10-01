// 사람 이름 규칙(점검 A·B #3) — 서버 규칙(msgr_person_label)과 같은 순서: 조직 안 이름 → 프로필 이름 → 이메일 앞부분.
// 조직 구성원 목록(removed_at null)에 없는 사람의 이름을 따로 조회한다: 조직을 나간 사람의 옛 글·활동 기록의 작성자.
// 그 사람은 나간 뒤 같은 방에도 없어 서버 이름 조회(msgr_people_names: 나·친구·같은 방 사람만)가 비어 돌아올 수 있다 —
// 그래서 조직 안 이름은 나간 사람의 행에서도 읽는다(조직 구성원이면 나간 행도 읽힌다, RLS msgr_members_select).

const CHUNK = 200; // msgr_people_names가 한 번에 받는 최대 수
const present = (v) => typeof v === 'string' && v.trim() !== '';

/** ids → { id: 이름 } — 못 찾은 id는 키가 없다. 같은 id는 한 번만 묻는다. */
export async function resolvePeopleNames(sb, { orgId, ids }) {
  const out = {};
  let left = [...new Set(ids.filter(Boolean))];
  if (!left.length) return out;
  if (orgId) {
    const res = await sb.from('msgr_org_members').select('user_id, display_name').eq('org_id', orgId).in('user_id', left).then((r) => r, () => ({ data: null }));
    for (const r of res?.data ?? []) if (present(r.display_name)) out[r.user_id] = r.display_name.trim();
    left = left.filter((id) => !(id in out));
  }
  for (let i = 0; i < left.length; i += CHUNK) {
    const chunk = left.slice(i, i + CHUNK);
    const res = await sb.rpc('msgr_people_names', { ids: chunk }).then((r) => r, () => ({ error: true }));
    if (!res.error) { for (const r of res.data ?? []) if (present(r.name)) out[r.user_id] = r.name; continue; }
    // 옛 서버(함수 없음) — 프로필 이름으로 물러난다
    const prof = await sb.from('msgr_profiles').select('user_id, display_name').in('user_id', chunk).then((r) => r, () => ({ data: null }));
    for (const r of prof?.data ?? []) if (present(r.display_name)) out[r.user_id] = r.display_name;
  }
  return out;
}

/** 화면에 쓸 사람 이름 — id 앞 8자리는 보이지 않는다. 끝내 모르면 left(나간 사용자), 작성자 id가 없으면(계정 삭제) deleted. */
export function nameForUser({ id, members, otherNames, resolved, left, deleted }) {
  if (!id) return deleted;
  const m = members.find((x) => x.user_id === id)?.display_name;
  return (present(m) ? m : null) ?? (present(otherNames[id]) ? otherNames[id] : null) ?? (present(resolved[id]) ? resolved[id] : null) ?? left;
}

/** 이 id는 지금 가진 이름(멤버·이름표·조회 결과)으로 못 풀리는가 — 풀리지 않을 때만 서버에 묻는다. */
export function needsNameLookup({ id, members, otherNames, resolved }) {
  if (!id || id in resolved) return false;
  return !present(members.find((x) => x.user_id === id)?.display_name) && !present(otherNames[id]);
}
