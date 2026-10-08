// 능동 비서 감시기 틱 — 스케줄러 60초 틱의 클라우드 리더 갈래에서 회사마다 부른다(scheduler.mjs `if (cloudLeader) tickAssistant(cid)`).
// 결과를 기다리지 않고(fire-and-forget) 회사별 진행 중 표시로 겹침을 막는다(tickHealthCheck와 같은 모양).
// 이 단계(1단계)는 일정만 본다. 글은 템플릿만(LLM 작성은 3단계). **기본 꺼짐** — assistant.json이 없거나 꺼져 있으면 네트워크 호출·쓰기 0.
//
// 한 틱(설계 4.2):
//  0. 설정 읽기(수정 시각 캐시) — 꺼짐이면 끝. company.json 봉인과 맞지 않는 켜짐도 꺼짐(config.mjs loadEffectiveAssistantConfig).
//  1. 리더 확인이 새것인가 — 동기화를 쓰는 기기면 리더 + 확인된 보유(ownedAt > 0) + 리스 확인 60초 안. 아니면 끝(호출 0).
//  2. 사용자당 1명 — 같은 주인의 다른 회사에서 더 나중에 켠 비서가 있으면 이 회사는 쉰다(상태 "다른 회사의 비서가 맡고 있음").
//  3. 조용한 시간(일정 예외 아니오)이면 확인도 배달도 하지 않는다 — 끝난 뒤 첫 확인이 밤사이를 읽어 아침 묶음에 넣는다.
//  4. 대기열(보낼 글 1건 이하)이 있으면 같은 client_msg_id·같은 본문으로 먼저 다시 보낸다. 비지 않으면 새 글을 만들지 않는다.
//     기한(시작 전 알림 = 회차 시작, 묶음 = rules.mjs bundleUntil)이 지난 글은 보내지 않고, 그 안의 지난 일정은 보류 목록으로 돌린다.
//  5. 차례 판정 — 일정 읽기(15분)·잠자기 뒤·저녁 묶음 범위. 차례가 아니면 네트워크 호출 0, 메모리 사본으로 시작 전 시각만 계산한다.
//     읽어야 할 차례에 읽지 못했으면(실패·실패 뒤 15분) 낡은 사본으로 지난 일정·묶음을 만들지 않고 확인 범위도 옮기지 않는다 — 다음 성공한 읽기가 그 사이를 다시 본다.
//  6. 감지 → 시작 전 알림(확인 읽기 뒤) / 지난 일정(보류 목록) / 아침·저녁 묶음.
//  7. 배달 → 묶음, 그다음 시작 전 알림을 하나씩(시작 전 알림은 늘 혼자 — 설계 7절). 성공한 뒤에만 보낸 키를 기록.
//     상태는 바뀐 때만 로컬 파일에(일정 확인 범위만 바뀐 경우는 15분에 한 번).
import { loadEffectiveAssistantConfig, calendarActive } from './config.mjs';
import { readState, pruneState, stateFile } from './state.mjs';
import { GAP_MS, LEASE_FRESH_MS, dateIn, addDays, instantIn, inQuiet, bundleDue, bundleUntil, assistantMuted, assistantCompanyOf, retryDelayMs } from './rules.mjs';
import { CAL_READ_MS, CAL_SPAN_MS, readCalendar, ownEvents, expand, planCalendar, confirmDue, preKey } from './calendar.mjs';
import { personalRoom, insertNotice, composePre, composeBundle, refreshPreBody } from './deliver.mjs';
import { leaseCheck, LEASE_TTL_MS, LEASE_ASSISTANT_ENGINE } from '../sync.mjs';
import { loadCompany } from '../workspace.mjs';
import { listCompanyIds } from '../hub.mjs';
import { readAgentCard } from '../persona.mjs';
import { writeJsonAtomic } from '../jsonstore.mjs';

/** 바꿔 끼우는 자리 — 기본값이 곧 실제 동작. 테스트만 가짜(시계·세션·리스·파일)를 넘긴다. */
export const assistantDeps = {
  config: loadEffectiveAssistantConfig, // 봉인이 맞는 설정만 켜짐(config.mjs — 옛 버전 기기의 에이전트가 assistant.json을 써도 켜지지 않는다)
  companyIds: listCompanyIds,
  company: loadCompany,
  agentExists: (cid, slug) => readAgentCard(cid, slug).then(() => true, (e) => e?.code !== 'NOT_FOUND'), // 읽기 실패(손상 등)는 있음으로 — 해고만 '없음'
  lease: leaseCheck,
  // 메신저 기기 세션(일정 도구와 같은 세션) — msgr.mjs는 chat.mjs를 끌어오므로 부를 때 동적으로 불러 순환을 피한다(office-calendar calendarDeps와 같은 방식)
  session: async () => (await import('../gateway/msgr.mjs')).sessionClient(),
  readState,
  writeState: (cid, st) => writeJsonAtomic(stateFile(cid), JSON.stringify(st)),
};

