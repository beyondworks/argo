// 블록 편집기 — tiptap(페이지를 열 때만 불러온다). '/' 블록 메뉴, 블록 끌기 손잡이, 마크다운 단축 입력.
// 저장 버튼 없음: 입력이 멈추면(0.8초) 저장한다(P0: 보낼 목록 → Supabase, 최대 5초마다·바뀐 게 없으면 보내지 않음).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extension-placeholder';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { Icon } from '../ui/Icon.jsx';
import { t } from '../core/i18n.js';
import { savePage } from '../core/store.js';

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

export default function Editor({ page }) {
  const [slash, setSlash] = useState(null); // { q, from, to, x, y, idx }
  const slashRef = useRef(null); slashRef.current = slash;
  const timer = useRef(null);
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
    ],
    content: page.content,
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
      const sq = slashQuery(ed);
      if (sq) { const c = ed.view.coordsAtPos(sq.to); setSlash((cur) => ({ ...sq, x: c.left, y: c.bottom + 6, idx: cur && cur.q === sq.q ? cur.idx : 0 })); } else if (slashRef.current) setSlash(null);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const json = ed.getJSON();
        const first = json.content?.[0];
        const title = first?.type === 'heading' ? (first.content ?? []).map((n) => n.text ?? '').join('') : page.title;
        savePage(page.id, { content: json, title });
      }, 800);
    },
    onSelectionUpdate: ({ editor: ed }) => { if (slashRef.current && !slashQuery(ed)) setSlash(null); },
  }, [page.id]);
  const editorRef = useRef(null); editorRef.current = editor;
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div className="editor">
      {editor && <DragHandle editor={editor} className="block-handle"><Icon name="grip" size={14} /></DragHandle>}
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
