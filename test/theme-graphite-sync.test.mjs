// 그래파이트 테마 동기화 — **같은 값을 두 곳에 적어야 하는 구조**라 갈림을 테스트로 막는다.
//
// CSS는 "이 토큰 묶음을 두 셀렉터가 공유하라"를 표현할 방법이 없다. 시스템 자동(@media 안)과
// 고정(data-theme)은 서로 다른 블록이어야 해서, 값이 물리적으로 중복된다. 기본 테마(argo)도 같은
// 구조이고 주석으로 "항상 동일하게 유지"라고만 적혀 있다 — 사람 규율이라 언젠가 한쪽만 고쳐진다.
//
// 여기서 잠그는 계약:
//  ① 자동(@media)의 다크 값 == 고정 다크 값
//  ② 자동의 라이트 값 == 고정 라이트 값
// 한쪽만 고치면 red다. 그때 메시지가 어느 쪽이 어긋났는지 짚어준다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

/** 셀렉터 블록의 토큰만 뽑는다(주석·공백 무시) — 순서가 달라도 같은 값이면 같다고 본다. */
function tokens(selector, { inMedia = false } = {}) {
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

test('시스템 자동의 다크 값 == 어둡게 고정 — 한쪽만 고치면 사용자마다 다른 색을 본다', () => {
  const auto = tokens(":root[data-theme='graphite']", { inMedia: true });
  const fixed = tokens(":root[data-theme='graphite-dark']");
  assert.deepEqual(diff(auto, fixed), [],
    '자동(@media)과 고정 다크가 갈렸다 — 시스템 다크 사용자와 수동 선택 사용자가 다른 화면을 본다');
});

test('시스템 자동의 라이트 값 == 밝게 고정', () => {
  const auto = tokens(":root[data-theme='graphite']");   // @media 밖 = 라이트 기본
  const fixed = tokens(":root[data-theme='graphite-light']");
  assert.deepEqual(diff(auto, fixed), [], '자동의 라이트와 고정 라이트가 갈렸다');
});

test('세 갈래가 등록·라벨·색점까지 갖췄다 — 하나라도 빠지면 화면에서 못 고르거나 빈 원이 뜬다', () => {
  // .jsx는 Node가 직접 못 읽는다(다른 트립와이어들과 같은 방식으로 텍스트를 본다).
  const theme = readFileSync(new URL('../app/theme.jsx', import.meta.url), 'utf8');
  const i18n = readFileSync(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  for (const t of ['graphite', 'graphite-light', 'graphite-dark']) {
    assert.match(theme, new RegExp(`'${t}'`), `${t}가 THEMES 목록에 없다 — 화면에서 고를 수 없다`);
    assert.match(i18n, new RegExp(`'settings\\.theme\\.${t}': \\['[^']+', '[^']+'\\]`), `${t} 라벨이 ko·en 둘 다 있어야 한다`);
    assert.match(settings, new RegExp(`'?${t}'?: \\[`), `${t}가 THEME_SWATCHES에 없다 — 칩의 색 점이 빈 원으로 나온다`);
  }
});
