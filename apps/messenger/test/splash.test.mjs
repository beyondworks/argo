// 시작 스플래시(북극성, 유건 선택 2026-09-29) — 로딩 시간을 늘리지 않는다: 준비가 빨라도 최소 0.9초, 늦으면 준비된 순간, 신호가 안 와도 5초에 닫는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splashExitAt, SPLASH_MIN_MS, SPLASH_MAX_MS } from '../src/splash-timing.mjs';

test('닫는 시각 — 최소 0.9초, 준비가 늦으면 준비 시각, 준비 신호가 없으면 5초', () => {
  assert.equal(SPLASH_MIN_MS, 900); assert.equal(SPLASH_MAX_MS, 5000);
  assert.equal(splashExitAt(1000, 1200), 1900, '빨리 준비돼도 0.9초는 보여 준다');
  assert.equal(splashExitAt(1000, 3000), 3000, '늦으면 준비된 순간');
  assert.equal(splashExitAt(1000, null), 6000, '신호가 없으면 5초에 닫는다(앱이 멈춰 보이지 않게)');
  assert.equal(splashExitAt(1000, 9000), 6000, '5초를 넘기지 않는다');
});

test('배선 — main.jsx가 React보다 먼저 스플래시를 띄우고, App이 로그인 화면·조직 로딩 끝에 준비 신호를 보낸다', () => {
  const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.ok(main.indexOf('startSplash()') > -1 && main.indexOf('startSplash()') < main.indexOf('createRoot('), 'createRoot 전에 startSplash()');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /if \(!configured \|\| sessionWaiting \|\| session === null\) markAppReady\(\);/);
  const early = app.indexOf('if (orgs === null) return');
  const ready = app.indexOf('if (orgs !== null) markAppReady();');
  assert.ok(ready > -1 && ready < early, '조직 준비 신호는 조기 반환 앞(훅 순서)');
});

test('정적 바탕 — index.html이 첫 페인트부터 스플래시 색을 깔고, 스크립트가 없을 때는 8초 뒤 스스로 사라진다', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="argo-splash"[^>]*background:#1F1E1B[^>]*animation:argoSplashGone \.3s 8s forwards/);
  assert.ok(html.indexOf('id="argo-splash"') < html.indexOf('id="root"'), '앱보다 앞(위에 덮이게)');
  const js = readFileSync(new URL('../src/splash.js', import.meta.url), 'utf8');
  assert.match(js, /let root = document\.getElementById\('argo-splash'\);/, '정적 바탕을 이어받는다');
});
