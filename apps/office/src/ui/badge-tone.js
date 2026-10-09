// 종류·분류·유형 뱃지 색(유건 10/9 "뱃지들은 종류별로 색을 다르게 표시") — 값 하나 → 색 하나. 같은 값은 어느 화면에서나 같은 색이다.
// 상태 뱃지(읽는 중·읽음·실패 같은 warn·ok·danger)는 뜻이 있는 색이라 여기서 다루지 않는다. 종류 색에는 상태 색조(빨강·초록·호박색)가 없다.
// 색 이름 → css는 base.css의 .tone-*(종류 전용 토큰 --kind-*). 늦게 불러오는 화면만 가져다 쓴다(첫 화면 JS 상한).

/** 쓸 수 있는 색(회색은 클래스 없이 기본 .badge) — 청록·하늘·파랑·남색·보라·분홍 */
export const TONES = ['teal', 'sky', 'blue', 'indigo', 'violet', 'pink'];
/** 미리 정하지 않은 값(태그 등)이 받는 색 — 여섯 모두(상태로 읽히는 색이 없다). 순서는 해시 칸 순서 —
 *  예시 문서함의 태그('한빛코퍼레이션'·'signed')가 같은 줄의 출처·분류·유형 색과 겹치지 않는 순서다(test/badge-tone.test.mjs) */
export const HASH_TONES = ['teal', 'sky', 'blue', 'indigo', 'pink', 'violet'];

// 키는 화면에 보이는 글이 아니라 저장값(언어가 바뀌어도 색은 그대로).
// 한 칸 안의 값끼리, 그리고 문서함 한 줄·미리보기에 함께 나오는 값끼리(분류 × 유형 × 출처 × 태그) 겹치지 않게 골랐다 — test/badge-tone.test.mjs
const FIXED = {
  // 문서함 분류 · 견적·계약 종류
  quote: 'blue', contract: 'indigo', bizcert: 'teal', card: 'pink', bankbook: 'sky', evidence: 'violet', archive: 'gray', general: 'gray',
  // 파일 유형 — PDF는 견적·계약·사업자등록증·통장사본·증빙과, 그림은 명함·사업자등록증·통장사본·증빙과 같은 줄에 자주 나온다
  pdf: 'pink', image: 'blue', doc: 'teal', link: 'sky', other: 'gray',
  // 파일 출처 — 만든 파일은 견적·계약 PDF, 서명본은 계약 PDF, 메일은 증빙 PDF·그림, 드라이브는 링크·문서와 함께 나온다
  drive: 'blue', generated: 'violet', esign: 'teal', mail: 'sky', agent: 'indigo',
  // 도구 종류 · 노하우 종류 · 평가 대상 유형
  service: 'blue', mcp: 'violet', plugin: 'teal', account: 'pink', knowhow: 'blue', set: 'violet', ceo: 'pink', staff: 'teal',
  // 거래 품목 과세 유형 · 거래 첨부 종류
  taxable: 'blue', zero: 'teal', exempt: 'violet', note: 'pink', page: 'teal', file: 'indigo',
};

function hashTone(s) {
  let h = 0x811c9dc5; // FNV-1a
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193); }
  return HASH_TONES[(h >>> 0) % HASH_TONES.length];
}

/** 뱃지에 붙일 클래스 — 'tone tone-blue', 회색이면 '' */
export function badgeTone(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return '';
  const tone = Object.hasOwn(FIXED, v) ? FIXED[v] : hashTone(v);
  return tone === 'gray' ? '' : `tone tone-${tone}`;
}
