// 채팅 목록 시각(순수) — 오늘은 대화 글과 같은 시각, 어제는 "어제", 올해는 월·일, 그 밖은 연·월·일(카카오톡·라인 방식, 2026-09-29 모바일 점검).
// 종전 슬랙식 "요일 한 글자"(월·화)는 폰 목록에서 무슨 뜻인지 바로 안 읽혔다.
export function fmtDmWhen(ms, lang, now = Date.now()) {
  const d = new Date(ms), n = new Date(now), loc = lang === 'en' ? 'en-US' : 'ko-KR';
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  const y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return lang === 'en' ? 'Yesterday' : '어제';
  if (d.getFullYear() === n.getFullYear()) return d.toLocaleDateString(loc, { month: lang === 'en' ? 'short' : 'long', day: 'numeric' });
  return d.toLocaleDateString(loc, { year: 'numeric', month: 'numeric', day: 'numeric' });
}
