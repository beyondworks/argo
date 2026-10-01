// 아주 작은 React 대역 — 페이지 컴포넌트의 **훅 배선**(useState·useEffect 순서·의존성)을 브라우저 없이 돌린다.
// 화면은 그리지 않는다(jsx는 객체만 만든다). 상태가 바뀌면 다시 렌더하고, 의존성이 바뀐 effect만 실행한다.
// 쓰는 곳: test/north-star-splash.test.mjs(홈·로그인 화면의 스플래시 준비 신호). esbuild로 묶을 때 'react'·'react/jsx-runtime'을 이 파일로 돌린다.
let cur = null;
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function slot(init) {
  const st = cur;
  const i = st.idx++;
  if (!(i in st.hooks)) st.hooks[i] = init();
  return { st, i, h: st.hooks[i] };
}

export function useState(init) {
  const { st, i, h } = slot(() => ({ v: typeof init === 'function' ? init() : init }));
  const set = (nv) => {
    const next = typeof nv === 'function' ? nv(st.hooks[i].v) : nv;
    if (Object.is(next, st.hooks[i].v)) return;
    st.hooks[i].v = next;
    st.schedule();
  };
  return [h.v, set];
}
export function useEffect(fn, deps) {
  const { st, h } = slot(() => ({ deps: undefined, cleanup: null }));
  if (deps && same(deps, h.deps)) return;
  h.deps = deps;
  st.pending.push(() => { h.cleanup?.(); const c = fn(); h.cleanup = typeof c === 'function' ? c : null; });
}
export const useLayoutEffect = useEffect;
let idSeq = 0;
export function useId() { return slot(() => `:r${(idSeq += 1)}:`).h; } // React useId 대역 — 마운트마다 유일
export function useRef(v) { return slot(() => ({ current: v })).h; }
export function useMemo(f, deps) {
  const { h } = slot(() => ({ deps: undefined, v: undefined }));
  if (!deps || !same(deps, h.deps)) { h.deps = deps; h.v = f(); }
  return h.v;
}
export const useCallback = (f, deps) => useMemo(() => f, deps);
export const Fragment = Symbol('Fragment');
export const jsx = (type, props) => ({ type, props });
export const jsxs = jsx;
export const createElement = (type, props, ...children) => ({ type, props: { ...props, children } });
export default { useId, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, Fragment, createElement };

/** 컴포넌트를 마운트한다. flush()는 예약된 다시 렌더·effect·마이크로태스크가 잦아들 때까지 돈다. */
export function mount(Component, props = {}) {
  const st = { hooks: [], idx: 0, pending: [], dirty: true, renders: 0, schedule() { st.dirty = true; } };
  const renderOnce = () => {
    st.dirty = false; st.idx = 0; st.pending = [];
    cur = st;
    try { st.out = Component(props); } finally { cur = null; }
    st.renders++;
    const run = st.pending; st.pending = [];
    for (const e of run) e();
  };
  const flush = async () => {
    for (let n = 0; n < 50; n++) {
      if (st.dirty) renderOnce();
      await new Promise((r) => setImmediate(r));
      if (!st.dirty) return st;
    }
    throw new Error('다시 렌더가 멈추지 않는다');
  };
  return { flush, state: st };
}
