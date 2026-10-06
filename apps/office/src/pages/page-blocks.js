// 페이지 편집기 블록(16차, 유건 10/4 "사용성은 노션 수준") — 토글·콜아웃·표·2열/3열·링크·'->' 화살표.
// 여기는 스키마와 키 동작만 둔다(화면 없음): 편집기(Editor.jsx)가 토글·콜아웃에 그리기(node view)를 붙이고, 이관 변환(scripts/notion-plan.mjs)과
// 시험(test/page-blocks.test.mjs)이 같은 스키마로 문서를 검사한다. 읽기 화면·공개 페이지는 ui/DocView.jsx가 같은 모양(같은 class)으로 그린다.
// 표는 tiptap 표 확장을 새로 설치하지 않고 이미 있는 prosemirror-tables(@tiptap/pm/tables)로 만든다.
import { Node, Extension, mergeAttributes, wrappingInputRule, callOrReturn, getExtensionField } from '@tiptap/react'; // 코어는 react 패키지가 다시 내보낸다
import { TextSelection } from '@tiptap/pm/state';
import { InputRule, inputRules, undoInputRule } from '@tiptap/pm/inputrules';
import { tableEditing, columnResizing, TableView, goToNextCell, addRowAfter, isInTable, findTable } from '@tiptap/pm/tables';
import { SAFE_HREF, calloutIcon, cellSpan, shouldAutoLink } from '../core/blocks-model.js';

export { SAFE_HREF, safeHref, CALLOUT_ICONS, calloutIcon } from '../core/blocks-model.js';

/* ── 링크 ── 편집 중에는 눌러도 열리지 않는다(⌘+누르기·링크 말풍선으로 연다). 주소는 http(s)·mailto·tel만 */
/** 손으로 친 주소 → 열 수 있는 주소. 'naver.com'처럼 앞이 없으면 https://를 붙인다. 못 쓰는 주소는 null */
export function normalizeHref(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (SAFE_HREF.test(s)) return s;
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(s)) return `mailto:${s}`;
  if (/^[a-z][\w+.-]*:/i.test(s)) return null;                                 // javascript: 같은 다른 형식
  return /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(s) ? `https://${s}` : null;
}
export const LINK = {
  openOnClick: false, enableClickSelection: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https', protocols: ['http', 'https', 'mailto', 'tel'], shouldAutoLink,
  isAllowedUri: (url, ctx) => { const u = normalizeHref(url); return !!u && ctx.defaultValidate(u); }, // 자동 링크는 프로토콜 없는 'naver.com'을 넘긴다 — 도메인 모양에만 https를 붙인다(normalizeHref)
  HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
};

/* ── '->' 화살표 ── 코드 블록·인라인 코드 안에서는 바꾸지 않고, 바로 지우면(Backspace) '->'로 되돌린다 */
export const ARROW = new InputRule(/->$/, (state, match, start, end) => {
  const code = state.schema.marks.code;
  const $s = state.doc.resolve(start);
  if ($s.parent.type.spec.code) return null;
  if (code && ((state.storedMarks ?? $s.marks()).some((m) => m.type === code) || state.doc.rangeHasMark(start, Math.min(end, $s.end()), code))) return null;
  return state.tr.insertText('→', start, end);
});
export const Arrow = Extension.create({
  name: 'arrow',
  addProseMirrorPlugins: () => [inputRules({ rules: [ARROW] })],
  addKeyboardShortcuts: () => ({ Backspace: ({ editor }) => undoInputRule(editor.state, editor.view.dispatch) }),
});

/* ── 상자 블록 공용 키 ── */
/** 상자(콜아웃·토글 안쪽)의 마지막 빈 줄에서 Enter → 빈 줄을 상자 밖 바로 뒤로(목록에서 빠져나오는 것과 같다) */
export function exitEmpty(editor, typeName, min = 2) {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== 'paragraph' || $from.parent.content.size || $from.depth < 2) return false;
  const depth = $from.depth - 1, box = $from.node(depth);
  if (box.type.name !== typeName || box.childCount < min || $from.index(depth) !== box.childCount - 1) return false;
  const para = $from.before(), boxEnd = $from.after(depth);
  return editor.commands.command(({ tr }) => {
    tr.delete(para, para + 2);
    const at = boxEnd - 2;
    tr.insert(at, editor.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, at + 1));
    return true;
  });
}
/** 상자의 첫 줄 맨 앞에서 Backspace → 그 줄을 상자 밖으로 꺼낸다 */
function liftAtStart(editor, typeName) {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.depth < 2) return false;
  const box = $from.node(-1);
  if (box.type.name !== typeName || $from.index(-1) !== 0) return false;
  return editor.commands.lift(typeName);
}

