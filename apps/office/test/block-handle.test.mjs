import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getSchema } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { EditorState } from '@tiptap/pm/state';
import { firstTextblockPos, firstLine, atomLine, anchorRect, HANDLE_POSITION, hoverPlugin, hoverKey } from '../src/pages/block-handle.js';

const schema = getSchema([StarterKit.configure({ link: false }), TaskList, TaskItem.configure({ nested: true })]);
const node = (json) => schema.nodeFromJSON(json);
const p = (text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });
const center = (r) => r.top + r.height / 2;

// 손잡이는 블록의 첫 줄 가운데에 선다(유건 10/1) — 제목·인용·코드·할 일 목록은 안쪽 첫 글 블록이 첫 줄이다
test('first text block inside a block — itself, or the first one nested inside; atoms have none', () => {
  assert.equal(firstTextblockPos(node(p('a')), 10), 10);
  assert.equal(firstTextblockPos(node({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '제목' }] }), 0), 0);
  assert.equal(firstTextblockPos(node({ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }), 4), 4);
  assert.equal(firstTextblockPos(node({ type: 'blockquote', content: [p('인용'), p('둘째')] }), 7), 8);
  assert.equal(firstTextblockPos(node({ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [p('할 일')] }] }), 3), 5);
  assert.equal(firstTextblockPos(node({ type: 'bulletList', content: [{ type: 'listItem', content: [p('하나')] }] }), 0), 2);
  assert.equal(firstTextblockPos(node({ type: 'horizontalRule' }), 12), null); // 구분선은 글 블록이 없다 — 블록 상자 자체를 쓴다
});

// 9/30 제보: 구분선 손잡이가 선 아래에 매달렸다, 제목·인용·코드에서는 첫 줄보다 위로 떴다
test('first line box sits below border and padding, one line tall', () => {
  const pre = { top: 100, bottom: 160, left: 0, right: 600, width: 600, height: 60 };
  assert.deepEqual(firstLine(pre, { paddingTop: '12px', borderTopWidth: '0px', lineHeight: '21.875px', fontSize: '12.5px' }), { top: 112, height: 21.875 });
  const h1 = { top: 0, bottom: 37.5, left: 0, right: 600, width: 600, height: 37.5 };
  assert.deepEqual(firstLine(h1, { paddingTop: '0px', borderTopWidth: '0px', lineHeight: '37.5px', fontSize: '30px' }), { top: 0, height: 37.5 });
  assert.deepEqual(firstLine(h1, { paddingTop: '0px', lineHeight: 'normal', fontSize: '20px' }), { top: 0, height: 24 }); // 'normal'이면 글자 크기 × 1.2
});

test('atoms: header line when present, whole block when one line tall, else the top line only', () => {
  const hr = { top: 50, bottom: 76, height: 26 };
  assert.deepEqual(atomLine(hr), { top: 50, height: 26 }); // 구분선 = 한 줄 높이 띠, 손잡이는 선(띠 가운데)에
  assert.deepEqual(atomLine({ top: 0, bottom: 300, height: 300 }, { top: 0, height: 42 }), { top: 0, height: 42 }); // 모듈·비공개 = 머리줄
  assert.deepEqual(atomLine({ top: 0, bottom: 300, height: 300 }), { top: 0, height: 26 }); // 머리줄이 없는 큰 블록이 가운데(150px)에 손잡이를 띄우지 않게
});

test('anchor rect: horizontal extent of the block, vertical extent of the line — handle centers on the line', () => {
  const block = { top: 100, bottom: 160, left: 40, right: 640, width: 600, height: 60 };
  const r = anchorRect(block, { top: 112, height: 21.875 });
  assert.equal(r.left, 40); assert.equal(r.x, 40); assert.equal(r.width, 600);
  assert.equal(center(r), 112 + 21.875 / 2);
  assert.equal(HANDLE_POSITION.placement, 'left'); // left = 기준 상자의 세로 가운데. left-start(옛 기본값)는 위쪽 끝에 붙어 선 아래로 매달렸다
  assert.ok(Object.isFrozen(HANDLE_POSITION)); // 렌더마다 새 객체면 손잡이 플러그인이 다시 등록된다
});

// 손잡이에 마우스를 올리면 무엇이 움직이는지 보이게 대상 블록을 옅게 칠한다(유건 10/1)
test('hover paint follows the handle and clears when the document changes', () => {
  const doc = schema.nodeFromJSON({ type: 'doc', content: [p('하나'), { type: 'horizontalRule' }, p('셋')] });
  const plugin = hoverPlugin();
  const paint = (st) => plugin.spec.props.decorations(st);
  let state = EditorState.create({ doc, plugins: [plugin] });
  const hrPos = doc.child(0).nodeSize;
  state = state.apply(state.tr.setMeta(hoverKey, hrPos));
  const deco = paint(state).find();
  assert.equal(deco.length, 1);
  assert.deepEqual([deco[0].from, deco[0].to, deco[0].type.attrs.class], [hrPos, hrPos + 1, 'block-hover']);
  state = state.apply(state.tr.setSelection(state.selection)); // 문서가 그대로면 남는다
  assert.equal(hoverKey.getState(state), hrPos);
  state = state.apply(state.tr.insertText('x', 1)); // 문서가 바뀌면 지운다
  assert.equal(hoverKey.getState(state), null);
  assert.equal(paint(state), null);
});

// 슬래시 메뉴 아이콘 칸: '[ ]'가 두 줄로 꺾였다(.menu-ico 16px이 22px을 덮음, 9/30 제보). 외곽선은 빼고 면으로(유건 9/30)
test('slash menu icon cell is a fixed 22x22 one-line chip without an outline; divider is a line-tall band', () => {
  const css = readFileSync(new URL('../src/base.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => css.split('\n').find((l) => l.startsWith(`${sel} {`)) ?? '';
  const ico = rule('.menu .block-ico');
  for (const d of ['width: 22px', 'height: 22px', 'white-space: nowrap', 'flex: none', 'background: var(--wash)']) assert.ok(ico.includes(d), `${d} in ${ico}`);
  assert.doesNotMatch(ico, /box-shadow|border:/);
  const hr = rule('.prose hr');
  assert.match(hr, /height: 2[4-6]px/);
  assert.doesNotMatch(hr, /border-top/); // 선을 테두리로 그리면 상자 높이가 1px — 손잡이도, 마우스 감지도 1px에 묶인다
});
