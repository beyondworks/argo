// 할 일 모듈(로그인 화면) — 성과 기록 1단계(유건 9/29). 기한이 있는 할 일을 서버에 저장하고,
// 끝낸 날짜로 기한 준수율·달성률을 계산한다. 지우기는 없고 취소만 있다(기록은 남는다).
// 할 일 속성(유건 10/4): 제목을 누르면 오른쪽 할 일 패널(상태·중요도·분류·시작일·메모·바뀐 기록 — 열 때 받는다), 줄에는 상태·중요도·분류를 글로 보인다.
import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { t, getLang, registerDict, useLang } from '../core/i18n.js';
import { ME, canManage } from '../core/session.js';
import { useTasks, taskAction, orgOf } from '../core/tasks.js';
import { kstDay, groupTasks, dueInfo } from '../core/task-model.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { openMenu, menuProps } from '../ui/Menu.jsx';
import { Icon } from '../ui/Icon.jsx';
import { useUrl } from '../core/router.jsx';
import { TASK_DICT } from './task-i18n.js';

registerDict(TASK_DICT);
const TaskPanel = lazy(() => import('../views/TaskPanel.jsx'));
const shortDay = (value) => new Date(value.length === 10 ? `${value}T00:00:00+09:00` : value).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' });
const GROUPS = ['overdue', 'today', 'week', 'later', 'none', 'gave', 'others'];

