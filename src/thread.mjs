// 채팅 스레드 영속화 — 크루별 chats/<slug>.json 에 대화·세션을 남긴다.
// 새로고침해도 대화가 이어지는 것이 제품의 기본 자세다.
import { readFile, rm, readdir, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { paths, getDeviceId } from './workspace.mjs';
import { withLock } from './mutex.mjs';
import { writeJsonAtomic, readJson, salvageFromCorrupt } from './jsonstore.mjs';
import { resetStamp, resumeStamp } from './reset-stamp.mjs';
import { channelIdsOf, forgetChannels, applyDeparted, mergeDeparted, msgChannel, isOwnerSoloScope, foldedSolo, summaryRecalled } from './departed.mjs'; // 채널 기억 회수(유건 결정 2026-10-03)
import { isRelaxedStored, resetDelegationLimit } from './delegation-limits.mjs'; // 위임 제한 스위치 — 대화방(스레드)마다 저장
import { sanitizeFileSlug } from './slug.mjs'; // 파일 이름 세척의 단일 원천 — 회의록 충돌 판정(sync 반입 문)과 같은 규칙

const file = (wsId, slug) => join(paths(wsId).chats, `${sanitizeFileSlug(slug)}.json`);
// 같은 크루 스레드의 read-modify-write를 직렬화 — 웹·텔레그램 동시 턴의 lost-update 방지
const lockKey = (wsId, slug) => `thread:${wsId}:${sanitizeFileSlug(slug)}`;
// 앱 사이드카·argo CLI가 같은 폴더를 쓰면 프로세스 간 잠금도 필요하다(M-b) — 파일 단위(<chat>.json.lockd). 보관·휴지통 편집도 활성 스레드 잠금 하나로 직렬화한다.
const lockThread = (wsId, slug, fn) => withLock(lockKey(wsId, slug), fn, { file: file(wsId, slug) });

// 턴 기록(appendTurn)을 기다리는 쪽 — 세션 메시지가 크루의 직전 턴이 새 sessionId를 쓸 때까지 기다린다(session-msg.mjs idleSession).
// globalThis: Next가 진입점마다 모듈을 따로 번들한다(turn-abort.mjs와 같은 이유). 같은 프로세스 안의 기록만 알린다.
const writeWaiters = (globalThis.__argoThreadWrite ??= new Map()); // lockKey → Set<resolve>
const notifyWrite = (wsId, slug) => {
  const k = lockKey(wsId, slug); const set = writeWaiters.get(k);
  if (set) { writeWaiters.delete(k); for (const wake of set) wake(); }
};
/** 이 스레드의 다음 턴 기록에 풀리는 약속. cancel()로 걸어 둔 것을 거둔다(쌓이지 않게). */
export function nextThreadWrite(wsId, slug) {
  const k = lockKey(wsId, slug);
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const set = writeWaiters.get(k) ?? new Set();
  set.add(resolve); writeWaiters.set(k, set);
  return { promise, cancel: () => { const cur = writeWaiters.get(k); cur?.delete(resolve); if (cur && !cur.size) writeWaiters.delete(k); } };
}

/** 스레드 파일 mtime(ms) — 폴링 dedup용. 파일이 없으면 0. */
export async function threadMtime(wsId, slug) {
  try { return (await stat(file(wsId, slug))).mtimeMs; } catch { return 0; }
}

/** 턴의 기록 범위(단일 원천) — 메신저 DM은 뿌리, 메신저 채널은 채널, 텔레그램 그룹은 그 그룹 채팅 단위. 데스크톱·텔레그램 1:1은 범위 없음
    (전역 sessionId = 주인이 데스크톱·1:1에서 나눈 대화). 범위 턴이 전역 세션을 이어받으면 주인 대화가 다른 참여자가 보는 답에 샌다. */
export function turnScope(ctx) {
  if (ctx?.kind === 'scope') return ctx.scope ?? null; // 자동 턴(루틴·작업·쪽지·서류함)·위임·결재 후속이 목적지 범위를 실어 온 맥락(gateway briefingCtx·approvalScope)
  if (ctx?.kind === 'msgr-rules') return ctx.channelId ? { kind: 'msgr', channelId: ctx.channelId } : null; // 메신저 위임(방어 — 지금은 넘김으로 먼저 빠져 도달하지 않는다)
  if (ctx?.kind === 'msgr') return ctx.channelId ? { kind: ctx.channelKind === 'dm' ? 'msgr-dm' : 'msgr', channelId: ctx.channelId, ...(ctx.threadRoot ? { threadRoot: ctx.threadRoot } : {}) } : null;
  if (ctx?.chatId != null && /group/.test(ctx.chatType ?? '')) return { kind: 'tg-group', chatId: String(ctx.chatId) };
  if (ctx?.kind === 'slack' && ctx.channelId) return { kind: 'slack', channelId: String(ctx.channelId) }; // 슬랙 공유 채널(1:1은 게이트웨이가 ctx를 넘기지 않는다)
  return null;
}
/** 세션을 따로 잇는 범위의 키 — 메신저 채널 = channelId(#593 저장분 그대로), 텔레그램 그룹 = tg:<chatId>, 슬랙 채널 = slack:<channelId>. 그 밖(메신저 DM 등)은 세션을 남기지 않는다. */
export const scopeKey = (s) => (s?.kind === 'msgr' && s.channelId ? s.channelId : s?.kind === 'tg-group' && s.chatId ? `tg:${s.chatId}` : s?.kind === 'slack' && s.channelId ? `slack:${s.channelId}` : null);
export const scopedSession = (t, key) => t?.scopedSessions?.[key] ?? { sessionId: null, sessionDevice: null };
export { isOwnerSoloScope, foldedSolo }; // 주인 혼자 1:1 기록 표지·요약이 접은 1:1 방(정의는 departed.mjs — 회수가 같은 술어로 범위 없는 요약을 거둔다)
/** 프롬프트에 붙일 스레드 줄 — 범위 턴은 같은 범위 기록만, 그 밖의 턴은 범위 없는 기록 + 주인 혼자 1:1 기록(채널·그룹·남 낀 DM 기록이 데스크톱 대화에 섞이지 않게).
    주인 혼자 1:1 턴은 범위 없는 턴처럼 이 규칙을 쓴다(chat.mjs lineScope = null) — 데스크톱과 같은 대화다. */
export const inContextScope = (m, scope) => { const k = scopeKey(scope); return scope ? !!k && scopeKey(m.contextScope) === k : (!m.contextScope || isOwnerSoloScope(m.contextScope)); }; // 키 없는 범위(여러 공유 목적지 {kind:'shared'})는 아무것도 붙이지 않는다

/* ── 데스크톱 세션이 본 주인 혼자 1:1 줄(유건 결정 2026-10-08 ①) — 1:1 턴은 세션 밖에서 돈다(세션을 남기지 않는다). 그래서 데스크톱(범위 없는) 세션이
   이어 쓸 때 그 세션이 아직 못 본 1:1 줄을 알아야 한다. 위치(마지막 데스크톱 답 뒤)로는 못 가린다 — 루틴·위임·쪽지 줄이 끼고, 동기화 병합은 줄을 시각순으로
   다시 놓고, 턴 끝에 기록하는 경로는 도는 사이 끝난 1:1을 앞에 둔다(검수 HIGH 2026-10-08). 그래서 "이 세션에 건넨 1:1 줄"을 세션 id와 짝으로 남긴다:
   t.soloSeen = { session, keys:[soloKey…] }. 병합은 줄을 더하기만 하므로 순서와 상관없이 맞다. 다른 세션의 기록이거나 기록이 없으면 본 줄이 없는 것으로 본다
   (못 본 줄을 다시 건넬 뿐 — 잃지 않는다). 쓰기는 건넨 줄이 생긴 턴에만 1회(로컬 파일, DB 0). ── */
/** 1:1 줄의 키 — 시각·화자·방(동기화 병합의 줄 동일성 ts|who와 같은 축 + 방) */
export const soloKey = (m) => `${m?.ts ?? ''}|${m?.who ?? ''}|${String(m?.contextScope?.channelId ?? '').toLowerCase()}`;
/** 이 세션이 본 1:1 줄 키 — 기록이 그 세션 것이 아니면 빈 집합 */
export const soloSeenFor = (t, session) => new Set(session && t?.soloSeen?.session === session && Array.isArray(t.soloSeen.keys) ? t.soloSeen.keys : []);
/** 기록 쓰기 — 같은 세션이면 이미 본 줄에 더한다(한 세션은 본 것을 잊지 않는다 — 동시에 끝난 두 턴이 서로의 기록을 덮지 않게). 키는 지금 스레드에 있는 1:1 줄로만 남긴다(크기 상한 = 스레드).
    바뀐 것이 없으면 쓰지 않는다. inThread = 지금 스레드에서 키를 셀 줄(chat.mjs가 맥락 규칙으로 고른 1:1 줄). */
export async function noteSoloSeen(wsId, slug, session, keys, inThread) {
  if (!session) return false;
  return lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug);
    const present = new Set(t.messages.filter(inThread).map(soloKey));
    const prev = soloSeenFor(t, session);
    const next = [...new Set([...prev, ...keys])].filter((k) => present.has(k));
    if (t.soloSeen?.session === session && next.length === prev.size && next.every((k) => prev.has(k))) return false;
    t.soloSeen = { session, keys: next };
    await writeJsonAtomic(file(wsId, slug), t);
    return true;
  });
}
/** 이 기기 스레드에 이미 있는 그 방의 주인 혼자 1:1 턴(메신저 원본 메시지 id) — 게이트웨이가 서버 봉투의 최근 방 대화에서 겹치는 줄을 뺄 때 쓴다(msgr.mjs). */
export const soloMsgIds = (t, channelId) => new Set((t?.messages ?? []).filter((m) => isOwnerSoloScope(m.contextScope) && m.contextScope.msgId != null
  && String(m.contextScope.channelId ?? '').toLowerCase() === String(channelId ?? '').toLowerCase()).map((m) => String(m.contextScope.msgId)));
