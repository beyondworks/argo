// 열린 동안 Android 뒤로가 이것부터 닫게 한다(back-stack.mjs). open이 참이 될 때 올리고, 닫히거나 사라지면 내린다.
import { useEffect, useRef } from 'react';
import { appBackStack } from './back-stack.mjs';
export function useBackClose(open, close) {
  const ref = useRef(close); ref.current = close;
  useEffect(() => (open ? appBackStack.push(() => ref.current?.()) : undefined), [open]);
}
