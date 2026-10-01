// 사전 문구 속 `백틱` 쌍을 코드 조각으로 나눈다 — 화면은 <code>로 그린다(백틱을 글자 그대로 찍지 않는다).
// 짝이 안 맞는 백틱은 글자 그대로 둔다(내용을 잃지 않는다).
export function splitInlineCode(text) {
  const s = String(text ?? ''); const out = []; let i = 0;
  while (i < s.length) {
    const a = s.indexOf('`', i); const b = a < 0 ? -1 : s.indexOf('`', a + 1);
    if (a < 0 || b < 0) { out.push({ text: s.slice(i) }); break; }
    if (a > i) out.push({ text: s.slice(i, a) });
    out.push({ code: s.slice(a + 1, b) }); i = b + 1;
  }
  return out;
}
