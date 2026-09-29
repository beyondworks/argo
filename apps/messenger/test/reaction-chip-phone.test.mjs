// 폰 반응 칩은 알약(높이 28px), 누르는 범위만 44px, 내가 누른 반응은 얇은 테두리 색으로만(유건 2026-09-29 "알약 모양이 맞고, 테두리 너무 두꺼울 필요 없어")
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
test('폰 반응 칩 — 44px 최소 크기 목록에서 빠지고, 보이는 칩은 28px 알약·누름 범위는 투명하게 44px', () => {
  const touchList = css.match(/\.argo-messenger :is\(([^)]*)\) \{ min-width: 44px; min-height: 44px;/);
  assert.ok(touchList, '44px 목록이 있다');
  assert.doesNotMatch(touchList[1], /\.msgr-reacts button/, '반응 칩은 44px 원으로 키우지 않는다(#475 이후 원처럼 보였다)');
  assert.match(css, /\.msgr-phone \.msgr-reacts button \{[^}]*height: 28px;/);
  assert.match(css, /\.msgr-phone \.msgr-reacts button::before \{[^}]*inset: -8px -2px;/, '위아래 8px씩 넓혀 누름 범위 44px');
  assert.match(css, /\.msgr-phone \.msgr-reacts button \{[^}]*border-width: \.5px;/, '테두리는 머리카락 선(유건 "더 얇게")');
  assert.match(css, /\.msgr-phone \.msgr-reacts button\.on \{ box-shadow: none; \}/, '겹 테두리 없음, 탁한 바탕(--primary-soft) 없음 — 내 반응은 테두리 색으로만');
});
