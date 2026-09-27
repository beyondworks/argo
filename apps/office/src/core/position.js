// 형제 순서 값(분수 인덱스) — 앞(a)과 뒤(b) 사이의 문자열을 만든다. null은 끝이 열린 쪽.
// 옮긴 페이지 하나의 값만 바뀌므로 형제들을 다시 쓰지 않는다(DB 위생). 0으로 끝나는 값은 만들지 않는다(그 앞에 끼울 자리가 없다).
const D = '0123456789abcdefghijklmnopqrstuvwxyz';
const idx = (c) => D.indexOf(c);

export function between(a, b) {
  a = a ?? '';
  let out = '';
  for (let i = 0; ; i++) {
    const lo = i < a.length ? idx(a[i]) : 0;
    const hi = b != null && i < b.length ? idx(b[i]) : D.length;
    if (lo === hi) { out += D[lo]; continue; }
    const mid = (lo + hi) >> 1;
    if (mid > lo) return out + D[mid];
    out += D[lo];          // lo + 1 === hi — 이 자리는 a를 따르고, 뒤는 위 경계 없이 이어 간다
    b = null;
  }
}
