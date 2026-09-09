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