/** 스레드 맥락 누적 요약(thread-context.mjs) — 범위 없는 대화는 summary, 키 있는 범위(채널·그룹)는 scopedSummaries[key]. 범위끼리 섞이지 않게 세션과 같은 키를 쓴다.
    {text, upto} — upto는 요약이 덮는 마지막 메시지 ts(앵커). 앵커가 스레드에 없으면 쓰는 쪽(planContext)이 무효로 본다. 없으면 null. */
export const threadSummary = (t, scope) => { const s = scope ? (scopeKey(scope) ? t?.scopedSummaries?.[scopeKey(scope)] : null) : t?.summary; return s && typeof s.text === 'string' ? s : null; };
/** 결재 항목에 실을 범위 — 메신저가 아닌 범위 턴(텔레그램 그룹·슬랙 채널·자동 턴 목적지)에서 올린 결재의 후속이 그 범위로 돈다(approval-actions followUp). 메신저는 msgr 각인이 맡는다. */
export const approvalScope = (ctx) => { const s = ctx?.kind === 'msgr' ? null : turnScope(ctx); return s ? { scope: s } : {}; };

async function keepSession(t, sessionId, scope) {
  // SDK 세션 저장소는 기기 로컬이라 소유 기기를 함께 기록한다 — 다른 기기가 이 sessionId를
  // resume하면 CLI가 'No conversation found'로 죽는다(실측: 기기 전환 실패). chat이 사전 분기.
  if (!sessionId) return;
  if (!scope) { t.sessionId = sessionId; t.sessionDevice = await getDeviceId().catch(() => t.sessionDevice ?? null); return; }
  const key = scopeKey(scope);
  if (!key) return; // DM 등 나머지 범위 기록은 세션을 남기지 않는다
  const prev = t.scopedSessions?.[key];
  t.scopedSessions = { ...t.scopedSessions, [key]: { sessionId, sessionDevice: await getDeviceId().catch(() => prev?.sessionDevice ?? null) } };
}

