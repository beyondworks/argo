// 리넨 테마 동기화 — 그래파이트와 같은 계약(test/helpers/theme-family.mjs) + 이 가족 고유 불변식 2개.
//  · 옐로는 --mark에만: --accent가 옐로면 Dial·Bars·meter 같은 --accent 소비자가 저대비 계기판이 된다.
//  · 레일은 라이트에서도 차콜: .side 스코프의 배경이 캔버스보다 어둡다(핀 프레임 문법 — 시안 승인 조건).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { themeFamilyTests, tokens } from './helpers/theme-family.mjs';

themeFamilyTests('linen', {
  // 차콜 스코프는 .side와 .msgr-composer(메신저 플로팅 독)가 함께 쓴다 — 앵커는 그 셀렉터 쌍
  sideLight: ":root[data-theme='linen'] .side, :root[data-theme='linen'] .msgr-composer {\n  background: #1f1e1b;",
  sideDark: ":root[data-theme='linen'] .side, :root[data-theme='linen'] .msgr-composer {\n  background: #171614;",
});

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

test('[linen] 옐로는 --mark에만 — --accent는 --primary와 같은 차콜(계기판 소비자 보호)', () => {
  for (const sel of [":root[data-theme='linen']", ":root[data-theme='linen-light']", ":root[data-theme='linen-dark']"]) {
    const t = tokens(css, sel);
    assert.equal(t.get('--accent'), t.get('--primary'), `${sel}: --accent가 --primary와 다르다`);
    assert.match(t.get('--mark') ?? '', /^#(e8e400|f1ee3a)$/, `${sel}: --mark가 형광 옐로가 아니다`);
    assert.notEqual(t.get('--accent'), t.get('--mark'), `${sel}: --accent에 옐로가 들어갔다`);
  }
});

test('[linen] :root 기본값에 --mark 가족이 있다 — 다른 테마에서 .msgr-* 소비자가 빈 값을 읽지 않게', () => {
  const root = tokens(css, ':root');
  for (const k of ['--mark', '--mark-rgb', '--mark-fg', '--mark-wash', '--shadow-float']) assert.ok(root.has(k), `:root에 ${k}가 없다`);
});

test('[linen] 라이트 .side가 캔버스보다 어둡다(차콜 레일) — 세 갈래 전부', () => {
  for (const sel of [":root[data-theme='linen']", ":root[data-theme='linen-light']"]) {
    const esc = sel.replace(/[[\]']/g, (c) => `\\${c}`);
    const m = new RegExp(`${esc} \\.side, ${esc} \\.msgr-composer \\{\\s*background: (#[0-9a-f]{6});`).exec(css);
    assert.ok(m, `${sel} .side 규칙이 없다`);
    assert.equal(m[1], '#1f1e1b', `${sel}: 라이트 레일이 차콜(#1f1e1b)이 아니다`);
  }
});