const mems = new Map(); // 회사별 메모리 — 지난 틱 리더 여부·시각, 상태, 일정 사본, 확인 읽기에서 사라진 키, 개인 1:1 방
function mem(cid) {
  let m = mems.get(cid);
  if (!m) mems.set(cid, (m = { wasLeader: false, lastTickAt: 0, state: null, sig: null, persistedCal: null, persistedAt: 0, snap: null, skip: new Set(), room: null, readFailedAt: 0 }));
  return m;
}
const lastLog = new Map();
function logOnce(cid, msg) { // 같은 실패가 매분 같은 줄을 쌓지 않게 — 바뀔 때만
  if (lastLog.get(cid) === msg) return;
  lastLog.set(cid, msg);
  console.error(`[argo] 비서(${cid}): ${msg}`);
}
const errText = (e) => String(e?.message ?? e).slice(0, 160);

function setStatus(st, code, now) {
  if (st.status?.code !== code) st.status = { code, at: now }; // 같은 상태가 이어지면 시각을 바꾸지 않는다(쓰기 0)
}

/** 바뀐 때만 쓴다. 일정 확인 범위(cal)만 바뀌었으면 15분에 한 번만 — 확인 범위는 매 틱 바뀌는 값이라 매분 쓰지 않는다(재시작 뒤엔 최대 15분 앞부터 다시 본다). */
async function save(cid, m, now, deps) {
  const st = m.state;
  const sig = JSON.stringify({ ...st, cal: null });
  const cal = JSON.stringify(st.cal);
  if (sig === m.sig && (cal === m.persistedCal || now - m.persistedAt < CAL_READ_MS)) return;
  await deps.writeState(cid, st);
  m.sig = sig; m.persistedCal = cal; m.persistedAt = now;
}

let idsCache = { at: -Infinity, ids: [] };
/** 같은 주인의 다른 회사 중 비서를 맡을 회사 — 다른 회사 설정은 수정 시각 캐시로 읽고, 켜진 회사만 company.json을 연다. */
async function pickCompany(cid, owner, cfg, now, deps) {
  if (now - idsCache.at > 30_000 || now < idsCache.at) idsCache = { at: now, ids: await deps.companyIds() };
  const peers = [{ cid, ownerId: owner, cfg }];
  for (const id of idsCache.ids) {
    if (id === cid) continue;
    const pc = await deps.config(id).catch(() => null);
    if (!pc?.enabled || !pc.agent) continue;
    const co = await deps.company(id).catch(() => null);
    if (co) peers.push({ cid: id, ownerId: co.ownerId ?? null, cfg: pc });
  }
  return assistantCompanyOf(peers, owner);
}

/** 대기열 글 하나 보내기 — 개인 공간 1:1 방(메모리 캐시) → 글 넣기. 성공(새 글·이미 있음)이면 키를 기록하고 대기열을 비운다. 실패면 대기열을 두고 재시도 시각을 미룬다. */
async function send(cid, m, c, cfg, now, lang) {
  const st = m.state; const ob = st.outbox;
  try {
    if (!m.room || m.room.slug !== cfg.agent) m.room = { slug: cfg.agent, ...(await personalRoom(c, cid, cfg.agent)) };
    ob.body = refreshPreBody(ob, { now, lang, tz: cfg.tz });
    await insertNotice(c, m.room, ob);
    for (const k of ob.keys) st.sent[k] = now;
    if (ob.kind === 'pre') st.day.instant += 1; // 즉시 알림 수(아침·저녁 묶음은 세지 않는다 — 설계 9절)
    if (ob.kind === 'am' || ob.kind === 'pm') st.bundles[ob.kind] = ob.date;
    st.outbox = null;
    setStatus(st, 'ok', now);
    return true;
  } catch (e) {
    m.room = null; // 방·행이 바뀌었을 수 있다 — 다음 시도에서 다시 찾는다
    const code = e?.code === 'personal_room_unavailable' ? 'personal_room_unavailable' : 'deliver_failed';
    ob.tries = (ob.tries ?? 0) + 1;
    ob.nextAt = now + retryDelayMs(ob.tries);
    setStatus(st, code, now);
    logOnce(cid, `알림을 보내지 못해 대기열에 두었습니다(${code}): ${errText(e)}`);
    return false;
  }
}