export async function loadThread(wsId, slug) {
  // 대화는 유실이 치명적 — 손상 시 조용히 빈 상태로 리셋하지 않고 throw로 드러낸다(readJson).
  const t = await readJson(file(wsId, slug), { sessionId: null, messages: [] });
  applyDeparted(t); // 회수 각인 — 예전 버전·다른 기기가 되살린 옛 채널 줄·세션은 읽는 자리에서 거른다(설계 검수 M4)
  // 회의실과 동일 계약 — 파일 부재일 때만 손상본에서 건져 화면에 되돌리고, 파일은 쓰지 않는다.
  // (새 대화·신규 크루처럼 정상적으로 비어 있는 경우는 파일이 존재하므로 복구가 발동하지 않는다.)
  // sessionId는 복구하지 않는다 — 이어가기 세션은 새로 시작(대화 기록 보존이 우선).
  if (!t.messages?.length) {
    const s = await salvageFromCorrupt(file(wsId, slug), 'messages').catch(() => null);
    if (s) return { ...t, messages: s.items, salvagedFrom: s.from };
  }
  return t;
}

/** 누적 요약 저장 — 앵커 메시지가 아직 스레드에 있을 때만(그 사이 새 대화·회수로 사라졌으면 쓰지 않는다). 키 없는 범위는 저장하지 않는다.
    범위 없는 요약은 접은 주인 혼자 1:1 방을 solo로 든다(departed.mjs foldedSolo) — summary.solo(호출부가 요약할 때 본 줄·이어 접은 앞 요약 기준) + 지금 스레드의 기준점 이하 1:1 줄.
    그 방이 요약하는 사이 회수됐으면 저장하지 않는다(회수된 내용을 접은 요약을 남기지 않는다). */
export async function setThreadSummary(wsId, slug, scope, summary) {
  const key = scope ? scopeKey(scope) : null;
  if (scope && !key) return false;
  return lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug);
    if (!t.messages.some((m) => m.ts === summary?.upto)) return false;
    const solo = key ? {} : foldedSolo(t.messages, summary.upto, summary.solo);
    const val = { text: String(summary.text), upto: summary.upto, at: Date.now(), ...(key ? {} : { withSolo: true }), ...(Object.keys(solo).length ? { solo } : {}) }; // withSolo — 주인 혼자 1:1 줄까지 접을 수 있는 요약(이전 버전 요약과 가른다 — chat.mjs threadContextFor)
    if (summaryRecalled(t.departed, val)) return false;
    if (key) t.scopedSummaries = { ...t.scopedSummaries, [key]: val }; else t.summary = val;
    await writeJsonAtomic(file(wsId, slug), t);
    return true;
  });
}

/** 턴 시작 — 사장의 지시를 **답변을 기다리기 전에** 저장한다.
    예전엔 턴이 끝난 뒤에야 appendTurn으로 한꺼번에 저장했다. 그래서 답변을 만드는 동안에는 사장의 글이
    브라우저 메모리에만 있었고, 페이지를 벗어나거나 새로고침하면 **내가 쓴 글이 사라졌다가 답변이
    끝나야 다시 나타났다**(실사용 신고 2026-08-02). 오래 걸리는 턴일수록 오래 사라져 있는 셈이다.
    반환한 turnId로 나중에 같은 줄을 찾아 답변을 붙인다 — 새 줄을 밀어 넣지 않으므로 중복이 없다. */
