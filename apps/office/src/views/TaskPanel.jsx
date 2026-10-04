// 할 일 상세 — 오른쪽 패널(ui/Panel.jsx)에서 제목·상태·중요도·분류·맡은 사람·시작일·기한·메모를 한곳에서 보고 고친다(유건 10/4, 오피스 14차 트랙 T).
// 저장 단추가 없다: 고르는 칸은 고를 때, 글 칸(제목·메모)은 칸을 벗어날 때 바로 저장한다. 실패하면 화면을 되돌리고 이유를 알린다.
// 권한은 서버 office_task_write와 같다(views/model.js taskCan) — 고칠 수 없는 칸은 잠그고, 왜 잠겼는지 한 줄로 알린다.
// 바뀐 기록(office_task_events)은 이 패널 아래에서 본다. 부하: 열 때 기록 한 번, 고칠 때마다 쓰기 한 번 + 목록·기록 다시 읽기 한 번. 폴링 없음.
import { useEffect, useMemo, useRef, useState } from 'react';
import { t, registerDict, useLang, getLang } from '../core/i18n.js';
import { canManage, SPACES } from '../core/session.js';
import { navigate } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import { Panel } from '../ui/Panel.jsx';
import { showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import * as V from './model.js';
import { useViewTasks, usePeople, makeCtx, runWrites, useTaskCategories, categoriesOf, loadTaskHistory } from './data.js';
import { kstDay } from '../core/task-model.js';
import { TASK_DICT } from '../pages/task-i18n.js';
import { VIEWS_DICT } from './views-i18n.js';
import './views.css';

registerDict({ ...TASK_DICT, ...VIEWS_DICT });

const locale = () => (getLang() === 'en' ? 'en-US' : 'ko-KR');
const day = (d) => new Date(`${d}T00:00:00+09:00`).toLocaleDateString(locale(), { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' });
const stamp = (iso) => new Date(iso).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' });
const FIELD_OF = { title: 'task.f.title', due: 'task.f.due', start: 'task.f.start', assign: 'task.f.assignee', status: 'task.f.status', priority: 'task.f.priority', category: 'task.f.category' };
/** 바뀐 기록 한 줄의 글 */
export function historyLine(h) {
  if (!FIELD_OF[h.kind]) return t(`task.h.${h.kind}`);
  const val = (v) => {
    if (v == null || v === '') return t('task.h.none');
    if (h.kind === 'status') return t(`task.st.${v}`);
    if (h.kind === 'priority') return t(`task.pr.${v}`);
    if (h.kind === 'due' || h.kind === 'start') return /^\d{4}-\d{2}-\d{2}$/.test(v) ? day(v) : v;
    return v;
  };
  return t('task.h.change', { field: t(FIELD_OF[h.kind]), from: val(h.from), to: val(h.to) });
}

/** space: 보고 있는 공간(개인 공간이면 조직에서 맡겨진 일도 있다), id·taskSpace: 연 할 일. onManageCats가 있으면 분류 칸 옆에 '분류 관리' */
export default function TaskPanel({ space, id, taskSpace, onClose, onManageCats }) {
  useLang();
  const tasks = useViewTasks(space), people = usePeople(space);
  const row = tasks.find((x) => x.id === id && (!taskSpace || x.space === taskSpace));
  const ts = row?.space ?? taskSpace ?? space;
  useTaskCategories([ts]);
  const today = kstDay();
  const ctx = useMemo(() => makeCtx(today, people), [today, people]);
  const [rev, setRev] = useState(0), [hist, setHist] = useState(null), [histFail, setHistFail] = useState(false);
  const [saving, setSaving] = useState(0), [ask, setAsk] = useState(false);
  const [title, setTitle] = useState(row?.title ?? ''), [note, setNote] = useState(row?.note ?? '');
  const editing = useRef(new Set()); // 지금 고치는 글 칸 — 다시 읽은 값이 친 글자를 덮지 않게
  const seen = useRef(false);
  useEffect(() => { let live = true; setHistFail(false); loadTaskHistory(ts, id).then((h) => { if (live) setHist(h); }, () => { if (live) setHistFail(true); }); return () => { live = false; }; }, [ts, id, rev]);
  useEffect(() => { if (row && !editing.current.has('title')) setTitle(row.title); }, [row?.title]);
  useEffect(() => { if (row && !editing.current.has('note')) setNote(row.note ?? ''); }, [row?.note]);
  useEffect(() => { if (row) seen.current = true; else if (seen.current) onClose(); }, [!!row]); // 취소하면 목록에서 빠진다 — 패널도 닫는다
  const latest = useRef(null);
  useEffect(() => () => { // 글 칸에 커서를 둔 채 Esc·바깥 누르기로 닫으면 칸을 벗어나는 일이 생기지 않는다 — 닫을 때 남은 글을 저장한다
    const cur = latest.current;
    if (!cur) return;
    for (const [field, value] of [['title', cur.title], ['note', cur.note]]) {
      if (!editing.current.has(field)) continue;
      const plan = V.planField(cur.it, field, value, cur.ctx), writes = V.writesOf(plan);
      if (!plan.reason && writes.length) runWrites(writes, space).then(({ failed }) => { if (failed) showToast(t(failed)); });
    }
  }, []);

  if (!row) return <Panel title={t('task.panel')} onClose={onClose}><p className="mod-empty" role="status">…</p></Panel>;
  const it = V.taskItem(row);
  latest.current = { it, title, note, ctx };
  const admin = ts !== 'me' && canManage(ts);
  const may = (action) => V.taskCan(action, row, ctx.me, admin);
  const canEdit = (field) => !it.done && may(V.FIELD_ACTION[field]);
  const canStatus = may('task.status'), canAssign = !it.done && admin;
  const anyEdit = ['title', 'note', 'priority', 'category', 'starts_on', 'due_on'].some(canEdit);
  const cats = categoriesOf(ts);
  const others = people.list(ts).filter((p) => p.role !== 'guest');

  /** 계획대로 쓴다 — 한 건이면 목록에 먼저 보이고(실패하면 되돌린다), 끝나면 기록을 다시 읽는다. 성공하면 true */
  const save = async (plan) => {
    if (plan.reason) { showToast(t(`views.why.${plan.reason}`)); return false; }
    const writes = V.writesOf(plan);
    if (!writes.length) return true;
    setSaving((n) => n + 1);
    const { failed } = await runWrites(writes, space);
    setSaving((n) => n - 1);
    if (failed) { showToast(t(failed)); return false; }
    setRev((r) => r + 1);
    return true;
  };
  const text = (field, value, reset) => async () => {
    editing.current.delete(field);
    if (!(await save(V.planField(it, field, value, ctx)))) reset(field === 'title' ? row.title : row.note ?? '');
  };
  const spaceName = ts === 'me' ? '' : SPACES.find((s) => s.key === ts)?.name;
  const page = row.source?.kind === 'page' && typeof row.source.page_id === 'string' ? row.source.page_id : null;
  const hint = it.done ? (canStatus ? t('task.doneLock') : t('task.viewOnly')) : !anyEdit ? (canStatus ? t('task.assigned') : t('task.viewOnly')) : '';
  const badDates = row.starts_on && row.due_on && row.starts_on > row.due_on;

  return <Panel title={spaceName ? `${t('task.panel')} · ${spaceName}` : t('task.panel')} onClose={onClose} footer={<>
    <span className="tk-save dim small" role="status" aria-live="polite">{saving ? t('task.saving') : ''}</span>
    {!it.done && may('task.cancel') && (ask
      ? <><span className="small">{t('task.cancelBody')}</span><button type="button" className="btn" onClick={() => setAsk(false)}>{t('task.close')}</button>
        <button type="button" className="btn danger" onClick={async () => { if (await save(V.planDelete(it, ctx))) { showToast(t('task.cancelled')); onClose(); } }}>{t('task.cancel')}</button></>
      : <button type="button" className="btn ghost tk-cancel" onClick={() => setAsk(true)}><Icon name="x" size={13} />{t('task.cancel')}</button>)}
  </>}>
    <div className="tk-panel">
      <input className="input tk-title-in" value={title} maxLength={200} aria-label={t('task.f.title')} disabled={!canEdit('title')}
        onFocus={() => editing.current.add('title')} onChange={(e) => setTitle(e.target.value)} onBlur={text('title', title, setTitle)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur(); }} />
      {hint && <p className="tk-hint" role="note">{hint}</p>}
      <div className="tk-fields">
        <span className="label" id={`tk-st-${id}`}>{t('task.f.status')}</span>
        <div className="seg" role="radiogroup" aria-labelledby={`tk-st-${id}`}>
          {[...V.STATUSES, 'done'].map((s) => <button key={s} type="button" role="radio" aria-checked={it.status === s} className={`seg-btn${it.status === s ? ' on' : ''}`}
            disabled={s === 'done' ? !may('task.done') : !canStatus} onClick={() => save(V.planStatus(it, s, ctx))}>{t(`task.st.${s}`)}</button>)}
        </div>
        <span className="label" id={`tk-pr-${id}`}>{t('task.f.priority')}</span>
        <div className="seg" role="radiogroup" aria-labelledby={`tk-pr-${id}`}>
          {V.PRIORITIES.map((p) => <button key={p} type="button" role="radio" aria-checked={it.priority === p} className={`seg-btn${it.priority === p ? ' on' : ''}`}
            disabled={!canEdit('priority')} onClick={() => save(V.planField(it, 'priority', p, ctx))}>{t(`task.pr.${p}`)}</button>)}
        </div>
        <label className="label" htmlFor={`tk-cat-${id}`}>{t('task.f.category')}</label>
        <span className="tk-row">
          <select id={`tk-cat-${id}`} className="input" value={row.category_id ?? ''} disabled={!canEdit('category')}
            onChange={(e) => { const c = cats.find((x) => x.id === e.target.value); save(V.planTaskCategory(it, c?.id ?? null, c?.name ?? '', ctx)); }}>
            <option value="">{t('task.uncategorized')}</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {row.category_id && !cats.some((c) => c.id === row.category_id) && <option value={row.category_id}>{row.category || '…'}</option>}
          </select>
          {onManageCats && (ts === space) && (ts === 'me' || admin) && <button type="button" className="btn ghost sm" onClick={onManageCats}><Icon name="tag" size={13} />{t('task.manageCats')}</button>}
        </span>
        <label className="label" htmlFor={`tk-who-${id}`}>{t('task.f.assignee')}</label>
        {canAssign && others.length > 1
          ? <select id={`tk-who-${id}`} className="input" value={row.assignee} onChange={(e) => save(V.planAssign(it, e.target.value, ctx))}>
            {!others.some((p) => p.user_id === row.assignee) && <option value={row.assignee}>{people.name(`p:${row.assignee}`)}</option>}
            {others.map((p) => <option key={p.user_id} value={p.user_id}>{p.user_id === ctx.me ? t('task.me') : p.name}</option>)}</select>
          : <span id={`tk-who-${id}`} className="tk-value">{row.assignee === ctx.me ? t('task.me') : people.name(`p:${row.assignee}`)}</span>}
        <label className="label" htmlFor={`tk-start-${id}`}>{t('task.f.start')}</label>
        <input id={`tk-start-${id}`} type="date" className="input tk-date" value={row.starts_on ?? ''} max={row.due_on ?? undefined} disabled={!canEdit('starts_on')}
          onChange={(e) => save(V.planField(it, 'starts_on', e.target.value || null, ctx))} />
        <label className="label" htmlFor={`tk-due-${id}`}>{t('task.f.due')}</label>
        <input id={`tk-due-${id}`} type="date" className="input tk-date" value={row.due_on ?? ''} min={row.starts_on ?? undefined} disabled={!canEdit('due_on')}
          onChange={(e) => save(V.planField(it, 'due_on', e.target.value || null, ctx))} />
      </div>
      {badDates && <p className="tk-hint" role="alert">{t('task.badDates')}</p>}
      <label className="field-block">
        <span className="label">{t('task.f.note')}</span>
        <textarea className="input area tk-note" value={note} maxLength={4000} placeholder={canEdit('note') ? t('task.notePh') : ''} disabled={!canEdit('note')}
          onFocus={() => editing.current.add('note')} onChange={(e) => setNote(e.target.value)} onBlur={text('note', note, setNote)} />
      </label>
      {page && <p className="tk-hint">{t('task.fromPage')} · <button type="button" className="link-btn" onClick={() => { onClose(); navigate(`${baseOf(ts)}/p/${page}`); }}>{t('task.openPage')}</button></p>}
      <section className="tk-hist" aria-label={t('task.history')}>
        <h3>{t('task.history')}</h3>
        {hist === null ? <p className="tk-hint" role="status">{histFail ? t('task.historyFail') : '…'}</p>
          : !hist.length ? <p className="tk-hint">{t('task.historyEmpty')}</p>
            : <ol>{hist.map((h, i) => <li key={`${h.at}:${i}`}><span className="tk-hist-who">{h.name || '?'}</span> <span>{historyLine(h)}</span> <time className="dim" dateTime={h.at}>{stamp(h.at)}</time></li>)}</ol>}
      </section>
    </div>
  </Panel>;
}
