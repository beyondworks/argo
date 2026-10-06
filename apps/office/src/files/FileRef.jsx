// 페이지 '/파일' 블록(인트라넷 workboard-editor.tsx:72-131 — 본문에 파일·그림 첨부) — 문서함 파일을 본문에 넣는다.
// 파일은 문서함에 한 번만 저장되고 본문에는 가리킴(id·공간·이름)만 남는다. 그림은 본문에서 바로 보이고, 나머지는 눌러서 문서함 미리보기로.
// 볼 권한이 없거나 지운 파일은 '볼 수 없음'으로만 보인다. 공개 링크(office_strip)에서는 블록이 빠진다.
import { lazy, Suspense, useEffect, useState } from 'react';
import { Node, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { t, registerDict } from '../core/i18n.js';
import { navigate } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import { Modal } from '../ui/Overlay.jsx';
import { FILES_DICT } from './files-i18n.js';
import { FIcon } from './FIcon.jsx';
import './files.css';

registerDict(FILES_DICT);

function FileRefView({ node }) {
  const { id, space, title } = node.attrs;
  const [f, setF] = useState(undefined), [img, setImg] = useState(null);
  useEffect(() => {
    let live = true, made = null;
    import('./api.js').then(async (m) => {
      const x = await m.getFile(space, id);
      if (!live) return;
      setF(x);
      if (x.kind === 'file' && !x.deleted_at && /^image\//.test(x.mime) && x.mime !== 'image/svg+xml') {
        const blob = await m.fileBlob(space, x);
        if (live && blob) { made = URL.createObjectURL(blob); setImg(made); }
      }
    }).catch(() => live && setF(null));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [id, space]);
  const open = () => navigate(`${baseOf(space)}/files?open=${encodeURIComponent(id)}`);
  const gone = f === null || f?.deleted_at;
  return <NodeViewWrapper contentEditable={false} data-drag-handle="">
    <div className={`file-block${img ? ' image' : ''}`} role="button" tabIndex={0} onClick={gone ? undefined : open} onKeyDown={(e) => { if (e.key === 'Enter' && !gone) open(); }}>
      {img ? <img src={img} alt={f?.title ?? title} /> : <>
        <FIcon name={f?.kind === 'link' ? 'link' : /pdf/.test(f?.mime ?? '') ? 'pdf' : 'doc'} size={18} />
        <span className="file-block-main"><strong>{f?.title ?? title}</strong>{gone && <small className="dim">{t('files.blockGone')}</small>}</span>
      </>}
    </div>
  </NodeViewWrapper>;
}

export const FileRefNode = Node.create({
  name: 'fileRef', group: 'block', atom: true, selectable: true, draggable: true,
  addAttributes: () => ({ id: { default: null }, space: { default: 'me' }, title: { default: '' } }),
  parseHTML: () => [{ tag: 'div[data-file-ref]', getAttrs: (el) => ({ id: el.getAttribute('data-file-ref'), space: el.getAttribute('data-space'), title: el.textContent }) }],
  renderHTML: ({ node }) => ['div', { 'data-file-ref': node.attrs.id, 'data-space': node.attrs.space }, node.attrs.title],
  addNodeView() { return ReactNodeViewRenderer(FileRefView); },
});

const Picker = lazy(() => import('./FilePicker.jsx'));
/** '/파일'을 고르면 뜨는 창 — 문서함에서 고르거나 새로 올린다. onPick({ id, title }) */
export function FilePickModal({ space, onPick, onClose }) {
  return <Modal open width={560} title={t('files.blockPickTitle')} onClose={onClose}>
    <Suspense fallback={<div className="skeleton-lines"><span /><span /></div>}><Picker space={space} onPick={onPick} /></Suspense>
  </Modal>;
}