export async function beginTurn(wsId, slug, { userMsg, attachments, via, contextScope, src } = {}) {
  const turnId = `t${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug);
    t.messages.push({
      who: 'user', text: userMsg, ts: Date.now(), turnId,
      awaiting: true, // 답변 대기 중 — 프롬프트 맥락에서는 뺀다(지금 보내는 그 글이라 두 번 들어간다)
      ...(attachments?.length ? { attachments } : {}),
      ...(via ? { via } : {}),
      ...(contextScope ? { contextScope } : {}),
      ...(src ? { src } : {}), // 출처 표지(세션 메시지 — session-msg.mjs). 화면 카드와 맥락 줄이 이 값으로 화자·출처를 적는다
    });
    await writeJsonAtomic(file(wsId, slug), t);
  });
  return turnId;
}

/** 턴 없이 한 줄을 더한다 — 세션 메시지의 보낸 줄·돌아온 답 카드·안내(session-msg.mjs). 줄 모양은 호출부가 정한다(ts는 없으면 지금).
    noticeOf = 진행 중인 턴(turnId)에 딸린 안내(예: 앞 대화 요약 안내, chat.mjs) — 그 지시(와 끼워 넣기·앞 안내) 바로 뒤에 둔다.
    appendTurn이 같은 표지를 보고 답을 그 뒤에 넣으므로 순서가 지시 → 안내 → 답으로 고정된다. 그 턴 줄이 없으면(메신저 표지 등) 끝에. */
export async function appendLine(wsId, slug, line) {
  return lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug);
    const m = { ts: Date.now(), ...line };
    const at = m.noticeOf ? t.messages.findIndex((x) => x.turnId === m.noticeOf) : -1;
    if (at >= 0) {
      let end = at;
      t.messages.forEach((x, i) => { if (i > at && (x.steerOf === m.noticeOf || x.noticeOf === m.noticeOf)) end = i; });
      t.messages.splice(end + 1, 0, m);
    } else {
      delete m.noticeOf;
      t.messages.push(m);
    }
    await writeJsonAtomic(file(wsId, slug), t);
    return m;
  });
}

export async function appendTurn(wsId, slug, opts) {
  const out = await appendTurnLocked(wsId, slug, opts);
  notifyWrite(wsId, slug); // 기록이 끝난 뒤 — 기다리던 세션 메시지가 새 sessionId를 읽는다
  return out;
}
// noContext = 화면에는 보이되 다음 턴 맥락(chat.mjs inThreadContext — 최근 대화·누적 요약)에는 싣지 않는 기록(루틴 실패 안내 — 에이전트가 한 말이 아니다).
async function appendTurnLocked(wsId, slug, { turnId, userMsg, reply, handover, sessionId, attachments, artifacts, via, actor, failed, aborted, cancellationIncomplete, fellBack, failedCode, failedOrigin, modelFallback, contextScope, steerFailed, noContext }) {
  return lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug); // 락 안에서 최신 상태를 다시 읽는다
    const ts = Date.now();
    // beginTurn이 이미 써 둔 줄이 있으면 그 줄을 마무리한다(새로 밀어 넣으면 같은 지시가 두 줄이 된다).
    // 답변은 스레드 끝이 아니라 **그 지시 바로 뒤**에 넣는다 — 턴 도중 도착한 공유 노트가 사이에 끼면
    // 질문과 답이 떨어져 보인다.
    const at = turnId ? t.messages.findIndex((m) => m.turnId === turnId) : -1;
    // Scoped audit records stay visible, but cannot seed another channel or replace its provider session.
    const scope = contextScope ?? (at >= 0 ? t.messages[at].contextScope : null);
    const scoped = { ...(scope ? { contextScope: scope } : {}), ...(noContext ? { noContext: true } : {}) };
    if (at >= 0) {
      const m = t.messages[at];
      delete m.awaiting;
      // 이 턴에 끼워 넣은 사장 메시지(addSteer) — 같은 결과로 마무리하고, 답은 그 뒤에 넣는다(질문들 → 답 순서)
      let end = at;
      t.messages.forEach((x, i) => {
        if (x.noticeOf === turnId) { end = Math.max(end, i); return; } // 이 턴의 안내 줄(appendLine noticeOf) — 답은 그 뒤에
        if (x.steerOf !== turnId) return;
        end = Math.max(end, i); delete x.awaiting;
        if (failed) Object.assign(x, { failed, ...(failedCode ? { failedCode } : {}), ...(failedOrigin ? { failedOrigin } : {}), ...(aborted ? { aborted: true } : {}) });
        // 턴은 답했지만 이 줄을 실은 이어진 실행이 실패했다(chat.mjs steerFailed) — 이 줄만 실패(재전송 가능). 엔진 글은 첨부 안내가 뒤에 붙어 앞부분으로 맞춘다
        else if (steerFailed?.texts?.some((t) => String(t).startsWith(x.text))) x.failed = steerFailed.reason || 'failed';
      });
      if (scope) m.contextScope = scope;
      if (noContext) m.noContext = true;
      if (attachments?.length) m.attachments = attachments;
      if (actor) m.actor = actor; // 팀 메신저: 사람 발화자 {uid,name} — who:'user'만으로는 누가 말했는지 구분 불가(MESSENGER-DESIGN.md)
      if (failed) m.failed = failed;
      if (failedCode) m.failedCode = failedCode; // 실패 코드 표(error-class.mjs) — UI가 chat.fail.<code>로 행동 안내를 그린다
      if (failedOrigin) m.failedOrigin = failedOrigin; // vendor/argo/probe — 출처 판정(유건 기준)
      if (aborted) m.aborted = true;
      if (cancellationIncomplete) m.cancellationIncomplete = true;
      if (!failed) t.messages.splice(end + 1, 0, { who: 'crew', text: reply, handover, ts, ...scoped, ...(artifacts?.length ? { artifacts } : {}), ...(fellBack ? { fellBack } : {}), ...(modelFallback ? { modelFallback } : {}) }); // fellBack = 폴백 투명화(P2) — UI가 대체 실행 안내를 그린다
      await keepSession(t, sessionId, scope);
      await writeJsonAtomic(file(wsId, slug), t);
      await noteChannelSession(wsId, slug, scope, sessionId);
      return t;
    }
    t.messages.push(
      // via = 사장이 직접 쓴 글이 아닌 배달 지시(crewmail·delegate·routine). who:'user'는 러너 프롬프트
      // 관점의 역할일 뿐인데 UI가 사장 말풍선으로 그려 "내가 쓴 게 아니거든"이 됐다(신고 2026-07-28).
      // aborted = 사장 지시 중단(사유 문자열과 별도 — 원문이 우연히 'aborted'여도 오판 없음, 재검수 MEDIUM).
      { who: 'user', text: userMsg, ts, ...scoped, ...(attachments?.length ? { attachments } : {}), ...(via ? { via } : {}), ...(actor ? { actor } : {}), ...(failed ? { failed } : {}), ...(failedCode ? { failedCode } : {}), ...(failedOrigin ? { failedOrigin } : {}), ...(aborted ? { aborted: true } : {}), ...(cancellationIncomplete ? { cancellationIncomplete: true } : {}) },
    );
    // 실패·중단 턴은 크루 답변이 없다 — 지시문만 사유(failed)와 함께 보존한다. 성공 뒤에만 저장하면
    // 실패 턴의 지시문이 새로고침에 증발하고 비용만 남는다(전수리뷰 2026-07-30 #1).
    // ⚠ "실패 표현"은 두 형태가 공존한다: 이 failed(user 단독 — 답변 자체가 없음)와
    // approval-actions의 실패 사유를 담은 crew 메시지(부작용은 이미 적용돼 보고만 실패). 의도적 구분.
    if (!failed) t.messages.push(
      // artifacts = 이 턴에 크루가 만든/고친 vault 문서(rel) — 답변 칩으로 바로 연다
      { who: 'crew', text: reply, handover, ts, ...scoped, ...(artifacts?.length ? { artifacts } : {}), ...(fellBack ? { fellBack } : {}), ...(modelFallback ? { modelFallback } : {}) }, // 검수 L1 — turnId 없는 갈래(선저장 실패·턴 중 리셋)도 폴백 표식 보존
    );
    await keepSession(t, sessionId, scope);
    await writeJsonAtomic(file(wsId, slug), t);
    await noteChannelSession(wsId, slug, scope, sessionId);
    return t;
  });
}

/** 진행 중인 사장 턴에 끼워 넣은 메시지를 저장한다 — 새로고침해도 남게(beginTurn과 같은 이유). 답을 기다리는 사장 턴이
    없으면(이미 끝남) null — 호출부는 끼워 넣지 않고 대기열에 남긴다. 반환: { steerId(되돌리기용), turnId(실행 표지 — chat/steer가 정확히 그 턴을 고른다) }. */
export async function addSteer(wsId, slug, { text, attachments } = {}) {
  return lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug);
    const turn = t.messages.findLast((m) => m.who === 'user' && m.awaiting && m.turnId && !m.via && !m.steerOf);
    if (!turn) return null;
    const steerId = `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    t.messages.push({ who: 'user', text, ts: Date.now(), steerOf: turn.turnId, steerId, awaiting: true, ...(attachments?.length ? { attachments } : {}) });
    await writeJsonAtomic(file(wsId, slug), t);
    return { steerId, turnId: turn.turnId };
  });
}

