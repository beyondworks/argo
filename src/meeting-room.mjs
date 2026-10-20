// 메신저 v2 "내 에이전트 회의방" 실행기(A+ P3, 2026-10-19 유건 승인). 사람은 주인 혼자, 참여자는 그 방의 내 Argo 에이전트(여러 회사 가능)와 외부 봇.
// 데스크톱 회의실과 **같은 회의 실행기**(room.mjs runRoomCore)를 쓰고, 바깥만 바꾼다:
//   저장소 = 이 질문 하나의 메모리(방의 글은 서버가 갖는다 — 결과를 posts[]로 돌려주면 서버가 글로 쓴다), 참여자 = offer가 알려 준 방의 내 에이전트·봇.
// 회의방 상한(room.mjs MEETING_LIMITS): 라운드 2 고정, 참가자 S≤5, 질문 1번당 글 S×R≤10, 위임 0(발언 턴의 hop을 위임 상한으로 넘겨 동료 목록을 비운다), cc·loop 없음.
// R10: 전원 취소(신호가 서면 발언 중인 에이전트 턴을 interruptTurn으로 끊고, 봇 요청은 신호로 끊는다)와 턴 상한 max_turn_s(기본 900초)를 실제로 건다.
//   시간 상한에 닿으면 그때까지 끝난 글은 버리지 않고 돌려주고(stopped:'timeout'), 안내 글을 하나 붙인다.
import { runRoomCore, MEETING_LIMITS } from './room.mjs';
import { DELEGATION_LIMITS } from './delegation-limits.mjs';
import { newBotBudget } from './ext-bots.mjs';

export const MEETING_MAX_TURN_S = 900; // 서버 msgr2_max_turn_s 기본값과 같다(offer.limits.max_turn_s가 오면 그 값)

const TIMEOUT_NOTE = { ko: (s) => `시간 상한(${s}초)에 닿아 회의를 멈췄습니다 — 끝난 발언까지만 남깁니다.`, en: (s) => `Stopped at the time limit (${s}s) — only finished replies are kept.` };

/**
 * 회의 한 번(사람 글 1개). 반환 { posts:[{ref, kind:'agent'|'bot', text, round?, noAdd?}], notes:[{code, text}], stopped: null|'timeout'|'cancelled' }.
 * participants = [{ kind:'agent', ref, ws, slug, name } | { kind:'bot', ref, ws, id, name }] — ref는 방에서 그 참여자를 가리키는 값(서버 에이전트 id 등).
 * deps = { chat, interruptTurn, callBot, mirrorCtxFor(p), chatExtra(p) → 추가 chat 옵션(일지 끄기 등), clock{setTimeout,clearTimeout} }
 */
