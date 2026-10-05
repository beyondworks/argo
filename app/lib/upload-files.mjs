// 첨부 업로드 화면 함수 — 크루 대화·회의실이 같이 쓴다(2차 검수 M3). 보내기 전에 한도를 확인해 넘으면 요청 없이 사전 문구로 안내하고,
// 서버 응답은 api()와 같은 규칙(responseError)으로 오류를 만든다 — JSON이 아닌 응답(본문 파싱 실패 등)의 원문은 화면에 나오지 않는다(failureReason이 상태별 일반 문구로).
import { uploadSizeProblem } from './upload-limit.mjs';
import { errorTextFor } from '../apimsg.mjs';
import { responseError } from './error-text.mjs';

/** 업로드 — files = File 배열. 성공하면 서버가 돌려준 files 배열. fetchImpl은 테스트가 바꾼다. */
export async function uploadAttachments(ws, files, lang, fetchImpl = (...a) => globalThis.fetch(...a)) {
  const problem = uploadSizeProblem(files);
  if (problem) { // 보내기 전에 막는다 — 서버(미들웨어)까지 가면 안내가 아니라 파싱 오류가 된다
    throw Object.assign(new Error(errorTextFor({ errorCode: problem }, 413, lang)), { data: { errorCode: problem }, status: 413 });
  }
  const fd = new FormData();
  files.forEach((f) => fd.append('file', f));
  const res = await fetchImpl(`/api/companies/${ws}/chat/upload`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw responseError(res, data, lang);
  return data.files ?? [];
}
