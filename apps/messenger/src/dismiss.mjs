// 작은 팝오버 닫기 판단(D18) — 바깥 누름이면 닫고, Escape면 닫고 연 버튼으로 초점을 돌려준다(K7).
// inside: 팝오버와 연 버튼을 모두 덮는 선택자(연 버튼을 다시 누르면 그 버튼의 토글이 닫는다)
export function dismissHandlers({ inside, close, focusTrigger }) {
  return {
    down: (e) => { if (!e.target?.closest?.(inside)) close(); },
    key: (e) => { if (e.key !== 'Escape') return; e.stopPropagation?.(); close(); focusTrigger?.(); },
  };
}
