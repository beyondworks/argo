// 능동 비서 — 메일 알림 글(ko/en). 10/9 유건님 "이런 식으로": 무엇이 왔나 → 상대가 원하는 것·기한 → 준비한 것(초안 전문·자료) → 확인 질문 하나.
// 첫 줄은 코드가 만든 줄이다(잠금 화면 140자·방 문맥 표지 줄의 출처). 템플릿 줄은 해요체·호칭 없음(설계 12절), AI가 쓴 칸(상황·조언·초안·질문)은 그 에이전트 카드의 말투.
// 메일에서 나온 글(보낸 사람·제목·앞부분·AI가 메일을 보고 쓴 글)이 본문에 들어간 글은 meta.assistant.outside = true — 다음 대화 턴의 방 문맥에는 이 글 대신
// 표지 줄(outsideMark)만 들어간다(설계 4.9 규칙 2·3). 사전 모양은 text.mjs와 같은 [ko, en], 모든 키의 두 언어는 테스트가 잠근다.
import { dateLabel } from './text.mjs';
import { hhmmIn, dateIn } from './rules.mjs';
import { scrubLine } from './mail-classify.mjs';

export const MAIL_TEXT = Object.freeze({
  'head.reply': ['[하트비트] 답장이 필요한 메일 — {from} · {time} 도착', '[Heartbeat] Mail waiting for your reply — {from} · arrived {time}'],
  'head.batch': ['[하트비트] 확인할 것 {n}건', '[Heartbeat] {n} things to check'],
  'head.batch1': ['[하트비트] 확인할 것 하나', '[Heartbeat] One thing to check'],
  'line.ask': ['· 원하는 것: {v}', '· They want: {v}'],
  'line.due.past': ['· 기한: "{q}" — {n}일 지났어요', '· Due: "{q}" — {n} days ago'],
  'line.due.today': ['· 기한: "{q}" — 오늘이에요', '· Due: "{q}" — today'],
  'line.due.left': ['· 기한: "{q}" — {n}일 남았어요', '· Due: "{q}" — in {n} days'],
  'line.due.only': ['· 기한: "{q}"', '· Due: "{q}"'],
  'line.noreply': ['· 아직 답장은 안 하셨어요.', "· You haven't replied yet."],
  'line.subject': ['· 제목: {v}', '· Subject: {v}'],
  'line.preview': ['· 미리보기: {v}', '· Preview: {v}'],
  'prep.title': ['준비한 것', 'Prepared'],
  'prep.brief': ['· 자료 정리: 첨부 파일 "{name}"', '· Brief: attached file "{name}"'],
  'prep.briefSkip': ['· 자료 정리는 오늘 하트비트 AI 한도에 가까워 만들지 않았어요 — 필요하면 "자료 정리해 줘"라고 답해 주세요.', "· I skipped the brief because today's heartbeat AI limit is close — reply \"make a brief\" if you need one."],
  'prep.draft': ['· 회신 초안(메일함에는 넣지 않았어요)', '· Reply draft (not saved to your mailbox)'],
  'prep.newLink': ['※ 초안에 메일에 없던 링크·번호가 있어요 — 쓰기 전에 꼭 확인하세요.', '※ The draft has a link or number that was not in the mail — check it before using.'],
  'q': ['확인할 것 하나: {q}', 'One thing to confirm: {q}'],
  'q.answers': ['(예: {a})', '(e.g. {a})'],
  'noprep.cap': ['오늘 하트비트 AI 한도에 닿아 초안은 만들지 않았어요 — 필요하면 "초안 만들어 줘"라고 답해 주세요.', "Today's heartbeat AI limit is reached, so I didn't draft a reply — reply \"draft it\" if you need one."],
  'noprep.daily': ['오늘은 초안을 이미 세 번 만들어 이번에는 만들지 않았어요 — 필요하면 "초안 만들어 줘"라고 답해 주세요.', 'I already drafted three replies today, so not this one — reply "draft it" if you need one.'],
  'noprep.failed': ['초안을 만들지 못했어요(AI가 제때 답하지 않았어요) — 필요하면 "초안 만들어 줘"라고 답해 주세요.', 'I couldn\'t draft a reply (the AI did not answer in time) — reply "draft it" if you need one.'],
  'noprep.free': ['무료 AI 모델이라 메일 내용을 AI에게 보내지 않았어요 — 초안이 필요하면 "초안 만들어 줘"라고 답해 주세요.', 'This agent uses a free AI model, so mail text was not sent to the AI — reply "draft it" if you need a draft.'],
  'noprep.cli': ['이 에이전트의 AI({runner})는 파일·명령 도구를 끈 채 부를 수 없어 메일 글을 보내지 않았어요 — 초안이 필요하면 "초안 만들어 줘"라고 답해 주세요.', "This agent's AI ({runner}) can't be called with file and command tools turned off, so mail text was not sent to it — reply \"draft it\" if you need a draft."],
  'noprep.codex': ['이 에이전트의 AI({runner})에는 메일 글을 보내지 않아요 — Claude 로그인이나 API 키를 연결하면 초안까지 준비해요. 지금 초안이 필요하면 "초안 만들어 줘"라고 답해 주세요.', "Mail text isn't sent to this agent's AI ({runner}) — connect a Claude sign-in or API key and drafts will be prepared too. Reply \"draft it\" if you need one now."],
  'noprep.unverified': ['보낸 곳을 확인하지 못해 초안은 만들지 않았어요 — 보낸 사람이 맞으면 "초안 만들어 줘"라고 답해 주세요.', "The sender couldn't be verified, so no draft was made — reply \"draft it\" if the sender is right."],
  // 보낸 곳이 확인되지 않은 답장 필요 메일(내가 먼저 보낸 스레드 ②) — From은 위조할 수 있다(10/9 분리 검수 LOW 3)
  'line.unverified': ['· 보낸 곳을 확인하지 못했어요 — 보낸 주소 {addr}가 맞는지 먼저 보세요.', '· The sender could not be verified — check that {addr} is right first.'],
  'noprep.runner': ['이 에이전트의 AI 연결이 없어 초안을 만들지 못했어요 — 설정 › AI 연결을 확인해 주세요.', "This agent has no working AI connection, so I couldn't draft — check Settings › AI connections."],
  'noprep.held': ['오늘 즉시 알림이 많아 초안 없이 목록으로만 보내요.', 'Many instant alerts today, so this comes as a plain list.'],
  // 보낸 주소만 — 표시 이름은 보낸 쪽이 마음대로 쓴다(10/9 분리 검수 MEDIUM 1)
  'item.security': ['{i}. 보안 알림 — {addr} · {time}\n   "{subject}"\n   본인이 한 일이 맞나요? 아니라면 비밀번호부터 바꾸세요. 메일의 링크 말고 그 서비스에 직접 들어가 확인하세요.',
    '{i}. Security alert — {addr} · {time}\n   "{subject}"\n   Was this you? If not, change your password first. Go to the service directly instead of using links in the mail.'],
  'item.due.today': ['{i}. 오늘이 기한이에요 — {sender} · "{subject}"\n   그대로 둘까요, 아니면 오늘 안에 처리할까요?', '{i}. Due today — {sender} · "{subject}"\n   Leave it, or handle it today?'],
  'item.due.days': ['{i}. 기한이 {n}일 남았어요({date}) — {sender} · "{subject}"\n   그대로 둘까요, 아니면 그 전에 처리할까요?', '{i}. Due in {n} days ({date}) — {sender} · "{subject}"\n   Leave it, or handle it before then?'],
  'item.customer': ['{i}. 거래처 메일 — {sender} · "{subject}" · {time}', '{i}. From a customer — {sender} · "{subject}" · {time}'],
  'item.money': ['{i}. 계약·입금 메일 — {sender} · "{subject}" · {time}', '{i}. Contract / payment — {sender} · "{subject}" · {time}'],
  'item.reply': ['{i}. 답장이 필요한 메일 — {sender} · "{subject}" · {time}', '{i}. Waiting for your reply — {sender} · "{subject}" · {time}'],
  'sum.title': ['메일', 'Mail'],
  'sum.other': ['· 그 밖의 새 메일 {n}건({who})', '· {n} other new mails ({who})'],
  'sum.news': ['· 뉴스레터 {n}건({who})', '· {n} newsletters ({who})'],
  'sum.phish': ['· 보안 알림처럼 보이는 메일 — 보낸 주소 {addr}. 보낸 곳을 확인하지 못했어요 — 메일의 링크는 누르지 마세요.', "· Looks like a security alert — sent from {addr}. The sender could not be verified — don't use links in it."],
  'sum.due': ['· 기한 안내 — {sender} · "{subject}"{date}', '· Deadline notice — {sender} · "{subject}"{date}'],
  'sum.held': ['· 즉시 알림 한도로 모아 둔 메일 — {sender} · "{subject}"', '· Held by the daily alert limit — {sender} · "{subject}"'],
  'sum.more': ['  …외 {n}건', '  …and {n} more'],
  'mark': ['[하트비트 알림 · {what} · 메일에서 나온 글이라 문맥에서 뺐어요{ids}]', '[Heartbeat notice · {what} · left out of context because it came from mail{ids}]'],
  'mark.ids': [' · 메일 id {v} — 주인이 원하면 office_mail mail_read로 읽는다', ' · mail id {v} — read with office_mail mail_read if the owner asks'],
  'what.reply': ['답장이 필요한 메일', 'mail waiting for a reply'],
  'what.batch': ['확인할 메일 {n}건', '{n} mails to check'],
  'what.sum': ['메일 정리', 'mail summary'],
  'brief.file': ['{topic} 자료 정리.md', '{topic} brief.md'],
  'untitled': ['(제목 없음)', '(no subject)'],
});
export function mt(key, lang = 'ko', vars = {}) {
  const pair = MAIL_TEXT[key];
  const s = pair ? pair[lang === 'en' ? 1 : 0] : key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}

