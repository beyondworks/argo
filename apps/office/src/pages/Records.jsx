// 기록판 — 메신저에서 크루와 한 일을 읽어 보여 준다(P2: msgr_work_runs·msgr_crew_approvals·msgr_attachments·조직 문서).
import { useMemo } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Icon } from '../ui/Icon.jsx';
import { Face } from '../ui/Face.jsx';
import { menuProps, mergeHandlers } from '../ui/Menu.jsx';
import { Sheet, showToast } from '../ui/Overlay.jsx';
import { t, ago, useLang } from '../core/i18n.js';
import { useStore, decide } from '../core/store.js';
import { recordMenu, fileMenu } from '../core/commands.js';
import { fmtBytes } from '../core/files.js';
import { navigate } from '../core/router.jsx';
import { OUTPUTS, JOURNAL } from '../data/sample.js';
import { SPACES, ME } from '../core/session.js';
import { crewName } from './modules.jsx';

const inSpace = (space) => (x) => space === 'me' || x.space === space;
const spaceName = (key) => SPACES.find((s) => s.key === key)?.name ?? '';

function Title({ h, sub }) {
  return <div className="page-title-row"><div><h1 className="page-h1">{h}</h1>{sub && <p className="dim">{sub}</p>}</div></div>;
}

export function Approvals({ space, openId }) {
  useLang();
  const list = useStore((s) => s.approvals);
  const rows = useMemo(() => list.filter(inSpace(space)), [list, space]);
  const cur = rows.find((a) => a.id === openId);
  const close = () => navigate(location.pathname);
  const act = (result) => { decide(cur.id, result, ME.name); close(); showToast(t('ap.decided', { result: t(`status.${result}`) })); };
  return (
    <div className="page-wrap">
      <Title h={t('nav.approvals')} />
      {rows.length === 0 && <div className="empty-state"><Icon name="stamp" size={20} /><p>{t('ap.empty')}</p></div>}
      <div className="list">
        {rows.map((a) => (
          <button key={a.id} type="button" className={`ap-row${a.id === openId ? ' active' : ''}`} onClick={() => navigate(`${location.pathname}?open=${a.id}`)} {...menuProps(() => recordMenu(a, a.plain))}>
            <Face id={a.crew} size={22} />
            <span className="ap-main"><span className="ap-plain">{a.plain}</span><small>{t('ap.from', { crew: crewName(a.crew), channel: a.channel })}{space === 'me' ? ` · ${spaceName(a.space)}` : ''} · {ago(a.at)}</small></span>
            <span className={`badge ${a.risk === 'high' ? 'warn' : ''}`}>{t(`risk.${a.risk}`)}</span>
            <span className="btn sm">{t('ap.review')}</span>
          </button>
        ))}
      </div>
      <Sheet open={!!cur} onClose={close} title={t('nav.approvals')}
        footer={cur && <><button type="button" className="btn" onClick={() => act('rejected')}>{t('ap.reject')}</button><button type="button" className="btn primary" onClick={() => act('approved')}><Icon name="check" size={14} />{t('ap.approve')}</button></>}>
        {cur && <div className="ap-detail">
          <div className="ap-who"><Face id={cur.crew} size={28} /><div><b>{crewName(cur.crew)}</b><small className="dim">#{cur.channel} · {ago(cur.at)}</small></div><span className={`badge ${cur.risk === 'high' ? 'warn' : ''}`}>{t(`risk.${cur.risk}`)}</span></div>
          <p className="ap-big">{cur.plain}</p>
          <p>{cur.need}</p>
          <details className="ap-cmd"><summary>{t('ap.command')}</summary><pre>{cur.command}</pre></details>
          <p className="dim small">{cur.risk === 'high' ? t('ap.who') : t('ap.whoLow')}</p>
        </div>}
      </Sheet>
    </div>
  );
}

