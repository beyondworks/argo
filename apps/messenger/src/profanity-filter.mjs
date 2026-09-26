// 부적절 표현 가리기(App Store 1.2 — 최소한의 콘텐츠 조정) — 켜고 끌 수 있는 설정, 기본 켜짐.
// 목록은 명백한 한국어·영어 욕설·혐오 표현만 짧게 둔다(전수 사전이 아니다 — 오탐보다 미탐이 낫다는 판단, 유건 지시 2026-09-26).
// 여기 한 파일에만 모아 둔다 — 다른 파일에서 이 목록을 복제하지 않는다.
// 2026-09-27 검수 L1: 영어는 왼쪽 단어 경계(\b)만 걸어 다른 단어 중간에 우연히 낀 경우(예: Scunthorpe의 cunt)를 막고
// (오른쪽은 걸지 않는다 — "fucking"·"bitches"처럼 어미가 붙어도 여전히 욕설이라 잡아야 한다), 한국어는 오탐이 흔한
// 항목(시발점·시발역·병신년)을 부정형 전방탐색으로 예외 처리한다.
const KOREAN_PATTERNS = [
  '씨발', '시발(?!점|역)', '개새끼', '병신(?!년)', '좆같', 'ㅆㅂ', 'ㅂㅅ',
];
const ENGLISH_WORDS = ['fuck', 'shit', 'bitch', 'nigger', 'faggot', 'cunt', 'retard'];
const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PARTS = [...KOREAN_PATTERNS, ...ENGLISH_WORDS.map((w) => `\\b${escapeRe(w)}`)];
const RE = new RegExp(PARTS.join('|'), 'i');

export function containsProfanity(text) {
  return typeof text === 'string' && text.length > 0 && RE.test(text);
}

const KEY = 'argo-msgr-profanity-filter';
export const PROFANITY_FILTER_EVENT = 'argo-profanity-filter-change'; // 설정 화면과 대화 목록이 다른 컴포넌트라 window 이벤트로 즉시 반영
export function readProfanityFilterOn() {
  try { const v = localStorage.getItem(KEY); return v === null ? true : v === '1'; } catch { return true; } // 기본 켜짐
}
export function writeProfanityFilterOn(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* 저장 못 해도 이번 세션은 적용 */ }
  try { window.dispatchEvent(new CustomEvent(PROFANITY_FILTER_EVENT, { detail: on })); } catch { /* 서버 렌더·구식 환경 — 다음 마운트에서 반영 */ }
}
