// 전송 카드의 제목과 오류 줄을 고른다(순수). 연결 끊김은 제목이 곧 안내라 오류 줄이 없고,
// 첨부만 실패한 카드(메시지는 게시됨)는 제목은 '일부 첨부를 보내지 못했다'를 유지하고 줄에 이유와 실패한 파일 이름을 남긴다(#793 검수 LOW-1).
const OFFLINE = 'msg.delivery.offline';
// 영구 거절(job.permanent — RLS 42501)은 다시 보내기를 숨기고 이유만: 1:1은 '보낼 수 없는 상대입니다', 그 밖 방은 '이 방에 보낼 수 없습니다'(기능 점검 D14).
// 첨부만 보낸 글(본문 없음)의 실패는 '첨부를 올리지 못했습니다' + [다시 시도·지우기](MSG-06), 그 밖의 그만두기는 보내지 못한 글·파일을 입력창으로 되돌린다
// ([입력창으로 되돌리기] — '재시도 그만두기'가 글을 지웠다, UX 판독). retryKey·dismissKey = 두 단추 문구.
export function deliveryCardView({ busy, job, isDm = false }) {
  if (busy) return { titleKey: 'msg.delivery.sending', errorLine: null, canRetry: false };
  const canRetry = !job.permanent;
  const offline = job.errorKey === OFFLINE;
  const attachOnly = !job.body && (job.files?.length ?? 0) > 0;
  const titleKey = job.permanent ? 'msg.delivery.notSent' : offline && !job.messageId ? OFFLINE : attachOnly ? 'msg.delivery.attachOnlyFailed' : job.messageId ? 'msg.delivery.attachFailed' : 'msg.delivery.failed';
  const keys = { retryKey: attachOnly ? 'msg.delivery.retryUpload' : 'msg.delivery.retry', dismissKey: attachOnly ? 'msg.delivery.discard' : canRetry ? 'msg.delivery.toComposer' : 'ui.close' };
  if (!job.error || (offline && !job.messageId)) return { titleKey, errorLine: null, canRetry, ...keys };
  const files = job.messageId ? (job.files ?? []).filter((f) => !f.done).map((f) => f.file.name) : [];
  // 무료 첨부 저장 한도(서버 20261011150000) — 업로드는 storage-api가 원문을 숨겨 'database error, code: PT402', 첨부 행은 'msgr_storage_limit'.
  // 후속(#944 병합 뒤): 플랜 카드로 잇는 목록 pro-checkout.mjs PRO_UPSELL에 msgr_storage_limit: 'err.storageLimit' 한 줄 + 이 카드 줄에서 플랜 카드 열기(iOS 제외)
  const storageFull = /\bmsgr_storage_limit\b|\bcode: PT402\b/.test(job.error);
  const key = job.errorKey === 'msg.delivery.rejected' && isDm ? 'msg.delivery.unreachable' : job.errorKey || (storageFull ? 'err.storageLimit' : /msgr_runtime_update_required/.test(job.error) ? 'dm.delivery.blocked' : null);
  return { titleKey, errorLine: { key, raw: key ? null : job.error, files: offline || job.errorKey || storageFull ? files : [] }, canRetry, ...keys };
}
