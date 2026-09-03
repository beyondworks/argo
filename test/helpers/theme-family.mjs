// 테마 가족(시스템 자동 / 밝게 고정 / 어둡게 고정) 동기 계약 — 그래파이트에서 뽑아 일반화(2026-09-03, linen 추가 시).
//
// CSS는 "이 토큰 묶음을 두 셀렉터가 공유하라"를 표현할 방법이 없다. 시스템 자동(@media 안)과 고정(data-theme)은
// 서로 다른 블록이어야 해서 값이 물리적으로 중복된다. 사람 규율이라 언젠가 한쪽만 고쳐진다 — 그래서 테스트가 잠근다.
//  ① 자동(@media)의 다크 값 == 고정 다크 값   ② 자동의 라이트 값 == 고정 라이트 값
//  ③ 자동(@media) 블록이 라이트 .side 오버라이드보다 뒤(순서 계약 — @media는 특이도를 안 올린다)
//  ④ 세 갈래가 THEMES·i18n 라벨·THEME_SWATCHES에 등록됐다(하나라도 빠지면 못 고르거나 빈 원)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

/** 셀렉터 블록의 토큰만 뽑는다(주석·공백 무시) — 순서가 달라도 같은 값이면 같다고 본다. */
export function tokens(css, selector, { inMedia = false } = {}) {
  const src = inMedia
    ? (css.match(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?\n\}/g) ?? []).join('\n')
    : css;
  const esc = selector.replace(/[[\]']/g, (c) => `\\${c}`);
  const m = new RegExp(`${esc}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(src);
  assert.ok(m, `블록을 못 찾았다: ${selector}${inMedia ? ' (@media 안)' : ''}`);
  const out = new Map();
  for (const line of m[1].split('\n')) {
    for (const [, k, v] of line.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out.set(k, v.trim());
  }
  assert.ok(out.size > 10, `토큰이 너무 적다(${out.size}) — 파싱이 깨졌을 수 있다: ${selector}`);
  return out;
}

const diff = (a, b) => [...new Set([...a.keys(), ...b.keys()])]
  .filter((k) => a.get(k) !== b.get(k))
  .map((k) => `${k}: ${a.get(k) ?? '(없음)'} ≠ ${b.get(k) ?? '(없음)'}`);

/**
 * @param {string} family  'graphite' | 'linen' …
 * @param {{ sideLight: string, sideDark: string }} anchors  자동 테마의 라이트/다크 .side 규칙 **앞부분**(indexOf로 순서를 잰다)
 */
export function themeFamilyTests(family, { sideLight, sideDark }) {
  const css = read('app/globals.css');
  const auto = `:root[data-theme='${family}']`;

  test(`[${family}] 시스템 자동의 다크 값 == 어둡게 고정 — 한쪽만 고치면 사용자마다 다른 색을 본다`, () => {
    assert.deepEqual(diff(tokens(css, auto, { inMedia: true }), tokens(css, `${auto.slice(0, -2)}-dark']`)), [],
      '자동(@media)과 고정 다크가 갈렸다 — 시스템 다크 사용자와 수동 선택 사용자가 다른 화면을 본다');
  });

  test(`[${family}] 시스템 자동의 라이트 값 == 밝게 고정`, () => {
    assert.deepEqual(diff(tokens(css, auto), tokens(css, `${auto.slice(0, -2)}-light']`)), [], '자동의 라이트와 고정 라이트가 갈렸다');
  });

  test(`[${family}] 자동(@media) 블록이 라이트 .side 오버라이드보다 뒤에 온다 — 앞에 두면 사이드바만 밝게 남는다`, () => {
    // 실측 2026-08-01(그래파이트): 토큰은 다크로 바뀌는데 하드코딩 .side만 라이트 값이 이겨서 남았다. 순서가 곧 계약.
    const light = css.indexOf(sideLight);
    const dark = css.indexOf(sideDark);
    assert.ok(light > 0 && dark > 0, `두 .side 규칙이 모두 있어야 한다(${sideLight} / ${sideDark})`);
    assert.ok(dark > light, '자동(다크) .side 규칙이 라이트보다 앞에 있다 — 시스템 다크에서 사이드바만 밝게 남는다');
  });

  test(`[${family}] 세 갈래가 등록·라벨·색점·패밀리 세그먼트까지 갖췄다`, () => {
    const theme = read('app/theme.jsx');
    const i18n = read('app/i18n.jsx');
    const settings = read('app/c/[ws]/settings/page.jsx');
    for (const t of [family, `${family}-light`, `${family}-dark`]) {
      assert.match(theme, new RegExp(`'${t}'`), `${t}가 THEMES 목록에 없다 — 화면에서 고를 수 없다`);
      assert.match(i18n, new RegExp(`'settings\\.theme\\.${t}': \\['[^']+', '[^']+'\\]`), `${t} 라벨이 ko·en 둘 다 있어야 한다`);
      assert.match(settings, new RegExp(`'?${t}'?: \\[`), `${t}가 THEME_SWATCHES에 없다 — 칩의 색 점이 빈 원으로 나온다`);
    }
    assert.match(settings, new RegExp(`\\['${family}', 'settings\\.family\\.${family}'\\]`), `${family}가 FAMILIES(모드 세그먼트)에 없다 — 라이트/다크 토글이 안 붙는다`);
    assert.match(i18n, new RegExp(`'settings\\.family\\.${family}': \\['[^']+', '[^']+'\\]`), `${family} 패밀리 라벨이 ko·en 둘 다 있어야 한다`);
  });
}