/**
 * 한 회사의 감시기 틱. 반환 = { ran, why } (테스트·로그용).
 * now = 시계(ms), deps = 바꿔 끼우는 자리(assistantDeps).
 */
export async function runAssistantTick(cid, { now = Date.now(), deps = assistantDeps } = {}) {
  // 0. 설정 — 꺼짐이면 상태 파일도 열지 않는다(호출·쓰기 0)
  const cfg = await deps.config(cid);
  if (!cfg?.enabled || !cfg.agent) { mems.delete(cid); return { ran: false, why: 'off' }; }
  const m = mem(cid);
  // 1. 리더 확인이 새것인가 — isCloudLeader()의 기본값(leader:true)은 획득한 리더십이 아니다
  const li = deps.lease();
  if (li.syncOn && !(li.leader && li.ownedAt > 0 && now - li.checkedAt <= LEASE_FRESH_MS)) { m.wasLeader = false; return { ran: false, why: 'lease' }; }
  const company = await deps.company(cid).catch(() => null);
  if (!company) return { ran: false, why: 'no_company' };
  const owner = company.ownerId ?? null;
  if (!m.state) {
    const { state, fresh } = await deps.readState(cid);
    m.state = state;
    if (!fresh) { m.sig = JSON.stringify({ ...state, cal: null }); m.persistedCal = JSON.stringify(state.cal); m.persistedAt = now; }
  }
  const st = m.state;
  const gap = !m.wasLeader || now - m.lastTickAt > GAP_MS; // 새로 리더가 됐거나·재시작했거나·잠자기·멈춤
  m.wasLeader = true; m.lastTickAt = now;
  const done = async (why, code = null) => { if (code) setStatus(st, code, now); await save(cid, m, now, deps); return { ran: true, why }; };

  // 확인 범위 기준선 — 이 기기에 기록이 없으면 지금부터(다른 기기가 이미 알린 일을 "지난 일정"으로 다시 알리지 않는다),
  // 있으면 저장값과 켠 시각 중 늦은 쪽(다시 켰을 때 꺼져 있던 동안의 일은 알리지 않는다). 뒤로는 26시간까지만 본다.
  st.cal.coveredUntil = Math.min(now, Math.max(st.cal.coveredUntil || now, cfg.enabledAt ?? 0, now - CAL_SPAN_MS));
  const today = dateIn(now, cfg.tz);
  if (st.day.date !== today) st.day = { date: today, instant: 0 };
  pruneState(st, now);

  // 2. 사용자당 1명 · 비서 에이전트 · 끈 목록 · 볼 것 — 쉬는 동안은 글 0. 쉬는 동안의 일정은 나중에 "지난 일정"으로 알리지 않고(확인 범위를 지금으로),
  //    쉬기 전 보류·대기열도 비운다 — 다시 맡는 순간 낡은 글이 가지 않게(다른 회사가 맡았으면 그쪽이 알린다). 이미 비어 있으면 쓰기 0(save 비교).
  const rest = (why, code) => { st.cal.coveredUntil = now; st.pending = []; st.outbox = null; return done(why, code); };
  if ((await pickCompany(cid, owner, cfg, now, deps)) !== cid) return rest('other_company', 'other_company');
  if (!(await deps.agentExists(cid, cfg.agent))) return rest('no_agent', 'no_agent');
  if (assistantMuted(company)) return rest('muted', 'muted'); // 메신저 알림 종류에서 비서를 껐다
  if (!calendarActive(cfg)) return rest('idle'); // 이 단계는 일정만 본다
  // 3. 조용한 시간 — 확인 범위를 옮기지 않는다(끝난 뒤 첫 확인이 그 사이를 읽는다)
  const quiet = inQuiet(now, cfg);
  if (quiet && !cfg.quiet.calendarAlerts) return done('quiet');

  let c = null;
  const session = async () => {
    if (c) return c;
    const s = await deps.session().catch(() => null);
    if (!s?.client || !s.uid || s.uid !== owner) return null; // 로그아웃·다른 계정 — 일정 도구와 같은 확인(세션 계정 = 회사 주인)
    return (c = s);
  };
  const lang = company.lang === 'en' ? 'en' : 'ko';

  // 4. 대기열 — 남은 글을 먼저. 비지 않으면 이번 틱에 새 글을 만들지 않는다(대기열은 늘 1건 이하).
  if (st.outbox && now >= Number(st.outbox.until)) {
    // 기한이 지난 글 — 시작 전 알림은 "N분 뒤 시작"이, 묶음은 "오늘·내일"이 거짓이 된다. 보내지 않고, 그 안의 지난 일정(시작 전 알림의 회차 포함)은
    // 보류 목록으로 돌려 다음 묶음에 넣는다(오늘 종일·내일 일정은 다음 묶음이 새 사본으로 다시 고른다).
    const have = new Set(st.pending.map((p) => p.key));
    st.pending.push(...(Array.isArray(st.outbox.items) ? st.outbox.items : []).filter((p) => p && typeof p.key === 'string' && !have.has(p.key)));
    st.outbox = null;
  }
  if (st.outbox) {
    if (quiet && st.outbox.kind !== 'pre') return done('quiet'); // 조용한 시간 예외는 시작 전 알림만 — 묶음 글은 밤에 보내지 않는다
    if (now < Number(st.outbox.nextAt || 0)) return done('outbox_wait');
    const s = await session();
    if (!s) return done('login', 'login_required');
    if (!(await send(cid, m, s, cfg, now, lang))) return done('outbox_failed');
  }

  // 5. 차례 — 읽을 때만 네트워크
  const slot = bundleDue(now, cfg, st.bundles);
  const pmTo = slot?.lane === 'pm' ? instantIn(addDays(slot.date, 2), '00:00', cfg.tz) : 0; // 저녁 묶음은 모레 00:00까지(내일 일정)
  const coveredUntil = st.cal.coveredUntil;
  const needRead = gap || !m.snap || now - m.snap.readAt >= CAL_READ_MS || m.snap.from > coveredUntil || (pmTo > 0 && m.snap.to < pmTo);
  let readNow = false;
  if (needRead) {
    const throttled = m.readFailedAt > 0 && now - m.readFailedAt < CAL_READ_MS; // 읽기 실패 뒤엔 다음 15분 차례까지 다시 부르지 않는다
    if (!throttled) {
      const s = await session();
      if (!s) return done('login', 'login_required');
      const from = coveredUntil; const to = Math.max(now + CAL_SPAN_MS, pmTo);
      try {
        const { events } = await readCalendar(s, from, to);
        m.snap = { readAt: now, from, to, occs: expand(ownEvents(events, s.uid), from, to) };
        m.skip = new Set(); m.readFailedAt = 0; readNow = true;
        st.cal.readAt = now;
        setStatus(st, 'ok', now);
      } catch (e) {
        m.readFailedAt = now;
        setStatus(st, 'calendar_error', now);
        logOnce(cid, `일정을 읽지 못했습니다(다음 차례에 다시): ${errText(e)}`);
      }
    }
    if (!m.snap) return done('no_snapshot');
  }

  // 6. 판정 — covered = 지난 일정을 가르고 확인 범위를 옮기고 묶음을 만들어도 되는 사본인가: 사본이 확인 범위 시작부터 덮고, 읽어야 할 차례에 읽지
  //    못한(stale — 실패·실패 뒤 15분) 사본이 아니어야 한다. 낡은 사본으로 하면 그 사이 새로 생긴 회차는 영영 안 보이고, 지운 회차는 "이미 시작한 일정"으로
  //    나간다(#863 분리 검수). 시작 전 알림은 확인 읽기를 거치므로 낡은 사본으로도 계산한다.
  const stale = needRead && !readNow;
  const covered = !stale && m.snap.from <= coveredUntil;
  const plan = planCalendar({ occs: m.snap.occs, now, coveredUntil, leadMs: cfg.leadMinutes * 60_000, sent: st.sent, skip: m.skip, slot, tz: cfg.tz });
  if (covered) {
    const have = new Set(st.pending.map((p) => p.key));
    for (const o of plan.missed) {
      const key = preKey(o);
      if (!have.has(key)) st.pending.push({ key, source: 'calendar', reason: inQuiet(o.start, cfg) ? 'quiet' : 'gap', eventId: o.id, start: o.start, title: o.title, location: o.location });
    }
    st.cal.coveredUntil = now;
  }
  let due = plan.due;
  if (due.length && !readNow) { // 확인 읽기 — 마지막 읽기(최대 15분 전) 뒤에 옮기거나 지운 일정에 옛 시각으로 알리지 않게
    const s = await session();
    if (!s) return done('login', 'login_required');
    try {
      const { kept, gone } = await confirmDue(s, due, s.uid);
      for (const o of gone) m.skip.add(preKey(o)); // 다음 전체 읽기까지 사본에서 뺀다
      due = kept;
    } catch (e) {
      due = []; // 확인 못 한 알림은 다음 틱으로 미룬다
      logOnce(cid, `알림 전 일정 확인 읽기 실패(다음 틱에 다시): ${errText(e)}`);
    }
  }

  // 7. 배달 — 묶음(차례이고 새 사본일 때), 그다음 시작 전 알림을 하나씩. 시작 전 알림은 묶음 차례에도 늘 혼자다(설계 7절 — 기준 = 키 하나).
  const deliverNew = async (ob, extra = {}) => {
    st.outbox = { ...ob, ...extra, at: now, tries: 0, nextAt: 0 };
    await save(cid, m, now, deps); // 대기열에 먼저 저장 — 글 넣기 도중 프로세스가 죽어도 다음 틱이 같은 글을 같은 id로 다시 보낸다
    const s = await session();
    if (!s) { setStatus(st, 'login_required', now); return false; }
    return send(cid, m, s, cfg, now, lang);
  };
  const bundleReady = covered && slot && (slot.lane !== 'pm' || m.snap.to >= pmTo); // 저녁 묶음은 내일 일정을 다 읽은 사본으로만
  if (bundleReady) {
    const pending = st.pending.slice();
    const ob = composeBundle(slot, { allDay: plan.allDay, tomorrow: plan.tomorrow, pending }, { lang, tz: cfg.tz });
    if (ob) {
      st.pending = st.pending.filter((p) => !pending.includes(p)); // 보류 항목은 이제 대기열 글 안에 있다(기한이 지나 버리면 되돌린다)
      if (!(await deliverNew(ob, { date: slot.date, until: bundleUntil(slot, cfg) }))) return done('ok'); // 막히면 시작 전 알림은 대기열이 빈 뒤에
    } else {
      st.bundles[slot.lane] = slot.date; // 넣을 것이 없다 — 그날 이 묶음은 처리한 것으로(뒤에 생긴 지난 일정은 다음 묶음으로)
    }
  }
  for (const o of due) {
    if (!(await deliverNew(composePre(o, { now, lang, tz: cfg.tz })))) break; // 막히면 나머지는 다음 틱에 다시 계산된다
  }
  return done('ok');
}

