// 능동 비서 템플릿 글(ko/en) — 메신저 개인 공간 1:1 방에 그대로 올라가는 글이라 서버 모듈에 둔다(app/i18n.jsx는 'use client' 리액트 모듈이라
// 노드 엔진이 읽을 수 없다 — 메신저 알림 문구 src/msgr-notify.mjs formatMsgrNotify와 같은 자리). 사전 모양은 i18n.jsx와 같은 [ko, en]이고,
// 모든 키에 두 언어가 다 있는지는 test/assistant-engine.test.mjs가 잠근다. 호칭은 쓰지 않는다(설계 12절 — 템플릿에는 호칭 없음).
export const ASSISTANT_TEXT = Object.freeze({
  'head.pre': ['[비서] 곧 시작하는 일정', '[Assistant] Starting soon'],
  'head.am': ['[비서] 아침 정리 — {date}', '[Assistant] Morning summary — {date}'],
  'head.pm': ['[비서] 저녁 정리 — {date}', '[Assistant] Evening summary — {date}'],
  'sec.soon': ['곧 시작', 'Starting soon'],
  'sec.allDay': ['오늘 종일', 'All day today'],
  'sec.missedQuiet': ['이미 시작한 일정(조용한 시간 동안)', 'Already started (during quiet hours)'],
  'sec.missedGap': ['확인 못 한 사이 지난 일정', 'Started while I could not check'],
  'sec.tomorrow': ['내일 일정 {n}건 — {date}', 'Tomorrow — {date} ({n})'],
  'line.inMin': ['{n}분 뒤 시작', 'starts in {n} min'],
  'line.allDay': ['종일', 'All day'],
  'line.place': ['장소: {v}', 'at {v}'],
  'line.more': ['…외 {n}건', '…and {n} more'],
  'line.untitled': ['(제목 없음)', '(untitled)'],
  'dow': ['일,월,화,수,목,금,토', 'Sun,Mon,Tue,Wed,Thu,Fri,Sat'],
  'months': ['1월,2월,3월,4월,5월,6월,7월,8월,9월,10월,11월,12월', 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec'],
});

/** 문구 하나 — lang은 회사 언어(ko 기본). {이름} 자리는 vars로 채운다. */
export function at(key, lang = 'ko', vars = {}) {
  const pair = ASSISTANT_TEXT[key];
  const s = pair ? pair[lang === 'en' ? 1 : 0] : key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}

/** 'YYYY-MM-DD' → ko '10월 9일(목)' / en 'Thu, Oct 9'. 요일은 그 날짜 자체로 계산한다(시간대와 무관한 달력 날짜). */
export function dateLabel(date, lang = 'ko') {
  const [y, m, d] = String(date).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (lang === 'en') return `${at('dow', 'en').split(',')[dow]}, ${at('months', 'en').split(',')[m - 1]} ${d}`;
  return `${at('months', 'ko').split(',')[m - 1]} ${d}일(${at('dow', 'ko').split(',')[dow]})`;
}
