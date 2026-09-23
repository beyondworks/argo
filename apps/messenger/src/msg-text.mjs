// 메시지 본문 표시 도우미 — 말풍선 밖 한 줄(인용·목록 미리보기·OS 알림)과 부재중 안내 분리.

// 본체 게이트웨이가 늦게 처리한 답글 첫 줄에 붙이는 안내(src/gateway/msgr.mjs AWAY_NOTE_MS). 본문에 섞여 저장되고 전달 때 그대로 복사된다.
const AWAY = /^\((부재중 대기분 · \d+분 전 지시|Handled after being away · asked \d+ min ago)\)\r?\n/;

/** 본문 첫 줄의 부재중 안내를 떼어 낸다 → { note, text }. 안내가 없으면 note는 ''. */
export function splitAwayNote(body) {
  const s = String(body ?? '');
  const m = s.match(AWAY);
  return m ? { note: m[1], text: s.slice(m[0].length) } : { note: '', text: s };
}

/** 한 줄 미리보기 — 부재중 안내와 마크다운 기호를 걷고 공백을 접는다(내용 글자는 남긴다). */
export function plainPreview(body, max = 120) {
  return splitAwayNote(body).text
    .replace(/```[^\n]*\n?/g, '')                              // 코드 울타리(내용은 남김)
    .replace(/`([^`\n]*)`/g, '$1')                             // 인라인 코드
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')              // 링크·이미지 → 글자
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+\.[ \t]+)/gm, '') // 제목·인용·목록 머리
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, '$2')           // 굵게·취소선
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')  // 기울임(*a*) — 곱셈 기호 2*3은 그대로
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
