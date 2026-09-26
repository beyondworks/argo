// 모듈 등록부 — 홈 격자에 놓이는 것은 전부 여기 한 줄씩. 직무별 템플릿(2차)·크루가 만드는 모듈(3차)도 여기에 항목을 더하는 것으로 끝난다.
import { useMemo } from 'react';
import { Face } from '../ui/Face.jsx';
import { Icon } from '../ui/Icon.jsx';
import { menuProps } from '../ui/Menu.jsx';
import { Link } from '../core/router.jsx';
import { t, ago } from '../core/i18n.js';
import { useStore, toggleTodo } from '../core/store.js';
import { baseOf, mailMenu, pageMenu, fileMenu, recordMenu } from '../core/commands.js';
import { CREWS, SPACES, OUTPUTS, JOURNAL } from '../data/sample.js';
import { fmtBytes } from '../core/files.js';

export const crewName = (id) => CREWS.find((c) => c.id === id)?.name ?? '';
const inSpace = (space) => (x) => space === 'me' || x.space === space;
const spaceName = (key) => SPACES.find((s) => s.key === key)?.name ?? '';

function Empty() { return <div className="mod-empty">{t('mod.empty')}</div>; }

function Approvals({ space }) {
  const list = useStore((s) => s.approvals);
  const rows = useMemo(() => list.filter(inSpace(space)), [list, space]);
  if (!rows.length) return <Empty />;
  return rows.slice(0, 4).map((a) => (
    <Link key={a.id} to={`${baseOf(space)}/approvals?open=${a.id}`} className="mod-row" {...menuProps(() => recordMenu(a, a.plain))}>
      <Face id={a.crew} size={18} />
      <span className="mod-main"><span className="clamp">{a.plain}</span><small>{crewName(a.crew)}{space === 'me' ? ` · ${spaceName(a.space)}` : ` · #${a.channel}`} · {ago(a.at)}</small></span>
      {a.risk === 'high' && <span className="badge warn">{t('risk.high')}</span>}
    </Link>
  ));
}

function Work({ space }) {
  const list = useStore((s) => s.work);
  const rows = useMemo(() => list.filter(inSpace(space)), [list, space]);
  if (!rows.length) return <Empty />;
  return rows.slice(0, 5).map((w) => (
    <div key={w.id} className="mod-row" {...menuProps(() => recordMenu(w, w.goal))}>
      <span className={`dot ${w.status === 'blocked' ? 'ask' : 'work'}`} />
      <span className="mod-main"><span className="clamp">{w.goal}</span><small>{crewName(w.lead)} · {w.status === 'blocked' ? `${t('status.blocked')} · ${w.blockedBy}` : t('status.running')}</small></span>
      <span className="mono dim">{w.steps}</span>
    </div>
  ));
}

function Mail() {
  const list = useStore((s) => s.mails);
  const rows = useMemo(() => list.filter((m) => m.folder === 'inbox' && m.unread), [list]);
  if (!rows.length) return <Empty />;
  return rows.map((m) => (
    <Link key={m.id} to={`/me/mail/${m.id}`} className="mod-row" {...menuProps(() => mailMenu(m))}>
      <span className="dot mark" />
      <span className="mod-main"><span className="clamp">{m.subject}</span><small>{m.from} · {ago(m.at)}</small></span>
    </Link>
  ));
}

function Todos() {
  const mails = useStore((s) => s.mails);
  const done = useStore((s) => s.todosDone);
  const rows = useMemo(() => mails.flatMap((m) => (m.note?.todos ?? []).map((text, i) => ({ key: `${m.id}:${i}`, text, crew: m.note.crew, from: m.subject }))), [mails]);
  if (!rows.length) return <Empty />;
  return rows.map((r) => (
    <label key={r.key} className={`mod-row todo${done[r.key] ? ' done' : ''}`}>
      <input type="checkbox" checked={!!done[r.key]} onChange={() => toggleTodo(r.key)} />
      <span className="mod-main"><span className="clamp">{r.text}</span><small>{crewName(r.crew)} · {r.from}</small></span>
    </label>
  ));
}