export default function TaskList({ space }) {
  useLang();
  const { rows, people = [], error, loading } = useTasks(space);
  const manager = !!orgOf(space) && canManage(space);
  const [title, setTitle] = useState(''), [due, setDue] = useState(''), [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false), [edit, setEdit] = useState(null), [showDone, setShowDone] = useState(false), [panel, setPanel] = useState(null);
  const name = (id) => (id === ME.id ? t('task.me') : people.find((p) => p.user_id === id)?.name ?? '?');
  const today = kstDay();
  const focus = new URLSearchParams(useUrl().split('?')[1] ?? '').get('open'); // 예전 주소(?open=id)로 왔을 때 그 줄로 가서 할 일 패널을 연다
  useEffect(() => { if (focus && rows) { document.querySelector(`[data-task="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'center' }); if (rows.some((r) => r.id === focus)) setPanel(focus); } }, [focus, !!rows]);
  const run = (action, data, patch) => taskAction(space, action, data, patch).catch((e) => showToast(t(e.message)));
  const add = async (event) => {
    event.preventDefault();
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await taskAction(space, 'task.create', { id: crypto.randomUUID(), title: text, due_on: due || null, ...(assignee ? { assignee } : {}) });
      setTitle(''); setDue(''); setAssignee(''); // 다음 할 일에 앞의 기한·맡을 사람이 몰래 따라가지 않게
    } catch (e) { showToast(t(e.message)); } finally { setBusy(false); }
  };
  const menu = (row) => [{ label: t('task.details'), icon: 'doc', run: () => setPanel(row.id) }, ...(manager || row.created_by === ME.id ? [ // 남이 맡긴 일은 끝내기·상태 바꾸기만(서버도 같은 규칙)
    !row.done_at && { sep: true },
    !row.done_at && { label: t('task.changeDue'), icon: 'history', run: () => setEdit({ kind: 'due', row, value: row.due_on ?? '' }) },
    !row.done_at && { label: t('task.rename'), icon: 'draft', run: () => setEdit({ kind: 'title', row, value: row.title }) },
    !row.done_at && manager && { label: t('task.reassign'), icon: 'person', run: () => setEdit({ kind: 'assign', row, value: row.assignee }) },
    !row.done_at && { sep: true },
    !row.done_at && { label: t('task.cancel'), icon: 'x', danger: true, run: () => setEdit({ kind: 'cancel', row }) },
  ] : [])].filter(Boolean);

  if (!rows) return <div className="mod-empty" role="status">{error ? t(error) : loading ? '…' : ''}</div>;
  const g = groupTasks(rows, today, ME.id);
  const renderRow = (row) => {
    const info = dueInfo(row.due_on, today);
    const late = row.done_at && row.due_on && kstDay(new Date(row.done_at)) > row.due_on;
    const meta = [
      !row.done_at && row.status && row.status !== 'todo' && t(`task.st.${row.status}`), // 진행 중·보류
      !row.done_at && row.priority && row.priority !== 2 && t('task.prBadge', { p: t(`task.pr.${row.priority}`) }),
      row.done_at ? t('task.doneAt', { date: shortDay(row.done_at) }) : info && t(`task.d.${info.key}`, { n: info.n }),
      late && t('task.late'),
      row.category_id && row.category,
      row.assignee !== ME.id && t('task.to', { name: name(row.assignee) }),
      row.assignee === ME.id && row.created_by !== ME.id && t('task.by', { name: name(row.created_by) }),
    ].filter(Boolean).join(' · ');
    const items = menu(row);
    return <div key={row.id} data-task={row.id} className={`mod-row todo task-row${row.done_at ? ' done' : ''}${info?.key === 'overdue' && !row.done_at ? ' overdue' : ''}${row.id === focus ? ' focus' : ''}`} {...menuProps(() => items)}>
      <input type="checkbox" aria-label={row.title} checked={!!row.done_at} onChange={() => run(row.done_at ? 'task.reopen' : 'task.done', { id: row.id }, { done_at: row.done_at ? null : new Date().toISOString() })} />
      <button type="button" className="mod-main task-open" style={{ textAlign: 'start' }} onClick={() => setPanel(row.id)}><span className="clamp">{row.title}</span>{meta && <small>{meta}</small>}</button>
      <button type="button" className="icon-btn task-more" aria-label={t('task.more')} onClick={(e) => openMenu(e, items, { anchor: e.currentTarget })}><Icon name="dots" size={14} /></button>
    </div>;
  };
  const save = async (event) => {
    event.preventDefault();
    const { kind, row, value } = edit;
    const action = { due: 'task.due', title: 'task.title', assign: 'task.assign', cancel: 'task.cancel' }[kind];
    const data = { id: row.id, ...(kind === 'due' ? { due_on: value || null } : kind === 'title' ? { title: value.trim() } : kind === 'assign' ? { assignee: value } : {}) };
    try { await taskAction(space, action, data); setEdit(null); if (kind === 'cancel') showToast(t('task.cancelled')); }
    catch (e) { showToast(t(e.message)); }
  };
  const open = GROUPS.filter((key) => g[key].length);
  return <div className="task-list">
    <form className="task-add" onSubmit={add}>
      <input className="input" value={title} maxLength={200} placeholder={t('task.addHint')} aria-label={t('task.add')} onChange={(e) => setTitle(e.target.value)} />
      <input type="date" className="input" value={due} aria-label={t('task.due')} onChange={(e) => setDue(e.target.value)} />
      {manager && people.length > 1 && <select className="input" value={assignee} aria-label={t('task.assignee')} onChange={(e) => setAssignee(e.target.value)}>
        <option value="">{t('task.me')}</option>{people.filter((p) => p.user_id !== ME.id).map((p) => <option key={p.user_id} value={p.user_id}>{p.name}</option>)}</select>}
      <button className="btn sm" disabled={busy || !title.trim()}><Icon name="plus" size={13} />{t('task.add')}</button>
    </form>
    {!open.length && !g.done.length && <p className="mod-empty">{t('task.empty')}</p>}
    {open.map((key) => <section key={key} className={`task-group g-${key}`}>
      <h4>{t(`task.g.${key}`)} <span className="dim">{g[key].length}</span></h4>
      {g[key].map(renderRow)}
    </section>)}
    {g.done.length > 0 && <section className="task-group g-done">
      <button type="button" className="task-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}><Icon name="caret" size={12} />{t('task.g.done', { n: g.done.length })}</button>
      {showDone && g.done.map(renderRow)}
    </section>}
    <TaskEdit edit={edit} setEdit={setEdit} save={save} people={people} />
    {panel && <Suspense fallback={null}><TaskPanel space={space} id={panel} taskSpace={space} onClose={() => setPanel(null)} /></Suspense>}
  </div>;
}

function TaskEdit({ edit, setEdit, save, people }) {
  const formId = useId();
  if (!edit) return null;
  const title = t({ due: 'task.changeDue', title: 'task.rename', assign: 'task.reassign', cancel: 'task.cancel' }[edit.kind]);
  const value = (v) => setEdit({ ...edit, value: v });
  return <Modal open title={title} onClose={() => setEdit(null)} footer={<>
    <button type="button" className="btn" onClick={() => setEdit(null)}>{t('task.close')}</button>
    <button type="submit" form={formId} className={`btn ${edit.kind === 'cancel' ? 'danger' : 'primary'}`} disabled={edit.kind === 'title' && !edit.value.trim()}>{edit.kind === 'cancel' ? t('task.cancel') : t('task.save')}</button></>}>
    <form id={formId} className="task-edit" onSubmit={save}>
      <p className="clamp"><strong>{edit.row.title}</strong></p>
      {edit.kind === 'due' && <><label className="field-block"><span className="label">{t('task.due')}</span><input type="date" className="input" value={edit.value} onChange={(e) => value(e.target.value)} /></label><p className="dim small">{t('task.dueNote')}</p></>}
      {edit.kind === 'title' && <label className="field-block"><span className="label">{t('task.title')}</span><input className="input" maxLength={200} value={edit.value} onChange={(e) => value(e.target.value)} /></label>}
      {edit.kind === 'assign' && <label className="field-block"><span className="label">{t('task.assignee')}</span><select className="input" value={edit.value} onChange={(e) => value(e.target.value)}>{people.map((p) => <option key={p.user_id} value={p.user_id}>{p.user_id === ME.id ? t('task.me') : p.name}</option>)}</select></label>}
      {edit.kind === 'cancel' && <p>{t('task.cancelBody')}</p>}
    </form>
  </Modal>;
}
