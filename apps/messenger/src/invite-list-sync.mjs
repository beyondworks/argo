// 초대 창이 서버에 링크를 남겼을 때만(순변화가 있을 때만), 창이 닫힌 뒤 목록을 한 번 다시 읽게 한다.
// - 창은 열 때 링크를 만들고 복사하지 않은 채 닫으면 지운다 → 만들기(+1)와 버리기(-1)가 맞아떨어지면 목록은 그대로라 읽지 않는다(DB 위생:
//   초대 표는 지난 초대까지 전부 읽는다). 복사해서 남긴 링크가 있으면(+1) 닫은 뒤 한 번 읽는다.
// - 창이 닫히며 지우는 링크의 삭제 요청이 끝나기 전에 읽으면 곧 사라질 링크가 목록에 보이므로, 진행 중인 요청이 모두 끝난 뒤에 읽는다.
// 호출 순서: opened() → start()/finish(+1|-1|0) 짝(만들기·버리기) → closed(). 창이 사라질 때의 버리기는 closed()보다 먼저 start()된다.
export function inviteListSync(onStale) {
  let net = 0; let pending = 0; let open = false;
  const flush = () => { if (open || pending > 0 || net === 0) return false; net = 0; onStale(); return true; };
  return {
    opened() { open = true; },
    start() { pending++; },
    finish(delta = 0) { pending = Math.max(0, pending - 1); net += delta; flush(); }, // delta: 만들기 성공 +1, 버리기 성공 -1, 실패 0
    closed() { open = false; return flush(); },
  };
}
