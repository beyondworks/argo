// 북극성 시작 스플래시 정본 엔진(public/splash/north-star.mjs) — 메신저와 Argo 본체(부트 화면 1단계·Next 첫 화면 2단계)가 같이 쓴다.
// 1) 행동: 가짜 DOM·가짜 시계로 엔진을 그대로 돌린다(창이 가려져 애니메이션이 멈춰도 등장 끝·닫기가 타이머로 진행되는지 등).
// 2) CSP: Tauri가 HTML의 <style>에 nonce를 붙이면 'unsafe-inline'이 무시돼 style 속성이 전부 막힌다(반대 검토 2026-10-01 WKWebView 재현 —
//    메신저 설치본에서 로고 폭 0). 엔진은 style 속성을 만들지 않고, 부트 화면 HTML에는 <style>도 style 속성도 두지 않는다.
// 3) 색: 본체 스플래시는 graphite(시스템 밝기를 따름) — app/globals.css 토큰과 부트 화면 boot.css·엔진 GRAPHITE가 같은 값이어야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startNorthStar, GRAPHITE, INTRO_CAP_MS, graphitePalette } from '../public/splash/north-star.mjs';
import { continueSplash, markSplashReady, homeSplashReady, STAGE2_MAX_MS, __resetSplashContinue } from '../app/splash-continue-core.mjs';
import { loadComponent } from './helpers/load-component.mjs';
import { mount } from './helpers/mini-react.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PALETTE = GRAPHITE.light;

function env({ hidden = false, reduced = false, dark = false } = {}) {
  let now = 0;
  const timers = [];
  const anims = [];
  const violations = [];
  const el = (tag) => {
    const e = {
      tag, style: {}, dataset: {}, attrs: {}, children: [], removed: false, offsetWidth: 258,
      setAttribute(k, v) { if (k === 'style') violations.push(`setAttribute(style) on ${tag}`); e.attrs[k] = String(v); },
      appendChild(c) { e.children.push(c); return c; },
      append(...cs) { e.children.push(...cs); },
      remove() { e.removed = true; },
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 112, height: 112 }),
      animate(frames, opts) { const a = { el: e, frames, opts, cancelled: false, cancel() { a.cancelled = true; }, finished: new Promise(() => {}) }; anims.push(a); return a; },
      set textContent(v) { e.children = []; },
      set innerHTML(v) { violations.push(`innerHTML on ${tag}`); },
    };
    return e;
  };
  const body = el('body');
  const doc = {
    body, visibilityState: hidden ? 'hidden' : 'visible',
    createElement: el, createElementNS: (_ns, tag) => el(tag),
  };
  const win = {
    innerHeight: 800,
    performance: { now: () => now },
    matchMedia: (q) => ({ matches: (q.includes('reduced-motion') && reduced) || (q.includes('prefers-color-scheme: dark') && dark) }),
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + Math.max(0, ms || 0) }); return timers.length; },
  };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.done && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at; due.done = true; due.fn();
      await Promise.resolve();
    }
    now = end;
    await new Promise((r) => setImmediate(r));
  };
  return { doc, win, body, anims, violations, advance, el };
}

const settled = (p) => Promise.race([p.then(() => true), new Promise((r) => setImmediate(() => r(false)))]);

test('엔진은 style 속성·innerHTML을 만들지 않고 CSSOM으로만 그린다(설치본 CSP nonce에도 로고가 보이게)', () => {
  const e = env();
  const s = startNorthStar({ doc: e.doc, win: e.win, palette: PALETTE });
  assert.ok(s);
  assert.deepEqual(e.violations, []);
  assert.equal(s.root.style.background, '#fafafa');
  assert.equal(s.root.style.color, '#1a1a1a', '마크는 currentColor로 root 색을 따른다');
  assert.equal(s.root.style.animation, 'none', '정적 바탕의 8초 안전 사라짐을 푼다(이제 스크립트가 닫는다)');
  const svg = s.root.children.find((c) => c.dataset.part === 'logo').children[0];
  assert.deepEqual(svg.children.map((p) => p.attrs.fill), ['currentColor', 'currentColor']);
  assert.equal(e.body.children[0], s.root, 'root가 없으면 body에 새로 만든다');
});

