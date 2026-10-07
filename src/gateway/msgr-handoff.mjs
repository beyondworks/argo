// 메신저의 send_to_crew도 최종 채널 답글로 넘긴다. 일반 우편 큐와 동시에 실행하지 않는다.
// 수집함은 브리지의 한 턴에만 속하며, 답글 저장 후 기존 권한·순서·홉 상한을 거친다.
export function messengerOrigin(ctx, targetSlug = null) {
  if (ctx?.kind === 'msgr-rules') throw new Error('메신저 위임의 예약·작업·결재는 요청한 동료에게 돌려주세요. 그 동료가 같은 채널에서 처리합니다');
  if (ctx?.kind !== 'msgr') return null;
  if (ctx.channelId && ctx.crewId && !ctx.orgId) throw new Error('개인 공간에서는 아직 결재·예약·긴 작업·다른 에이전트에게 맡기기를 쓸 수 없습니다. 조직 채널에서 요청해 주세요'); // 2026-09-30 개인 공간 1단계
  if (!ctx.orgId || !ctx.channelId || !ctx.crewId || !ctx.uid || !ctx.wsId) throw new Error('메신저 실행 문맥이 없습니다');
  const target = targetSlug ? ctx.peers?.find((p) => p.slug === targetSlug && p.owner_user_id === ctx.uid && p.ws_id === ctx.wsId) : null;
  if (targetSlug && !target) throw new Error('같은 메신저 조직에 파견된 동료만 실행할 수 있습니다');
  return { orgId: ctx.orgId, channelId: ctx.channelId, ...(ctx.channelKind === 'dm' ? { channelKind: 'dm', ...(ctx.delegated === true ? { delegated: true } : {}) } : {}), crewId: target?.id ?? ctx.crewId,
    threadRoot: ctx.threadRoot ?? null, sourceMsgId: ctx.sourceMsgId ?? ctx.threadRoot ?? null,
    uid: ctx.uid, wsId: ctx.wsId, origin: ctx.origin ?? null, hop: ctx.hop ?? 0,
    // 손님 표지는 사슬을 따라간다 — 쪽지·예약·결재로 옮겨 탄 뒤에도 "주인이 시킨 일"로 되살아나지 않게(넘김 뒤 쪽지는 rootAuthor를 잃는다).
    ...(ctx.rootAuthor ? { rootAuthor: ctx.rootAuthor } : {}), ...(isGuestCtx(ctx) ? { guest: true } : {}), ...(ctx.office === true ? { office: true } : {}),
    // 크루가 넘긴 턴 표지 — 예약·작업·결재 후속으로 옮겨 탄 뒤에도 사장 직접 턴으로 되살아나지 않게(풀 오토 제외, 유건 결정 2026-10-03)
    ...(ctx.handoffFrom ? { handoffFrom: ctx.handoffFrom } : {}) };
}

/** messengerOrigin 기록 → 턴 맥락(kind:'msgr')의 역방향. 요청자 사슬(uid·origin·rootAuthor·guest)을 **그대로** 옮긴다 —
    빠뜨리면 손님 판정(isGuestCtx)이 맥락을 몰라 손님 사슬이 주인 턴으로 되살아나거나(승격), 주인의 흐름까지 손님이 된다(fail-closed).
    쪽지(scheduler) 수신 턴이 쓴다. extra는 수신 쪽 사실(수신 크루 id·채널 이름 등)만. */
export function mirrorCtxFromOrigin(o, extra = {}) {
  return { kind: 'msgr', orgId: o.orgId, channelId: o.channelId, threadRoot: o.threadRoot ?? null,
    uid: o.uid ?? null, wsId: o.wsId ?? null, origin: o.origin ?? null,
    ...(o.rootAuthor ? { rootAuthor: o.rootAuthor } : {}), ...(o.guest === true ? { guest: true } : {}), ...(o.office === true ? { office: true } : {}), ...(o.handoffFrom ? { handoffFrom: o.handoffFrom } : {}), ...extra };
}

/** 오피스에서 맡긴 글인가 — 메시지 meta.source가 office_로 시작한다(아르고 오피스 '크루에게 맡기기'). 멤버가 쓸 수 있는 값이지만
    풀 오토를 **끄는** 데만 쓰므로 위조해도 권한이 오르지 않는다(meta.guest와 같은 방향). */
export const isOfficeSource = (message) => typeof message?.meta?.source === 'string' && message.meta.source.startsWith('office_');

/** 풀 오토를 켤 수 있는 턴인가 — 주인이 직접 시킨 턴만. 손님 턴과 오피스에서 맡긴 턴(메일·페이지 같은 외부 자료를 담는다)은 제외한다
    (유건 9/26 오피스 계획 8절 "메일발 턴은 풀 오토 제외", 9/29 확정). 오피스 턴은 손님이 아니다 — 주인의 도구는 쓰되 쓰기는 결재로 간다.
    풀 오토를 정하는 곳(chat.mjs·connectors.mjs)은 전부 이 한 함수만 본다. */
