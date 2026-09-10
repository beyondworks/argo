import { useEffect, useRef } from 'react';

// 터치에서 메시지 액션을 여는 길게 누르기 — 마우스는 hover·focus가 이미 연다.
// 스크롤과 구분해야 하므로 손가락이 이 거리를 넘어 움직이면 취소한다.
const MOVE_TOLERANCE = 10;

// 순수 부분 — 상태는 호출자가 보관한다(훅에서는 useRef, 테스트에서는 평범한 객체).
export function longPressHandlers(state, onLongPress, ms = 450) {
  const clear = () => { if (state.timer) { clearTimeout(state.timer); state.timer = null; } };
  return {
    clear,
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse') return;
      clear();
      state.x = e.clientX; state.y = e.clientY;
      state.timer = setTimeout(() => { state.timer = null; onLongPress(); }, ms);
    },
    onPointerMove: (e) => { if (state.timer && Math.hypot(e.clientX - state.x, e.clientY - state.y) > MOVE_TOLERANCE) clear(); },
    onPointerUp: clear,
    onPointerCancel: clear,
  };
}

export function useLongPress(onLongPress, ms) {
  const st = useRef({ timer: null, x: 0, y: 0 });
  const { clear, ...props } = longPressHandlers(st.current, onLongPress, ms);
  useEffect(() => clear, []); // 언마운트 시 타이머 정리(react-hooks 플러그인 미사용 — 규칙 주석 금지)
  return props;
}
