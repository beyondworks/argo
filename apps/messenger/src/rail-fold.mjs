// 레일 구역 접기(네이티브 details, 2026-09-08) — 접힘은 이 기기에만(localStorage) 남는다. App.jsx RailSection·RailFold가 쓴다. 순수(시험에서 그대로 부른다).
export const FOLD_KEY = 'argo-msgr-rail-fold';

/** 저장된 접힘 표 { [구역 id]: true(접힘) }. 읽지 못하면 빈 표(전부 펼침). */
export function readFold(storage) {
  try { const v = JSON.parse(storage?.getItem(FOLD_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** 처음 그릴 때 펼침인가 — 저장된 값이 '접힘'일 때만 접는다. */
export const initialOpen = (id, storage) => readFold(storage)[id] !== true;

/**
 * details의 toggle 사건 처리. nextOpen = 사건 뒤 details.open.
 * 늘 펼침 구역이면 저장하지 않고 펼침으로 되돌린다(revert). 아니면 접힘을 저장하고 그 값을 그린다.
 */
export function foldToggle({ id, forceOpen = false, nextOpen, storage }) {
  if (forceOpen) return { open: true, revert: !nextOpen };
  try { storage?.setItem(FOLD_KEY, JSON.stringify({ ...readFold(storage), [id]: !nextOpen })); } catch { /* 저장 못 해도 이번엔 접힌다 */ }
  return { open: !!nextOpen, revert: false };
}

/**
 * 늘 펼침(접기 화살표 없음) 구역인가.
 * - 친구(friends): 폰 홈에서는 친구 목록이 그 화면이라 늘 펼친다(2026-09-17 카톡식). 데스크톱 레일에서는 다른 구역처럼 접힌다(유건 제보 2026-10-22 — 화살표가 보이는데 눌러도 안 접혔다)
 * - 채팅(dms): 폰 DM 탭에서만(유건 제보 2026-09-15 — 홈에서 접으면 DM 화면이 비었다)
 * - 고정 DM(dmpin): 늘(고정한 대화는 접어 숨기지 않는다 — 종전 그대로)
 */
export function railForceOpen(id, { phone = false, dmTab = false } = {}) {
  if (id === 'friends') return !!phone;
  if (id === 'dms') return !!dmTab;
  return id === 'dmpin';
}
