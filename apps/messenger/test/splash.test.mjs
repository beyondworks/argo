// 시작 스플래시(북극성, 유건 선택 2026-09-29) — 로딩 시간을 늘리지 않는다: 준비가 빨라도 최소 0.9초, 늦으면 준비된 순간, 신호가 안 와도 5초에 닫는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splashExitAt, SPLASH_MIN_MS, SPLASH_MAX_MS } from '../../../public/splash/timing.mjs'; // 정본은 본체와 같이 쓰는 public/splash/(2026-10-01)

test('닫는 시각 — 최소 0.9초, 준비가 늦으면 준비 시각, 준비 신호가 없으면 5초', () => {
  assert.equal(SPLASH_MIN_MS, 900); assert.equal(SPLASH_MAX_MS, 5000);
  assert.equal(splashExitAt(1000, 1200), 1900, '빨리 준비돼도 0.9초는 보여 준다');
  assert.equal(splashExitAt(1000, 3000), 3000, '늦으면 준비된 순간');
  assert.equal(splashExitAt(1000, null), 6000, '신호가 없으면 5초에 닫는다(앱이 멈춰 보이지 않게)');
  assert.equal(splashExitAt(1000, 9000), 6000, '5초를 넘기지 않는다');
});

test('최소·최대를 바꿔 부를 수 있다(본체 2단계는 최소 0) — 기본값은 그대로', () => {
  assert.equal(splashExitAt(1000, 1200, 0), 1200, '최소 0이면 준비된 순간');
  assert.equal(splashExitAt(1000, null, 0, 3000), 4000);
});

test('배선 — 진입 청크(main.jsx)는 큰 앱 본체를 정적으로 끌어오지 않는다(순서는 아래 행동 테스트), App이 로그인 화면·조직 로딩 끝에 준비 신호를 보낸다', () => {
  const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /from '\.\/App\.jsx'|from 'react-dom\/client'/, '진입 청크가 큰 앱 본체를 정적으로 끌어오면 스플래시가 다시 번들 해석 뒤로 밀린다');
  const root = readFileSync(new URL('../src/app-root.jsx', import.meta.url), 'utf8');
  assert.match(root, /createRoot\(document\.getElementById\('root'\)\)/);
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /if \(!configured \|\| sessionWaiting \|\| session === null\) markAppReady\(\);/);
  const early = app.indexOf('if (orgs === null) return');
  const ready = app.indexOf('if (orgs !== null) markAppReady();');
  assert.ok(ready > -1 && ready < early, '조직 준비 신호는 조기 반환 앞(훅 순서)');
});

test('정적 바탕 — 첫 페인트부터 스플래시 색을 head의 CSS 파일로 깔고, 스크립트가 없을 때는 8초 뒤 스스로 사라진다', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="argo-splash" aria-hidden="true"><\/div>/);
  assert.ok(html.indexOf('id="argo-splash"') < html.indexOf('id="root"'), '앱보다 앞(위에 덮이게)');
  assert.ok(html.indexOf('href="/src/splash.css"') > -1 && html.indexOf('href="/src/splash.css"') < html.indexOf('</head>'), 'head에서 읽는다(첫 페인트 전)');
  const css = readFileSync(new URL('../src/splash.css', import.meta.url), 'utf8');
  assert.match(css, /#argo-splash \{[^}]*background: #1F1E1B;[^}]*animation: argoSplashGone \.3s 8s forwards;/);
  const js = readFileSync(new URL('../src/splash.js', import.meta.url), 'utf8');
  assert.match(js, /root: document\.getElementById\('argo-splash'\)/, '정적 바탕을 이어받는다');
  assert.match(js, /bg: '#1F1E1B', mark: '#E4E700'/, '메신저 색은 그대로(본체만 graphite)');
});

// 설치본 CSP(반대 검토 2026-10-01, WKWebView 재현): Tauri가 HTML의 <style>에 nonce를 붙이면 style-src의 'unsafe-inline'이 무시돼
// style 속성이 전부 막힌다 — 0.1.46까지 index.html의 <style> 하나 때문에 정적 바탕도 로고 크기도 안 그려졌다.
test('CSP — index.html에 <style> 요소도 style 속성도 없다', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
});

test('모바일 창 — iOS·Android 창은 데스크톱 창 설정 그대로 + 스플래시 색 바탕(배열은 통째로 바뀌므로 어긋나면 데스크톱 값이 빠진다)', () => {
  const conf = (f) => JSON.parse(readFileSync(new URL(`../src-tauri/${f}`, import.meta.url), 'utf8'));
  const base = conf('tauri.conf.json').app.windows;
  assert.equal(base.length, 1);
  for (const f of ['tauri.ios.conf.json', 'tauri.android.conf.json']) {
    assert.deepEqual(conf(f).app.windows, [{ ...base[0], backgroundColor: '#1F1E1B' }], f);
  }
  assert.equal(base[0].backgroundColor, undefined, '데스크톱(맥·윈도우)은 바꾸지 않는다');
  const cap = conf('capabilities/mobile.json');
  assert.ok(cap.permissions.includes('core:webview:allow-set-webview-background-color'), '스플래시가 닫힌 뒤 테마 바탕으로 바꾸는 권한(webview-bg.js)');
});

