// 블록 편집기 — tiptap(페이지를 열 때만 불러온다). '/' 블록 메뉴, 블록 끌기 손잡이, 마크다운 단축 입력.
// 저장 버튼 없음: 입력이 멈추면(0.8초) 저장한다(P0: 보낼 목록 → Supabase, 최대 5초마다·바뀐 게 없으면 보내지 않음).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, Node, ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extension-placeholder';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { Icon } from '../ui/Icon.jsx';
import { t } from '../core/i18n.js';
import { savePage, getState } from '../core/store.js';
import { getClient } from '../core/supabase.js';
import { flushNow, outbox } from '../core/sync.js';
import { canManage } from '../core/session.js';
import { openMenu } from '../ui/Menu.jsx';
import { showToast } from '../ui/Overlay.jsx';
import { DocView } from './Misc.jsx';
import { PageModuleNode } from '../ui/PageModuleNode.jsx';
import { getStorageScope } from '../core/save.js';

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
  { id: 'text', key: 'block.text', words: 'text p', run: (c) => c.setParagraph() },
  { id: 'h1', key: 'block.h1', words: 'h1 heading', run: (c) => c.setHeading({ level: 1 }) },
  { id: 'h2', key: 'block.h2', words: 'h2 heading', run: (c) => c.setHeading({ level: 2 }) },
  { id: 'h3', key: 'block.h3', words: 'h3 heading', run: (c) => c.setHeading({ level: 3 }) },
  { id: 'bullet', key: 'block.bullet', words: 'bullet list', run: (c) => c.toggleBulletList() },
  { id: 'ordered', key: 'block.ordered', words: 'ordered number', run: (c) => c.toggleOrderedList() },
  { id: 'todo', key: 'block.todo', words: 'todo task', run: (c) => c.toggleTaskList() },
  { id: 'quote', key: 'block.quote', words: 'quote', run: (c) => c.toggleBlockquote() },
  { id: 'code', key: 'block.code', words: 'code', run: (c) => c.toggleCodeBlock() },
  { id: 'divider', key: 'block.divider', words: 'divider hr', run: (c) => c.setHorizontalRule() },
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
      TaskList, TaskItem.configure({ nested: true }),
      PrivateBlock.configure({ pageId: page.id, canEdit: canPrivate }),
      PageModuleNode.configure({ space: page.space, sourceOwner: page.owner ?? null }),
    ],
    content: page.content,
    editable: canEdit,
    immediatelyRender: true,
    editorProps: {
      attributes: { class: 'prose', spellcheck: 'false' },
      handleKeyDown: (view, e) => {
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
  const blockMenu = (e) => {
    const h = handle.current;
    if (!h?.node) return;
    openMenu(e, [
      canPrivate && h.pos > 0 && !['privateBlock', 'moduleGrid'].includes(h.node.type.name) && { label: t('block.private'), icon: 'lock', run: () => makePrivate(h) },
      { label: t('block.delete'), icon: 'trash', danger: true, run: () => editor.chain().focus().deleteRange({ from: h.pos, to: h.pos + h.node.nodeSize }).run() },
    ].filter(Boolean), { anchor: e.currentTarget });
  };
  useEffect(() => () => savePending(), []);

  return (
    <div className="editor">
      {editor && canEdit && <DragHandle editor={editor} className="block-handle" onNodeChange={(d) => { handle.current = d; }}><span className="block-grip" role="button" tabIndex={-1} aria-label={t('block.menu')} onClick={blockMenu}><Icon name="grip" size={14} /></span></DragHandle>}
      <EditorContent editor={editor} />
      {slash && (
        <div className="menu slash" role="listbox" style={{ left: Math.min(slash.x, innerWidth - 240), top: Math.min(slash.y, innerHeight - 320) }}>
          {items.length === 0 && <div className="menu-heading">{t('block.none')}</div>}
          {items.map((b, i) => (
            <button key={b.id} type="button" role="option" aria-selected={i === slash.idx} className={`menu-item${i === slash.idx ? ' on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); apply(editor, b); }} onPointerMove={() => setSlash({ ...slash, idx: i })}>
              <span className="menu-ico block-ico">{b.id === 'text' ? 'T' : b.id.startsWith('h') && b.id.length === 2 ? `H${b.id[1]}` : b.id === 'bullet' ? '•' : b.id === 'ordered' ? '1.' : b.id === 'todo' ? '[ ]' : b.id === 'quote' ? '"' : b.id === 'code' ? '<>' : '—'}</span>
              <span className="menu-label">{t(b.key)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
