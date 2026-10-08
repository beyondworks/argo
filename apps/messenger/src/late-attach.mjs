// 글보다 늦게 붙는 첨부 — 놓친 'attach' 방송 되찾기(C-a, 2026-10-08).
// 에이전트·봇·사람 첨부는 글이 먼저 오르고 파일이 뒤에 등록된다(게이트웨이 deliverReplyFiles: 답 게시 → 업로드 → 첨부 행, 운영 실측 0.2~3.6초,
// 큰 파일은 더 길다). 서버는 첨부 행마다 'attach' 방송을 보내고(20260930160000) 열린 방은 그 글의 첨부를 다시 읽는다.
// 그 사이 실시간 연결이 끊기면(잠자기·와이파이 전환·폰 배경·가려진 창의 심박 끊김) 방송을 받을 수 없는데, 글은 이미 빈 첨부로 읽혀 있어
// 다시 붙은 뒤 따라잡기(새 글만)·빈 묶음 메우기(못 읽은 글만) 어느 쪽도 그 글을 다시 보지 않았다 — 방을 다시 열 때까지 파일 카드가 없고,
// 본문 없는 첨부 글은 2분 뒤 숨겨졌다(attach-only.mjs). 로컬 스택 재현: 답 → 연결 끊김 → 첨부 등록 → 다시 붙음 → 18초 뒤에도 카드 없음 → 다시 열면 보임.
// 그래서 방송을 놓쳤을 수 있는 때(다시 붙음·끊긴 동안의 보정 조회)에만, 아직 첨부가 붙을 수 있는 글의 첨부를 한 번 다시 읽는다. 주기 조회는 만들지 않는다.

/** 첨부가 아직 붙을 수 있는 시간 — 봇 첨부 등록 기한(_msgr_bot_attach_target: 글 뒤 1시간)과 같다. 게이트웨이·사람 첨부는 글 직후에 붙는다. */
export const LATE_ATTACH_WINDOW_MS = 60 * 60 * 1000;
/** 한 번에 다시 읽는 글 수 상한(조회 주소 길이) — 최신 글부터. */
export const LATE_ATTACH_MAX = 200;

/** 다시 읽을 글 id — 첨부를 이미 읽었는데 비어 있고(못 읽은 글은 빈 묶음 메우기가 맡는다), 지우지 않은 일반 글(kind text)이며, 기한 안에 쓴 것. 없으면 [] → 요청 0. */
export function lateAttachCandidates(msgs, atts, { now = Date.now(), windowMs = LATE_ATTACH_WINDOW_MS, max = LATE_ATTACH_MAX } = {}) {
  const ids = [];
  for (const m of msgs ?? []) {
    if (!Number.isFinite(m?.id) || m.deleted_at || (m.kind && m.kind !== 'text')) continue;
    const got = atts?.[m.id];
    if (!Array.isArray(got) || got.length) continue;
    const born = Date.parse(m.created_at ?? '');
    if (!Number.isFinite(born) || now - born > windowMs) continue;
    ids.push(m.id);
  }
  return ids.slice(-max);
}

/** 조회한 첨부 행을 화면 상태에 합친다 — 글 묶음(ids)마다 받은 행, 없으면 빈 묶음. 첨부는 지우지 않으므로(보존 규칙) 이미 보이는 첨부를 빈 결과로 덮지 않는다
    (첨부 등록 전에 나간 조회가 attach 방송의 다시 읽기보다 늦게 도착하는 경합 — 검수 LOW). 첫 로드·새 글(hydrate)과 늦은 첨부 다시 읽기가 같은 규칙을 쓴다. */
export function mergeAttachments(cur, ids, rows) {
  const n = { ...cur }; const got = {};
  for (const r of rows ?? []) (got[r.message_id] ??= []).push(r);
  for (const id of ids) n[id] = got[id] ?? (cur?.[id]?.length ? cur[id] : []);
  return n;
}