function Table({ cols, rows, render, rowProps }) {
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr>{cols.map((c) => <th key={c}>{t(c)}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id} {...(rowProps?.(r) ?? {})}>{render(r)}</tr>)}</tbody>
    </table></div>
  );
}

export function Work({ space }) {
  useLang();
  const list = useStore((s) => s.work);
  const rows = useMemo(() => list.filter(inSpace(space)), [list, space]);
  return (
    <div className="page-wrap wide">
      <Title h={t('nav.work')} />
      <Table cols={['col.goal', 'col.lead', 'col.status', 'col.progress', 'col.channel', 'col.started']} rows={rows} rowProps={(w) => menuProps(() => recordMenu(w, w.goal))}
        render={(w) => <>
          <td className="strong">{w.goal}</td>
          <td><span className="who"><Face id={w.lead} size={16} />{crewName(w.lead)}</span></td>
          <td><span className={`badge ${w.status === 'blocked' ? 'warn' : 'ok'}`}>{t(`status.${w.status}`)}</span>{w.blockedBy && <small className="dim"> · {w.blockedBy}</small>}</td>
          <td className="mono">{w.steps}</td><td className="dim">#{w.channel}</td><td className="dim">{ago(w.started)}</td>
        </>} />
    </div>
  );
}

export function Decisions({ space }) {
  useLang();
  const list = useStore((s) => s.decisions);
  const rows = useMemo(() => list.filter(inSpace(space)), [list, space]);
  return (
    <div className="page-wrap wide">
      <Title h={t('nav.decisions')} />
      <Table cols={['col.item', 'col.crew', 'col.result', 'col.by', 'col.date']} rows={rows}
        render={(d) => <>
          <td className="strong">{d.plain}</td>
          <td><span className="who"><Face id={d.crew} size={16} />{crewName(d.crew)}</span></td>
          <td><span className={`badge ${d.result === 'approved' ? 'ok' : 'danger'}`}>{t(`status.${d.result}`)}</span></td>
          <td>{d.by}</td><td className="dim">{ago(d.at)}</td>
        </>} />
    </div>
  );
}

function FileRow({ f }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `file:${f.id}`, data: { kind: 'file', id: f.id, label: f.name } });
  const { onTouchStart, ...mouse } = listeners ?? {};
  return (
    <tr ref={setNodeRef} className={isDragging ? 'ghost' : ''} {...attributes} {...mergeHandlers(mouse, menuProps(() => fileMenu(f)))}>
      <td className="strong"><span className="who"><Icon name="file" size={14} className="dim" /><span className="mono-name">{f.name}</span></span></td>
      <td><span className="who"><Face id={f.crew} size={16} />{crewName(f.crew)}</span></td>
      <td className="dim">#{f.channel}</td><td className="mono dim">{fmtBytes(f.bytes)}</td><td className="dim">{ago(f.at)}</td>
    </tr>
  );
}

export function Outputs({ space }) {
  useLang();
  const rows = OUTPUTS.filter(inSpace(space));
  return (
    <div className="page-wrap wide">
      <Title h={t('nav.outputs')} />
      <div className="table-wrap"><table className="table">
        <thead><tr>{['col.name', 'col.crew', 'col.channel', 'col.size', 'col.date'].map((c) => <th key={c}>{t(c)}</th>)}</tr></thead>
        <tbody>{rows.map((f) => <FileRow key={f.id} f={f} />)}</tbody>
      </table></div>
    </div>
  );
}

export function Journal({ space }) {
  useLang();
  const days = JOURNAL.filter(inSpace(space));
  return (
    <div className="page-wrap">
      <Title h={t('nav.journal')} />
      {days.map((d) => (
        <section key={d.date} className="journal-day">
          <h2 className="mono">{d.date}</h2>
          {d.entries.map((e, i) => <div key={i} className="journal-entry"><Face id={e.crew} size={22} /><div><b>{crewName(e.crew)}</b><p>{e.text}</p></div></div>)}
        </section>
      ))}
    </div>
  );
}