const one = (s, n) => String(s ?? '').slice(0, 4 * n).replace(/\s+/g, ' ').trim().slice(0, n);
// 보이지 않는 글자·방향 바꾸는 글자·제어 문자(U+200B~U+200F 제로폭·LRM/RLM, U+202A~U+202E·U+2066~U+2069 방향, U+00AD, U+FEFF, U+2060, C0·C1 제어)
const HIDDEN_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// 링크가 될 수 있는 낱말 — 메신저는 에이전트 글을 마크다운(marked, GFM 자동 링크)으로 그려 낱말 안 어디에 있든 http(s)://·www.를 누를 수 있는 링크로 만든다
const LINKY_RE = /https?:\/\/|www\.|\]\(/i;
/** 메일 쪽이 쓴 글을 알림 본문에 싣기 전에(순수, 10/9 보안 검토) — 숨은 글자를 지우고, 링크가 될 낱말은 '(링크)'로(비서 목소리로 남의 링크를 건네지 않게),
    낱말 앞 @는 전각 ＠로(멘션처럼 보이거나 읽히지 않게), 줄 앞 /는 전각 ／로(명령처럼 보이지 않게). 한 줄로, n자까지. */
// 메일 주소 모양 낱말 — GFM은 주소도 mailto 링크로 만든다(피싱 보낸 주소가 눌리는 링크로 보이지 않게 `코드`로 감싼다, 10/9 실측 캡처)
const EMAILY_RE = /[^\s@]@[^\s@]+\.[^\s@]/;
export function display(s, n) {
  const words = String(s ?? '').slice(0, 4 * n).replace(HIDDEN_RE, '').replace(/`/g, 'ˋ').split(/\s+/).filter(Boolean)
    .map((w) => (LINKY_RE.test(w) ? '(링크)' : EMAILY_RE.test(w) ? `\`${w}\`` : w.replace(/^@/, '＠').replace(/^\//, '／')));
  const out = words.join(' ');
  if (out.length <= n) return out;
  // 자를 때 감싼 낱말 가운데서 자르면 백틱 짝이 깨진다 — 감싼 낱말은 통째로 빼고, 그 밖은 글자 단위로 자른다(예전과 같다)
  let acc = '';
  for (const w of words) {
    const next = acc ? `${acc} ${w}` : w;
    if (next.length <= n) { acc = next; continue; }
    return w.startsWith('`') ? acc : next.slice(0, n);
  }
  return acc;
}
/** 초안처럼 줄을 살려야 하는 글 — 숨은 글자를 지우고, 링크가 될 낱말은 `인라인 코드`로 감싸 누를 수 없게(글자는 그대로 — 쓰기 전에 사람이 본다.
    메일에 없던 링크는 parsePrep이 "새 링크·번호" 표시도 단다). 백틱은 'ˋ'로 바꿔 감싼 코드가 깨지지 않게. */
export const plainLines = (s, n) => String(s ?? '').slice(0, n).replace(/\r\n/g, '\n').replace(HIDDEN_RE, '').replace(/`/g, 'ˋ')
  .split('\n').map((line) => line.split(/( +)/).map((w) => (LINKY_RE.test(w) ? `\`${w}\`` : w)).join('')).join('\n');
/** 보낸 사람 표시 — 이름(30자), 이름이 없거나 주소면 주소. */
export const senderOf = (m) => display(m.from && m.from !== m.addr ? m.from : m.addr, 30) || '?';
const subjectOf = (m, lang) => display(m.subject, 80) || mt('untitled', lang);
/** 받은 시각 — 오늘이면 HH:MM, 아니면 M/D HH:MM(회사 시간대). */
export function arrivedAt(ms, { now, tz }) {
  const t = hhmmIn(ms, tz);
  return dateIn(ms, tz) === dateIn(now, tz) ? t : `${dateIn(ms, tz).slice(5).replace('-', '/')} ${t}`;
}

/** 자료 정리 파일 이름의 주제(순수) — 제목에서 Re:·Fwd:·회신: 머리를 떼고 URL·메일 주소·6자리 이상 숫자를 지우고 40자, 파일 이름에 못 쓰는 글자는 뺀다(설계 4.4-c 주제 줄). */
export function topicOf(subject, lang = 'ko') {
  let s = String(subject ?? '').slice(0, 300).replace(HIDDEN_RE, ''); // 입력을 먼저 자르고 낱말 단위로(예전 주소 패턴은 긴 줄에서 제곱 이상 — 10/9 보안 검토 ReDoS)
  for (let i = 0; i < 4; i++) s = s.replace(/^\s*(?:re|fw|fwd|aw|sv|답장|회신|전달)\s*[:：]\s*/i, '');
  s = s.split(/\s+/).filter((w) => w && !LINKY_RE.test(w) && !w.includes('@')).join(' ')
    .replace(/\d{6,}/g, '').replace(/[\\/:*?"<>|]/g, ' ');
  return one(s, 40) || (lang === 'en' ? 'Mail' : '메일');
}

const dueLine = (d, lang) => {
  if (!d?.quote) return null;
  const q = display(d.quote, 160);
  if (typeof d.days !== 'number') return mt('line.due.only', lang, { q });
  if (d.days < 0) return mt('line.due.past', lang, { q, n: -d.days });
  if (d.days === 0) return mt('line.due.today', lang, { q });
  return mt('line.due.left', lang, { q, n: d.days });
};

/** 답장이 필요한 메일 한 통의 글(순수) — prep(검증된 준비) 또는 noPrep(준비하지 않은 이유 코드). briefName = 첨부한 자료 정리 파일 이름(없으면 null). */
export function composeReply(m, { unverified = false, prep = null, noPrep = null, briefName = null, briefSkipped = false, runnerName = '', lang = 'ko', now, tz }) {
  const head = mt('head.reply', lang, { from: senderOf(m), time: arrivedAt(Date.parse(m.at), { now, tz }) });
  const out = [head];
  if (unverified) out.push(mt('line.unverified', lang, { addr: display(m.addr, 80) }));
  if (prep) {
    out.push(...prep.situation.map((x) => display(x, 200)));
    if (prep.ask) out.push(mt('line.ask', lang, { v: display(prep.ask, 200) }));
    const due = dueLine(prep.deadline, lang);
    if (due) out.push(due);
    out.push(`${mt('line.noreply', lang)}${prep.advice ? ` ${display(prep.advice, 160)}` : ''}`);
    out.push('', mt('prep.title', lang));
    if (briefName) out.push(mt('prep.brief', lang, { name: briefName }));
    else if (briefSkipped) out.push(mt('prep.briefSkip', lang));
    out.push(mt('prep.draft', lang), '──────────', plainLines(prep.draft, 3_000), '──────────');
    if (prep.newLink) out.push(mt('prep.newLink', lang));
    if (prep.question) out.push('', `${mt('q', lang, { q: display(prep.question.q, 200) })}${prep.question.answers.length ? ` ${mt('q.answers', lang, { a: prep.question.answers.map((a) => display(a, 60)).join(' / ') })}` : ''}`);
  } else {
    out.push(mt('line.subject', lang, { v: `"${subjectOf(m, lang)}"` }));
    if (m.snippet) out.push(mt('line.preview', lang, { v: `"${display(m.snippet, 140)}"` }));
    out.push(mt('line.noreply', lang));
    if (noPrep) out.push('', mt(`noprep.${noPrep}`, lang, { runner: display(runnerName, 30) }));
  }
  return out.join('\n');
}

/** 짧은 알림 묶음(순수) — 10/9 화면 (b) "두 가지만 확인할게: 1. … 2. …". items = [{ m, cls }](보안·기한·거래처·계약/입금, 한도에 걸린 답장 필요). */
export function composeBatch(items, { lang = 'ko', now, tz, held = false }) {
  const lines = [items.length === 1 ? mt('head.batch1', lang) : mt('head.batch', lang, { n: items.length })];
  items.forEach(({ m, cls }, k) => {
    const v = { i: k + 1, sender: senderOf(m), addr: display(m.addr, 80), subject: cls.cat === 'security' ? scrubLine(m.subject, 80) || mt('untitled', lang) : subjectOf(m, lang), time: arrivedAt(Date.parse(m.at), { now, tz }) };
    if (cls.cat === 'security') lines.push(mt('item.security', lang, v));
    else if (cls.cat === 'deadline') lines.push(cls.due?.days === 0 ? mt('item.due.today', lang, v) : mt('item.due.days', lang, { ...v, n: cls.due?.days ?? '?', date: cls.due ? dateLabel(cls.due.date, lang) : '' }));
    else if (cls.cat === 'customer') lines.push(mt('item.customer', lang, v), ...(cls.unverified ? [`   ${mt('line.unverified', lang, { addr: display(m.addr, 80) }).replace(/^· /, '')}`] : []));
    else if (cls.cat === 'reply') lines.push(mt('item.reply', lang, v));
    else lines.push(mt('item.money', lang, v));
  });
  if (held) lines.push('', mt('noprep.held', lang));
  return lines.join('\n');
}

const MAX_LINES = 8;
/** 저녁·아침 정리에 넣는 메일 줄(순수) — items = 저녁 몫 [{ cat, from, addr, subject, at, due }]. 넣을 것이 없으면 null.
    뉴스레터·그 밖은 개수와 보낸 사람 상위 3, 보안처럼 보이는 메일은 주소와 "링크는 누르지 마세요", 기한 안내(3일 밖)·한도로 모아 둔 메일은 한 줄씩. */
export function composeSummary(items, { lang = 'ko' } = {}) {
  if (!items?.length) return null;
  const top = (list) => {
    const n = new Map();
    for (const x of list) { const k = senderOf(x); n.set(k, (n.get(k) ?? 0) + 1); }
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k).join(', ');
  };
  const by = (c) => items.filter((x) => x.cat === c);
  const lines = [mt('sum.title', lang)];
  const listed = (rows, fmt) => { rows.slice(0, MAX_LINES).forEach((x) => lines.push(fmt(x))); if (rows.length > MAX_LINES) lines.push(mt('sum.more', lang, { n: rows.length - MAX_LINES })); };
  listed(by('held'), (x) => mt('sum.held', lang, { sender: senderOf(x), subject: subjectOf(x, lang) }));
  listed(by('deadline'), (x) => mt('sum.due', lang, { sender: senderOf(x), subject: subjectOf(x, lang), date: x.due?.date ? ` · ${dateLabel(x.due.date, lang)}` : '' }));
  listed(by('security_other'), (x) => mt('sum.phish', lang, { addr: display(x.addr, 80) }));
  const news = by('newsletter'); if (news.length) lines.push(mt('sum.news', lang, { n: news.length, who: top(news) }));
  const other = by('other'); if (other.length) lines.push(mt('sum.other', lang, { n: other.length, who: top(other) }));
  return lines.length > 1 ? lines.join('\n') : null;
}

const MAIL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{1,200}$/i;
/** 바깥 글 표지가 있는 비서 글 → 방 문맥에 넣는 표지 줄(순수, 설계 4.9 규칙 3). a = meta.assistant. 메일 id는 형식이 맞는 것만(코드가 만든 값), 3개까지. */
export function outsideMark(a, lang = 'ko') {
  const ids = (Array.isArray(a?.ref) ? a.ref : []).filter((x) => typeof x === 'string' && MAIL_ID_RE.test(x)).slice(0, 3);
  const what = a?.kind === 'mail_reply' ? mt('what.reply', lang) : a?.kind === 'mail_batch' ? mt('what.batch', lang, { n: Math.max(1, Number(a?.count) || ids.length || 1) }) : mt('what.sum', lang);
  return mt('mark', lang, { what, ids: ids.length ? mt('mark.ids', lang, { v: ids.join(', ') }) : '' });
}

/** 방 문맥·답장 대상 줄에서 이 글을 표지 줄로 바꿀까(순수) — 비서 에이전트 글이고 meta.assistant.outside이면 표지 줄, 아니면 null(본문 그대로).
    r = 방 글 행(봉투 문맥은 meta 전체, contextOf는 assistant:meta->assistant 별칭). 사람 글의 meta는 보지 않는다(사람이 표지를 흉내 내 문맥을 지우지 못하게). */
export function outsideContextLine(r, lang = 'ko') {
  if (r?.author_kind !== 'crew') return null;
  const a = r.meta?.assistant ?? r.assistant;
  return a && typeof a === 'object' && a.outside === true ? outsideMark(a, lang) : null;
}
