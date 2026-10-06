// 블록 편집기 — tiptap(페이지를 열 때만 불러온다). '/' 블록 메뉴, 블록 끌기 손잡이([+] 줄 추가), 마크다운 단축 입력.
// 저장 버튼 없음: 입력이 멈추면(0.8초) 저장한다(P0: 보낼 목록 → Supabase, 최대 5초마다·바뀐 게 없으면 보내지 않음).
// 16차(유건 10/4 "노션 수준"): 토글·콜아웃·표·2열/3열·링크(편집 중에는 ⌘+누르기·말풍선으로 연다)·'->' 화살표·붙여넣기 정리(pages/paste.js).
// 페이지 이름은 본문 첫 줄이 "제목 줄"일 때만 따라간다(pages/page-title.js — 이관 페이지가 처음 고칠 때 이름이 바뀌지 않게).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, Node, ReactNodeViewRenderer, NodeViewWrapper, getMarkRange } from '@tiptap/react';
import { TextSelection, NodeSelection } from '@tiptap/pm/state';
import { Fragment } from '@tiptap/pm/model';
import { DOMSerializer } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extension-placeholder';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { Icon } from '../ui/Icon.jsx';
import { t, registerDict } from '../core/i18n.js';
import { savePage, getState } from '../core/store.js';
import { getClient } from '../core/supabase.js';
import { flushNow, outbox } from '../core/sync.js';
import { canManage } from '../core/session.js';
import { registerEditor } from '../core/page-live.js';
import { openMenu } from '../ui/Menu.jsx';
import { showToast } from '../ui/Overlay.jsx';
import { DocView } from '../ui/DocView.jsx';
import { PageModuleNode } from '../ui/PageModuleNode.jsx';
import { FileRefNode, FilePickModal } from '../files/FileRef.jsx'; // '/파일' 블록 — 문서함 파일을 본문에(유건 10/2)
import { getStorageScope } from '../core/save.js';
import { RedactMark, BlockPick, pickKey, blockRects, redactStatus, setRedact, menuRange, unpick, blockKeys, keysRange } from './block-pick.js';
import { useSelection } from '../core/selection.js';
import { EDITOR_DICT } from './editor-i18n.js';
import { PAGE_EDIT_DICT } from './page-i18n.js';
import { BlockHover, HANDLE_POSITION, measureAnchor, setHover } from './block-handle.js';
import { LINK, Toggle, Callout, Columns, Column, Table, TableRow, TableCell, TableHeader, Arrow, newTable, newColumns, unwrapColumns, normalizeHref } from './page-blocks.js';
import { fixPastedHrefs } from '../core/blocks-model.js';
import { ToggleView, CalloutView, TableBar, LinkPop, openHref } from './editor-blocks.jsx';
import { markHtmlCheckboxes, normalizeSlice, looksMarkdown, markdownSlice, htmlHasBlocks } from './paste.js';
import { titleLinked, nextTitle } from './page-title.js';
import { BLOCKS_DICT } from './blocks-i18n.js';

registerDict({ ...EDITOR_DICT, ...PAGE_EDIT_DICT, ...BLOCKS_DICT });
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
// 토글·콜아웃은 화면 그리기(node view)를 붙여 쓴다 — 스키마는 page-blocks.js 그대로(이관·시험과 같은 스키마)
const ToggleBlock = Toggle.extend({ addNodeView() { return ReactNodeViewRenderer(ToggleView); } });
const CalloutBlock = Callout.extend({ addNodeView() { return ReactNodeViewRenderer(CalloutView); } });
// 여백에서 끌기를 시작하지 않는 자리 — 누를 수 있는 것, 창, 블록 손잡이
/** 고른 블록 복사 — 문서 조각을 HTML·글자로 직접 만든다(원자 블록만 골라도 비지 않게, 분리 검수 M1). 실패하면 false */
async function copySlice(view, from, to) {
  const box = document.createElement('div');
  box.append(DOMSerializer.fromSchema(view.state.schema).serializeFragment(view.state.doc.slice(from, to).content));
  const text = view.state.doc.textBetween(from, to, '\n\n', '\n');
  try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([box.innerHTML], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]); return true; }
  catch { return navigator.clipboard?.writeText(text).then(() => true, () => false) ?? false; }
}
const NO_PICK = 'button, a, input, textarea, select, label, summary, form, [contenteditable], [role=dialog], .menu, .block-handle, .attachments, .doc-meta, .table-bar, .link-pop, .icon-grid';

