// 소스 핀용 주석 스트리퍼(정본) — 문자열 리터럴('·"·`) 안의 /* … */·//를 주석으로 오인하지 않는 하드닝판(#338 재검수 LOW-D,
// #341). 문자열 미종결이면 여는 따옴표 한 글자만 소비해 자가 치유한다. 정규식 2줄판(줄주석 우선)은 문자열 속 /*가
// 실코드를 통째로 지우는 fail-open이 있어(분리 검수 2026-09-02 MEDIUM-2), app/ 전역 스위프 같은 넓은 게이트는 이 판을 쓴다.
export function stripComments(src) {
  const out = src.split('');
  let i = 0;
  let prev = '\n'; // 주석·문자열 밖 직전 문자 — 라인 주석의 "행 머리·공백 뒤" 판정용
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      for (let k = i; k < end; k++) if (out[k] !== '\n') out[k] = ' ';
      i = end; prev = ' ';
    } else if (c === '/' && src[i + 1] === '/' && /\s/.test(prev)) {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      for (let k = i; k < end; k++) out[k] = ' ';
      i = end;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1, closed = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; closed = true; break; }
        if (src[j] === '\n' && c !== '`') break;
        j++;
      }
      prev = c;
      i = closed ? j : i + 1; // 미종결이면 여는 따옴표 한 글자만 소비(일반 문자 취급)
    } else {
      prev = c;
      i++;
    }
  }
  return out.join('');
}
