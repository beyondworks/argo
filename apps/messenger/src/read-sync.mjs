// 읽음 커서·안 읽음 숫자 판정부(2026-10-05 분리 검증 MSG-05·MSG-08). 화면(App.jsx)에서 떼어 둔 이유: 저장 실패·응답 순서처럼 화면으로는 드물게만
// 보이는 경합이라, 행동을 테스트로 잠가야 다시 새지 않는다.

/** 이 기기의 읽음 커서 저장 — 같은 값을 다시 쓰지 않되(초점·가시성마다 upsert하던 것, 기능 점검 D2) 실패한 위치는 다음 기회에 다시 쓴다(MSG-05:
    실패해도 '저장함'으로 남아 읽은 방이 서버·다른 기기·폰 아이콘에서 계속 안 읽음이었다).
    begin(방, 글 id) → null(이미 저장했거나 저장 중) | { ok(), fail() }. unreadFrom(서버 행, 물은 시각) → 화면에 쓸 { 방: { n, mention } }. */
export function createReadCursor({ now = Date.now } = {}) {
  const saved = new Map();   // 방 → 저장이 확인된 커서
  const flying = new Map();  // 방 → 저장 중인 커서들
  const savedAt = new Map(); // 방 → 마지막 저장 확인 시각
  const top = (ch) => Math.max(saved.get(ch) ?? 0, ...(flying.get(ch) ?? []));
  return {
    begin(ch, id) {
      if (!ch || !id || top(ch) >= id) return null;
      const set = flying.get(ch) ?? new Set(); set.add(id); flying.set(ch, set);
      const end = () => { set.delete(id); if (!set.size && flying.get(ch) === set) flying.delete(ch); };
      return {
        ok() { end(); if (id > (saved.get(ch) ?? 0)) saved.set(ch, id); savedAt.set(ch, now()); },
        fail() { end(); }, // 저장 확인 전 상태로 — 다음 초점·가시성·새 글 때 다시 쓴다(이벤트가 있을 때만이라 호출이 폭주하지 않는다)
      };
    },
    // 서버 숫자는 물은 시점의 스냅샷이다. 물은 뒤(또는 묻는 동안) 이 기기가 읽음으로 저장한 열린 방(openId)은 0으로 둔다 — 저장 전에 센 n=1이 늦게 도착해
    // 이미 읽은 열린 방에 배지를 다시 덮던 경합. 열린 방만 — 다른 방은 저장한 위치 뒤 새 글까지 감췄다(검수 L2). 저장에 실패한 방은 서버 숫자 그대로(실패를 감추지 않는다).
    unreadFrom(rows, since, openId = null) {
      const out = {};
      for (const r of rows ?? []) out[r.channel_id] = r.channel_id === openId && (flying.has(r.channel_id) || (savedAt.get(r.channel_id) ?? -Infinity) >= since) ? { n: 0, mention: 0 } : { n: r.n, mention: r.mention };
      return out;
    },
  };
}

/** 이 글이 보는 공간의 안 읽음 숫자를 다시 셀 일인가(MSG-08) — 이 기기에서 열어 둔 방(openId)의 내 글, 참여하지 않은 공개 채널(미리보기·이미 물어
    내 방이 아닌 것으로 확인한 방) 글은 아니다. 다른 방의 내 글은 센다 — 다른 기기(폰)에서 쓴 글이고 그 기기가 읽음을 올렸다(msgr_reads에는 방송이 없어
    이 재집계가 다른 기기의 읽음을 아는 유일한 길, 검수 L1). 방송에는 client_msg_id가 없어 열린 방으로 가른다.
    ponytail: 이 기기가 열린 방 밖으로 보낸 글(넘기기 등)도 한 번 더 센다 — 묶기 창(1.5초) 안이라 요청은 늘지 않거나 1건.
    처음 보는 방의 첫 글은 센다(새 1:1·비공개 방 — 목록에 들어오는 중일 수 있다). 부르는 쪽은 그 방을 목록에 넣기 전에 판정한다. */
export function unreadWorthy(payload, { uid, listIds = new Set(), previewIds = new Set(), asked = new Set(), openId = null } = {}) {
  const cid = payload?.channel_id;
  if (!cid || (payload.author_user_id && payload.author_user_id === uid && cid === openId)) return false;
  if (listIds.has(cid)) return true;
  return !previewIds.has(cid) && !asked.has(cid);
}

/** 창(delayMs) 안의 요청을 한 번으로 — 첫 요청 뒤 delayMs에 한 번 부른다(요청이 계속 와도 미루지 않는다: 글이 1초마다 와도 1.5초마다 센다). */
export function createCoalescer(fn, { delayMs = 1500, timer = setTimeout, clear = clearTimeout } = {}) {
  let t = null;
  return {
    request() { if (t !== null) return; t = timer(() => { t = null; fn(); }, delayMs); },
    cancel() { if (t !== null) clear(t); t = null; },
  };
}