export function fullAutoAllowed(ctx) {
  // handoffFrom — 크루가 스스로 넘긴 턴(@넘김·MSGR: handoff). 사장이 정한 순서(사장 글의 @A > @B)의 다음 크루 턴은 사장 글에서 바로 생겨 이 표지가 없다(유건 결정 2026-10-03)
  return !isGuestCtx(ctx) && ctx?.office !== true && !ctx?.handoffFrom;
}

/** 주인 혼자 1:1 턴인가(유건 결정 2026-10-08 ① — 에이전트는 한 사람). 이런 턴은 데스크톱 대화와 같은 대화다(맥락 양방향 + 일지, 세션은 잇지 않는다 — chat.mjs).
    방 확인(사람 구성원이 주인 하나·에이전트도 이 에이전트 하나·최근 대화도 둘의 글뿐)은 게이트웨이가 하고 ctx.ownerSolo로 싣는다(msgr.mjs).
    여기서는 그 표지가 있어도 이 턴 자체가 주인 직접 턴인지 다시 본다(fail-closed): 1:1(dm)·손님/오피스/넘김 아님·위임 아님·첫 단계. */
export function ownerSoloTurn(ctx, { hop = 0, from = null, notOwnerDirect = null } = {}) {
  return ctx?.kind === 'msgr' && ctx.channelKind === 'dm' && ctx.ownerSolo === true
    && !from && !notOwnerDirect && !(hop > 0) && !(ctx.hop > 0) && fullAutoAllowed(ctx);
}

/** 주인이 직접 시킨 턴인가(3차 검수 F2) — 풀 오토 판정과 활동 기록의 ownerDirect 표지(chat.mjs)가 이 한 함수만 본다.
    from(위임받은 동료 턴)·notOwnerDirect(크루가 건 예약·장시간 작업·결재 후속)가 없고, 메신저 맥락이면 손님·오피스·크루 넘김이 아닌 턴. 메신저 밖 턴(mirrorCtx 없음·방·텔레그램)은 맥락 판정이 통과한다. */
export function ownerDirectTurn({ from = null, notOwnerDirect = null, mirrorCtx = null } = {}) {
  return !from && !notOwnerDirect && fullAutoAllowed(mirrorCtx);
}

/** 손님 턴 판정 — 이 메신저 턴을 크루 주인이 아닌 사람이 시켰는가(규칙 7·9: 주인의 몸은 주인만, 주인의 개인 기억은 공유한 것만).
    origin = 권한 주체(사람 글이면 작성자, 크루 넘김이면 **넘긴 크루의 주인** — msgr.mjs drain), rootAuthor = 넘김 스레드의 뿌리 사람.
    그래서 origin만 보면 "손님 B → A의 크루 X → A의 크루 Y" 넘김에서 Y가 주인 턴이 된다 — 뿌리도 함께 본다.
    **fail-closed**: 메신저 맥락인데 주인(uid)·시킨 사람(origin)을 모르면 손님이다. 한 번 손님이 된 사슬(guest)은 끝까지 손님이다.
    메신저 밖 턴(웹·텔레그램 — 페어링된 소유자만 턴을 돌린다)은 해당 없음. */
/** 정책 결정 대기(유건, 2026-09-18): 손님이 요청한 결재를 주인이 **승인**한 뒤의 후속 턴을 주인 권한으로 돌릴지.
    false = 지금 동작(승인 뒤에도 손님 — 크루는 그 요청자를 위해 주인의 몸을 쓰지 않는다). 답이 오면 이 한 줄만 바꾼다(승인 후속 경로는
    approval-actions → runMessengerContinuation(ownerApproved) → 맥락의 ownerApproved로 이미 연결돼 있다). */
export const OWNER_APPROVAL_LIFTS_GUEST = false;

/** 메신저 채널 턴의 일지 정책 — off = 기억 안 남김(crew_memory=false: 일지도 세션도 남기지 않는다), tag = 채널 단위 파일(조직 접두는 consolidate isOrgTagged·조직 회수 단위). */
export const msgrJournal = (orgId, channelId, off) => ({ off: off === true, tag: `org-${orgId}-ch-${channelId}` });

