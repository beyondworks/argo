// 세션 메시지 — 크루 A의 대화방에서 크루 B가 이어 가던 대화 세션으로 메시지를 넣고, B의 답을 A로 돌려준다
// (Claude Code의 SendMessage·Codex 세션 메시지와 같은 개념, 유건 요청 2026-10-02).
//
// 이미 있는 통로와 다른 점:
//   delegate(chat.mjs)  — 부른 턴이 결과를 **기다린다**(동기). 위임받은 쪽은 새 세션(sessionId null)으로 돈다.
//   쪽지(crewmail.mjs)   — 파일로 적재하고 스케줄러가 **60초 틱**에 배달한다. 받은 쪽은 새 세션, 답은 또 다른 쪽지다.
//   세션 메시지(여기)    — B가 **이어 가던 세션**(B 스레드의 sessionId)에 들어가고, B의 답은 기다리던 A에게 **돌아온다**.
//                          보낸 쪽은 기다리지 않고 턴을 끝내며, 답이 기록되는 순간 깨운다(타이머·틱 확인 없음).
//
// 흐름:
//   보내기 ─ 사장(A 방 입력창의 @B)·크루 A(send_session_message 도구) → sendSessionMessage
//          → B 방에 출처 표지(src)가 붙은 대기 줄(beginTurn) → B 크루 대기열(이 프로세스) → B가 한가해지면(whenCrewIdle) B 턴 1번
//   돌려주기 ─ 사장이 보낸 것: A 방에 B 답 카드 한 줄(A 턴 0번)
//            크루 A가 보낸 것: A 방에 알림 줄 + A 턴 1번(A가 이어 가던 세션으로 깨운다)
//
// 지키는 규칙:
//   - 같은 회사 크루끼리만(listAgents — 해고된 크루는 카드가 없어 자동 제외). 외부 에이전트 크루(runner: http)는 제외.
//   - 사슬 단계 상한 sessionHopCap — 사슬을 시작한 대화방의 위임 제한 스위치(켜짐 2·풀림 4, delegation-limits.mjs). hop은 delegate·쪽지와 같은 값이라
//     B 턴 안의 위임·쪽지도 같은 상한을 공유한다. 상한에 닿으면 보내지 않고 보낸 쪽 방에 안내를 남긴다.
//   - 합계 예산: 사슬마다 위임과 같은 합계 예산(delegation-limits.mjs tree, 30턴)을 싣고 B 턴·깨움 턴을 보낼 때 미리 차감한다.
//     풀린 대화방의 사장 직접 턴에서 시작하면 그 턴의 위임 예산을 같이 쓴다(위임·쪽지·세션 메시지가 한 지시의 30턴을 나눠 쓴다).
//   - 같은 방 → 같은 상대로 답을 기다리는 중이면 다시 보내지 않는다(DUP). 이름이 겹치면 보내지 않는다(AMBIGUOUS — slug는 정확히 일치가 먼저).
//   - 기다림에는 기한(SESSION_TTL_MS)이 있다. 프로세스가 죽어 대기 기록이 남으면 다음 부팅 정리(sweepSessionMessages)가 안내와 함께 지운다.
//   - B가 다른 턴을 실행 중이면 끝날 때까지 기다렸다 다음 턴으로 돈다(동시 실행을 만들지 않는다).
//
// 저장: <ws root>/sessmsg/pending.json — 기다리는 기록만(답이 오거나 기한·정리로 끝나면 지운다). 이 프로세스의 상태라 동기화 제외(sync.mjs EXCLUDE).
// 쓰기는 보낼 때·끝날 때·정리할 때만 한다.
import { mkdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { paths, loadCompany } from './workspace.mjs';
import { listAgents, listCompanyIds } from './hub.mjs';
import { beginTurn, appendTurn, appendLine, loadThread, getDelegationLimit, nextThreadWrite } from './thread.mjs';
import { crewBusy, whenCrewIdle } from './turn-abort.mjs';
import { readJsonLenient, writeJsonAtomic } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { DELEGATION_LIMITS, newTree, getTree, spendTree } from './delegation-limits.mjs';

/** 사슬 단계 상한 — 사장 → A(0) → B(1) → … 한 사슬에서 세션 메시지로 이어지는 단계. 위임 제한 스위치를 따른다(유건 2026-10-03):
    사슬을 **시작한 대화방**이 켜짐이면 2단계, 풀림이면 4단계. 값은 사슬에 실려(rec.relaxed → chat opts sessionChain → 도구) 끝까지 가고,
    중간 크루의 방 설정으로 바뀌지 않는다. SESSION_HOP_CAP = 켜짐 값(옛 소비자·테스트 호환). */
export const sessionHopCap = (relaxed) => (relaxed === true ? DELEGATION_LIMITS.off.hop : DELEGATION_LIMITS.on.hop);
export const SESSION_HOP_CAP = sessionHopCap(false);
/** 답을 기다리는 기한 — B 턴(CLI 최대 30분·재시도)과 앞 턴 대기를 넉넉히 덮는다. */
export const SESSION_TTL_MS = 2 * 3600_000;
const MAX_MESSAGE = 8000;
const MAX_REPLY_IN_WAKE = 12000;
/** 실행 등록이 풀린 뒤 스레드 기록(appendTurn — 새 sessionId)이 오기를 기다리는 최대 시간. 그 안에 기록이 오면 바로 깨고, 안 오면(다른 프로세스의
    닫히지 않은 줄 등) 더 기다리지 않고 진행한다 — 타이머 1개, 주기 확인 없음. */
const RECORD_GRACE_MS = 10_000;
const grace = () => S.grace ?? RECORD_GRACE_MS;
/** 기록을 만든 프로세스가 살아 있어도 기한 + 이 여유가 지나면 정리한다(pid 재사용·멈춘 프로세스 — 통합본 재검수 LOW-1). */
const STALE_AFTER_DEADLINE_MS = 30 * 60_000;
const BOOT_AT = Date.now() - process.uptime() * 1000;

// 상태는 globalThis에 — Next는 서버 진입점마다 모듈을 따로 번들한다(turn-abort.mjs와 같은 이유). API 라우트와 크루 도구가 같은 대기 목록을 봐야 한다.
const S = (globalThis.__argoSessMsg ??= {
  pending: new Map(), // `${ws}:${room}>${to}` → rec
  queues: new Map(),  // `${ws}:${slug}` → 그 크루 앞으로 줄 선 마지막 작업
  jobs: new Set(),
  timers: new Map(),  // rec.id → 기한 타이머
  runTurn: null,
  ttl: null,
  grace: null,
  budgetNoticed: new Set(), // 예산을 모르는(이 프로세스가 모르는) 사슬의 안내 한 번 — 아는 예산은 예산 객체에 표시한다
  owner: `${process.pid}-${Math.round(BOOT_AT)}`,
});
S.budgetNoticed ??= new Set(); // 이 필드가 없던 버전이 먼저 만든 상태 객체(같은 프로세스의 다른 번들 사본)

const fail = (code, message) => Object.assign(new Error(message), { code });
const pairKey = (ws, room, to) => `${ws}:${room}>${to}`;
const fileOf = (ws) => join(paths(ws).root, 'sessmsg', 'pending.json');
const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().trim();
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
const ttl = () => S.ttl ?? SESSION_TTL_MS;

async function runTurn(...a) {
  if (S.runTurn) return S.runTurn(...a);
  const { chat } = await import('./chat.mjs'); // 지연 — chat.mjs가 크루 도구에서 이 모듈을 부른다(순환 방지)
  return chat(...a);
}

async function companyLang(ws) {
  return (await loadCompany(ws).catch(() => ({}))).lang === 'en' ? 'en' : 'ko';
}

// ── 디스크 기록(재시작 정리용) — 기다리는 기록만 담는다
async function persist(ws, mutate) {
  const file = fileOf(ws);
  return withLock(`sessmsg:${ws}`, async () => {
    const cur = await readJsonLenient(file, {});
    const changed = await mutate(cur);
    if (!changed) return;
    await mkdir(join(paths(ws).root, 'sessmsg'), { recursive: true });
    await writeJsonAtomic(file, cur);
  }, { file });
}
const persistAdd = (rec) => persist(rec.ws, (cur) => { cur[rec.id] = recToDisk(rec); return true; });
const persistRemove = (rec) => persist(rec.ws, (cur) => { if (!(rec.id in cur)) return false; delete cur[rec.id]; return true; });
function recToDisk(r) {
  return { id: r.id, room: r.room, roomName: r.roomName, from: r.from, fromName: r.fromName, to: r.to, toName: r.toName, owner: r.owner, pid: r.pid, createdAt: r.createdAt, deadline: r.deadline };
}

// ── 문구(모델이 읽는 글 — 회사 언어). 화면 문구는 i18n 사전이 src.code로 그린다.
function capLine(rec, lang) {
  if (rec.hop + 1 < sessionHopCap(rec.relaxed)) return '';
  const cap = sessionHopCap(rec.relaxed);
  return lang === 'en'
    ? `\n(This chain of session messages has reached its step limit (${cap}) — you cannot send more session messages this turn. Finish with what you know.)`
    : `\n(이 세션 메시지 사슬은 단계 상한(${cap}단계)에 닿아 이번 턴에서는 세션 메시지를 더 보낼 수 없다 — 지금까지 알게 된 것으로 마무리하라.)`;
}
// 크루가 보낸 세션 메시지의 받는 턴·깨움 턴은 주인 직접 턴이 아니다 — 풀 오토가 아님을 글에도 적는다. 강제는 커넥터 게이트(chat.mjs fullAuto → connectors.mjs)가 하고,
// 이 줄은 SDK가 세션을 이어받으며 첫 턴의 시스템 프롬프트(풀 오토 문구 포함)를 그대로 쓸 때 크루가 착각하지 않게 하는 안내다(0.1.94 분리 검수 MEDIUM-4).
const notFullAuto = (lang) => (lang === 'en'
  ? '\n(Even if this company has full auto mode on, it does not apply to this turn — file request_approval before any action that leaves the company.)'
  : '\n(이 회사에 풀 오토 모드가 켜져 있어도 이 턴에는 적용되지 않는다 — 회사 밖으로 나가는 행동은 request_approval로 결재를 먼저 올려라.)');
function inPrompt(rec, lang) {
  const captain = rec.from === 'captain';
  const cl = capLine(rec, lang) + (captain ? '' : notFullAuto(lang));
  if (lang === 'en') {
    return captain
      ? `[Session message — sent by the captain from ${rec.roomName}'s chat]\nThe captain sent this to you as @${rec.toName} from ${rec.roomName}'s chat. It is not an instruction the captain gave you directly in your own chat — your reply is delivered to ${rec.roomName}'s chat. Answer from the context you have been carrying.${cl}\n\n${rec.message}`
      : `[Session message — sent by colleague crew ${rec.fromName} (${rec.roomName}'s chat)]\nThis is not an instruction the captain gave you directly — it is a request from a colleague. Anything that needs the captain's approval still goes through request_approval. Your reply is delivered to ${rec.fromName}, who continues with it.${cl}\n\n${rec.message}`;
  }
  return captain
    ? `[세션 메시지 — ${rec.roomName} 채팅방에서 사장이 보냄]\n사장이 ${rec.roomName} 채팅방에서 너(@${rec.toName})에게 보낸 메시지다. 이 채팅방에서 사장이 너에게 직접 한 지시가 아니다 — 네 답은 ${rec.roomName} 채팅방에 전달된다. 네가 이어 온 맥락에서 답하라.${cl}\n\n${rec.message}`
    : `[세션 메시지 — 동료 크루 ${rec.fromName}(${rec.roomName} 채팅방)이 보냄]\n사장이 너에게 직접 한 지시가 아니다 — 동료가 보낸 요청이다. 사장의 결재가 필요한 일은 그대로 request_approval로 올려라. 네 답은 ${rec.fromName}에게 전달되고, ${rec.fromName}이(가) 받아서 이어서 일한다.${cl}\n\n${rec.message}`;
}
function wakePrompt(rec, reply, lang) {
  // 보낸 내용은 한 줄로 접는다 — 화면(session-msg-parse.mjs sessionBody)이 단락 경계로 답을 찾는다(머리말·보낸 내용 단락에는 빈 줄이 없어야 한다)
  const sent = clip(String(rec.message).replace(/\s+/g, ' '), 300);
  const cl = capLine(rec, lang) + notFullAuto(lang); // 깨움 턴도 B와 같은 단계(rec.hop + 1), 동료의 답으로 깨운 턴이라 풀 오토가 아니다
  return lang === 'en'
    ? `[Session message reply — colleague crew ${rec.toName}]\n${rec.toName} answered the session message you sent. This is not a direct instruction from the captain. Use the answer to continue what you were doing; if nothing else is needed, report the result to the captain.${cl}\n\nYou sent: ${sent}\n\n${rec.toName}'s answer:\n${clip(reply, MAX_REPLY_IN_WAKE)}`
    : `[세션 메시지 답 — 동료 크루 ${rec.toName}]\n네가 ${rec.toName}에게 보낸 세션 메시지에 답이 왔다. 사장의 직접 지시가 아니다. 이 답을 반영해 하던 일을 이어 가고, 더 할 일이 없으면 사장에게 결과를 보고하라.${cl}\n\n보낸 내용: ${sent}\n\n${rec.toName}의 답:\n${clip(reply, MAX_REPLY_IN_WAKE)}`;
}
function noticeText(code, { toName, cap, detail }, lang) {
  const en = lang === 'en';
  switch (code) {
    case 'capReached': return en ? `This chain of session messages reached its step limit (${cap}), so crews will not message each other further from here.` : `세션 메시지 사슬이 상한(${cap}단계)에 닿아 이 뒤로는 크루끼리 더 주고받지 않습니다.`;
    case 'budget': return en ? `Crew turns from this instruction reached the total limit, so no session message was sent to ${toName}.` : `이번 지시에서 이어진 크루 턴이 합계 상한에 닿아 ${toName}에게 세션 메시지를 보내지 않았습니다.`;
    case 'cap': return en ? `Session messages between crews reached the chain limit (${cap} steps), so nothing more was sent to ${toName}.` : `크루끼리 주고받은 세션 메시지가 사슬 상한(${cap}단계)에 닿아 ${toName}에게 더 보내지 않았습니다.`;
    case 'expired': return en ? `No reply from ${toName} within the time limit, so stopped waiting.` : `${toName}의 답이 기한 안에 오지 않아 기다림을 끝냈습니다.`;
    case 'restart': return en ? `The server restarted before ${toName} replied, so the reply will not arrive.` : `${toName}이(가) 답하기 전에 서버가 다시 시작되어 답을 받지 못했습니다.`;
    default: return en ? `${toName} could not answer the session message${detail ? `: ${detail}` : '.'}` : `${toName}이(가) 세션 메시지에 답하지 못했습니다${detail ? `: ${detail}` : '.'}`;
  }
}
async function notice(ws, room, code, { id = null, to = null, toName = null, cap, detail } = {}, lang) {
  const text = noticeText(code, { toName, cap, detail }, lang ?? await companyLang(ws));
  return appendLine(ws, room, { who: 'crew', text, src: { kind: 'session', dir: 'notice', code, ...(id ? { id } : {}), ...(to ? { from: to, fromName: toName } : {}), ...(cap ? { cap } : {}) } })
    .catch((e) => console.error(`[argo] 세션 메시지 안내 기록 실패(${ws}/${room}):`, e?.message ?? e));
}

// ── 크루 대기열 — 같은 크루 앞으로 온 작업은 순서대로, 각 작업은 그 크루가 한가해진 뒤에 시작한다.
function enqueue(ws, slug, job) {
  const k = `${ws}:${slug}`;
  const next = (S.queues.get(k) ?? Promise.resolve()).then(job)
    .catch((e) => console.error(`[argo] 세션 메시지 작업 실패(${k}):`, e?.message ?? e));
  S.queues.set(k, next); S.jobs.add(next);
  next.finally(() => { S.jobs.delete(next); if (S.queues.get(k) === next) S.queues.delete(k); });
}
/** 크루가 한가해질 때까지 기다리고, 그 순간의 세션 id를 돌려준다. 읽는 사이 다른 턴이 시작했으면 다시 기다린다.
    실행 등록은 chat()이 끝나는 순간 풀리지만 새 sessionId는 그 뒤 호출부의 appendTurn이 쓴다(채팅 라우트·CLI) — 그 사이에 읽으면 직전 세션을
    잃고 새 세션으로 덮는다(0.1.94 분리 검수 MEDIUM-2). 그래서 이 크루 스레드에 세션 메시지가 아닌 닫히지 않은 턴(awaiting)이 남아 있으면 그 기록을
    기다린다(appendTurn이 깨운다). RECORD_GRACE_MS 안에 안 닫히면 다른 프로세스의 줄로 보고 진행한다. */
async function idleSession(ws, slug) {
  let graceUntil = 0;
  for (;;) {
    // 크루가 다시 바빴다면(새 턴이 돌았다면) 그 턴의 기록을 기다릴 시간을 새로 잡는다(통합본 재검수 LOW-2)
    if (crewBusy(ws, slug)) graceUntil = 0;
    await whenCrewIdle(ws, slug);
    const written = nextThreadWrite(ws, slug); // 읽기 전에 걸어 둔다 — 읽는 사이 끝난 기록을 놓치지 않게
    const t = await loadThread(ws, slug).catch(() => ({ sessionId: null, messages: [] }));
    if (crewBusy(ws, slug)) { written.cancel(); continue; }
    // 이 프로세스가 시작되기 전의 열린 줄은 이전 프로세스의 고아다(고아 턴 정리가 곧 닫는다) — 기다리지 않는다(LOW-3).
    // 부팅 뒤 생긴 줄이 이 프로세스 것인지 같은 폴더를 쓰는 다른 프로세스(CLI 등) 것인지는 줄에 표시가 없어 가르지 못한다 — 그 경우만 대기 상한까지 기다린다.
    const open = (t.messages ?? []).some((m) => m.awaiting && m.turnId && m.via !== 'session' && (m.ts ?? 0) >= BOOT_AT);
    if (!open) { written.cancel(); return t.sessionId ?? null; }
    const now = Date.now();
    if (!graceUntil) graceUntil = now + grace();
    if (now >= graceUntil) { written.cancel(); return t.sessionId ?? null; }
    let timer;
    await Promise.race([written.promise, new Promise((r) => { timer = setTimeout(r, graceUntil - now); timer.unref?.(); })]);
    clearTimeout(timer); written.cancel();
  }
}
const handoverRel = (ws, h) => (h?.file ? { rel: relative(paths(ws).vault, h.file), linked: h.linked } : null);

/** 기다림 끝 — 대기 목록·디스크·타이머에서 지운다. 이미 끝났으면(기한·정리) false. */
async function settle(rec) {
  const key = pairKey(rec.ws, rec.room, rec.to);
  if (S.pending.get(key) !== rec) return false;
  S.pending.delete(key);
  clearTimeout(S.timers.get(rec.id)); S.timers.delete(rec.id);
  await persistRemove(rec).catch((e) => console.error(`[argo] 세션 메시지 기록 정리 실패(${rec.ws}):`, e?.message ?? e));
  return true;
}

/**
 * 세션 메시지 보내기.
 * sender: 'captain'(사장이 A 방 입력창에서 @B) | { slug }(크루 A가 도구로 — slug는 room과 같아야 한다)
 * hop·chain: 보낸 턴의 단계·사슬(사장은 0·[]). relaxed: 크루가 보낼 때 이 사슬의 위임 제한 풀림 여부(도구가 이어받은 값 — 엄격한 true만 풀림).
 *   사장이 보내면 이 값은 무시하고 보낸 방(room)의 스위치를 읽는다 — 그 방이 사슬의 시작이다.
 * 반환: { id, line(사장이 보낸 경우 A 방에 남긴 줄), tree(사슬 예산 id) }
 * tree: 이 사슬의 합계 예산 id(delegation-limits). 없으면 새 예산으로 시작하고, 있는데 이 프로세스가 모르면 보내지 않는다(fail-closed).
 * 오류 code: EMPTY·TOO_LONG·NOT_FOUND·AMBIGUOUS·SELF·SENDER·CHAIN_CAP·TREE_CAP·DUP
 */
export async function sendSessionMessage(ws, { room, sender, to, message, hop = 0, chain = [], relaxed = false, tree = null }) {
  const text = String(message ?? '').trim();
  if (!text) throw fail('EMPTY', '보낼 내용이 없습니다');
  if (text.length > MAX_MESSAGE) throw fail('TOO_LONG', `세션 메시지는 ${MAX_MESSAGE}자까지입니다`);
  const agents = await listAgents(ws); // paths()가 회사 id를 검증한다 — 다른 회사 크루는 이 목록에 없다
  // slug 정확히 일치가 먼저, 이름은 그 다음 — 이름이 겹치면 어느 크루인지 모르므로 보내지 않는다(L7)
  const bySlug = (v) => agents.find((a) => norm(a.slug) === norm(v));
  const roomCrew = bySlug(room);
  if (!roomCrew) throw fail('NOT_FOUND', '보내는 채팅방의 크루를 찾을 수 없습니다');
  let target = bySlug(to);
  if (!target) {
    const named = agents.filter((a) => norm(a.name) === norm(to));
    if (named.length > 1) throw fail('AMBIGUOUS', `"${to}" 이름의 크루가 여럿입니다 — slug(${named.map((a) => a.slug).join(', ')})로 보내 주세요`);
    target = named[0];
  }
  // 외부 에이전트 크루(runner: http)는 이 회사의 두뇌로 돌지 않는다(chat.mjs가 실행을 거절) — 보낼 대상이 아니다
  if (!target || norm(target.runner) === 'http') throw fail('NOT_FOUND', `"${to}"은(는) 이 회사의 크루가 아닙니다`);
  if (target.slug === roomCrew.slug) throw fail('SELF', '자기 자신에게는 보낼 수 없습니다');
  const captain = sender === 'captain';
  if (!captain && sender?.slug !== roomCrew.slug) throw fail('SENDER', '크루는 자기 채팅방에서만 보낼 수 있습니다');
  const lang = await companyLang(ws);
  const h = Math.max(0, Math.floor(Number(hop) || 0));
  const chainRelaxed = captain ? !(await getDelegationLimit(ws, roomCrew.slug)) : relaxed === true; // 읽기 실패는 켜짐(getDelegationLimit fail-closed)
  const cap = sessionHopCap(chainRelaxed);
  if (h >= cap) {
    await notice(ws, roomCrew.slug, 'cap', { to: target.slug, toName: target.name, cap }, lang);
    throw fail('CHAIN_CAP', `사슬 상한(${cap}단계)에 닿았습니다`);
  }
  await sweepWorkspace(ws).catch(() => 0); // 부팅 정리 전에 보내도 죽은 프로세스의 기록이 중복 판정을 막지 않게
  const key = pairKey(ws, roomCrew.slug, target.slug);
  if (S.pending.has(key)) throw fail('DUP', `${target.name}의 답을 기다리는 중입니다`);
  // 합계 예산 — B 턴 1 + (크루가 보냈으면) 답이 오면 깨울 턴 1을 미리 차감한다. 모자라면 한 턴도 만들지 않는다.
  const budget = tree ? getTree(tree) : newTree({ kind: 'session' });
  const cost = captain ? 1 : 2;
  if (!budget || !spendTree(budget, cost)) {
    // 사슬마다 한 번만 안내(noticeCapOnce와 같은 규칙 — 통합본 재검수 LOW-4). 이 프로세스가 모르는 예산 id도 id 단위로 한 번
    const first = budget ? !budget.sessionBudgetNoticed : !S.budgetNoticed.has(String(tree));
    if (budget) budget.sessionBudgetNoticed = true;
    else { if (S.budgetNoticed.size > 1000) S.budgetNoticed.clear(); S.budgetNoticed.add(String(tree)); }
    if (first) await notice(ws, roomCrew.slug, 'budget', { to: target.slug, toName: target.name }, lang);
    throw fail('TREE_CAP', '이번 지시에서 이어진 크루 턴이 합계 상한에 닿았습니다');
  }
  const now = Date.now();
  const rec = {
    id: `sm${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, ws,
    room: roomCrew.slug, roomName: roomCrew.name,
    from: captain ? 'captain' : roomCrew.slug, fromName: captain ? (lang === 'en' ? 'Captain' : '사장') : roomCrew.name,
    to: target.slug, toName: target.name, message: text, hop: h, chain: Array.isArray(chain) ? chain.map(String) : [], relaxed: chainRelaxed, tree: budget.id,
    owner: S.owner, pid: process.pid, createdAt: now, deadline: now + ttl(), turnId: null, expired: false,
  };
  S.pending.set(key, rec); // 확인과 등록 사이에 await가 없다 — 동시에 두 번 눌러도 하나만 지난다
  let line = null;
  try {
    await persistAdd(rec);
    if (captain) line = await appendLine(ws, rec.room, { who: 'user', text: `@${rec.toName} ${text}`, src: { kind: 'session', dir: 'out', id: rec.id, to: rec.to, toName: rec.toName } });
    const prompt = inPrompt(rec, lang);
    rec.turnId = await beginTurn(ws, rec.to, { userMsg: prompt, via: 'session', src: { kind: 'session', dir: 'in', id: rec.id, room: rec.room, roomName: rec.roomName, from: rec.from, fromName: rec.fromName } });
    const timer = setTimeout(() => { expire(rec).catch(() => {}); }, Math.max(0, rec.deadline - Date.now()));
    timer.unref?.(); S.timers.set(rec.id, timer);
    enqueue(ws, rec.to, () => runIncoming(rec, prompt, lang));
  } catch (e) {
    await settle(rec);
    budget.left += cost; // 만들지 못한 턴의 예산은 되돌린다
    throw e;
  }
  return { id: rec.id, line, tree: rec.tree }; // tree = 이 사슬의 합계 예산 id — 같은 턴의 다음 전송이 이어 쓴다
}

/** B 턴 — 한가해지면 B가 이어 가던 세션으로 한 번 돈다. */
/** 이 사슬이 상한 단계의 턴을 처음 만들 때 그 크루 방에 한 번 알린다(사슬 = 합계 예산 하나). 그 단계 턴에는 도구가 없어 실패한 호출이 안내를 쌓지 않는다(L1). */
async function noticeCapOnce(rec, slug, lang) {
  const cap = sessionHopCap(rec.relaxed);
  if (rec.hop + 1 < cap) return;
  const t = getTree(rec.tree);
  if (!t || t.sessionCapNoticed) return;
  t.sessionCapNoticed = true;
  await notice(rec.ws, slug, 'capReached', { cap }, lang);
}
const chainOf = (rec) => ({ relaxed: rec.relaxed, tree: rec.tree });

async function runIncoming(rec, prompt, lang) {
  const sid = rec.expired ? null : await idleSession(rec.ws, rec.to);
  if (rec.expired) { // 차례가 오기 전에 기한이 지났다 — 실행하지 않고 B 방의 대기 줄을 정직하게 닫는다
    await appendTurn(rec.ws, rec.to, { turnId: rec.turnId, userMsg: prompt, failed: lang === 'en' ? 'Not run — the wait expired before it was this crew\'s turn.' : '차례가 오기 전에 기한이 지나 실행하지 않았습니다.' }).catch(() => {});
    return;
  }
  let t;
  try {
    t = await runTurn(rec.ws, rec.to, prompt, sid, {
      source: 'session', from: rec.from === 'captain' ? null : rec.from,
      hop: rec.hop + 1, chain: rec.from === 'captain' ? rec.chain : [...rec.chain, rec.room], abortTag: rec.turnId, sessionChain: chainOf(rec), // 사장이 보낸 @B는 사장 직접 지시다 — 사슬에 A 크루를 넣지 않는다(넣으면 B가 올린 결재·작업이 'A의 위임'이 되어 풀 오토에서 빠진다)
    });
    await noticeCapOnce(rec, rec.to, lang);
  } catch (e) {
    const failed = String(e?.message || e);
    await appendTurn(rec.ws, rec.to, { turnId: rec.turnId, userMsg: prompt, failed, failedCode: e?.failCode ?? null, aborted: !!e?.aborted })
      .catch((err) => console.error(`[argo] 세션 메시지 실패 턴 기록 실패(${rec.ws}/${rec.to}):`, err?.message ?? err));
    if (await settle(rec)) await notice(rec.ws, rec.room, 'failed', { id: rec.id, to: rec.to, toName: rec.toName, detail: clip(failed, 160) }, lang);
    return;
  }
  await appendTurn(rec.ws, rec.to, { turnId: rec.turnId, userMsg: prompt, reply: t.reply, handover: handoverRel(rec.ws, t.handover), sessionId: t.sessionId,
    artifacts: t.artifacts, fellBack: t.fellBack, modelFallback: t.modelFallback, steerFailed: t.steerFailed })
    .catch((e) => console.error(`[argo] 세션 메시지 답 기록 실패(${rec.ws}/${rec.to}):`, e?.message ?? e));
  await deliverReply(rec, t.reply ?? '', lang);
}

/** B의 답을 A로 — 사장이 보냈으면 카드 한 줄, 크루가 보냈으면 A를 깨운다. 기한이 지난 뒤 온 답은 카드로만(깨우지 않는다 — 비용). */
async function deliverReply(rec, reply, lang) {
  const live = await settle(rec);
  if (rec.from === 'captain' || !live) {
    await appendLine(rec.ws, rec.room, { who: 'crew', text: reply, src: { kind: 'session', dir: 'reply', id: rec.id, from: rec.to, fromName: rec.toName, ...(live ? {} : { late: true }) } })
      .catch((e) => console.error(`[argo] 세션 메시지 답 카드 기록 실패(${rec.ws}/${rec.room}):`, e?.message ?? e));
    return;
  }
  // 보낸 크루가 그 사이 해고됐으면 깨우지 않는다(대화 기록은 남기지 않아도 된다 — 받을 사람이 없다)
  if (!(await listAgents(rec.ws).catch(() => [])).some((a) => a.slug === rec.room)) return;
  const prompt = wakePrompt(rec, reply, lang);
  const turnId = await beginTurn(rec.ws, rec.room, { userMsg: prompt, via: 'session', src: { kind: 'session', dir: 'reply', id: rec.id, from: rec.to, fromName: rec.toName } });
  enqueue(rec.ws, rec.room, async () => {
    const sid = await idleSession(rec.ws, rec.room);
    try {
      const t = await runTurn(rec.ws, rec.room, prompt, sid, { source: 'session', from: rec.to, hop: rec.hop + 1, chain: [...rec.chain, rec.to], abortTag: turnId, sessionChain: chainOf(rec) });
      await noticeCapOnce(rec, rec.room, lang);
      await appendTurn(rec.ws, rec.room, { turnId, userMsg: prompt, reply: t.reply, handover: handoverRel(rec.ws, t.handover), sessionId: t.sessionId,
        artifacts: t.artifacts, fellBack: t.fellBack, modelFallback: t.modelFallback, steerFailed: t.steerFailed });
    } catch (e) {
      await appendTurn(rec.ws, rec.room, { turnId, userMsg: prompt, failed: String(e?.message || e), failedCode: e?.failCode ?? null, aborted: !!e?.aborted }).catch(() => {});
    }
  });
}

/** 기한 — 아직 기다리는 중이면 기다림을 끝내고 A 방에 안내. 차례 전이면 B 턴도 돌지 않는다(runIncoming). */
async function expire(rec) {
  rec.expired = true;
  if (await settle(rec)) await notice(rec.ws, rec.room, 'expired', { id: rec.id, to: rec.to, toName: rec.toName });
}

/** 기록을 만든 프로세스가 아직 살아 있는가 — 신호 0은 존재 확인만 한다(EPERM = 살아 있으나 권한 없음). pid가 없으면(옛 기록) owner 앞자리. */
function ownerAlive(r) {
  const pid = Number(r.pid ?? String(r.owner ?? '').split('-')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid && r.owner !== S.owner) return false; // 같은 pid를 다시 받은 새 생애(컨테이너 재시작 등) — 이전 생애의 기록은 죽은 것(LOW-1)
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** 한 회사의 디스크 기록 정리 — 이 프로세스가 시작되기 전에 다른 프로세스가 남긴 기록(재시작)과 기한이 지난 기록. 바뀐 게 없으면 쓰지 않는다. */
async function sweepWorkspace(ws, now = Date.now()) {
  const dropped = [];
  await persist(ws, (cur) => {
    for (const [id, r] of Object.entries(cur)) {
      if (r.owner === S.owner) {
        // 이 프로세스의 기록 — 기다리는 중이면 그대로, 메모리에 없으면 끝난 것(settle이 디스크를 지우는 중)이라 안내 없이 지운다
        if (![...S.pending.values()].some((x) => x.id === id)) { delete cur[id]; dropped.push(null); }
        continue;
      }
      // 다른 프로세스(같은 폴더를 쓰는 앱·상주 등)가 살아 있으면 그 기다림은 그 프로세스의 것 — 기한도 그쪽 타이머가 맡는다(0.1.94 분리 검수 MEDIUM-3).
      // 단 기한 + 30분이 지나도 남아 있으면 pid를 다른 프로세스가 다시 받았거나 멈춘 것 — 살아 있어도 정리한다(LOW-1)
      const alive = ownerAlive(r);
      if (alive && now <= (r.deadline ?? 0) + STALE_AFTER_DEADLINE_MS) continue;
      const orphan = !alive && ((r.createdAt ?? 0) < BOOT_AT || !!r.pid); // pid가 있고 죽었으면 부팅 순서와 무관하게 끝난 프로세스. 살아 있는데 오래된 것은 기한 초과(expired)
      const late = (r.deadline ?? 0) < now;
      if (!orphan && !late) continue;
      delete cur[id];
      dropped.push({ ...r, code: orphan ? 'restart' : 'expired' });
    }
    return dropped.length > 0;
  });
  const told = dropped.filter(Boolean);
  for (const r of told) await notice(ws, r.room, r.code, { id: r.id, to: r.to, toName: r.toName });
  return told.length;
}

/** 부팅 정리 — 모든 회사(instrumentation-node.mjs가 부팅 몇 초 뒤 한 번). 반환: 정리한 기록 수. */
export async function sweepSessionMessages({ now = Date.now() } = {}) {
  let n = 0;
  for (const ws of await listCompanyIds().catch(() => [])) n += await sweepWorkspace(ws, now).catch(() => 0);
  return n;
}

// ── 테스트 전용
export function _setRunTurnForTest(fn) { S.runTurn = fn; }
export function _setTtlForTest(ms) { S.ttl = ms; }
export function _setGraceForTest(ms) { S.grace = ms; }
export async function _drainForTest() { while (S.jobs.size) await Promise.allSettled([...S.jobs]); }
export async function _resetForTest() {
  await _drainForTest();
  for (const t of S.timers.values()) clearTimeout(t);
  S.timers.clear(); S.pending.clear(); S.queues.clear(); S.ttl = null;
  for (const ws of await listCompanyIds().catch(() => [])) await rm(join(paths(ws).root, 'sessmsg'), { recursive: true, force: true }).catch(() => {});
}
