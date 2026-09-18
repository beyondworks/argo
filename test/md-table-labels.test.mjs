// 표 칸 라벨(data-label) — 메신저 폰이 한 행을 카드로 풀어 "머리글: 값"으로 보이게 하는 재료(유건 2026-09-17).
import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { labelTableCells } from '../app/md-table.mjs';
marked.setOptions({ breaks: true, gfm: true });
const render = (md) => labelTableCells(marked.parse(md.replace(/</g, '&lt;')));

test('각 칸에 같은 열의 머리글 텍스트가 data-label로 붙는다(태그 제거·정렬 속성 유지)', () => {
  const html = render('| 건 | 마지막 **inbound** | 상대 요구 |\n|:---|---:|---|\n| Vickie | 09-15 | USD 700 |\n| B | c | d |');
  assert.match(html, /<td align="left" data-label="건">Vickie<\/td>/);
  assert.match(html, /<td align="right" data-label="마지막 inbound">09-15<\/td>/);
  assert.match(html, /<td data-label="상대 요구">d<\/td>/);
  assert.equal((html.match(/data-label=/g) || []).length, 6);
});

test('라벨은 속성 밖으로 새지 않는다(따옴표·꺾쇠 이스케이프)', () => {
  const html = render('| a" onmouseover="x | <b>y</b> |\n|---|---|\n| 1 | 2 |');
  assert.doesNotMatch(html, /onmouseover="x/);
  assert.match(html, /data-label="a&quot; onmouseover=&quot;x"/);
  assert.doesNotMatch(html, /data-label="[^"]*<b>/);
});

test('머리글 없는 표·표가 아닌 글은 그대로', () => {
  assert.equal(labelTableCells('<p>hello</p>'), '<p>hello</p>');
  assert.equal(labelTableCells('<table><tbody><tr><td>x</td></tr></tbody></table>'), '<table><tbody><tr><td>x</td></tr></tbody></table>');
});
