// 폰 목록 줄 밀기·밀어서 답장(유건 승인 2026-09-29).
//  · 줄: 오른쪽으로 밀기 = 즐겨찾기(고정), 왼쪽으로 밀기 = 알림 끄기·읽음 버튼. 절반 넘게 밀면 첫 동작을 바로 실행(iOS 메일 방식).
//  · 메시지: 왼쪽으로 밀어 60px을 넘기고 놓으면 답장(텔레그램·카카오톡 방향 — 오른쪽 뒤로가기와 겹치지 않는다).
// 움직임은 뒤로 스와이프와 같은 스프링(springStep)이라 손을 뗀 속도를 이어받는다.
import { springStep } from './use-phone.js';
import { haptic } from './haptics.js';

export const ROW_LEAD_W = 88;   // 오른쪽으로 연 칸(즐겨찾기 버튼 하나)
export const ROW_TRAIL_W = 168; // 왼쪽으로 연 칸(알림·읽음 버튼 둘)
export const ROW_OPEN_MIN = 44; // 이만큼은 밀어야 칸이 열린다
export const REPLY_AT = 60;     // 메시지를 이만큼 밀면 답장
/** 줄 높이에 맞춘 칸 폭 — 홈 줄(낮음)은 좁게·작은 글씨(data-compact), 채팅 줄은 그대로(유건 실기기 2026-09-29: 홈은 아이콘이 크고 너무 길게 빠졌다) */
export const rowWidths = (h) => (h < 56 ? { lead: 64, trail: 128, compact: true } : { lead: ROW_LEAD_W, trail: ROW_TRAIL_W, compact: false });
const LOCK_PX = 10;

/** 줄을 놓을 때 — dx: 민 거리(+오른쪽), w: 줄 폭, v: 최근 속도(px/s). { action: full|open|close, dir: lead|trail, to } */
export function rowSwipeRelease(dx, w, v, widths = rowWidths(Infinity)) {
  const dir = dx > 0 ? 'lead' : 'trail'; const a = Math.abs(dx);
  if (a >= w * 0.5) return { action: 'full', dir, to: 0 };
  const back = v !== 0 && Math.sign(v) !== Math.sign(dx) && Math.abs(v) > 200; // 되돌리며 놓으면 닫는다
  if (a >= ROW_OPEN_MIN && !back) return { action: 'open', dir, to: dx > 0 ? widths.lead : -widths.trail };
  return { action: 'close', dir, to: 0 };
}
/** 메시지 밀기의 보이는 거리 — 답장 기준까지는 손가락 그대로, 넘으면 점점 무겁게(최대 약 90px) */
export const replyOffset = (dx) => (dx >= 0 ? 0 : dx >= -REPLY_AT ? dx : -(REPLY_AT + Math.min(30, (-dx - REPLY_AT) * 0.35)));

function animate(el, from, to, v0, paint, done) {
  cancelAnimationFrame(el._swRaf); let x = from, v = v0, last = 0;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) { el._swX = to; paint(to); done?.(); return; }
  const step = (now) => {
    const dt = Math.min(0.032, last ? (now - last) / 1000 : 1 / 60); last = now;
    [x, v] = springStep(x, v, to, dt);
    if (Math.abs(x - to) < 0.5 && Math.abs(v) < 10) { el._swRaf = 0; el._swX = to; paint(to); done?.(); return; }
    el._swX = x; paint(x); el._swRaf = requestAnimationFrame(step);
  };
  el._swRaf = requestAnimationFrame(step);
}
const velocity = (samples, now) => { const a = samples[0], b = samples[samples.length - 1]; return a && b && b[0] > a[0] && now - b[0] < 120 ? ((b[1] - a[1]) / (b[0] - a[0])) * 1000 : 0; };

