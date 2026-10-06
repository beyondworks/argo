// 창을 열 때 초점을 창 안으로 옮긴다(화면 검수 UL8, 2026-10-05). 터치 기기에서 초점 링을 피하려고 초점을 아예 옮기지 않자(UXM-17)
// VoiceOver·TalkBack 사용자가 창 안으로 들어가지 못했다. 터치면 창 자체(tabIndex=-1, 링 없음)로, 아니면 첫 단추로.
export function focusEntry({ dialog, first = null, coarse = !!globalThis.matchMedia?.('(pointer: coarse)').matches }) {
  const el = coarse ? dialog : (first ?? dialog);
  el?.focus?.({ preventScroll: true });
  return el ?? null;
}
