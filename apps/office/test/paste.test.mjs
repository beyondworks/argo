// 편집기 붙여넣기 정리(src/pages/paste.js, 16차 — 인트라넷 workboard-editor 붙여넣기 대응). HTML 표시 바꾸기 → 읽은 문서 조각 정리 → 마크다운 글 변환.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Fragment, Slice } from '@tiptap/pm/model';
import { LINK, PAGE_BLOCKS } from '../src/pages/page-blocks.js';
import { markHtmlCheckboxes, normalizeSlice, looksMarkdown, markdownToNodes, markdownSlice, htmlHasBlocks } from '../src/pages/paste.js';

const schema = getSchema([StarterKit.configure({ link: LINK }), TaskList, TaskItem.configure({ nested: true }), ...PAGE_BLOCKS]);
const node = (json) => schema.nodeFromJSON(json);
const p = (text) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });
const ul = (...items) => ({ type: 'bulletList', content: items.map((x) => ({ type: 'listItem', content: [p(x)] })) });
const slice = (nodes, os = 0, oe = 0) => new Slice(Fragment.fromArray(nodes.map(node)), os, oe);
const types = (s) => s.content.toJSON().map((n) => n.type);

test('HTML 체크 상자 → 글자 표시: input·노션 상자·role=checkbox 칸, 켜짐/꺼짐을 지킨다', () => {
  assert.equal(markHtmlCheckboxes('<ul><li><input type="checkbox" checked> 자료</li><li><input type="checkbox"> 메일</li></ul>'), '<ul><li>[x]  자료</li><li>[ ]  메일</li></ul>');
  assert.equal(markHtmlCheckboxes('<ul class="to-do-list"><li><div class="checkbox checkbox-on"></div> <span>끝</span></li><li><div class="checkbox checkbox-off"></div> 할 것</li></ul>'),
    '<ul class="to-do-list"><li>[x]  <span>끝</span></li><li>[ ]  할 것</li></ul>', '노션 클립보드');
  assert.equal(markHtmlCheckboxes('<ul><li role="checkbox" aria-checked="true">완료</li><li role="checkbox" aria-checked="false">남음</li></ul>'),
    '<ul><li role="checkbox" aria-checked="true">[x] 완료</li><li role="checkbox" aria-checked="false">[ ] 남음</li></ul>', '구글 문서');
  const own = '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>a</p></div></li></ul>';
  assert.equal(markHtmlCheckboxes(own), own, '이 편집기에서 복사한 할 일 목록은 그대로(편집기가 바로 읽는다)');
  assert.equal(markHtmlCheckboxes('<p>평범한 글</p>'), '<p>평범한 글</p>');
  assert.equal(markHtmlCheckboxes('<input type="checkbox" data-checked="true">'), '[ ] ', 'data-checked는 켜짐이 아니다');
});

test('문서 조각 정리: 체크 표시로 시작하는 글머리·번호 목록 → 할 일 목록(켜짐·꺼짐, 표시 글자는 뺀다)', () => {
  const out = normalizeSlice(slice([ul('[x] 자료 준비', '[ ] 후속 메일', '☐ 견적')]), schema);
  const list = out.content.firstChild;
  assert.equal(list.type.name, 'taskList');
  assert.deepEqual(list.content.content.map((li) => [li.attrs.checked, li.textContent]), [[true, '자료 준비'], [false, '후속 메일'], [false, '견적']]);
  assert.equal(normalizeSlice(slice([ul('그냥', '목록')]), schema).content.firstChild.type.name, 'bulletList', '표시 없는 목록은 그대로');
  const nested = normalizeSlice(slice([{ type: 'bulletList', content: [{ type: 'listItem', content: [p('상위'), ul('[x] 안쪽')] }] }]), schema);
  assert.equal(nested.content.firstChild.firstChild.child(1).type.name, 'taskList', '안쪽 목록도 정리한다');
  node({ type: 'doc', content: out.content.toJSON() }).check();
});

test('문서 조각 정리: 체크 표시로 시작하는 문단이 이어지면 할 일 목록 하나로, 구분선 글자만 있는 줄은 구분선', () => {
  const out = normalizeSlice(slice([p('회의'), p('☑ 안건 정리'), p('☐ 자료 공유'), p('───'), p('끝')]), schema);
  assert.deepEqual(types(out), ['paragraph', 'taskList', 'horizontalRule', 'paragraph']);
  assert.deepEqual(out.content.child(1).content.content.map((i) => [i.attrs.checked, i.textContent]), [[true, '안건 정리'], [false, '자료 공유']]);
  const one = normalizeSlice(slice([p('---')], 1, 1), schema);
  assert.deepEqual([types(one), one.openStart, one.openEnd], [['horizontalRule'], 0, 0], '구분선 한 줄만 붙여 넣으면 구분선');
  const edge = normalizeSlice(slice([p('☐ 열린 앞'), p('가운데'), p('☐ 열린 뒤')], 1, 1), schema);
  assert.deepEqual(types(edge), ['paragraph', 'paragraph', 'paragraph'], '열린 조각의 앞뒤 끝 문단은 구조를 바꾸지 않는다(지금 줄에 이어 붙는다)');
  // 가운데 줄이 든 체크 묶음은 끝 줄까지 같이 할 일로 — 예전에는 A만 할 일, B는 '[x] B' 글자로 남아 섞였다(16차 검수 LOW 1). 바꾼 쪽 끝은 닫는다
  const mixed = normalizeSlice(slice([p('제목'), p('[ ] A'), p('[x] B')], 1, 1), schema);
  assert.deepEqual([types(mixed), mixed.openStart, mixed.openEnd], [['paragraph', 'taskList'], 1, 0]);
  assert.deepEqual(mixed.content.child(1).content.content.map((i) => [i.attrs.checked, i.textContent]), [[false, 'A'], [true, 'B']]);
});