/* ── 토글 ── 첫 줄(문단·제목)은 늘 보이고 나머지는 접힌다. 접힘은 문서에 저장한다(attrs.open). 단축 입력은 '>>'+공백('>'+공백은 인용) */
/** 커서가 토글 첫 줄(요약)에 있으면 { toggle, pos, $from } */
export function toggleSummary(state) {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth < 2) return null;
  const toggle = $from.node(-1);
  return toggle.type.name === 'toggle' && $from.index(-1) === 0 ? { toggle, pos: $from.before(-1), $from } : null;
}
export const Toggle = Node.create({
  name: 'toggle', group: 'block', content: '(paragraph | heading) block*', defining: true,
  addAttributes: () => ({ open: { default: true, parseHTML: (el) => el.getAttribute('data-open') !== 'false', renderHTML: (a) => ({ 'data-open': String(a.open !== false) }) } }),
  parseHTML: () => [{ tag: 'div[data-toggle]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-toggle': '', class: 'toggle' }), ['div', { class: 'toggle-content' }, 0]],
  addInputRules() { return [wrappingInputRule({ find: /^>>\s$/, type: this.type })]; },
  addKeyboardShortcuts() {
    return {
      // 요약 끝에서 Enter: 펼쳐져 있으면 안쪽 첫 줄, 접혀 있으면 토글 뒤에 새 줄. 가운데서 나누면 뒷부분이 안쪽 첫 줄이 되니 접혀 있으면 펼친다
      Enter: () => {
        const s = toggleSummary(this.editor.state);
        if (!s) return exitEmpty(this.editor, 'toggle');
        const { toggle, pos, $from } = s, open = toggle.attrs.open !== false;
        if ($from.parentOffset === $from.parent.content.size) {
          const at = open ? pos + 1 + toggle.firstChild.nodeSize : pos + toggle.nodeSize;
          return this.editor.chain().insertContentAt(at, { type: 'paragraph' }).setTextSelection(at + 1).run();
        }
        return this.editor.chain().splitBlock().command(({ tr }) => { if (!open) tr.setNodeMarkup(pos, undefined, { ...toggle.attrs, open: true }); return true; }).run();
      },
      // 요약 맨 앞에서 Backspace: 토글을 풀고 안의 줄을 그대로 둔다
      Backspace: () => {
        const s = toggleSummary(this.editor.state);
        if (!s || s.$from.parentOffset !== 0) return false;
        return this.editor.commands.command(({ tr }) => {
          tr.replaceWith(s.pos, s.pos + s.toggle.nodeSize, s.toggle.content);
          tr.setSelection(TextSelection.near(tr.doc.resolve(s.pos + 1)));
          return true;
        });
      },
      'Mod-Enter': () => { // 요약에서 ⌘Enter = 접기·펼치기(노션과 같다)
        const s = toggleSummary(this.editor.state);
        return !!s && this.editor.commands.command(({ tr }) => { tr.setNodeMarkup(s.pos, undefined, { ...s.toggle.attrs, open: s.toggle.attrs.open === false }); return true; });
      },
    };
  },
});

/* ── 콜아웃 ── 아이콘(앱 아이콘 목록에서, 이모지 아님) + 안쪽 블록. 바탕은 표면색, 색 막대 없음 */
export const Callout = Node.create({
  name: 'callout', group: 'block', content: 'block+', defining: true,
  addAttributes: () => ({ icon: { default: 'info', parseHTML: (el) => calloutIcon(el.getAttribute('data-icon')), renderHTML: (a) => ({ 'data-icon': calloutIcon(a.icon) }) } }),
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'callout' }), ['div', { class: 'callout-body' }, 0]],
  addKeyboardShortcuts() { return { Enter: () => exitEmpty(this.editor, 'callout'), Backspace: () => liftAtStart(this.editor, 'callout') }; },
});

/* ── 2열·3열 ── 칸마다 블록 여러 개. 좁은 화면에서는 위아래로 쌓인다(css) */
export const Columns = Node.create({
  name: 'columns', group: 'block', content: 'column{2,}', isolating: true, defining: true,
  parseHTML: () => [{ tag: 'div[data-columns]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-columns': '', class: 'cols' }), 0],
});
export const Column = Node.create({
  name: 'column', content: 'block+', isolating: true,
  parseHTML: () => [{ tag: 'div[data-column]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-column': '', class: 'col' }), 0],
});
export const newColumns = (n) => ({ type: 'columns', content: Array.from({ length: n }, () => ({ type: 'column', content: [{ type: 'paragraph' }] })) });
/** 칸 나누기 풀기 — 칸들의 블록을 차례로 꺼낸다(지우지 않는다) */
export const unwrapColumns = (node) => node.content.content.flatMap((col) => col.content.content);

