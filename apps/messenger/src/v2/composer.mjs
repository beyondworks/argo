// 메신저 v2 보내기 발송기(U6c-1b) — 기존 입력창의 전달 흐름(src/composer-delivery.mjs: 먼저 그리기·재시도·실패 카드)을 그대로 쓰고,
// 실제로 보내는 부분만 연결 상태 기계(link/machine.mjs send)로 바꾼다. 기계는 글 넣기 → 파일마다 msgr2_attachment_add → 그 경로에 올리기를 한 번에 하고
// client_msg_id·(글, 순번)으로 멱등이다. 그래서 흐름의 '파일 올리기'·'첨부 행' 단계는 이미 끝난 것으로 넘긴다.
import { retryable } from '../link/policy.mjs';

/** job.mentions(옛 모양 [{ kind, id }]) → v2 멘션(에이전트 id, 20개까지). 사람 멘션은 v2 글에 없다. */
export const v2Mentions = (mentions) => [...new Set((mentions ?? []).filter((m) => m?.kind === 'crew' && m.id).map((m) => m.id))].slice(0, 20);

/** 기계가 받는 파일 모양. */
export const v2Files = (items) => (items ?? []).map((item) => ({ name: item.file?.name ?? 'file', mime: item.file?.type || 'application/octet-stream', bytes: item.file?.size ?? 0, data: item.file }));

// 다시 보내도 같은 결과인 거절 — 흐름이 다시 보내기를 권하지 않는다(옛 발송기의 42501과 같은 자리)
// 코드 이름: 기계 sendBlock(service_paused·update_required·device_revoked)·rejectCodeOf(rejected·invalid·too_large·login_required·device_unknown)·attachmentProblem(invalid_attachment)
const PERMANENT_KEYS = {
  invalid_attachment: 'msg.delivery.rejected', rejected: 'msg.delivery.rejected', invalid: 'msg.delivery.rejected', too_large: 'msg.delivery.rejected',
  invalid_envelope: 'msg.delivery.rejected', service_paused: 'msg.delivery.rejected', update_required: 'msg.delivery.rejected',
  login_required: 'msg.delivery.authExpired', device_revoked: 'msg.delivery.authExpired', device_unknown: 'msg.delivery.authExpired',
};

/** getMachine() — 지금 셸의 기계(없으면 보내지 않는다). chId — 이 입력창의 방. */
export function v2ComposerTransport(getMachine, { chId }) {
  return {
    async message(job) {
      const m = getMachine();
      if (!m) throw new Error('v2 link not ready');
      const r = await m.send({ roomId: chId, body: job.body ?? '', clientMsgId: job.clientId, replyTo: job.replyTo ?? null, mentions: v2Mentions(job.mentions), files: v2Files(job.files) });
      if (r.ok) return r.id;
      const code = r.code || 'internal';
      if (!retryable(code) && PERMANENT_KEYS[code]) throw Object.assign(new Error(code), { uiKey: PERMANENT_KEYS[code], permanent: true });
      throw new Error(code);
    },
    async upload() { return { existed: true }; }, // 기계가 이미 올렸다(경로는 서버가 정한다)
    async attachment() { /* 기계가 이미 첨부 행을 만들었다(msgr2_attachment_add) */ },
    // discard 없음: 첨부만 보낸 글은 기계가 파일을 넣기 전에 검사하고(attachmentProblem), 실패하면 같은 client_msg_id로 다시 보낸다
    preview() { /* 링크 미리보기 엣지 함수는 옛 표용 — v2는 아직 없다(U6c-1b 미룸) */ },
  };
}