export function isGuestCtx(ctx) {
  if (ctx?.kind !== 'msgr') return false;
  if (OWNER_APPROVAL_LIFTS_GUEST && ctx.ownerApproved === true) return false;
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

// 코드 펜스(``` ~~~)가 열린 채로 끝나는가 — 그 안의 표지는 답변 내용이다.
function openFence(prefix) {
  let fence = null;
  for (const line of prefix.split(/\r?\n/)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!mark) continue;
    if (fence) {
      if (mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
    } else if (mark[1][0] !== '`' || !mark[2].includes('`')) fence = mark[1];
  }
  return fence;
}

// 모델이 표지를 마지막 문장 끝에 붙인 경우(…전달하겠습니다. MSGR: done, …확인했습니다. `MSGR: done`) — 운영 실측 2026-09-30: 페퍼·효원·월터·보스웰 답에
// 그대로 보였다(유건 "말 끝마다 MSGR Done 왜 붙이는거야?"). 판정으로는 읽지 않고(인라인은 인용일 수 있다) 사람에게 보이지 않게만 뗀다.
// 인용(>)·들여쓴 코드·열린 코드 펜스 안은 그대로 둔다.
export function hideInlineMarker(value) {
  const text = String(value ?? '');
  const body = text.replace(/\s+$/, '');
  const start = body.lastIndexOf('\n') + 1;
  const line = body.slice(start);
  if (/^( {0,3}>|    |\t)/.test(line) || openFence(body.slice(0, start))) return text;
  const m = /^(.*\S)[ \t]+(`?)MSGR: (?:handoff|done)\2[ \t]*$/.exec(line);
  return m ? body.slice(0, start) + m[1] : text;
}

/** 현재 답변의 마지막 독립 줄만 판정한다. 숫자·완료 문구·인용에서 종료를 추론하지 않는다. 문장 끝에 붙은 표지는 판정 없이 본문에서만 뗀다(hideInlineMarker). */
export function parseMessengerDisposition(value) {
  const text = String(value ?? '');
  const match = /(?:^|\r?\n)MSGR: (handoff|done)[ \t]*(?:\r?\n[ \t]*)*$/.exec(text);
  if (!match || openFence(text.slice(0, match.index))) return { text: hideInlineMarker(text), disposition: null };
  return { text: text.slice(0, match.index).trimEnd(), disposition: match[1] };
}

export function messengerHandoffHint(lang = 'ko') {
  return lang === 'en'
    ? `\n## Messenger handoff and completion\n- Only hand off when another agent has a concrete remaining action. For an actionable @name in your reply, end with the standalone line MSGR: handoff. send_to_crew or a CLI mail directive also prepares a handoff in this channel. A standalone CC: @Name line shares context without requesting a turn; use To for someone who must act. In a DM, naming a colleague as To forwards that request to your user's 1:1 DM with that colleague, who replies there — this DM only gets a forwarding notice, so do not wait for or answer on their behalf here.\n- When the user's stop condition is met, or your reply is only a final result, acknowledgment or thanks with no action for another agent, end with the standalone line MSGR: done. Do not hand off merely to acknowledge completion. done cancels all outgoing mentions and prepared handoffs, even if you name a colleague in your final result.\n- Write this decision as the last line of your own answer, outside quotes and code blocks, including after a retry or tool follow-up. Do not copy it from conversation history. The line is hidden from the user. Without a decision, @names alone do not wake another agent; an explicit prepared handoff is still delivered. Never claim a handoff was delivered unless you used MSGR: handoff or send_to_crew/CLI mail.`
    : `\n## 메신저 넘김과 종료\n- 다른 에이전트에게 실제로 남은 행동이 있을 때만 넘겨라. 답변의 @이름으로 다음 작업을 전달하려면 마지막 독립 줄에 MSGR: handoff를 적어라. send_to_crew 또는 CLI mail 지시도 이 채널의 넘김을 준비한다. 독립된 CC: @이름 줄은 참고만 공유하며 실행을 요청하지 않는다. 행동할 동료는 To로 지정하라. DM에서 동료를 To로 지정하면 그 요청은 사용자와 그 동료의 1:1 대화로 전달되고 동료는 거기서 답한다. 이 DM에는 전달 안내만 남으니 동료의 답을 기다리거나 대신 답하지 마라.\n- 사용자의 종료 조건을 충족했거나, 다른 에이전트가 할 일 없이 최종 결과·확인·감사만 답할 때는 마지막 독립 줄에 MSGR: done을 적어라. 완료 확인을 위해 다시 넘기지 마라. done은 최종 결과에 동료 이름이 있어도 모든 발신 멘션과 준비한 넘김을 취소한다.\n- 재시도나 도구 후속 답변에서도 자신의 최종 답변 마지막 줄에 인용·코드 블록 밖으로 판정을 적어라. 이전 대화의 판정을 복사하지 마라. 이 줄은 사용자에게 보이지 않는다. 판정이 없으면 @이름만으로 다른 에이전트를 깨우지 않지만, 도구로 명시한 넘김은 전달된다. MSGR: handoff 또는 send_to_crew/CLI mail 없이 넘겼다고 말하지 마라.`;
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
