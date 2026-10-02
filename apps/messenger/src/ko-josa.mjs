// 한국어 조사 — 사전 문장의 "이(가)·을(를)·(으)로·은(는)"을 앞말 받침에 맞춰 고른다(영문·숫자 끝은 받침 없음으로).
// 기억 활동 문장(Activity)이 쓰던 것을 꺼내 에이전트 꺼짐 안내도 같이 쓴다(검수 F: "페퍼이(가) 꺼져 있어…"가 그대로 보였다).
export const koJosa = (txt) => txt.replace(/([^\s'"‘’“”「」『』])(['"’”」』]?)(이\(가\)|을\(를\)|\(으\)로|은\(는\))/g, (all, ch, q, j) => { // 닫는 따옴표는 건너뛰고 그 앞 글자의 받침으로(“'효일'을”, 기능 점검 D6)
  const code = ch.charCodeAt(0); const hangul = code >= 0xac00 && code <= 0xd7a3; const jong = hangul ? (code - 0xac00) % 28 : 0;
  const pick = { '이(가)': jong ? '이' : '가', '을(를)': jong ? '을' : '를', '(으)로': (jong && jong !== 8) ? '으로' : '로', '은(는)': jong ? '은' : '는' }[j];
  return ch + q + pick;
});
