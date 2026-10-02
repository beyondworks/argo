// 5차 피드백 3(유건 2026-10-02): 세그먼트 토글을 한 컴포넌트로 — 모양은 하나(.msgr-seg), 고르기(radio)·탭(tab) 두 역할만.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { Seg } from '../src/seg.mjs';

test('고르기 — radiogroup·radio·aria-checked, 고른 칸만 active, 칸별 disabled·숫자', () => {
  const html = renderToStaticMarkup(h(Seg, { label: '역할', value: 'b', onPick: () => {}, options: [{ v: 'a', label: 'A' }, { v: 'b', label: 'B', n: 3 }, { v: 'c', label: 'C', disabled: true }] }));
  assert.match(html, /^<div class="msgr-seg" role="radiogroup" aria-label="역할">/);
  assert.equal((html.match(/role="radio"/g) ?? []).length, 3);
  assert.match(html, /aria-checked="true" class="active"[^>]*>B<span class="n">3<\/span>/);
  assert.match(html, /aria-checked="false" disabled=""[^>]*>C</);
  assert.doesNotMatch(html, /aria-selected/);
});

test('탭 — tablist·tab·aria-selected, 추가 클래스는 뒤에 붙는다', () => {
  const html = renderToStaticMarkup(h(Seg, { kind: 'tab', className: 'ph-fm-tabs', label: '친구', value: 'x', onPick: () => {}, options: [{ v: 'x', label: 'X' }, { v: 'y', label: 'Y' }] }));
  assert.match(html, /^<div class="msgr-seg ph-fm-tabs" role="tablist" aria-label="친구">/);
  assert.match(html, /role="tab" aria-selected="true" class="active"/);
  assert.doesNotMatch(html, /aria-checked/);
});

test('앱의 세그먼트는 모두 이 컴포넌트 — 손으로 짠 .msgr-seg 마크업이 남지 않는다', () => {
  const dir = new URL('../src/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => /\.jsx$/.test(x))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /className=\{?["'`]msgr-seg/, `${f}: 손으로 짠 msgr-seg`);
  }
});
