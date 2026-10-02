// 블록 편집기 — tiptap(페이지를 열 때만 불러온다). '/' 블록 메뉴, 블록 끌기 손잡이, 마크다운 단축 입력.
// 저장 버튼 없음: 입력이 멈추면(0.8초) 저장한다(P0: 보낼 목록 → Supabase, 최대 5초마다·바뀐 게 없으면 보내지 않음).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, Node, ReactNodeViewRenderer, NodeViewWrapper, getMarkRange } from '@tiptap/react';
import { TextSelection, NodeSelection } from '@tiptap/pm/state';
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
import { openMenu } from '../ui/Menu.jsx';
import { showToast } from '../ui/Overlay.jsx';
import { DocView } from '../ui/DocView.jsx';
import { PageModuleNode } from '../ui/PageModuleNode.jsx';
import { getStorageScope } from '../core/save.js';
import { RedactMark, BlockPick, pickKey, pickRange, blockRects, redactStatus, setRedact, menuRange, unpick } from './block-pick.js';
import { EDITOR_DICT } from './editor-i18n.js';
import { PAGE_EDIT_DICT } from './page-i18n.js';
import { BlockHover, HANDLE_POSITION, measureAnchor, setHover } from './block-handle.js';

registerDict({ ...EDITOR_DICT, ...PAGE_EDIT_DICT });
// 여백에서 끌기를 시작하지 않는 자리 — 누를 수 있는 것, 창, 블록 손잡이
/** 고른 블록 복사 — 문서 조각을 HTML·글자로 직접 만든다(원자 블록만 골라도 비지 않게, 분리 검수 M1). 실패하면 false */
async function copySlice(view, from, to) {
  const box = document.createElement('div');
  box.append(DOMSerializer.fromSchema(view.state.schema).serializeFragment(view.state.doc.slice(from, to).content));
  const text = view.state.doc.textBetween(from, to, '\n\n', '\n');
  try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([box.innerHTML], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]); return true; }
  catch { return navigator.clipboard?.writeText(text).then(() => true, () => false) ?? false; }
}
const NO_PICK = 'button, a, input, textarea, select, label, summary, [contenteditable], [role=dialog], .menu, .block-handle, .attachments, .doc-meta';

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
  { id: 'text', face: 'T', key: 'block.text', words: 'text p', run: (c) => c.setParagraph() },
  { id: 'h1', face: 'H1', key: 'block.h1', words: 'h1 heading', run: (c) => c.setHeading({ level: 1 }) },
  { id: 'h2', face: 'H2', key: 'block.h2', words: 'h2 heading', run: (c) => c.setHeading({ level: 2 }) },
  { id: 'h3', face: 'H3', key: 'block.h3', words: 'h3 heading', run: (c) => c.setHeading({ level: 3 }) },
  { id: 'bullet', face: '•', key: 'block.bullet', words: 'bullet list', run: (c) => c.toggleBulletList() },
  { id: 'ordered', face: '1.', key: 'block.ordered', words: 'ordered number', run: (c) => c.toggleOrderedList() },
  { id: 'todo', face: '[ ]', key: 'block.todo', words: 'todo task', run: (c) => c.toggleTaskList() },
  { id: 'quote', face: '"', key: 'block.quote', words: 'quote', run: (c) => c.toggleBlockquote() },
  { id: 'code', face: '<>', key: 'block.code', words: 'code', run: (c) => c.toggleCodeBlock() },
  { id: 'divider', face: '—', key: 'block.divider', words: 'divider hr', run: (c) => c.setHorizontalRule() },
];

/** 커서 앞 문단 글자가 '/검색어' 꼴이면 메뉴를 연다 — 입력한 글자가 문서에 그대로 남아 IME(한글)와 충돌하지 않는다. */
function slashQuery(editor) {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== 'paragraph') return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n');
  const m = /^\/([^\s/]{0,20})$/.exec(before);
  return m ? { q: m[1].toLowerCase(), from: $from.start(), to: $from.pos } : null;
}

