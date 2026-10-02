// 전송 카드의 제목과 오류 줄을 고른다(순수). 연결 끊김은 제목이 곧 안내라 오류 줄이 없고,
// 첨부만 실패한 카드(메시지는 게시됨)는 제목은 '일부 첨부를 보내지 못했다'를 유지하고 줄에 이유와 실패한 파일 이름을 남긴다(#793 검수 LOW-1).
const OFFLINE = 'msg.delivery.offline';
// 영구 거절(job.permanent — RLS 42501)은 다시 보내기를 숨기고 이유만: 1:1은 '보낼 수 없는 상대입니다', 그 밖 방은 '이 방에 보낼 수 없습니다'(기능 점검 D14).
export function deliveryCardView({ busy, job, isDm = false }) {
  if (busy) return { titleKey: 'msg.delivery.sending', errorLine: null, canRetry: false };
  const canRetry = !job.permanent;
  const offline = job.errorKey === OFFLINE;
  const titleKey = job.permanent ? 'msg.delivery.notSent' : offline && !job.messageId ? OFFLINE : job.messageId ? 'msg.delivery.attachFailed' : 'msg.delivery.failed';
  if (!job.error || (offline && !job.messageId)) return { titleKey, errorLine: null, canRetry };
  const files = job.messageId ? (job.files ?? []).filter((f) => !f.done).map((f) => f.file.name) : [];
  const key = job.errorKey === 'msg.delivery.rejected' && isDm ? 'msg.delivery.unreachable' : job.errorKey || (/msgr_runtime_update_required/.test(job.error) ? 'dm.delivery.blocked' : null);
  return { titleKey, errorLine: { key, raw: key ? null : job.error, files: offline || job.errorKey ? files : [] }, canRetry };
}
