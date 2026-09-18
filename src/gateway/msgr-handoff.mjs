// 메신저의 send_to_crew도 최종 채널 답글로 넘긴다. 일반 우편 큐와 동시에 실행하지 않는다.
// 수집함은 브리지의 한 턴에만 속하며, 답글 저장 후 기존 권한·순서·홉 상한을 거친다.
export function messengerOrigin(ctx, targetSlug = null) {
  if (ctx?.kind === 'msgr-rules') throw new Error('메신저 위임의 예약·작업·결재는 요청한 동료에게 돌려주세요. 그 동료가 같은 채널에서 처리합니다');
  if (ctx?.kind !== 'msgr') return null;
  if (!ctx.orgId || !ctx.channelId || !ctx.crewId || !ctx.uid || !ctx.wsId) throw new Error('메신저 실행 문맥이 없습니다');
  const target = targetSlug ? ctx.peers?.find((p) => p.slug === targetSlug && p.owner_user_id === ctx.uid && p.ws_id === ctx.wsId) : null;
  if (targetSlug && !target) throw new Error('같은 메신저 조직에 파견된 동료만 실행할 수 있습니다');
  return { orgId: ctx.orgId, channelId: ctx.channelId, ...(ctx.channelKind === 'dm' ? { channelKind: 'dm', ...(ctx.delegated === true ? { delegated: true } : {}) } : {}), crewId: target?.id ?? ctx.crewId,
    threadRoot: ctx.threadRoot ?? null, sourceMsgId: ctx.sourceMsgId ?? ctx.threadRoot ?? null,
    uid: ctx.uid, wsId: ctx.wsId, origin: ctx.origin ?? null, hop: ctx.hop ?? 0,
    // 손님 표지는 사슬을 따라간다 — 쪽지·예약·결재로 옮겨 탄 뒤에도 "주인이 시킨 일"로 되살아나지 않게(넘김 뒤 쪽지는 rootAuthor를 잃는다).
    ...(ctx.rootAuthor ? { rootAuthor: ctx.rootAuthor } : {}), ...(isGuestCtx(ctx) ? { guest: true } : {}) };
}

/** messengerOrigin 기록 → 턴 맥락(kind:'msgr')의 역방향. 요청자 사슬(uid·origin·rootAuthor·guest)을 **그대로** 옮긴다 —
    빠뜨리면 손님 판정(isGuestCtx)이 맥락을 몰라 손님 사슬이 주인 턴으로 되살아나거나(승격), 주인의 흐름까지 손님이 된다(fail-closed).
    쪽지(scheduler) 수신 턴이 쓴다. extra는 수신 쪽 사실(수신 크루 id·채널 이름 등)만. */
export function mirrorCtxFromOrigin(o, extra = {}) {
  return { kind: 'msgr', orgId: o.orgId, channelId: o.channelId, threadRoot: o.threadRoot ?? null,
    uid: o.uid ?? null, wsId: o.wsId ?? null, origin: o.origin ?? null,
    ...(o.rootAuthor ? { rootAuthor: o.rootAuthor } : {}), ...(o.guest === true ? { guest: true } : {}), ...extra };
}

/** 손님 턴 판정 — 이 메신저 턴을 크루 주인이 아닌 사람이 시켰는가(규칙 7·9: 주인의 몸은 주인만, 주인의 개인 기억은 공유한 것만).
    origin = 권한 주체(사람 글이면 작성자, 크루 넘김이면 **넘긴 크루의 주인** — msgr.mjs drain), rootAuthor = 넘김 스레드의 뿌리 사람.
    그래서 origin만 보면 "손님 B → A의 크루 X → A의 크루 Y" 넘김에서 Y가 주인 턴이 된다 — 뿌리도 함께 본다.
    **fail-closed**: 메신저 맥락인데 주인(uid)·시킨 사람(origin)을 모르면 손님이다. 한 번 손님이 된 사슬(guest)은 끝까지 손님이다.
    메신저 밖 턴(웹·텔레그램 — 페어링된 소유자만 턴을 돌린다)은 해당 없음. */
export function isGuestCtx(ctx) {
  if (ctx?.kind !== 'msgr') return false;
  if (ctx.guest === true) return true;
  if (!ctx.uid || !ctx.origin || ctx.origin !== ctx.uid) return true;
  return !!ctx.rootAuthor && ctx.rootAuthor !== ctx.uid;
}

export function stageMessengerHandoff(ctx, { to, cc = [], message }) {
  if (ctx?.kind === 'msgr-rules') throw new Error('메신저 위임 결과는 요청한 동료에게 돌려주세요. 추가 넘김은 그 동료가 같은 채널에서 처리합니다');
  if (ctx?.kind !== 'msgr') return false;
  if (!ctx.channelId || !ctx.uid || !ctx.wsId || !Array.isArray(ctx.handoffs) || !Array.isArray(ctx.peers)) throw new Error('메신저 넘김 문맥이 없습니다');
  const resolve = (key) => {
    const candidates = ctx.peers.filter((p) => p.id !== ctx.crewId);
    const exact = candidates.find((p) => p.id === key);
    if (exact) return exact;
    const matches = candidates.filter((p) => p.slug === key);
    return matches.length === 1 ? matches[0] : null;
  }; // peers is the freshly authorized organization/thread envelope, never a local slug fallback
  const target = resolve(to);
  if (!target) throw new Error('같은 메신저 조직에 파견된 동료만 넘겨받을 수 있습니다');
  const body = String(message ?? '').trim();
  if (!body || body.length > 6000) throw new Error('넘김 내용은 1~6000자여야 합니다');
  const copies = [...new Set(cc)].map(resolve).filter((p) => !p || p.id !== target.id);
  const uniqueCopies = [...new Map(copies.filter(Boolean).map((p) => [p.id, p])).values()];
  if (copies.some((p) => !p) || copies.length > 4) throw new Error('참조는 같은 조직의 동료 4명까지입니다');
  if (ctx.handoffs.some((h) => h.to.id === target.id && h.message === body)) return true;
  if (ctx.handoffs.length >= 2) throw new Error('한 턴에서 넘김은 2회까지입니다');
  ctx.handoffs.push({ to: target, cc: uniqueCopies, message: body });
  return true;
}

