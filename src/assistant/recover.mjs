// 능동 비서 — 방에서 복구(설계 7절 "방에서 복구", 4.2 2단계).
// 상태 파일(.assistant/state.json)은 기기 로컬이다. 그래서 실행 기기(클라우드 리더)가 바뀌거나, 상태가 없는 기기가 맡거나, 재시작·잠자기 뒤이거나,
// 쉬다가(다른 회사가 맡음·일정 보기 끔 등) 다시 맡으면 — 이 사람의 비서가 개인 1:1 방에 쓴 알림 글(meta.assistant)을 읽어 이미 보낸 키를 로컬 상태와
// 합친다(합집합). 이것이 없으면(#863 2차 검수 LOW, H61):
//  · 새 기기가 다른 기기가 보낸 시작 전 알림·아침 묶음을 다시 넣으려 해 23505가 실행 기기 교대마다 쌓인다(같은 방 — DB 유니크가 한 번만 넣는다).
//  · 비서를 다른 회사로 바꾸면 같은 일정이 두 방에 알려진다(다른 방이라 DB 유니크가 막지 못한다).
//  · 상태가 있는 기기가 다른 기기의 리더 기간 뒤 돌아오면 그사이 알린 회차를 "확인 못 한 사이 지난 일정"으로 다시 넣는다.
// 읽는 방: 같은 주인의 회사들 중 비서 설정에 에이전트가 적힌 회사(켜짐·꺼짐 모두 — 비서를 다른 회사로 바꾸면 이전 회사는 꺼진 채 에이전트가 남는다)의
// 그 에이전트 개인 1:1 방, 이미 있는 방만(만들지 않는다). 최근 14일(보낸 키 보관 기간과 같다)·300건(설계 7절).
// 보류 목록은 넘겨받지 않는다(설계 7절) — 다른 기기가 모은 보류는 그 기기가 묶음에 넣거나, 이 기기가 자기 확인 범위로 다시 찾는다.
// 호출: 복구 1번 = 크루 행 1 + 방 1 + 글 1(크루·방이 없으면 그 뒤는 0). 실패하면 5분 뒤 다시 — 매 틱 읽지 않는다.
// 내려받는 양: 처음(이 기기에 기록 없음·읽는 방이 바뀜)만 14일, 그 뒤(잠자기·재시작)는 지난 복구에서 본 마지막 글 시각 − 10분과 오늘 0시 중 이른 쪽부터
// (recoverSince) — 오늘 수는 늘 오늘 글 전부로 센다. 같은 글을 매번 다시 내려받지 않게(DB 위생 — 전송량).
import { SENT_KEEP_MS } from './state.mjs';
import { dateIn } from './rules.mjs';

export const RECOVER_LIMIT = 300;
export const RECOVER_RETRY_MS = 5 * 60_000;
export const RECOVER_OVERLAP_MS = 10 * 60_000; // 지난 복구의 끝보다 이만큼 앞부터 — 늦게 커밋된 글·서버와 기기 시계 차이
const SUM_RE = /^sum:(am|pm):(\d{4}-\d{2}-\d{2})$/;

/** 읽을 방의 주인 — [{ ws, agent }]. 지금 비서(이 회사)가 먼저. ids = 이 기기의 회사 목록, config = 엔진 설정 읽기(봉인 안 맞는 켜짐은 null — 그 회사는 뺀다). */
export async function recoveryTargets(cid, owner, cfg, ids, { config, company }) {
  const out = [{ ws: cid, agent: cfg.agent }];
  for (const id of ids) {
    if (id === cid) continue;
    const pc = await config(id).catch(() => null);
    if (!pc?.agent) continue;
    const co = await company(id).catch(() => null);
    if (!co || (co.ownerId ?? null) !== (owner ?? null)) continue;
    out.push({ ws: id, agent: pc.agent });
  }
  return out;
}

/** 이 복구가 읽을 방들의 서명(순서 무관) — 바뀌면 지난 복구의 끝을 쓰지 않고 14일을 다시 읽는다. */
export const targetsSig = (targets) => targets.map((t) => `${t.ws}/${t.agent}`).sort().join(',');

/** 어디부터 읽나(ms) — 처음·방이 바뀜이면 14일 전, 아니면 min(지난 복구의 끝 − 10분, 오늘 0시)과 14일 전 중 늦은 쪽.
    rec = 상태의 { to, sig }, todayStart = 회사 시간대 오늘 0시. */
