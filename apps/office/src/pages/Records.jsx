// 기록판 — 메신저에서 크루와 한 일을 읽어 보여 준다(P2: msgr_work_runs·msgr_crew_approvals·msgr_attachments·조직 문서).
import { useEffect, useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Icon } from '../ui/Icon.jsx';
import { Face } from '../ui/Face.jsx';
import { menuProps, mergeHandlers } from '../ui/Menu.jsx';
import { showToast } from '../ui/Overlay.jsx';
import { Sheet } from '../ui/Panel.jsx';
import { t, ago, useLang, registerDict } from '../core/i18n.js';
import { RECORDS_DICT } from './records-i18n.js';
import { useStore, decide, crewName, approvalsIn } from '../core/store.js';
import { recordMenu, fileMenu } from '../core/commands.js';
import { fmtBytes, fileKind } from '../core/files.js';
import { getClient } from '../core/supabase.js';
import { isDesktop, saveAttachment } from '../core/platform.js';
import { setUi } from '../core/ui-state.js';
import { navigate } from '../core/router.jsx';
import { loadDocBody } from '../core/pull.js';
import { mdToDoc } from '../core/board.js';
import { folderKey, isoDay, byDate, journalDigest, fileGroup, canQuickDecide } from '../core/folders.js';
import { FolderView, DateSections, useFolder, folderName, FolderIcon, openItem, closeItem, pickFolder, when, countText } from '../ui/FolderView.jsx';
import { kstDay } from '../core/task-model.js';
import { DocView } from '../ui/DocView.jsx';
import { SPACES, ME } from '../core/session.js';
import { useSelection, selProps } from '../core/selection.js';

registerDict(RECORDS_DICT);

const inSpace = (space) => (x) => space === 'me' || x.space === space;
const spaceName = (key) => SPACES.find((s) => s.key === key)?.name ?? '';
/** 여러 개 고르기(11차) — 고른 기록을 한 번에 크루에게 맡기기(기록 메뉴의 단일 동작과 같은 창). 공간이 섞이면(내 공간 모아 보기) 맡길 곳이 하나가 아니라 뺀다 */
const assignMany = (list, label) => {
  const spaces = new Set(list.map((x) => x.space));
  return list.length > 0 && spaces.size === 1 && { label: t('crew.assign'), icon: 'hand', run: (_, clear) => { setUi({ assign: { space: list[0].space, items: list.map((x) => ({ kind: 'record', id: x.id, label: label(x) })) } }); clear(); } };
};

function Title({ h, sub }) {
  return <div className="page-title-row"><div><h1 className="page-h1">{h}</h1>{sub && <p className="dim">{sub}</p>}</div></div>;
}

// 폴더 보기 공통(유건 9/30) — 에이전트별 폴더, 날짜 구간, 한 줄 요약. 누르면 지금의 자세히 보기(Sheet)가 열린다.
const crewKey = (x) => folderKey(x.crew);
const atMs = (x) => Date.parse(x.at ?? '') || 0;
const byDay = (x) => isoDay(x.at);

/** 결정 한 줄 — 내용 한 줄 말줄임 + 배지 + 시각. 전체 폴더에서만 얼굴을 붙인다 */
function RecRow({ x, all, bucket, active, badges, extra, sel }) {
  return (
    <button type="button" className={`rec-row${active ? ' on' : ''}`} {...selProps(sel, x.id)} onClick={() => openItem(x.id)}>
      {all && <FolderIcon id={crewKey(x)} size={20} />}
      <span className="rec-text">{x.plain}</span>
      {badges}
      <small className="rec-when">{[extra, when(atMs(x), bucket)].filter(Boolean).join(' · ')}</small>
    </button>
  );
}

/** 위험도 배지 — 결재가 보이는 모든 곳이 같은 문구(risk.*)와 색(가장 높은 등급만 warn) */
const Risk = ({ risk }) => <span className={`badge ${risk === 'high' ? 'warn' : ''}`}>{t(`risk.${risk}`)}</span>;
/** 결정 — 카드 버튼과 상세 창이 같은 경로(store.decide → 전송함 approval.decide) */
const decideAp = (a, result) => { decide(a.id, result, ME.name); showToast(t('ap.decided', { result: t(`status.${result}`) })); };

/** 결재 카드(유건 9/30 #7) — 한 줄 핵심(에이전트가 적은 목적·할 일, 없으면 요청 앞부분) + 바로 승인·거절.
 *  위험도가 가장 높은 것은 버튼 대신 '열어서 확인'(상세 창에서 명령까지 보고 결정). 결정 권한이 없으면 버튼이 없다 */
