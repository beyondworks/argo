// 능동 비서 — 메일 분류(코드, LLM 0). 설계 proactive-assistant-design 5.2 + muse-delta 4.8 + 10/9 유건님 "이런 식으로"(기한 안내).
// 위에서부터 처음 맞는 것:
//   0 내가 보낸 메일(SENT·연결 계정 주소) → 뺀다
//   1.4 인증 번호 메일 → 뺀다(알림·정리 글·AI 입력 어디에도 — 번호가 DB·잠금 화면·벤더로 가지 않게)
//   1.5 보안 메일(제목 키워드 + 보낸 주소가 허용 목록 도메인) → 즉시(보낸 주소 표시, 링크 0, 같은 주소 하루 1건)
//   1.6 보안 메일처럼 보이지만 목록 밖 주소 → 저녁 한 줄(피싱을 비서 목소리로 전하지 않게)
//   답장 필요(4.5 — 신호 + 스레드 조건, 또는 거래처 + 강한 신호) → 즉시 + 준비(회신 초안·자료 정리). 4번(계약·입금)보다 먼저 본다 — 같은 메일이면 준비가 붙는 쪽.
//   2 거래처·고객 → 즉시
//   2.5 기한 안내(구독 해지·갱신·만료·체험 종료, 10/9) → 3일 안이면 즉시, 아니면 저녁
//   3 뉴스레터(프로모션·소셜·포럼 라벨, noreply 주소) → 저녁
//   4 계약·입금 키워드 → 즉시
//   5 그 밖 → 저녁 한 줄
// 스레드 조건이 필요한 메일(신호가 있는 메일)만 오피스 thread를 1번 읽는다(needsThread) — 나머지는 sync가 준 메타(보낸 사람·제목·앞부분·라벨)로 끝난다.
// 정규식은 비서 전용이다 — 성과 기록의 NEGATIVE(apps/office/server/mail-signals.js)는 "아직"·"빨리"처럼 거래처 스레드 안에서만 쓰려고 만든 넓은 규칙이라 쓰지 않는다.
import { dateIn, addDays } from './rules.mjs';

export const SECURITY_ALLOW = Object.freeze(['google.com', 'openai.com', 'apple.com', 'microsoft.com', 'github.com', 'naver.com', 'kakao.com', 'kakaocorp.com', 'amazon.com']);
export const DEADLINE_SOON_DAYS = 3;

const OTP_RE = /인증 ?번호|verification code|\bOTP\b|일회용 ?비밀번호|one[- ]time (?:pass(?:code|word)|code)/i;
const SECURITY_RE = /로그인|새 기기|새로운 기기|비밀번호 재설정|보안 알림|sign[- ]?in|signed in|new device|password reset|security alert/i;
const STRONG_RE = /follow(?:ing)?[ -]?up|checking in|just checking|gentle reminder|any updates?|still waiting|재촉|독촉|회신 부탁|답변 부탁|확인 부탁|언제쯤|언제 ?까지/i;
const ETA_RE = /\bETA\b/; // 대문자 그대로·단어 경계 — beta·metadata에 걸리지 않게
const WEAK_RE = /일정|날짜|기한|마감|전달일|납기|timeline|schedule|deadline|due date|delivery date|when (?:can|will) (?:you|we)/i;
const DEADLINE_RE = /구독|정기 ?결제|자동 ?갱신|갱신|해지|만료|체험(?:판)? ?(?:기간 ?)?종료|subscription|renew(?:al|s|ed)?|auto-?renew|trial (?:ends|ending|expires|period)|expir(?:es|ing|ation|ed)|cancel(?:l)?ation|cancel(?:l)?ed on|will be cancel(?:l)?ed|ends on/i;
const MONEY_RE = /계약|입금|송금|세금계산서|계산서|견적|발주|청구|결제|invoice|contract|payment|quote/i;
const NEWS_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'];
const NOREPLY_RE = /^(?:no-?reply|do-?not-?reply|donotreply|newsletters?|news|mailer|marketing|notifications?|info)(?:[+.-][^@]*)?@/i;

