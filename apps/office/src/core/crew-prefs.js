// 크루 고정·순서 저장(유건 9/30) — 메신저 '내 에이전트' 레일과 같은 행(msgr_target_prefs).
// 서버 함수 office_crew_prefs가 바꾸려는 칸만 쓴다(오래된 화면 상태가 메신저에서 바꾼 고정을 덮지 않게 — 분리 검수 MEDIUM-2).
// 화면에 먼저 반영하고, 실패하면 서버에서 다시 읽는다(스냅숏 되돌리기는 여러 조직·새로 받은 값을 덮는다 — 검수 LOW-2).
import { ME, getMode } from './session.js';
import { update, getState } from './store.js';
import { rpc } from './tasks.js';
import { pullBoard } from './pull.js';
import { moveIds, reslot } from './crew-list.js';

const patch = (fn) => update((s) => ({ crews: s.crews.map((c) => fn(c) ?? c) }));

async function save(orgId, action, ids, on = null) {
  if (getMode() !== 'signedIn' || !orgId) return; // 예시 모드는 화면에서만
  try { await rpc('office_crew_prefs', { p_org: orgId, p_action: action, p_ids: ids, p_on: on }); }
  catch (e) { pullBoard().catch(() => {}); throw e; }
}

/** 한 묶음(order: 화면 순서의 크루 id) 안에서 끌어 놓기. mode 'pin' = 고정 묶음. 내 공간은 여러 조직 크루가 섞이므로 조직마다 따로 */
export async function moveCrew(order, movedId, targetId, mode) {
  const next = moveIds(order, movedId, targetId);
  if (!next) return;
  const crews = getState().crews, orgOf = new Map(crews.map((c) => [c.id, c.org ?? null]));
  const slots = mode === 'pin' ? reslot(crews, next) : null;
  patch((c) => { const i = next.indexOf(c.id); return i < 0 ? null : mode === 'pin' ? { ...c, pinPos: slots.get(c.id) } : { ...c, sortPos: i }; });
  const orgs = [...new Set(next.map((id) => orgOf.get(id)))];
  await Promise.all(orgs.map((org) => {
    const ids = next.filter((id) => orgOf.get(id) === org);
    if (mode !== 'pin') patch((c) => (ids.includes(c.id) ? { ...c, sortPos: ids.indexOf(c.id) } : null)); // 서버와 같은 번호(조직 안 순서)
    return save(org, mode === 'pin' ? 'pin_order' : 'sort', ids);
  }));
}

/** 고정 켜기/끄기 — 켜면 맨 뒤 */
export function pinCrew(crew, on) {
  const last = Math.max(-1, ...getState().crews.filter((c) => c.pinned && c.pinPos != null).map((c) => c.pinPos));
  patch((c) => (c.id === crew.id ? { ...c, pinned: on, pinPos: on ? last + 1 : null } : null));
  return save(crew.org, 'pin', [crew.id], on);
}

export const canPin = (crew) => (crew.access ?? 'ok') === 'ok' && (!!crew.org || getMode() !== 'signedIn') && !!ME;