// ── 시작 순서 행동 테스트(검수 #792 MEDIUM-1) — 배선 한 줄을 지우면 여기서 실패해야 한다 ──
import { bootMessenger, renderChunkError, pickLang, CHUNK_ERROR_TEXT } from '../src/boot-entry.mjs';
import { loadComponent } from '../../../test/helpers/load-component.mjs';
import { fileURLToPath } from 'node:url';

const flushAll = () => new Promise((r) => setImmediate(r));
function spySplash(ret = { ready() { this.readied = (this.readied || 0) + 1; } }) {
  const calls = [];
  return { calls, startSplash: (o) => { calls.push(o); return ret; } };
}

test('모바일: 스플래시가 닫히면(onClosed) 웹뷰 바탕을 테마 색으로 바꾼다, 데스크톱은 닫힘 콜백이 없다', async () => {
  for (const platform of ['ios', 'android']) {
    const s = spySplash(); let follow = 0;
    bootMessenger({ platform, startSplash: s.startSplash, followThemeBackground: () => follow++, loadApp: async () => {} });
    assert.equal(follow, 0, '스플래시가 닫히기 전에는 바꾸지 않는다');
    s.calls[0].onClosed();
    assert.equal(follow, 1, platform);
  }
  for (const platform of [undefined, 'macos', 'windows', 'linux']) {
    const s = spySplash(); let follow = 0;
    const r = bootMessenger({ platform, startSplash: s.startSplash, followThemeBackground: () => follow++, loadApp: async () => {} });
    assert.equal(s.calls[0].onClosed, undefined, String(platform));
    assert.equal(r.mobile, false);
    assert.equal(follow, 0);
  }
});

test('스플래시를 먼저 띄우고 그다음 앱 본체 청크를 부른다', async () => {
  const order = [];
  const r = bootMessenger({ platform: 'macos', startSplash: () => { order.push('splash'); return null; }, followThemeBackground: () => {}, loadApp: async () => { order.push('app'); } });
  await r.loaded;
  assert.deepEqual(order, ['splash', 'app']);
});

test('모바일에서 스플래시가 안 뜨면(null) 닫힘을 기다리지 않고 바로 테마 바탕으로', () => {
  let follow = 0;
  bootMessenger({ platform: 'ios', startSplash: () => null, followThemeBackground: () => follow++, loadApp: async () => {} });
  assert.equal(follow, 1);
});

test('앱 청크를 못 불러오면 진단을 남기고 스플래시를 걷은 뒤 안내를 그린다', async () => {
  const splash = { readied: 0, ready() { this.readied++; } };
  const seen = [];
  const r = bootMessenger({
    platform: 'macos', startSplash: () => splash, followThemeBackground: () => {},
    loadApp: () => Promise.reject(new Error('chunk 404')),
    diag: (e) => seen.push(['diag', e.message]), onChunkError: (e) => seen.push(['ui', e.message]),
  });
  await r.loaded;
  assert.deepEqual(seen, [['diag', 'chunk 404'], ['ui', 'chunk 404']]);
  assert.equal(splash.readied, 1);
  const ok = bootMessenger({ platform: 'macos', startSplash: () => splash, followThemeBackground: () => {}, loadApp: async () => {}, onChunkError: () => seen.push('x') });
  await ok.loaded;
  assert.equal(seen.length, 2, '성공하면 안내 없음');
});

function fakeDoc() {
  const mk = (tag) => {
    const e = { tag, children: [], attrs: {}, listeners: {}, className: '', textContent: '', type: '',
      setAttribute(k, v) { if (k === 'style') throw new Error('style 속성 금지(CSP)'); e.attrs[k] = v; },
      append(...c) { e.children.push(...c); }, appendChild(c) { e.children.push(c); return c; },
      addEventListener(n, f) { e.listeners[n] = f; } };
    return e;
  };
  const root = mk('div');
  return { root, doc: { createElement: mk, getElementById: (id) => (id === 'root' ? root : null), body: mk('body') } };
}