/** 전달에 실패한 끼워 넣기를 되돌린다(대기열로 돌아간다). */
export async function removeSteer(wsId, slug, steerId) {
  return lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug);
    const next = t.messages.filter((m) => m.steerId !== steerId);
    if (next.length !== t.messages.length) { t.messages = next; await writeJsonAtomic(file(wsId, slug), t); }
  });
}

/** 참조(cc) 공유 — 대상 크루 스레드에 노트를 남긴다. pending 표시는 "아직 그 크루가 못 본 맥락"이라는 뜻. */
export async function appendSharedNote(wsId, slug, text) {
  return lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug);
    t.messages.push({ who: 'user', shared: true, pending: true, text, ts: Date.now() });
    await writeJsonAtomic(file(wsId, slug), t);
  });
}

/** 미소비 공유 노트 회수 — 다음 턴 프롬프트에 1회만 주입되도록 pending을 해제하며 반환한다. */
export async function takeSharedNotes(wsId, slug) {
  return lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug);
    const notes = t.messages.filter((m) => !m.contextScope && m.shared && m.pending);
    if (!notes.length) return [];
    for (const m of notes) delete m.pending;
    await writeJsonAtomic(file(wsId, slug), t);
    return notes.map((m) => m.text);
  });
}

/** 소비했던 공유 노트 복원 — 턴이 최종 실패하면 pending을 되살려 다음 턴에 다시 주입한다.
    (소비가 러너 실행 전이라, 복원 없이는 실패한 턴이 cc 맥락을 영구 소실시켰다 — 검증 2026-07-19) */
export async function restoreSharedNotes(wsId, slug, texts) {
  if (!texts?.length) return;
  return lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug);
    const want = new Set(texts);
    for (const m of t.messages) {
      if (m.shared && !m.pending && want.has(m.text)) { m.pending = true; want.delete(m.text); }
    }
    await writeJsonAtomic(file(wsId, slug), t);
  });
}

/** 보관된 세션 목록 — 새 대화로 적재된 이전 스레드들(최신순). 크루 채팅 좌측 레일의 원천. */
export async function listArchivedSessions(wsId, slug) {
  const dir = join(paths(wsId).chats, '.archive');
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  // 엄격 매칭(^slug-<ts>.json$) — startsWith만 쓰면 sales가 sales-lead 아카이브까지 잡아 못 여는 유령 항목이 생긴다
  const re = new RegExp(`^${safe}-\\d+\\.json$`);
  let names = [];
  try {
    names = (await readdir(dir)).filter((n) => re.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const t = JSON.parse(await readFile(join(dir, n), 'utf8'));
      // via(배달 지시)는 대화 제목감이 아니다 — 쪽지로 시작된 대화의 제목이 배달 프리픽스가 된다(검수 LOW)
      const firstUser = (t.messages ?? []).find((m) => m.who === 'user' && !m.shared && !m.via);
      out.push({
        id: n,
        ts: Number(n.match(/-(\d+)\.json$/)?.[1] ?? 0),
        count: t.messages?.length ?? 0,
        title: t.title ?? null, // 사용자가 붙인 대화명(있으면 레일에서 gist 대신 표시)
        pinned: t.pinned === true, // 고정 세션 — 레일 상단에 최근순으로 묶인다(title과 동일 in-file 저장)
        gist: String(firstUser?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 42),
      });
    } catch { /* 깨진 보관본은 건너뛴다 */ }
  }
  // 고정 먼저, 그 안에서 최근순 — 각 그룹 내부는 기존과 동일(ts 내림차순)
  return out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.ts - a.ts);
}

