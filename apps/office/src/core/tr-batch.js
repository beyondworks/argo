// 번역 묶음 나누기(순수) — 기기에서 4개씩 동시에 번역하므로, 묶음이 고르게 작을수록 첫 결과가 빨리 온다.
const BATCH_CHARS = 2400, BATCH_ITEMS = 40;

/** 문장 목록 → 묶음(글자 수·개수 상한). 같은 문장은 한 번만 */
export function batches(strings) {
  const uniq = [...new Set(strings)];
  const out = []; let cur = [], size = 0;
  for (const s of uniq) {
    if (cur.length && (size + s.length > BATCH_CHARS || cur.length >= BATCH_ITEMS)) { out.push(cur); cur = []; size = 0; }
    cur.push(s); size += s.length;
  }
  if (cur.length) out.push(cur);
  return out.map((items, i) => ({ i, items }));
}

/** 번역할 필요가 있는 글자인가 — 공백·숫자·기호·주소만인 조각은 보내지 않는다 */
// 한국어로 옮길 때 한글뿐인 조각은 이미 목표 언어라 보내지 않는다(구독 한도·시간 절약)
export const wanted = (s, lang = 'ko') => /\p{L}/u.test(s) && !/^(https?:\/\/\S+|[\w.+-]+@[\w-]+(\.[\w-]+)+)$/.test(s.trim()) && !(lang === 'ko' && !/[^\P{L}\p{Script=Hangul}]/u.test(s));

