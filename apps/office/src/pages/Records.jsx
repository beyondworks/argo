// 기록판 — 메신저에서 크루와 한 일을 읽어 보여 준다(P2: msgr_work_runs·msgr_crew_approvals·msgr_attachments·조직 문서).
import { useEffect, useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Icon } from '../ui/Icon.jsx';
import { Face } from '../ui/Face.jsx';
import { menuProps, mergeHandlers } from '../ui/Menu.jsx';
import { Sheet, showToast } from '../ui/Overlay.jsx';
import { t, ago, useLang } from '../core/i18n.js';
import { useStore, decide, crewName, approvalsIn } from '../core/store.js';
import { recordMenu, fileMenu } from '../core/commands.js';
import { fmtBytes, fileKind } from '../core/files.js';
import { getClient } from '../core/supabase.js';
import { isDesktop, saveAttachment } from '../core/platform.js';
import { setUi } from '../core/ui-state.js';
import { navigate } from '../core/router.jsx';
import { loadDocBody } from '../core/pull.js';
import { mdToDoc } from '../core/board.js';
import { DocView } from '../ui/DocView.jsx';
import { SPACES, ME } from '../core/session.js';

const inSpace = (space) => (x) => space === 'me' || x.space === space;
const spaceName = (key) => SPACES.find((s) => s.key === key)?.name ?? '';

function Title({ h, sub }) {
  return <div className="page-title-row"><div><h1 className="page-h1">{h}</h1>{sub && <p className="dim">{sub}</p>}</div></div>;
}

export function Approvals({ space, openId }) {
  useLang();
  const list = useStore((s) => s.approvals);
  const rows = useMemo(() => list.filter(approvalsIn(space)), [list, space]);
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
        footer={cur && cur.canDecide !== false && <><button type="button" className="btn" onClick={() => act('rejected')}>{t('ap.reject')}</button><button type="button" className="btn primary" onClick={() => act('approved')}><Icon name="check" size={14} />{t('ap.approve')}</button></>}>
        {cur && <div className="ap-detail">
          <div className="ap-who"><Face id={cur.crew} size={28} /><div><b>{crewName(cur.crew)}</b><small className="dim">#{cur.channel} · {ago(cur.at)}</small></div><span className={`badge ${cur.risk === 'high' ? 'warn' : ''}`}>{t(`risk.${cur.risk}`)}</span></div>
          <p className="ap-big">{cur.plain}</p>
          {cur.need && <p>{cur.need}</p>}
          {cur.command && <details className="ap-cmd"><summary>{t('ap.command')}</summary><pre>{cur.command}</pre></details>}
          <p className="dim small">{cur.canDecide === false ? t('ap.noRight') : cur.risk === 'high' ? t('ap.who') : t('ap.whoLow')}</p>
        </div>}
      </Sheet>
    </div>
  );
}

// 행을 누르면 ?open=id로 자세히 보기(유건 9/30: "뭐 눌러도 보이는 게 없다") — 결재함·공용 문서와 같은 방식
const openRow = (id) => ({ onClick: () => navigate(`${location.pathname}?open=${id}`), onKeyDown: (e) => { if (e.key === 'Enter') navigate(`${location.pathname}?open=${id}`); } });
const closeOpen = () => navigate(location.pathname);

function Table({ cols, rows, render, rowProps }) {
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr>{cols.map((c) => <th key={c}>{t(c)}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id} tabIndex={0} className="row-link" {...mergeHandlers(rowProps?.(r), openRow(r.id))}>{render(r)}</tr>)}</tbody>
    </table></div>
  );
}

/** 자세히 보기 한 줄 — 이름표와 값 */
const Fact = ({ k, children }) => children ? <div className="fact"><span className="dim">{t(k)}</span><span>{children}</span></div> : null;

