// 첨부만 보낸 글의 모양(2026-10-05 분리 검증 MSG-06). 전송은 글 행을 먼저 넣고 파일을 올린다(저장 경로 3번째 칸 = 글 번호 — 서버 함수가 본다).
// 그래서 첨부가 붙기 전까지 본문 없는 글이 모두에게 보이고(빈 말풍선), 업로드가 전부 실패하면 거둔 글이 남에게 '삭제되었습니다'로 남았다.
export const UPLOAD_GRACE_MS = 120_000; // 이보다 오래된 빈 글은 거두지 못한 실패로 보고 숨긴다(보낸 사람이 아직 올리는 중이면 예외)

/** 업로드가 전부 실패해 보낸 앱이 거둔 글 — 지운 시각을 고친 시각에도 같이 남긴다(composer-delivery discard). 사용자가 지운 글은 고친 시각이 없거나 다르다. */
export function isDiscardedUpload(m) {
  return !!m?.deleted_at && !!m.edited_at && m.edited_at === m.deleted_at && !String(m.body ?? '').trim();
}

/** 글 하나를 어떻게 그릴까 → 'bubble'(말풍선) | 'files'(첨부 줄만) | 'uploading'(올리는 중 자리표시) | 'hidden'(그리지 않음).
    attCount: 붙은 첨부 수(null = 아직 못 읽음), uploading: 이 기기가 지금 그 글의 파일을 올리는 중, now: 지금 시각. */
export function messageShape(m, { attCount = 0, uploading = false, now = Date.now() } = {}) {
  if (isDiscardedUpload(m)) return 'hidden';
  if (m.deleted_at || m.kind === 'system') return 'bubble';
  const text = String(m.body ?? '').trim();
  const extras = !!m.reply_to || !!m.meta?.relay || (m.mentions ?? []).some((r) => r?.kind === 'crew' && ['to', 'cc'].includes(r.role)) || (Number.isInteger(m.meta?.handoff_dropped) && m.meta.handoff_dropped > 0);
  if (text || extras) return 'bubble';
  if (attCount > 0) return 'files';
  const fresh = m.pending || uploading || !(now - Date.parse(m.created_at) > UPLOAD_GRACE_MS);
  if (fresh) return 'uploading';
  return attCount === null ? 'files' : 'hidden'; // 못 읽은 오래된 글은 숨기지 않는다(빈 첨부 메우기가 다시 읽는다)
}
