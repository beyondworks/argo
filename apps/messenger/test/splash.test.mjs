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

test('배선 — 작은 진입 청크(main.jsx)가 스플래시를 먼저 띄우고 앱 본체는 그다음 동적으로 불러온다, App이 로그인 화면·조직 로딩 끝에 준비 신호를 보낸다', () => {
  const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
  const start = main.indexOf('startSplash(');
  const load = main.indexOf("import('./app-root.jsx')");
  assert.ok(start > -1 && load > start, 'startSplash가 앱 본체 동적 import보다 먼저');
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
