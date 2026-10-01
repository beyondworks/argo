// 쉼 몸짓 스케줄러(face-gestures.mjs) — 앱 전체에 타이머 하나, 화면에 보이는 쉼 얼굴에만 data-g, 탭 숨김·동작 줄이기면 정지.
// 시계·타이머·문서·IntersectionObserver를 주입해 브라우저 없이 행동을 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGestureScheduler, faceGestures } from '../src/face-gestures.mjs';
import { gestureAt, gesturePhase, GESTURE_MS } from '../src/crew-face.mjs';

function harness() {
  let t = 0, seq = 0;
  const timers = new Map(); // id → {at, fn}
  const listeners = {};
  const doc = { hidden: false, addEventListener: (ev, fn) => { listeners[ev] = fn; } };
  const reduce = { matches: false, addEventListener: (ev, fn) => { listeners[`mq:${ev}`] = fn; } };
  let observer;
  class Observer { constructor(cb) { this.cb = cb; this.seen = new Set(); observer = this; } observe(el) { this.seen.add(el); } unobserve(el) { this.seen.delete(el); } }
  const s = createGestureScheduler({
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => timers.delete(id),
    doc, Observer, reduce,
  });
  const el = (state = 'idle') => {
    const attrs = {};
    return { attrs, cls: new Set([`s-${state}`]), classList: { contains(c) { return this.owner.cls.has(c); } }, setAttribute(k, v) { attrs[k] = v; }, removeAttribute(k) { delete attrs[k]; }, init() { this.classList.owner = this; return this; } }.init();
  };
  const show = (e, on = true) => observer.cb([{ target: e, isIntersecting: on }]);
  // 가상 시계를 ms만큼 진행하며 만기된 타이머를 순서대로 실행. 매 순간 대기 타이머 수를 기록
  const advance = (ms, onTick) => {
    const end = t + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]); t = next[1].at; next[1].fn();
      onTick?.();
    }
    t = end;
  };
  return { s, el, show, advance, timers, doc, reduce, listeners, now: () => t, observer: () => observer };
}

test('보이는 쉼 얼굴만 몸짓 — 첫 몸짓은 크루별 첫 시작(0.4~3.4초)에, 길이만큼 뒤 data-g를 뗀다', () => {
  const h = harness();
  const a = h.el(), b = h.el();
  h.s.watch(a, 'crew-a'); h.s.watch(b, 'crew-b');
  assert.equal(h.timers.size, 0, '아직 보이는 얼굴이 없으면 타이머도 없다');
  h.show(a);
  assert.equal(h.timers.size, 1);
  const first = gestureAt('crew-a', 0, null).g;
  h.advance(gesturePhase('crew-a') - 1);
  assert.equal(a.attrs['data-g'], undefined, '첫 시작 전');
  h.advance(1);
  assert.equal(a.attrs['data-g'], first, '계획한 첫 몸짓');
  assert.equal(b.attrs['data-g'], undefined, '안 보이는 얼굴은 data-g 없음');
  h.advance(GESTURE_MS[first]);
  assert.equal(a.attrs['data-g'], undefined, '몸짓 길이만큼 뒤 뗀다');
});

test('타이머는 언제나 하나 — 얼굴 40개가 1분 동안 움직여도', () => {
  const h = harness();
  const faces = Array.from({ length: 40 }, (_, i) => { const e = h.el(); h.s.watch(e, `crew-${i}`); h.show(e); return e; });
  let max = 0, starts = 0;
  const before = new Map(faces.map((f) => [f, undefined]));
  h.advance(60_000, () => {
    max = Math.max(max, h.timers.size);
    for (const f of faces) { const g = f.attrs['data-g']; if (g && before.get(f) !== g) starts++; before.set(f, g); }
  });
  assert.equal(max, 1, '대기 타이머는 최대 1개');
  // 크루당 분당 12~30회(간격 2~5초) — 40명이면 대략 480~1200회. 몸짓이 이어 붙는 경우 셈이 줄 수 있어 하한을 낮게 둔다
  assert.ok(starts > 300 && starts < 1300, `1분 몸짓 시작 ${starts}회`);
});