export function Work({ space, openId }) {
  useLang();
  const list = useStore((s) => s.work);
  const rows = useMemo(() => list.filter(inSpace(space)), [list, space]);
  const cur = rows.find((w) => w.id === openId);
  return (
    <div className="page-wrap wide">
      <Title h={t('nav.work')} />
      <Table cols={['col.goal', 'col.lead', 'col.status', 'col.progress', 'col.channel', 'col.started']} rows={rows} rowProps={(w) => menuProps(() => recordMenu(w, w.goal))}
        render={(w) => <>
          <td className="strong">{w.goal}</td>
          <td><span className="who"><Face id={w.lead} size={16} />{crewName(w.lead)}</span></td>
          <td><span className={`badge ${w.status === 'blocked' ? 'warn' : 'ok'}`}>{t(`status.${w.status}`)}</span>{w.blockedBy && <small className="dim"> · {w.blockedBy}</small>}</td>
          <td className="mono">{w.steps ?? '—'}</td><td className="dim">{w.channel && `#${w.channel}`}</td><td className="dim">{ago(w.started)}</td>
        </>} />
      <Sheet open={!!cur} onClose={closeOpen} title={t('nav.work')}>
        {cur && <div className="ap-detail">
          <div className="ap-who"><Face id={cur.lead} size={28} /><div><b>{crewName(cur.lead)}</b><small className="dim">{[cur.channel && `#${cur.channel}`, ago(cur.started)].filter(Boolean).join(' · ')}</small></div><span className={`badge ${cur.status === 'blocked' ? 'warn' : 'ok'}`}>{t(`status.${cur.status}`)}</span></div>
          <p className="ap-big">{cur.goal}</p>
          <Fact k="work.done">{cur.done}</Fact>
        </div>}
      </Sheet>
    </div>
  );
}

export function Decisions({ space, openId }) {
  useLang();
  const list = useStore((s) => s.decisions);
  const rows = useMemo(() => list.filter(inSpace(space)), [list, space]);
  const cur = rows.find((d) => d.id === openId);
  return (
    <div className="page-wrap wide">
      <Title h={t('nav.decisions')} />
      <Table cols={['col.item', 'col.crew', 'col.result', 'col.by', 'col.date']} rows={rows}
        render={(d) => <>
          <td className="strong">{d.plain}</td>
          <td><span className="who"><Face id={d.crew} size={16} />{crewName(d.crew)}</span></td>
          <td><span className={`badge ${d.result === 'approved' ? 'ok' : 'danger'}`}>{t(`status.${d.result}`)}</span></td>
          <td>{d.by || '—'}</td><td className="dim">{ago(d.at)}</td>
        </>} />
      <Sheet open={!!cur} onClose={closeOpen} title={t('nav.decisions')}>
        {cur && <div className="ap-detail">
          <div className="ap-who"><Face id={cur.crew} size={28} /><div><b>{crewName(cur.crew)}</b><small className="dim">{[cur.channel && `#${cur.channel}`, cur.asked && ago(cur.asked)].filter(Boolean).join(' · ')}</small></div>{cur.risk && <span className={`badge ${cur.risk === 'high' ? 'warn' : ''}`}>{t(`risk.${cur.risk}`)}</span>}</div>
          <p className="ap-big">{cur.plain}</p>
          <Fact k="col.result"><span className={`badge ${cur.result === 'approved' ? 'ok' : 'danger'}`}>{t(`status.${cur.result}`)}</span></Fact>
          <Fact k="col.by">{[cur.by, ago(cur.at)].filter(Boolean).join(' · ')}</Fact>
          {cur.action && cur.action !== cur.plain && <details className="ap-cmd"><summary>{t('ap.command')}</summary><pre>{cur.action}</pre></details>}
        </div>}
      </Sheet>
    </div>
  );
}

function FileRow({ f }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `file:${f.id}`, data: { kind: 'file', id: f.id, label: f.name } });
  const { onTouchStart, onKeyDown: dragKey, ...mouse } = listeners ?? {};
  const keys = { onKeyDown: (e) => { if (e.key !== 'Enter') dragKey?.(e); } }; // Enter = 열기, Space = 키보드로 끌기(끌기 센서는 둘 다 시작 키로 본다)
  return (
    <tr ref={setNodeRef} className={`row-link${isDragging ? ' ghost' : ''}`} {...attributes} {...mergeHandlers(mouse, keys, menuProps(() => fileMenu(f)), openRow(f.id))}>
      <td className="strong"><span className="who"><Icon name="file" size={14} className="dim" /><span className="mono-name">{f.name}</span></span></td>
      <td><span className="who"><Face id={f.crew} size={16} />{crewName(f.crew)}</span></td>
      <td className="dim">{f.channel && `#${f.channel}`}</td><td className="mono dim">{fmtBytes(f.bytes)}</td><td className="dim">{ago(f.at)}</td>
    </tr>
  );
}

