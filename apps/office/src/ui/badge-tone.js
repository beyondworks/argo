// 종류·분류·유형 뱃지 색(유건 10/9 "뱃지들은 종류별로 색을 다르게 표시") — 값 하나 → 색 하나. 같은 값은 어느 화면에서나 같은 색이다.
// 상태 뱃지(읽는 중·읽음·기한 지남 같은 warn·ok·danger)는 뜻이 있는 색이라 여기서 다루지 않는다.
// 색 이름 → css는 base.css의 .tone-*(테마의 상태 색을 섞어 만든 --tone). 늦게 불러오는 화면만 가져다 쓴다(첫 화면 JS 상한).

/** 쓸 수 있는 색(회색은 클래스 없이 기본 .badge) */
export const TONES = ['blue', 'teal', 'green', 'amber', 'orange', 'red', 'violet'];
/** 미리 정하지 않은 값(태그 등)이 받는 색 — 빨강은 '위험'으로 읽혀 뺀다 */
export const HASH_TONES = ['blue', 'teal', 'green', 'amber', 'orange', 'violet'];

// 키는 화면에 보이는 글이 아니라 저장값(언어가 바뀌어도 색은 그대로). 한 칸 안의 값끼리는 겹치지 않게 골랐다(test/badge-tone.test.mjs)
const FIXED = {
  // 문서함 분류 · 견적·계약 종류
  quote: 'blue', contract: 'green', bizcert: 'amber', card: 'violet', bankbook: 'teal', evidence: 'orange', archive: 'gray', general: 'gray',
  // 파일 유형
  pdf: 'red', image: 'teal', doc: 'blue', link: 'violet', other: 'gray',
  // 파일 출처
  drive: 'green', generated: 'teal', esign: 'violet', mail: 'blue', agent: 'amber',
  // 도구 종류 · 노하우 종류 · 평가 대상 유형
  service: 'blue', mcp: 'violet', plugin: 'teal', account: 'amber', knowhow: 'blue', set: 'violet', ceo: 'violet', staff: 'blue',
  // 거래 품목 과세 유형 · 거래 첨부 종류
  taxable: 'blue', zero: 'teal', exempt: 'amber', note: 'amber', page: 'green', file: 'teal',
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
