// 페이지 트리 '이름 바꾸기'·'옮기기'(16차, PARITY-tasks D4·D6) — 메뉴(core/commands.js)는 첫 화면이라 이 창 코드는 누를 때만 받는다.
//   · 이름 바꾸기: 트리 줄(없으면 머리줄의 페이지 이름) 바로 그 자리에 입력 칸을 띄운다. Enter·칸 밖 누르기 = 바꾸기, Esc = 그대로. 한글 입력 중의 Enter는 무시한다.
//     본문 첫 줄이 제목 줄이면 그 글자도 같이 바뀐다(pages/page-title.js). 페이지가 열려 있으면 열린 편집기를 거쳐 바꾼다.
//   · 옮기기: 상위 고르기 창(찾기·↑↓·Enter). 자기 자신·하위는 빠지고, 서버 office_page_move가 거절할 곳은 처음부터 보이지 않는다(pages/tree-model.js). 되돌리기 알림.
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { t, registerDict, useLang } from '../core/i18n.js';
import { getState, useStore, savePage, update, childrenOf } from '../core/store.js';
import { loadPageContent } from '../core/pull.js';
import { canManage, getMode } from '../core/session.js';
import { between } from '../core/position.js';
import { openEditor } from '../core/page-live.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { TREE_DICT } from './tree-i18n.js';
import { cleanTitle, renameDoc } from './page-title.js';
import { moveTargets, filterTargets } from './tree-model.js';
import './tree.css';

registerDict(TREE_DICT);

let root = null;
const mount = (el) => { if (!root) { const box = document.createElement('div'); document.body.append(box); root = createRoot(box); } root.render(el); };
const unmount = () => root?.render(null);

/** 이름 저장 — 열린 편집기가 있으면 그쪽(제목 줄과 함께), 없으면 본문을 받아 제목 줄을 고친 뒤 저장 */
export async function applyRename(id, raw) {
  const page = getState().pages.find((p) => p.id === id);
  const title = cleanTitle(raw);
  if (!page || !title || title === page.title) return;
  const live = openEditor(id);
  if (live) { live.rename(title); return; }
  if (page.content === undefined) await loadPageContent(id).catch(() => {});
  const cur = getState().pages.find((p) => p.id === id);
  if (!cur) return;
  if (cur.content === undefined) { showToast(t('tree.renameFail')); return; }       // 본문 없이 이름만 보내는 길은 없다(저장은 이름·본문을 함께 보낸다)
  savePage(id, { title, content: renameDoc(cur.content, cur.title, title) });
}