/** 스케줄러 틱이 부르는 자리 — 기다리지 않는다. 같은 회사가 아직 돌고 있으면 이번 틱은 건너뛴다(겹침 방지). 동기적으로 던지지 않는다. 반환 = 시작 여부. */
const inflight = new Set();
export function tickAssistant(cid, { run = runAssistantTick, set = inflight } = {}) {
  if (set.has(cid)) return false;
  set.add(cid);
  Promise.resolve()
    .then(() => run(cid))
    .catch((e) => logOnce(cid, `틱 오류: ${errText(e)}`))
    .finally(() => set.delete(cid));
  return true;
}

/** 리더가 아닌 기기의 "누가 비서를 돌리나" 판정(순수 — 설정 화면 상태 칸이 쓴다, 2단계).
    'this_device' | 'other_device' | 'runner_outdated'(실행 기기가 옛 버전이라 비서가 꺼져 있음 — 리스 글에 비서 엔진 번호가 없거나 낮다) | 'no_runner'(살아 있는 리스 없음). */
export function assistantRunnerStatus(li = leaseCheck(), now = Date.now()) {
  if (!li.syncOn || (li.leader && li.ownedAt > 0)) return 'this_device';
  const h = li.holder;
  if (!h || !(now - h.ts < LEASE_TTL_MS)) return 'no_runner';
  return (Number(h.assistant) || 0) >= LEASE_ASSISTANT_ENGINE ? 'other_device' : 'runner_outdated';
}

export function _resetAssistantForTest() { mems.clear(); lastLog.clear(); inflight.clear(); idsCache = { at: -Infinity, ids: [] }; }
