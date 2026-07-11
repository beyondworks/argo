// 결재 처리의 공통 동작 — 웹 결재함·대화창 카드·메신저 버튼이 같은 경로를 탄다.
import { resolveApproval } from './approvals.mjs';
import { updateCapabilities } from './capabilities.mjs';
import { chat } from './chat.mjs';
import { loadThread, appendTurn } from './thread.mjs';

/** 상태 변경 + 후속 처리. kind:'tool'은 대기 중인 턴이 스스로 재개하므로 후속 턴이 없다.
    kind:'capability'는 승인 시 능력을 켜고, 후속 턴이 원래 요청을 이어서 실행한다. */
export async function resolveWithFollowUp(wsId, id, approve) {
  const item = await resolveApproval(wsId, id, approve);
  if (item.kind === 'capability' && approve && item.cap) {
    await updateCapabilities(wsId, { [item.cap]: true });
  }
  if (item.kind !== 'tool') {
    followUp(wsId, item, approve).catch((e) => console.error('[argo] 결재 후속 턴 실패:', e.message));
  }
  return item;
}

async function followUp(wsId, item, approve) {
  const msg = item.kind === 'capability'
    ? (approve
      ? `(사장 결재) "${item.action}" 이(가) 승인되어 능력이 켜졌다. 직전에 받은 요청을 이어서 실행하고 결과를 보고하라.`
      : `(사장 결재) "${item.action}" 이(가) 거절되었다. 그 능력 없이 가능한 대안을 한두 줄로 정리하라.`)
    : approve
    ? `(사장 결재) 요청한 "${item.action}" 이(가) 승인되었다. 이제 실행하고 결과를 보고하라.`
    : `(사장 결재) 요청한 "${item.action}" 이(가) 거절되었다. 실행하지 말고, 대안이 있으면 한두 줄로 정리하라.`;
  const t = await loadThread(wsId, item.slug);
  const r = await chat(wsId, item.slug, msg, t.sessionId);
  await appendTurn(wsId, item.slug, { userMsg: msg, reply: r.reply, handover: r.handover, sessionId: r.sessionId });
  return r;
}
