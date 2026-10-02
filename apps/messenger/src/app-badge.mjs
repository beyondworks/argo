// 폰 앱 아이콘 숫자 — 서버 배지(msgr_my_badge)와 같은 숫자를 앱이 직접 쓴다(유건 제보 2026-10-01: 다 읽어도 아이콘 '1'이 남음).
// iOS는 앱이 앞에 있을 때 받은 푸시의 aps.badge를 적용하지 않는다(푸시 플러그인 willPresent → [], 시뮬레이터 실측). 그래서 폰에서 읽는 동안
// 서버가 보낸 배지 0은 버려지고, 앱이 쓴 숫자만 남는다 — 앱이 다른 셈법(모든 채널 합계)을 쓰면 뒤로 보낸 뒤에도 그 숫자가 굳었다.
// Android는 아이콘 숫자가 트레이 알림에서 나온다 → 다 읽은 채널의 알림(태그 ch-<채널>)만 지운다(안 읽은 글이 남은 채널은 배지 대상이 아니어도 둔다).
// 호출은 읽기 RPC 하나뿐이다(쓰기·pg_net·푸시 없음). 순수 모듈 — 테스트는 가짜 함수로 돈다(test/app-badge.test.mjs).

/** 푸시 알림 칸 태그 — 엣지 msgr-push sendOne의 group(`ch-${channelId}`)과 같아야 한다(Android FCM tag). */
export const trayTagOf = (channelId) => `ch-${channelId}`;

/**
 * 서버 행([{channel_id, n, unread}]) → { total, tags }. total = 아이콘 숫자(배지 n의 합), tags = 트레이에 남길 채널(안 읽은 글이 있는 모든 채널).
 * 트레이를 배지(1:1·멘션·답글)로 정하면 멘션 없는 채널 글 알림이 앱을 열기만 해도 지워졌다(분리 검수 MEDIUM 2026-10-02). unread가 없는 행은 n으로 본다.
 */
export function badgeFromRows(rows) {
  let total = 0; const tags = [];
  for (const r of rows ?? []) {
    if (!r?.channel_id) continue;
    const n = Number(r.n) || 0; const unread = r.unread == null ? n : Number(r.unread) || 0;
    if (n > 0) total += n;
    if (unread > 0 || n > 0) tags.push(trayTagOf(r.channel_id));
  }
  return { total, tags };
}

/**
 * fetchRows: () => Promise<[{channel_id, n, unread}]> — 서버 배지(msgr_my_badge). 실패하면 throw.
 * setIcon:   (n) => void — 아이콘 숫자(0 = 지움).
 * clearTray: ({ keep }) => void | null — Android: 태그가 keep에 없는 메시지 알림을 지운다. iOS·데스크톱은 null.
 * fallback:  () => number | null — 서버 함수가 아직 없을 때(라이브 적용 전) 쓸 예전 숫자. null이면 아이콘을 건드리지 않는다.
 */
export function createIconBadge({ fetchRows, setIcon, clearTray = null, fallback = null, wait = 400, timers = globalThis }) {
  let shown = null; let trayKey = null; let running = null; let again = false; let timer = null; let stopped = false;
  const apply = (n, tags) => {
    if (n !== shown) { shown = n; try { setIcon(n); } catch { /* 아이콘 실패는 다음 동기화에서 */ } }
    if (clearTray && tags) { const key = tags.slice().sort().join(','); if (key !== trayKey) { trayKey = key; try { clearTray({ keep: tags }); } catch { trayKey = null; } } }
  };
  const once = async () => {
    let rows;
    try { rows = await fetchRows(); } catch {
      const n = fallback ? fallback() : null;
      if (Number.isInteger(n) && n >= 0 && !stopped) apply(n, null); // 예전 숫자는 트레이를 지우지 않는다(어느 채널이 읽혔는지 모른다)
      return;
    }
    if (stopped) return;
    const { total, tags } = badgeFromRows(rows);
    apply(total, tags);
  };
  /** 지금 다시 맞춘다. 진행 중이면 끝난 뒤 한 번 더(그 사이 바뀐 읽음까지) — 동시에 두 번 부르지 않는다. */
  const sync = () => {
    if (stopped) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => { do { again = false; await once(); } while (again && !stopped); })().finally(() => { running = null; });
    return running;
  };
  /** 잇따른 변화는 wait 동안 모아 한 번 부른다. */
  const request = () => { if (stopped) return; timers.clearTimeout(timer); timer = timers.setTimeout(() => { timer = null; sync(); }, wait); };
  /** 트레이를 다시 훑게 한다 — 앱이 뒤에 있는 동안 새 알림이 쌓였을 수 있다(앞으로 올 때). */
  const resume = () => { trayKey = null; request(); }; // 앞으로 올 때는 visibilitychange와 재개 신호가 같이 온다 — 모아서 한 번
  const stop = () => { stopped = true; timers.clearTimeout(timer); };
  return { sync, request, resume, stop, get shown() { return shown; } };
}

/** 같은 안 읽음이면 같은 문자열 — 15초마다 새 객체로 다시 읽혀도 값이 같으면 서버를 다시 부르지 않는다. */
export function unreadSignature({ unread = {}, totals = {}, muted = new Set() }) {
  const a = Object.entries(unread).filter(([, u]) => u?.n).map(([id, u]) => `${id}:${u.n}:${u.mention || 0}${muted.has(id) ? 'm' : ''}`).sort();
  const b = Object.entries(totals).filter(([, u]) => u?.n).map(([k, u]) => `${k}:${u.n}:${u.mention || 0}`).sort();
  return `${a.join(',')}|${b.join(',')}`;
}