export async function readArchivedSession(wsId, slug, id) {
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  if (!new RegExp(`^${safe}-\\d+\\.json$`).test(id)) throw new Error('잘못된 세션 id');
  const t = JSON.parse(await readFile(join(paths(wsId).chats, '.archive', id), 'utf8'));
  const cur = await readJson(file(wsId, slug), null).catch(() => null);
  const departed = mergeDeparted(cur?.departed, t.departed); // 보관 화면도 지운 채널 줄을 보이지 않는다(분리 검수 L-3)
  if (departed) { t.departed = departed; applyDeparted(t); }
  return t;
}

/** 새 대화 — 삭제가 아니라 적재. 이전 대화는 chats/.archive/에 보관되고, vault 기억은 그대로다(그게 제품의 핵심). */
export async function resetThread(wsId, slug) {
  return lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug);
    if (t.messages?.length) {
      const dir = join(paths(wsId).chats, '.archive');
      await writeJsonAtomic(join(dir, `${slug.replace(/[^a-z0-9-]/g, '')}-${Date.now()}.json`), t);
    }
    // 삭제가 아니라 **빈 스레드로 재기록** — 파일 부재는 "손상 격리됨"의 신호로 쓰이므로(loadThread의
    // salvage 게이트), 새 대화가 파일을 지우면 옛 손상본이 되살아난다(검수 CRITICAL-1 C 케이스 실측).
    // 회의실 endMeeting이 {messages:[], sid+1}을 쓰는 것과 같은 계약으로 통일한다.
    // resetAt = 비움 각인(tombstone) — 근거·산식은 src/reset-stamp.mjs에 있다(벽시계 미사용 이유 포함).
    await writeJsonAtomic(file(wsId, slug), { sessionId: null, messages: [], ...resetStamp(t), ...resetDelegationLimit(), ...(t.departed ? { departed: t.departed } : {}) }); // 회수 각인은 새 대화로 이어진다 — 각인 없는 옛 보관본을 되살려도 지운 줄이 돌아오지 않게(분리 검수 L-2) // 새 대화 = 위임 제한 켜짐(기본값) — 이전이 풀림이었으면 명시적 true(동기화 병합에서 옛 꺼짐이 되살아나지 않게)
  });
}

/** 대화 이어가기 — 보관 세션을 다시 활성 스레드로 되살린다. 현재 활성 대화는 먼저 보관(비파괴).
    sessionId(SDK 세션)까지 복원해 크루가 맥락을 이어서 답한다. 반환 = 되살린 스레드({sessionId, messages}). */
export async function resumeSession(wsId, slug, id) {
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  if (!new RegExp(`^${safe}-\\d+\\.json$`).test(id)) throw new Error('잘못된 세션 id');
  return lockThread(wsId, slug, async () => {
    const dir = join(paths(wsId).chats, '.archive');
    const restored = JSON.parse(await readFile(join(dir, id), 'utf8'));
    // 현재 활성 대화가 있으면 먼저 보관(유실 방지) — 새 타임스탬프로 적재
    const cur = await loadThread(wsId, slug);
    if (cur.messages?.length) {
      await writeJsonAtomic(join(dir, `${safe}-${Date.now()}.json`), cur);
    }
    // 보관본을 활성으로 되살리고, 원래 보관 파일은 제거(레일에 중복 노출 방지).
    // 되살림 각인 — resetAt을 지우기만 하면 **원격이 든 tombstone**이 이겨 복원분이 도로 잘린다
    // (실측: 로컬 삭제만으론 max(0, 원격 T2)=T2가 적용). 리셋과 되살림을 같은 축의 사건으로 두고
    // mergeThread가 최신값으로 승부하게 한다(resumedAt >= resetAt이면 비움 취소).
    delete restored.resetAt;
    delete restored.cutTs; // 보관본의 옛 자르기 지점 정리 — 방어적: 되살림 직후엔 resumedAt >= resetAt 게이트가 먼저 걸려 현재 무행동(4R 차등 탐색 4000시드 차이 0), 옛 각인이 새 문맥에 실려 다니지 않게만 한다
    restored.resumedAt = resumeStamp(cur); // 각인 보유자는 활성 스레드(cur) — 보관본은 리셋을 모른다
    const departed = mergeDeparted(cur.departed, restored.departed); // 회수 각인은 보관본으로 바꿔도 이어진다 — 되살린 대화에 지운 채널 기억이 돌아오지 않게(설계 검수 H2)
    if (departed) { restored.departed = departed; applyDeparted(restored); }
    await writeJsonAtomic(file(wsId, slug), restored);
    await rm(join(dir, id), { force: true });
    return restored;
  });
}

// ── 보관 세션 이름 편집 / 삭제(보관함으로) / 복구 ──
// 삭제는 하드 삭제가 아니라 chats/.trash/로 이동 — 설정 보관함에서 복구할 수 있다(비파괴).
const trashDir = (wsId) => join(paths(wsId).chats, '.trash');
const ARCH_ID = (safe) => new RegExp(`^${safe}-\\d+\\.json$`);
const ANY_ARCH_ID = /^[a-z0-9-]+-\d+\.json$/; // 보관함은 회사 전체(여러 크루) — id 앞부분이 slug

/** 현재(활성) 대화명 편집 — 활성 스레드 파일에 title 기록. '새 대화'로 적재되면 보관본에 그대로 승계된다
    (resetThread가 t 통째 보관 — 이름 붙인 대화가 레일에서도 그 이름으로 남는 것이 자연스러운 기대). */