const lower = (s) => String(s ?? '').trim().toLowerCase();
// 메일 쪽 글은 보낸 사람이 마음대로 만든다 — 정규식에 넣기 전에 칸마다 자른다(10/9 보안 검토 ReDoS). 제목·앞부분은 보통 수십~200자.
export const FIELD_CAP = 500, ADDR_CAP = 320;
const ADDR_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;
/** 보낸 주소를 엄격하게(순수) — 소문자 'local@domain' 또는 null. @가 하나이고, 따옴표·공백·꺾쇠·제어 문자·ASCII 밖 글자(IDN 혼동)가 없을 때만.
    'x@google.com@evil.com'(메일 시스템은 마지막 @ 뒤를 도메인으로 본다)·'"security@google.com" <a@evil.com>'를 통째로 넘긴 값은 null이다(10/9 보안 검토 — 분류 우회). */
export function addrOf(addr) {
  const a = lower(String(addr ?? '').slice(0, ADDR_CAP));
  return ADDR_RE.test(a) && a.length <= 254 ? a : null;
}
export const domainOf = (addr) => addrOf(addr)?.split('@')[1] ?? '';
/** 주소의 도메인이 목록의 도메인과 같거나 그 하위 도메인인가(accounts.google.com → google.com). 비슷한 이름(google.com.evil.io·mygoogle.com)·엄격 파싱에 실패한 주소는 아니다 */
export const domainIn = (addr, list) => { const d = domainOf(addr); return !!d && list.some((x) => d === x || d.endsWith(`.${x}`)); };
const cap = (s) => String(s ?? '').slice(0, FIELD_CAP);
const textOf = (m) => `${cap(m.subject)}\n${cap(m.snippet)}`;

/** 답장 신호(순수) — 'strong' | 'weak' | null. 오피스는 제목 + 앞부분을 본다. */
export function replySignal(m) {
  const t = textOf(m);
  if (STRONG_RE.test(t) || ETA_RE.test(t)) return 'strong';
  if (WEAK_RE.test(t)) return 'weak';
  return null;
}

/** 스레드 조건(순수, 설계 4.8 4.5) — thread = 오피스 thread 동작의 메일 목록(오래된 순, { gid, addr, at, sent }).
    { waiting, mineBefore, nudge, repliedAfter }:
    ② 그 스레드에 이 메일보다 먼저 내가 보낸 메일이 있다(mineBefore)
    ②' 같은 보낸 사람이 내 답 없이 이 스레드에 두 번째 메일을 보냈다(nudge — 처음 받은 문의에 답 안 했는데 "Any update?")
    이 메일 뒤에 내가 보낸 메일이 이미 있으면(repliedAfter, P9) 답장 필요가 아니다. */
export function threadState(m, thread, mine = []) {
  const me = new Set(mine.map((x) => addrOf(x)).filter(Boolean));
  const t = Date.parse(m.at);
  const list = (thread ?? []).map((x) => ({ ...x, t: Date.parse(x.at), isMine: x.sent === true || me.has(addrOf(x.addr)) }));
  const repliedAfter = list.some((x) => x.isMine && x.t > t);
  const mineBefore = list.some((x) => x.isMine && x.t < t);
  const from = addrOf(m.addr) ?? `?${lower(m.addr)}`; // 엄격 파싱에 실패한 주소는 스레드 안 누구와도 같지 않게
  const lastMine = Math.max(-Infinity, ...list.filter((x) => x.isMine && x.t < t).map((x) => x.t));
  const nudge = list.filter((x) => !x.isMine && addrOf(x.addr) === from && x.t < t && x.t > lastMine).length >= 1;
  return { waiting: !repliedAfter && (mineBefore || nudge), mineBefore, nudge, repliedAfter };
}

/** thread를 읽어야 판정이 끝나는 메일인가(순수) — 앞 범주(내 메일·인증 번호·보안·뉴스레터 라벨)에서 끝나지 않고 답장 신호가 있는 메일만. */
export function needsThread(m, c = {}) {
  const pre = earlyCategory(m, c);
  if (pre) return false;
  if ((m.labels ?? []).some((l) => NEWS_LABELS.includes(l))) return false; // 프로모션 "Still waiting for your order!"(M23)
  return replySignal(m) != null;
}