export async function runMeeting({ text, participants, attachments = [], lang = 'ko', signal = null, maxTurnS = MEETING_MAX_TURN_S, tag, sessionKey = 'argo', rounds = MEETING_LIMITS.rounds, allByDefault = false }, deps) {
  const clock = deps.clock ?? { setTimeout, clearTimeout };
  const ac = new AbortController();
  let stopped = null;
  const stop = (why) => { if (!stopped) { stopped = why; ac.abort(); } };
  const onOuter = () => stop('cancelled');
  if (signal?.aborted) stop('cancelled'); else signal?.addEventListener?.('abort', onOuter, { once: true });
  const limitS = Math.max(1, Math.min(Number(maxTurnS) || MEETING_MAX_TURN_S, MEETING_MAX_TURN_S)); // 서버 값이 더 커도 900초를 넘기지 않는다
  const timer = clock.setTimeout(() => stop('timeout'), limitS * 1000);

  // 참여자 → 회의 실행기 모양. slug = ref(회사가 다른 두 에이전트의 slug가 같아도 섞이지 않게), 멘션은 이름으로 한다
  const byRef = new Map(participants.map((p) => [String(p.ref), p]));
  const core = participants.map((p) => ({ slug: String(p.ref), name: p.name, kind: p.kind === 'bot' ? 'bot' : 'agent' }));
  const room = { messages: [] };
  const inflight = new Set(); // 발언 중인 에이전트 — 취소·시간 상한 때 끊는다
  const budget = newBotBudget();
  let botHops = 0;
  const onStop = () => {
    for (const p of inflight) deps.interruptTurn(p.ws, p.slug, { source: 'messenger', tag }).catch(() => {});
  };
  ac.signal.addEventListener('abort', onStop, { once: true });

  const transcriptFor = () => room.messages.filter((m) => m.who !== 'system').slice(-10)
    .map((m) => `${m.who === 'user' ? (lang === 'en' ? 'User' : '사용자') : (byRef.get(m.who)?.name ?? m.who)}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');

  const env = {
    wsId: null,
    participants: async () => core,
    folder: async () => ({ pin: '', stale: '' }), // 회의방에는 작업 폴더 고정이 없다(기기 고유 경로 — 메신저에서 고를 수 없다)
    company: async () => ({ lang }),
    begin: async (msg) => { room.messages.push(msg); return { sid: 0, relaxed: false }; },
    push: async (msg) => { if (ac.signal.aborted) return false; room.messages.push(msg); return true; },
    load: async () => room,
    async speak(a, prompt, opts) {
      const p = byRef.get(a.slug);
      if (ac.signal.aborted) throw Object.assign(new Error('중단됨'), { aborted: true });
      if (p.kind === 'bot') {
        // 봇에게는 Argo 전용 지시(위임 도구 등) 대신 회의 대화만 보낸다. hop = 이 질문에서 앞서 답한 봇 수 + 1(사람이 부른 첫 봇 = 1)
        const hop = botHops + 1;
        const r = await deps.callBot({ ws: p.ws, id: p.id }, { text: transcriptFor(), sessionId: `${sessionKey}:${p.id}`, signal: ac.signal, budget, hop });
        botHops += 1;
        return { reply: r.text, handover: null, artifacts: [] };
      }
      inflight.add(p);
      try {
        return await deps.chat(p.ws, p.slug, prompt, null, {
          source: 'messenger', attachments: opts.attachments, abortTag: tag,
          mirrorCtx: deps.mirrorCtxFor(p),
          hop: DELEGATION_LIMITS.on.hop, // 위임 0 — 이 단계에서는 동료 목록이 빈다(chat.mjs turnColleagues). 권한은 좁아지는 쪽으로만 바뀐다(주인 직접 턴 판정이 꺼진다)
          ...(deps.chatExtra?.(p) ?? {}),
        });
      } finally { inflight.delete(p); }
    },
    record: async () => {}, // 개인 스레드 기록 없음 — 메신저 일(link 범위 턴)은 데스크톱 대화 기록을 쓰지 않는다(agent-link-host와 같은 규약)
    overBudget: async () => false, // 월 예산은 chat()이 턴마다 본다. 서버 상한(주인 하루 500 offer)이 회의 전체를 한 일로 센다
    directives: false,
    mirrorDelegations: false,
    meeting: { signal: ac.signal },
  };

  let failure = null;
  try {
    await runRoomCore(env, text, attachments, {}, async () => {}, { rounds: Math.max(1, Math.min(Number(rounds) || MEETING_LIMITS.rounds, MEETING_LIMITS.rounds)), noMentionAll: allByDefault }); // offer.meeting.rounds(1..2)
  } catch (e) {
    if (!stopped) failure = e;
  } finally {
    clock.clearTimeout(timer);
    signal?.removeEventListener?.('abort', onOuter);
  }
  if (failure) throw failure;

  const posts = []; const notes = [];
  for (const m of room.messages.slice(1)) {
    if (m.who === 'system') { notes.push({ code: m.kind, text: m.text }); continue; }
    const p = byRef.get(m.who);
    if (!p) continue;
    posts.push({ ref: p.ref, kind: p.kind === 'bot' ? 'bot' : 'agent', text: String(m.text ?? ''), ...(m.round ? { round: m.round } : {}), ...(m.noAdd ? { noAdd: true } : {}) });
  }
  if (stopped === 'timeout') notes.push({ code: 'timeout', text: (TIMEOUT_NOTE[lang] ?? TIMEOUT_NOTE.ko)(limitS) });
  return { posts: posts.slice(0, MEETING_LIMITS.posts), notes, stopped };
}
