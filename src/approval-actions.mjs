// 결재 처리의 공통 동작 — 웹 결재함·대화창 카드·메신저 버튼이 같은 경로를 탄다.
import { resolveApproval } from './approvals.mjs';
import { chat } from './chat.mjs';
import { loadThread, appendTurn } from './thread.mjs';
import { emitNotify } from './notify.mjs'; // 후속 턴 결과를 원 채널(메신저)로 — 카드 약속('이어서 보고합니다') 이행

/** 상태 변경 + 후속 처리. kind:'tool'은 대기 중인 턴이 스스로 재개하므로 후속 턴이 없다.
    kind:'profile'/'hire'는 승인 시 서버가 payload를 실행(카드 수정·영입)한 뒤 — 후속 턴이 결과를
    사용자에게 보고한다.
    kind:'capability'는 없어졌다(2026-07-30) — 능력이 설치 시점부터 전권이라 켤 것이 없다
    (capabilities.mjs). 옛 결재함에 남은 capability 항목은 여기서 특별 처리 없이 그냥 해소된다. */
export async function resolveWithFollowUp(wsId, id, approve, opts = {}) {
  const item = await resolveApproval(wsId, id, approve, opts);
  if (item.kind === 'loop') {
    // 루프 막힘(LOOP: blocked) 결재 — 승인이면 루틴을 다시 켠다(다음 틱에 재개), 거절이면 정지 유지.
    // 후속 턴을 돌리지 않는다: 재개된 루프의 다음 회차가 곧 후속이고, 여기서 턴을 더 쓰면 비용 이중.
    if (approve && item.payload?.routineId) {
      const { resumeLoop } = await import('./routines.mjs');
      await resumeLoop(wsId, item.payload.routineId).catch((e) => console.error('[argo] 루프 재개 실패:', e.message));
    }
    return item;
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
  if (item.kind === 'mcp') {
    // 크루 주도 도구 설치 — 카탈로그(검증된 목록) 또는 호스트 가져오기(이 컴퓨터의 Claude Code
    // 등록분)만 허용. 임의 command 지정은 크루에게 열지 않는다(프롬프트 인젝션 방어).
    // 신규 생성 경로는 전권 전환으로 소멸(chat.mjs가 즉시 설치) — 과거 버전이 쌓아둔 대기 항목 완결용 유지.
    const { installMcp, importHostMcp } = await import('./market.mjs');
    const src = p.source;
    const id = String(p.id ?? '');
    const r = src === 'host' ? await importHostMcp(wsId, id) : await installMcp(wsId, id);
    return `설치 완료 — 도구 "${r?.name ?? id}"가 이 회사에 연결되었다. 다음 턴부터 사용할 수 있다.`;
  }
  if (item.kind === 'connector') {
    // 커넥터 쓰기 — **서버가 실행한다**. 크루에게 "이제 실행하라"고 돌려주면 같은 게이트를 다시 만나
    // 결재가 무한히 쌓인다(게이트는 러너 무관 단일 지점이라 우회가 없다). approved 플래그로 한 번만 통과.
    const { callConnectorTool } = await import('./connectors.mjs');
    const { serverId, tool, args, lang } = p;
    // 카드에 뜬 것과 실제로 실행되는 것이 같아야 한다. action 문자열과 payload는 등록 시점에만
    // 맞춰지고 그 뒤 검증이 없었다 — CLI 러너(codex·gemini·antigravity)는 도구 게이트를 지나지 않아
    // 결재 파일을 직접 고칠 수 있으므로, 사장이 `create_event`를 보고 승인했는데 `delete_event`가
    // 실행될 수 있었다(분리 검수 지적 2026-08-01). 어긋나면 실행하지 않는다.
    if (item.action !== `${serverId} · ${tool}`) {
      return `실행 취소 — 결재 내용(${item.action})과 실행 대상(${serverId} · ${tool})이 다르다. 사장에게 다시 올려라.`;
    }
    const r = await callConnectorTool(wsId, serverId, tool, args ?? {}, { lang: lang ?? 'ko', approved: true });
    if (!r.ok) {
      const detail = r.content?.[0]?.text ?? r.error ?? '';
      return `실행 실패 — ${detail}`.slice(0, 300);
    }
    const text = (r.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n').slice(0, 600);
    return `실행 완료 — ${serverId}/${tool}${text ? `\n${text}` : ''}`;
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
  if ((item.kind === 'profile' || item.kind === 'hire' || item.kind === 'mcp' || item.kind === 'connector') && approve) {
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
  try {
    // 메신저발 결재의 후속 턴은 메신저 턴으로 — 파일 규약(messengerNote)을 받아야 '경로를 적으면
    // 첨부된다'가 작동한다(검수 M-1: 이게 없으면 승인 후속이 규약을 못 받는 유일한 턴이었다).
    const r = await chat(wsId, item.slug, msg, t.sessionId, item.tg?.chatId ? { source: 'messenger' } : {});
    await appendTurn(wsId, item.slug, { userMsg: msg, reply: r.reply, handover: r.handover, sessionId: r.sessionId, artifacts: r.artifacts });
    // 결재가 메신저에서 왔으면(item.tg) 후속 보고도 그 방으로 — 이 방송이 없어서 카드가
    // "이어서 보고합니다"라고 약속하고 영원히 무소식이었다(실사용 제보 2026-07-30). 파일 첨부는
    // sendTgReply의 경로 규약이 그대로 작동하므로 "승인 = 실제 발송"이 여기서 성립한다.
    emitNotify({ type: 'approval_followup', wsId, item, reply: r.reply });
    return r;
  } catch (e) {
    // 크루의 자연어 보고 턴이 실패해도(예산 초과·크루 삭제·모델 장애) 사용자는 결과를 알아야 한다.
    // profile/hire는 부작용이 이미 적용됐으므로, 최소한 처리 결과를 스레드에 남긴다(무통보 방지).
    const note = (item.kind === 'profile' || item.kind === 'hire') && approve
      ? `${msg}\n\n(자동 보고 실패 — 하지만 위 처리는 완료되었습니다: ${String(e.message || e).slice(0, 120)})`
      : `${msg}\n\n(후속 실행 실패: ${String(e.message || e).slice(0, 160)})`;
    await appendTurn(wsId, item.slug, { userMsg: msg, reply: note, handover: null, sessionId: t.sessionId }).catch(() => {});
    emitNotify({ type: 'approval_followup', wsId, item, reply: note }); // 실패도 무소식보다 통보가 낫다
    throw e;
  }
}