export async function renameActiveThread(wsId, slug, title) {
  return lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug);
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (clean) t.title = clean; else delete t.title;
    await writeJsonAtomic(file(wsId, slug), t);
    return { id: null, title: t.title ?? null };
  });
}

/** 위임 제한 스위치 — true = 켜짐(기본, 크루 간 위임 2회·2단계), false = 사용자가 이 대화에서 푼 상태(안전 상한까지).
    활성 스레드 파일 안에 한 필드(delegationLimit)로 둔다 — 대화명(title)과 같은 방식이라 appendTurn(스레드 통째 재기록)이 값을 보존하고,
    '새 대화'로 보관되면 보관본이 값을 들고 가며(이어가기 때 되돌아온다), 동기화 병합(mergeThread의 스칼라 필드 우선순위)을 그대로 탄다.
    읽기 실패(손상 등)는 켜짐 — 풀림은 사용자의 명시 선택이 읽힌 때만 효력이 있다(fail-closed). */
export async function getDelegationLimit(wsId, slug) {
  try { return !isRelaxedStored(await readJson(file(wsId, slug), {})); } catch { return true; }
}
export async function setDelegationLimit(wsId, slug, on) {
  return lockThread(wsId, slug, async () => {
    const t = await loadThread(wsId, slug);
    const want = on !== false;
    if (want === !isRelaxedStored(t)) return { limit: want }; // 이미 그 상태면 쓰지 않는다(필드 부재 = 켜짐) — 불필요한 동기화 업로드·mtime 갱신 방지
    t.delegationLimit = want; // 끌 때 false, 다시 켤 때도 **명시적 true**(필드 삭제 금지 — 동기화 병합이 다른 기기의 옛 false를 되살린다)
    await writeJsonAtomic(file(wsId, slug), t);
    return { limit: want };
  });
}

/** 대화명 편집 — 보관 세션 파일에 title을 기록(레일·보관함 표시는 title 우선, 없으면 gist). */
export async function renameSession(wsId, slug, id, title) {
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  if (!ARCH_ID(safe).test(id)) throw new Error('잘못된 세션 id');
  return lockThread(wsId, slug, async () => {
    const f = join(paths(wsId).chats, '.archive', id);
    const t = JSON.parse(await readFile(f, 'utf8'));
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (clean) t.title = clean; else delete t.title;
    await writeJsonAtomic(f, t);
    return { id, title: t.title ?? null };
  });
}

/** 세션 고정/해제 — 보관 세션 파일에 pinned를 기록(renameSession과 동일 in-file·원자적 쓰기 패턴).
    고정 세션은 레일 상단에 최근순으로 묶인다. resume로 아카이브가 사라지면 핀도 함께 사라진다(핀=보관 대화 표식). */
export async function setPinned(wsId, slug, id, pinned) {
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  if (!ARCH_ID(safe).test(id)) throw new Error('잘못된 세션 id');
  return lockThread(wsId, slug, async () => {
    const f = join(paths(wsId).chats, '.archive', id);
    const t = JSON.parse(await readFile(f, 'utf8'));
    if (pinned) t.pinned = true; else delete t.pinned;
    await writeJsonAtomic(f, t);
    return { id, pinned: t.pinned === true };
  });
}

/** 세션 삭제(보관) — .archive → .trash 이동. 레일에서 사라지고 설정 보관함에 나타난다(복구 가능). */
export async function trashSession(wsId, slug, id) {
  const safe = slug.replace(/[^a-z0-9-]/g, '');
  if (!ARCH_ID(safe).test(id)) throw new Error('잘못된 세션 id');
  return lockThread(wsId, slug, async () => {
    const from = join(paths(wsId).chats, '.archive', id);
    const data = JSON.parse(await readFile(from, 'utf8')); // 존재 검증 겸 읽기
    await mkdir(trashDir(wsId), { recursive: true });
    await writeJsonAtomic(join(trashDir(wsId), id), data);
    await rm(from, { force: true });
    return { id };
  });
}

