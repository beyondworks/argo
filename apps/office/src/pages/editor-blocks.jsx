// 편집기 새 블록의 화면(16차) — 토글·콜아웃 그리기(node view), 표 도구 막대, 링크 말풍선. 스키마는 pages/page-blocks.js, 모양(css)은 ui/doc-blocks.css·./editor.css.
// 모두 편집기와 함께 지연 로드된다.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NodeViewWrapper, NodeViewContent, getMarkRange } from '@tiptap/react';
import { isInTable, findTable, addRowAfter, addColumnAfter, deleteRow, deleteColumn, deleteTable } from '@tiptap/pm/tables';
import { Icon } from '../ui/Icon.jsx';
import { t } from '../core/i18n.js';
import { openExternal } from '../core/platform.js';
import { CALLOUT_ICONS, calloutIcon, safeHref, normalizeHref, toggleFirstRowHeader } from './page-blocks.js';
import './editor.css';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const openHref = (href) => { const url = safeHref(href); if (url) openExternal(url).catch(() => {}); };

/** 토글 그리기 — 편집할 수 있으면 접힘을 문서에 저장하고, 보기만 하는 사람은 이 화면에서만 접고 편다 */
export function ToggleView({ node, editor, updateAttributes }) {
  const saved = node.attrs.open !== false;
  const [local, setLocal] = useState(saved);
  useEffect(() => setLocal(saved), [saved]);
  const open = editor.isEditable ? saved : local;
  const flip = () => (editor.isEditable ? updateAttributes({ open: !saved }) : setLocal(!local));
  return <NodeViewWrapper className="toggle" data-toggle="" data-open={String(open)} data-empty={node.childCount < 2 && editor.isEditable ? '' : undefined} data-hint={t('doc.toggleEmpty')}>
    <button type="button" className="toggle-btn" contentEditable={false} aria-expanded={open} aria-label={t(open ? 'doc.toggleClose' : 'doc.toggleOpen')}
      onMouseDown={(e) => e.preventDefault()} onClick={flip}><Icon name="chevron" size={16} /></button>
    <NodeViewContent className="toggle-content" />
  </NodeViewWrapper>;
}

/** 아이콘 고르기 — 버튼 아래 작은 격자. ↑↓←→로 옮기고 Enter로 고른다, Esc·바깥 누르기로 닫는다 */
function IconGrid({ anchor, value, onPick, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect(), w = ref.current?.offsetWidth ?? 240, h = ref.current?.offsetHeight ?? 160;
    setPos({ left: Math.max(8, Math.min(r.left, innerWidth - w - 8)), top: r.bottom + h + 12 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6 });
    ref.current?.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  }, [anchor]);
  useEffect(() => {
    const out = (e) => { if (!ref.current?.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) onClose(); };
    document.addEventListener('pointerdown', out, true);
    return () => document.removeEventListener('pointerdown', out, true);
  }, [anchor, onClose]);
  const onKey = (e) => {
    const items = [...ref.current.querySelectorAll('button')], i = items.indexOf(document.activeElement), cols = 6;
    const go = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (go) { e.preventDefault(); items[Math.max(0, Math.min(items.length - 1, i + go))]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); anchor.focus?.(); }
  };
  return createPortal(<div ref={ref} className="icon-grid" role="radiogroup" aria-label={t('block.calloutIcon')} onKeyDown={onKey} style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}>
    {CALLOUT_ICONS.map((name) => <button key={name} type="button" role="radio" aria-checked={name === value} aria-label={t(`callout.icon.${name}`)} title={t(`callout.icon.${name}`)}
      className={name === value ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(name)}><Icon name={name} size={18} /></button>)}
  </div>, document.body);
}

/** 콜아웃 그리기 — 아이콘을 눌러 바꾼다(편집할 수 있을 때만) */
export function CalloutView({ node, editor, updateAttributes }) {
  const [anchor, setAnchor] = useState(null);
  const icon = calloutIcon(node.attrs.icon);
  return <NodeViewWrapper className="callout" data-callout="" data-icon={icon}>
    {editor.isEditable
      ? <button type="button" className="callout-icon" contentEditable={false} aria-label={t('block.calloutIcon')} aria-haspopup="true" aria-expanded={!!anchor} title={t('block.calloutIcon')}
        onMouseDown={(e) => e.preventDefault()} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}><Icon name={icon} size={18} /></button>
      : <span className="callout-icon" contentEditable={false} aria-hidden="true"><Icon name={icon} size={18} /></span>}
    <NodeViewContent className="callout-body" />
    {anchor && <IconGrid anchor={anchor} value={icon} onClose={() => setAnchor(null)} onPick={(name) => { setAnchor(null); updateAttributes({ icon: name }); editor.commands.focus(); }} />}
  </NodeViewWrapper>;
}

/** 편집기 상태가 바뀔 때마다 다시 그린다(선택·초점 포함) */
function useEditorTick(editor) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!editor) return undefined;
    const f = () => tick((x) => x + 1);
    editor.on('transaction', f); editor.on('focus', f); editor.on('blur', f);
    addEventListener('resize', f);
    return () => { editor.off('transaction', f); editor.off('focus', f); editor.off('blur', f); removeEventListener('resize', f); };
  }, [editor]);
}
/** host(편집기 바깥 상자, position: relative) 기준 좌표 */
const within = (host, rect) => { const h = host.getBoundingClientRect(); return { left: rect.left - h.left, top: rect.top - h.top, bottom: rect.bottom - h.top, right: rect.right - h.left }; };

