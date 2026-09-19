// 메신저 방에 올리는 실패 글 — 로컬 오류 원문을 방(손님 포함 방 사람 전원)에 싣지 않는다(검수 D26, 정비사 원장 P-C13).
// 실측: 모델 실패 때 손님 화면에 "처리 실패: API Error … check your inference gateway (127.0.0.1:5291)"가 그대로 올라와 주인 쪽 로컬 엔드포인트가 드러났다.
// 첨부 실패도 같은 모양 — 파일 읽기 오류 원문(EACCES 등)에는 주인 컴퓨터의 절대 경로가 들어 있다.
// 상세는 주인에게만: 실패 턴은 chat()이 회사 활동 로그에 원문과 함께 남기고(appendEvent ok:false), 게이트웨이는 로컬 콘솔에 남긴다.
import { pick } from './protocol.mjs';

/** 크루 턴 실패 — 방에 올리는 일반 문구(원문 없음). */
export const roomTurnFailure = (lang = 'ko') => pick(
  '에이전트가 지금 답하지 못했습니다. 주인이 Argo 활동에서 원인을 확인할 수 있습니다.',
  'The agent could not answer right now. Its owner can see the cause in Argo activity.', lang);

/** 첨부 한 건 실패 사유 — 우리가 만든 사유(없음·크기)만 그대로, 그 밖의 원문(경로가 들어 있을 수 있음)은 일반 사유로. */
export function roomAttachReason(e, lang = 'ko') {
  const msg = String(e?.message ?? e ?? '');
  if (/ENOENT/.test(msg)) return pick('파일이 없습니다', 'file not found', lang);
  if (e?.roomSafe) return msg.slice(0, 80); // 게이트웨이가 직접 만든 사유(예: 25MB 초과)
  return pick('파일을 읽거나 올리지 못했습니다', 'could not read or upload the file', lang);
}
