// 좌측 크루 목록 정리(유건 9/30) — 고정·내 에이전트 두 묶음, 검색, 끌어 옮긴 뒤의 순서. 화면과 분리한 순수 함수(테스트: test/crew-list.test.mjs).
// 쓸 수 있는지(access)는 서버가 메신저와 같은 판정으로 준다(값이 없으면 = 예시 데이터·옛 DB, 쓸 수 있는 것으로).
// 고정·순서는 메신저 '내 에이전트' 레일과 같은 행(msgr_target_prefs) — 번호가 메신저와 맞는 '고정'·'내 크루' 묶음만 끌어 옮긴다.
const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
const byPos = (key) => (a, b) => (a[key] ?? Infinity) - (b[key] ?? Infinity) || byName(a, b);
export const usable = (c) => (c.access ?? 'ok') === 'ok';
export const isMine = (c, me) => !c.company && (!c.owner || c.owner === me); // 주인 없음 = 예시 데이터(내 공간)

/** crews → { groups: [{ key: 'pinned'|'mine', crews, movable }], blocked(꺼진 내 크루) } — 고정한 크루는 '내 에이전트'에서 빠진다.
 *  주인별·부서별 묶기와 '일하는 중만' 필터는 뺐다(유건 9/30 #6) */
export function groupCrews(crews, { me, query = '' } = {}) {
  const q = query.trim().toLowerCase();
  const hit = (c) => !q || [c.name, c.ownerName, c.dept, c.role, c.job].some((v) => v && String(v).toLowerCase().includes(q));
  // 오피스에는 내 크루만(유건 9/30: 남의 크루·회사 크루는 메신저에서 부르면 된다 — 오피스로 끌고 올 필요 없다)
  const shown = crews.filter((c) => isMine(c, me) && hit(c));
  const ok = shown.filter(usable);
  const groups = [
    { key: 'pinned', movable: true, crews: ok.filter((c) => c.pinned).sort(byPos('pinPos')) },
    { key: 'mine', movable: true, crews: ok.filter((c) => !c.pinned).sort(byPos('sortPos')) },
  ];
  return { groups: groups.filter((g) => g.crews.length), blocked: shown.filter((c) => !usable(c)).sort(byName) }; // blocked = 꺼진 내 크루
}

const RANK = { work: 0, ask: 1, idle: 2, rest: 3, off: 4 };
/** 내 공간의 에이전트 한 줄씩(유건 2026-10-05 에이전트 = 한 사람, 메신저 에이전트 탭과 같은 묶음) — 같은 묶음 키(agent)의 행을 하나로.
 *  대표 = 조직 행(고정·순서가 사는 행), 없으면 개인 공간 행. ids = 묶인 행 전부, twin = 개인 공간 행(맡기기는 그 1:1로), spaces = 들어 있는 조직 공간 키.
 *  상태는 가장 바쁜 것(일하는 중 → 결재 대기 → 대기 중 → 모름 → 꺼짐), 접속은 하나라도 켜져 있으면 켜짐 */
export function oneEach(list) {
  const by = new Map();
  for (const c of list) { const k = c.agent ?? c.id; if (by.has(k)) by.get(k).push(c); else by.set(k, [c]); }
  return [...by.values()].map((g) => {
    // 대표 = 고정한 조직 행 → 회사 크루가 아닌 조직 행 → 아무 조직 행 → 개인 행(고정·순서는 조직마다 따로라 고정한 행을 앞에, 회사 크루 행이 대표면 줄이 통째로 빠졌다)
    const orgRows = g.filter((c) => !c.personal);
    const rep = orgRows.find((c) => c.pinned) ?? orgRows.find((c) => !c.company) ?? orgRows[0] ?? g[0];
    return { ...rep, ids: g.map((c) => c.id), twin: g.find((c) => c.personal)?.id ?? null, spaces: [...new Set(g.map((c) => c.space).filter((s) => s && s !== 'me'))],
      status: g.map((c) => c.status).sort((a, b) => (RANK[a] ?? 2) - (RANK[b] ?? 2))[0], on: g.some((c) => c.on) || (g.some((c) => c.on === false) ? false : null) };
  });
}

/** 공간의 크루 — 내 공간은 내 에이전트를 한 줄씩(여러 조직·개인 공간 행을 묶는다, oneEach), 조직은 그 조직 크루(개인 공간 행은 빠진다).
 *  꺼진(파견 해제·분리) 크루와 동기화 충돌 사본은 싣지 않는다 — 메신저 목록과 같은 수(10/5). 예시 크루(공간·주인 없음)는 어디서나 */
export const crewsIn = (crews, space, me) => {
  const here = crews.filter((c) => !c.copy && (c.access ?? 'ok') !== 'inactive' && (space === 'me' ? !c.owner || c.owner === me : !c.space || c.space === space));
  return space === 'me' ? oneEach(here) : here;
};

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
