// 능동 비서 — 메일 확인 한 차례(엔진 틱이 회사마다 부른다). 설계 proactive-assistant-design 5.2·6·7·8·9 + muse-delta 4.3·4.8·4.9·9 + 10/9 유건님 "이런 식으로".
//
// 모드(assistant.json watch.mail — config.mjs mailMode): 'off' 안 봄(호출 0) · 'shadow' 미리 보기(감지·분류·기록만 — 글 0·AI 0, 설계 18절: 기존 메일 보고 루틴과 겹치지 않게
// 7일 대조한 뒤 '알림'으로 바꾸고 그때 루틴을 끈다 — 루틴 끄기는 운영 단계라 코드가 하지 않는다) · 'live' 알림.
//
// 한 차례:
//  1. 대기열(보낼 글 1건)이 있으면 같은 client_msg_id·같은 본문으로 먼저 다시 보낸다 — AI 준비를 다시 부르지 않는다.
//  2. 조용한 시간이면 확인하지 않는다(08:00 첫 확인이 커서로 밤사이를 읽는다). 확인 차례(평일 09–19시 10분, 그 밖 30분 — mailIntervalMs)가 아니면 호출 0.
//  3. 계정(하루 1번 읽기) → sync 1번(계정 전부, 봉인 접근 토큰을 들고 간다 — 오피스가 DB에 쓰지 않는다) → reset이면 메울 구간을 list로(한 차례 3번까지).
//  4. 새 메일 = 받은편지함·내가 보낸 것 아님·받은 시각 ≥ 기준선 − 10분·처음 보는 키. 기준선은 처리한 메일의 가장 늦은 받은 시각(벽시계 아님 — 설계 6절).
//  5. 분류(mail-classify) — 답장 신호가 있는 메일만 thread 1번. 즉시 몫: 답장 필요는 한 통씩(준비 원샷 + 자료 정리 첨부), 나머지는 번호 묶음 한 글.
//     저녁 몫은 정리 글 줄로 모은다(takeSummary). 즉시 알림이 하루 상한을 넘으면 한 시간에 한 번 목록 글로(설계 9절).
//  6. 상태(.assistant/mail.json, 기기 로컬·동기화 제외)는 바뀐 때만 쓴다 — 바뀐 메일이 없는 확인은 historyId도 그대로라 쓰기 0.
// 부하(계산값, 메모 4절): 확인 1번 = 오피스 서버 함수 1(계정마다 DB 읽기 1 + Gmail 1), 평일 70번·주말 30번. Supabase 쓰기는 알림 글뿐(하루 즉시 ≤10 + 한도 목록 글),
// 자료 정리 첨부는 Storage 업로드 1 + 첨부 행 1(하루 준비 ≤3). vault 파일 쓰기 0.
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../jsonstore.mjs';
import { paths } from '../workspace.mjs';
import { STATE_DIR } from './state.mjs';
import { dateIn, minuteIn, inQuiet } from './rules.mjs';
import { outsideOf } from '../gateway/office-audience.mjs';
import { clientMsgId, personalRoom, MSG_MAX } from './deliver.mjs';
import { classifyMail, needsThread, securityDayKey, scrubLine, domainOf, FIELD_CAP, ADDR_CAP } from './mail-classify.mjs';
import { mailAccounts, syncMail, listWindow, readThread } from './mail-source.mjs';
import { assistantUsageToday, prepPlan, runPrep } from './mail-prep.mjs';
import { composeReply, composeBatch, composeSummary, topicOf, mt } from './mail-text.mjs';

export const MAIL_STATE = 'mail.json';
export const mailStateFile = (wsId) => join(paths(wsId).root, STATE_DIR, MAIL_STATE);
export const OVERLAP_MS = 10 * 60_000;     // 기준선 겹침 — 받은 시각 순서와 검색 반영 순서가 어긋나는 몫(설계 5.2)
export const KEEP_MS = 14 * 86_400_000;    // 처리한 키·미리 보기 기록 보관
export const FILL_READS = 3;               // 한 차례 메울 구간 읽기 상한
export const THREAD_READS = 6;             // 한 차례 thread 읽기 상한(넘는 메일은 스레드 없이 분류 — 답장 필요로 보지 않는다)
export const ACCOUNTS_TTL_MS = 6 * 3_600_000;
export const EVENING_MAX = 200, SHADOW_MAX = 500, HELD_EVERY_MS = 3_600_000;

