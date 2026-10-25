// 한 목록(레일·폰 대화 탭)의 1:1 상대 이름과 좌하단 내 이름을 "지금 고른 방의 공간"과 무관하게 고정한다(유건 사용 검수 2026-10-24).
// 종전에는 nameOfUser가 지금 공간의 멤버 이름(팀 안 이름)을 먼저 써서, 같은 친구가 팀 방을 고르면 'Coco 팀', 개인 방을 고르면 'cocoball0610'으로 바뀌었다.
// 기준: 행이 사는 공간 — 개인 공간 행은 프로필 이름(서버 msgr_person_label: 프로필 → 이메일 앞부분), 팀 공간 행은 그 팀 안 이름(없으면 프로필).
// 내 이름은 개인 프로필 기준 하나. 읽기는 목록이 바뀔 때 모르는 (공간, 사람)만 묻고, 모른다는 답(null)도 기억해 다시 묻지 않는다(주기 조회 없음).
import { oneListPair, oneListSpace } from './one-list.mjs';

export const peerKey = (row, personalKey) => `${oneListSpace(row, personalKey)}:${row.peer_id}`;

/** rows 가운데 아직 모르는 사람 1:1 상대를 공간별로 묻는다. resolve(sb, { orgId, ids }) → { id: 이름 } (person-names.mjs resolvePeopleNames). 반환: { 'space:user': 이름 | null } */
export async function loadPeerNames(sb, rows, { personalKey, known = {}, resolve }) {
  const want = new Map();
  for (const r of rows ?? []) {
    if (!oneListPair(r) || r.peer_kind !== 'user' || !r.peer_id) continue;
    const k = peerKey(r, personalKey); if (k in known) continue;
    const sp = oneListSpace(r, personalKey);
    if (!want.has(sp)) want.set(sp, new Set());
    want.get(sp).add(r.peer_id);
  }
  const out = {};
  for (const [sp, set] of want) {
    const ids = [...set];
    const got = await resolve(sb, { orgId: sp === personalKey ? null : sp, ids }).catch(() => ({}));
    for (const id of ids) out[`${sp}:${id}`] = got?.[id] ?? null;
  }
  return out;
}

/** 행의 1:1 상대 이름 — 고정된 이름이 있으면 그것, 아직 모르면 fallback(종전 nameOfUser) */
export const peerName = (row, names, personalKey, fallback) => names[peerKey(row, personalKey)] ?? fallback(row.peer_id);