test('문서 조각 정리: 스키마가 첫 줄을 정해 둔 블록(토글)은 정리 결과가 맞지 않으면 그대로 둔다', () => {
  // 토글 첫 줄은 문단·제목만 — '✅ 계약'이 할 일 목록이 되면 문서 검사에 걸렸다(16차 검수 LOW 2)
  const toggle = { type: 'toggle', attrs: { open: true }, content: [p('✅ 계약'), p('☐ 둘'), p('☐ 셋')] };
  const out = normalizeSlice(slice([toggle]), schema);
  const fixed = out.content.firstChild;
  assert.equal(fixed.firstChild.type.name, 'paragraph');
  fixed.check();
});

test('마크다운 신호: 줄 머리 표시나 글자 꾸밈이 있을 때만 — 날짜 한 줄·맨 주소·밑줄 든 이름은 아니다', () => {
  for (const s of ['# 제목', '- 하나\n- 둘', '1. 하나\n2. 둘', '- [ ] 할 일', '☐ 할 일', '> 인용', '```\ncode\n```', '---', '| a | b |\n| - | - |', '**굵게** 글', '[링크](https://a.test)']) assert.equal(looksMarkdown(s), true, s);
  for (const s of ['그냥 글입니다', 'https://a.test/x', '10. 4. 회의', '2026. 10. 4 일정', '보고서_최종_본.pdf', 'a * b * c', '', '   ']) assert.equal(looksMarkdown(s), false, s);
});

test('마크다운 → 편집기 문서: 제목·들여쓴 하위 목록·체크·번호 시작값·인용·코드·표·구분선·링크·꾸밈, 편집기 스키마로 열린다', () => {
  const md = '# 계획\n\n- 하나\n  - 하나의 하위\n- 둘\n\n- [x] 끝냄\n- [ ] 남음\n\n3. 셋째\n4. 넷째\n\n> 인용 한 줄\n\n```js\nconst a = 1;\n```\n\n| 단계 | 기한 |\n| --- | --- |\n| 견적 | 1일 |\n\n---\n**굵게** *기울임* ~~취소~~ `코드` [링크](https://a.test) javascript 링크는 [글자](javascript:alert(1))';
  const nodes = markdownToNodes(md);
  assert.deepEqual(nodes.map((n) => n.type), ['heading', 'bulletList', 'taskList', 'orderedList', 'blockquote', 'codeBlock', 'table', 'horizontalRule', 'paragraph']);
  assert.equal(nodes[1].content[0].content[1].type, 'bulletList', '들여 쓴 줄은 앞 항목의 하위 목록');
  assert.deepEqual(nodes[2].content.map((i) => i.attrs.checked), [true, false]);
  assert.deepEqual(nodes[3].attrs, { start: 3 });
  assert.equal(nodes[5].attrs.language, 'js');
  assert.deepEqual(nodes[6].content[0].content.map((c) => c.type), ['tableHeader', 'tableHeader']);
  const last = nodes.at(-1).content;
  assert.deepEqual(last.filter((n) => n.marks).map((n) => n.marks[0].type), ['bold', 'italic', 'strike', 'code', 'link']);
  assert.equal(last.find((n) => n.marks?.[0].type === 'link').marks[0].attrs.href, 'https://a.test');
  assert.ok(last.some((n) => n.text?.includes('글자') && !n.marks), '안전하지 않은 주소는 글자만 남긴다');
  node({ type: 'doc', content: nodes }).check();
});

test('붙여넣기 조각: 앞뒤가 문단이면 열어 둬서 지금 줄에 이어 붙고, 블록이면 닫는다. 블록 구조가 든 HTML은 HTML 경로로', () => {
  const a = markdownSlice('**굵게** 한 줄', schema);
  assert.deepEqual([a.openStart, a.openEnd, a.content.childCount], [1, 1, 1]);
  const b = markdownSlice('- 하나\n- 둘', schema);
  assert.deepEqual([b.openStart, b.openEnd], [0, 0]);
  assert.equal(markdownSlice('', schema), null);
  assert.equal(htmlHasBlocks('<meta charset="utf-8"><div><span># 제목</span></div>'), false, '코드 편집기의 줄 글 HTML은 마크다운 경로');
  assert.equal(htmlHasBlocks('<ul><li>a</li></ul>'), true);
  assert.equal(htmlHasBlocks(''), false);
  // 편집기 안에서 복사한 콜아웃·토글·2열·비공개 블록은 문서 조각 그대로 붙인다 — 마크다운 경로로 가면 상자와 서식이 사라졌다(16차 검수 M2)
  assert.equal(htmlHasBlocks('<div data-pm-slice="1 1 []"><div data-callout="" data-icon="info"><p>✅ 계약서 받음</p><p><strong>다음</strong>: 입금</p></div></div>'), true);
  assert.equal(htmlHasBlocks('<div data-columns=""><div data-column=""><p>*참고*</p></div><div data-column=""><p>b</p></div></div>'), true);
  assert.equal(htmlHasBlocks('<div data-toggle="" data-open="true"><p>1. 하나</p><p>2. 둘</p></div>'), true);
  assert.equal(htmlHasBlocks('<p data-pm-slice="0 0 []">**굵게**</p>'), true);
});