/** 산출물 파일 — 메신저와 같은 버킷(msgr)·같은 권한으로 서명 주소를 만든다(10분) */
async function signedUrl(path, options) {
  const sb = await getClient();
  const { data, error } = await sb.storage.from('msgr').createSignedUrl(path, 600, options);
  if (error) throw error;
  return data.signedUrl;
}
export async function downloadOutput(f) {
  if (!f.path) { showToast(t('file.sample')); return; }
  try {
    if (isDesktop()) { const r = await fetch(await signedUrl(f.path)); if (!r.ok) throw new Error('fetch'); await saveAttachment(await r.blob(), f.name); return; }
    Object.assign(document.createElement('a'), { href: await signedUrl(f.path, { download: f.name }) }).click();
  } catch { showToast(t('file.fail')); }
}
const TEXT_MAX = 512 * 1024; // 글 파일 미리보기 상한 — 넘으면 받아서 본다

function FileView({ f }) {
  const kind = fileKind(f.name, f.mime);
  const [st, setSt] = useState({});
  useEffect(() => {
    let live = true;
    setSt({});
    if (!f.path) { setSt({ note: 'file.sample' }); return undefined; }
    const text = kind === 'md' || kind === 'text';
    if (kind !== 'image' && !text) { setSt({ note: kind === 'pdf' ? null : 'file.noPreview' }); return undefined; }
    if (text && f.bytes > TEXT_MAX) { setSt({ note: 'file.tooBig' }); return undefined; }
    signedUrl(f.path).then(async (url) => {
      const body = text ? await fetch(url).then((r) => { if (!r.ok) throw new Error('fetch'); return r.text(); }) : null;
      if (live) setSt({ url, body });
    }).catch(() => { if (live) setSt({ note: 'file.fail' }); });
    return () => { live = false; };
  }, [f.id, f.path, f.bytes, kind]);
  if (st.note) return <p className="dim">{t(st.note)}</p>;
  if (kind === 'pdf') return <button type="button" className="btn" onClick={() => signedUrl(f.path).then((u) => window.open(u, '_blank', 'noopener')).catch(() => showToast(t('file.fail')))}><Icon name="file" size={14} />{t('file.openNew')}</button>;
  if (!st.url) return <div className="skeleton-lines"><span /><span /></div>;
  if (kind === 'image') return <img className="file-img" src={st.url} alt={f.name} />;
  if (kind === 'md') return <article className="prose"><DocView doc={mdToDoc(st.body)} /></article>;
  return <pre className="file-text">{st.body}</pre>;
}

export function Outputs({ space, openId }) {
  useLang();
  const all = useStore((s) => s.outputs);
  const rows = useMemo(() => all.filter(inSpace(space)), [all, space]);
  const cur = rows.find((f) => f.id === openId);
  return (
    <div className="page-wrap wide">
      <Title h={t('nav.outputs')} />
      <div className="table-wrap"><table className="table">
        <thead><tr>{['col.name', 'col.crew', 'col.channel', 'col.size', 'col.date'].map((c) => <th key={c}>{t(c)}</th>)}</tr></thead>
        <tbody>{rows.map((f) => <FileRow key={f.id} f={f} />)}</tbody>
      </table></div>
      <Sheet open={!!cur} onClose={closeOpen} title={cur?.name ?? ''}
        footer={cur && <><button type="button" className="btn" onClick={() => setUi({ assign: { space: cur.space, items: [{ kind: 'file', id: cur.id, label: cur.name }] } })}><Icon name="hand" size={14} />{t('file.sendCrew')}</button><button type="button" className="btn primary" onClick={() => downloadOutput(cur)}><Icon name="file" size={14} />{t('file.download')}</button></>}>
        {cur && <div className="doc-read">
          <p className="dim small">{[crewName(cur.crew), cur.channel && `#${cur.channel}`, fmtBytes(cur.bytes), ago(cur.at)].filter(Boolean).join(' · ')}</p>
          <FileView key={cur.id} f={cur} />
        </div>}
      </Sheet>
    </div>
  );
}

