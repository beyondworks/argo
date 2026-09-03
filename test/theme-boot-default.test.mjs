// 첫 페인트 기본 테마 — 인라인 부트 스크립트(플래시 방지)와 ThemeProvider 기본값이 갈리면 첫 프레임과 두 번째 프레임이
// 다른 테마로 그려진다(번쩍임). 앱마다 한 쌍씩 잠근다: Argo(layout.jsx ↔ DEFAULT_THEME), 메신저(index.html ↔ main.jsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const theme = read('app/theme.jsx');
const THEMES = [...theme.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
const DEFAULT = /export const DEFAULT_THEME = '([a-z0-9-]+)'/.exec(theme)?.[1];
const bootOf = (src) => /localStorage\.getItem\('argo-theme'\)\|\|'([a-z0-9-]+)'/.exec(src)?.[1];

test('Argo 앱: layout.jsx 부트 폴백 == DEFAULT_THEME, 그리고 THEMES 안', () => {
  const boot = bootOf(read('app/layout.jsx'));
  assert.ok(boot, 'layout.jsx themeBoot에서 폴백을 못 읽었다');
  assert.equal(boot, DEFAULT, 'layout.jsx 폴백과 DEFAULT_THEME이 다르다 — 첫 프레임과 두 번째 프레임의 테마가 갈린다');
  assert.ok(THEMES.includes(DEFAULT), `DEFAULT_THEME(${DEFAULT})이 THEMES에 없다`);
});

test('메신저: index.html 부트 폴백 == main.jsx defaultTheme, 그리고 THEMES 안', () => {
  const boot = bootOf(read('apps/messenger/index.html'));
  const prop = /<ThemeProvider defaultTheme="([a-z0-9-]+)">/.exec(read('apps/messenger/src/main.jsx'))?.[1];
  assert.ok(boot && prop, `부트(${boot}) 또는 defaultTheme(${prop})을 못 읽었다`);
  assert.equal(boot, prop, 'index.html 폴백과 main.jsx defaultTheme이 다르다 — 메신저 첫 페인트가 번쩍인다');
  assert.ok(THEMES.includes(prop), `메신저 기본 테마(${prop})가 THEMES에 없다`);
  assert.equal(prop, 'linen', '메신저 기본 테마는 linen(유건 승인 2026-09-03)');
});

test('ThemeProvider는 defaultTheme prop을 받고, 저장값이 없을 때 그것을 적용한다', () => {
  assert.match(theme, /export function ThemeProvider\(\{ children, defaultTheme = DEFAULT_THEME \}\)/, 'defaultTheme prop 시그니처');
  assert.match(theme, /useState\(defaultTheme\)/, '초기 상태가 defaultTheme이어야 한다');
  assert.match(theme, /else apply\(defaultTheme\)/, '저장값 없을 때 defaultTheme을 apply해야 한다(DEFAULT_THEME 고정이면 메신저가 그래파이트로 켜진다)');
});
