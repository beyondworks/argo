// 내 화면 가림(12차, 유건 10/2 "연락처·이메일·금액·회사 정보는 전부 쉬머") — 저장 자리가 따로 없는 값(금액·합계·이메일·전화·메일 주소 등)의 가림.
// 행에 가림 목록이 있는 데이터(거래처 redacted·회사 정보 redacted)는 그 저장 방식을 그대로 쓰고, 여기는 그 밖의 값만 맡는다.
// 저장: 이 브라우저·이 계정의 localStorage 한 키(값은 'item:<id>:price' 같은 칸 이름 목록) — DB를 바꾸지 않는다. 화면에서 덮는 것이지 접근을 막는 것이 아니다.
import { useSyncExternalStore } from 'react';
import { scopedStorageKey } from '../core/save.js';

const KEY = 'argo-office-redact';
let cache = null, ver = 0;
const subs = new Set();
const key = () => scopedStorageKey(KEY);
const read = () => { if (cache?.key === key()) return cache.set; let list = []; try { list = JSON.parse(localStorage.getItem(key()) ?? '[]'); } catch { /* 사생활 창 등 */ } cache = { key: key(), set: new Set(Array.isArray(list) ? list : []) }; return cache.set; };
export const isHidden = (k) => read().has(k);
/** 칸들을 가리거나 푼다 — 바뀐 것이 있을 때만 한 번 저장 */
export function setHidden(keys, on) {
  const s = read(), before = s.size;
  let changed = false;
  for (const k of keys) { if (on && !s.has(k)) { s.add(k); changed = true; } if (!on && s.delete(k)) changed = true; }
  if (!changed && before === s.size) return;
  try { localStorage.setItem(key(), JSON.stringify([...s])); } catch { /* 기억만 못 한다 */ }
  ver++; subs.forEach((f) => f());
}
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
/** 가림 목록이 바뀌면 다시 그린다 */
export const useRedactStore = () => useSyncExternalStore(subscribe, () => ver);