test('청크 실패 안내 — 두 언어 고정 문구(언어는 argo-lang, 기본 한국어), [다시 열기]는 새로 고침, style 속성 없음', () => {
  for (const [saved, lang] of [[null, 'ko'], ['en', 'en'], ['ko', 'ko']]) {
    const { root, doc } = fakeDoc();
    let reloads = 0;
    const win = { localStorage: { getItem: () => saved }, location: { reload: () => reloads++ } };
    assert.equal(pickLang(win), lang);
    const box = renderChunkError({ doc, win });
    assert.equal(root.children[0], box, '#root 안에');
    assert.equal(box.attrs.role, 'alert');
    const [title, hint, btn] = box.children;
    assert.equal(title.textContent, CHUNK_ERROR_TEXT[lang].title);
    assert.equal(hint.textContent, CHUNK_ERROR_TEXT[lang].hint);
    assert.equal(btn.textContent, CHUNK_ERROR_TEXT[lang].reload);
    btn.listeners.click();
    assert.equal(reloads, 1);
  }
  for (const l of ['ko', 'en']) for (const k of ['title', 'hint', 'reload']) assert.ok(CHUNK_ERROR_TEXT[l][k], `${l}.${k}`);
});

// main.jsx를 그대로 묶어 실행 — 진입 파일이 boot-entry에 플랫폼·스플래시·바탕 바꾸기·앱 청크를 제대로 넘기는지
let runN = 0;
async function runMain(platform, { appFails = false } = {}) {
  const log = [];
  const nonce = `\n// run ${++runN}`; // data: 모듈은 같은 소스면 캐시돼 두 번째 실행이 안 돈다
  globalThis.__log = log;
  globalThis.location = { href: 'tauri://localhost/' };
  await loadComponent(fileURLToPath(new URL('../src/main.jsx', import.meta.url)), {
    define: { 'import.meta.env.TAURI_ENV_PLATFORM': platform ? JSON.stringify(platform) : 'undefined' },
    stubs: {
      '@argo/globals.css': nonce, './styles.css': '',
      './splash.js': 'export const startSplash = (o) => { globalThis.__log.push(["splash", o]); return { ready() {} }; };',
      './diag.jsx': 'export const pushDiag = (...a) => globalThis.__log.push(["diag", a[0], String(a[1]).slice(0, 20)]);',
      './webview-bg.js': 'export const followThemeBackground = () => globalThis.__log.push(["follow"]);',
      './app-root.jsx': (appFails ? 'throw new Error("boom");' : 'globalThis.__log.push(["app"]);') + nonce,
      './boot-entry.mjs': readFileSync(new URL('../src/boot-entry.mjs', import.meta.url), 'utf8')
        .replace("export function renderChunkError(", 'export function __real(').replace(/^/, 'export const renderChunkError = () => globalThis.__log.push(["chunk-ui"]);\n'),
    },
  });
  await flushAll(); await flushAll();
  return log;
}

test('main.jsx — iOS 빌드는 스플래시 닫힘에 바탕 바꾸기를 걸고, 데스크톱 빌드는 걸지 않는다, 앱 청크를 불러온다', async () => {
  const ios = await runMain('ios');
  const s = ios.find((e) => e[0] === 'splash');
  assert.equal(typeof s[1].onClosed, 'function');
  assert.ok(ios.some((e) => e[0] === 'app'), '앱 본체 청크 로드');
  s[1].onClosed();
  assert.ok(ios.some((e) => e[0] === 'follow'));
  const mac = await runMain(undefined);
  assert.equal(mac.find((e) => e[0] === 'splash')[1].onClosed, undefined);
  assert.ok(mac.some((e) => e[0] === 'app'));
});

test('main.jsx — 앱 청크가 실패하면 진단 기록 + 안내 화면', async () => {
  const log = await runMain('android', { appFails: true });
  assert.ok(log.some((e) => e[0] === 'diag' && e[1] === 'boot' && e[2].startsWith('app chunk failed')));
  assert.ok(log.some((e) => e[0] === 'chunk-ui'));
});

test('app-root.jsx — 앱 전체를 RootBoundary(빈 화면 대신 오류 문구) 안에서 #root에 그린다', async () => {
  globalThis.__rendered = null;
  globalThis.document = { getElementById: (id) => ({ id }) };
  try {
    await loadComponent(fileURLToPath(new URL('../src/app-root.jsx', import.meta.url)), {
      stubs: {
        'react-dom/client': 'export const createRoot = (el) => ({ render: (tree) => { globalThis.__rendered = { el, tree }; } });',
        './diag.jsx': 'export function RootBoundary() {}',
        '@argo/i18n': 'export function LanguageProvider() {}',
        '@argo/theme': 'export function ThemeProvider() {}',
        './App.jsx': 'export default function App() {}',
      },
    });
  } finally { delete globalThis.document; }
  const { el, tree } = globalThis.__rendered;
  assert.equal(el.id, 'root');
  assert.equal(tree.type.name, 'RootBoundary', '맨 바깥이 RootBoundary');
  const theme = tree.props.children.props.children;
  assert.equal(theme.type.name, 'ThemeProvider');
  assert.equal(theme.props.defaultTheme, 'linen');
});
