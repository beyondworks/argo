// 작은 팝오버 닫기 판단(D18) — 바깥 누름이면 닫고, Escape면 닫고 연 버튼으로 초점을 돌려준다(K7).
// inside: 팝오버와 연 버튼을 모두 덮는 선택자(연 버튼을 다시 누르면 그 버튼의 토글이 닫는다)
// swallow(폰): 바깥 누름은 닫기만 한다 — 뒤따르는 click 한 번을 삼켜 아래 대화 행이 열리지 않게(유건 2026-09-29).
//   iOS가 click을 안 내는 경우(스크롤로 이어진 누름)엔 500ms 뒤 풀려 다음 탭을 먹지 않는다.
export function dismissHandlers({ inside, close, focusTrigger, swallow = false, doc = globalThis.document }) {
  const eat = () => {
    const f = (e) => { e.preventDefault(); e.stopPropagation(); doc.removeEventListener('click', f, { capture: true }); };
    doc.addEventListener('click', f, { capture: true });
    setTimeout(() => doc.removeEventListener('click', f, { capture: true }), 500);
  };
  return {
    down: (e) => { if (e.target?.closest?.(inside)) return; close(); if (swallow) eat(); },
    key: (e) => { if (e.key !== 'Escape') return; e.stopPropagation?.(); close(); focusTrigger?.(); },
  };
}