test('같은 몸짓 연속 없음 + 간격 2~5초 — 실제 스케줄러 출력으로', () => {
  const h = harness();
  const a = h.el();
  h.s.watch(a, 'crew-seq'); h.show(a);
  const log = [];
  let cur;
  h.advance(120_000, () => { const g = a.attrs['data-g']; if (g && g !== cur) log.push({ g, t: h.now() }); cur = g; });
  assert.ok(log.length >= 24, `2분 ${log.length}회`);
  for (let i = 1; i < log.length; i++) {
    assert.notEqual(log[i].g, log[i - 1].g, `연속 ${log[i].g}`);
    const gap = log[i].t - log[i - 1].t;
    assert.ok(gap >= 2000 && gap <= 5000, `간격 ${gap}`);
  }
});

test('준비 중·결재 대기 같은 상태 얼굴에는 data-g를 붙이지 않는다(계획 박자는 유지)', () => {
  const h = harness();
  const w = h.el('work');
  h.s.watch(w, 'crew-w'); h.show(w);
  h.advance(30_000, () => assert.equal(w.attrs['data-g'], undefined));
  w.cls.clear(); w.cls.add('s-idle');
  let got = false;
  h.advance(6000, () => { if (w.attrs['data-g']) got = true; });
  assert.ok(got, '쉼으로 돌아오면 다시 몸짓');
});

test('화면 밖으로 나가면 진행 중 몸짓을 바로 떼고 더는 깨우지 않는다', () => {
  const h = harness();
  const a = h.el();
  h.s.watch(a, 'crew-a'); h.show(a);
  h.advance(gesturePhase('crew-a'));
  assert.ok(a.attrs['data-g']);
  h.show(a, false);
  assert.equal(a.attrs['data-g'], undefined);
  assert.equal(h.timers.size, 0, '보이는 얼굴이 없으면 타이머 0');
  h.advance(60_000, () => assert.equal(a.attrs['data-g'], undefined));
});

test('탭 숨김·동작 줄이기 — 새 몸짓을 시작하지 않고(타이머 0), 돌아오면 크루별 첫 시작부터 다시', () => {
  for (const mode of ['hidden', 'reduce']) {
    const h = harness();
    const a = h.el();
    h.s.watch(a, 'crew-a'); h.show(a);
    h.advance(gesturePhase('crew-a') + GESTURE_MS[gestureAt('crew-a', 0).g] + 5); // 첫 몸짓 끝
    if (mode === 'hidden') { h.doc.hidden = true; h.listeners.visibilitychange(); } else { h.reduce.matches = true; h.listeners['mq:change'](); }
    assert.equal(h.timers.size, 0, `${mode}: 타이머 0`);
    h.advance(60_000, () => assert.equal(a.attrs['data-g'], undefined));
    if (mode === 'hidden') { h.doc.hidden = false; h.listeners.visibilitychange(); } else { h.reduce.matches = false; h.listeners['mq:change'](); }
    assert.equal(h.timers.size, 1, `${mode}: 다시 하나`);
    let got = false;
    h.advance(3400 + 10, () => { if (a.attrs['data-g']) got = true; });
    assert.ok(got, `${mode}: 3.4초 안에 다시 움직인다(밀린 차례를 몰아서 하지 않음)`);
  }
});

test('unwatch — 관찰 해제·data-g 제거·타이머 정리, 같은 요소 두 번 등록 무시', () => {
  const h = harness();
  const a = h.el();
  h.s.watch(a, 'crew-a'); h.s.watch(a, 'crew-a');
  assert.equal(h.s.size, 1);
  h.show(a); h.advance(gesturePhase('crew-a'));
  h.s.unwatch(a);
  assert.equal(h.s.size, 0);
  assert.equal(a.attrs['data-g'], undefined);
  assert.equal(h.observer().seen.size, 0);
  assert.equal(h.timers.size, 0);
});

test('IntersectionObserver가 없는 환경 — 등록을 건너뛴다(정지 얼굴), DOM 없는 Node에서는 공유 스케줄러 null', () => {
  const s = createGestureScheduler({ Observer: undefined, doc: null, reduce: null });
  s.watch({ setAttribute() {}, removeAttribute() {} }, 'x');
  assert.equal(s.size, 0);
  assert.equal(faceGestures(), null);
});