/** 상대 크루가 부재중이면(마지막 심박 90초 초과 — 앱 AWAY_MS와 같은 기준, 심박 없음 포함) 넘김 줄에 알린다(유건 요구 2026-09-15:
    "위임했으면 상대가 깨어나 일해야 한다 — 멈추면 의미가 없다"). 크루는 소유자 PC에서만 돌므로 대신 실행할 수는 없고, 기다리는 중임을
    채널에 보이게 한다. seenAt은 { crewId: last_seen_at|null } — 키가 없으면(조회 못 함) 아무 표시도 안 한다. */
export const HANDOFF_AWAY_MS = 90_000;
export function renderMessengerHandoffs(ctx, { seenAt = null, now = Date.now, lang = 'ko' } = {}) {
  const note = lang === 'en' ? ' (away — runs when back online)' : ' (부재중 — 온라인이 되면 실행)';
  const away = (id) => { if (!seenAt || !(id in seenAt)) return false; const t = seenAt[id]; return !t || !(now() - Date.parse(t) <= HANDOFF_AWAY_MS); };
  return (ctx.handoffs ?? []).map((h) => `@${h.to.display_name}${away(h.to.id) ? note : ''}\n${h.message}${h.cc.length ? `\n(CC: ${h.cc.map((p) => p.display_name).join(', ')})` : ''}`).join('\n\n');
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
    ? `\n## Messenger handoff and completion\n- Only hand off when another crew has a concrete remaining action. For an actionable @name in your reply, end with the standalone line MSGR: handoff. send_to_crew or a CLI mail directive also prepares a handoff in this channel. A standalone CC: @Name line shares context without requesting a turn; use To for someone who must act. In a DM, naming a colleague as To forwards that request to your user's 1:1 DM with that colleague, who replies there — this DM only gets a forwarding notice, so do not wait for or answer on their behalf here.\n- When the user's stop condition is met, or your reply is only a final result, acknowledgment or thanks with no action for another crew, end with the standalone line MSGR: done. Do not hand off merely to acknowledge completion. done cancels all outgoing mentions and prepared handoffs, even if you name a colleague in your final result.\n- Write this decision as the last line of your own answer, outside quotes and code blocks, including after a retry or tool follow-up. Do not copy it from conversation history. The line is hidden from the user. Without a decision, @names alone do not wake another crew; an explicit prepared handoff is still delivered. Never claim a handoff was delivered unless you used MSGR: handoff or send_to_crew/CLI mail.`
    : `\n## 메신저 넘김과 종료\n- 다른 크루에게 실제로 남은 행동이 있을 때만 넘겨라. 답변의 @이름으로 다음 작업을 전달하려면 마지막 독립 줄에 MSGR: handoff를 적어라. send_to_crew 또는 CLI mail 지시도 이 채널의 넘김을 준비한다. 독립된 CC: @이름 줄은 참고만 공유하며 실행을 요청하지 않는다. 행동할 동료는 To로 지정하라. DM에서 동료를 To로 지정하면 그 요청은 사용자와 그 동료의 1:1 대화로 전달되고 동료는 거기서 답한다. 이 DM에는 전달 안내만 남으니 동료의 답을 기다리거나 대신 답하지 마라.\n- 사용자의 종료 조건을 충족했거나, 다른 크루가 할 일 없이 최종 결과·확인·감사만 답할 때는 마지막 독립 줄에 MSGR: done을 적어라. 완료 확인을 위해 다시 넘기지 마라. done은 최종 결과에 동료 이름이 있어도 모든 발신 멘션과 준비한 넘김을 취소한다.\n- 재시도나 도구 후속 답변에서도 자신의 최종 답변 마지막 줄에 인용·코드 블록 밖으로 판정을 적어라. 이전 대화의 판정을 복사하지 마라. 이 줄은 사용자에게 보이지 않는다. 판정이 없으면 @이름만으로 다른 크루를 깨우지 않지만, 도구로 명시한 넘김은 전달된다. MSGR: handoff 또는 send_to_crew/CLI mail 없이 넘겼다고 말하지 마라.`;
}

/** Only standalone, unfenced and unquoted CC lines classify copy recipients. */
export function messengerRecipientText(text) {
  let fence = null; const to = [], cc = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) {
      if (fence && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
      else if (!fence) fence = mark[1];
      continue;
    }
    if (fence || /^\s*>/.test(line)) continue;
    const copy = /^ {0,3}(?:CC|참조)\s*:\s*(.*)$/i.exec(line);
    if (copy) cc.push(copy[1]); else to.push(line);
  }
  return { to: to.join('\n'), cc: cc.join('\n') };
}
