// 북극성 시작 스플래시 정본 엔진(public/splash/north-star.mjs) — 메신저와 Argo 본체(부트 화면 1단계·Next 첫 화면 2단계)가 같이 쓴다.
// 1) 행동: 가짜 DOM·가짜 시계로 엔진을 그대로 돌린다(창이 가려져 애니메이션이 멈춰도 등장 끝·닫기가 타이머로 진행되는지 등).
// 2) CSP: Tauri가 HTML의 <style>에 nonce를 붙이면 'unsafe-inline'이 무시돼 style 속성이 전부 막힌다(반대 검토 2026-10-01 WKWebView 재현 —
//    메신저 설치본에서 로고 폭 0). 엔진은 style 속성을 만들지 않고, 부트 화면 HTML에는 <style>도 style 속성도 두지 않는다.
// 3) 색: 본체 스플래시는 graphite(시스템 밝기를 따름) — app/globals.css 토큰과 부트 화면 boot.css·엔진 GRAPHITE가 같은 값이어야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startNorthStar, GRAPHITE, INTRO_CAP_MS, graphitePalette } from '../public/splash/north-star.mjs';

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

test('Next 첫 화면 — 해시를 바로 지우고(BuildWatch 새로고침에 다시 안 뜨게), 정적 오버레이는 클릭을 통과시키며 8초 뒤 CSS만으로 사라진다', () => {
  const layout = read('app/layout.jsx');
  assert.match(layout, /location\.hash==='#argo-splash'\)\{document\.documentElement\.dataset\.argoSplash='1';history\.replaceState\(history\.state,'',location\.pathname\+location\.search\)/);
  assert.match(layout, /html\[data-argo-splash\] #argo-splash-ssr\{display:grid[^`]*?pointer-events:none;animation:argoSplashGone \.3s 8s forwards/);
  assert.match(layout, /calc\(112px \/ var\(--z, 1\)\)/, '표시 배율이 1이 아니어도 부트 화면과 같은 실제 크기');
  assert.ok(layout.indexOf('splashBoot') < layout.indexOf('<body>'), '첫 페인트 전(head)');
});
