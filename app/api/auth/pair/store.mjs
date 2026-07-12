// 앱 ↔ 브라우저 로그인 브리지의 일회용 페어링 저장소.
// 데스크톱 앱 웹뷰는 Google/GitHub 로그인 창을 못 띄운다(웹뷰 차단·패스키 팝업 불가) →
// 앱이 pairing code를 들고 "진짜 브라우저"를 열어 거기서 로그인하고,
// 브라우저가 그 code에 세션을 봉인하면 앱이 code로 회수한다.
//
// 원칙: 코드=단명(5분)·1회 소비, 세션 토큰은 메모리에만(디스크·로그 금지), localhost 전제.
// globalThis 공유 — Next가 라우트를 별도 번들로 복제해도 한 저장소를 본다.
const TTL_MS = 5 * 60_000;
const store = (globalThis.__argoPair ??= new Map()); // code → { session|null, createdAt }

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.createdAt > TTL_MS) store.delete(k);
}

/** 앱이 새 코드 발급. 아직 세션 없음(pending). */
export function createPairing(code) {
  sweep();
  store.set(code, { session: null, createdAt: Date.now() });
}

/** 브라우저가 로그인 후 이 코드에 세션을 봉인. 존재하고 미만료일 때만. */
export function bindPairing(code, session) {
  const e = store.get(code);
  if (!e || Date.now() - e.createdAt > TTL_MS) return false;
  e.session = session;
  return true;
}

/** 앱이 폴링으로 회수 — 세션이 있으면 1회 반환 후 즉시 삭제(재사용 차단). */
export function claimPairing(code) {
  sweep();
  const e = store.get(code);
  if (!e) return { status: 'expired' };
  if (!e.session) return { status: 'pending' };
  store.delete(code);
  return { status: 'ready', session: e.session };
}
