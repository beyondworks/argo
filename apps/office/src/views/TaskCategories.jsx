// 할 일 분류 관리(유건 10/4) — 추가·이름 바꾸기·순서 바꾸기·지우기. 지우면 그 분류의 할 일은 미분류가 된다(할 일은 지워지지 않는다).
// 조직 공간은 관리자만, 개인 공간은 본인(서버 office_task_category_write와 같다). 이름은 칸을 벗어나거나 Enter를 누르면 바로 저장한다.
import { useState } from 'react';
import { t, registerDict, useLang } from '../core/i18n.js';
import { canManage, SPACES } from '../core/session.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { useTaskCategories, categoriesOf, writeCategory } from './data.js';
import { TASK_DICT } from '../pages/task-i18n.js';
import './views.css';

registerDict(TASK_DICT);

export default function TaskCategories({ space, onClose }) {
  useLang();
  useTaskCategories([space]);
  const list = categoriesOf(space);
  const canEdit = space === 'me' || canManage(space);
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [ask, setAsk] = useState(null), [drafts, setDrafts] = useState({});
  const drop = (id) => setDrafts(({ [id]: _gone, ...rest }) => rest);
  const run = async (action, data) => {
    setBusy(true);
    try { await writeCategory(space, action, data); return true; } catch (e) { showToast(t(e.message)); return false; } finally { setBusy(false); }
  };
  const add = async (e) => {
    e.preventDefault();
    const n = name.trim();
    if (n && !busy && (await run('category.create', { id: crypto.randomUUID(), name: n }))) setName('');
  };
  const rename = async (c) => {
    const v = (drafts[c.id] ?? c.name).trim();
    if (v && v !== c.name) await run('category.rename', { id: c.id, name: v }); // 실패하면 원래 이름으로 돌아간다
    drop(c.id);
  };
  const move = (i, d) => {
    const ids = list.map((c) => c.id), j = i + d;
    if (j < 0 || j >= ids.length || busy) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    run('category.order', { ids });
  };
  const remove = async (c) => { if (await run('category.delete', { id: c.id })) { setAsk(null); showToast(t('task.cats.deleted')); } };
  const where = space === 'me' ? t('task.cats.me') : SPACES.find((s) => s.key === space)?.name ?? space;

  return <Modal open width={480} title={t('task.cats.title', { space: where })} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>{t('task.close')}</button>}>
    <div className="tk-cats">
      {!canEdit && <p className="tk-hint">{t('task.cats.readOnly')}</p>}
      {!list.length ? <p className="tk-hint">{t('task.cats.empty')}</p> : <ul className="tk-cat-list">{list.map((c, i) => <li key={c.id} className="tk-cat">
        {ask === c.id ? <div className="tk-cat-ask" role="alert">
          <p>{c.tasks != null ? t('task.cats.ask', { name: c.name, n: c.tasks }) : t('task.cats.askAny', { name: c.name })}</p>
          <span className="tk-row"><button type="button" className="btn sm" onClick={() => setAsk(null)}>{t('task.cats.keep')}</button>
            <button type="button" className="btn sm danger" disabled={busy} onClick={() => remove(c)}>{t('task.cats.delete')}</button></span>
        </div> : <>
          <input className="input" value={drafts[c.id] ?? c.name} maxLength={40} aria-label={t('task.cats.name')} disabled={!canEdit}
            onChange={(e) => setDrafts({ ...drafts, [c.id]: e.target.value })} onBlur={() => rename(c)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.blur(); } }} />
          {c.tasks != null && <span className="dim small tk-cat-n">{t('task.cats.count', { n: c.tasks })}</span>}
          {canEdit && <span className="tk-row">
            <button type="button" className="icon-btn sm" aria-label={t('task.cats.up')} title={t('task.cats.up')} disabled={i === 0 || busy} onClick={() => move(i, -1)}><Icon name="caret" size={14} className="tk-up" /></button>
            <button type="button" className="icon-btn sm" aria-label={t('task.cats.down')} title={t('task.cats.down')} disabled={i === list.length - 1 || busy} onClick={() => move(i, 1)}><Icon name="caret" size={14} /></button>
            <button type="button" className="icon-btn sm" aria-label={t('task.cats.delete')} title={t('task.cats.delete')} disabled={busy} onClick={() => setAsk(c.id)}><Icon name="trash" size={14} /></button>
          </span>}
        </>}
      </li>)}</ul>}
      {canEdit && <form className="tk-cat-add" onSubmit={add}>
        <input className="input" value={name} maxLength={40} placeholder={t('task.cats.addPh')} aria-label={t('task.cats.addPh')} onChange={(e) => setName(e.target.value)} />
        <button className="btn sm primary" disabled={busy || !name.trim()}><Icon name="plus" size={13} />{t('task.cats.add')}</button>
      </form>}
      {canEdit && <p className="tk-hint">{t('task.cats.note')}</p>}
    </div>
  </Modal>;
}
