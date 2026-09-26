// 한국어 IME — 조합 중 Enter는 글자 확정만 하고 제출하지 않는다(본체 app/ui.jsx imeGuardWith와 같은 규칙).
// 스프레드와 onKeyDown을 한 태그에 같이 쓰면 한쪽이 덮이므로, 자기 처리기를 합쳐 넘기는 형태만 둔다.
export const imeGuardWith = (onKeyDown) => ({
  onKeyDown: (e) => {
    if (e.key === 'Enter' && (e.nativeEvent?.isComposing || e.keyCode === 229)) { e.preventDefault(); return; }
    onKeyDown?.(e);
  },
});
