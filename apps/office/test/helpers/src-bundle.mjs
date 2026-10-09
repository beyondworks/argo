// src 모듈을 노드에서 불러와 화면 함수까지 시험하는 도구(10/9 #906 검수 — "화면 연결을 소스 글자 대신 행동으로").
// esbuild로 src 파일을 한 덩어리로 묶되, stubs에 적은 파일(src 기준 경로)·패키지는 그 글로 바꾼다. css는 빈 파일, 메신저 공용 별칭은 Vite와 같게.
// react는 아래 가짜 훅으로 바꾼다 — 컴포넌트를 함수처럼 불러(render) 요소 나무를 보고, 효과는 flush()로 직접 돌린다(useState 값은 다음 render에 이어진다).
// JSX는 진짜 react/jsx-runtime(운영판 — react 본체를 부르지 않는다)이 만든 요소 그대로다.
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const SHARED = fileURLToPath(new URL('../../../messenger/src/crew-face.mjs', import.meta.url));

/* ── 가짜 react 훅 ── 한 번에 한 화면(뿌리 하나)만 그린다. 훅 자리는 부른 차례로 정해진다(진짜 react와 같은 규칙) */
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
export const F = {
  slots: [], i: 0, queue: [],
  useState(init) { const i = F.i++; if (!(i in F.slots)) F.slots[i] = { v: typeof init === 'function' ? init() : init }; const s = F.slots[i]; return [s.v, (x) => { s.v = typeof x === 'function' ? x(s.v) : x; }]; },
  useReducer(fn, init) { const [v, set] = F.useState(init); return [v, (a) => set((x) => fn(x, a))]; },
  useRef(init = null) { const i = F.i++; return (F.slots[i] ??= { current: init }); },
  useMemo(fn, deps) { const i = F.i++, s = F.slots[i]; if (s && same(s.deps, deps)) return s.v; F.slots[i] = { v: fn(), deps }; return F.slots[i].v; },
  useCallback(fn, deps) { return F.useMemo(() => fn, deps); },
  useEffect(fn, deps) { const i = F.i++, s = F.slots[i]; if (s && same(s.deps, deps)) return; F.slots[i] = { deps }; F.queue.push(fn); },
  useId() { return `:r${F.i++}:`; },
  useSyncExternalStore(_subscribe, get) { return get(); },
  useContext(ctx) { return ctx?._v; },
};
F.useLayoutEffect = F.useEffect;
globalThis.__fakeReact = F;
const FAKE_REACT = `const F = globalThis.__fakeReact;
export const useState = (...a) => F.useState(...a), useReducer = (...a) => F.useReducer(...a), useRef = (...a) => F.useRef(...a), useMemo = (...a) => F.useMemo(...a),
  useCallback = (...a) => F.useCallback(...a), useEffect = (...a) => F.useEffect(...a), useLayoutEffect = (...a) => F.useLayoutEffect(...a), useId = () => F.useId(),
  useSyncExternalStore = (...a) => F.useSyncExternalStore(...a), useContext = (c) => F.useContext(c), useTransition = () => [false, (f) => f()], useDeferredValue = (v) => v;
export const Fragment = Symbol.for('react.fragment');
export const lazy = () => function Lazy() { return null; };
export const Suspense = ({ children }) => children;
export const memo = (c) => c, forwardRef = (c) => c, startTransition = (f) => f();
export const createContext = (v) => ({ _v: v, Provider: ({ children }) => children });
export const createElement = (type, props, ...children) => ({ $$typeof: Symbol.for('react.transitional.element'), type, key: null, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } });
export class Component {}
export default { useState, useRef, useMemo, useEffect, useLayoutEffect, createElement, Fragment };`;

/** 새 화면 — 훅 자리·남은 효과를 비운다 */
export function reset() { F.slots = []; F.i = 0; F.queue = []; }
/** 컴포넌트(또는 요소)를 그려 요소 나무로 — 함수 컴포넌트는 불러서 펼치고, 태그 요소만 남긴다. 같은 뿌리를 다시 그리면 useState 값이 이어진다 */
export function render(type, props = {}) { F.i = 0; return expand(typeof type === 'function' ? { type, props } : type); }
function expand(node) {
  if (Array.isArray(node)) return node.map(expand).flat();
  if (node == null || typeof node === 'boolean') return null;
  if (typeof node !== 'object') return node;
  const { type, props = {} } = node;
  if (typeof type === 'function') return expand(type(props));
  if (typeof type === 'symbol') return expand(props.children);
  return { type, props: { ...props, children: expand(props.children) } };
}
/** 남은 효과를 차례로 돌린다(효과가 상태를 바꿔도 다시 그리지는 않는다 — 필요하면 render를 다시) */
export function flush() { while (F.queue.length) F.queue.shift()(); }
/** 나무 안의 태그 요소 — pred에 맞는 것만 */
export function findAll(tree, pred = () => true) {
  const out = [];
  const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (pred(n)) out.push(n); walk(n.props.children); } };
  walk(tree);
  return out;
}
export const textOf = (n) => (Array.isArray(n) ? n.map(textOf).join('') : n == null ? '' : typeof n === 'object' ? textOf(n.props.children) : String(n));
export const hasClass = (n, c) => String(n.props.className ?? '').split(/\s+/).includes(c);

/**
 * entries(src 기준 파일 하나, 또는 { 이름: 파일 })를 묶어 새로 불러오는 함수를 돌려준다 — 부를 때마다 모듈 상태(저장소 등)가 새것이다(같은 묶음 안에서는 공유).
 * stubs: { 'core/session.js': '글', '@dnd-kit/core': '글', … } — src 파일은 경로 끝이 같으면 바꾼다. 'react'는 늘 가짜 훅.
 */
export async function bundleSrc(entries, { stubs = {} } = {}) {
  const named = typeof entries === 'string' ? { m: entries } : entries;
  const contents = Object.entries(named).map(([k, f]) => `export * as ${k} from './${f}';`).join('\n');
  const plugin = {
    name: 'office-stubs',
    setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' }));
      b.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'react-dom', namespace: 'stub' }));
      b.onResolve({ filter: /^@msgr\/crew-face$/ }, () => (stubs['@msgr/crew-face'] ? { path: '@msgr/crew-face', namespace: 'stub' } : { path: SHARED }));
      b.onResolve({ filter: /.*/ }, (args) => {
        if (stubs[args.path] !== undefined) return { path: args.path, namespace: 'stub' };
        if (!args.path.startsWith('.')) return undefined;
        const abs = resolvePath(args.resolveDir, args.path);
        const key = Object.keys(stubs).find((k) => abs === join(SRC, k));
        return key ? { path: key, namespace: 'stub' } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
        contents: args.path === 'react' ? FAKE_REACT : args.path === 'react-dom' ? (stubs['react-dom'] ?? 'export const createPortal = (el) => el; export const flushSync = (f) => f();') : stubs[args.path],
        loader: 'jsx', resolveDir: SRC,
      }));
    },
  };
  const out = await build({
    stdin: { contents, resolveDir: SRC, loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty', '.js': 'jsx' }, plugins: [plugin],
  });
  const dir = mkdtempSync(join(tmpdir(), 'office-src-'));
  const file = join(dir, 'bundle.mjs');
  writeFileSync(file, out.outputFiles[0].text);
  let n = 0;
  const load = async () => { const mod = await import(`${pathToFileURL(file).href}?n=${++n}`); return typeof entries === 'string' ? mod.m : mod; };
  load.dispose = () => rmSync(dir, { recursive: true, force: true });
  return load;
}
