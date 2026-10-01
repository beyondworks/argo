// 폰 아래 탭 바(유건 결정 2026-10-01 밤): 다섯 탭 모두 같은 크기의 아이콘 원, 선택된 탭은 강조색으로 채운 원만, 이름 글자 없음.
// 이름이 늘어나는 알약은 영어 360 폭에서 'Frie'로 잘렸다 — 바 폭이 언어에 따라 달라지지 않게 구조로 막는다.
// 실제 측정(390·360 × ko·en: 바 넘침 0, 원 48×48 동일, 뱃지 화면 안)은 보고서의 ego-browser 측정이 근거이고, 여기서는 그 결과를 만드는 규칙을 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const tabs = app.slice(app.indexOf('function PhoneTabs('), app.indexOf('function PhoneHead('));
const v2 = css.slice(css.indexOf('폰 셸 v2(유건 확정 2026-10-01)'));
const rule = (sel) => { const i = v2.indexOf(`${sel} {`); assert.ok(i >= 0, `규칙 없음: ${sel}`); return v2.slice(i, v2.indexOf('}', i)); };

test('탭 버튼에는 아이콘과 뱃지만 — 이름 글자는 바에 없고 aria-label·aria-selected가 이름을 말한다', () => {
  assert.ok(tabs.length > 200, 'PhoneTabs를 찾았다');
  assert.doesNotMatch(tabs, /className="lb"/, '이름 글자 칸 없음');
  assert.match(tabs, /aria-selected=\{active === k\}/);
  assert.match(tabs, /aria-label=\{n > 0 \? t\(`phone\.tab\.badge\.\$\{k\}`, \{ tab: label, n: badgeText\(n\) \}\) : label\}/, '뱃지가 있으면 이름 + 숫자를 읽는다');
  assert.match(tabs, /data-tour=\{`tab-\$\{k\}`\}/, '튜토리얼 표지(tab-friends 등)');
});

test('원은 다섯 개 모두 같은 크기(48) — 선택된 탭도 폭·여백을 바꾸지 않고 색만 바꾼다', () => {
  const btn = rule('.msgr-phone .msgr-island button');
  for (const d of ['flex: 0 0 48px', 'width: 48px', 'min-width: 48px', 'height: 48px', 'min-height: 48px', 'padding: 0', 'border-radius: 50%']) assert.ok(btn.includes(d), `탭 원: ${d}`);
  const on = rule('.msgr-phone .msgr-island button.on');
  assert.match(on, /background: var\(--mark\); color: var\(--mark-fg\);/, '선택 = 강조색으로 채운 원');
  assert.doesNotMatch(on, /width|padding|flex/, '선택해도 크기는 그대로');
  assert.doesNotMatch(v2, /msgr-island button[^{]*\.lb/, '이름 칸을 늘리는 옛 규칙 없음');
  assert.doesNotMatch(v2, /transition:[^;]*(max-width|padding)/, '크기 전환 없음(색 전환만)');
});

test('바는 떠 있는 알약 — 폭은 화면에서 정하고(언어 무관) 원은 간격으로만 벌어진다, 동작 줄이기면 전환 없음', () => {
  const isl = rule('.msgr-phone .msgr-island');
  assert.match(isl, /flex: 0 1 360px;/); assert.match(isl, /justify-content: space-between;/); assert.match(isl, /border-radius: 999px;/);
  assert.match(isl, /backdrop-filter: blur\(18px\)/, '표면색 반투명 + 흐림');
  assert.match(v2, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\) \{ \.msgr-phone \.msgr-island \{ background: var\(--card\); \} \}/, '흐림을 못 쓰면 불투명');
  assert.match(v2, /@media \(prefers-reduced-motion: no-preference\) \{\n\s+\.msgr-phone \.msgr-island button \{ transition: background-color/, '전환은 동작 줄이기가 아닐 때만');
  assert.match(rule('.msgr-phone .msgr-tabbar'), /bottom: var\(--ph-bar-gap\);/, '아래 안전 영역 위에 띄운다');
  assert.match(v2, /--ph-bar-gap: max\(10px, env\(safe-area-inset-bottom\)\)/);
});

test('안 읽은 수 — 원 오른쪽 위 잉크 알약(.msgr-badge와 같은 --fg 바탕·--bg 숫자) + 바 표면색 고리', () => {
  const n = rule('.msgr-phone .msgr-island .msgr-tabn');
  assert.match(n, /position: absolute;/); assert.match(n, /background: var\(--fg\); color: var\(--bg\);/); assert.match(n, /box-shadow: 0 0 0 2px var\(--card\);/);
  assert.match(tabs, /\{n > 0 && <span className="msgr-tabn" aria-hidden="true">\{badgeText\(n\)\}<\/span>\}/, '0이면 그리지 않는다, 99+');
});

test('목록 아래 여백 = 바 높이 + 바 아래 간격 — 떠 있는 바가 마지막 줄을 가리지 않는다', () => {
  assert.match(v2, /\.ph-root \.ph-body \{ flex: 1 1 auto; min-height: 0; padding: 2px 0 calc\(var\(--ph-bar\) \+ var\(--ph-bar-gap\) \+ 16px\);/);
  assert.match(v2, /\.msgr-phone \.msgr-main \{ padding-bottom: calc\(var\(--ph-bar\) \+ var\(--ph-bar-gap\) \+ 12px\); \}/, '탭 위에 여는 화면도');
});
