// 저장 상태 — 저장 버튼 없이 모든 변경이 뒤에서 저장된다(유건 지시 2026-09-26).
// 화면 초안 단계: 이 기기(localStorage)에만 즉시 쓴다. P0에서 IndexedDB 보낼 목록 + Supabase 전송으로 바꾼다.
// 표시 규칙: 1초 안에 끝나는 저장은 표시를 깜빡이지 않는다 — 오래 걸릴 때만 "저장 중…".
import { useSyncExternalStore } from 'react';

let status = typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'saved';
const listeners = new Set();
const set = (s) => { if (s !== status) { status = s; listeners.forEach((l) => l()); } };
if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => set('offline'));
  window.addEventListener('online', () => set('saved'));
}
export const useSaveStatus = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => status, () => 'saved');

const timers = new Map();
/** key의 최신 값을 저장한다. 같은 key가 빨리 여러 번 오면 마지막 값만 쓴다. */
export function persist(key, value, delay = 300) {
  clearTimeout(timers.get(key));
  const slow = setTimeout(() => set('saving'), 1000);
  timers.set(key, setTimeout(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 용량 초과 — P0에서 IndexedDB로 */ }
    clearTimeout(slow);
    timers.delete(key);
    if (status !== 'offline') set('saved');
  }, delay));
}

export function restore(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
