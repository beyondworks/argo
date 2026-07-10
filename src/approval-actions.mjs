// 결재 처리의 공통 동작 — 웹 결재함과 메신저 버튼이 같은 경로를 탄다.
import { resolveApproval } from './approvals.mjs';
import { chat } from './chat.mjs';
import { loadThread, appendTurn } from './thread.mjs';

/** 상태 변경 + 해당 크루 스레드에서 후속 턴(승인=실행, 거절=대안 정리). 후속 턴은 await 없이 부를 수 있다. */
export async function resolveWithFollowUp(wsId, id, approve) {
  const item = await resolveApproval(wsId, id, approve);
  followUp(wsId, item, approve).catch((e) => console.error('[argo] 결재 후속 턴 실패:', e.message));
  return item;
}

async function followUp(wsId, item, approve) {
  const msg = approve
    ? `(사장 결재) 요청한 "${item.action}" 이(가) 승인되었다. 이제 실행하고 결과를 보고하라.`
    : `(사장 결재) 요청한 "${item.action}" 이(가) 거절되었다. 실행하지 말고, 대안이 있으면 한두 줄로 정리하라.`;
  const t = await loadThread(wsId, item.slug);
  const r = await chat(wsId, item.slug, msg, t.sessionId);
  await appendTurn(wsId, item.slug, { userMsg: msg, reply: r.reply, handover: r.handover, sessionId: r.sessionId });
  return r;
}
