// 거래처 메일 만족도 신호(유건 9/29) — AI 없이 신호 4개(상대 회신, 내 첫 회신 시간, 감사·긍정, 불만·재촉)로 좋음/보통/주의.
// 입력은 Gmail 메타데이터(보낸 사람·시각·앞부분 요약)뿐이고, 결과에는 판정·근거 종류·메일 id만 남긴다(본문·제목 저장 안 함).
const PUBLIC = new Set(['gmail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'yahoo.com', 'yahoo.co.kr', 'proton.me', 'protonmail.com']);
const POSITIVE = /감사|고맙|고마워|잘 받았|만족|좋습니다|좋네요|훌륭|수고 ?많|덕분|thank|thanks|appreciate|great job|perfect/i;
const NEGATIVE = /아직|언제쯤|언제 ?까지|늦어|늦네|지연|답변이 없|회신이 없|연락이 없|재촉|독촉|불만|실망|문제가 있|빨리|급합|급하|urgent|asap|still waiting|disappoint|unacceptable/i;
const H = 3600e3;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/; // 공백·중괄호·OR 같은 것이 섞이면 Gmail 검색 범위가 넓어진다(분리 검수) — 형식이 아니면 버린다
const clean = (e) => { const x = String(e ?? '').trim().toLowerCase(); return EMAIL.test(x) ? x : null; };
const domainOf = (addr) => String(addr).toLowerCase().split('@')[1] ?? '';
const addrs = (header) => String(header ?? '').toLowerCase().match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+/g) ?? []; // '이름 <주소>, 주소2' → 주소들

/** 주소 → 거래처 id. 이메일이 같거나, 공용 메일이 아닌 같은 회사 도메인 */
export function customerMatcher(customers) {
  const byEmail = new Map(), byDomain = new Map();
  for (const c of customers) {
    const email = clean(c.email);
    if (!email) continue;
    byEmail.set(email, c.id);
    const d = domainOf(email);
    if (!PUBLIC.has(d) && !byDomain.has(d)) byDomain.set(d, c.id);
  }
  return (addr) => { const a = String(addr ?? '').toLowerCase(); return byEmail.get(a) ?? byDomain.get(domainOf(a)) ?? null; };
}

/** Gmail 검색어 — 거래처 주소(공용 메일)·도메인(회사 메일). 거래처 이메일이 없으면 null(부르지 않는다) */
export function gmailQuery(customers, days = 30, cap = 40) {
  const terms = [...new Set(customers.map((c) => clean(c.email)).filter(Boolean)
    .map((e) => (PUBLIC.has(domainOf(e)) ? e : `@${domainOf(e)}`)))].slice(0, cap);
  return terms.length ? `newer_than:${days}d {${terms.flatMap((x) => [`from:${x}`, `to:${x}`]).join(' ')}}` : null;
}

export const gradeOf = (reasons) => (reasons.some((r) => r === 'pushy' || r === 'late_reply') ? 'caution' : reasons.includes('thanks') || reasons.includes('quick_reply') ? 'good' : 'normal');

const kstDay = (ms) => new Date(ms + 9 * H).toISOString().slice(0, 10);

/** 스레드 하나 → { thread_id, customer_id, day, grade, reasons, reply_minutes, last_message_id } | null(거래처 없음) */
export function threadSignals(threadId, messages, me, match, now = Date.now()) {
  const mine = String(me).toLowerCase();
  const list = messages.map((m) => { const from = addrs(m.from)[0] ?? ''; return { ...m, t: Date.parse(m.at), mine: from === mine, customer: match(from) }; })
    .filter((m) => m.mine || m.customer).sort((a, b) => a.t - b.t);
  const theirs = list.filter((m) => m.customer);
  const customer = theirs[0]?.customer ?? messages.flatMap((m) => addrs(m.to)).map(match).find(Boolean) ?? null;
  if (!customer || !list.length) return null;
  const reasons = new Set(), waits = [];
  for (const m of theirs) {
    const reply = list.find((x) => x.mine && x.t > m.t);
    if (reply) { waits.push(reply.t - m.t); if (reply.t - m.t > 72 * H) reasons.add('late_reply'); }
    else if (now - m.t > 72 * H) reasons.add('late_reply');
  }
  const lastTheirs = theirs.at(-1);
  if (lastTheirs && POSITIVE.test(lastTheirs.snippet ?? '')) reasons.add('thanks');
  if (lastTheirs && NEGATIVE.test(lastTheirs.snippet ?? '')) reasons.add('pushy');
  const firstMine = list.find((m) => m.mine);
  if (firstMine && theirs.some((m) => m.t > firstMine.t)) reasons.add('replied');
  else if (firstMine && list[0].mine && now - firstMine.t > 5 * 24 * H) reasons.add('no_reply');
  const avg = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length / 60e3) : null;
  if (avg != null && avg <= 24 * 60 && !reasons.has('late_reply')) reasons.add('quick_reply');
  const r = [...reasons];
  const last = list.at(-1);
  return { thread_id: threadId, customer_id: customer, day: kstDay(last.t), grade: gradeOf(r), reasons: r, reply_minutes: avg, last_message_id: last.id };
}
