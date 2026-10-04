// 방 밖 에이전트 안내 한 줄(outside-row.mjs) — 버튼 순서와 '한 번 보인 버튼은 같은 크기·자리'를 잠근다.
// 검수 #826: 결과 뒤 버튼을 지우자(N2) 데스크톱에서, 버튼 순서를 바꾸자(NEW-1) 폰 폭에서 [1:1로 시키기]가 그 자리로 와 더블탭 둘째 번이 1:1을 열었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { OutsideRow } from '../src/outside-row.mjs';

const row = (request, o = {}) => renderToStaticMarkup(h(OutsideRow, { text: '페퍼는 이 방에 없어요', dm: '1:1로 시키기', onDm: () => {}, request, requestLabel: '이 방에 추가 요청', onRequest: () => {}, ...o }));
const buttons = (html) => [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map(([, attrs, label]) => ({ attrs, label }));

test('순서는 글 → [1:1로 시키기] → [이 방에 추가 요청], 누를 수 있을 때는 켜져 있다', () => {
  const html = row('on');
  assert.match(html, /^<div class="row"><span class="q">페퍼는 이 방에 없어요<\/span>/);
  const b = buttons(html);
  assert.deepEqual(b.map((x) => x.label), ['1:1로 시키기', '이 방에 추가 요청']);
  assert.doesNotMatch(b[1].attrs, /disabled|aria-hidden|visibility/);
});

test('응답 대기(busy)는 같은 글자로 꺼지고, 결과 뒤(slot)는 같은 글자의 보이지 않는 자리로 남는다 — 크기가 그대로라 옆 버튼이 움직이지 않는다', () => {
  const busy = buttons(row('busy'))[1];
  assert.equal(busy.label, '이 방에 추가 요청', '대기 중 글자를 바꾸면 폭이 줄어 폰에서 줄바꿈이 바뀌었다(NEW-1)');
  assert.match(busy.attrs, /disabled=""/); assert.match(busy.attrs, /aria-busy="true"/); assert.doesNotMatch(busy.attrs, /visibility/);
  const slot = buttons(row('slot'))[1];
  assert.equal(slot.label, '이 방에 추가 요청');
  for (const re of [/disabled=""/, /aria-hidden="true"/, /tabindex="-1"/i, /style="visibility:hidden"/]) assert.match(slot.attrs, re);
  assert.deepEqual(buttons(row('slot')).map((x) => x.label), ['1:1로 시키기', '이 방에 추가 요청'], '자리를 지우지 않는다(N2)');
});

test('처음부터 없는 경우(null: 남의 에이전트·1:1 방)는 요청 버튼을 그리지 않고, onDm이 없으면 [1:1로 시키기]도 없다', () => {
  assert.deepEqual(buttons(row(null)).map((x) => x.label), ['1:1로 시키기']);
  assert.deepEqual(buttons(row('on', { onDm: null })).map((x) => x.label), ['이 방에 추가 요청']);
});

test('Composer는 이 줄을 OutsideRow로 그리고 버튼 상태를 outsideRowView에서 그대로 넘긴다(손으로 짠 버튼으로 되돌리지 않는다)', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /<OutsideRow key=\{c\.id\} text=\{/);
  assert.match(app, /request=\{view\.request\} requestLabel=\{t\('mention\.outside\.request'\)\} onRequest=\{\(\) => requestAdd\(c\)\} \/>/);
  assert.doesNotMatch(app, /className="btn sm ghost"[^>]*requestAdd\(c\)/, '방 밖 안내 버튼을 App.jsx에서 직접 그리지 않는다');
});
