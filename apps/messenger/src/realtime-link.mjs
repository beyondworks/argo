// 실시간 구독 상태 → 앱이 낼 신호(rt_down·rt_up·목록 다시 읽기)를 고르는 판정부.
// 화면(App.jsx)에서 떼어 둔 이유: '끊김 → 다시 붙음'의 짝이 구독을 새로 거는 순간(폰 복귀·조직 집합·전체 해제) 효과 안 지역 변수와 함께
// 사라져, 열린 방의 10초 보정 조회가 방을 떠날 때까지 이어지고(MSG-03·04) 거는 사이 온 글이 다음 글까지 안 보였다(MSG-01, 2026-10-05 분리 검증).
export const RT_DOWN = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']); // 구독이 끊겼다고 알려 주는 상태

/** 구독 키(org:<조직>·u:<나>·dm:<방>)마다 끊김을 기억한다 — 구독 객체가 바뀌어도(효과 재실행) 남는다.
    status(키, 상태) → 'down' | 'up' | null. 'up'은 (1) 끊겼던 키가 다시 붙었을 때, (2) 다시 건 구독(expect)의 첫 SUBSCRIBED — 거는 사이 빈 구간을 한 번 따라잡는다.
    목록 다시 읽기(onSync)는 끊겼다 붙은 키가 있을 때만, 조용해진 뒤 한 번 — 마지막으로 붙은 키 뒤 syncDelayMs 동안 더 붙는 키가 없으면 부른다(조직 N개 + u:가 각자 부르던 것).
    고정 창(첫 키 뒤 0.8초)이던 때는 재연결 한 번에 구독 약 55개(조직 N + u: + 방 최대 50)가 서버 처리 순서대로 몇 초에 걸쳐 붙으면서 창마다 전체 재조회(요청 약 24건)가
    다시 돌았다(2026-10-07 운영 데스크톱 0.1.51: 재연결 한 번에 7~8번, 53초 주기). 계속 붙어도 첫 키 뒤 syncMaxMs에는 부른다(끝없이 미루지 않게).
    방 토픽(dm:)은 u:가 붙는 서버에서는 목록 다시 읽기를 부르지 않는다 — 방 글은 u:로도 오고(서버 msgr_room_send), 방 토픽만 실어 오는 입력 중·진행·반응은
    목록을 다시 읽어도 되찾지 못한다(열린 개인 방은 roomSignal의 rt_up이 따라잡는다). u:가 한 번도 붙지 않은 옛 서버(u: 거절)에서는 종전대로 부른다. */
export function createLinkWatch({ onSync = () => {}, syncDelayMs = 800, syncMaxMs = 10_000, now = Date.now, timer = setTimeout, clear = clearTimeout } = {}) {
  const down = new Map(); // 키 → 다시 붙을 때 목록도 다시 읽어야 하나
  const fresh = new Set(); // 다시 건 구독 중 아직 SUBSCRIBED를 못 받은 키
  let pending = null; let firstAt = 0; let uSeen = false; // uSeen = 이 서버가 u:를 받아 준 적이 있다
  const syncSoon = () => {
    const t = now();
    if (pending === null) firstAt = t; else clear(pending);
    pending = timer(() => { pending = null; onSync(); }, Math.max(0, Math.min(syncDelayMs, firstAt + syncMaxMs - t)));
  };
  const listKey = (key) => !uSeen || !key.startsWith('dm:');
  return {
    expect(keys) { for (const k of keys) fresh.add(k); }, // 구독을 다시 걸 때(앱 첫 구독은 부르지 않는다 — 화면이 열 때 읽는다)
    status(key, st) {
      if (RT_DOWN.has(st)) { if (!down.has(key)) down.set(key, true); fresh.delete(key); return 'down'; }
      if (st !== 'SUBSCRIBED') return null;
      if (key.startsWith('u:')) uSeen = true;
      if (down.has(key)) { const sync = down.get(key) && listKey(key); down.delete(key); fresh.delete(key); if (sync) syncSoon(); return 'up'; }
      return fresh.delete(key) ? 'up' : null;
    },
    resumed() { for (const k of down.keys()) down.set(k, false); }, // 복귀 처리가 이미 목록을 다시 읽었다 — 다시 붙을 때 또 읽지 않는다
    dispose() { if (pending !== null) clear(pending); pending = null; },
  };
}

/** 조직·u: 구독을 다시 거는 조건. 토큰은 넣지 않는다 — supabase-js가 TOKEN_REFRESHED·SIGNED_IN 때 realtime.setAuth로 붙어 있는 채널에
    새 토큰을 넘긴다. 토큰이 바뀔 때마다(약 1시간) 통째로 떼고 다시 걸면 그 사이 온 글이 다음 글까지 안 보였다(MSG-01). */
export function orgSubscriptionKey({ uid, orgIdsKey, resumeEpoch, roomReset }) {
  return [uid, orgIdsKey, resumeEpoch, roomReset].join('|');
}

/** 방 토픽(dm:<방>)의 'down'·'up'을 화면에 알릴지 — 개인 공간에서 지금 열린 방만. 조직 방은 조직 구독(org:)이 알리고,
    열려 있지 않은 방(최대 50개)이 각자 알리면 다시 붙을 때 따라잡기가 방 수만큼 돈다. */
export function roomSignal(result, { roomId, openId, roomSpace, activeSpace, personal }) {
  if (!result || roomId !== openId || roomSpace !== activeSpace || roomSpace !== personal) return null;
  return result === 'down' ? 'rt_down' : 'rt_up';
}
