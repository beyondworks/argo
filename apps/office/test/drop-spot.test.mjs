// 페이지에 끌어 놓은 파일을 넣을 자리(src/pages/drop-spot.js, 분리 검수 LOW-8) — 실제 ProseMirror 문서·트랜잭션으로 본다.
// 올리는 동안 문서가 바뀌어도(앞에 글을 쓰거나 지우면) 놓은 자리를 따라가고, 범위를 벗어나면 끝에, 편집기가 새로 열리면 끝에.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { blockAfter, dropSpot } from '../src/pages/drop-spot.js';

const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*' }, text: {} } });
const p = (s) => schema.node('paragraph', null, s ? [schema.text(s)] : []);
/** 편집기 대역 — state·on/off·트랜잭션 보내기만(tiptap Editor의 'transaction' 이벤트와 같은 모양) */
function fakeEditor(doc) {
  const handlers = new Set();
  const ed = { isDestroyed: false, state: EditorState.create({ doc }), on: (ev, fn) => ev === 'transaction' && handlers.add(fn), off: (ev, fn) => handlers.delete(fn),
    apply(fn) { const tr = fn(ed.state.tr); ed.state = ed.state.apply(tr); handlers.forEach((h) => h({ editor: ed, transaction: tr })); }, handlers };
  return ed;
}

test('blockAfter: 든 줄의 맨 바깥 블록 끝 — 범위 밖은 문서 끝으로 맞춘다', () => {
  const doc = schema.node('doc', null, [p('하나'), p('둘'), p('셋')]); // 하나=0..4, 둘=4..7, 셋=7..10
  assert.equal(blockAfter(doc, 2), 4);
  assert.equal(blockAfter(doc, 5), 7);
  assert.equal(blockAfter(doc, 999), doc.content.size);
  assert.equal(blockAfter(doc, -5), 0);
});

test('올리는 동안 앞에 글을 쓰면 놓은 자리가 그만큼 뒤로 따라간다 — 지우면 앞으로', () => {
  const ed = fakeEditor(schema.node('doc', null, [p('하나'), p('둘'), p('셋')]));
  const spot = dropSpot(ed, 7); // '둘' 뒤에 놓았다
  ed.apply((tr) => tr.insertText('앞에 쓴 글', 1)); // 맨 앞 문단에 6글자
  assert.equal(spot.place(ed), 13, '둘 뒤(7) + 6');
  assert.equal(ed.state.doc.resolve(spot.place(ed)).nodeBefore.textContent, '둘', '여전히 둘 뒤');
  ed.apply((tr) => tr.delete(0, ed.state.doc.child(0).nodeSize)); // 첫 문단을 통째로 지움
  assert.equal(ed.state.doc.resolve(spot.place(ed)).nodeBefore.textContent, '둘');
  spot.stop();
  assert.equal(ed.handlers.size, 0, '끝나면 따라가기를 뗀다');
});

test('놓은 자리가 사라지거나 범위를 벗어나면 끝, 놓은 자리가 없으면 끝, 편집기가 새로 열리면 끝', () => {
  const ed = fakeEditor(schema.node('doc', null, [p('하나'), p('둘'), p('셋')]));
  const spot = dropSpot(ed, 7);
  ed.apply((tr) => tr.delete(4, ed.state.doc.content.size)); // 둘·셋을 지움 → 자리는 남은 문서 안으로 접힌다
  assert.ok(spot.place(ed) <= ed.state.doc.content.size);
  assert.equal(spot.place(ed), ed.state.doc.content.size);
  spot.moved(999); // 범위 밖
  assert.equal(spot.place(ed), ed.state.doc.content.size);
  const none = dropSpot(ed, null);
  assert.equal(none.place(ed), ed.state.doc.content.size, '자리를 모르면 끝');
  none.stop(); spot.stop();
  const again = fakeEditor(schema.node('doc', null, [p('다시 연 문서'), p('끝 문단')]));
  const s2 = dropSpot(ed, 4);
  assert.equal(s2.place(again), again.state.doc.content.size, '다른 편집기(새로 연 문서)에는 끝에');
  assert.equal(ed.handlers.size, 0); assert.equal(again.handlers.size, 1, '새 편집기를 따라간다');
  again.apply((tr) => tr.insertText('xx', 1));
  s2.moved(4); assert.equal(s2.place(again), again.state.doc.child(0).nodeSize, '그 뒤로는 새 편집기 기준');
  s2.stop(); assert.equal(again.handlers.size, 0);
});

test('없는 편집기(이미 닫힘)로 시작해도 깨지지 않는다', () => {
  const spot = dropSpot({ isDestroyed: true, on() { throw new Error('닫힌 편집기에 붙이지 않는다'); } }, 5);
  const ed = fakeEditor(schema.node('doc', null, [p('a')]));
  assert.equal(spot.place(ed), ed.state.doc.content.size);
  spot.stop();
});
