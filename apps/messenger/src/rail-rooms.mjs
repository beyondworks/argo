// 넓은 화면(폭 > 720px — 데스크톱·iPad) 레일의 대화 두 절, '즐겨찾기'와 '채팅'. 순수 함수 — App.jsx가 쓰고 test/rail-rooms.test.mjs가 잠근다.
// 즐겨찾기(고정)한 방은 '채팅' 절에서 빠지고 '즐겨찾기' 절에만 있다. 그래서 즐겨찾기 절은 공간(조직·개인)을 가리지 않는다 —
// 개인 공간에서 이 절만 감추자(9/16~) 즐겨찾기한 대화가 넓은 화면 목록 어디에도 없었고 다시 풀 수도 없었다(2026-10-08).
// 폰(≤ 720px)은 레일 대신 폰 셸이 채팅 탭을 따로 그린다(App.jsx phoneRoot·splitFavs) — 여기 대상이 아니다.

/**
 * @param {object} o
 * @param {Array} o.channels 지금 공간의 방(채널·1:1·그룹)
 * @param {Set<string>} o.pinned 즐겨찾기한 방 id
 * @param {Map<string, number>} [o.pinPos] 즐겨찾기 순서(pin_pos)
 * @param {Array} [o.targets] 즐겨찾기한 사람·에이전트(조직만 — { id, kind: 'target', name, pin_pos })
 * @param {(c: object) => boolean} [o.hidden] 채팅 절에서 뺄 방(글 없는 개인 1:1, D13). 즐겨찾기는 사용자가 고른 것이라 빼지 않는다(종전과 같다)
 * @param {boolean} [o.blocked] 조직 AI 동의 전·조회 중 — 두 절 모두 가린다. 개인 공간은 늘 false
 * @param {string|null} [o.space] 지금 공간 id(조직 id 또는 개인 공간 표지). 있으면 채팅 절은 비어 있어도 그린다(머리의 새 대화 단추)
 */
export function railRooms({ channels, pinned, pinPos = new Map(), targets = [], hidden = () => false, blocked = false, space = null }) {
  const at = (x) => (x.kind === 'target' ? x.pin_pos : pinPos.get(x.id)) ?? 1e9;
  const favs = [...channels.filter((c) => pinned.has(c.id)), ...targets].sort((a, b) => at(a) - at(b) || a.name.localeCompare(b.name));
  const dms = channels.filter((c) => c.kind === 'dm' && !pinned.has(c.id) && !hidden(c));
  return { favs, dms, showFavs: !blocked && favs.length > 0, showDms: !blocked && (dms.length > 0 || !!space) };
}
