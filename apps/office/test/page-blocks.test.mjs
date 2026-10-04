// 16차 편집기 블록(src/pages/page-blocks.js) — 스키마·'->' 화살표·링크 주소·상자 블록 키 동작. 실제 ProseMirror 상태로 본다(편집기 화면 없이).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getSchema } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { inputRules, undoInputRule } from '@tiptap/pm/inputrules';
import { LINK, PAGE_BLOCKS, ARROW, normalizeHref, safeHref, calloutIcon, CALLOUT_ICONS, newTable, newColumns, unwrapColumns, exitEmpty, toggleSummary, toggleFirstRowHeader } from '../src/pages/page-blocks.js';
import { MATERIAL } from '../src/ui/icon-names.js';

const schema = getSchema([StarterKit.configure({ link: LINK }), TaskList, TaskItem.configure({ nested: true }), ...PAGE_BLOCKS]);
const p = (text, marks) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] } : {}) });
const doc = (...blocks) => schema.nodeFromJSON({ type: 'doc', content: blocks });

test('스키마: 새 블록이 편집기 문서로 열리고, 표의 tableRole이 노드 스펙에 있다(prosemirror-tables가 표를 찾는 표시)', () => {
  for (const n of ['toggle', 'callout', 'columns', 'column', 'table', 'tableRow', 'tableCell', 'tableHeader']) assert.ok(schema.nodes[n], n);
  assert.deepEqual(['table', 'tableRow', 'tableCell', 'tableHeader'].map((n) => schema.nodes[n].spec.tableRole), ['table', 'row', 'cell', 'header_cell']);
  doc(newTable(), newColumns(2), newColumns(3), { type: 'toggle', attrs: { open: false }, content: [p('요약'), p('안쪽')] }, { type: 'callout', attrs: { icon: 'star' }, content: [p('알림')] }).check();
  assert.equal(schema.topNodeType.contentMatch.defaultType.name, 'paragraph', '빈 자리를 채우는 기본 블록은 여전히 문단');
  assert.throws(() => doc({ type: 'columns', content: [{ type: 'column', content: [p('하나')] }] }).check(), '칸은 둘 이상');
  assert.throws(() => doc({ type: 'toggle', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [p('x')] }] }] }).check(), '토글 첫 줄은 문단·제목');
  const t = newTable();
  assert.deepEqual(t.content.map((r) => r.content.map((c) => c.type)), [['tableHeader', 'tableHeader', 'tableHeader'], ['tableCell', 'tableCell', 'tableCell'], ['tableCell', 'tableCell', 'tableCell']], '새 표는 3×3, 첫 줄은 머리 행');
});

test('콜아웃 아이콘: 앱 아이콘 글꼴에 있는 이름만, 모르는 값은 안내 — 이모지는 받지 않는다', () => {
  for (const name of CALLOUT_ICONS) assert.ok(name in MATERIAL, name);
  assert.ok(CALLOUT_ICONS.length >= 18);
  assert.deepEqual([calloutIcon('star'), calloutIcon('💡'), calloutIcon(undefined), calloutIcon('<script>')], ['star', 'info', 'info', 'info']);
});

