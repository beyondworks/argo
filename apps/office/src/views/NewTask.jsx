// 새 할 일 창 — 여러 보기·할 일 화면의 '새 할 일'과 페이지 ⋯ 메뉴 '할 일로 만들기'(제목·본문 앞부분을 채워 연다)가 같이 쓴다.
// 할 일 속성(유건 10/4): 기한·시작일·분류·중요도·메모를 만들 때 함께 정한다(맡을 사람은 조직 관리자만).
import { useId, useState } from 'react';
import { t, registerDict, useLang } from '../core/i18n.js';
import { canManage } from '../core/session.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import * as V from './model.js';
import { runWrites, useTaskCategories, categoriesOf } from './data.js';
import { TASK_DICT } from '../pages/task-i18n.js';
import { VIEWS_DICT } from './views-i18n.js';
import './views.css';

registerDict({ ...TASK_DICT, ...VIEWS_DICT });

/** init: { title, note, category_id, source } — 미리 채울 값(페이지에서 만들기). onCreated(id): 만든 뒤(창은 닫힌다) */
export function NewTask({ space, people, onClose, init = {}, onCreated }) {
  useLang();
  useTaskCategories([space]);
  const [f, setF] = useState({ title: init.title ?? '', due: '', start: '', who: '', cat: init.category_id ?? '', pr: 2, note: init.note ?? '' });
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const put = (patch) => setF((x) => ({ ...x, ...patch }));
  const admin = space !== 'me' && canManage(space);
  const others = admin ? people.list(space).filter((p) => p.user_id !== people.me && p.role !== 'guest') : [];
  const cats = categoriesOf(space);
  const bad = !!(f.start && f.due && f.start > f.due);
  const submit = async (e) => {
    e.preventDefault();
    if (!f.title.trim() || busy || bad) return;
    setBusy(true);
    const id = crypto.randomUUID();
    const data = { id, title: f.title.trim(), due_on: f.due || null, starts_on: f.start || null, priority: f.pr, category_id: f.cat || null, note: f.note.slice(0, 4000),
      ...(f.who ? { assignee: f.who } : {}), ...(init.source ? { source: init.source } : {}) };
    const { failed } = await runWrites([{ type: 'task', space, action: 'task.create', data }], space);
    setBusy(false);
    if (failed) showToast(t(failed)); else { showToast(t('views.taskCreated')); onClose(); onCreated?.(id); }
  };
  return <Modal open width={460} title={t('views.newTask')} onClose={onClose} footer={<>
    <button type="button" className="btn" onClick={onClose}>{t('views.cancel')}</button>
    <button type="submit" form={formId} className="btn primary" disabled={busy || !f.title.trim() || bad}>{t('views.create')}</button></>}>
    <form id={formId} className="vw-form" onSubmit={submit}>
      <input className="input" maxLength={200} value={f.title} placeholder={t('views.taskHint')} aria-label={t('views.f.title')} onChange={(e) => put({ title: e.target.value })} />
      <div className="tk-two">
        <label className="field-block"><span className="label">{t('views.f.due')}</span><input type="date" className="input" value={f.due} min={f.start || undefined} onChange={(e) => put({ due: e.target.value })} /></label>
        <label className="field-block"><span className="label">{t('task.f.start')}</span><input type="date" className="input" value={f.start} max={f.due || undefined} onChange={(e) => put({ start: e.target.value })} /></label>
      </div>
      {bad && <p className="tk-hint" role="alert">{t('task.badDates')}</p>}
      <div className="tk-two">
        <label className="field-block"><span className="label">{t('task.f.category')}</span><select className="input" value={f.cat} onChange={(e) => put({ cat: e.target.value })}>
          <option value="">{t('task.uncategorized')}</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <div className="field-block"><span className="label">{t('task.f.priority')}</span>
          <div className="seg" role="radiogroup" aria-label={t('task.f.priority')}>{V.PRIORITIES.map((p) => <button key={p} type="button" role="radio" aria-checked={f.pr === p} className={`seg-btn${f.pr === p ? ' on' : ''}`} onClick={() => put({ pr: p })}>{t(`task.pr.${p}`)}</button>)}</div></div>
      </div>
      {others.length > 0 && <label className="field-block"><span className="label">{t('views.f.assignee')}</span><select className="input" value={f.who} onChange={(e) => put({ who: e.target.value })}>
        <option value="">{t('views.me')}</option>{others.map((p) => <option key={p.user_id} value={p.user_id}>{p.name}</option>)}</select></label>}
      <label className="field-block"><span className="label">{t('task.f.note')}</span><textarea className="input area tk-note short" maxLength={4000} value={f.note} onChange={(e) => put({ note: e.target.value })} /></label>
    </form>
  </Modal>;
}
