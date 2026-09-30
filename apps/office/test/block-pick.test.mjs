import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { pickRange, redactStatus, setRedact, RedactMark, pickPlugin, pickKey, menuRange, unpick } from '../src/pages/block-pick.js';

const schema = getSchema([StarterKit.configure({ link: false }), RedactMark]);
const doc = (...blocks) => schema.nodeFromJSON({ type: 'doc', content: blocks });
const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const code = (text) => ({ type: 'codeBlock', content: [{ type: 'text', text }] });
const box = (top, bottom) => ({ top, bottom, left: 0, right: 500 });

// 노션처럼 여백에서 끌어 그린 사각형에 걸친 블록만 고른다(유건 9/29)
test('drag box picks the blocks at its height, from the first to the last', () => {
  const blocks = [{ from: 0, to: 5, rect: box(0, 20) }, { from: 5, to: 9, rect: box(30, 50) }, { from: 9, to: 14, rect: box(60, 80) }];
  assert.deepEqual(pickRange(blocks, box(40, 70)), { from: 5, to: 14 });
  assert.deepEqual(pickRange(blocks, box(0, 100)), { from: 0, to: 14 });
  assert.equal(pickRange(blocks, box(21, 29)), null); // 블록 사이 빈틈만 스치면 아무것도 고르지 않는다
  assert.deepEqual(pickRange(blocks, { top: 35, bottom: 45, left: 600, right: 700 }), { from: 5, to: 9 }); // 여백에서만 끌어도 같은 높이의 블록을 고른다(9/29 실측: 여백 끌기가 블록에 닿지 않아 아무것도 안 골라졌다)
});

// 가림은 문서에 표시로 저장된다 — 공유받은 사람도 가려진 채로 본다. 코드 블록처럼 표시를 못 받는 곳은 건너뛴다
test('redact marks only the chosen range and reports whether it is fully hidden', () => {
  const d = doc(p('계좌 123-456'), p('평범한 문장'), code('SECRET=1'));
  let state = EditorState.create({ schema, doc: d });
  const second = d.child(0).nodeSize, all = d.content.size;
  assert.deepEqual(redactStatus(state.doc, 0, all), { any: false, all: false });
  state = state.apply(setRedact(state.tr, 0, second, true));
  assert.deepEqual(redactStatus(state.doc, 0, second), { any: true, all: true });
  assert.deepEqual(redactStatus(state.doc, 0, all), { any: true, all: false });
  const json = state.doc.toJSON();
  assert.deepEqual(json.content[0].content[0].marks, [{ type: 'redact' }]);
  assert.equal(json.content[1].content[0].marks, undefined);
  state = state.apply(setRedact(state.tr, 0, all, true));
  assert.equal(state.doc.toJSON().content[2].content[0].marks, undefined); // 코드 블록은 그대로
  assert.deepEqual(redactStatus(state.doc, 0, all), { any: true, all: true }); // 표시를 못 받는 글자는 판정에서 뺀다
  state = state.apply(setRedact(state.tr, 0, all, false));
  assert.deepEqual(redactStatus(state.doc, 0, all), { any: false, all: false });
});

// 고른 블록은 다른 곳을 누르거나 문서가 바뀌면 풀린다
test('picked blocks survive unrelated transactions and clear on a new selection or edit', () => {
  const d = doc(p('하나'), p('둘'), p('셋'));
  let state = EditorState.create({ schema, doc: d, plugins: [pickPlugin()] });
  state = state.apply(state.tr.setMeta(pickKey, { from: 0, to: 9 }));
  assert.deepEqual(pickKey.getState(state), { from: 0, to: 9 });
  state = state.apply(state.tr.setMeta('unrelated', true));
  assert.deepEqual(pickKey.getState(state), { from: 0, to: 9 });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 5))); // 처음 커서(1)와 다른 자리
  assert.equal(pickKey.getState(state), null);
  state = state.apply(state.tr.setMeta(pickKey, { from: 0, to: 9 }));
  state = state.apply(state.tr.insertText('x', 1));
  assert.equal(pickKey.getState(state), null);
});

