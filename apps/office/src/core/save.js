// 저장 상태 — 저장 버튼 없이 모든 변경이 뒤에서 저장된다(유건 지시 2026-09-26).
// 표시는 보낼 목록(core/outbox.js) 상태를 따른다. 1초 안에 끝나는 저장은 깜빡이지 않는다 — 오래 걸릴 때만 "저장 중…".
// persist/restore는 이 기기 화면 캐시(첫 화면을 바로 그리기 위한 사본)다 — 저장 상태 표시와 무관하다.
import { useSyncExternalStore } from 'react';

let status = typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'saved';
const listeners = new Set();
const set = (s) => { if (s !== status) { status = s; listeners.forEach((l) => l()); } };
let sync = 'idle', slow = null;
const derive = () => {
  clearTimeout(slow); slow = null;
  if (sync === 'idle') return set('saved');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return set('offline');
  if (sync === 'retrying') return set('saving');
  slow = setTimeout(() => set('saving'), 1000); // 1초 넘게 걸릴 때만 "저장 중…"
};
/** 보낼 목록 상태(idle | pending | retrying)를 받는다 */
export const setSyncState = (s) => { sync = s; derive(); };
if (typeof window !== 'undefined') {
  window.addEventListener('offline', derive);
  window.addEventListener('online', derive);
}
export const useSaveStatus = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => status, () => 'saved');

const timers = new Map();
/** 화면 캐시에 key의 최신 값을 쓴다. 같은 key가 빨리 여러 번 오면 마지막 값만 쓴다. */
export function persist(key, value, delay = 300) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 용량 초과 — 캐시일 뿐, 원본은 보낼 목록 */ }
    timers.delete(key);
  }, delay));
}

export function forget(key) {
  clearTimeout(timers.get(key)); timers.delete(key);
  try { localStorage.removeItem(key); } catch { /* 캐시일 뿐 */ }
}

/** 충돌로 못 보낸 내 변경 — 새로고침·탭 닫기 뒤에도 사람이 고를 때까지(사본 저장·새로 불러오기) 이 기기에 남긴다 */
export const heldKey = (id) => `argo-office-conflict:${id}`;

export function restore(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