function ApRow({ a, all, bucket, active, extra, sel }) {
  return (
    <div className={`rec-row ap-row${active ? ' on' : ''}`} {...selProps(sel, a.id)} {...menuProps(() => recordMenu(a, a.plain))}>
      <button type="button" className="ap-open" data-sel-body="" onClick={() => openItem(a.id)}>
        {all && <FolderIcon id={crewKey(a)} size={20} />}
        <span className="rec-text">{a.head || a.plain}</span>
        <Risk risk={a.risk} />
        <small className="rec-when">{[extra, when(atMs(a), bucket)].filter(Boolean).join(' · ')}</small>
      </button>
      {a.canDecide !== false && <span className="ap-quick">{canQuickDecide(a)
        ? <><button type="button" className="btn sm" onClick={() => decideAp(a, 'rejected')}>{t('ap.reject')}</button><button type="button" className="btn sm primary" onClick={() => decideAp(a, 'approved')}>{t('ap.approve')}</button></>
        : <button type="button" className="btn sm" onClick={() => openItem(a.id)}>{t('ap.open')}</button>}</span>}
    </div>
  );
}

export function Approvals({ space, openId, folder }) {
  useLang();
  const list = useStore((s) => s.approvals);
  const rows = useMemo(() => list.filter(approvalsIn(space)), [list, space]);
  const { folders, current, visible } = useFolder(rows, crewKey, atMs, folder);
  const cur = rows.find((a) => a.id === openId);
  const act = (result) => { decideAp(cur, result); closeItem(); };
  // 여러 개 승인·거절(11차) — 카드의 바로 승인·거절과 같은 경로. 위험도가 가장 높은 것은 카드처럼 열어서 확인해야 해 건너뛰고 알린다
  const [sel] = useSelection('approvals', { keys: visible.map((a) => a.id), actions: (keys) => {
    const mine = rows.filter((a) => keys.includes(a.id) && a.canDecide !== false), quick = mine.filter(canQuickDecide);
    const many = (result) => (_, clear) => {
      quick.forEach((a) => decide(a.id, result, ME.name));
      const skip = mine.length - quick.length;
      showToast([quick.length && t('sel.decided', { n: quick.length, result: t(`status.${result}`) }), skip && t('sel.skipped', { n: skip })].filter(Boolean).join(' · '));
      clear();
    };
    return [quick.length > 0 && { label: t('ap.reject'), run: many('rejected') }, quick.length > 0 && { label: t('ap.approve'), icon: 'check', run: many('approved') }, assignMany(rows.filter((a) => keys.includes(a.id)), (a) => a.plain)];
  } });
  return (
    <div className="page-wrap wide">
      <Title h={t('nav.approvals')} />
      {rows.length === 0 ? <div className="empty-state"><Icon name="stamp" size={20} /><p>{t('ap.empty')}</p></div> : (
        <FolderView folders={folders} current={current} total={rows.length} human="fold.people">
          <div data-sel-scope="approvals"><DateSections groups={byDate(visible, byDay, kstDay())} render={(g) => g.items.map((a) => (
            <ApRow key={a.id} a={a} all={current === 'all'} bucket={g.key} active={a.id === openId} sel={sel} extra={space === 'me' ? spaceName(a.space) : ''} />))} /></div>
        </FolderView>)}
      <Sheet open={!!cur} onClose={closeItem} title={t('nav.approvals')}
        footer={cur && cur.canDecide !== false && <><button type="button" className="btn" onClick={() => act('rejected')}>{t('ap.reject')}</button><button type="button" className="btn primary" onClick={() => act('approved')}><Icon name="check" size={14} />{t('ap.approve')}</button></>}>
        {cur && <div className="ap-detail">
          <div className="ap-who"><FolderIcon id={crewKey(cur)} size={28} /><div><b>{folderName(crewKey(cur), 'fold.people')}</b><small className="dim">#{cur.channel} · {ago(cur.at)}</small></div><Risk risk={cur.risk} /></div>
          <p className="ap-big">{cur.head || cur.plain}</p>
          {cur.head && cur.head !== cur.plain && <p><span className="dim small">{t('ap.request')}</span><br />{cur.plain}</p>}
          {cur.need && <p>{cur.need}</p>}
          {cur.command && <details className="ap-cmd"><summary>{t('ap.command')}</summary><pre>{cur.command}</pre></details>}
          <p className="dim small">{cur.canDecide === false ? t('ap.noRight') : cur.risk === 'high' ? t('ap.who') : t('ap.whoLow')}</p>
        </div>}
      </Sheet>
    </div>
  );
}

