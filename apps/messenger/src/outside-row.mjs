// 방 밖 에이전트 안내의 한 줄(D14) — 글 · [1:1로 시키기] · [이 방에 추가 요청]. test/outside-row.test.mjs가 순서와 자리 유지를 잠근다.
// [이 방에 추가 요청]은 한 번 보이면 안내가 닫힐 때까지 같은 크기·자리다(request: mention-candidates.mjs outsideRowView) — 지우거나 글자를 바꾸면
// 데스크톱 오른쪽 정렬·폰 왼쪽 줄바꿈에서 [1:1로 시키기]가 그 자리로 와 더블탭 둘째 번이 1:1을 열었다(검수 #826 N2·NEW-1, 두 번 되풀이).
// JSX 없이 쓴다 — node 시험이 바로 읽는다(seg.mjs와 같다).
import { createElement as h } from 'react';

// onDm이 없으면(시킬 수 없음·1:1을 열 수 없는 화면) [1:1로 시키기]를 그리지 않는다.
export function OutsideRow({ text, dm, onDm = null, request = null, requestLabel, onRequest }) {
  const slot = request === 'slot';
  return h('div', { className: 'row' },
    h('span', { className: 'q' }, text),
    onDm ? h('button', { type: 'button', className: 'btn sm', onClick: onDm }, dm) : null,
    request ? h('button', {
      type: 'button', className: 'btn sm ghost', disabled: request !== 'on', onClick: onRequest,
      'aria-busy': request === 'busy' || undefined, 'aria-hidden': slot || undefined, tabIndex: slot ? -1 : undefined, style: slot ? { visibility: 'hidden' } : undefined,
    }, requestLabel) : null);
}