test('링크 주소: http(s)·mailto·tel만, 손으로 친 도메인은 https를 붙이고 javascript: 같은 것은 막는다', () => {
  assert.deepEqual(['naver.com', 'https://a.test/x', 'me@ex.test', 'tel:01012345678', 'javascript:alert(1)', 'data:text/html,x', '그냥 글', ''].map(normalizeHref),
    ['https://naver.com', 'https://a.test/x', 'mailto:me@ex.test', 'tel:01012345678', null, null, null, null]);
  assert.equal(safeHref(' https://a.test '), 'https://a.test');
  assert.equal(safeHref('javascript:alert(1)'), null);
  // 자동 링크는 프로토콜 없는 'naver.com'을 넘긴다 — https를 붙여 허용, 다른 프로토콜은 그대로 막는다(5400 확인 중 찾은 결함, 10/4)
  const allowed = (u) => LINK.isAllowedUri(u, { defaultValidate: () => true, protocols: [], defaultProtocol: 'https' });
  assert.equal(allowed('naver.com'), true);
  assert.equal(allowed('javascript:alert(1)'), false);
  assert.equal(allowed('ftp://a.test'), false);
  assert.deepEqual(LINK.HTMLAttributes, { rel: 'noopener noreferrer nofollow', target: '_blank' }, '링크 속성(새 창·noopener)이 살아 있다');
  const ok = (u) => LINK.isAllowedUri(u, { defaultValidate: () => true });
  assert.deepEqual([ok('https://a.test'), ok('mailto:a@b.c'), ok('javascript:x'), ok('/relative')], [true, true, false, false]);
  assert.equal(LINK.openOnClick, false, '편집 중에는 눌러도 열리지 않는다');
  assert.match(LINK.HTMLAttributes.rel, /noopener/); assert.match(LINK.HTMLAttributes.rel, /noreferrer/);
});

/** '->'를 친 것처럼 — 입력 규칙 플러그인에 글자 하나를 넣어 본다(편집기 화면 없이 ProseMirror 상태만) */
function typeArrow(state) {
  const plugin = inputRules({ rules: [ARROW] });
  let st = EditorState.create({ doc: state.doc, selection: state.selection, plugins: [plugin] });
  const view = { get state() { return st; }, dispatch(tr) { st = st.apply(tr); }, composing: false };
  const { from, to } = st.selection;
  const handled = plugin.props.handleTextInput.call(plugin, view, from, to, '>');
  return { handled, st, view };
}
const at = (d, pos) => EditorState.create({ doc: d, selection: TextSelection.create(d, pos) });

test("'->' 입력: 글 사이에서는 '→'로, 코드 블록·인라인 코드 안에서는 그대로, 바로 지우면 '->'로 되돌린다", () => {
  const d = doc(p('A -'));
  const { handled, st, view } = typeArrow(at(d, 4));
  assert.equal(handled, true);
  assert.equal(st.doc.textContent, 'A →');
  assert.equal(undoInputRule(st, view.dispatch), true, 'Backspace = 되돌리기');
  assert.equal(view.state.doc.textContent, 'A ->');
  const code = doc({ type: 'codeBlock', content: [{ type: 'text', text: 'a -' }] });
  assert.equal(typeArrow(at(code, 4)).handled, false, '코드 블록');
  const inlineCode = doc(p('x -', [{ type: 'code' }]));
  assert.equal(typeArrow(at(inlineCode, 4)).handled, false, '인라인 코드');
});

/** 편집기 대역 — exitEmpty가 쓰는 state·schema·commands.command만 */
function fakeEditor(state) {
  const ed = { state, get schema() { return ed.state.schema; }, commands: { command(fn) { const tr = ed.state.tr; const ok = fn({ tr }); if (ok) ed.state = ed.state.apply(tr); return ok; } } };
  return ed;
}

test('상자 블록: 콜아웃·토글 안 마지막 빈 줄에서 Enter면 그 줄이 상자 밖 바로 뒤로 나온다 — 줄이 하나뿐이거나 가운데 줄이면 그대로', () => {
  const d = doc({ type: 'callout', attrs: { icon: 'info' }, content: [p('알림'), p()] }, p('뒤'));
  const ed = fakeEditor(at(d, 1 + 4 + 1)); // 콜아웃 열기(1) + '알림' 문단(4) + 빈 문단 안(1)
  assert.equal(exitEmpty(ed, 'callout'), true);
  assert.deepEqual(ed.state.doc.toJSON().content.map((n) => n.type), ['callout', 'paragraph', 'paragraph']);
  assert.equal(ed.state.doc.firstChild.childCount, 1, '빈 줄이 콜아웃에서 빠졌다');
  assert.equal(ed.state.selection.$from.parent, ed.state.doc.child(1), '커서는 새 줄에');
  const single = doc({ type: 'callout', attrs: { icon: 'info' }, content: [p()] });
  assert.equal(exitEmpty(fakeEditor(at(single, 2)), 'callout'), false, '빈 줄 하나뿐인 콜아웃은 나오지 않는다(새 줄이 생긴다)');
  const mid = doc({ type: 'toggle', content: [p('요약'), p(), p('끝')] });
  assert.equal(exitEmpty(fakeEditor(at(mid, 1 + 4 + 1)), 'toggle'), false, '마지막 줄이 아니면 그대로');
});

