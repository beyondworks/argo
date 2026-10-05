// 첨부 업로드 한도 — 라우트(chat/upload)·화면(보내기 전 확인)·next.config(미들웨어 본문 한도)가 함께 쓰는 한 곳(2차 검수 M3·4차 검수, 2026-10-05).
// 문제 1(M3): Next 미들웨어가 요청 본문을 10MB까지만 복제해(experimental.middlewareClientMaxBodySize 기본값) 11MB 첨부가 라우트의 "파일당 10MB" 안내까지 가지 못하고
//   "Failed to parse body as FormData."로 끝났고, 10MB 파일도 multipart 머리 때문에 같은 실패였다(실측: 10,444,800바이트 통과·10,485,760 실패).
// 문제 2(4차): 그 한도는 미들웨어가 잡는 모든 요청(정적 자산 밖 전부)의 요청당 버퍼 상한이다. 합계 20MB 기준으로 21MB를 주자 다른 라우트도 요청당 두 배를 버퍼했다
//   (/api/ping에 20MB POST 8개 동시 — 검수 실측 RSS 409→592MB, 마감 실측 21MB 208→497MB·이 한도 210→374MB). 그래서 요청 하나에 파일 하나만 보내고(화면이 파일마다 따로 보낸다),
//   본문 한도는 "파일 하나 + multipart 머리 여유"로 둔다. 업로드 라우트만 미들웨어에서 빼는 길은 Host 검사(DNS 리바인딩 방어)가 빠져 쓰지 않는다.
export const MiB = 1024 * 1024;
export const UPLOAD_MAX_FILE_BYTES = 10 * MiB; // 파일 하나(= 요청 하나)
// multipart 머리 여유 — 경계 줄·Content-Disposition(파일 이름)·Content-Type·끝 경계. 실측(10MiB 파일): 크롬 192~953바이트·Node(undici) 180~941바이트·curl 211~498바이트
// (최댓값은 파일 이름 255바이트를 전부 따옴표로 채운 경우 — 따옴표는 %22 세 바이트). 64KiB는 그 수십 배라 정상 파일이 머리 때문에 잘릴 일이 없고, 기본 10MiB보다 0.6%만 크다.
export const UPLOAD_MULTIPART_ALLOWANCE_BYTES = 64 * 1024;
export const UPLOAD_BODY_LIMIT_BYTES = UPLOAD_MAX_FILE_BYTES + UPLOAD_MULTIPART_ALLOWANCE_BYTES; // 미들웨어 본문 한도(next.config) — 라우트도 Content-Length로 같은 값을 본다

/** 보내기 전·받은 뒤 공용 판정 — files = [{ size }]. null(문제 없음) | 'upload_too_large'(파일 하나가 한도 초과). 코드는 app/apimsg.mjs 사전에 있다.
    합계 한도는 없다 — 파일마다 요청이 따로라 요청 하나의 크기는 파일 하나로 정해진다. */
export function uploadSizeProblem(files) {
  return Array.from(files ?? []).some((f) => (f?.size ?? 0) > UPLOAD_MAX_FILE_BYTES) ? 'upload_too_large' : null;
}
