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
// 호출: 복구 1번 = 크루 행 1 + 방 1 + 방마다 글 1(보통 방 1~2개, 크루·방이 없으면 그 뒤는 0). 실패하면 5분 뒤 다시 — 매 틱 읽지 않는다.
// 읽는 범위(#894 분리 검수 M1 — 로컬 PG 14, 사용자 권한(RLS) EXPLAIN ANALYZE. 측정 방법·표는 PR #894 본문):
//  · 그 방을 처음 읽을 때(이 기기에 그 방의 끝 기록이 없음·아직 비서 글이 없는 방): 최근 14일. msgr_messages_client_id로 그 방의
//    에이전트 글 전부를 꺼내 거른다 — 에이전트 글 8,012개인 방에서 버퍼 약 33,100·61~104ms, 812개인 방에서 3,690·7~9ms(방 크기에 비례). 기기·방마다 한 번이다.
//  · 그 뒤(잠자기·재시작·기기 교대): 그 방에서 지난번에 본 마지막 비서 글 id보다 큰 글만(rec.last). msgr_messages_channel_id_id 범위라
//    두 방 모두 버퍼 397~409·약 1ms(방 크기와 무관 — 방이 테이블의 작은 비율이면 통계가 낡아도 같은 계획). 작성자 종류(author_kind)는 서버에서 거르지 않는다 —
//    넣으면 계획이 msgr_messages_client_id로 바뀌어 방의 에이전트 글에 비례했다(큰 방 1,062 대 409). 거름은 받은 뒤 여기서 한다.
//    한 방이 테이블 대부분인 인위 상황에서 통계가 낡으면 기본 키 역순 훑기를 골라 테이블 전체의 끝 뒤 글 수에 비례했다(6만 건에 2,105·9~11ms).
//  · 오늘 즉시 알림 수는 오늘 시작 전 알림 키를 모아(day.keys) 합집합으로 센다 — 읽은 범위가 일부여도 겹쳐 세지 않는다.
import { SENT_KEEP_MS } from './state.mjs';
import { dateIn } from './rules.mjs';

export const RECOVER_LIMIT = 300;
export const RECOVER_RETRY_MS = 5 * 60_000;
export const DAY_KEYS_MAX = 500; // 오늘 시작 전 알림 키 — 하루 알림 수보다 넉넉히(상태 파일이 커지지 않게)
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

/** 방 글 읽기 — 크루 행 → 이미 있는 1:1 방 → 방마다 비서 글. after = { 방 id: 지난번에 본 마지막 비서 글 id }(없으면 그 방은 14일).
    반환 = { rows: [{ id, meta, created_at }], last: { 방 id: 이번에 본 마지막 비서 글 id } }(새 글이 없으면 지난 값 그대로, 처음인데 글이 없으면 그 방은 빠진다 —
    다음 복구도 14일을 읽는다. 방의 맨 끝 id를 따로 읽지 않는 이유: 통계가 낡으면 기본 키 역순 훑기를 골라 테이블 전체의 새 글에 비례했다). 서버가 거절하면 던진다. */
export async function readRoomNotices(c, targets, { now, after = {} }) {
  const want = new Set(targets.map((t) => `${t.ws}\n${t.agent}`));
  const crews = ((await c.db.personalCrewsOf(c.uid, [...new Set(targets.map((t) => t.ws))])) ?? [])
    .filter((r) => r && r.id && r.org_id == null && want.has(`${r.ws_id}\n${r.slug}`));
  const rows = []; const last = {};
  if (!crews.length) return { rows, last };
  const pairs = new Set(crews.map((r) => `crew:${r.id}`));
  const rooms = ((await c.db.personalRoomsOf(crews.map((r) => r.id))) ?? []).filter((r) => r?.id && pairs.has(r.personal_pair));
  const sinceIso = new Date(now - SENT_KEEP_MS).toISOString();
  for (const r of rooms) { // 방 하나씩(인덱스 — msgr.mjs assistantNotices)
    const prev = Number.isFinite(Number(after[r.id])) && Number(after[r.id]) > 0 ? Number(after[r.id]) : null;
    const got = ((await c.db.assistantNotices(r.id, r.personal_pair.slice('crew:'.length), { afterId: prev, sinceIso, limit: RECOVER_LIMIT })) ?? [])
      .filter((x) => x && x.author_kind === 'crew'); // 끝 기록 뒤 읽기는 작성자 종류를 서버에서 거르지 않는다(위 머리 주석)
    rows.push(...got);
    const top = Math.max(prev ?? 0, ...got.map((x) => Number(x.id) || 0));
    if (top > 0) last[r.id] = top;
  }
  return { rows, last };
}

/** 글 → 복구 값(순수). 0.1.99(엔진 2)가 쓴 글도 같은 모양이다(meta.assistant.keys·kind). 반환:
    { today, sent: { 키: 보낸 시각 }, bundles: { am, pm }(처리한 가장 늦은 날짜), todayPre(오늘 보낸 시작 전 알림 키 — 두 방에 같은 키가 있어도 하나),
      capNoted(오늘 하루 한도 꼬리를 붙인 글이 있음) } */
export function foldNotices(rows, { now, tz }) {
  const today = dateIn(now, tz);
  const sent = {}; const bundles = { am: '', pm: '' }; const pre = new Set(); let capNoted = false;
  for (const r of rows ?? []) {
    const a = r?.meta?.assistant;
    if (!a || typeof a !== 'object' || !Array.isArray(a.keys)) continue;
    const t0 = Date.parse(r.created_at);
    const t = Number.isFinite(t0) ? Math.min(t0, now) : now;
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
  return { today, sent, bundles, todayPre: [...pre], capNoted };
}

/** 로컬 상태와 합치기(순수, st를 고친다). 보낸 키·오늘 시작 전 알림 키는 합집합, 묶음 날짜는 큰 쪽. 다른 기기(·다른 방)가 이미 보낸 글이 대기열에 있으면 넣지 않고 비운다
    (23505 0) — 묶음이면 그 안의 보낸 적 없는 지난 일정은 보류 목록으로 돌려 다음 묶음에. 보류 목록에서도 이미 보낸 항목을 뺀다. */
export function mergeRecovered(st, rec) {
  for (const [k, t] of Object.entries(rec.sent)) if (!(k in st.sent)) st.sent[k] = t;
  for (const lane of ['am', 'pm']) if (rec.bundles[lane] > (st.bundles[lane] || '')) st.bundles[lane] = rec.bundles[lane];
  if (st.day.date === rec.today) {
    // 오늘 수 = 오늘 키의 합집합. 키를 하루 처음부터 모은 상태면(keys 수 = instant) 그대로 키 수, 키가 없던 옛 상태 파일(0.1.99·이 PR 전)이면 큰 쪽
    const tracked = st.day.keys.length === st.day.instant;
    for (const k of rec.todayPre) if (!st.day.keys.includes(k) && st.day.keys.length < DAY_KEYS_MAX) st.day.keys.push(k);
    st.day.instant = tracked ? st.day.keys.length : Math.max(st.day.instant, st.day.keys.length);
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