test('토글 첫 줄 판정: 첫 줄(요약)에 커서가 있을 때만 — 안쪽 줄·다른 블록은 아니다', () => {
  const d = doc({ type: 'toggle', attrs: { open: false }, content: [p('요약'), p('안')] }, p('밖'));
  assert.ok(toggleSummary(at(d, 3)));
  assert.equal(toggleSummary(at(d, 3)).toggle.attrs.open, false);
  assert.equal(toggleSummary(at(d, 1 + 4 + 1)), null, '안쪽 줄');
  assert.equal(toggleSummary(at(d, d.content.size - 1)), null, '토글 밖');
});

test('칸 나누기 풀기: 칸의 블록을 차례로 꺼낸다(지우지 않는다)', () => {
  const d = doc({ type: 'columns', content: [{ type: 'column', content: [p('왼쪽')] }, { type: 'column', content: [p('오른쪽 1'), p('오른쪽 2')] }] });
  assert.deepEqual(unwrapColumns(d.firstChild).map((n) => n.textContent), ['왼쪽', '오른쪽 1', '오른쪽 2']);
});

test('표 명령: 이 스키마로 줄·칸 더하기·지우기, 머리 행 끄기, 다음 칸 이동, 열 너비 저장이 된다(prosemirror-tables)', async () => {
  const { addRowAfter, addColumnAfter, deleteRow, deleteColumn, toggleHeaderRow, goToNextCell, tableEditing, columnResizing, TableView, setCellAttr } = await import('@tiptap/pm/tables');
  let st = EditorState.create({ doc: doc(newTable()), plugins: [columnResizing({ View: TableView }), tableEditing()] });
  const run = (cmd) => { let ok = false; cmd(st, (tr) => { st = st.apply(tr); ok = true; }); return ok; };
  st = st.apply(st.tr.setSelection(TextSelection.near(st.doc.resolve(4)))); // 첫 머리 칸 안
  const shape = () => st.doc.firstChild.content.content.map((r) => r.childCount);
  assert.ok(run(addColumnAfter)); assert.deepEqual(shape(), [4, 4, 4]);
  assert.ok(run(addRowAfter)); assert.deepEqual(shape(), [4, 4, 4, 4]);
  assert.equal(st.doc.firstChild.child(1).firstChild.type.name, 'tableCell', '머리 행 아래 새 줄은 보통 칸');
  assert.ok(run(deleteColumn)); assert.deepEqual(shape(), [3, 3, 3, 3]);
  assert.ok(run(toggleHeaderRow)); assert.equal(st.doc.firstChild.firstChild.firstChild.type.name, 'tableCell', '머리 행 끄기');
  assert.ok(run(goToNextCell(1)));
  assert.ok(run(setCellAttr('colwidth', [180])));
  assert.deepEqual(st.doc.firstChild.firstChild.child(1).attrs.colwidth, [180], '열 너비는 칸 attrs로 문서에 남는다(읽기 화면이 같은 너비로 그린다)');
  assert.ok(run(deleteRow)); assert.equal(st.doc.firstChild.childCount, 3);
  st.doc.check();
});

