// 메신저의 send_to_crew도 최종 채널 답글로 넘긴다. 일반 우편 큐와 동시에 실행하지 않는다.
// 수집함은 브리지의 한 턴에만 속하며, 답글 저장 후 기존 권한·순서·홉 상한을 거친다.
export function messengerOrigin(ctx, targetSlug = null) {
  if (ctx?.kind === 'msgr-rules') throw new Error('메신저 위임의 예약·작업·결재는 요청한 동료에게 돌려주세요. 그 동료가 같은 채널에서 처리합니다');
  if (ctx?.kind !== 'msgr') return null;
  if (!ctx.orgId || !ctx.channelId || !ctx.crewId || !ctx.uid || !ctx.wsId) throw new Error('메신저 실행 문맥이 없습니다');
  const target = targetSlug ? ctx.peers?.find((p) => p.slug === targetSlug && p.owner_user_id === ctx.uid && p.ws_id === ctx.wsId) : null;
  if (targetSlug && !target) throw new Error('같은 메신저 조직에 파견된 동료만 실행할 수 있습니다');
  return { orgId: ctx.orgId, channelId: ctx.channelId, crewId: target?.id ?? ctx.crewId,
    threadRoot: ctx.threadRoot ?? null, sourceMsgId: ctx.sourceMsgId ?? ctx.threadRoot ?? null,
    uid: ctx.uid, wsId: ctx.wsId, origin: ctx.origin ?? null, hop: ctx.hop ?? 0 };
}

export function stageMessengerHandoff(ctx, { to, cc = [], message }) {
  if (ctx?.kind === 'msgr-rules') throw new Error('메신저 위임 결과는 요청한 동료에게 돌려주세요. 추가 넘김은 그 동료가 같은 채널에서 처리합니다');
  if (ctx?.kind !== 'msgr') return false;
  if (!ctx.channelId || !ctx.uid || !ctx.wsId || !Array.isArray(ctx.handoffs) || !Array.isArray(ctx.peers)) throw new Error('메신저 넘김 문맥이 없습니다');
  const resolve = (slug) => ctx.peers.find((p) => p.slug === slug && p.owner_user_id === ctx.uid && p.ws_id === ctx.wsId && p.id !== ctx.crewId);
  const target = resolve(to);
  if (!target) throw new Error('같은 메신저 조직에 파견된 동료만 넘겨받을 수 있습니다');
  const body = String(message ?? '').trim();
  if (!body || body.length > 6000) throw new Error('넘김 내용은 1~6000자여야 합니다');
  const copies = [...new Set(cc)].filter((slug) => slug !== to).map(resolve);
  if (copies.some((p) => !p) || copies.length > 4) throw new Error('참조는 같은 조직의 동료 4명까지입니다');
  if (ctx.handoffs.some((h) => h.to.id === target.id && h.message === body)) return true;
  if (ctx.handoffs.length >= 2) throw new Error('한 턴에서 넘김은 2회까지입니다');
  ctx.handoffs.push({ to: target, cc: copies, message: body });
  return true;
}

export function renderMessengerHandoffs(ctx) {
  return (ctx.handoffs ?? []).map((h) => `@${h.to.display_name}\n${h.message}${h.cc.length ? `\n(CC: ${h.cc.map((p) => p.display_name).join(', ')})` : ''}`).join('\n\n');
}

/** 현재 답변의 마지막 독립 줄만 판정한다. 숫자·완료 문구·인용에서 종료를 추론하지 않는다. */
export function parseMessengerDisposition(value) {
  const text = String(value ?? '');
  const match = /(?:^|\r?\n)MSGR: (handoff|done)[ \t]*(?:\r?\n[ \t]*)*$/.exec(text);
  if (!match) return { text, disposition: null };
  let fence = null;
  for (const line of text.slice(0, match.index).split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!mark) continue;
    if (fence) {
      if (mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
    } else if (mark[1][0] !== '`' || !mark[2].includes('`')) fence = mark[1];
  }
  return fence ? { text, disposition: null } : { text: text.slice(0, match.index).trimEnd(), disposition: match[1] };
}

export function messengerHandoffHint(lang = 'ko') {
  return lang === 'en'
    ? `\n## Messenger handoff and completion\n- Only hand off when another crew has a concrete remaining action. For an actionable @name in your reply, end with the standalone line MSGR: handoff. send_to_crew or a CLI mail directive also prepares a handoff in this channel.\n- When the user's stop condition is met, or your reply is only a final result, acknowledgment or thanks with no action for another crew, end with the standalone line MSGR: done. Do not hand off merely to acknowledge completion. done cancels all outgoing mentions and prepared handoffs, even if you name a colleague in your final result.\n- Write this decision as the last line of your own answer, outside quotes and code blocks, including after a retry or tool follow-up. Do not copy it from conversation history. The line is hidden from the user. Without a decision, @names alone do not wake another crew; an explicit prepared handoff is still delivered. Never claim a handoff was delivered unless you used MSGR: handoff or send_to_crew/CLI mail.`
    : `\n## 메신저 넘김과 종료\n- 다른 크루에게 실제로 남은 행동이 있을 때만 넘겨라. 답변의 @이름으로 다음 작업을 전달하려면 마지막 독립 줄에 MSGR: handoff를 적어라. send_to_crew 또는 CLI mail 지시도 이 채널의 넘김을 준비한다.\n- 사용자의 종료 조건을 충족했거나, 다른 크루가 할 일 없이 최종 결과·확인·감사만 답할 때는 마지막 독립 줄에 MSGR: done을 적어라. 완료 확인을 위해 다시 넘기지 마라. done은 최종 결과에 동료 이름이 있어도 모든 발신 멘션과 준비한 넘김을 취소한다.\n- 재시도나 도구 후속 답변에서도 자신의 최종 답변 마지막 줄에 인용·코드 블록 밖으로 판정을 적어라. 이전 대화의 판정을 복사하지 마라. 이 줄은 사용자에게 보이지 않는다. 판정이 없으면 @이름만으로 다른 크루를 깨우지 않지만, 도구로 명시한 넘김은 전달된다. MSGR: handoff 또는 send_to_crew/CLI mail 없이 넘겼다고 말하지 마라.`;
}