// 공유받은 사람·공개 화면(DocView)도 가린 글자를 가린 채로 그린다 — 보기는 누르고 있는 동안만(base.css :active)
test('read-only document view keeps hidden text hidden', async () => {
  const { readFileSync } = await import('node:fs');
  const { transformSync } = await import('esbuild');
  const { createRequire } = await import('node:module');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const code = transformSync(readFileSync(new URL('../src/ui/DocView.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(createRequire(import.meta.url), module, module.exports);
  const html = renderToStaticMarkup(createElement(module.exports.DocView, { doc: { content: [{ type: 'paragraph', content: [{ type: 'text', text: '계좌 ' }, { type: 'text', text: '110-123', marks: [{ type: 'redact' }] }] }] } }));
  assert.equal(html, '<p>계좌 <span data-redact="" class="redact-text">110-123</span></p>');
});

// 분리 검수 H1: 편집기가 초점을 잃으면 화면에서 선택이 사라져도 내부 선택은 남는다 — 그 보이지 않는 선택에 가리기·삭제가 걸리면 안 된다.
// 메뉴 범위는 초점이 있을 때의 선택·고른 블록이고, 우클릭한 자리가 그 범위 안일 때만 쓴다
test('menu range is the live selection or picked blocks, only when the right-click lands inside it', () => {
  const d = doc(p('첫째 문장'), p('둘째 문장'), p('셋째 문장'));
  let state = EditorState.create({ schema, doc: d, plugins: [pickPlugin()] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 4)));
  assert.equal(menuRange(state, { focused: false, pos: 2 }), null, '초점이 없으면 남은 선택을 쓰지 않는다');
  assert.deepEqual(menuRange(state, { focused: true, pos: 2 }), { from: 1, to: 4, picked: false });
  assert.equal(menuRange(state, { focused: true, pos: 12 }), null, '선택 밖을 우클릭하면 그 선택이 아니다');
  const second = d.child(0).nodeSize;
  state = state.apply(state.tr.setMeta(pickKey, { from: second, to: second + d.child(1).nodeSize }));
  assert.deepEqual(menuRange(state, { focused: false, pos: second + 2 }), { from: second, to: second + d.child(1).nodeSize, picked: true }, '고른 블록은 파랗게 보이므로 초점과 상관없이 쓴다');
  assert.equal(menuRange(state, { focused: true, pos: 2 }), null, '고른 블록 밖');
});

// 고르기를 풀면 파란 칸도, 그 밑에 깔린 글자 선택도 남지 않는다(유건 9/29: "하고 나면 하이라이트 남는 게 거슬려")
test('unpick clears the pick and collapses the text selection behind it', () => {
  const d = doc(p('계좌 123-456'), p('평범한 문장'));
  let state = EditorState.create({ schema, doc: d, plugins: [pickPlugin()] });
  const range = { from: 0, to: d.content.size };
  state = state.apply(state.tr.setSelection(TextSelection.between(state.doc.resolve(1), state.doc.resolve(d.content.size - 1))).setMeta(pickKey, range));
  assert.deepEqual(pickKey.getState(state), range);
  state = state.apply(unpick(state.tr, range.to));
  assert.equal(pickKey.getState(state), null);
  assert.equal(state.selection.empty, true);
  // 가리기처럼 문서를 바꾼 같은 트랜잭션에서도 푼다(예전에는 가린 뒤에도 파란 칸을 일부러 남겼다)
  state = state.apply(state.tr.setMeta(pickKey, range));
  state = state.apply(unpick(setRedact(state.tr, range.from, range.to, true), range.to));
  assert.equal(pickKey.getState(state), null);
  assert.equal(state.selection.empty, true);
  assert.deepEqual(redactStatus(state.doc, range.from, range.to), { any: true, all: true });
});