/** 비공개 블록 자리 — 본문은 office_private_blocks에만 있다. 권한 없는 사람은 데이터 자체를 받지 않고(RLS), 공개 화면은 서버가 이 노드를 뺀다.
 *  ponytail: 비공개인 동안은 읽기 전용 — 고치려면 공개로 되돌려 고친 뒤 다시 비공개로(안쪽 편집기는 필요해지면). */
function PrivateView({ node, editor, getPos, extension }) {
  const { pageId, canEdit } = extension.options;
  const [row, setRow] = useState(undefined);                  // undefined 읽는 중 | null 볼 수 없음 | { content }
  useEffect(() => {
    let live = true;
    getClient().then(async (sb) => {
      if (!sb) { if (live) setRow(null); return; }
      const { data } = await sb.from('office_private_blocks').select('content').eq('page_id', pageId).eq('block_id', node.attrs.id).maybeSingle();
      if (live) setRow(data ?? null);
    }).catch(() => live && setRow(null));
    return () => { live = false; };
  }, [pageId, node.attrs.id]);
  const unhide = () => {
    const pos = getPos();
    editor.chain().focus().insertContentAt({ from: pos, to: pos + node.nodeSize }, row.content).run();
    // 문서 저장이 서버에 닿은 뒤에만 비공개 행을 지운다 — 그 전에 지우면 내용이 어디에도 없게 된다
    setTimeout(async () => {
      await flushNow();
      if (outbox.has(`page:${pageId}`)) return;
      const sb = await getClient();
      await sb?.from('office_private_blocks').delete().eq('page_id', pageId).eq('block_id', node.attrs.id);
    }, 1500);
  };
  return (
    <NodeViewWrapper className="private-block" contentEditable={false}>
      <div className="private-head"><span className="badge"><Icon name="lock" size={12} />{t('block.privateBadge')}</span>
        {row && canEdit && editor.isEditable && <button type="button" className="btn sm ghost" onClick={unhide}>{t('block.unhide')}</button>}</div>
      {row === undefined ? <div className="skeleton-lines"><span /></div>
        : row ? <div className="private-body"><DocView doc={{ content: [row.content] }} /></div>
          : <p className="dim small">{t('block.hidden')}</p>}
    </NodeViewWrapper>
  );
}
const PrivateBlock = Node.create({
  name: 'privateBlock', group: 'block', atom: true, draggable: true, selectable: true,
  addOptions: () => ({ pageId: null, canEdit: false }),
  addAttributes: () => ({ id: { default: null, parseHTML: (el) => el.getAttribute('data-private-block'), renderHTML: (a) => ({ 'data-private-block': a.id }) } }),
  parseHTML: () => [{ tag: 'div[data-private-block]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', HTMLAttributes],
  addNodeView() { return ReactNodeViewRenderer(PrivateView); },
});

// 검색은 영문 별칭(words) + 현재 언어의 블록 이름(t) 둘 다로 맞춘다.
const BLOCKS = [
  { id: 'text', icon: 'text', key: 'block.text', words: 'text p', run: (c) => c.setParagraph() },
  { id: 'h1', icon: 'h1', key: 'block.h1', words: 'h1 heading', run: (c) => c.setHeading({ level: 1 }) },
  { id: 'h2', icon: 'h2', key: 'block.h2', words: 'h2 heading', run: (c) => c.setHeading({ level: 2 }) },
  { id: 'h3', icon: 'h3', key: 'block.h3', words: 'h3 heading', run: (c) => c.setHeading({ level: 3 }) },
  { id: 'bullet', icon: 'bullet', key: 'block.bullet', words: 'bullet list', run: (c) => c.toggleBulletList() },
  { id: 'ordered', icon: 'ordered', key: 'block.ordered', words: 'ordered number', run: (c) => c.toggleOrderedList() },
  { id: 'todo', icon: 'todo', key: 'block.todo', words: 'todo task', run: (c) => c.toggleTaskList() },
  // 토글·콜아웃은 지금 줄을 감싼다(뒤에 있던 글이 첫 줄이 된다). 목록 첫 줄처럼 감쌀 수 없는 자리면 새 블록으로 넣는다
  { id: 'toggle', icon: 'chevron', key: 'block.toggle', words: 'toggle fold details', run: (c) => c.command(({ commands }) => commands.wrapIn('toggle') || commands.insertContent({ type: 'toggle', content: [{ type: 'paragraph' }] })) },
  { id: 'quote', icon: 'quote', key: 'block.quote', words: 'quote', run: (c) => c.toggleBlockquote() },
  { id: 'callout', icon: 'info', key: 'block.callout', words: 'callout note info box', run: (c) => c.command(({ commands }) => commands.wrapIn('callout') || commands.insertContent({ type: 'callout', content: [{ type: 'paragraph' }] })) },
  { id: 'code', icon: 'code', key: 'block.code', words: 'code', run: (c) => c.toggleCodeBlock() },
  { id: 'divider', icon: 'divider', key: 'block.divider', words: 'divider hr', run: (c) => c.setHorizontalRule() },
  { id: 'table', icon: 'layout', key: 'block.table', words: 'table grid', insert: () => newTable() },          // 넣은 뒤 커서는 첫 칸
  { id: 'cols2', icon: 'sidebar', key: 'block.cols2', words: 'columns 2 two col', insert: () => newColumns(2) },
  { id: 'cols3', icon: 'template', key: 'block.cols3', words: 'columns 3 three col', insert: () => newColumns(3) },
  { id: 'file', icon: 'attach', key: 'files.block', words: 'file attach image upload pdf', pick: true }, // 고르는 창을 띄운 뒤 넣는다
];

/** 커서 앞 문단 글자가 '/검색어' 꼴이면 메뉴를 연다 — 입력한 글자가 문서에 그대로 남아 IME(한글)와 충돌하지 않는다. */
function slashQuery(editor) {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== 'paragraph') return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n');
  const m = /^\/([^\s/]{0,20})$/.exec(before);
  return m ? { q: m[1].toLowerCase(), from: $from.start(), to: $from.pos } : null;
}

