// 화면 검수 UM5(2026-10-05): 폰 빈 입력창에서 @ 단추 오른쪽(입력창 안)을 누르면 '@'가 들어가고 멘션 목록이 열렸다 — @ 단추의 투명 누르는 영역이 입력창을 덮었다.
// 실제 렌더러에서 elementFromPoint로 잰다: 입력창 왼쪽 안쪽은 입력창, @ 단추 위·아래 가장자리는 단추. 폰 픽스처(빈 입력창)에서 부른다.
export function verifyComposerHit(doc) {
  const ta = doc.querySelector('.msgr-composer textarea'); const at = doc.querySelectorAll('.msgr-composer .msgr-tools .tb')[1];
  if (!ta || !at) throw new Error('입력창 또는 @ 단추가 없다');
  const tr = ta.getBoundingClientRect(); const ar = at.getBoundingClientRect(); const y = tr.top + tr.height / 2;
  const hit = (x, yy) => { const el = doc.elementFromPoint(x, yy); return el === ta || ta.contains(el) ? 'textarea' : el === at || at.contains(el) ? 'at' : el?.className || el?.tagName; };
  // @ 글리프는 입력 시작점 위에 겹친 안내(흐름 밖)라 그 자리는 @다 — 글리프 오른쪽 입력창(검수 재현 x=90~106)이 입력창이어야 한다
  const inside = [6, 10, 14, 18].map((dx) => ({ x: Math.round(ar.right + dx), on: hit(ar.right + dx, y) }));
  const atEdges = [hit(ar.left + ar.width / 2, ar.top - 2), hit(ar.left + ar.width / 2, ar.bottom + 2), hit(ar.right + 2, ar.top + ar.height / 2)];
  return { textareaLeft: Math.round(tr.left), atRight: Math.round(ar.right), inside, atEdges, ok: inside.every((p) => p.on === 'textarea') };
}