/** 그 자리 입력 칸 — 화면에 떠 있는 줄 위에 겹쳐 그린다(트리가 다시 그려져도 입력이 끊기지 않게 React 밖 칸 하나) */
function inlineInput(anchor, page) {
  const input = document.createElement('input');
  input.className = 'tree-rename';
  input.value = page.title ?? '';
  input.maxLength = 500;
  input.setAttribute('aria-label', t('tree.renameLabel'));
  let done = false;
  const place = () => {
    if (!anchor.isConnected) { finish(true); return; }
    const r = anchor.getBoundingClientRect(), cs = getComputedStyle(anchor);
    Object.assign(input.style, { left: `${r.left - 3}px`, top: `${r.top + r.height / 2 - 14}px`, width: `${Math.max(r.width + 6, 160)}px`, fontSize: cs.fontSize, fontWeight: cs.fontWeight });
  };
  const stop = () => { removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  function finish(commit) {
    if (done) return;
    done = true; stop();
    const value = input.value;
    input.remove();
    if (commit) applyRename(page.id, value);
  }
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;                                  // 한글 조합 중 Enter는 글자를 확정할 뿐
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  addEventListener('resize', place);
  document.addEventListener('scroll', place, true);
  document.body.append(input);
  place();
  input.focus({ preventScroll: true });
  input.select();
}

function RenameDialog({ page, onClose }) {
  useLang();
  const [v, setV] = useState(page.title ?? '');
  const save = (e) => { e.preventDefault(); applyRename(page.id, v); onClose(); };
  return <Modal open width={420} title={t('tree.renameTitle')} onClose={onClose} footer={<>
    <button type="button" className="btn" onClick={onClose}>{t('tree.cancel')}</button>
    <button type="submit" form="tree-rename-form" className="btn primary" disabled={!cleanTitle(v)}>{t('tree.renameSave')}</button></>}>
    <form id="tree-rename-form" onSubmit={save}><input className="input tree-rename-field" value={v} maxLength={500} aria-label={t('tree.renameLabel')} onChange={(e) => setV(e.target.value)} data-autofocus /></form>
  </Modal>;
}

/** 이름 바꾸기 시작 — 트리에 그 줄이 보이면 그 자리, 열린 페이지면 머리줄 이름 자리, 둘 다 아니면 작은 창 */
export function startRename(page) {
  const esc = (s) => (globalThis.CSS?.escape ? CSS.escape(s) : s);
  const anchor = document.querySelector(`.tree-row[data-tree-id="${esc(page.id)}"] .tree-label`)
    ?? (location.pathname.endsWith(`/p/${page.id}`) ? document.querySelector('.crumb-cur') : null);
  if (anchor && anchor.getBoundingClientRect().width > 0) inlineInput(anchor, page);
  else mount(<RenameDialog key={`${page.id}:${Date.now()}`} page={page} onClose={unmount} />);
}

/** 옮기기 — 새 상위의 맨 끝에. 서버로는 순서 바꾸기와 같은 'page.move'(상위·순서를 함께 보낸다) */
export function movePage(page, parent) {
  const cur = getState().pages.find((p) => p.id === page.id);
  if (!cur || (cur.parent ?? null) === parent) return false;
  const before = { parent: cur.parent ?? null, position: cur.position };
  const position = between(childrenOf(getState().pages, cur.space, parent).at(-1)?.position ?? null, null);
  const set = (v) => update((s) => ({ pages: s.pages.map((p) => (p.id === cur.id ? { ...p, ...v } : p)) }), [[`order:${cur.id}`, { type: 'page.move', id: cur.id }]]);
  if (!set({ parent, position })) return false;
  const name = parent ? getState().pages.find((p) => p.id === parent)?.title || t('page.untitled') : null;
  showToast(name ? t('tree.moved', { title: name }) : t('tree.movedTop'), { undo: () => set(before) });
  return true;
}

function MoveDialog({ page, onClose }) {
  useLang();
  const pages = useStore((s) => s.pages);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const all = useMemo(() => moveTargets(pages, page, { admin: canManage(page.space), sample: getMode() === 'sample' }), [pages, page]);
  const list = filterTargets(all, q, t('page.untitled'));
  const pickable = list.filter((x) => !x.current);
  const cur = pickable[Math.min(at, pickable.length - 1)];
  const choose = (x) => { if (!x || x.current) return; movePage(page, x.id); onClose(); };
  const onKey = (e) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;                    // Safari는 조합을 끝내는 Enter에 isComposing이 거짓 — 229로도 본다(16차 검수 LOW 7)
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(i + 1, pickable.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(cur); }
  };
  return <Modal open width={460} title={t('tree.moveTitle', { title: page.title || t('page.untitled') })} onClose={onClose}>
    <div className="tree-move">
      <input className="input" value={q} placeholder={t('tree.moveSearch')} aria-label={t('tree.moveSearch')} onChange={(e) => { setQ(e.target.value); setAt(0); }} onKeyDown={onKey} data-autofocus />
      <div className="tree-move-list" role="listbox" aria-label={t('tree.moveSearch')}>
        {list.map((x) => <button key={x.id ?? 'top'} type="button" role="option" aria-selected={x === cur} disabled={x.current} className={`tree-move-row${x === cur ? ' on' : ''}`}
          style={{ paddingLeft: 10 + (q ? 0 : x.depth * 16) }} onClick={() => choose(x)} onPointerMove={() => { const i = pickable.indexOf(x); if (i >= 0) setAt(i); }}>
          <Icon name={x.id ? 'doc' : 'home'} size={14} className="dim" /><span className="grow">{x.id ? x.title || t('page.untitled') : t('tree.top')}</span>{x.current && <span className="badge">{t('tree.here')}</span>}
        </button>)}
        {!list.length && <p className="dim small tree-move-empty">{all.length ? t('tree.noMatch') : t('tree.none')}</p>}
      </div>
      <p className="dim small">{t('tree.moveHint')}</p>
    </div>
  </Modal>;
}

export function openMove(page) {
  mount(<MoveDialog key={`${page.id}:${Date.now()}`} page={page} onClose={unmount} />);
}
