// 진단 기록 저장(설정 → 내 정보 → 진단) — 일반 기록과 알림 탭·이동 기록을 다른 키에 각각 최근 20건씩 둔다.
// 모바일에서는 실시간 글마다 'notify' 줄이 쌓여 같은 20건 안에서 'tap'·'nav' 줄이 금방 밀려났다(2026-10-01 반대 검토).
// 보여 줄 때는 두 목록을 시각 순으로 합친다. 저장 불가 환경(사생활 보호 모드 등)에서는 조용히 아무것도 남기지 않는다.
export const DIAG_KEY = 'msgr-diag';
export const DIAG_NAV_KEY = 'msgr-diag-nav';
export const DIAG_LIMIT = 20;
const NAV_KINDS = new Set(['tap', 'nav']);
const ERROR_KINDS = new Set(['error', 'rejection', 'render', 'toast']); // 오류 줄 — 'notify'·'shell' 줄에 밀려나지 않게 먼저 지킨다(화면 검수 UL2)
const OTHER_MIN = 8; // 오류가 넘쳐도 다른 줄은 이만큼 남긴다
/** 최신순 목록을 상한 안으로 — 오류 줄을 먼저 지키고(다른 줄은 최소 OTHER_MIN칸), 순서는 그대로 */
function trim(list) {
  if (list.length <= DIAG_LIMIT) return list;
  const others = list.filter((e) => !ERROR_KINDS.has(e.kind));
  const keepOthers = Math.min(others.length, Math.max(OTHER_MIN, DIAG_LIMIT - (list.length - others.length)));
  let errs = DIAG_LIMIT - keepOthers; let rest = keepOthers;
  return list.filter((e) => (ERROR_KINDS.has(e.kind) ? errs-- > 0 : rest-- > 0));
}

export function createDiagStore(getStorage, now = () => new Date().toISOString()) {
  const storage = () => { try { return getStorage() ?? null; } catch { return null; } };
  const readKey = (key) => {
    try { const v = JSON.parse(storage()?.getItem(key) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  return {
    read() {
      return [...readKey(DIAG_KEY), ...readKey(DIAG_NAV_KEY)].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); // 최신순
    },
    push(kind, message, extra = '') {
      try {
        const key = NAV_KINDS.has(kind) ? DIAG_NAV_KEY : DIAG_KEY;
        const list = readKey(key);
        list.unshift({ at: now(), kind, message: String(message).slice(0, 400), extra: String(extra).slice(0, 600) });
        storage()?.setItem(key, JSON.stringify(trim(list)));
      } catch { /* 저장 불가 환경 */ }
    },
    clear() { try { const s = storage(); s?.removeItem(DIAG_KEY); s?.removeItem(DIAG_NAV_KEY); } catch { /* 무해 */ } },
  };
}
