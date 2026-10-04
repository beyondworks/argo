// 메일 서식 편집기(15차 C2) — 굵게·기울임·글머리 목록·번호 목록·링크. 작성 창 안에서 지연 로드된다(tiptap은 페이지 편집기와 같은 묶음, 첫 화면 밖).
// 보낼 때 HTML(이 편집기 값)과 글자(mail-model htmlToText) 두 갈래로 나간다. 링크는 http(s)·mailto만 — 붙여 넣은 주소는 저절로 링크가 된다.
import { useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Icon } from '../ui/Icon.jsx';
import { t } from '../core/i18n.js';
import { fixPastedHrefs, shouldAutoLink } from '../core/blocks-model.js';

const SAFE = /^(https?:\/\/|mailto:)/i;
/** 링크 주소 — http(s)·mailto는 그대로, 도메인 모양('naver.com')은 https를 붙인다. 나머지는 null */
const mailHref = (url) => (SAFE.test(url) ? url : /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(url) ? `https://${url}` : null);

export default function MailEditor({ initial = '', onChange, placeholder = '', autoFocus = false, onSubmit }) {
  const [link, setLink] = useState(null); // 링크 넣기 칸이 열렸을 때의 주소
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false, codeBlock: false, code: false, horizontalRule: false, strike: false, underline: false, blockquote: {},
        link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https', protocols: ['http', 'https', 'mailto'], shouldAutoLink,
          isAllowedUri: (url, ctx) => { const u = mailHref(url); return !!u && ctx.defaultValidate(u); }, // 자동 링크는 프로토콜 없는 'naver.com'을 넘긴다
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } },
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: initial,
    autofocus: autoFocus ? 'start' : false,
    editorProps: {
      attributes: { class: 'mail-editor-body', role: 'textbox', 'aria-multiline': 'true', 'aria-label': placeholder },
      transformPastedHTML: (html) => fixPastedHrefs(html, mailHref), // 붙여 넣은 <a href="naver.com">이 받는 사람에게 깨진 주소로 가지 않게(16차 검수 LOW 6)
      handleKeyDown: (_view, e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { onSubmit?.(); return true; } return false; },
    },
    onUpdate: ({ editor: ed }) => onChange?.(ed.getHTML()),
  });
  if (!editor) return <div className="mail-editor loading" aria-busy="true" />;
  const on = (name, attrs) => editor.isActive(name, attrs);
  const run = (fn) => (e) => { e.preventDefault(); fn(editor.chain().focus()).run(); };
  const openLink = (e) => { e.preventDefault(); setLink(editor.getAttributes('link').href ?? 'https://'); };
  const applyLink = (e) => {
    e.preventDefault();
    const href = String(link ?? '').trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!href || href === 'https://') chain.unsetLink().run();
    else if (SAFE.test(href)) {
      if (editor.state.selection.empty && !on('link')) chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
      else chain.setLink({ href }).run();
    }
    setLink(null);
  };
  const tool = (label, active, onMouseDown, children) => <button type="button" className={`mail-tool${active ? ' on' : ''}`} aria-label={label} aria-pressed={!!active} title={label} onMouseDown={onMouseDown}>{children}</button>;
  return <div className="mail-editor">
    <div className="mail-toolbar" role="toolbar" aria-label={t('mailx.format')}>
      {tool(t('mailx.bold'), on('bold'), run((c) => c.toggleBold()), <b>B</b>)}
      {tool(t('mailx.italic'), on('italic'), run((c) => c.toggleItalic()), <i>I</i>)}
      {tool(t('mailx.bullet'), on('bulletList'), run((c) => c.toggleBulletList()), <Icon name="bullet" size={15} />)}
      {tool(t('mailx.ordered'), on('orderedList'), run((c) => c.toggleOrderedList()), <Icon name="ordered" size={15} />)}
      {tool(t('mailx.link'), on('link'), openLink, <Icon name="link" size={15} />)}
      {link !== null && <form className="mail-linkbox" onSubmit={applyLink}>
        <input className="input" value={link} onChange={(e) => setLink(e.target.value)} aria-label={t('mailx.linkUrl')} placeholder="https://" autoFocus
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setLink(null); editor.commands.focus(); } }} />
        <button type="submit" className="btn sm">{t('mailx.linkApply')}</button>
        {on('link') && <button type="button" className="btn sm ghost" onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().extendMarkRange('link').unsetLink().run(); setLink(null); }}>{t('mailx.linkRemove')}</button>}
      </form>}
    </div>
    <EditorContent editor={editor} />
  </div>;
}
