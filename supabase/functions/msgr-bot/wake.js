// 봇 깨움 듣기(2026-10-25, 쉬는 VPS 봇 호출 줄이기) — 순수 JS. index.ts(Deno)와 test/msgr-bot-wake.test.mjs가 같이 쓴다.
// DB가 새 일을 만들면 그 봇의 토픽('botw:' + sha256('wake:' + 토큰 해시), 20261025100000)으로 빈 방송을 보낸다.
// 엣지는 롱폴 동안 이 토픽만 듣다가 방송이 오면 RPC를 부른다 — 5초마다 부르던 것(쉬는 봇 RPC 분당 12회)을 롱폴당 1회로.
// 한 인스턴스 안에서 같은 토픽은 채널 하나를 나눠 쓴다(겹친 롱폴이 서로의 채널을 닫지 않게). 마지막 사용 뒤 잠시(linger) 열어 두어
//   어댑터가 곧바로 다시 부를 때 다시 들어가지(join) 않게 하고, 그 사이 온 방송은 버린다(다음 롱폴이 시작하자마자 RPC로 찾는다).
// 들어가기가 실패·지연(readyMs)되면 null — 처리기는 종전 5초 폴링으로 돌아간다(받기는 늘 된다).

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))));

/** 토큰 → 깨움 토픽. DB의 _msgr2_hash(토큰) = sha256 hex, _msgr2_bot_wake_topic(해시)와 같은 식. */
export async function wakeTopic(token) {
  return `botw:${await sha256hex(`wake:${await sha256hex(token)}`)}`;
}

/**
 * client: supabase-js 클라이언트(channel·removeChannel). 반환: listen(topic) → { wait(ms) → 깨웠으면 true, close() } | null(들을 수 없음).
 * opts: readyMs(들어가기 기다림), lingerMs(마지막 사용 뒤 채널을 열어 두는 시간), setTimer·clearTimer(시험).
 */
export function createWakeHub(client, { readyMs = 2_500, lingerMs = 20_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const subs = new Map(); // topic → { ch, ready, refs, waiters, linger }
  const drop = (topic, s) => {
    if (s.linger) { clearTimer(s.linger); s.linger = null; }
    if (subs.get(topic) === s) subs.delete(topic);
    try { client.removeChannel(s.ch); } catch { /* 이미 닫힘 */ }
  };
  const open = (topic) => {
    const had = subs.get(topic);
    if (had) { if (had.linger) { clearTimer(had.linger); had.linger = null; } had.refs += 1; return had; }
    const s = { refs: 1, waiters: new Set(), linger: null, ch: null, ready: null };
    s.ch = client.channel(topic, { config: { private: true } });
    s.ch.on('broadcast', { event: 'wake' }, () => { for (const w of [...s.waiters]) w(); });
    s.ready = new Promise((res) => {
      const t = setTimer(() => res(false), readyMs);
      s.ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') { clearTimer(t); res(true); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { clearTimer(t); res(false); }
      });
    });
    subs.set(topic, s);
    return s;
  };
  const release = (topic, s) => {
    s.refs -= 1;
    if (s.refs > 0) return;
    s.linger = setTimer(() => drop(topic, s), lingerMs);
  };
  return async function listen(topic) {
    const s = open(topic);
    if (!(await s.ready)) { s.refs -= 1; if (s.refs <= 0) drop(topic, s); return null; }
    let closed = false;
    return {
      wait: (ms) => new Promise((res) => {
        const w = () => { clearTimer(t); s.waiters.delete(w); res(true); };
        const t = setTimer(() => { s.waiters.delete(w); res(false); }, Math.max(0, ms));
        s.waiters.add(w);
      }),
      close: () => { if (closed) return; closed = true; release(topic, s); },
    };
  };
}
