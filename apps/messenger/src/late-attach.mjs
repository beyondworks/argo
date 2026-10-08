// 글보다 늦게 붙는 첨부 — 놓친 'attach' 방송 되찾기(C-a 인접 경로, 2026-10-08).
// 에이전트·봇·사람 첨부는 글이 먼저 오르고 파일이 뒤에 등록된다(게이트웨이 deliverReplyFiles: 답 게시 → 파일마다 업로드 → 첨부 행, 한 답 최대 10개,
// 운영 실측 0.2~3.6초, 큰 파일은 더 길다). 서버는 첨부 행마다 'attach' 방송을 보내고(20260930160000) 열린 방은 그 글의 첨부를 다시 읽는다.
// 그 사이 실시간 연결이 끊기면(잠자기·와이파이 전환·폰 배경·가려진 창의 심박 끊김) 방송을 받을 수 없는데, 글은 이미 읽혀 있어(빈 첨부 또는 첫 파일만)
// 다시 붙은 뒤 따라잡기(새 글만)·빈 묶음 메우기(못 읽은 글만) 어느 쪽도 그 글을 다시 보지 않았다 — 방을 다시 열 때까지 파일 카드가 없거나 일부만 보였고,
// 본문 없는 첨부 글은 2분 뒤 숨겨졌다(attach-only.mjs). 로컬 스택 재현: 답 → 연결 끊김 → 첨부 등록 → 다시 붙음 → 18초 뒤에도 카드 없음 → 다시 열면 보임.
// 그래서 방송을 놓쳤을 수 있는 때(다시 붙음·끊긴 동안의 보정 조회)에만, 아직 첨부가 붙을 수 있는 글의 첨부를 다시 읽는다. 새 주기 조회는 만들지 않는다.
import { createCatchUp } from './refresh-messages.mjs';

/** 첨부가 아직 붙을 수 있는 시간 — 봇 첨부 등록 기한(_msgr_bot_attach_target: 글 뒤 1시간)과 같다. 게이트웨이·사람 첨부는 글 직후에 붙는다. */
export const LATE_ATTACH_WINDOW_MS = 60 * 60 * 1000;
/** 한 번에 다시 읽는 글 수 상한(조회 주소 길이) — 최신 글부터. */
export const LATE_ATTACH_MAX = 200;
/** 끊긴 동안 보정 조회(10초)가 같은 대상을 다시 읽는 간격 — 대상이 그대로면 같은 첨부를 10초마다 받지 않는다(DB 위생). 새 글이 대상에 들어오면 다음 회에 바로 읽는다. */
export const LATE_ATTACH_RECHECK_MS = 60 * 1000;

/** 다시 읽을 글 id — 첨부를 이미 읽은(못 읽은 글은 빈 묶음 메우기가 맡는다) 지우지 않은 일반 글(kind text) 중 기한 안에 쓴 것. 첨부 수는 보지 않는다 —
    여러 파일 답은 첫 파일만 보인 채 끊길 수 있다(1차 검수 M). 없으면 [] → 요청 0. */
export function lateAttachCandidates(msgs, atts, { now = Date.now(), windowMs = LATE_ATTACH_WINDOW_MS, max = LATE_ATTACH_MAX } = {}) {
  const ids = [];
  for (const m of msgs ?? []) {
    if (!Number.isFinite(m?.id) || m.deleted_at || (m.kind && m.kind !== 'text')) continue;
    if (!Array.isArray(atts?.[m.id])) continue;
    const born = Date.parse(m.created_at ?? '');
    if (!Number.isFinite(born) || now - born > windowMs) continue;
    ids.push(m.id);
  }
  return ids.slice(-max);
}

const attKey = (r) => r?.id ?? r?.storage_path;
/** 조회한 첨부 행을 화면 상태에 합친다 — 글 묶음(ids)마다 보이던 첨부 + 새로 받은 행(id 기준 합집합, 보이던 순서 유지). 처음 읽은 글에 행이 없으면 빈 묶음.
    첨부는 지우지 않으므로(보존 규칙·삭제 정책 없음) 보이는 첨부는 줄지 않는다 — 먼저 나간 조회(빈 결과·첫 파일만)가 더 완전한 다시 읽기보다 늦게 도착하는 경합(검수 LOW·1차 검수 M).
    바뀐 것이 없으면 cur를 그대로 돌려준다(같은 결과로 다시 그리지 않게). 첫 로드·새 글(hydrate)·attach 방송 다시 읽기·늦은 첨부 되찾기가 같은 규칙을 쓴다. */
export function mergeAttachments(cur, ids, rows) {
  const got = {};
  for (const r of rows ?? []) (got[r.message_id] ??= []).push(r);
  let next = null;
  for (const id of ids) {
    const have = cur?.[id];
    const seen = new Set((have ?? []).map(attKey));
    const add = (got[id] ?? []).filter((r) => { const k = attKey(r); if (seen.has(k)) return false; seen.add(k); return true; });
    if (Array.isArray(have) && !add.length) continue;
    (next ??= { ...cur })[id] = [...(have ?? []), ...add];
  }
  return next ?? cur;
}

/** 이번에 읽을지 — 대상이 없으면 0건. 다시 붙음(rejoined)은 늘 읽는다(그 사이 방송을 놓쳤을 수 있다).
    끊긴 동안 보정 조회는 첫 회, 지난 읽기 뒤 새 글이 대상에 들어왔을 때, 지난 읽기에서 recheckMs가 지났을 때만. */
export function lateAttachDue(last, ids, { now, rejoined = false, recheckMs = LATE_ATTACH_RECHECK_MS }) {
  if (!ids.length) return false;
  if (rejoined || !last) return true;
  return ids.some((id) => !last.ids.has(id)) || now - last.at >= recheckMs;
}

/** 늦은 첨부 되찾기 — snapshot()이 지금 화면의 { msgs, atts }, read(ids)가 그 글들의 첨부 행(조회 1건), apply(ids, rows)가 화면에 합친다(mergeAttachments).
    돌려준 함수는 ({ rejoined }) → 약속. 겹친 신호는 한 번에 하나(createCatchUp), 다시 붙음 몫은 실패해도 다음 회로 넘긴다. */
export function createLateAttach({ snapshot, read, apply, now = Date.now }) {
  let last = null; let rejoined = false;
  const run = createCatchUp(async () => {
    const t = now(); const { msgs, atts } = snapshot() ?? {};
    const ids = lateAttachCandidates(msgs, atts, { now: t });
    const force = rejoined; rejoined = false;
    if (!lateAttachDue(last, ids, { now: t, rejoined: force })) return;
    let rows;
    try { rows = await read(ids); } catch (e) { if (force) rejoined = true; throw e; }
    last = { ids: new Set(ids), at: t };
    apply(ids, rows);
  });
  return ({ rejoined: r = false } = {}) => { if (r) rejoined = true; return run(); };
}