const DAY_SHOW = 20; // 하루에 먼저 보이는 건수 — 나머지는 "더 보기"(유건 9/30: 끝없는 스크롤이 피곤하다)

function JournalDay({ d }) {
  const [shown, setShown] = useState(DAY_SHOW), [open, setOpen] = useState(() => new Set());
  const list = useMemo(() => d.entries.slice().reverse(), [d.entries]); // 최근 것 먼저
  const toggle = (i) => setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  return (
    <section className="journal-day">
      <h2 className="mono">{d.date} <span className="dim">· {t('journal.count', { n: list.length })}</span></h2>
      {list.slice(0, shown).map((e, i) => (
        <button key={i} type="button" className={`journal-entry${open.has(i) ? ' open' : ''}`} aria-expanded={open.has(i)} onClick={() => toggle(i)}>
          <Face id={e.crew} size={22} /><div><b>{crewName(e.crew) || e.name}</b>{e.time && <small className="dim mono"> {e.time}</small>}<p className={open.has(i) ? '' : 'clamp three'}>{e.text}</p></div>
        </button>))}
      {list.length > shown && <button type="button" className="btn journal-more" onClick={() => setShown((n) => n + DAY_SHOW)}>{t('journal.more', { n: list.length - shown })}</button>}
    </section>
  );
}

export function Journal({ space }) {
  useLang();
  const all = useStore((s) => s.journal);
  const days = useMemo(() => all.filter(inSpace(space)), [all, space]);
  return (
    <div className="page-wrap">
      <Title h={t('nav.journal')} />
      {days.map((d) => <JournalDay key={`${d.space}|${d.date}`} d={d} />)}
    </div>
  );
}

const FOLDERS = ['rules', 'glossary', 'projects'];

/** 크루 공용 문서(메신저 조직 문서 — 규칙·용어·프로젝트). 편집은 메신저에서(문서 변경은 결재를 거친다) — 오피스는 읽기 */
export function Docs({ space, openId }) {
  useLang();
  const all = useStore((s) => s.docs);
  const rows = useMemo(() => all.filter(inSpace(space)), [all, space]);
  const cur = rows.find((d) => d.id === openId);
  const [body, setBody] = useState(undefined);
  useEffect(() => { let live = true; setBody(undefined); if (openId) loadDocBody(openId).then((b) => live && setBody(b)); return () => { live = false; }; }, [openId]);
  const close = () => navigate(location.pathname);
  return (
    <div className="page-wrap">
      <Title h={t('nav.docs')} sub={t('docs.sub')} />
      {rows.length === 0 && <div className="empty-state"><Icon name="book" size={20} /><p>{t('docs.empty')}</p></div>}
      {FOLDERS.map((f) => { const list = rows.filter((d) => d.folder === f); return list.length > 0 && (
        <section key={f} className="doc-group">
          <h2 className="label">{t(`docs.${f}`)}</h2>
          <div className="list">{list.map((d) => (
            <button key={d.id} type="button" className={`list-row${d.id === openId ? ' on' : ''}`} onClick={() => navigate(`${location.pathname}?open=${d.id}`)}>
              <Icon name="doc" size={14} className="dim" /><span className="grow">{d.title}</span><small className="dim">{[d.channel && `#${d.channel}`, ago(d.updated)].filter(Boolean).join(' · ')}</small>
            </button>))}
          </div>
        </section>); })}
      <Sheet open={!!cur} onClose={close} title={cur?.title ?? ''}>
        {cur && <div className="doc-read">
          <p className="dim small mono">{cur.path}</p>
          {body === undefined ? <div className="skeleton-lines"><span /><span /></div> : body ? <article className="prose"><DocView doc={mdToDoc(body)} /></article> : <p className="dim">{t('docs.empty')}</p>}
          <p className="dim small">{t('docs.readOnly')}</p>
        </div>}
      </Sheet>
    </div>
  );
}
