// 아르고 기능 도움말 — 에이전트의 argo_help 도구가 검색해 돌려주는 사용자용 설명(앱과 같이 배포된다).
// 주제마다 파일 하나(src/help/topics/*.mjs)이고 ko·en 두 언어를 함께 둔다. 화면 이름은 app/i18n.jsx의 문구를 그대로 쓴다.
// 내부 전용 내용(보안 의심·사고 이력·열린 결함·내부 문서 경로·사람 이름·이메일)은 넣지 않는다 — test/argo-help.test.mjs가 검사한다.
// 마크다운 파일 대신 모듈로 둔 이유: Next 산출물은 임포트한 모듈만 싣고(런타임 파일 읽기는 추적 설정이 따로 필요하다), 헤드리스 CLI는 src를 통째로 싣는다 —
// 모듈이면 데스크톱 앱·CLI·개발 서버 어디서나 같은 내용이 같은 방법으로 읽힌다.
import { TOPICS } from './topics.mjs';

export { TOPICS };

const JOSA_RE = /(으로|에서|까지|부터|에게|한테|이랑|하고|이야|이지|이니|니\?|은|는|이|가|을|를|에|의|로|도|만|랑|지|야|요)$/;
const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase();
const squash = (s) => s.replace(/\s+/g, '');

/** 검색어 → 낱말(순수). 조사 하나를 떼고, 한 글자 낱말은 버린다(숫자 제외). */
export function helpTerms(q) {
  return [...new Set(norm(q).split(/[\s,.;:!?·/()[\]{}"'`~%]+/)
    .map((w) => (w.length > 2 ? w.replace(JOSA_RE, '') : w))
    .filter((w) => w.length >= 2 || /\d/.test(w)))];
}

const topicText = (t, lang) => {
  const v = t[lang] ?? t.ko;
  return { title: v.title, keywords: v.keywords ?? [], body: v.body };
};

/** 주제 점수(순수) — 제목·핵심어에 걸리면 크게, 본문에 걸리면 작게. 띄어쓰기가 달라도 맞춘다("연결밀도" = "연결 밀도"). */
export function scoreTopic(t, terms, lang = 'ko') {
  const { title, keywords, body } = topicText(t, lang);
  const head = norm(`${title} ${keywords.join(' ')}`);
  const text = norm(body);
  const has = (hay, w) => hay.includes(w) || squash(hay).includes(w);
  let s = 0;
  for (const w of terms) {
    if (has(head, w)) s += 5;
    if (has(text, w)) s += 1;
  }
  return s;
}

/**
 * 도움말 검색 — 반환 문자열(도구 결과 그대로). q가 비면 주제 목록.
 * limit = 돌려줄 주제 수(기본 2), cap = 글자 상한(매 호출이 컨텍스트에 실린다).
 */
export function searchHelp(q, { lang = 'ko', limit = 2, cap = 9000 } = {}) {
  const L = lang === 'en' ? 'en' : 'ko';
  const index = () => TOPICS.map((t) => `- ${topicText(t, L).title} (${t.id})`).join('\n');
  const terms = helpTerms(q);
  if (!terms.length) {
    return L === 'en'
      ? `Argo help topics — call again with a question or a topic id:\n${index()}`
      : `아르고 도움말 주제 — 질문이나 주제 id로 다시 불러라:\n${index()}`;
  }
  const byId = TOPICS.find((t) => t.id === norm(q).trim()); // 주제 id를 그대로 준 경우만 — 질문 속 낱말(memory·chat 등)이 다른 주제를 가로채지 않게
  const ranked = byId ? [byId] : TOPICS.map((t) => ({ t, s: scoreTopic(t, terms, L) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.t);
  if (!ranked.length) {
    return L === 'en'
      ? `No help topic matched "${q}". Topics:\n${index()}\nIf it is about the current numbers or settings, use argo_status / argo_settings instead. Do not guess about Argo features.`
      : `"${q}"에 맞는 도움말이 없다. 주제 목록:\n${index()}\n지금 숫자·설정 값이 궁금한 것이면 argo_status·argo_settings로 본다. 아르고 기능을 추측해서 답하지 마라.`;
  }
  let out = ranked.map((t) => { const v = topicText(t, L); return `# ${v.title} (${t.id})\n${v.body.trim()}`; }).join('\n\n');
  if (out.length > cap) out = `${out.slice(0, cap)}\n…`;
  return out;
}