/** 보관함 목록 — 회사 전체(모든 크루)의 삭제된 대화. 설정 보관함의 원천(최신순). */
export async function listTrashedSessions(wsId) {
  const dir = trashDir(wsId);
  let names = [];
  try { names = (await readdir(dir)).filter((n) => ANY_ARCH_ID.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const t = JSON.parse(await readFile(join(dir, n), 'utf8'));
      const m = n.match(/^([a-z0-9-]+)-(\d+)\.json$/);
      const firstUser = (t.messages ?? []).find((x) => x.who === 'user' && !x.shared && !x.via); // 레일 gist와 동일 규칙
      out.push({
        id: n, slug: m?.[1] ?? '', ts: Number(m?.[2] ?? 0),
        count: t.messages?.length ?? 0,
        title: t.title ?? null,
        gist: String(firstUser?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 42),
      });
    } catch { /* 깨진 항목 건너뜀 */ }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/** 복구 — .trash → .archive (다시 크루 레일에 나타난다). id 앞부분이 slug라 원래 크루로 돌아간다. */
export async function restoreTrashed(wsId, id) {
  if (!ANY_ARCH_ID.test(id)) throw new Error('잘못된 세션 id');
  const from = join(trashDir(wsId), id);
  const to = join(paths(wsId).chats, '.archive', id);
  const data = JSON.parse(await readFile(from, 'utf8'));
  await mkdir(dirname(to), { recursive: true });
  await writeJsonAtomic(to, data);
  await rm(from, { force: true });
  return { id };
}

/** 영구 삭제 — 보관함에서 완전히 제거(복구 불가). */
export async function purgeTrashed(wsId, id) {
  if (!ANY_ARCH_ID.test(id)) throw new Error('잘못된 세션 id');
  await rm(join(trashDir(wsId), id), { force: true });
  return { id };
}

/** 이 크루의 대화 파일(활성·보관·보관함)에 남은 메신저 채널 id 전부 — 기억 회수 판정에 물을 목록. */
export async function threadChannelIds(wsId, slug) {
  const out = new Set();
  for (const f of await threadFiles(wsId, slug)) {
    const t = await readJson(f, null).catch(() => null);
    for (const c of channelIdsOf(t)) out.add(c);
  }
  return out;
}

/** 채널 기억 회수 — 이 크루의 활성·보관·보관함 대화에서 그 채널 줄과 채널 세션을 지우고 각인(departed)을 남긴다.
    활성 스레드 잠금 하나로 직렬화한다(보관·보관함 편집과 같은 잠금). 반환: 지운 줄 수, 지운 세션 id(전사 파일 정리용). */
export async function forgetThreadChannels(wsId, slug, ids) {
  if (!ids?.length) return { removed: 0, sessionIds: [] };
  return lockThread(wsId, slug, async () => {
    let removed = 0; const sessionIds = [];
    const hit = new Set(ids.map((x) => String(x).toLowerCase()));
    const files = [];
    for (const f of await threadFiles(wsId, slug)) {
      const t = await readJson(f, null).catch(() => null);
      if (t && Array.isArray(t.messages)) files.push([f, t]);
    }
    // 각인 시각은 모든 파일(활성·보관·보관함)에 걸친 그 채널 줄의 가장 늦은 ts — 활성 파일에는 줄이 없어도 각인을 쓴다.
    // 채널 줄이 보관본에만 있을 때 활성에 각인이 없으면, 각인 없는 옛 보관본이 동기화로 돌아와도 거를 근거가 없다(재검수 L-a).
    const ts = {};
    for (const [, t] of files) for (const m of t.messages) { const c = msgChannel(m); if (c && hit.has(c)) ts[c] = Math.max(ts[c] ?? 0, Number(m.ts) || 0); }
    const active = file(wsId, slug);
    for (const [f, t] of files) {
      if (f !== active && ![...channelIdsOf(t)].some((c) => hit.has(c))) continue; // 그 채널 기록이 없는 보관본은 쓰지 않는다
      const r = forgetChannels(t, ids, ts);
      removed += r.removed; sessionIds.push(...r.sessionIds);
      await writeJsonAtomic(f, t);
    }
    return { removed, sessionIds };
  });
}

async function threadFiles(wsId, slug) {
  const safe = slug.replace(/[^a-z0-9-]/g, ''); // 보관본 이름 규칙(resetThread·listArchivedSessions)과 같다
  const out = [file(wsId, slug)];
  for (const dir of [join(paths(wsId).chats, '.archive'), trashDir(wsId)]) {
    try { for (const n of await readdir(dir)) if (ARCH_ID(safe).test(n)) out.push(join(dir, n)); } catch { /* 폴더 없음 */ }
  }
  return out;
}

// 채널 세션 장부(기기 로컬 — 점 파일이라 동기화되지 않는다): <회사>/.msgr-sessions.json = { "<slug>:<channelId>": [세션 id…] }.
// 채널·DM 턴이 이 기기에서 쓴 세션 id를 모두 남긴다 — 스레드에는 마지막 하나만 남아(기기 전환·새 세션 재시도) 회수 때 전사를 다 못 지운다(설계 검수 H3).
const ledgerFile = (wsId) => join(paths(wsId).root, '.msgr-sessions.json');
const LEDGER_MAX = 50; // ponytail: 채널당 최근 50개 — 더 오래된 전사는 SDK가 따로 정리한다
async function noteChannelSession(wsId, slug, scope, sessionId) {
  const c = msgChannel({ contextScope: scope });
  if (!c || !sessionId) return;
  await withLock(`msgr-sessions:${wsId}`, async () => {
    const l = await readJson(ledgerFile(wsId), {}).catch(() => null);
    if (!l) return; // 손상된 장부를 빈 것으로 덮으면 다른 채널의 세션 id가 사라진다(분리 검수 L-5)
    const k = `${slug}:${c}`; const list = Array.isArray(l[k]) ? l[k] : [];
    if (list.includes(sessionId)) return;
    l[k] = [...list, sessionId].slice(-LEDGER_MAX);
    await writeJsonAtomic(ledgerFile(wsId), l);
  }, { file: ledgerFile(wsId) }).catch(() => {}); // 장부 실패가 턴 기록을 막지 않는다
}
/** 회수 — 그 채널들의 장부 세션 id를 꺼내고 장부에서 지운다. */
export async function takeChannelSessions(wsId, slug, ids) {
  return withLock(`msgr-sessions:${wsId}`, async () => {
    const l = await readJson(ledgerFile(wsId), {}).catch(() => null);
    if (!l) return [];
    const out = [];
    for (const id of ids) { const k = `${slug}:${String(id).toLowerCase()}`; if (Array.isArray(l[k])) { out.push(...l[k]); delete l[k]; } }
    if (out.length) await writeJsonAtomic(ledgerFile(wsId), l);
    return out;
  }, { file: ledgerFile(wsId) });
}
/** 장부에 남은 이 크루의 채널 id — 스레드 줄이 이미 없어도 전사가 남은 채널까지 묻는다. */
export async function channelSessionIds(wsId, slug) {
  const l = await readJson(ledgerFile(wsId), {}).catch(() => ({}));
  return Object.keys(l).filter((k) => k.startsWith(`${slug}:`)).map((k) => k.slice(slug.length + 1));
}
