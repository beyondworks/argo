// 폰 당겨서 새로고침 직전의 화면 상태 스냅샷 — sessionStorage에 한 번 쓰고, 부팅 때 한 번 읽어 곧바로 지운다.
// 유건 제보(2026-09-26): "모바일 새로고침이 마지막 보던 페이지에서 이루어지게 해 줘."
// 콜드 스타트(진짜 새 실행)에는 이 키가 없으므로 기존 기본 동작(홈 탭) 그대로 — 당겨서 새로고침을 실제로 실행한
// 순간에만 App.jsx가 이 모듈로 저장하고, 부팅 시 1회 소비한다. 순수 함수만 — DOM·React 접근은 호출부(App.jsx) 책임.
const KEY = 'argo-msgr-pull-snap';
const MAX_AGE_MS = 60_000; // 소비 전에 탭이 오래 떠 있었다면(드문 경우) 낡은 값으로 보고 버린다

export function writeScreenSnapshot(store, snapshot) {
  if (!store) return;
  try { store.setItem(KEY, JSON.stringify({ v: 1, at: Date.now(), ...snapshot })); } catch { /* 저장 못 해도 새로고침 자체는 진행 */ }
}

// 한 번 읽고 반드시 지운다 — 다음 콜드 스타트에 잘못 쓰이지 않게. 값이 없거나 깨졌거나 낡았으면 null.
export function consumeScreenSnapshot(store, { maxAgeMs = MAX_AGE_MS } = {}) {
  if (!store) return null;
  let raw = null;
  try { raw = store.getItem(KEY); store.removeItem(KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw);
    if (!snap || typeof snap !== 'object' || snap.v !== 1) return null;
    if (typeof snap.at !== 'number' || Date.now() - snap.at > maxAgeMs) return null;
    return snap;
  } catch { return null; }
}
