// 화면 상태(열린 창 등) — 데이터가 아니라 저장하지 않는다.
import { useSyncExternalStore } from 'react';

let ui = { palette: false, share: null, assign: null, compose: null, navOpen: false };
const listeners = new Set();
export const setUi = (patch) => { ui = { ...ui, ...(typeof patch === 'function' ? patch(ui) : patch) }; listeners.forEach((l) => l()); };
export const getUi = () => ui;
export const useUi = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => ui, () => ui);
