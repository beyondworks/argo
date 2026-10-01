// 쉼(idle) 몸짓 스케줄러 — 앱 전체에 타이머 하나(setTimeout 1개)와 IntersectionObserver 하나(유건 확정 2026-10-01).
// 화면에 보이는 얼굴만 <svg data-g="…">를 붙였다 뗀다 — styles.css가 data-g가 붙은 동안 그 몸짓을 한 번 재생한다(transform·opacity만).
// 탭이 숨겨지거나 '동작 줄이기'면 새 몸짓을 시작하지 않는다(진행 중인 것만 제때 뗀다). 네트워크·저장소 호출 없음.
// 몸짓 순서·간격(2~5초)·첫 시작은 크루 id 해시(gestureAt/gesturePhase)라 크루마다 박자가 다르다.
// 몸짓 정의는 메신저 전용이라 여기 둔다 — crew-face.mjs(오피스와 공유)에 두면 오피스 첫 화면 묶음에 끌려 들어간다(150KB 상한).
import { hash } from './crew-face.mjs';

/** 몸짓 8종(길이 ms, 뽑힐 가중치). 이름은 styles.css의 .msgr-face[data-g="…"] 와 같다 */
export const GESTURES = [
  { k: 'blink', ms: 360, w: 3 },
  { k: 'look', ms: 1600, w: 2 },
  { k: 'tilt', ms: 1400, w: 1.2 },
  { k: 'bounce', ms: 900, w: 1.2 },
  { k: 'wiggle', ms: 900, w: 1 },
  { k: 'yawn', ms: 1900, w: 0.8 },
  { k: 'roll', ms: 1400, w: 1 },
  { k: 'smile', ms: 1600, w: 1.5 },
];
export const GESTURE_MS = Object.fromEntries(GESTURES.map((g) => [g.k, g.ms]));
export const GESTURE_GAP = [2000, 5000]; // 다음 몸짓까지 간격(시작~시작) 하한·상한
const G_TOTAL = GESTURES.reduce((a, g) => a + g.w, 0);
function pickGesture(h) { let r = (h % 10000) / 10000 * G_TOTAL; for (const g of GESTURES) { r -= g.w; if (r < 0) return g.k; } return GESTURES[0].k; }
/** n번째 몸짓과 다음 몸짓까지 간격(2~5초) — id·n·직전 몸짓만으로 정해진다. 직전과 같으면 다른 몸짓으로 바꾼다(같은 몸짓 연속 없음) */
export function gestureAt(id, n, prev = null) {
  let g = pickGesture(hash(`${id}|g|${n}`));
  if (g === prev) g = GESTURES[(GESTURES.findIndex((x) => x.k === g) + 1 + hash(`${id}|g2|${n}`) % (GESTURES.length - 1)) % GESTURES.length].k;
  return { g, gap: GESTURE_GAP[0] + hash(`${id}|gap|${n}`) % (GESTURE_GAP[1] - GESTURE_GAP[0] + 1) };
}
/** 첫 몸짓까지 기다림(0.4~3.4초) — 화면에 들어온 크루들이 같은 박자로 움직이지 않게 */
export const gesturePhase = (id) => 400 + hash(`${id}|phase`) % 3000;

/** env는 테스트용 주입(시계·타이머·문서·관찰자·동작 줄이기 미디어 쿼리) — 앱에서는 기본값(브라우저 전역)을 쓴다 */
export function createGestureScheduler(env = {}) {
  const {
    now = () => performance.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    doc = globalThis.document,
    Observer = globalThis.IntersectionObserver,
    reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null,
  } = env;
  const faces = new Map(); // svg → { id, n, next, clearAt, visible, last }
  let timer = null;
  const paused = () => !!(reduce?.matches || doc?.hidden);
  // 다음 할 일(몸짓 끝내기 또는 보이는 얼굴의 다음 몸짓) 가운데 가장 이른 때 하나에만 타이머를 건다
  function schedule() {
    if (timer != null) { clearTimer(timer); timer = null; }
    const stop = paused();
    let t = Infinity;
    for (const f of faces.values()) {
      if (f.clearAt) t = Math.min(t, f.clearAt);
      if (f.visible && !stop) t = Math.min(t, f.next);
    }
    if (t < Infinity) timer = setTimer(wake, Math.max(16, t - now()));
  }
  function wake() {
    timer = null;
    const at = now();
    const stop = paused();
    for (const [el, f] of faces) {
      if (f.clearAt && at >= f.clearAt - 4) { el.removeAttribute('data-g'); f.clearAt = 0; }
      if (!f.visible || stop || f.clearAt || at < f.next - 4) continue;
      const plan = gestureAt(f.id, f.n++, f.last);
      f.last = plan.g;
      // 쉼일 때만 몸짓 — 준비 중·결재 대기 같은 상태 얼굴은 자기 움직임이 있다(계획은 그대로 넘겨 박자를 유지)
      if (el.classList.contains('s-idle')) { el.setAttribute('data-g', plan.g); f.clearAt = at + GESTURE_MS[plan.g]; }
      f.next = at + plan.gap;
    }
    schedule();
  }
  // 다시 보이게 된 얼굴은 밀린 차례를 몰아서 하지 않고 크루별 첫 시작(0.4~3.4초)부터 — 여러 얼굴이 한꺼번에 움직이지 않게
  const rephase = (f, at) => { if (f.next < at) f.next = at + gesturePhase(f.id); };
  const io = Observer ? new Observer((entries) => {
    const at = now();
    for (const en of entries) {
      const f = faces.get(en.target);
      if (!f) continue;
      f.visible = en.isIntersecting;
      if (f.visible) rephase(f, at);
      else if (f.clearAt) { en.target.removeAttribute('data-g'); f.clearAt = 0; }
    }
    schedule();
  }) : null;
  const resume = () => {
    if (!paused()) { const at = now(); for (const f of faces.values()) if (f.visible) rephase(f, at); }
    schedule();
  };
  doc?.addEventListener?.('visibilitychange', resume);
  reduce?.addEventListener?.('change', resume);
  return {
    /** 얼굴 등록 — IntersectionObserver가 없으면(아주 오래된 웹뷰) 몸짓 없이 정지 얼굴로 둔다 */
    watch(el, id) {
      if (!io || !el || faces.has(el)) return;
      faces.set(el, { id: String(id), n: 0, next: -Infinity, clearAt: 0, visible: false, last: null }); // next -Infinity = 아직 차례 없음 → 처음 보일 때 첫 시작부터
      io.observe(el);
    },
    unwatch(el) {
      if (!faces.has(el)) return;
      io.unobserve(el);
      faces.delete(el);
      el.removeAttribute('data-g');
      schedule();
    },
    get size() { return faces.size; },
    get timerPending() { return timer != null; },
  };
}

let shared;
/** 앱 전체가 같이 쓰는 스케줄러 하나(처음 부를 때 만든다). DOM이 없는 곳(Node 테스트)에서는 null */
export function faceGestures() {
  if (shared === undefined) shared = typeof document === 'undefined' ? null : createGestureScheduler();
  return shared;
}
