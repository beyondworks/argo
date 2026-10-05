// 첨부 업로드 한도 — 라우트(chat/upload)·화면(보내기 전 확인)·next.config(미들웨어 본문 한도)가 함께 쓰는 한 곳(2차 검수 M3, 2026-10-05).
// 문제: Next 미들웨어가 요청 본문을 10MB까지만 복제해(experimental.middlewareClientMaxBodySize 기본값) 11MB 첨부가 라우트의 "파일당 10MB" 안내까지 가지 못하고
// "Failed to parse body as FormData."로 끝났고, 10MB 파일도 멀티파트 오버헤드로 같은 실패였다(실측: 10,444,800바이트 통과·10,485,760 실패).
export const MiB = 1024 * 1024;
export const UPLOAD_MAX_FILE_BYTES = 10 * MiB;       // 파일 하나
export const UPLOAD_MAX_REQUEST_BYTES = 20 * MiB;    // 한 번에 보내는 합계
export const UPLOAD_BODY_LIMIT_BYTES = UPLOAD_MAX_REQUEST_BYTES + MiB; // 미들웨어 본문 한도 — 멀티파트 오버헤드 여유 1MB

/** 보내기 전·받은 뒤 공용 판정 — files = [{ size }]. null(문제 없음) | 'upload_too_large'(파일 하나가 한도 초과) | 'upload_total_too_large'(합계 초과). 코드는 app/apimsg.mjs 사전에 있다. */
export function uploadSizeProblem(files) {
  const list = Array.from(files ?? []);
  if (list.some((f) => (f?.size ?? 0) > UPLOAD_MAX_FILE_BYTES)) return 'upload_too_large';
  if (list.reduce((n, f) => n + (f?.size ?? 0), 0) > UPLOAD_MAX_REQUEST_BYTES) return 'upload_total_too_large';
  return null;
}
