// 커스텀 테마 — 고른 색 위 글자가 읽히는지(4.5:1), 둥글기·글꼴·투명도가 변수로 나가는지, 첫 페인트 함수가 모드별 값을 입히는지 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildVars, contrast, hex, mix, EMPTY } from '../src/core/custom-theme.js';

// 린넨 라이트의 지금 색(셸·색상이 정한 값)
const LINEN = { bg: [233, 230, 223], card: [251, 250, 247], side: [31, 30, 27], surface: [243, 241, 237], fg: [38, 36, 31], sideFg: [230, 226, 216] };
const c = (x) => ({ ...EMPTY, light: {}, dark: {}, ...x });
const col = (v, k) => hex(v[k]) ?? v[k].match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);

// 이유(유건 9/30 추천안 승인): 글자 색은 고르지 않는다 — 어떤 바탕을 골라도 글자가 4.5:1 이상이어야 한다.
const PICKS = ['#ffffff', '#000000', '#ffe45c', '#1e3a8a', '#f4b8dc', '#808080', '#2d2d2d', '#c62d26', '#e9e6df'];
test('바탕·사이드바·카드를 무엇으로 골라도 그 위 글자는 4.5:1 이상 (배경·카드가 너무 다르면 warn)', () => {
  for (const bg of PICKS) for (const card of PICKS) {
    const { vars, flags } = buildVars(c({}), { bg, card }, LINEN);
    const ink = hex(vars['--fg']);
    const surfaces = [hex(bg), hex(card), mix(hex(card), hex(bg), 0.85)]; // 캔버스 위 --surface(카드 85% 반투명)가 보이는 색
    const worst = Math.min(...surfaces.map((s) => contrast(ink, s)));
    if (bg === card) assert.ok(worst >= 4.5, `같은 색 ${bg}은 늘 읽혀야 한다: ${worst.toFixed(2)}`);
    if (worst < 4.5) assert.match(flags, /warn/, `${bg}/${card}: ${worst.toFixed(2)}인데 경고 없음`);
    else for (const k of ['--fg-2', '--fg-3']) for (const s of surfaces) assert.ok(contrast(hex(vars[k]), s) >= 4.5, `${bg}/${card} ${k}`);
  }
  for (const side of PICKS) {
    const { vars } = buildVars(c({}), { side }, LINEN);
    for (const k of ['--side-fg', '--side-fg-2', '--side-fg-3']) assert.ok(contrast(hex(vars[k]), hex(side)) >= 4.5, `사이드바 ${side} ${k}`);
  }
});

test('강조·배지: 선택된 메뉴 글자와 배지 글자가 그 색 위에서 4.5:1 이상, 호버 위 메뉴 글자도', () => {
  for (const x of PICKS) {
    const { vars, flags } = buildVars(c({}), { accent: x, badge: x }, LINEN);
    assert.match(flags, /accent/);
    assert.ok(contrast(hex(vars['--c-active-fg']), hex(x)) >= 4.5, `강조 ${x}`);
    assert.ok(contrast(hex(vars['--mark-fg']), hex(x)) >= 4.5, `배지 ${x}`);
    const h = +vars['--side-hover'].match(/, ([\d.]+)\)$/)[1];
    assert.ok(h <= 0.3 + 1e-9 && (contrast(LINEN.sideFg, mix(hex(x), LINEN.side, h)) >= 4.5 || h < 0.1), `호버 ${x} ${h}`);
  }
});

test('안 바꾼 것은 덮어쓰지 않는다 — 빈 값은 변수 0개, 지금 글자 색이 읽히면 그대로 둔다', () => {
  assert.deepEqual(buildVars(c({}), {}, LINEN).vars, {});
  const { vars } = buildVars(c({}), { bg: '#f4efe6' }, LINEN);
  assert.equal(vars['--fg'], '#26241f', '린넨 글자 색이 새 바탕에서도 읽히면 그대로');
  assert.equal(vars['--side-bg'], undefined);
});

test('둥글기 0~24px가 모든 둥글기 변수로, 글꼴·투명도', () => {
  const v0 = buildVars(c({ radius: 0 }), {}, LINEN).vars;
  assert.equal(v0['--rs'], '0px'); assert.equal(v0['--t-btn-r'], '0px');
  const v = buildVars(c({ radius: 24, font: 'serif', alpha: 30 }), {}, LINEN).vars;
  assert.equal(v['--rs'], '24px'); assert.equal(v['--rc'], '12px'); assert.equal(v['--t-win-r'], '30px');
  assert.match(v['--font'], /serif$/);
  assert.match(v['--card'], /^rgba\(251, 250, 247, 0\.7\)$/);
  assert.match(v['--side-bg'], /0\.7\)$/);
  assert.equal(buildVars(c({ radius: 99 }), {}, LINEN).vars['--rs'], '24px', '상한');
  assert.equal(buildVars(c({ font: 'pretendard' }), {}, LINEN).vars['--font'], undefined);
});

// 이유: 새로고침·모드 전환 때 커스텀 값이 한 번 빠졌다 들어오면 깜빡인다 — 첫 페인트 스크립트가 모드에 맞는 값을 입혀야 한다.
test('첫 페인트 __argoCustom: 모드별 값을 입히고, 모드가 바뀌면 이전 값을 걷는다', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const body = html.match(/window\.__argoCustom = (function \(\) \{[\s\S]*?\n {8}\});/)[1];
  const store = { 'argo-office-custom-css': JSON.stringify({ light: { '--bg': '#fff', '@flags': 'accent' }, dark: { '--card': '#111' } }) };
  const props = new Map();
  const el = { dataset: { theme: 'linen-light' }, style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } };
  const win = { matchMedia: () => ({ matches: false }) };
  const fn = Function('el', 'localStorage', 'window', `return ${body}`)(el, { getItem: (k) => store[k] ?? null }, win);
  fn();
  assert.deepEqual([...props], [['--bg', '#fff']]); assert.equal(el.dataset.custom, 'accent');
  el.dataset.theme = 'linen-dark'; fn();
  assert.deepEqual([...props], [['--card', '#111']]); assert.equal(el.dataset.custom, undefined);
  el.dataset.theme = 'linen'; win.matchMedia = () => ({ matches: true }); fn();
  assert.deepEqual([...props], [['--card', '#111']], '시스템 모드는 기기 다크 설정을 따른다');
  delete store['argo-office-custom-css']; fn();
  assert.equal(props.size, 0);
});