// 행을 누르면 ?open=id로 자세히 보기(유건 9/30: "뭐 눌러도 보이는 게 없다") — 결재함·공용 문서와 같은 방식
const openRow = (id) => ({ onClick: () => openItem(id), onKeyDown: (e) => { if (e.key === 'Enter') openItem(id); } }); // ?folder=는 그대로 둔다
const closeOpen = closeItem;

function Table({ cols, rows, render, rowProps, sel, scope }) {
  return (
    <div className="table-wrap" data-sel-scope={scope}><table className="table">
      <thead><tr>{cols.map((c) => <th key={c}>{t(c)}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id} tabIndex={0} className="row-link" {...(sel ? selProps(sel, r.id) : {})} {...mergeHandlers(rowProps?.(r), openRow(r.id))}>{render(r)}</tr>)}</tbody>
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
  const [sel] = useSelection('work', { keys: rows.map((w) => w.id), actions: (keys) => [assignMany(rows.filter((w) => keys.includes(w.id)), (w) => w.goal)] });
  return (
    <div className="page-wrap wide">
      <Title h={t('nav.work')} />
      <Table scope="work" sel={sel} cols={['col.goal', 'col.lead', 'col.status', 'col.progress', 'col.channel', 'col.started']} rows={rows} rowProps={(w) => menuProps(() => recordMenu(w, w.goal))}
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

export function Decisions({ space, openId, folder }) {
  useLang();
  const list = useStore((s) => s.decisions);
  const rows = useMemo(() => list.filter(inSpace(space)), [list, space]);
  const { folders, current, visible } = useFolder(rows, crewKey, atMs, folder);
  const cur = rows.find((d) => d.id === openId);
  const [sel] = useSelection('decisions', { keys: visible.map((d) => d.id), actions: (keys) => [assignMany(rows.filter((d) => keys.includes(d.id)), (d) => d.plain)] });
  return (
    <div className="page-wrap wide">
      <Title h={t('nav.decisions')} />
      {rows.length === 0 ? <div className="empty-state"><Icon name="check" size={20} /><p>{t('fold.empty')}</p></div> : (
        <FolderView folders={folders} current={current} total={rows.length} human="fold.people">
          <div data-sel-scope="decisions"><DateSections groups={byDate(visible, byDay, kstDay())} render={(g) => g.items.map((d) => (
            <RecRow key={d.id} x={d} all={current === 'all'} bucket={g.key} active={d.id === openId} sel={sel} extra={space === 'me' ? spaceName(d.space) : ''}
              badges={<>{d.risk && <Risk risk={d.risk} />}<span className={`badge ${d.result === 'approved' ? 'ok' : 'danger'}`}>{t(`status.${d.result}`)}</span></>} />))} /></div>
        </FolderView>)}
      <Sheet open={!!cur} onClose={closeOpen} title={t('nav.decisions')}>
        {cur && <div className="ap-detail">
          <div className="ap-who"><FolderIcon id={crewKey(cur)} size={28} /><div><b>{folderName(crewKey(cur), 'fold.people')}</b><small className="dim">{[cur.channel && `#${cur.channel}`, cur.asked && ago(cur.asked)].filter(Boolean).join(' · ')}</small></div>{cur.risk && <Risk risk={cur.risk} />}</div>
          <p className="ap-big">{cur.plain}</p>
          <Fact k="col.result"><span className={`badge ${cur.result === 'approved' ? 'ok' : 'danger'}`}>{t(`status.${cur.result}`)}</span></Fact>
          <Fact k="col.by">{[cur.by, ago(cur.at)].filter(Boolean).join(' · ')}</Fact>
          {cur.action && cur.action !== cur.plain && <details className="ap-cmd"><summary>{t('ap.command')}</summary><pre>{cur.action}</pre></details>}
        </div>}
      </Sheet>
    </div>
  );
}

function FileRow({ f, all, bucket, sel, group }) {
  // 고른 산출물을 끌면 고른 것 전부가 크루에게 간다(11차, items)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `file:${f.id}`, data: { kind: 'file', id: f.id, label: group?.length > 1 && sel.has(f.id) ? t('sel.count', { n: group.length }) : f.name, items: group?.length > 1 && sel.has(f.id) ? group : undefined } });
  const { onTouchStart, onKeyDown: dragKey, ...mouse } = listeners ?? {};
  const keys = { onKeyDown: (e) => { if (e.key !== 'Enter') dragKey?.(e); } }; // Enter = 열기, Space = 키보드로 끌기(끌기 센서는 둘 다 시작 키로 본다)
  return (
    <div ref={setNodeRef} className={`rec-row file-row${isDragging ? ' ghost' : ''}`} {...attributes} {...selProps(sel, f.id)} {...mergeHandlers(mouse, keys, menuProps(() => fileMenu(f)), openRow(f.id))}>
      <Icon name={fileGroup(f.name, f.mime) === 'image' ? 'box' : 'file'} size={14} className="dim" />
      <span className="rec-text mono-name">{f.name}</span>
      {all && <span className="who rec-who"><FolderIcon id={crewKey(f)} size={16} />{folderName(crewKey(f), 'fold.human')}</span>}
      <small className="rec-when"><span className="mono">{fmtBytes(f.bytes)}</span> · {when(atMs(f), bucket)}</small>
    </div>
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

const KINDS = ['all', 'doc', 'image', 'other'];
const fileItems = (list) => list.map((f) => ({ kind: 'file', id: f.id, label: f.name }));
const outKey = (f) => folderKey(f.crew);

export function Outputs({ space, openId, folder }) {
  useLang();
  const all = useStore((s) => s.outputs);
  const [kind, setKind] = useState('all');
  const inSp = useMemo(() => all.filter(inSpace(space)), [all, space]);
  const rows = useMemo(() => (kind === 'all' ? inSp : inSp.filter((f) => fileGroup(f.name, f.mime) === kind)), [inSp, kind]);
  const { folders, current, visible } = useFolder(rows, outKey, atMs, folder);
  const cur = inSp.find((f) => f.id === openId);
  const [sel] = useSelection('outputs', { keys: visible.map((f) => f.id), actions: (keys) => {
    const list = inSp.filter((f) => keys.includes(f.id)), spaces = new Set(list.map((f) => f.space));
    return [{ label: t('file.download'), icon: 'download', run: () => list.forEach((f) => downloadOutput(f)) },
      spaces.size === 1 && { label: t('file.sendCrew'), icon: 'hand', run: (_, clear) => { setUi({ assign: { space: list[0].space, items: fileItems(list) } }); clear(); } }];
  } });
  const group = fileItems(inSp.filter((f) => sel.has(f.id)));
  const kinds = <div className="seg fold-kinds" role="group" aria-label={t('fold.kind')}>{KINDS.map((k) => <button key={k} type="button" className={`seg-btn${kind === k ? ' on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{t(`fold.kind.${k}`)}</button>)}</div>;
  return (
    <div className="page-wrap wide">
      <Title h={t('nav.outputs')} />
      {inSp.length === 0 ? <div className="empty-state"><Icon name="file" size={20} /><p>{t('fold.empty')}</p></div> : (
        <FolderView folders={folders} current={current} total={rows.length} human="fold.human" toolbar={kinds}>
          {visible.length === 0 ? <p className="dim fold-none">{t('fold.none')}</p>
            : <div data-sel-scope="outputs"><DateSections groups={byDate(visible, byDay, kstDay())} render={(g) => g.items.map((f) => <FileRow key={f.id} f={f} all={current === 'all'} bucket={g.key} sel={sel} group={group} />)} /></div>}
        </FolderView>)}
      <Sheet open={!!cur} onClose={closeOpen} title={cur?.name ?? ''}
        footer={cur && <><button type="button" className="btn" onClick={() => setUi({ assign: { space: cur.space, items: [{ kind: 'file', id: cur.id, label: cur.name }] } })}><Icon name="hand" size={14} />{t('file.sendCrew')}</button><button type="button" className="btn primary" onClick={() => downloadOutput(cur)}><Icon name="file" size={14} />{t('file.download')}</button></>}>
        {cur && <div className="doc-read">
          <p className="dim small">{[folderName(crewKey(cur), 'fold.human'), cur.channel && `#${cur.channel}`, fmtBytes(cur.bytes), ago(cur.at)].filter(Boolean).join(' · ')}</p>
          <FileView key={cur.id} f={cur} />
        </div>}
      </Sheet>
    </div>
  );
}

const DAY_SHOW = 20; // 구간마다 먼저 보이는 건수 — 나머지는 "더 보기"(유건 9/30: 끝없는 스크롤이 피곤하다)
const jKey = (e) => folderKey(e.crew, e.name);
const jAt = (e) => Date.parse(`${e.day}T${e.time || '00:00'}:00+09:00`) || 0; // 일지 시각은 한국 시각
const jDay = (e) => e.day;

/** 에이전트 폴더 안 — 구간별 기록, 긴 글은 세 줄로 줄였다가 눌러서 펼친다 */
function JournalSection({ g, sel }) {
  const [shown, setShown] = useState(DAY_SHOW), [open, setOpen] = useState(() => new Set());
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return <>
    {g.items.slice(0, shown).map((e) => (
      <button key={e.id} type="button" className={`journal-entry${open.has(e.id) ? ' open' : ''}`} {...selProps(sel, e.id)} aria-expanded={open.has(e.id)} onClick={() => toggle(e.id)}>
        <p className={open.has(e.id) ? '' : 'clamp three'}>{e.text}</p><small className="rec-when">{when(jAt(e), g.key)}</small>
      </button>))}
    {g.items.length > shown && <button type="button" className="btn journal-more" onClick={() => setShown((n) => n + DAY_SHOW)}>{t('journal.more', { n: g.items.length - shown })}</button>}
  </>;
}

export function Journal({ space, folder }) {
  useLang();
  const all = useStore((s) => s.journal);
  const entries = useMemo(() => all.filter(inSpace(space)).flatMap((d) => d.entries.map((e, i) => ({ ...e, id: `${d.space}|${d.date}|${i}`, day: d.date, space: d.space }))), [all, space]);
  const { folders, current, visible } = useFolder(entries, jKey, jAt, folder);
  const today = kstDay();
  // 일지는 읽기만 — 고르기는 되고 일괄 동작은 없다(선택 막대 = 개수·해제). 전체 폴더의 에이전트별 한 줄은 폴더 열기 단추라 고르지 않는다
  const [sel] = useSelection('journal', { keys: current === 'all' ? [] : visible.map((e) => e.id) });
  let body;
  if (current === 'all') { // 전체 — 날짜마다 에이전트별 한 줄(하루 40건이 섞이지 않게), 누르면 그 에이전트 폴더로
    const groups = byDate(journalDigest(visible, jKey), (r) => r.day, today).map((g) => ({ ...g, count: g.items.reduce((n, r) => n + r.n, 0) }));
    body = <DateSections groups={groups} render={(g) => g.items.map((r) => (
      <button key={r.id} type="button" className="rec-row" onClick={() => pickFolder(r.key)}>
        <FolderIcon id={r.key} size={20} />
        <span className="rec-text"><b>{folderName(r.key, 'fold.people', r.latest.name)}</b><span className="dim"> · {countText(r.n)} · </span>{r.latest.text}</span>
        <small className="rec-when">{when(jAt(r.latest), g.key)}</small>
      </button>))} />;
  } else body = <div data-sel-scope="journal"><DateSections groups={byDate(visible, jDay, today)} render={(g) => <JournalSection key={`${current}|${g.key}`} g={g} sel={sel} />} /></div>;
  return (
    <div className="page-wrap wide">
      <Title h={t('nav.journal')} />
      {entries.length === 0 ? <div className="empty-state"><Icon name="book" size={20} /><p>{t('fold.empty')}</p></div>
        : <FolderView folders={folders} current={current} total={entries.length} human="fold.people">{body}</FolderView>}
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
  const [sel] = useSelection('crew-docs', { keys: rows.map((d) => d.id) }); // 읽기만 — 고르기만(일괄 동작 없음)
  return (
    <div className="page-wrap" data-sel-scope="crew-docs">
      <Title h={t('nav.docs')} sub={t('docs.sub')} />
      {rows.length === 0 && <div className="empty-state"><Icon name="book" size={20} /><p>{t('docs.empty')}</p></div>}
      {FOLDERS.map((f) => { const list = rows.filter((d) => d.folder === f); return list.length > 0 && (
        <section key={f} className="doc-group">
          <h2 className="label">{t(`docs.${f}`)}</h2>
          <div className="list">{list.map((d) => (
            <button key={d.id} type="button" className={`list-row${d.id === openId ? ' on' : ''}`} {...selProps(sel, d.id)} onClick={() => navigate(`${location.pathname}?open=${d.id}`)}>
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
