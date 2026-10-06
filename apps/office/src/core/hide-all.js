// 화면 전체 가리기(18차, 유건 결정 4) — 회의·화면 공유 전에 머리글 단추나 ⌘⇧H로 한 번에. 이 기기에만 기억한다(localStorage, 계정과 무관 — 다른 계정으로 바꿔도 가린 채로).
// 값은 그대로 두고 화면에서만 덮는다. 무엇을 덮는지는 business/redact-rule.js(값 가리기 Redact가 쓴다), 첫 화면·메일 글은 <html data-hide-all> CSS(base.css '.ha').
// 같은 기기의 다른 창도 따라간다(storage 이벤트).
import { useSyncExternalStore } from 'react';

const KEY = 'argo-office-hide-all';
let on = false;
try { on = localStorage.getItem(KEY) === '1'; } catch { /* 사생활 창 등 — 꺼진 채로 */ }
const subs = new Set();
const apply = () => { if (typeof document !== 'undefined') document.documentElement.toggleAttribute('data-hide-all', on); subs.forEach((f) => f()); };
apply();
export const hideAllOn = () => on;
/** 켜고 끈다(next를 안 주면 반대로). 바뀐 것이 없으면 아무것도 하지 않는다 */
export function toggleHideAll(next = !on) {
  if (next === on) return;
  on = next;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* 이번 창만 */ }
  apply();
}
if (typeof addEventListener === 'function') addEventListener('storage', (e) => { if (e.key === KEY && (e.newValue === '1') !== on) { on = e.newValue === '1'; apply(); } });
export const useHideAll = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, hideAllOn, hideAllOn);
/** 이메일 모양인가 — 'a@b.co' 또는 '이름 <a@b.co>'. 보낸 사람 이름이 없으면 서버가 주소를 이름 자리에 넣어(server/gmail.js parseAddress) 이름처럼 보이는 주소를 가려낸다 */
export const looksLikeAddr = (s) => /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/.test(String(s ?? ''));