export default function Editor({ page, canEdit = false }) {
  // 비공개로 바꾸기는 페이지 전체 권한자만(서버 정책과 같다) — 내 공간은 내 페이지, 조직은 관리자
  const canPrivate = page.space === 'me' || (page.space !== 'shared' && canManage(page.space));
  const handle = useRef(null);
  const [slash, setSlash] = useState(null); // { q, from, to, x, y, idx }
  const slashRef = useRef(null); slashRef.current = slash;
  const timer = useRef(null);
  const pending = useRef(null);
  const savePending = () => {
    clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    const current = next && getState().pages.find((entry) => entry.id === next.id);
    if (current && getStorageScope() === next.owner && current.loadedAt === next.loadedAt) savePage(next.id, next.patch);
  };
  const items = useMemo(() => (slash ? BLOCKS.filter((b) => !slash.q || b.words.includes(slash.q) || t(b.key).toLowerCase().includes(slash.q)) : []), [slash]);
  const itemsRef = useRef(items); itemsRef.current = items;

  const apply = (editor, b) => {
    const s = slashRef.current;
    const chain = editor.chain().focus().deleteRange({ from: s.from, to: s.to });
    b.run(chain); chain.run();
    setSlash(null);
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false }),
      Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'heading' && node.attrs.level === 1 ? t('page.titlePh') : t('page.placeholder')) }),
      TaskList, TaskItem.configure({ nested: true }), RedactMark, BlockPick, BlockHover,
      PrivateBlock.configure({ pageId: page.id, canEdit: canPrivate }),
      PageModuleNode.configure({ space: page.space, sourceOwner: page.owner ?? null }),
    ],
    content: page.content,
    editable: canEdit,
    immediatelyRender: true,
    editorProps: {
      attributes: { class: 'prose', spellcheck: 'false' },
      handleTextInput: (view) => !!pickKey.getState(view.state),
      handleDOMEvents: { compositionstart: (view) => { // 한글 입력은 키 가로채기로 못 막는다 — 고르기를 풀고 고른 블록 뒤에 쓰게
        const picked = pickKey.getState(view.state);
        if (picked) view.dispatch(unpick(view.state.tr, picked.to));
        return false;
      } },
      handleKeyDown: (view, e) => {
        const picked = pickKey.getState(view.state); // 고른 블록: 지우기 키는 블록째 지우고, Esc는 고르기를 푼다
        if (picked && (e.key === 'Backspace' || e.key === 'Delete')) { view.dispatch(view.state.tr.delete(picked.from, picked.to)); return true; }
        if (picked && e.key === 'Escape') { view.dispatch(unpick(view.state.tr, picked.to)); return true; }
        if (picked && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') { copySlice(view, picked.from, picked.to).then((ok) => showToast(t(ok ? 'page.copied' : 'page.copyFailed'))); return true; }
        // 고른 블록 위에서 글자·Enter는 무시한다 — 노션처럼 고른 블록이 입력으로 바뀌어 사라지지 않게(분리 검수 M2)
        if (picked && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key.length === 1 || e.key === 'Enter')) return true;
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
      if (!ed.isEditable) return;
      const sq = slashQuery(ed);
      if (sq) { const c = ed.view.coordsAtPos(sq.to); setSlash((cur) => ({ ...sq, x: c.left, y: c.bottom + 6, idx: cur && cur.q === sq.q ? cur.idx : 0 })); } else if (slashRef.current) setSlash(null);
      clearTimeout(timer.current);
      const json = ed.getJSON();
      const first = json.content?.[0];
      const title = first?.type === 'heading' ? (first.content ?? []).map((n) => n.text ?? '').join('') : page.title;
      pending.current = { id: page.id, owner: getStorageScope(), loadedAt: page.loadedAt, patch: { content: json, title } };
      timer.current = setTimeout(savePending, 800);
    },
    onSelectionUpdate: ({ editor: ed }) => { if (slashRef.current && !slashQuery(ed)) setSlash(null); },
  }, [page.id]);
  const editorRef = useRef(null); editorRef.current = editor;
  useEffect(() => { editor?.setEditable(canEdit); }, [editor, canEdit]);

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
      { label: t('block.delete'), icon: 'trash', danger: true, run: () => editor.chain().focus().deleteRange({ from: h.pos, to: h.pos + h.node.nodeSize }).run() },
    ].filter(Boolean), { anchor: e.currentTarget });
  };
  useEffect(() => () => savePending(), []);
  const cleanup = useRef(null);
  // 여백에서 끌어 사각형으로 블록 고르기(마우스만 — 터치 끌기는 스크롤). ponytail: 끄는 도중 화면이 스크롤되면 사각형이 따라가지 않는다 — 긴 문서에서 필요해지면 자동 스크롤을 붙인다.
  useEffect(() => {
    if (!editor || !canEdit) return;
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
      if (target instanceof Element && !view.dom.contains(target) && !target.closest('.menu')) release(); // 사이드바·머리줄·여백 어디를 눌러도 고르기를 푼다 — 메뉴 항목 누름만 예외(유건 9/29)
      if (e.button !== 0 || e.ctrlKey || view.composing || !editor.isEditable || !(target instanceof Element) || !target.closest('.content') || view.dom.contains(target) || target.closest(NO_PICK)) return;
      if (target.clientWidth && e.offsetX > target.clientWidth) return; // 스크롤 막대
      e.preventDefault(); // 여백 끌기가 글자 선택이 되지 않게(편집기 초점도 그대로)
      const start = { x: e.clientX, y: e.clientY };
      let box = null, range = null;
      const move = (ev) => {
        if (!box && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        if (!box) { box = document.createElement('div'); box.className = 'pick-box'; document.body.append(box); }
        const r = { left: Math.min(start.x, ev.clientX), right: Math.max(start.x, ev.clientX), top: Math.min(start.y, ev.clientY), bottom: Math.max(start.y, ev.clientY) };
        Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
        const next = pickRange(blockRects(view), r);
        if (next?.from !== range?.from || next?.to !== range?.to) { range = next; view.dispatch(view.state.tr.setMeta(pickKey, range)); } // 범위가 바뀔 때만
      };
      const up = () => {
        stop();
        if (view.isDestroyed) return;
        if (!box) { getSelection()?.removeAllRanges(); view.dom.blur(); } // 끌지 않고 여백만 눌렀으면 원래처럼 선택을 풀고 편집기에서 나간다
        if (!range) { if (pickKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(pickKey, null)); return; }
        const { doc } = view.state, only = doc.nodeAt(range.from); // 고른 블록을 편집기 선택으로도 잡는다 — 원자 블록 하나면 그 블록째
        const sel = only?.isAtom && range.from + only.nodeSize === range.to ? NodeSelection.create(doc, range.from) : TextSelection.between(doc.resolve(range.from), doc.resolve(range.to));
        view.dispatch(view.state.tr.setSelection(sel).setMeta(pickKey, range));
        view.focus();
      };
      const stop = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); box?.remove(); cleanup.current = null; };
      cleanup.current = stop; // 끄는 도중 편집기가 사라지면 리스너·사각형을 치운다
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); cleanup.current?.(); };
  }, [editor, canEdit]);
  /** 우클릭: 고른 블록이나 선택한 글자를 가리기·해제·복사·삭제. 아무것도 안 고르고 가린 글자 위면 그 가림만 해제 */
  const rangeMenu = (e) => {
    if (!editor?.isEditable) return;
    const { state, view } = editor, pos = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos;
    let range = menuRange(state, { focused: view.hasFocus(), pos }), only = false;
    if (!range) {
      range = pos == null ? null : getMarkRange(state.doc.resolve(pos), state.schema.marks.redact);
      if (!range) return; // 일반 글자 위 — 브라우저 기본 메뉴
      only = true;
    }
    const status = redactStatus(state.doc, range.from, range.to);
    const redact = (on) => view.dispatch(unpick(setRedact(view.state.tr, range.from, range.to, on), range.to)); // 메뉴 동작이 끝나면 하이라이트를 남기지 않는다(유건 9/29)
    const copy = () => { const done = copySlice(view, range.from, range.to); view.dispatch(unpick(view.state.tr, range.to)); done.then((ok) => showToast(t(ok ? 'page.copied' : 'page.copyFailed'))); }; // 복사할 내용은 copySlice가 부르는 즉시 만든다
    openMenu(e, [
      !only && !status.all && { label: t('page.redact'), icon: 'eyeOff', run: () => redact(true) },
      status.any && { label: t('page.unredact'), icon: 'eye', run: () => redact(false) },
      !only && { label: t('page.copy'), icon: 'copy', run: copy },
      !only && { label: t(range.picked ? 'block.delete' : 'page.delete'), icon: 'trash', danger: true, run: () => view.dispatch(view.state.tr.delete(range.from, range.to)) },
    ]);
  };
  // 오른쪽 버튼 누름이 고른 범위를 단어 선택으로 바꾸지 않게(맥 크롬) — 범위가 있을 때만
  const keepRange = (e) => { if (e.button === 2 && editor?.isEditable && menuRange(editor.state, { focused: editor.view.hasFocus(), pos: editor.view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos })) e.preventDefault(); };

  return (
    <div className="editor" onContextMenu={rangeMenu} onMouseDown={keepRange}>
      {editor && canEdit && (
        <DragHandle editor={editor} className="block-handle" computePositionConfig={HANDLE_POSITION} getReferencedVirtualElement={handleAnchor}
          onNodeChange={(d) => { handle.current = d; setHover(editor.view, null); }} onElementDragStart={() => setHover(editor.view, null)}>
          <span className="block-grip" role="button" tabIndex={-1} aria-label={t('block.menu')} onClick={blockMenu}
            onPointerEnter={(e) => { if (e.pointerType === 'mouse' && handle.current?.node) setHover(editor.view, handle.current.pos); }}
            onPointerLeave={() => setHover(editor.view, null)}><Icon name="grip" size={14} /></span>
        </DragHandle>
      )}
      <EditorContent editor={editor} />
      {slash && (
        <div className="menu slash" role="listbox" style={{ left: Math.min(slash.x, innerWidth - 240), top: Math.min(slash.y, innerHeight - 320) }}>
          {items.length === 0 && <div className="menu-heading">{t('block.none')}</div>}
          {items.map((b, i) => (
            <button key={b.id} type="button" role="option" aria-selected={i === slash.idx} className={`menu-item${i === slash.idx ? ' on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); apply(editor, b); }} onPointerMove={() => setSlash({ ...slash, idx: i })}>
              <span className="menu-ico block-ico" aria-hidden="true">{b.face}</span>
              <span className="menu-label">{t(b.key)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
