// 결재 처리의 공통 동작 — 웹 결재함·대화창 카드·메신저 버튼이 같은 경로를 탄다.
import { resolveApproval } from './approvals.mjs';
import { updateCapabilities } from './capabilities.mjs';
import { chat } from './chat.mjs';
import { loadThread, appendTurn } from './thread.mjs';

/** 상태 변경 + 후속 처리. kind:'tool'은 대기 중인 턴이 스스로 재개하므로 후속 턴이 없다.
    kind:'capability'는 승인 시 능력을 켜고, kind:'profile'/'hire'는 승인 시 서버가 payload를
    실행(카드 수정·영입)한 뒤 — 후속 턴이 결과를 사용자에게 보고한다. */
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

/** profile/hire 승인 — payload를 서버가 직접 적용. 성공 요약 문자열을 돌려준다(후속 턴 메시지 재료). */
async function applyPayload(wsId, item) {
  const p = item.payload ?? {};
  if (item.kind === 'profile') {
    const { updateAgentMeta, appendAgentRule } = await import('./persona.mjs');
    const changes = p.changes ?? {};
    let after = null;
    if (Object.keys(changes).length) after = await updateAgentMeta(wsId, p.slug, changes);
    if (p.rule) after = await appendAgentRule(wsId, p.slug, p.rule);
    return `적용 완료 — ${after?.name ?? p.slug}의 프로필이 변경되었다.`;
  }
  if (item.kind === 'hire') {
    const { createAgentFromPrompt, updateAgentMeta } = await import('./persona.mjs');
    const agent = await createAgentFromPrompt(wsId, p.brief, { name: p.name, team: p.team });
    if (p.runner || p.model) {
      await updateAgentMeta(wsId, agent.slug, { ...(p.runner ? { runner: p.runner } : {}), ...(p.model ? { model: p.model } : {}) });
    }
    // 영입 시운전 — 새 크루가 스스로 첫 인사+샘플 산출물을 만든다(영입 API와 동일 경로)
    import('./trial.mjs').then((m) => m.runTrialTurn(wsId, agent.slug)).catch(() => {});
    return `영입 완료 — ${agent.name}(${agent.slug})이(가) 합류했고 첫 시운전을 시작했다.`;
  }
  return '';
}

async function followUp(wsId, item, approve) {
  let msg;
  if ((item.kind === 'profile' || item.kind === 'hire') && approve) {
    // 서버가 payload를 먼저 적용하고, 결과를 크루가 사용자에게 보고한다(크루 재실행 금지 — 이중 적용 방지)
    let outcome;
    try {
      outcome = await applyPayload(wsId, item);
    } catch (e) {
      outcome = `적용 실패: ${String(e.message || e).slice(0, 160)}`;
    }
    msg = `(사장 결재) "${item.action}" 이(가) 승인되었고 시스템이 처리했다 — ${outcome}\n결과를 사용자에게 한두 줄로 보고하라. 다시 실행하려 하지 마라(이미 처리됨).`;
  } else {
    msg = item.kind === 'capability'
      ? (approve
        ? `(사장 결재) "${item.action}" 이(가) 승인되어 능력이 켜졌다. 직전에 받은 요청을 이어서 실행하고 결과를 보고하라.`
        : `(사장 결재) "${item.action}" 이(가) 거절되었다. 그 능력 없이 가능한 대안을 한두 줄로 정리하라.`)
      : approve
      ? `(사장 결재) 요청한 "${item.action}" 이(가) 승인되었다. 이제 실행하고 결과를 보고하라.`
      : `(사장 결재) 요청한 "${item.action}" 이(가) 거절되었다. 실행하지 말고, 대안이 있으면 한두 줄로 정리하라.`;
  }
  const t = await loadThread(wsId, item.slug);
  const r = await chat(wsId, item.slug, msg, t.sessionId);
  await appendTurn(wsId, item.slug, { userMsg: msg, reply: r.reply, handover: r.handover, sessionId: r.sessionId });
  return r;
}