function Pages({ space }) {
  const pages = useStore((s) => s.pages);
  const rows = useMemo(() => pages.filter((p) => p.space === space).slice().sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated)).slice(0, 5), [pages, space]);
  if (!rows.length) return <Empty />;
  return rows.map((p) => (
    <Link key={p.id} to={`${baseOf(space)}/p/${p.id}`} className="mod-row" {...menuProps(() => pageMenu(p))}>
      <Icon name={p.restricted ? 'lock' : 'doc'} size={14} className="dim" />
      <span className="mod-main"><span className="clamp">{p.title || t('page.untitled')}</span></span>
      <small className="dim">{ago(p.updated)}</small>
    </Link>
  ));
}

function Outputs({ space }) {
  const rows = OUTPUTS.filter(inSpace(space));
  if (!rows.length) return <Empty />;
  return rows.slice(0, 5).map((f) => (
    <div key={f.id} className="mod-row" {...menuProps(() => fileMenu(f))}>
      <Icon name="file" size={14} className="dim" />
      <span className="mod-main"><span className="clamp mono-name">{f.name}</span><small>{crewName(f.crew)} · #{f.channel}</small></span>
      <small className="dim mono">{fmtBytes(f.bytes)}</small>
    </div>
  ));
}

function Journal({ space }) {
  const day = JOURNAL.find(inSpace(space));
  if (!day) return <Empty />;
  return <>
    <div className="mod-date mono">{day.date}</div>
    {day.entries.map((e, i) => (
      <div key={i} className="mod-row top"><Face id={e.crew} size={18} /><span className="mod-main"><span>{e.text}</span><small>{crewName(e.crew)}</small></span></div>
    ))}
  </>;
}

function Decisions({ space }) {
  const list = useStore((s) => s.decisions);
  const rows = useMemo(() => list.filter(inSpace(space)).slice(0, 5), [list, space]);
  if (!rows.length) return <Empty />;
  return rows.map((d) => (
    <div key={d.id} className="mod-row">
      <span className={`badge ${d.result === 'approved' ? 'ok' : 'danger'}`}>{t(`status.${d.result}`)}</span>
      <span className="mod-main"><span className="clamp">{d.plain}</span><small>{d.by} · {ago(d.at)}</small></span>
    </div>
  ));
}

// sizes: s=1/3, m=1/2, l=2/3, full=전체. spaces: 이 모듈을 쓸 수 있는 공간 종류.
export const MODULES = [
  { id: 'approvals', title: 'mod.approvals', icon: 'stamp', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'], link: '/approvals', render: Approvals },
  { id: 'mail', title: 'mod.mail', icon: 'mail', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me'], link: '/mail', render: Mail },
  { id: 'todos', title: 'mod.todos', icon: 'check', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me'], render: Todos },
  { id: 'pages', title: 'mod.pages', icon: 'doc', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'], render: Pages },
  { id: 'work', title: 'mod.work', icon: 'run', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'm', spaces: ['me', 'org'], link: '/work', render: Work },
  { id: 'outputs', title: 'mod.outputs', icon: 'file', sizes: ['m', 'l', 'full'], defaultSize: 'l', spaces: ['org'], link: '/outputs', render: Outputs },
  { id: 'journal', title: 'mod.journal', icon: 'book', sizes: ['s', 'm', 'l', 'full'], defaultSize: 's', spaces: ['org'], link: '/journal', render: Journal },
  { id: 'decisions', title: 'mod.decisions', icon: 'check', sizes: ['s', 'm', 'l', 'full'], defaultSize: 'full', spaces: ['org'], link: '/decisions', render: Decisions },
];

export const DEFAULTS = {
  me: [{ id: 'approvals', size: 'm' }, { id: 'mail', size: 'm' }, { id: 'todos', size: 'l' }, { id: 'pages', size: 's' }, { id: 'work', size: 'full' }],
  org: [{ id: 'approvals', size: 'm' }, { id: 'work', size: 'm' }, { id: 'outputs', size: 'l' }, { id: 'journal', size: 's' }, { id: 'decisions', size: 'full' }],
};
