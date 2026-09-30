// 좌측 크루 목록 정리(유건 9/30) — 묶기·정렬·검색과 끌어 옮긴 뒤의 순서. 화면과 분리한 순수 함수(테스트: test/crew-list.test.mjs).
// 쓸 수 있는지(access)는 서버가 메신저와 같은 판정으로 준다(값이 없으면 = 예시 데이터·옛 DB, 쓸 수 있는 것으로).
// 고정·순서는 메신저 '내 에이전트' 레일과 같은 행(msgr_target_prefs) — 번호가 메신저와 맞는 '고정'·'내 크루' 묶음만 끌어 옮긴다.
const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
const byPos = (key) => (a, b) => (a[key] ?? Infinity) - (b[key] ?? Infinity) || byName(a, b);
const WORKING = new Set(['work', 'ask']);
export const usable = (c) => (c.access ?? 'ok') === 'ok';
export const isMine = (c, me) => !c.company && (!c.owner || c.owner === me); // 주인 없음 = 예시 데이터(내 공간)

/** crews → { groups: [{ key, label?, crews, movable }], blocked(꺼진 내 크루) } — by: 'owner'(내·회사·동료) | 'dept'(부서별) */
export function groupCrews(crews, { me, by = 'owner', query = '', working = false } = {}) {
  const q = query.trim().toLowerCase();
  const hit = (c) => !q || [c.name, c.ownerName, c.dept, c.role, c.job].some((v) => v && String(v).toLowerCase().includes(q));
  // 오피스에는 내 크루만(유건 9/30: 남의 크루·회사 크루는 메신저에서 부르면 된다 — 오피스로 끌고 올 필요 없다)
  const shown = crews.filter((c) => isMine(c, me) && hit(c) && (!working || WORKING.has(c.status)));
  const ok = shown.filter(usable);
  const groups = [{ key: 'pinned', movable: true, crews: ok.filter((c) => c.pinned).sort(byPos('pinPos')) }];
  const rest = ok.filter((c) => !c.pinned);
  if (by === 'dept') {
    const depts = [...new Set(rest.map((c) => c.dept || ''))].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, 'ko'));
    for (const d of depts) groups.push({ key: `dept:${d}`, label: d || null, movable: false, crews: rest.filter((c) => (c.dept || '') === d).sort(byPos('sortPos')) });
  } else {
    groups.push({ key: 'mine', movable: true, crews: rest.sort(byPos('sortPos')) });
  }
  return { groups: groups.filter((g) => g.crews.length), blocked: shown.filter((c) => !usable(c)).sort(byName) }; // blocked = 꺼진 내 크루
}

/** 끌어 옮긴 뒤의 id 순서 — moved를 target 자리로. 바뀌지 않으면 null */
export function moveIds(ids, movedId, targetId) {
  const from = ids.indexOf(movedId), to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...ids];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

/** 고정 순서: 이 크루들이 쓰던 번호 칸(오름차순)을 새 순서대로 다시 나눈다 — 메신저 즐겨찾기(채널과 섞인 번호)를 건드리지 않게 */
export function reslot(crews, orderedIds) {
  const slots = crews.filter((c) => orderedIds.includes(c.id)).map((c) => c.pinPos).filter((p) => p != null).sort((a, b) => a - b);
  return new Map(orderedIds.map((id, i) => [id, slots[i] ?? (slots.at(-1) ?? -1) + 1 + i - slots.length]));
}