test('같은 root로 두 번 시작하지 않는다', () => {
  const e = env();
  const root = e.el('div');
  assert.ok(startNorthStar({ doc: e.doc, win: e.win, root, palette: PALETTE }));
  assert.equal(startNorthStar({ doc: e.doc, win: e.win, root, palette: PALETTE }), null);
});

test('창이 가려져 애니메이션이 멈춰도(finished가 안 끝나도) 등장 끝은 타이머 상한에 온다(부트 이동이 멈추지 않게)', async () => {
  const e = env();
  const s = startNorthStar({ doc: e.doc, win: e.win, palette: PALETTE, autoClose: false });
  assert.equal(e.anims.length, 4, '별·꼬리·돛·후광');
  await e.advance(INTRO_CAP_MS - 1);
  assert.equal(await settled(s.introDone), false, '상한 전에는 아직');
  await e.advance(1);
  assert.equal(await settled(s.introDone), true, `${INTRO_CAP_MS}ms 상한`);
});

test('안 보이는 창으로 시작하면 등장을 건너뛰고 마지막 프레임으로 — 등장 끝은 바로', async () => {
  const e = env({ hidden: true });
  const s = startNorthStar({ doc: e.doc, win: e.win, palette: PALETTE, autoClose: false, breathe: false });
  assert.equal(e.anims.length, 0);
  assert.equal(await settled(s.introDone), true);
});

test('hold(본체 2단계)는 등장 없이 시작, 움직임 줄이기는 페이드 하나', () => {
  const a = env();
  startNorthStar({ doc: a.doc, win: a.win, palette: PALETTE, hold: true, breathe: false });
  assert.equal(a.anims.length, 0);
  const b = env({ reduced: true });
  startNorthStar({ doc: b.doc, win: b.win, palette: PALETTE });
  assert.equal(b.anims.length, 1);
  assert.deepEqual(b.anims[0].frames, [{ opacity: 0 }, { opacity: 1 }]);
});

test('autoClose=false(부트 화면)는 준비 신호에도, 시간이 지나도 스스로 닫지 않는다 — 다음 화면 이동이 덮는다', async () => {
  const e = env();
  let closed = 0;
  const s = startNorthStar({ doc: e.doc, win: e.win, palette: PALETTE, autoClose: false, breathe: false, onClosed: () => closed++ });
  s.ready();
  await e.advance(20000);
  assert.equal(s.root.removed, false);
  assert.equal(closed, 0);
});

test('준비가 빨라도 최소 0.9초 뒤 닫고, 끝맺음 애니메이션이 멈춰 있어도 타이머로 걷어 낸다(onClosed 한 번)', async () => {
  const e = env();
  let closed = 0;
  const s = startNorthStar({ doc: e.doc, win: e.win, palette: PALETTE, breathe: false, onClosed: () => closed++ });
  await e.advance(100);
  s.ready();
  await e.advance(799);
  assert.equal(s.root.style.pointerEvents, 'auto', '0.9초 전에는 아직 덮고 있다');
  await e.advance(1);
  assert.equal(s.root.style.pointerEvents, 'none', '0.9초에 닫기 시작 — 클릭을 통과시킨다');
  await e.advance(2000);
  assert.equal(s.root.removed, true);
  assert.equal(closed, 1);
});

test('준비 신호가 영영 안 오면 5초에 닫는다, 최소 0(본체 2단계)이면 준비된 순간 닫는다', async () => {
  const a = env();
  const s = startNorthStar({ doc: a.doc, win: a.win, palette: PALETTE, breathe: false });
  await a.advance(4999);
  assert.equal(s.root.style.pointerEvents, 'auto');
  await a.advance(1);
  assert.equal(s.root.style.pointerEvents, 'none');
  const b = env();
  const t = startNorthStar({ doc: b.doc, win: b.win, palette: PALETTE, hold: true, minMs: 0, breathe: false });
  await b.advance(30);
  t.ready();
  await b.advance(0);
  assert.equal(t.root.style.pointerEvents, 'none');
});

test('graphite 팔레트는 시스템 밝기를 따른다', () => {
  assert.equal(graphitePalette(env().win), GRAPHITE.light);
  assert.equal(graphitePalette(env({ dark: true }).win), GRAPHITE.dark);
});