/* ── 표 ── 머리 행·열 너비 조절(칸 attrs.colwidth로 문서에 저장)·행/열 추가 삭제는 prosemirror-tables 명령 */
const cellAttrs = () => ({
  colspan: { default: 1, parseHTML: (el) => cellSpan(el.getAttribute('colspan')) },
  rowspan: { default: 1, parseHTML: (el) => cellSpan(el.getAttribute('rowspan')) },
  colwidth: { default: null, parseHTML: (el) => { const w = el.getAttribute('data-colwidth'); const list = w ? w.split(',').map(Number) : null; return list?.every((x) => x > 0) ? list : null; },
    renderHTML: (a) => (a.colwidth ? { 'data-colwidth': a.colwidth.join(',') } : {}) },
});
/** 마지막 칸에서 Tab이면 줄을 하나 더하고 그 칸으로(노션과 같다). 표 밖이면 다른 동작에 넘긴다 */
function tableTab(editor, dir) {
  const { view } = editor;
  if (!isInTable(view.state)) return false;
  if (goToNextCell(dir)(view.state, view.dispatch)) return true;
  if (dir > 0 && addRowAfter(view.state, view.dispatch)) goToNextCell(1)(view.state, view.dispatch);
  return true;
}
export const Table = Node.create({
  name: 'table', group: 'block', content: 'tableRow+', isolating: true, tableRole: 'table',
  parseHTML: () => [{ tag: 'table' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { class: 'tableWrapper' }, ['table', HTMLAttributes, ['tbody', 0]]],
  addProseMirrorPlugins: () => [columnResizing({ handleWidth: 5, cellMinWidth: 64, View: TableView, lastColumnResizable: false }), tableEditing({ allowTableNodeSelection: false })],
  addKeyboardShortcuts() { return { Tab: () => tableTab(this.editor, 1), 'Shift-Tab': () => tableTab(this.editor, -1) }; },
  // prosemirror-tables는 노드 스펙의 tableRole로 표·줄·칸을 찾는다 — tiptap 설정의 tableRole을 스펙으로 옮긴다(모든 노드에 적용)
  extendNodeSchema(extension) { return { tableRole: callOrReturn(getExtensionField(extension, 'tableRole', { name: extension.name, options: extension.options, storage: extension.storage })) }; },
});
export const TableRow = Node.create({ name: 'tableRow', content: '(tableCell | tableHeader)*', tableRole: 'row', parseHTML: () => [{ tag: 'tr' }], renderHTML: ({ HTMLAttributes }) => ['tr', HTMLAttributes, 0] });
export const TableCell = Node.create({ name: 'tableCell', content: 'block+', isolating: true, tableRole: 'cell', addAttributes: cellAttrs, parseHTML: () => [{ tag: 'td' }], renderHTML: ({ HTMLAttributes }) => ['td', HTMLAttributes, 0] });
export const TableHeader = Node.create({ name: 'tableHeader', content: 'block+', isolating: true, tableRole: 'header_cell', addAttributes: cellAttrs, parseHTML: () => [{ tag: 'th' }], renderHTML: ({ HTMLAttributes }) => ['th', HTMLAttributes, 0] });
/** 새 표 — 3×3, 첫 줄은 머리 행 */
/** 머리 행 켜고 끄기 — 커서가 어느 줄에 있든 첫 줄만(prosemirror-tables toggleHeaderRow는 커서 줄을 바꿔 머리 행이 하나 더 생겼다, 16차 검수 LOW 3) */
export function toggleFirstRowHeader(state, dispatch) {
  const table = findTable(state.selection.$from);
  const row = table?.node.firstChild;
  if (!row) return false;
  const { tableCell, tableHeader } = state.schema.nodes;
  const to = row.firstChild?.type === tableHeader ? tableCell : tableHeader;
  if (dispatch) {
    const tr = state.tr;
    let pos = table.pos + 2; // 표 여는 자리 + 첫 줄 여는 자리 = 첫 칸
    row.forEach((cell) => { tr.setNodeMarkup(pos, to, cell.attrs); pos += cell.nodeSize; });
    dispatch(tr);
  }
  return true;
}
export const newTable = (rows = 3, cols = 3) => ({ type: 'table', content: Array.from({ length: rows }, (_, r) => ({ type: 'tableRow',
  content: Array.from({ length: cols }, () => ({ type: r === 0 ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph' }] })) })) });

/** 편집기·이관·시험이 같이 쓰는 새 블록 묶음(링크는 StarterKit 옵션 LINK로) */
export const PAGE_BLOCKS = [Toggle, Callout, Columns, Column, Table, TableRow, TableCell, TableHeader, Arrow];