export function recoverSince(rec, sig, now, todayStart) {
  const floor = now - SENT_KEEP_MS;
  if (!rec?.to || rec.sig !== sig) return floor;
  return Math.max(floor, Math.min(rec.to - RECOVER_OVERLAP_MS, todayStart));
}

/** 방 글 읽기 — 크루 행 → 이미 있는 1:1 방 → 비서 글(since 이후). 반환 = [{ meta, created_at }]. 서버가 거절하면 던진다(호출부가 5분 뒤 다시). */
export async function readRoomNotices(c, targets, sinceMs) {
  const want = new Set(targets.map((t) => `${t.ws}\n${t.agent}`));
  const crews = ((await c.db.personalCrewsOf(c.uid, [...new Set(targets.map((t) => t.ws))])) ?? [])
    .filter((r) => r && r.id && r.org_id == null && want.has(`${r.ws_id}\n${r.slug}`));
  if (!crews.length) return [];
  const pairs = new Set(crews.map((r) => `crew:${r.id}`));
  const rooms = ((await c.db.personalRoomsOf(crews.map((r) => r.id))) ?? []).filter((r) => r?.id && pairs.has(r.personal_pair));
  if (!rooms.length) return [];
  return (await c.db.assistantNotices(rooms.map((r) => r.id), rooms.map((r) => r.personal_pair.slice('crew:'.length)), new Date(sinceMs).toISOString(), RECOVER_LIMIT)) ?? [];
}

/** 글 → 복구 값(순수). 0.1.99(엔진 2)가 쓴 글도 같은 모양이다(meta.assistant.keys·kind). 반환:
    { today, sent: { 키: 보낸 시각 }, bundles: { am, pm }(처리한 가장 늦은 날짜), instant(오늘 보낸 시작 전 알림 수 — 키로 셈), capNoted(오늘 상한 꼬리를 붙인 글이 있음),
      latest(읽은 글 중 가장 늦은 서버 시각 — 다음 복구의 시작점) } */
export function foldNotices(rows, { now, tz }) {
  const today = dateIn(now, tz);
  const sent = {}; const bundles = { am: '', pm: '' }; const pre = new Set(); let capNoted = false; let latest = 0;
  for (const r of rows ?? []) {
    const a = r?.meta?.assistant;
    if (!a || typeof a !== 'object' || !Array.isArray(a.keys)) continue;
    const t0 = Date.parse(r.created_at);
    const t = Number.isFinite(t0) ? Math.min(t0, now) : now;
    if (Number.isFinite(t0) && t0 > latest) latest = t0;
    for (const k of a.keys) {
      if (typeof k !== 'string' || !k) continue;
      if (!(sent[k] >= t)) sent[k] = t;
      const m = SUM_RE.exec(k);
      if (m && m[2] > bundles[m[1]]) bundles[m[1]] = m[2];
    }
    if (dateIn(t, tz) === today) {
      if (a.kind === 'pre' && typeof a.keys[0] === 'string') pre.add(a.keys[0]);
      if (a.capNote === true) capNoted = true;
    }
  }
  return { today, sent, bundles, instant: pre.size, capNoted, latest };
}

/** 로컬 상태와 합치기(순수, st를 고친다). 보낸 키는 합집합, 묶음 날짜·오늘 수는 큰 쪽. 다른 기기(·다른 방)가 이미 보낸 글이 대기열에 있으면 넣지 않고 비운다
    (23505 0) — 묶음이면 그 안의 보낸 적 없는 지난 일정은 보류 목록으로 돌려 다음 묶음에. 보류 목록에서도 이미 보낸 항목을 뺀다. */
export function mergeRecovered(st, rec) {
  for (const [k, t] of Object.entries(rec.sent)) if (!(k in st.sent)) st.sent[k] = t;
  for (const lane of ['am', 'pm']) if (rec.bundles[lane] > (st.bundles[lane] || '')) st.bundles[lane] = rec.bundles[lane];
  if (st.day.date === rec.today) {
    st.day.instant = Math.max(st.day.instant, rec.instant);
    if (rec.capNoted) st.day.capNoted = true;
  }
  st.pending = st.pending.filter((p) => !st.sent[p.key]);
  const ob = st.outbox;
  if (ob && st.sent[ob.basis]) {
    const have = new Set(st.pending.map((p) => p.key));
    for (const p of Array.isArray(ob.items) ? ob.items : []) if (p && typeof p.key === 'string' && !st.sent[p.key] && !have.has(p.key)) st.pending.push(p);
    st.outbox = null;
  }
  return st;
}