/** 표 도구 막대 — 커서가 표 안에 있을 때 표 위에 뜬다. 줄·칸 더하기·지우기, 머리 행 켜고 끄기, 표 지우기. 열 너비는 칸 경계를 끌어 바꾼다 */
export function TableBar({ editor, host }) {
  useEditorTick(editor);
  if (!editor || editor.isDestroyed || !editor.isEditable || !editor.isFocused || !host.current) return null;
  const { state, view } = editor;
  if (!isInTable(state)) return null;
  const table = findTable(state.selection.$from);
  const dom = table && view.nodeDOM(table.pos);
  if (!(dom instanceof Element)) return null;
  const r = within(host.current, dom.getBoundingClientRect());
  const header = table.node.firstChild?.firstChild?.type.name === 'tableHeader';
  const run = (cmd) => (e) => { e.preventDefault(); cmd(view.state, view.dispatch); view.focus(); };
  const btn = (key, cmd, extra = {}) => <button type="button" className={`btn sm ghost${extra.on ? ' on' : ''}${extra.danger ? ' danger-text' : ''}`} aria-pressed={extra.on} onMouseDown={run(cmd)}>{t(key)}</button>;
  return <div className="table-bar" role="toolbar" aria-label={t('table.tools')} contentEditable={false} style={{ left: Math.max(0, r.left), top: Math.max(0, r.top - 36) }}>
    {btn('table.rowAfter', addRowAfter)}{btn('table.colAfter', addColumnAfter)}
    <span className="table-bar-sep" />
    {btn('table.rowDelete', deleteRow)}{btn('table.colDelete', deleteColumn)}
    <span className="table-bar-sep" />
    {btn('table.header', toggleFirstRowHeader, { on: header })}{btn('table.delete', deleteTable, { danger: true })}
  </div>;
}

/** 링크 말풍선 — 커서가 링크 안에 있으면 주소·열기·고치기·빼기, ⌘K(글자를 고른 채)면 주소 넣기 칸.
 *  ask: { from, to } | null — 넣기 칸을 연 범위. onAsk(null)로 닫는다 */
export function LinkPop({ editor, host, ask, onAsk }) {
  useEditorTick(editor);
  const [draft, setDraft] = useState(null);                                          // 고치는 중인 주소(넣기 칸이 열려 있으면 문자열)
  const [bad, setBad] = useState(false);
  const range = useRef(null);
  useEffect(() => { if (ask) { setDraft(editor.getAttributes('link').href ?? ''); setBad(false); range.current = ask; } }, [ask, editor]);
  const editing = draft !== null;
  useEffect(() => { // 넣기 칸을 연 채 본문을 다시 누르면 칸을 닫는다(넣지 않음)
    if (!editing || !editor) return undefined;
    const off = () => { setDraft(null); setBad(false); range.current = null; onAsk(null); };
    editor.on('focus', off);
    return () => editor.off('focus', off);
  }, [editing, editor]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!editor || editor.isDestroyed || !editor.isEditable || !host.current) return null;
  const { state, view } = editor, type = state.schema.marks.link;
  let at = null, href = null;
  if (draft !== null && range.current) at = range.current;
  else if (editor.isFocused && state.selection.empty && type) {
    const $p = state.selection.$from, mark = type.isInSet($p.marks()) || ($p.nodeAfter && type.isInSet($p.nodeAfter.marks));
    const r = mark && getMarkRange($p, type, mark.attrs);
    if (r) { at = r; href = mark.attrs.href; }
  }
  if (!at) return null;
  const close = () => { setDraft(null); setBad(false); range.current = null; onAsk(null); };
  const apply = (e) => {
    e.preventDefault();
    const url = normalizeHref(draft);
    if (draft.trim() && !url) { setBad(true); return; }
    const chain = editor.chain().focus().setTextSelection(at).extendMarkRange('link');
    (url ? chain.setLink({ href: url }) : chain.unsetLink()).setTextSelection(at.to).run();
    close();
  };
  const c = view.coordsAtPos(Math.min(at.from, state.doc.content.size));
  const p = within(host.current, { left: c.left, top: c.top, bottom: c.bottom, right: c.right });
  const style = { left: Math.max(0, p.left), top: p.bottom + 6 };
  if (draft !== null) return <form className="link-pop" style={style} onSubmit={apply} onMouseDown={(e) => e.stopPropagation()}>
    <input className="input sm" autoFocus value={draft} placeholder="https://" aria-label={t('link.address')} aria-invalid={bad || undefined}
      onChange={(e) => { setDraft(e.target.value); setBad(false); }} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); editor.commands.focus(); } }} />
    <button type="submit" className="btn sm primary">{t('link.apply')}</button>
    {bad && <small role="alert" className="link-pop-bad">{t('link.bad')}</small>}
  </form>;
  return <div className="link-pop" style={style} role="dialog" aria-label={t('link.address')} contentEditable={false}>
    <a className="link-pop-url" href={safeHref(href) ?? undefined} title={t('link.openHint', { key: isMac ? '⌘' : 'Ctrl' })} onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.preventDefault(); openHref(href); }}>{href}</a>
    <button type="button" className="icon-btn sm" aria-label={t('link.open')} title={t('link.open')} onMouseDown={(e) => e.preventDefault()} onClick={() => openHref(href)}><Icon name="share" size={14} /></button>
    <button type="button" className="icon-btn sm" aria-label={t('link.edit')} title={t('link.edit')} onMouseDown={(e) => e.preventDefault()} onClick={() => { range.current = at; setDraft(href ?? ''); }}><Icon name="draft" size={14} /></button>
    <button type="button" className="icon-btn sm" aria-label={t('link.remove')} title={t('link.remove')} onMouseDown={(e) => e.preventDefault()}
      onClick={() => editor.chain().focus().setTextSelection(at).unsetLink().setTextSelection(at.to).run()}><Icon name="x" size={14} /></button>
  </div>;
}
