// 한국어 조사 — 사전 문장의 "이(가)·을(를)·(으)로·은(는)"을 앞말 받침에 맞춰 고른다(영문·숫자 끝은 jongOf 규칙으로).
// 기억 활동 문장(Activity)이 쓰던 것을 꺼내 에이전트 꺼짐 안내도 같이 쓴다(검수 F: "페퍼이(가) 꺼져 있어…"가 그대로 보였다).

// 끝 글자의 받침(0 = 없음, 8 = ㄹ). 숫자는 한국어로 읽은 소리(3 → 삼), 영문은 n·m·ng(ㄴ·ㅁ·ㅇ)와 l(ㄹ)만 받침이고 그 밖은 받침 없음 —
// 종전엔 한글이 아니면 전부 받침 없음이라 "Fixture Organization로 돌아가기"·"Team 3로"가 나왔다(2026-10-04). 받침이 확실한 끝만 바꿔 나빠지는 문구가 없게.
const jongOf = (ch, prev) => {
  const c = /\d/.test(ch) ? '영일이삼사오육칠팔구'[ch] : ch; const code = c.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28;
  if (/l/i.test(c)) return 8;
  return /[nm]/i.test(c) || (/g/i.test(c) && /n/i.test(prev)) ? 4 : 0; // ㄴ·ㅁ·ㅇ은 고르는 조사가 같아(ㄹ이 아닌 받침) ㄴ(4) 하나로
};
export const koJosa = (txt) => txt.replace(/([^\s'"‘’“”「」『』])(['"’”」』]?)(이\(가\)|을\(를\)|\(으\)로|은\(는\))/g, (all, ch, q, j, at, s) => { // 닫는 따옴표는 건너뛰고 그 앞 글자의 받침으로(“'효일'을”, 기능 점검 D6)
  const jong = jongOf(ch, s.charAt(at - 1)); // 앞 글자는 ng 판정용 — 문장 첫 글자면 charAt(-1) = ''
  const pick = { '이(가)': jong ? '이' : '가', '을(를)': jong ? '을' : '를', '(으)로': (jong && jong !== 8) ? '으로' : '로', '은(는)': jong ? '은' : '는' }[j];
  return ch + q + pick;
});