test('머리 행 단추: 커서가 어느 줄에 있든 첫 줄만 켜고 끈다', () => {
  // prosemirror-tables toggleHeaderRow는 커서 줄을 바꿔, 둘째 줄에서 누르면 머리 행이 하나 더 생겼다(16차 검수 LOW 3)
  let st = EditorState.create({ doc: doc(newTable()) });
  const run = (cmd) => { let ok = false; cmd(st, (tr) => { st = st.apply(tr); ok = true; }); return ok; };
  const rows = () => st.doc.firstChild.content.content.map((r) => r.content.content.map((c) => (c.type.name === 'tableHeader' ? 'H' : 'c')).join(''));
  let inRow2 = 0; st.doc.firstChild.child(0).forEach((c) => { inRow2 += c.nodeSize; });
  st = st.apply(st.tr.setSelection(TextSelection.near(st.doc.resolve(1 + 1 + inRow2 + 1 + 1)))); // 둘째 줄 첫 칸 안
  assert.ok(run(toggleFirstRowHeader)); assert.deepEqual(rows(), ['ccc', 'ccc', 'ccc'], '끄기');
  assert.ok(run(toggleFirstRowHeader)); assert.deepEqual(rows(), ['HHH', 'ccc', 'ccc'], '다시 켜기');
  st.doc.check();
});

test('붙여 넣은 HTML 링크 주소: 도메인 모양은 https를 붙이고, 다른 형식은 그대로 둔다(편집기 허용 검사가 거른다)', async () => {
  // 'naver.com'이 앞 형식 없이 저장돼 ⌘+누르기·읽기 화면·보낸 메일에서 깨진 상대 주소가 되었다(16차 검수 LOW 6)
  const { fixPastedHrefs } = await import('../src/core/blocks-model.js');
  assert.equal(fixPastedHrefs('<p><a href="naver.com">네이버</a></p>', normalizeHref), '<p><a href="https://naver.com">네이버</a></p>');
  assert.equal(fixPastedHrefs("<a class='x' href='naver.com/a?b=1'>a</a>", normalizeHref), '<a class=\'x\' href="https://naver.com/a?b=1">a</a>');
  assert.equal(fixPastedHrefs('<a href=naver.com>a</a>', normalizeHref), '<a href="https://naver.com">a</a>');
  assert.equal(fixPastedHrefs('<a href="javascript:alert(1)">a</a>', normalizeHref), '<a href="javascript:alert(1)">a</a>');
  assert.equal(fixPastedHrefs('<a href="https://a.com/?x=1&amp;y=2">a</a>', normalizeHref), '<a href="https://a.com/?x=1&amp;y=2">a</a>');
  assert.equal(fixPastedHrefs('', normalizeHref), '');
  for (const f of ['Editor.jsx', 'MailEditor.jsx']) assert.match(readFileSync(new URL(`../src/pages/${f}`, import.meta.url), 'utf8'), /transformPastedHTML: \(html\) => [^\n]*fixPastedHrefs\(html,/, f);
});

test('자동 링크: 앞 형식 없는 이름.zip·이름.mov(파일 이름 모양)는 링크로 만들지 않는다 — 나머지는 tiptap 기본과 같다', async () => {
  // 'invoice.zip'·'clip.mov'가 https 링크가 되어 공개 화면·보낸 메일에 남의 도메인 링크로 나갔다(16차 검수 LOW 10)
  const { shouldAutoLink } = await import('../src/core/blocks-model.js');
  for (const u of ['invoice.zip', 'clip.mov', 'Report.ZIP']) assert.equal(shouldAutoLink(u), false, u);
  for (const u of ['naver.com', 'claude.ai', 'design.ai', 'naver.com/a.zip', 'https://invoice.zip', 'mailto:a@b.com', 'me@naver.com']) assert.equal(shouldAutoLink(u), true, u);
  for (const u of ['192.168.0.1', 'localhost']) assert.equal(shouldAutoLink(u), false, u);
  assert.equal(LINK.shouldAutoLink, shouldAutoLink);
  assert.match(readFileSync(new URL('../src/pages/MailEditor.jsx', import.meta.url), 'utf8'), /shouldAutoLink,/);
});