export default function Editor({ page, canEdit = false, hostRef = null }) {
  // 비공개로 바꾸기는 페이지 전체 권한자만(서버 정책과 같다) — 내 공간은 내 페이지, 조직은 관리자
  const canPrivate = page.space === 'me' || (page.space !== 'shared' && canManage(page.space));
  const handle = useRef(null);
  const wrapRef = useRef(null); // 표 도구·링크 말풍선 자리의 기준(position: relative)
  const [slash, setSlash] = useState(null); // { q, from, to, x, y, idx }
  const slashRef = useRef(null); slashRef.current = slash;
  const timer = useRef(null);
  const pending = useRef(null);
  const linked = useRef(titleLinked(page.content, page.title)); // 첫 줄이 제목 줄인가 — 열 때 한 번 정한다(pages/page-title.js)
  const savePending = () => {
    clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    const current = next && getState().pages.find((entry) => entry.id === next.id);
    // 이름은 저장하는 순간의 이름 — 제목 줄이 아니면 그동안 트리에서 바꾼 이름을 지킨다
    if (current && getStorageScope() === next.owner && current.loadedAt === next.loadedAt) savePage(next.id, { content: next.content, title: next.head ?? current.title });
  };
  const [pick, setPick] = useState(false); // '/파일' 창
  const blocks = page.space === 'shared' ? BLOCKS.filter((b) => !b.pick) : BLOCKS; // 공유받은 페이지는 남의 문서함이라 파일 블록을 넣지 않는다
  const items = useMemo(() => (slash ? blocks.filter((b) => !slash.q || b.words.includes(slash.q) || t(b.key).toLowerCase().includes(slash.q)) : []), [slash]);
  const itemsRef = useRef(items); itemsRef.current = items;

  const apply = (editor, b) => {
    const s = slashRef.current;
    const chain = editor.chain().focus().deleteRange({ from: s.from, to: s.to });
    if (b.pick) { chain.run(); setSlash(null); setPick(true); return; }
    if (b.insert) chain.insertContent(b.insert()).command(({ tr }) => { tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(s.from, tr.doc.content.size)))); return true; }); // 빈 줄 자리에 들어간다 — 커서를 그 블록 첫 글자 자리로
    else b.run(chain);
    chain.run();
    setSlash(null);
  };
  const [ask, setAsk] = useState(null); // ⌘K로 연 링크 넣기 칸의 범위
  // 모르는 블록·표시가 든 문서는 빈 문서로 열지 않고 잠근다 — 예전 판 편집기가 새 블록을 못 읽고 빈 문서를 저장해 본문을 덮던 길(16차 검수 M3).
  // 이 페이지 id를 담는다(같은 편집기가 다른 페이지를 열면 풀린다)
  const broken = useRef(null);
  const ownPaste = useRef(false);

  const editor = useEditor({
    enableContentCheck: true,
    onContentError: () => { broken.current = page.id; },
    extensions: [
      StarterKit.configure({ link: LINK }),
      Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'heading' && node.attrs.level === 1 ? t('page.titlePh') : t('page.placeholder')) }),
      TaskList, TaskItem.configure({ nested: true }), RedactMark, BlockPick, BlockHover,
      PrivateBlock.configure({ pageId: page.id, canEdit: canPrivate }),
      PageModuleNode.configure({ space: page.space, sourceOwner: page.owner ?? null }),
      FileRefNode,
      ToggleBlock, CalloutBlock, Columns, Column, Table, TableRow, TableCell, TableHeader, Arrow,
    ],
    content: page.content,
    editable: canEdit,
    immediatelyRender: true,
    editorProps: {
      attributes: { class: 'prose', spellcheck: 'false' },
      handleTextInput: (view) => !!pickKey.getState(view.state),
      // 붙여넣기: 체크리스트 HTML → 할 일 목록, 구분선 글자 → 구분선, 서식 없는 마크다운 글 → 서식(pages/paste.js)
      // 이 편집기에서 복사한 조각(data-pm-slice)·안에서 끌어 옮긴 블록(view.dragging)은 정리하지 않는다 — 콜아웃 속 '✅ …' 문단이 할 일로 바뀌던 길(16차 검수 M2)
      transformPastedHTML: (html) => { ownPaste.current = /\sdata-pm-slice\b/i.test(html); const h = fixPastedHrefs(html, normalizeHref); return ownPaste.current ? h : markHtmlCheckboxes(h); },
      transformPasted: (slice, view) => (ownPaste.current || view.dragging ? slice : normalizeSlice(slice, view.state.schema)),
      handlePaste: (view, e) => {
        ownPaste.current = false; // 붙여넣기 처리는 조각을 만든 뒤에 불린다 — 다음 붙여넣기(글자만)에 표지가 남지 않게
        const cd = e.clipboardData;
        if (!cd || view.state.selection.$from.parent.type.spec.code || cd.files?.length || htmlHasBlocks(cd.getData('text/html'))) return false;
        const text = cd.getData('text/plain');
        const slice = looksMarkdown(text) && markdownSlice(text, view.state.schema);
        if (!slice) return false;
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
        return true;
      },
      handleDOMEvents: {
        compositionstart: (view) => { // 한글 입력은 키 가로채기로 못 막는다 — 고르기를 풀고 고른 블록 뒤에 쓰게
          const picked = pickKey.getState(view.state);
          if (picked) view.dispatch(unpick(view.state.tr, picked.to));
          return false;
        },
        // 링크: 편집 중에는 눌러도 커서만 놓이고(⌘·Ctrl을 누른 채면 연다), 보기만 할 때는 바로 연다 — 데스크톱 앱은 기본 브라우저로
        click: (view, e) => {
          const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
          if (!a || !view.dom.contains(a) || (view.editable && !(e.metaKey || e.ctrlKey))) return false;
          e.preventDefault();
          openHref(a.getAttribute('href'));
          return true;
        },
      },
      handleKeyDown: (view, e) => {
        const picked = pickKey.getState(view.state); // 고른 블록: 지우기 키는 블록째 지우고, Esc는 고르기를 푼다
        if (picked && (e.key === 'Backspace' || e.key === 'Delete')) { view.dispatch(view.state.tr.delete(picked.from, picked.to)); return true; }
        if (picked && e.key === 'Escape') { view.dispatch(unpick(view.state.tr, picked.to)); return true; }
        if (picked && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') { copySlice(view, picked.from, picked.to).then((ok) => showToast(t(ok ? 'page.copied' : 'page.copyFailed'))); return true; }
        // 고른 블록 위에서 글자·Enter는 무시한다 — 노션처럼 고른 블록이 입력으로 바뀌어 사라지지 않게(분리 검수 M2)
        if (picked && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key.length === 1 || e.key === 'Enter')) return true;
        // ⌘K(글자를 고른 채) = 링크 넣기 칸. 고른 글자가 없으면 원래대로 검색 창(앱 단축키)
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k' && !view.state.selection.empty && view.editable && !e.isComposing) {
          e.preventDefault(); e.stopPropagation();
          setAsk({ from: view.state.selection.from, to: view.state.selection.to });
          return true;
        }
        const s = slashRef.current;
        if (!s) return false;
        const list = itemsRef.current;
        if (e.key === 'ArrowDown') { setSlash({ ...s, idx: (s.idx + 1) % Math.max(1, list.length) }); return true; }
        if (e.key === 'ArrowUp') { setSlash({ ...s, idx: (s.idx - 1 + list.length) % Math.max(1, list.length) }); return true; }
        if (e.key === 'Enter' && !e.isComposing) { if (list[s.idx]) apply(editorRef.current, list[s.idx]); return true; }
        if (e.key === 'Escape') { setSlash(null); return true; }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (!ed.isEditable || broken.current === page.id) return;
      const sq = slashQuery(ed);
      if (sq) { const c = ed.view.coordsAtPos(sq.to); setSlash((cur) => ({ ...sq, x: c.left, y: c.bottom + 6, idx: cur && cur.q === sq.q ? cur.idx : 0 })); } else if (slashRef.current) setSlash(null);
      clearTimeout(timer.current);
      const json = ed.getJSON();
      pending.current = { id: page.id, owner: getStorageScope(), loadedAt: page.loadedAt, content: json, head: nextTitle(json, { linked: linked.current, title: null }) };
      timer.current = setTimeout(savePending, 800);
    },
    onSelectionUpdate: ({ editor: ed }) => { if (slashRef.current && !slashQuery(ed)) setSlash(null); },
  }, [page.id]);
  const editorRef = useRef(null); editorRef.current = editor;
  const locked = broken.current === page.id;
  const editable = canEdit && !locked; // 잠긴 문서는 편집 도구도 숨긴다
  useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);
  useEffect(() => { if (!hostRef) return; hostRef.current = editor; return () => { hostRef.current = null; }; }, [editor, hostRef]); // 페이지가 끌어 놓은 파일을 놓은 자리에 넣는다
  // 열린 편집기를 알린다 — 탭 복귀·다른 창의 저장이 입력 중인 내용을 덮지 않게(core/page-live.js), 트리 '이름 바꾸기'가 제목 줄과 같이 바꾸게
  useEffect(() => {
    if (!editor) return undefined;
    return registerEditor(page.id, {
      dirty: () => !!pending.current,
      rename: (title) => {
        const first = editor.state.doc.firstChild;
        if (linked.current && editor.isEditable && first?.type.name === 'heading') { // 제목 줄 글자를 바꾸면 저장할 때 이름도 그 글자가 된다
          const marks = first.firstChild?.marks;
          editor.chain().command(({ tr }) => { tr.replaceWith(1, 1 + first.content.size, title ? editor.schema.text(title, marks) : Fragment.empty); return true; }).run();
          savePending();
        } else savePage(page.id, { title });
      },
    });
  }, [editor, page.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 비공개로: 내용을 서버 비공개 표에 먼저 저장하고, 저장된 뒤에만 문서 자리를 바꾼다(중간에 실패해도 내용이 사라지지 않는다) */
  const makePrivate = async ({ node, pos }) => {
    const id = crypto.randomUUID().replace(/-/g, '');
    await flushNow();                                           // 새 페이지면 서버에 먼저 있어야 한다(외래 키)
    const sb = await getClient();
    const { error } = sb ? await sb.from('office_private_blocks').insert({ page_id: page.id, block_id: id, content: node.toJSON() }) : { error: true };
    if (error) { showToast(t('block.privateFailed')); return; }
    let at = editor.state.doc.nodeAt(pos) === node ? pos : null;  // 기다리는 사이 문서가 바뀌었으면 같은 블록을 다시 찾는다
    if (at == null) editor.state.doc.descendants((n, p) => { if (at == null && n === node) at = p; return at == null; });
    if (at == null) { await sb.from('office_private_blocks').delete().eq('page_id', page.id).eq('block_id', id); showToast(t('block.privateFailed')); return; }
    editor.chain().focus().insertContentAt({ from: at, to: at + node.nodeSize }, { type: 'privateBlock', attrs: { id } }).run();
  };
  /** 손잡이 기준 상자 — 지금 가리킨 블록의 첫 줄(block-handle.js). 플러그인이 대상을 바꾼 직후에 부른다 */
  const handleAnchor = () => {
    const h = handle.current, view = h?.editor?.view;
    const dom = h?.node && view && !view.isDestroyed ? view.nodeDOM(h.pos) : null;
    return dom instanceof Element ? { getBoundingClientRect: () => measureAnchor(view, h.node, h.pos, dom), contextElement: dom } : null;
  };
  const blockMenu = (e) => {
    const h = handle.current;
    if (!h?.node) return;
    openMenu(e, [
      canPrivate && h.pos > 0 && !['privateBlock', 'moduleGrid'].includes(h.node.type.name) && { label: t('block.private'), icon: 'lock', run: () => makePrivate(h) },
      h.node.type.name === 'columns' && { label: t('block.unwrapCols'), icon: 'sidebar', run: () => editor.chain().focus().insertContentAt({ from: h.pos, to: h.pos + h.node.nodeSize }, unwrapColumns(h.node).map((n) => n.toJSON())).run() },
      { label: t('block.delete'), icon: 'trash', danger: true, run: () => editor.chain().focus().deleteRange({ from: h.pos, to: h.pos + h.node.nodeSize }).run() },
    ].filter(Boolean), { anchor: e.currentTarget });
  };
  /** 손잡이 [+] — 가리킨 블록 아래(⌥·Alt를 누른 채면 위)에 빈 줄을 넣고 커서를 옮긴다 */
  const addLine = (e) => {
    const h = handle.current;
    if (!h?.node) return;
    const at = e.altKey ? h.pos : h.pos + h.node.nodeSize;
    editor.chain().focus().insertContentAt(at, { type: 'paragraph' }).setTextSelection(at + 1).run();
  };
  useEffect(() => () => savePending(), []);
  // 블록 고르기(11차, 유건 10/2) — 끌어 감싸기는 오피스 공용 선택 상자가 맡는다(어디서든 시작, 본문 글자 위면 처음 블록 밖으로 나갈 때 블록 고르기, 자동 스크롤).
  // 여기서는 그 묶음에 붙는다: 고른 블록 = pickKey 범위, 선택 막대 = 가리기·가림 해제·복사·삭제(우클릭 메뉴와 같은 동작). 여백 누름 규칙(글자 선택 막기·누르면 풀기)은 그대로.
  const [range, setRange] = useState(null);
  useEffect(() => {
    if (!editor) return undefined;
    const on = () => { const r = pickKey.getState(editor.state); setRange((p) => (p?.from === r?.from && p?.to === r?.to ? p : r)); };
    editor.on('transaction', on);
    return () => editor.off('transaction', on);
  }, [editor]);
  const live = !!editor && editable && !editor.isDestroyed;
  const pickedKeys = useMemo(() => (live ? blockKeys(editor.state.doc, range) : new Set()), [live, range]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickBlocks = (keys) => {
    const view = editor?.view;
    if (!view || view.isDestroyed) return;
    const cur = pickKey.getState(view.state), next = keys.size ? keysRange(view.state.doc, keys) : null;
    if (cur?.from === next?.from && cur?.to === next?.to) return;
    view.dispatch(next ? view.state.tr.setMeta(pickKey, next) : unpick(view.state.tr, cur.to));
  };
  /** 끌기가 끝나면 고른 블록을 편집기 선택으로도 잡고 초점을 돌려준다 — 원자 블록 하나면 그 블록째(지우기·복사 키가 그 범위에 걸린다) */
  const settlePick = () => {
    const view = editor?.view, r = view && !view.isDestroyed && pickKey.getState(view.state);
    if (!r) return;
    const { doc } = view.state, only = doc.nodeAt(r.from);
    const sel = only?.isAtom && r.from + only.nodeSize === r.to ? NodeSelection.create(doc, r.from) : TextSelection.between(doc.resolve(r.from), doc.resolve(r.to));
    view.dispatch(view.state.tr.setSelection(sel).setMeta(pickKey, r));
    view.focus();
  };
  const rangeActions = (r, done) => { // 고른 범위 → 가리기·가림 해제·복사·삭제(우클릭 메뉴와 선택 막대가 같은 동작)
    const view = editor.view, status = redactStatus(view.state.doc, r.from, r.to);
    const redact = (on) => { view.dispatch(unpick(setRedact(view.state.tr, r.from, r.to, on), r.to)); view.focus(); }; // 메뉴 동작이 끝나면 하이라이트를 남기지 않는다(유건 9/29). 초점을 돌려줘 ⌘Z 한 번에 통째로 되돌린다(선택 막대에서 눌렀을 때)
    const copy = () => { const ok = copySlice(view, r.from, r.to); view.dispatch(unpick(view.state.tr, r.to)); ok.then((x) => showToast(t(x ? 'page.copied' : 'page.copyFailed'))); }; // 복사할 내용은 copySlice가 부르는 즉시 만든다
    return [
      !r.only && !status.all && { label: t('page.redact'), icon: 'eyeOff', run: () => { redact(true); done?.(); } },
      status.any && { label: t('page.unredact'), icon: 'eye', run: () => { redact(false); done?.(); } },
      !r.only && { label: t('page.copy'), icon: 'copy', run: copy },
      !r.only && { label: t(r.picked ? 'block.delete' : 'page.delete'), icon: 'trash', danger: true, run: () => { view.dispatch(view.state.tr.delete(r.from, r.to)); view.focus(); } },
    ];
  };
  useSelection(live ? `page:${page.id}` : null, { value: pickedKeys, onChange: pickBlocks, actions: () => (range ? rangeActions({ ...range, picked: true }) : []),
    boxes: () => blockRects(editor.view).map((b) => ({ key: String(b.from), left: -Infinity, right: Infinity, top: b.rect.top, bottom: b.rect.bottom })), // 같은 높이면 고른다(여백만 훑어도 옆 블록이 골라진다)
    onEnd: settlePick });
  const cleanup = useRef(null);
  useEffect(() => {
    if (!editor || !editable) return;
    const view = editor.view;
    const release = () => {
      const picked = pickKey.getState(view.state);
      if (!picked || view.isDestroyed) return;
      view.dispatch(unpick(view.state.tr, picked.to));
      const dom = getSelection(); if (!view.hasFocus() && dom && view.dom.contains(dom.anchorNode)) dom.removeAllRanges(); // 초점이 없으면 편집기가 화면 선택을 고치지 않아 글자 하이라이트가 남는다
    };
    const onKey = (e) => { if (e.key === 'Escape') release(); }; // 초점이 편집기 밖으로 나간 뒤의 Esc(안에 있을 때는 handleKeyDown이 먼저 푼다)
    const onDown = (e) => {
      const target = e.target;
      if (target instanceof Element && !view.dom.contains(target) && !target.closest('.menu, .sel-bar')) release(); // 사이드바·머리줄·여백 어디를 눌러도 고르기를 푼다 — 메뉴 항목·선택 막대 누름만 예외(유건 9/29)
      if (e.button !== 0 || e.ctrlKey || view.composing || !editor.isEditable || !(target instanceof Element) || !target.closest('.content') || view.dom.contains(target) || target.closest(NO_PICK)) return;
      if (target.clientWidth && e.offsetX > target.clientWidth) return; // 스크롤 막대
      e.preventDefault(); // 여백 끌기가 글자 선택이 되지 않게(편집기 초점도 그대로) — 사각형은 공용 선택 상자
      const start = { x: e.clientX, y: e.clientY };
      const up = (ev) => { // 끌지 않고 여백만 눌렀으면 원래처럼 선택을 풀고 편집기에서 나간다
        stop();
        if (!view.isDestroyed && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) { getSelection()?.removeAllRanges(); view.dom.blur(); }
      };
      const stop = () => { removeEventListener('mouseup', up); cleanup.current = null; };
      cleanup.current = stop;
      addEventListener('mouseup', up);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); cleanup.current?.(); };
  }, [editor, editable]);
  /** 우클릭: 고른 블록이나 선택한 글자를 가리기·해제·복사·삭제. 아무것도 안 고르고 가린 글자 위면 그 가림만 해제 */
  const rangeMenu = (e) => {
    if (!editor?.isEditable) return;
    const { state, view } = editor, pos = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos;
    let at = menuRange(state, { focused: view.hasFocus(), pos }), only = false;
    if (!at) {
      at = pos == null ? null : getMarkRange(state.doc.resolve(pos), state.schema.marks.redact);
      if (!at) return; // 일반 글자 위 — 브라우저 기본 메뉴
      only = true;
    }
    openMenu(e, rangeActions({ ...at, only }));
  };
  // 오른쪽 버튼 누름이 고른 범위를 단어 선택으로 바꾸지 않게(맥 크롬) — 범위가 있을 때만
  const keepRange = (e) => { if (e.button === 2 && editor?.isEditable && menuRange(editor.state, { focused: editor.view.hasFocus(), pos: editor.view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos })) e.preventDefault(); };

  return (
    <div ref={wrapRef} className="editor" onContextMenu={rangeMenu} onMouseDown={keepRange} {...(live ? { 'data-sel-scope': `page:${page.id}`, 'data-sel-blocks': '', 'data-sel-units': '' } : {})}>
      {locked && canEdit && <div className="conflict" role="alert">
        <div><b>{t('page.unknownContent')}</b><p className="dim small">{t('page.unknownHint')}</p></div>
        <div className="row-actions"><button type="button" className="btn primary" onClick={() => location.reload()}>{t('page.reload')}</button></div>
      </div>}
      {editor && editable && (
        <DragHandle editor={editor} className="block-handle has-add" computePositionConfig={HANDLE_POSITION} getReferencedVirtualElement={handleAnchor}
          onNodeChange={(d) => { handle.current = d; setHover(editor.view, null); }} onElementDragStart={() => setHover(editor.view, null)}>
          <span className="block-add" role="button" tabIndex={-1} aria-label={t('block.addBelow', { alt: isMac ? '⌥' : 'Alt' })} title={t('block.addBelow', { alt: isMac ? '⌥' : 'Alt' })}
            draggable={false} onMouseDown={(e) => e.preventDefault()} onClick={addLine}><Icon name="plus" size={14} /></span>
          <span className="block-grip" role="button" tabIndex={-1} aria-label={t('block.menu')} onClick={blockMenu}
            onPointerEnter={(e) => { if (e.pointerType === 'mouse' && handle.current?.node) setHover(editor.view, handle.current.pos); }}
            onPointerLeave={() => setHover(editor.view, null)}><Icon name="grip" size={14} /></span>
        </DragHandle>
      )}
      {locked ? <div className="prose"><DocView doc={page.content} /></div> : <EditorContent editor={editor} />}{/* 잠긴 문서: 편집기는 모르는 내용 때문에 빈 문서라 읽기 화면으로 아는 내용을 보인다 */}
      {live && <><TableBar editor={editor} host={wrapRef} /><LinkPop editor={editor} host={wrapRef} ask={ask} onAsk={setAsk} /></>}
      {slash && (
        <div className="menu slash" role="listbox" style={{ left: Math.min(slash.x, innerWidth - 240), top: Math.min(slash.y, innerHeight - 320) }}>
          {items.length === 0 && <div className="menu-heading">{t('block.none')}</div>}
          {items.map((b, i) => (
            <button key={b.id} type="button" role="option" aria-selected={i === slash.idx} className={`menu-item${i === slash.idx ? ' on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); apply(editor, b); }} onPointerMove={() => setSlash({ ...slash, idx: i })}>
              <span className="menu-ico block-ico" aria-hidden="true"><Icon name={b.icon} size={15} /></span>
              <span className="menu-label">{t(b.key)}</span>
            </button>
          ))}
        </div>
      )}
      {pick && editor && <FilePickModal space={page.space} onClose={() => setPick(false)}
        onPick={({ id, title }) => { setPick(false); editor.chain().focus().insertContent({ type: 'fileRef', attrs: { id, space: page.space, title } }).run(); }} />}
    </div>
  );
}