/** 보낸 곳이 확인된 메일인가(순수) — From은 보낸 사람이 마음대로 쓸 수 있다. Gmail이 받을 때 붙인 인증 결과(오피스 envelope auth — 첫 Authentication-Results가
    mx.google.com의 것)가 dmarc=pass이고, DMARC가 본 머리 From 도메인이 보낸 주소의 도메인과 같을 때만 확인된 것으로 본다. 결과가 없으면(옛 오피스·다른 서버) 확인 못 함. */
export const verifiedSender = (m) => !!(m?.auth && m.auth.dmarc === 'pass' && m.auth.from && m.auth.from === domainOf(m.addr));

/** 스레드 없이 끝나는 앞 범주 — 'mine' | 'otp' | 'security' | 'security_other' | null.
    보안 메일을 비서 목소리로 즉시 알리는 것(security)은 주소가 엄격 파싱되고 · 허용 목록 도메인이고 · 보낸 곳이 확인된(verifiedSender) 때만. 그 밖은 저녁 한 줄(보낸 주소 그대로, 단정하지 않음). */
function earlyCategory(m, { accounts = [], allow = SECURITY_ALLOW } = {}) {
  const labels = m.labels ?? [];
  const mine = accounts.map((x) => addrOf(x)).filter(Boolean);
  if (labels.includes('SENT') || mine.includes(addrOf(m.addr))) return 'mine';
  if (OTP_RE.test(textOf(m))) return 'otp';
  const hasAddr = String(m.addr ?? '').includes('@'); // 이름뿐이면(인트라넷 등) 보안 범주를 쓰지 않는다(M30)
  if (hasAddr && SECURITY_RE.test(cap(m.subject))) return domainIn(m.addr, allow) && verifiedSender(m) ? 'security' : 'security_other'; // 허용 목록을 바꾸는 설정은 다음 단계 — 지금은 기본값
  return null;
}

/** 날짜 찾기(순수) — 글 속 날짜들을 회사 시간대 오늘 기준 [−365, +365]일 안의 'YYYY-MM-DD'로. 연도가 없으면 오늘에 가까운 쪽(작년·올해·내년)을 고른다.
    ISO(2026-10-09·2026.10.09·2026/10/09), 한국어(10월 9일), 영어(Oct 9·October 9, 2026·9 Oct), M/D(10/9 — 연도 없는 짧은 꼴). */
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export function findDates(text, today) {
  const s = String(text ?? '').slice(0, 2 * FIELD_CAP); // 제목 + 앞부분(또는 기한 문장)까지만
  const year = Number(today.slice(0, 4));
  const out = [];
  const push = (y, mo, d) => {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return;
    const cands = y ? [y] : [year - 1, year, year + 1];
    let best = null;
    for (const yy of cands) {
      const iso = `${yy}-${pad(mo)}-${pad(d)}`;
      const u = new Date(Date.UTC(yy, mo - 1, d));
      if (u.getUTCMonth() !== mo - 1) continue; // 2월 30일 같은 없는 날
      const diff = daysBetween(today, iso);
      if (Math.abs(diff) > 365) continue;
      if (!best || Math.abs(diff) < Math.abs(best.diff)) best = { iso, diff };
    }
    if (best) out.push(best.iso);
  };
  for (const m of s.matchAll(/\b(20\d{2})[-./](\d{1,2})[-./](\d{1,2})\b/g)) push(+m[1], +m[2], +m[3]);
  for (const m of s.matchAll(/(?:(20\d{2})년\s*)?(\d{1,2})월\s*(\d{1,2})일/g)) push(m[1] ? +m[1] : null, +m[2], +m[3]);
  for (const m of s.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi)) push(m[3] ? +m[3] : null, MON[m[1].toLowerCase()], +m[2]);
  for (const m of s.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?(?:,?\s+(20\d{2}))?\b/gi)) push(m[3] ? +m[3] : null, MON[m[2].toLowerCase()], +m[1]);
  for (const m of s.matchAll(/(?<![\d/.-])(\d{1,2})\/(\d{1,2})(?![\d/])/g)) push(null, +m[1], +m[2]);
  return [...new Set(out)];
}
/** 기한(순수) — 글 속 날짜 중 오늘 이후(오늘 포함) 가장 가까운 날과 남은 일수 { date, days } | null */
export function nearestDue(text, today) {
  const ds = findDates(text, today).map((iso) => ({ date: iso, days: daysBetween(today, iso) })).filter((x) => x.days >= 0).sort((a, b) => a.days - b.days);
  return ds[0] ?? null;
}
export { daysBetween };