const MIN = 60_000;
const RUNNER_NAMES = { codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', claude: 'Claude' };
/** 확인 간격(순수, 설계 6.2 시작값 M26) — 조용한 시간 0(확인 안 함), 평일 09–19시 10분, 평일 그 밖·주말 30분. 요일·시각은 비서 시간대. */
export function mailIntervalMs(now, cfg) {
  if (inQuiet(now, cfg)) return 0;
  const dow = new Date(Date.parse(`${dateIn(now, cfg.tz)}T00:00:00Z`)).getUTCDay();
  const m = minuteIn(now, cfg.tz);
  return dow >= 1 && dow <= 5 && m >= 9 * 60 && m < 19 * 60 ? 10 * MIN : 30 * MIN;
}

export function emptyMailState() {
  return { v: 1, accounts: {}, nextAt: 0, seen: {}, evening: [], outbox: null, queue: [], held: [], heldAt: 0, prepDone: {}, shadow: [], status: null, checkedAt: 0 };
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** 읽은 값 → 엔진 모양(순수). 모르는 칸은 버린다. */
export function normalizeMailState(raw) {
  const s = emptyMailState();
  if (!raw || typeof raw !== 'object') return s;
  for (const [id, a] of Object.entries(raw.accounts ?? {})) {
    if (!a || typeof a !== 'object') continue;
    s.accounts[id] = { hist: /^\d{1,20}$/.test(String(a.hist ?? '')) ? String(a.hist) : '', base: num(a.base),
      fill: a.fill && Number.isFinite(Number(a.fill.from)) && Number.isFinite(Number(a.fill.to)) ? { from: num(a.fill.from), to: num(a.fill.to), page: typeof a.fill.page === 'string' ? a.fill.page : null } : null,
      access: a.access && typeof a.access.sealed === 'string' && typeof a.access.expires === 'string' ? { sealed: a.access.sealed, expires: a.access.expires } : null,
      retryAt: num(a.retryAt), err: typeof a.err === 'string' ? a.err : null };
  }
  s.nextAt = num(raw.nextAt); s.checkedAt = num(raw.checkedAt); s.heldAt = num(raw.heldAt);
  for (const [k, t] of Object.entries(raw.seen ?? {})) if (Number.isFinite(Number(t))) s.seen[k] = Number(t);
  for (const [k, d] of Object.entries(raw.prepDone ?? {})) if (typeof d === 'string') s.prepDone[k] = d;
  const items = (v, max) => (Array.isArray(v) ? v.filter((x) => x && typeof x.key === 'string').slice(-max) : []);
  s.evening = items(raw.evening, EVENING_MAX); s.queue = items(raw.queue, 50); s.held = items(raw.held, 100);
  s.shadow = Array.isArray(raw.shadow) ? raw.shadow.filter((x) => x && typeof x.cat === 'string').slice(-SHADOW_MAX) : [];
  const o = raw.outbox;
  if (o && typeof o === 'object' && typeof o.basis === 'string' && typeof o.body === 'string' && Array.isArray(o.keys)) s.outbox = o;
  s.status = raw.status && typeof raw.status.code === 'string' ? { code: raw.status.code, at: num(raw.status.at) } : null;
  return s;
}

/** 보관 기간 정리(순수) — 14일 지난 키·미리 보기 기록, 이틀 지난 저녁 몫. */
export function pruneMailState(s, now) {
  for (const [k, t] of Object.entries(s.seen)) if (now - t > KEEP_MS) delete s.seen[k];
  s.shadow = s.shadow.filter((x) => now - num(x.at) <= KEEP_MS).slice(-SHADOW_MAX);
  s.evening = s.evening.filter((x) => now - num(x.t) <= 2 * 86_400_000).slice(-EVENING_MAX);
  return s;
}

export const mailDeps = {
  readState: async (cid) => { try { return normalizeMailState(await readJson(mailStateFile(cid), null)); } catch { return emptyMailState(); } },
  writeState: (cid, s) => writeJsonAtomic(mailStateFile(cid), JSON.stringify(s)),
  accounts: mailAccounts,
  sync: (entries) => syncMail(entries),
  list: (account, from, to, page, access) => listWindow(account, from, to, page, access),
  thread: (account, threadId, access) => readThread(account, threadId, access),
  customers: async (c) => {
    const orgs = ((await c.db.myOrgIds(c.uid).catch(() => [])) ?? []).slice(0, 5);
    const out = [];
    for (const org of orgs) { const { data } = await c.client.rpc('office_perf_customers', { p_org: org }); if (Array.isArray(data)) out.push(...data); }
    return out;
  },
  usage: (wsIds, opts) => assistantUsageToday(wsIds, opts),
  prep: (args) => runPrep(args),
  room: (c, cid, slug) => personalRoom(c, cid, slug),
  nonce: undefined, // outsideOf 기본(호출마다 새 번호)
};

const mems = new Map(); // 회사별 — { s, sig, accounts: { at, list }, customers: { date, match }, room }
const keyOf = (m) => `mail:${m.account}:${m.gid}`;
const str = (v, n) => String(v ?? '').slice(0, n);
/** 오피스가 준 메일 메타(보낸 사람이 마음대로 만드는 칸)를 받는 자리에서 자른다 — 뒤의 정규식·글 만들기·상태 파일이 긴 값을 다루지 않게(10/9 보안 검토 ReDoS). */
export const intake = (x) => ({ id: str(x.id, 300), gid: str(x.gid, 200), account: str(x.account, 64), threadId: x.threadId == null ? null : str(x.threadId, 200),
  from: str(x.from, 200), addr: str(x.addr, ADDR_CAP), to: str(x.to, FIELD_CAP), subject: str(x.subject, FIELD_CAP), snippet: str(x.snippet, FIELD_CAP), at: str(x.at, 40),
  labels: Array.isArray(x.labels) ? x.labels.slice(0, 30).map((l) => str(l, 60)) : [],
  ...(x.auth && typeof x.auth === 'object' ? { auth: { dmarc: str(x.auth.dmarc, 20), from: str(x.auth.from, 253) } } : {}) });
const intakeThread = (t) => (Array.isArray(t) ? t.slice(-10).map((y) => ({ gid: str(y.gid, 200), from: str(y.from, 200), addr: str(y.addr, ADDR_CAP), at: str(y.at, 40), sent: y.sent === true, text: str(y.text, 1_500) })) : t);
const PUBLIC = new Set(['gmail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'yahoo.com', 'yahoo.co.kr', 'proton.me', 'protonmail.com']);
/** 거래처 주소 판정(순수) — 이메일이 같거나, 공용 메일이 아닌 같은 회사 도메인(오피스 성과 기록 customerMatcher와 같은 규칙). */
export function customerMatch(list) {
  const emails = new Set(), domains = new Set();
  for (const c of list ?? []) { const e = String(c?.email ?? '').trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) continue; emails.add(e); const d = domainOf(e); if (!PUBLIC.has(d)) domains.add(d); }
  return (addr) => { const a = String(addr ?? '').trim().toLowerCase(); return emails.has(a) || domains.has(domainOf(a)) ? a : null; };
}

// 들고 다니는 봉인 접근 토큰이 거절되면(Gmail 401 → 오피스 'expired') 버린다 — 만료 시각 전이라도 같은 토큰을 계속 보내지 않게, 다음 호출은 서버가 갱신한다(10/9 분리 검수 LOW 4)
const dropAccess = (a) => { if (a) a.access = null; };
function setStatus(s, code, now) { if (s.status?.code !== code) s.status = { code, at: now }; }
/** 바뀐 때만 쓴다 — 다음 확인 시각(nextAt)·마지막 확인 시각(checkedAt)만 바뀐 차례(바뀐 메일 없음)는 쓰지 않는다(유휴 확인 쓰기 0, 기기 로컬 파일이지만 같은 원칙).
    재시작하면 다음 확인 시각을 잃어 곧바로 한 번 확인한다 — 커서(historyId·기준선)는 남아 있어 메일을 다시 받지 않는다. */
const sigOf = (s) => JSON.stringify({ ...s, nextAt: 0, checkedAt: 0 });
async function save(cid, m, deps) {
  const sig = sigOf(m.s);
  if (sig === m.sig) return;
  await deps.writeState(cid, m.s);
  m.sig = sig;
}

/** 즉시 몫 한 글을 대기열에 넣고 보낸다 — 대기열 먼저 저장(넣기 도중 프로세스가 죽어도 다음 차례가 같은 글을 같은 id로). 성공하면 키를 기록. */
async function deliver(ctx, ob) {
  const { cid, m, deps, c, cfg, now, st } = ctx;
  m.s.outbox = { ...ob, tries: ob.tries ?? 0 };
  await save(cid, m, deps);
  return flushOutbox(ctx);
}
async function flushOutbox({ cid, m, deps, c, cfg, now, st }) {
  const ob = m.s.outbox;
  if (!ob) return true;
  try {
    if (!m.room || m.room.slug !== cfg.agent) m.room = { slug: cfg.agent, ...(await deps.room(c, cid, cfg.agent)) };
    const row = { channel_id: m.room.channelId, author_kind: 'crew', crew_id: m.room.crewId, kind: 'text', reply_to: null, thread_root: null,
      client_msg_id: clientMsgId(m.room.crewId, ob.basis), body: ob.body.slice(0, MSG_MAX), mentions: [], meta: { disposition: 'done', notification: 'assistant', assistant: ob.meta } };
    const ins = await c.db.insertMessage(row);
    if (ins?.id && ob.brief) { // 자료 정리 첨부 — 기기 메모리에서 바로 올린다(vault에 쓰지 않는다 — 동기화 업로드 0). 실패는 글을 막지 않는다(본문은 이미 나갔다)
      try {
        const buf = Buffer.from(ob.brief.text, 'utf8');
        const path = `p/${m.room.channelId}/${ins.id}/0-brief.md`;
        await c.db.upload(path, buf, 'text/markdown');
        await c.db.insertAttachment({ message_id: ins.id, org_id: null, name: ob.brief.name, mime: 'text/markdown', bytes: buf.length, storage_path: path });
      } catch (e) { console.error(`[argo] 비서(${cid}): 자료 정리 첨부를 올리지 못했습니다: ${String(e?.message ?? e).slice(0, 160)}`); }
    }
    for (const k of ob.keys) { m.s.seen[k] = now; if (st?.sent) st.sent[k] = now; }
    if (ob.instant && st?.day) { // 즉시 알림 수(일정 시작 전 알림과 같은 상한 — 설계 9절). 키로 세어 방에서 복구할 때 겹쳐 세지 않는다(recover.mjs — meta.assistant.dayKey)
      const keys = (st.day.keys ??= []);
      if (!keys.includes(ob.basis)) { if (keys.length < 500) keys.push(ob.basis); st.day.instant += 1; }
    }
    m.s.outbox = null;
    setStatus(m.s, 'ok', now);
    return true;
  } catch (e) {
    m.room = null;
    ob.tries = (ob.tries ?? 0) + 1;
    ob.nextAt = now + Math.min(5, 2 ** Math.max(0, ob.tries - 1)) * MIN;
    setStatus(m.s, e?.code === 'personal_room_unavailable' ? 'personal_room_unavailable' : 'deliver_failed', now);
    return false;
  }
}

const SOURCE_STATUS = { login_required: 'login_required', no_origin: 'mail_no_origin', office_outdated: 'office_outdated', rate_limited: 'mail_rate_limited', expired: 'mail_expired', no_account: 'mail_error', not_configured: 'mail_error', network: 'mail_error', server: 'mail_error', db: 'mail_error' };

/**
 * 메일 한 차례. 반환 { ran, why } (테스트·로그용).
 * args = { cid, cfg(엔진 설정 — mailMode), company, st(엔진 상태 — sent·day 공유, 없으면 이 파일 안에서만), c(기기 세션 | null), now, lang, ownerWs(같은 주인의 회사 id들) }
 */
export async function runMailStep({ cid, cfg, company, st = null, c, now = Date.now(), lang = 'ko', ownerWs = null, deps = mailDeps }) {
  const mode = cfg?.mailMode ?? 'off';
  if (mode === 'off') { mems.delete(cid); return { ran: false, why: 'off' }; }
  let m = mems.get(cid);
  if (!m) { const s = await deps.readState(cid); m = { s, sig: sigOf(s), accounts: null, customers: null, room: null }; mems.set(cid, m); }
  const s = pruneMailState(m.s, now);
  const done = async (why, code = null) => { if (code) setStatus(s, code, now); await save(cid, m, deps); return { ran: true, why }; };
  const owner = company?.ownerId ?? null;
  const live = mode === 'live';
  const sess = c && c.uid && c.uid === owner ? c : null;
  const ctx = { cid, m, deps, c: sess, cfg, now, st };

  // 1. 대기열 — 남은 글을 먼저(조용한 시간에는 보내지 않는다)
  if (s.outbox) {
    if (inQuiet(now, cfg)) return done('quiet');
    if (now < num(s.outbox.nextAt)) return done('outbox_wait');
    if (!sess) return done('login', 'login_required');
    if (!(await flushOutbox(ctx))) return done('outbox_failed');
  }
  // 2. 차례
  const every = mailIntervalMs(now, cfg);
  if (!every) return done('quiet');
  if (live && sess && s.queue.length) { // 지난 차례에 못 보낸 즉시 몫(한 차례에 글 여러 건이 막혔을 때)
    const q = s.queue.splice(0); await sendNow(ctx, q, { lang, ownerWs: ownerWs ?? [cid] });
    if (s.outbox) return done('outbox_failed');
  }
  if (live && sess && s.held.length && now - s.heldAt >= HELD_EVERY_MS) { // 하루 상한 뒤 모아 둔 것 — 한 시간에 한 글
    const held = s.held.splice(0);
    s.heldAt = now;
    if (!(await deliver(ctx, batchOb(held, { lang, now, tz: cfg.tz, held: true, instant: false })))) return done('outbox_failed');
  }
  if (now < s.nextAt) return done('wait');
  if (!sess) { s.nextAt = now + every; return done('login', 'login_required'); }
  s.nextAt = now + every;
  s.checkedAt = now;

  // 3. 계정 — 하루(6시간) 한 번, 오류 뒤 다시
  if (!m.accounts || now - m.accounts.at > ACCOUNTS_TTL_MS) {
    try { m.accounts = { at: now, list: await deps.accounts(sess) }; } catch (e) { return done('accounts', SOURCE_STATUS[e?.code] ?? 'mail_error'); }
  }
  const usable = m.accounts.list.filter((a) => a.status === 'ok' && !(num(s.accounts[a.id]?.retryAt) > now));
  for (const id of Object.keys(s.accounts)) if (!m.accounts.list.some((a) => a.id === id)) delete s.accounts[id]; // 연결을 끊은 계정
  if (!m.accounts.list.length) return done('no_account', 'no_mail_account');
  if (!usable.length) return done('accounts_wait', m.accounts.list.some((a) => a.status !== 'ok') ? 'mail_expired' : 'mail_rate_limited');
  const mine = m.accounts.list.map((a) => a.address);

  // sync — 계정 전부 한 번에
  let results;
  try {
    results = await deps.sync(usable.map((a) => { const x = s.accounts[a.id] ?? (s.accounts[a.id] = { hist: '', base: 0, fill: null, access: null, retryAt: 0, err: null }); return { account: a.id, since: x.hist || null, access: x.access }; }));
  } catch (e) {
    if (e?.code === 'rate_limited') s.nextAt = now + num(e.retryAfter) * 1000;
    if (e?.code === 'no_account') m.accounts = null;
    if (e?.code === 'expired') for (const a of usable) dropAccess(s.accounts[a.id]);
    return done('sync_failed', SOURCE_STATUS[e?.code] ?? 'mail_error');
  }
  const fresh = [];
  let anyErr = null;
  for (const r of results) {
    const a = s.accounts[r.account];
    if (!a) continue;
    if (r.access && typeof r.access.sealed === 'string') a.access = { sealed: r.access.sealed, expires: String(r.access.expires) };
    if (r.error) {
      a.err = r.error; anyErr = r.error;
      if (r.error === 'rate_limited') a.retryAt = now + Math.max(1, num(r.retryAfter) || 60) * 1000;
      if (r.error === 'expired' || r.error === 'no_account') m.accounts = null; // 다음 차례에 계정 상태를 다시 읽는다
      if (r.error === 'expired') dropAccess(a);
      continue;
    }
    a.err = null;
    const hist = /^\d{1,20}$/.test(String(r.historyId ?? '')) ? String(r.historyId) : a.hist;
    if (r.primed || !a.hist) { a.hist = hist; a.base = Math.max(a.base, cfg.enabledAt ?? 0, now); continue; } // 처음 — 지금부터(켠 시각 전 메일은 알리지 않는다)
    a.hist = hist;
    if (r.reset) a.fill = { from: Math.max(0, a.base - OVERLAP_MS), to: now, page: null };
    for (const x of (r.changed ?? []).slice(0, 100)) if (x && typeof x === 'object') fresh.push(intake(x));
  }
  // 메울 구간 — 한 차례 3번까지
  let reads = 0;
  for (const [id, a] of Object.entries(s.accounts)) {
    while (a.fill && reads < FILL_READS && usable.some((u) => u.id === id)) {
      reads += 1;
      try {
        const { items, next, access } = await deps.list(id, a.fill.from, a.fill.to, a.fill.page, a.access);
        if (access) a.access = access;
        fresh.push(...items.slice(0, 100).filter((x) => x && typeof x === 'object').map(intake));
        a.fill = next ? { ...a.fill, page: next } : null;
      } catch (e) { anyErr = e?.code ?? 'server'; if (e?.code === 'rate_limited') a.retryAt = now + num(e.retryAfter) * 1000; if (e?.code === 'expired') dropAccess(a); break; }
    }
  }

  // 4. 새 메일
  const seen = new Set();
  const news = [];
  for (const x of fresh) {
    const a = s.accounts[x.account];
    if (!a || !x.gid) continue;
    const k = keyOf(x);
    if (seen.has(k)) continue; seen.add(k);
    const t = Date.parse(x.at);
    const labels = x.labels ?? [];
    if (!labels.includes('INBOX') || labels.includes('SENT') || labels.includes('DRAFT') || !(t >= a.base - OVERLAP_MS)) continue;
    if (s.seen[k] || st?.sent?.[k]) continue;
    news.push(x);
  }
  for (const x of news) { const a = s.accounts[x.account]; a.base = Math.max(a.base, Date.parse(x.at)); }
  news.sort((p, q) => Date.parse(p.at) - Date.parse(q.at));

  // 5. 분류
  const today = dateIn(now, cfg.tz);
  if (!m.customers || m.customers.date !== today) {
    try { m.customers = { date: today, match: customerMatch(await deps.customers(sess)) }; } catch { m.customers = { date: today, match: () => null }; }
  }
  const nowItems = [];
  let threadReads = 0, outdated = false;
  for (const x of news) {
    const k = keyOf(x);
    const base = { accounts: mine, customer: m.customers.match, now, tz: cfg.tz };
    let thread;
    if (!outdated && threadReads < THREAD_READS && x.threadId && needsThread(x, base)) {
      threadReads += 1;
      try {
        const t = await deps.thread(x.account, x.threadId, s.accounts[x.account]?.access ?? null);
        if (t?.access) s.accounts[x.account].access = t.access;
        thread = intakeThread(Array.isArray(t) ? t : t?.messages);
      } catch (e) { if (e?.code === 'office_outdated') outdated = true; else anyErr = e?.code ?? 'server'; if (e?.code === 'expired') dropAccess(s.accounts[x.account]); }
    }
    const cls = classifyMail(x, { ...base, thread });
    if (cls.cat === 'security') { const dk = securityDayKey(x, now, cfg.tz); if (s.seen[dk]) cls.lane = 'drop'; else s.seen[dk] = now; } // 같은 주소 하루 1건
    s.seen[k] = now;
    if (!live) { // 미리 보기 — 기록만(글 0·AI 0). 메일 내용은 날짜·범주·보낸 도메인·제목 40자(숫자 지움)만, 기기 로컬
      s.shadow.push({ at: now, arrived: Date.parse(x.at), day: today, cat: cls.cat, lane: cls.lane, reply: cls.reply, domain: domainOf(x.addr), subject: scrubLine(x.subject, 40) });
      continue;
    }
    if (cls.lane === 'drop') continue;
    if (cls.lane === 'pm') { s.evening.push({ key: k, t: now, cat: cls.cat, from: String(x.from ?? '').slice(0, 60), addr: String(x.addr ?? '').slice(0, 120), subject: String(x.subject ?? '').slice(0, 120), at: x.at, ...(cls.due ? { due: cls.due } : {}) }); continue; }
    nowItems.push({ key: k, m: x, cls, thread });
  }
  if (outdated) setStatus(s, 'office_outdated', now);
  if (!live) return done('shadow', anyErr ? SOURCE_STATUS[anyErr] ?? 'mail_error' : outdated ? 'office_outdated' : 'shadow');
  if (nowItems.length) await sendNow(ctx, nowItems, { lang, ownerWs: ownerWs ?? [cid] });
  return done('ok', s.outbox ? null : anyErr ? SOURCE_STATUS[anyErr] ?? 'mail_error' : outdated ? 'office_outdated' : 'ok');
}

const mailRef = (x) => `${x.account}.${x.gid}`;
function batchOb(items, { lang, now, tz, held = false, instant = true }) {
  const keys = items.map((i) => i.key).sort();
  return {
    kind: 'mail_batch', basis: `mailbatch:${keys.join(',')}`, keys, instant,
    body: composeBatch(items, { lang, now, tz, held }),
    meta: { v: 1, kind: 'mail_batch', keys, count: items.length, outside: true, ...(instant ? { instant: true, dayKey: `mailbatch:${keys.join(',')}` } : {}), ref: items.map((i) => mailRef(i.m)).slice(0, 3),
      items: items.map((i) => ({ key: i.key, source: 'mail', cat: i.cls.cat, account: i.m.account, gid: i.m.gid, threadId: i.m.threadId ?? null, at: i.m.at })) },
  };
}

/** 즉시 몫 보내기 — 답장 필요는 한 통씩(준비), 나머지는 묶음 한 글. 하루 상한을 넘으면 held(한 시간에 한 글). 막히면 남은 것은 queue(다음 차례). */
async function sendNow(ctx, items, { lang, ownerWs }) {
  const { m, cfg, now, st, deps, cid } = ctx;
  const s = m.s;
  const cap = Number(cfg.dailyCap) || 10;
  const left = () => (st?.day ? cap - st.day.instant : Infinity);
  const today = dateIn(now, cfg.tz);
  const replies = items.filter((i) => i.cls.reply);
  const rest = items.filter((i) => !i.cls.reply);
  const todo = [...replies.map((i) => ({ reply: i })), ...(rest.length ? [{ batch: rest }] : [])];
  while (todo.length) {
    if (left() <= 0) { // 하루 상한 — 나머지는 모아서 한 시간에 한 글(준비 없이)
      for (const t of todo) for (const i of t.reply ? [t.reply] : t.batch) s.held.push(i);
      if (!s.heldAt) s.heldAt = now - HELD_EVERY_MS; // 첫 상한 — 다음 차례에 바로 한 글
      return;
    }
    const t = todo.shift();
    let ob;
    if (t.batch) ob = batchOb(t.batch, { lang, now, tz: cfg.tz });
    else {
      const i = t.reply; const x = i.m;
      const pk = `${x.account}:${x.threadId ?? x.gid}`;
      if (s.prepDone[pk] === today) { s.seen[i.key] = now; continue; } // 같은 스레드는 하루 한 번(P8)
      s.prepDone[pk] = today;
      for (const [k, d] of Object.entries(s.prepDone)) if (d !== today) delete s.prepDone[k];
      ob = await replyOb(ctx, i, { lang, ownerWs });
    }
    if (!(await deliver(ctx, ob))) { s.queue.push(...todo.flatMap((u) => (u.reply ? [u.reply] : u.batch))); return; }
  }
}

async function replyOb(ctx, i, { lang, ownerWs }) {
  const { cid, cfg, now, deps, m } = ctx;
  const x = i.m;
  const mails = (i.thread ?? []).length ? i.thread : [{ gid: x.gid, from: x.from, addr: x.addr, at: x.at, sent: false, text: x.snippet ?? '' }];
  const inChars = mails.reduce((n, y) => n + String(y.text ?? '').length, 0) + 3_000;
  const used = await deps.usage(ownerWs, { tz: cfg.tz, now }).catch(() => ({ eq: Infinity, preps: Infinity })); // 셈을 못 하면 쓰지 않는 쪽
  const plan = prepPlan({ used: used.eq, preps: used.preps, inChars });
  let prep = null, noPrep = plan.prep ? null : plan.why === 'daily' ? 'daily' : 'cap', runnerName = '';
  if (plan.prep) {
    const r = await deps.prep({ wsId: cid, agent: cfg.agent, lang, tz: cfg.tz, now, ownerAddrs: (m.accounts?.list ?? []).map((a) => a.address), target: x, mails, brief: plan.brief, ox: outsideOf('mail', lang, deps.nonce?.()) })
      .catch(() => ({ prep: null, why: 'failed' }));
    prep = r.prep;
    if (!prep) noPrep = r.why === 'free_model' ? 'free' : r.why === 'no_runner' ? 'runner' : r.why === 'cli_tools' ? 'cli' : r.why === 'codex_no_claude' ? 'codex' : 'failed';
    runnerName = r.runner ?? '';
  }
  const briefName = prep?.brief ? mt('brief.file', lang, { topic: topicOf(x.subject, lang) }) : null;
  const keys = [i.key];
  return {
    kind: 'mail_reply', basis: `mailreply:${i.key}`, keys, instant: true,
    body: composeReply(x, { unverified: !!i.cls?.unverified, prep, noPrep, briefName, briefSkipped: !!prep && !plan.brief, runnerName: RUNNER_NAMES[runnerName] ?? runnerName, lang, now, tz: cfg.tz }),
    ...(briefName ? { brief: { name: briefName, text: prep.brief } } : {}),
    meta: { v: 1, kind: 'mail_reply', keys, outside: true, instant: true, dayKey: `mailreply:${i.key}`, ref: [mailRef(x)], prep: prep ? (prep.brief ? 'brief' : 'draft') : noPrep,
      items: [{ key: i.key, source: 'mail', cat: 'reply', account: x.account, gid: x.gid, threadId: x.threadId ?? null, at: x.at }] },
  };
}

/** 저녁·아침 정리에 넣을 메일 줄 — { text, keys } | null. 넣었으면 저녁 몫을 비운다(consume). 정리 글은 엔진(tick)이 묶음과 같이 보낸다. */
export function takeSummary(cid, { lang = 'ko', consume = false } = {}) {
  const m = mems.get(cid);
  if (!m?.s?.evening?.length) return null;
  const text = composeSummary(m.s.evening, { lang });
  if (!text) return null;
  const keys = m.s.evening.map((x) => x.key);
  if (consume) m.s.evening = [];
  return { text, keys };
}
/** 정리 글에 넣은 저녁 몫을 비운 상태를 파일에 — 엔진(tick)이 정리 글을 대기열에 넣은 뒤 부른다. 바뀐 것이 없으면 쓰기 0. */
export async function persistMail(cid, deps = mailDeps) {
  const m = mems.get(cid);
  if (m) await save(cid, m, deps);
}

/** 설정 화면 상태 칸 — 이 기기의 메일 상태 파일에서(읽기만). { code, codeAt, checkedAt, shadow: { days, total, byCat } } | null */
export async function mailStatusView(cid, { now = Date.now(), read = (id) => readJson(mailStateFile(id), null) } = {}) {
  let raw; try { raw = await read(cid); } catch { return null; }
  if (!raw) return null;
  const s = normalizeMailState(raw);
  const byCat = {};
  for (const x of s.shadow) if (x.lane !== 'drop') byCat[x.cat] = (byCat[x.cat] ?? 0) + 1;
  const first = s.shadow.length ? Math.min(...s.shadow.map((x) => num(x.at))) : 0;
  return { code: s.status?.code ?? null, codeAt: s.status?.at ?? 0, checkedAt: s.checkedAt, shadow: { days: first ? Math.max(1, Math.ceil((now - first) / 86_400_000)) : 0, total: Object.values(byCat).reduce((a, b) => a + b, 0), byCat } };
}

export function _resetMailForTest() { mems.clear(); }
export const _mailMemForTest = (cid) => mems.get(cid);