/** 목록 컨테이너에 줄 밀기를 붙인다. 줄 = [data-swipe-id], 움직이는 면 = 그 안의 > .item, 버튼 칸 = .msgr-swipeacts. 해제 함수를 돌려준다 */
export function bindRowSwipe(container, { onFull, blocked = () => false }) {
  let g = null; let open = null;
  const paintRow = (row) => (x) => {
    const item = row.querySelector(':scope > .item'); if (item) item.style.transform = x ? `translate3d(${x}px,0,0)` : '';
    row.style.setProperty('--sw', String(Math.round(x))); row.toggleAttribute('data-swipe', x !== 0); row.dataset.side = x > 0 ? 'lead' : x < 0 ? 'trail' : '';
  };
  const close = (row, v = 0) => { if (!row) return; animate(row, row._swX ?? 0, 0, v, paintRow(row)); if (open === row) open = null; };
  const start = (e) => {
    if (e.touches.length !== 1) { g = null; return; }
    const row = e.target.closest?.('[data-swipe-id]');
    if (open && open !== row) close(open);
    if (!row || blocked() || e.target.closest?.('.msgr-swipeacts')) { g = null; return; }
    cancelAnimationFrame(row._swRaf);
    const widths = rowWidths(row.clientHeight); row.toggleAttribute('data-compact', widths.compact);
    const t = e.touches[0]; g = { row, widths, x: t.clientX, y: t.clientY, base: row._swX ?? 0, lockX: 0, dir: null, dx: row._swX ?? 0, samples: [], full: false };
  };
  const move = (e) => {
    if (!g) return;
    const t = e.touches[0]; const dx = t.clientX - g.x, dy = t.clientY - g.y;
    if (!g.dir) {
      if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
      g.dir = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
      if (g.dir === 'y' || blocked()) { g = null; return; }
      g.lockX = t.clientX;
    }
    e.preventDefault(); // 가로로 잠긴 뒤에는 세로 스크롤·길게 누르기를 멈춘다
    const w = g.row.clientWidth || 1;
    const x = Math.max(-w, Math.min(w, g.base + (t.clientX - g.lockX)));
    g.samples.push([e.timeStamp, x]); while (g.samples.length > 2 && e.timeStamp - g.samples[0][0] > 100) g.samples.shift();
    const full = Math.abs(x) >= w * 0.5;
    if (full !== g.full) { g.full = full; g.row.toggleAttribute('data-full', full); if (full) haptic('light'); } // 끝까지 민 순간 — 놓으면 바로 실행
    g.dx = x; g.row._swX = x; paintRow(g.row)(x);
  };
  const end = (e) => {
    if (!g || g.dir !== 'x') { g = null; return; }
    const row = g.row; const w = row.clientWidth || 1; const v = velocity(g.samples, e.timeStamp);
    const r = rowSwipeRelease(g.dx, w, v, g.widths); g = null;
    row.dataset.swipedAt = String(Date.now()); row.removeAttribute('data-full');
    if (r.action === 'full') { onFull(row.dataset.swipeId, r.dir); close(row, v); }
    else if (r.action === 'open') { open = row; animate(row, row._swX ?? 0, r.to, v, paintRow(row)); }
    else close(row, v);
  };
  const cancel = () => { if (g?.row && g.dir === 'x') close(g.row); g = null; };
  // 민 직후·열린 채 누른 줄은 대화를 열지 않고 닫기만 한다. 버튼을 누르면 동작 뒤 닫는다
  const click = (e) => {
    const row = e.target.closest?.('[data-swipe-id]'); if (!row) return;
    if (e.target.closest?.('.msgr-swipeacts')) { setTimeout(() => close(row), 0); return; }
    if (Date.now() - Number(row.dataset.swipedAt || 0) < 400 || (row._swX ?? 0) !== 0) { e.preventDefault(); e.stopPropagation(); close(row); }
  };
  const onScroll = () => { if (open) close(open); };
  container.addEventListener('touchstart', start, { passive: true });
  container.addEventListener('touchmove', move, { passive: false });
  container.addEventListener('touchend', end, { passive: true });
  container.addEventListener('touchcancel', cancel, { passive: true });
  container.addEventListener('click', click, true);
  container.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    container.removeEventListener('touchstart', start); container.removeEventListener('touchmove', move); container.removeEventListener('touchend', end);
    container.removeEventListener('touchcancel', cancel); container.removeEventListener('click', click, true); container.removeEventListener('scroll', onScroll);
    if (open) { cancelAnimationFrame(open._swRaf); open._swX = 0; paintRow(open)(0); open = null; }
  };
}

/** 메시지 한 줄에 밀어서 답장을 붙인다(왼쪽으로만). 해제 함수를 돌려준다 */
export function bindSwipeReply(el, onReply) {
  let g = null; let cur = 0; // cur = 지금 보이는 거리
  const paint = (x) => { cur = x; el.style.transform = x ? `translate3d(${x}px,0,0)` : ''; el.style.setProperty('--rp', String(Math.min(1, -x / REPLY_AT))); el.toggleAttribute('data-swipe-reply', x !== 0); };
  const start = (e) => { if (e.touches.length !== 1) { g = null; return; } cancelAnimationFrame(el._swRaf); const t = e.touches[0]; g = { x: t.clientX, y: t.clientY, dir: null, lockX: 0, dx: 0, armed: false }; };
  const move = (e) => {
    if (!g) return; const t = e.touches[0]; const dx = t.clientX - g.x, dy = t.clientY - g.y;
    if (!g.dir) {
      if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
      g.dir = dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'; // 오른쪽은 뒤로가기 몫
      if (g.dir === 'y') { g = null; return; }
      g.lockX = t.clientX;
    }
    e.preventDefault();
    const raw = Math.min(0, t.clientX - g.lockX); g.dx = raw;
    const armed = raw <= -REPLY_AT; if (armed && !g.armed) haptic('light'); g.armed = armed;
    paint(replyOffset(raw));
  };
  const end = () => { if (!g || g.dir !== 'x') { g = null; return; } const go = g.armed; g = null; animate(el, cur, 0, 0, paint); if (go) onReply(); };
  const cancel = () => { if (g?.dir === 'x') animate(el, cur, 0, 0, paint); g = null; };
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', move, { passive: false });
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', cancel, { passive: true });
  return () => { el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', end); el.removeEventListener('touchcancel', cancel); cancelAnimationFrame(el._swRaf); paint(0); };
}