test('CSP — 엔진 소스에 style 속성·innerHTML이 없고, 부트 화면 HTML에 <style>도 style 속성도 없다', () => {
  const src = read('public/splash/north-star.mjs').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /innerHTML|style="|setAttribute\(\s*['"]style/);
  const html = read('public/index.html').replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.ok(html.indexOf('src="/boot-splash.mjs"') > -1 && html.indexOf('type="module"') > -1, '스플래시는 별도 module 파일(인라인 스크립트 금지)');
  assert.doesNotMatch(html, /ship\.png|wave\.png/, '옛 배·파도 장면은 북극성으로 바뀌었다');
});

function graphiteTokens() {
  const css = read('app/globals.css');
  const blocks = [];
  let i = -1;
  while ((i = css.indexOf(":root[data-theme='graphite'] {", i + 1)) > -1) blocks.push(css.slice(i, css.indexOf('}', i)));
  assert.equal(blocks.length, 2, '라이트 한 벌 + 시스템 다크 한 벌');
  const pick = (b) => Object.fromEntries([...b.matchAll(/--(bg|primary|fg|fg-3|danger):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
  return { light: pick(blocks[0]), dark: pick(blocks[1]) };
}

test('색 — 엔진 GRAPHITE·부트 화면 boot.css가 globals.css graphite 토큰과 같다(라이트·다크)', () => {
  const tok = graphiteTokens();
  for (const mode of ['light', 'dark']) {
    assert.equal(GRAPHITE[mode].bg, tok[mode].bg, `${mode} 바탕 = --bg`);
    assert.equal(GRAPHITE[mode].mark, tok[mode].primary, `${mode} 마크 = --primary`);
  }
  const boot = read('public/boot.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const [lightVars, darkVars] = [boot.slice(boot.indexOf(':root {')), boot.slice(boot.indexOf('@media (prefers-color-scheme: dark)'))];
  const v = (block, name) => new RegExp(`--boot-${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(block)?.[1].toLowerCase();
  for (const [mode, block] of [['light', lightVars], ['dark', darkVars]]) {
    assert.equal(v(block, 'bg'), tok[mode].bg, `${mode} --boot-bg`);
    assert.equal(v(block, 'mark'), tok[mode].primary, `${mode} --boot-mark`);
    assert.equal(v(block, 'fg'), tok[mode].fg, `${mode} --boot-fg`);
    assert.equal(v(block, 'fg-3'), tok[mode]['fg-3'], `${mode} --boot-fg-3`);
    assert.equal(v(block, 'danger'), tok[mode].danger, `${mode} --boot-danger`);
  }
  assert.doesNotMatch(boot, /#d9b23a|#212121/i, '옛 금색 진행 막대·#212121 바탕은 폐기');
});


// ── Next 첫 화면(2단계) 행동 테스트(검수 #792 MEDIUM-1) — 배선 한 줄을 지우면 여기서 실패해야 한다 ──
const CORE = fileURLToPath(new URL('../app/splash-continue-core.mjs', import.meta.url));
const NORTH = fileURLToPath(new URL('../public/splash/north-star.mjs', import.meta.url));
const file = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

function htmlEl({ splash = true, zoom = '' } = {}) {
  const attrs = new Set(splash ? ['data-argo-splash'] : []);
  return { style: { zoom }, hasAttribute: (k) => attrs.has(k), removeAttribute: (k) => attrs.delete(k), attrs };
}
function spyStart() {
  const calls = [];
  const sp = { readies: [], ready(at) { sp.readies.push(at); } };
  return { calls, sp, start: (o) => { calls.push(o); return sp; } };
}
function fakePage({ splash = true, zoom = '', path = '/' } = {}) {
  const html = htmlEl({ splash, zoom });
  const queried = [];
  const doc = { documentElement: html, querySelector: (q) => { queried.push(q); return { q }; } };
  const win = { location: { pathname: path }, matchMedia: () => ({ matches: false }) };
  return { html, doc, win, queried };
}

test('2단계: 표시가 없으면(일반 브라우저) 아무것도 안 한다', () => {
  __resetSplashContinue();
  const s = spyStart(); const p = fakePage({ splash: false });
  assert.equal(continueSplash({ doc: p.doc, win: p.win, start: s.start }), null);
  assert.equal(s.calls.length, 0);
});

test('2단계: 표시가 있으면 엔진 오버레이를 hold·최소 0·최대 2초로 띄우고 정적 오버레이 표시를 지운다', () => {
  __resetSplashContinue();
  const s = spyStart(); const p = fakePage();
  assert.equal(continueSplash({ doc: p.doc, win: p.win, start: s.start }), s.sp);
  const o = s.calls[0];
  assert.equal(o.hold, true); assert.equal(o.minMs, 0);
  assert.equal(o.maxMs, 2000); assert.equal(STAGE2_MAX_MS, 2000, '2단계 최대 대기 2초(검수 #792 결정) — 메신저 5초 기본값과 별개');
  assert.equal(o.size, '112px'); assert.equal(o.fullWidth, true);
  assert.equal(p.html.hasAttribute('data-argo-splash'), false, '정적 오버레이를 숨긴다(안 지우면 엔진이 닫혀도 정적 로고가 8초까지 남는다)');
  assert.equal(continueSplash({ doc: p.doc, win: p.win, start: s.start }), null, '두 번 띄우지 않는다');
  assert.equal(o.target().q, 'header.topbar [data-splash-target] path', '홈은 상단바 별 자리로 날아가 앉는다');
});

test('2단계: 로그인 등 홈이 아닌 화면과 표시 배율≠1은 날아가 앉지 않고(페이드) 크기를 배율로 나눈다', () => {
  __resetSplashContinue();
  const a = spyStart(); const p = fakePage({ path: '/login' });
  continueSplash({ doc: p.doc, win: p.win, start: a.start });
  assert.equal(a.calls[0].target(), null);
  __resetSplashContinue();
  const b = spyStart(); const q = fakePage({ zoom: '1.25' });
  continueSplash({ doc: q.doc, win: q.win, start: b.start });
  assert.equal(b.calls[0].size, '89.6px'); assert.equal(b.calls[0].fullWidth, false); assert.equal(b.calls[0].target, null);
});

test('2단계: 스플래시보다 먼저 온 준비 신호는 시각을 기억했다가 넘기고, 뒤에 온 신호는 바로 넘긴다', () => {
  __resetSplashContinue();
  markSplashReady(() => 123);
  markSplashReady(() => 456); // 첫 시각만
  const s = spyStart(); const p = fakePage();
  continueSplash({ doc: p.doc, win: p.win, start: s.start });
  assert.deepEqual(s.sp.readies, [123]);
  __resetSplashContinue();
  const t = spyStart(); const q = fakePage();
  continueSplash({ doc: q.doc, win: q.win, start: t.start });
  assert.deepEqual(t.sp.readies, []);
  markSplashReady();
  assert.deepEqual(t.sp.readies, [undefined]);
});

test('2단계 + 실제 엔진: 준비 신호가 없으면 2초에 닫힌다(첫 화면을 5초까지 가리지 않는다)', async () => {
  __resetSplashContinue();
  const e = env();
  e.doc.documentElement = htmlEl();
  e.win.location = { pathname: '/' };
  e.doc.querySelector = () => null;
  const sp = continueSplash({ doc: e.doc, win: e.win });
  await e.advance(1999);
  assert.equal(sp.root.style.pointerEvents, 'auto');
  await e.advance(1);
  assert.equal(sp.root.style.pointerEvents, 'none');
});

test('홈 준비 판정 — 회사 목록(빈 목록 포함)이나 오류가 오면 준비', () => {
  assert.equal(homeSplashReady(null, ''), false);
  assert.equal(homeSplashReady([], ''), true);
  assert.equal(homeSplashReady(null, 'boom'), true);
});

// 홈·로그인 화면을 mini-react로 그대로 돌린다 — 준비 신호 effect를 지우면 splash.ready가 안 불려 실패한다
async function withSplash(run) {
  __resetSplashContinue();
  const s = spyStart(); const p = fakePage();
  continueSplash({ doc: p.doc, win: p.win, start: s.start });
  await run();
  return s.sp.readies.length;
}
const fn = (n) => `export function ${n}() { return null; }`;
const homeStubs = {
  'next/link': 'export default function Link() { return null; }',
  'next/navigation': 'export const useRouter = () => ({ push() {}, replace() {} });',
  './ui': ['Logo', 'Icon', 'Avatar', 'Spinner', 'Skeleton', 'ConfirmModal'].map(fn).join('\n')
    + '\nexport const api = (u) => globalThis.__api(u); export const imeGuard = () => ({}); export const timeAgo = () => "";',
  './runner-connect': `${fn('AiConnectionCard')}\nexport const ACCOUNT_WS = '@account'; export const anyRunnerUsable = () => true; export const runnerNeedsReconnect = () => false;`,
  './i18n': 'export const useLang = () => ({ t: (k) => k, lang: "ko" });',
  './components/LocalAssetImport': fn('LocalAssetOffer'),
};

async function mountHome(companies) {
  globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { reload() {} } };
  globalThis.__api = (u) => (u.startsWith('/api/companies?') ? companies.promise : Promise.resolve({}));
  const { default: Home } = await loadComponent(file('app/page.jsx'), { stubs: homeStubs, real: [CORE] });
  const m = mount(Home);
  await m.flush();
  return m;
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('홈 화면: 회사 목록이 오기 전에는 스플래시를 닫지 않고, 목록이 오면 한 번 닫는다', async () => {
  __resetSplashContinue();
  const s = spyStart(); const p = fakePage();
  continueSplash({ doc: p.doc, win: p.win, start: s.start });
  const c = deferred();
  const m = await mountHome(c);
  assert.equal(s.sp.readies.length, 0, '목록 전에는 아직');
  c.resolve({ companies: [], presets: [] });
  await m.flush();
  assert.equal(s.sp.readies.length, 1, '목록 뒤 준비 신호');
});

test('홈 화면: 회사 목록을 못 불러와도(오류) 스플래시를 닫는다', async () => {
  const c = deferred();
  const n = await withSplash(async () => {
    const m = await mountHome(c);
    c.reject(new Error('500'));
    await m.flush();
  });
  assert.equal(n, 1);
});

test('로그인 화면: 열리자마자 스플래시를 닫는다', async () => {
  const n = await withSplash(async () => {
    globalThis.window = { location: { hostname: 'localhost', search: '' }, addEventListener() {}, removeEventListener() {} };
    const { default: Login } = await loadComponent(file('app/login/page.jsx'), {
      real: [CORE],
      define: { 'process.env.NEXT_PUBLIC_SUPABASE_URL': '"https://example.supabase.co"', 'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': '"anon"', 'process.env.NEXT_PUBLIC_ARGO_CONTACT': '""' },
      stubs: {
        'next/link': 'export default function Link() { return null; }',
        '@supabase/ssr': 'export const createBrowserClient = () => ({});',
        '../ui': `${fn('Logo')}\n${fn('Spinner')}`,
        '../i18n': 'export const useLang = () => ({ t: (k) => k, lang: "ko" });',
        '@tauri-apps/plugin-opener': 'export const openUrl = async () => {};',
        '@tauri-apps/api/window': 'export const getCurrentWindow = () => ({});',
      },
    });
    await mount(Login).flush();
  });
  assert.equal(n, 1);
});

// layout을 그대로 렌더해(mini-react 트리) 부트 스크립트를 실제로 실행하고, 정적 오버레이 CSS 규칙을 읽는다
async function renderLayout() {
  const { default: RootLayout } = await loadComponent(file('app/layout.jsx'), {
    real: [NORTH],
    stubs: {
      './globals.css': '', './i18n': fn('LanguageProvider'), './theme': fn('ThemeProvider'),
      './build-watch': 'export default function BuildWatch() { return null; }',
      './splash-continue': 'export default function SplashContinue() { return null; }',
    },
  });
  const tree = RootLayout({ children: 'PAGE' });
  const all = [];
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); all.push(n); walk(n.props?.children); };
  walk(tree);
  return all;
}
function runBoot(code, { hash, pathname = '/login', search = '?x=1' }) {
  const replaced = [];
  const ctx = { location: { hash, pathname, search }, history: { state: { k: 1 }, replaceState: (...a) => replaced.push(a) }, document: { documentElement: { dataset: {} } } };
  vm.runInNewContext(code, ctx);
  return { dataset: ctx.document.documentElement.dataset, replaced };
}

test('Next 첫 화면 부트 스크립트: #argo-splash면 표시를 붙이고 해시를 바로 지운다(BuildWatch 새로고침에 다시 안 뜨게), 아니면 아무것도 안 한다', async () => {
  const nodes = await renderLayout();
  const code = nodes.filter((n) => n.type === 'script').map((n) => n.props.dangerouslySetInnerHTML.__html).find((c) => c.includes('argo-splash'));
  assert.ok(code, 'head에 스플래시 부트 스크립트');
  const hit = runBoot(code, { hash: '#argo-splash' });
  assert.equal(hit.dataset.argoSplash, '1');
  assert.deepEqual(hit.replaced, [[{ k: 1 }, '', '/login?x=1']], '경로·쿼리·history.state는 그대로, 해시만 지운다');
  const miss = runBoot(code, { hash: '' });
  assert.deepEqual(miss.dataset, {}); assert.deepEqual(miss.replaced, []);
  const head = nodes.find((n) => n.type === 'head');
  const inHead = []; const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); inHead.push(n); walk(n.props?.children); };
  walk(head);
  assert.ok(inHead.some((n) => n.type === 'script' && n.props.dangerouslySetInnerHTML?.__html === code), '첫 페인트 전(head)');
});

test('Next 첫 화면 정적 오버레이: 보이는 동안 클릭을 막고 8초 뒤 visibility:hidden으로 풀린다, 크기는 배율 보정, 페이지보다 앞', async () => {
  const nodes = await renderLayout();
  const css = nodes.find((n) => n.type === 'style').props.dangerouslySetInnerHTML.__html;
  const rule = (sel) => { const i = css.indexOf(`${sel}{`); assert.ok(i > -1, sel); return css.slice(i + sel.length + 1, css.indexOf('}', i)); };
  assert.match(rule('#argo-splash-ssr'), /display:none/, '표시 없으면 안 보인다');
  const on = rule('html[data-argo-splash] #argo-splash-ssr');
  assert.match(on, /position:fixed;inset:0/);
  assert.match(on, /pointer-events:auto/, '보이는 동안 클릭 막기(검수 #792 LOW-1)');
  assert.match(on, /animation:argoSplashGone \.3s 8s forwards/);
  assert.match(css, /@keyframes argoSplashGone\{to\{opacity:0;visibility:hidden\}\}/, 'visibility:hidden이 되면 클릭도 풀린다');
  assert.match(on, new RegExp(`background:${GRAPHITE.light.bg};color:${GRAPHITE.light.mark}`));
  assert.match(css, new RegExp(`prefers-color-scheme:dark\\)\\{html\\[data-argo-splash\\] #argo-splash-ssr\\{background:${GRAPHITE.dark.bg};color:${GRAPHITE.dark.mark}`));
  assert.match(rule('#argo-splash-ssr svg'), /width:calc\(112px \/ var\(--z, 1\)\)/);
  const body = nodes.find((n) => n.type === 'body');
  const kids = body.props.children;
  const ssrAt = kids.findIndex((k) => k?.props?.id === 'argo-splash-ssr');
  assert.ok(ssrAt > -1 && kids.findIndex((k) => k?.type?.name === 'SplashContinue') > ssrAt, '정적 오버레이 → SplashContinue → 페이지 순');
  assert.equal(kids[ssrAt].props.children.props.children.length, 2, '돛·별 두 path');
});

test('SplashContinue 컴포넌트: 마운트되면 2단계를 넘겨받는다(표시를 지운다)', async () => {
  __resetSplashContinue();
  const html = htmlEl();
  globalThis.document = { documentElement: html }; // body가 없으면 엔진은 그리지 않지만 넘겨받기(표시 제거)는 한다
  globalThis.window = { location: { pathname: '/' }, matchMedia: () => ({ matches: false }), performance };
  try {
    const { default: SplashContinue } = await loadComponent(file('app/splash-continue.jsx'), { real: [CORE] });
    const m = mount(SplashContinue);
    await m.flush();
    assert.equal(m.state.out, null, '아무것도 그리지 않는다');
    assert.equal(html.hasAttribute('data-argo-splash'), false);
  } finally { delete globalThis.document; }
});