/**
 * 메일 하나 분류(순수). m = sync가 준 메타 { id, gid, account, threadId, from, addr, subject, snippet, at, labels }.
 * ctx = { accounts: 연결된 내 주소들, customer: (addr) => 거래처 id | null, thread: thread 목록 | undefined(못 읽음·안 읽음), now, tz }.
 * 반환 { cat, lane: 'drop'|'now'|'pm', reply: bool, due?: { date, days }, signal }
 */
export function classifyMail(m, c = {}) {
  const early = earlyCategory(m, c);
  if (early === 'mine' || early === 'otp') return { cat: early, lane: 'drop', reply: false };
  if (early === 'security') return { cat: 'security', lane: 'now', reply: false };
  if (early === 'security_other') return { cat: 'security_other', lane: 'pm', reply: false };
  const labels = m.labels ?? [];
  const newsLabel = labels.some((l) => NEWS_LABELS.includes(l));
  const signal = newsLabel ? null : replySignal(m);
  const customer = typeof c.customer === 'function' ? c.customer(m.addr) : null;
  if (signal && Array.isArray(c.thread)) {
    const ts = threadState(m, c.thread, c.accounts ?? []);
    if (ts.waiting || (customer && signal === 'strong' && !ts.repliedAfter)) return { cat: 'reply', lane: 'now', reply: true, signal, thread: ts };
  }
  if (customer) return { cat: 'customer', lane: 'now', reply: false };
  const today = dateIn(c.now ?? Date.now(), c.tz ?? null);
  if (!newsLabel && DEADLINE_RE.test(textOf(m))) {
    const due = nearestDue(textOf(m), today);
    return { cat: 'deadline', lane: due && due.days <= DEADLINE_SOON_DAYS ? 'now' : 'pm', reply: false, ...(due ? { due } : {}) };
  }
  if (newsLabel || NOREPLY_RE.test(lower(m.addr))) return { cat: 'newsletter', lane: 'pm', reply: false };
  if (MONEY_RE.test(textOf(m))) return { cat: 'money', lane: 'now', reply: false };
  return { cat: 'other', lane: 'pm', reply: false };
}

/** 보안 메일 줄에 실을 글(순수) — 4자리 이상 숫자를 지우고 링크·주소를 뺀다(설계 4.8 1.5: 인증 번호가 정리 글·잠금 화면에 가지 않게, 링크는 싣지 않음).
    입력을 먼저 자르고, 링크·주소는 공백으로 나눈 낱말 단위로 뺀다(예전 정규식의 주소 패턴은 @·점이 많은 긴 줄에서 세제곱 시간이었다 — 10/9 보안 검토 ReDoS). */
export const scrubLine = (s, max = 80) => String(s ?? '').slice(0, 4 * max).split(/\s+/)
  .filter((w) => w && !/https?:\/\/|www\./i.test(w) && !w.includes('@')) // 낱말 안 어디든 링크가 될 수 있는 것은 뺀다(메신저 마크다운 자동 링크)
  .join(' ')
  .replace(/\d[\d -]{2,}\d/g, (x) => (x.replace(/\D/g, '').length >= 4 ? '…' : x))
  .trim().slice(0, max);

/** 같은 보낸 주소의 보안 메일은 하루 1건 — 키(순수) */
export const securityDayKey = (m, now, tz) => `mailsec:${lower(m.addr)}:${dateIn(now, tz)}`;
export { addDays };
