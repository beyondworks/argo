// 문서함(유건 10/2, 트랙 B) — 인트라넷 문서함·드라이브·거래처 첨부를 한 화면으로. 파일은 오피스 자체 보관(조직별 Storage), 구글 드라이브는 골라 가져오기·링크.
// 주소: ?tab=customers|trash · ?folder=<폴더> · ?open=<파일>(미리보기) · ?c=<거래처>(거래처별 보기) · ?drive=1(드라이브 창).
// 동등 목록: ~/lean-projects/_worktrees/office-r5-spec/PARITY-B.md. 규칙(순수 함수)은 model.js, 데이터는 api.js.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { t, useLang, getLang, registerDict } from '../core/i18n.js';
import { navigate } from '../core/router.jsx';
import { useSession } from '../core/session.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { openMenu } from '../ui/Menu.jsx';
import { Icon } from '../ui/Icon.jsx';
import { LoadFail } from '../ui/LoadFail.jsx';
import { fmtBytes, dragHasFiles, filesFromTransfer } from '../core/files.js';
import { FILES_DICT } from './files-i18n.js';
import { usageInfo, fmtSize, CATEGORIES, pageMenuIds, countBy, filterFiles, folderPath, childFolders, canMoveFolder, uploadSummary, daysLeft, missingBizcert } from './model.js';
import { useFiles, uploadMany, trashFiles, restoreFiles, purgeFiles, purgeExpired, updateFile, downloadFile, createFolder, renameFolder, moveFolder, deleteFolder, loadCustomers, ocrPending, fileError } from './api.js';
import { FIcon } from './FIcon.jsx';
import { badgeTone } from '../ui/badge-tone.js';
import { kindKey, tagTone } from './tones.js';
export { kindKey, tagTone }; // 미리보기(Preview)는 이 화면 묶음에서 가져간다 — 첫 화면의 지연 로드 모양이 그대로다
import { useSelection, selProps } from '../core/selection.js';
import { CustomerFiles } from './CustomerFiles.jsx';
import './files.css';

registerDict(FILES_DICT);
/** 쓴 용량 / 한도 — 판정과 같은 값(서버 office_storage_taken·quota). 80%부터 은은한 안내 한 줄 */
function UsageLine({ usage }) {
  const u = usageInfo(usage);
  if (!u) return null;
  return <div className="files-used small">
    <p className="dim">{t('files.used', { size: fmtSize(u.used), quota: fmtSize(u.quota) })}</p>
    {u.near && <p className="files-near" role="status">{t('files.near')}</p>}
  </div>;
}
const Preview = lazy(() => import('./Preview.jsx'));
const Drive = lazy(() => import('./Drive.jsx'));

/** 지금 주소의 쿼리 일부만 바꾼 주소(null·''은 뺀다) */
export function withQuery(patch) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') q.delete(k); else q.set(k, v); }
  const s = q.toString();
  return location.pathname + (s ? `?${s}` : '');
}
const go = (patch) => navigate(withQuery(patch));
export const catLabel = (c) => t(`files.cat.${c ?? 'general'}`);
export const day = (iso) => (iso ? new Date(iso).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const useDebounced = (value, ms) => { const [v, setV] = useState(value); useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]); return v; };
export const ocrBadge = (f) => { const s = ocrPending(f.id) ? 'pending' : f.ocr_status ?? 'none'; return s === 'none' ? null : <span className={`badge${s === 'failed' ? ' danger' : s === 'done' ? ' ok' : s === 'pending' ? ' warn' : ''}`}>{t(`files.ocr.${s}`)}</span>; };

export default function FilesPage({ space, query }) {
  useLang();
  const mode = useSession();
  const p = new URLSearchParams(query ?? '');
  const tab = ['customers', 'trash'].includes(p.get('tab')) ? p.get('tab') : 'all';
  const folder = p.get('folder') || null, openId = p.get('open'), cust = p.get('c');
  const [qInput, setQ] = useState(''), q = useDebounced(qInput, 300); // 인트라넷과 같은 300ms
  const [cat, setCat] = useState(null), [custFilter, setCustFilter] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [progress, setProgress] = useState(null), [over, setOver] = useState(false);
  const [dialog, setDialog] = useState(null); // { kind: 'newFolder'|'renameFolder'|'move'|'purge', ... }
  const [customers, setCustomers] = useState([]);
  const input = useRef(null);
  const data = useFiles(space, { trash: tab === 'trash', q: tab === 'trash' ? '' : q });
  const all = useFiles(space, {}); // 거래처별 보기·미보유 판정은 전체 목록으로(같은 키면 한 번만 읽는다)
  useEffect(() => { setSel(new Set()); }, [space, tab, folder, q]);
  useEffect(() => { let live = true; loadCustomers(space).then((c) => live && setCustomers(c)).catch(() => {}); return () => { live = false; }; }, [space, mode]);
  useEffect(() => { purgeExpired(space).catch(() => {}); }, [space, mode]); // 휴지통 30일 정리 — 하루 한 번

  const folders = data.folders ?? all.folders ?? [];
  const searching = !!q.trim();
  const inFolder = tab === 'all' && !searching;
  const files = data.files ?? [];
  const shown = useMemo(() => filterFiles(files, { category: cat, customer: custFilter || null, folder: inFolder && !cat && !custFilter ? folder : undefined }), [files, cat, custFilter, folder, inFolder]);
  const counts = useMemo(() => countBy(files), [files]);
  const custName = (id) => customers.find((c) => c.id === id)?.name;
  const path = folderPath(folders, folder);
  const subs = inFolder && !cat && !custFilter ? childFolders(folders, folder) : [];
  const selected = shown.filter((f) => sel.has(f.id));
  const allSel = shown.length > 0 && shown.every((f) => sel.has(f.id));

  const upload = async (list, opts = {}) => {
    const arr = [...list];
    if (!arr.length) return;
    const res = await uploadMany(space, arr, { folderId: tab === 'all' ? folder : null, ...opts }, (done, total) => setProgress(done < total ? { done: done + 1, total } : null));
    setProgress(null);
    const s = uploadSummary(arr.map((f) => f.name), res);
    const why = res.find((r) => r !== true);
    showToast(t(s.key, s.vars) + (why && arr.length === 1 ? ` — ${t(FILES_DICT[`files.reason.${why}`] ? `files.reason.${why}` : `files.err.${why}`)}` : ''));
  };
  // 반환: 성공했는가(OFC-05) — 실패 알림을 성공 알림이 덮지 않게, 창은 실패하면 열어 둔다(적은 이름을 잃지 않게)
  const act = async (fn, okKey, vars) => {
    try { await fn(); if (okKey) showToast(t(okKey, vars)); return true; }
    catch (e) {
      const key = e.message?.startsWith('files.') ? e.message : fileError(e);
      // 휴지통에 든 파일 때문에 폴더를 못 지울 때 — 화면엔 '비어 있음'이라 할 일을 몰랐다(OFC-13): 휴지통으로 가는 단추
      showToast(t(key), key === 'files.err.notEmpty' ? { action: { label: t('files.seeTrash'), run: () => go({ tab: 'trash', folder: null }) } } : undefined);
      return false;
    }
  };
  const trash = (rows) => act(() => trashFiles(space, rows.map((f) => f.id)), null).then((ok) => { if (!ok) return; setSel(new Set()); showToast(t('files.trashed', { n: rows.length }), { undo: () => act(() => restoreFiles(space, rows.map((f) => f.id)), 'files.restored', { n: rows.length }) }); });
  const download = (rows) => rows.filter((f) => f.kind === 'file').reduce((pr, f) => pr.then(() => downloadFile(space, f).catch(() => showToast(t('files.previewFail')))), Promise.resolve());
  const setCategory = (rows, c) => act(() => Promise.all(rows.map((f) => updateFile(space, f.id, { category: c }))), 'files.saved');
  const catMenu = (e, rows) => openMenu(e, CATEGORIES.map((c) => ({ label: catLabel(c), checked: rows.every((f) => f.category === c), run: () => setCategory(rows, c) })), { anchor: e.currentTarget });
  const rowMenu = (e, f) => openMenu(e, [
    { label: t('files.open'), icon: 'eye', run: () => go({ open: f.id }) },
    f.kind === 'file' ? { label: t('files.download'), icon: 'share', run: () => download([f]) } : { label: t('files.openDrive'), icon: 'link', run: () => window.open(f.link_url, '_blank', 'noopener') },
    { label: t('files.setCategory'), icon: 'tag', run: () => catMenu(e, [f]) },
    { label: t('files.move'), icon: 'chevron', run: () => setDialog({ kind: 'move', files: [f] }) },
    { sep: true },
    { label: t('files.trash'), icon: 'trash', danger: true, run: () => trash([f]) },
  ]);
  const folderMenu = (e, fo) => openMenu(e, [
    { label: t('files.rename'), icon: 'draft', run: () => setDialog({ kind: 'renameFolder', folder: fo, name: fo.name }) },
    { label: t('files.folderMove'), icon: 'chevron', run: () => setDialog({ kind: 'move', folder: fo }) },
    { sep: true },
    { label: t('files.folderDelete'), icon: 'trash', danger: true, run: () => act(() => deleteFolder(space, fo.id)) },
  ]);
  // 머리 ⋯(유건 10/2 10차 "눌러도 반응 없음") — 새로고침은 끝나면 알리고, 탭마다 그 화면에서 할 수 있는 일을 둔다(홈·페이지 ⋯처럼)
  const refresh = () => import('./api.js').then((m) => m.refreshFiles()).then(() => showToast(t('files.refreshed')), () => showToast(t('files.err.request')));
  const trashRows = tab === 'trash' ? (data.files ?? []).filter((f) => data.manager || f.created_by === data.me) : [];
  const PAGE_ITEMS = {
    refresh: { label: t('files.refresh'), icon: 'refresh', run: refresh },
    newFolder: { label: t('files.newFolder'), icon: 'folder', run: () => setDialog({ kind: 'newFolder', name: '' }) },
    drive: { label: t('files.drive'), icon: 'link', run: () => go({ drive: 1 }) },
    selAll: { label: t('files.selAll'), icon: 'check', run: () => setSel(new Set(shown.map((f) => f.id))) },
    selNone: { label: t('files.selNone'), icon: 'x', run: () => setSel(new Set()) },
    emptyTrash: { label: t('files.emptyTrash'), icon: 'trash', danger: true, run: () => setDialog({ kind: 'purge', files: trashRows }) },
    'emptyTrash:off': { label: t('files.emptyTrash'), icon: 'trash', danger: true, disabled: true },
    sep: { sep: true },
  };
  const pageMenu = (e) => openMenu(e, pageMenuIds(tab, { rows: shown.length, allSelected: allSel, purgeable: trashRows.length }).map((id) => PAGE_ITEMS[id]), { anchor: e.currentTarget });

  // 화면 어디에 놓아도 지금 폴더로(인트라넷 드롭존 + 드라이브 화면 전체 드롭)
  const dropProps = tab === 'trash' ? {} : {
    onDragOver: (e) => { if (!dragHasFiles(e.dataTransfer)) return; e.preventDefault(); setOver(true); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); },
    onDrop: (e) => { if (!dragHasFiles(e.dataTransfer)) return; e.preventDefault(); setOver(false); upload(filesFromTransfer(e.dataTransfer), tab === 'customers' && cust ? { customerId: cust } : {}); },
  };
  // 여러 개 고르기(11차) — 체크박스와 같은 선택을 끌어 감싸기·⇧/⌘ 클릭·⌘A로도. 선택 막대는 오피스 공용(분류·옮기기·다운로드·드라이브로·휴지통 — 원래 막대와 같은 동작)
  useSelection(tab === 'all' ? 'files' : null, { value: sel, onChange: setSel, keys: shown.map((f) => f.id), actions: (keys) => {
    const rows = shown.filter((f) => keys.includes(f.id)), real = rows.filter((f) => f.kind === 'file');
    return [
      { label: t('files.setCategory'), icon: 'tag', run: (_, __, e) => catMenu(e, rows) },
      { label: t('files.move'), icon: 'folder', run: () => setDialog({ kind: 'move', files: rows }) },
      { label: t('files.download'), icon: 'download', run: () => download(rows) },
      real.length > 0 && { label: t('files.toDrive'), icon: 'link', run: () => go({ drive: 1, send: real.map((f) => f.id).join(',') }) },
      { label: t('files.trash'), icon: 'trash', run: () => trash(rows) },
    ];
  } });
  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const tabs = <div className="tabs" role="tablist" aria-label={t('files.title')}>{['all', 'customers', 'trash'].map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' on' : ''}`} onClick={() => go({ tab: k === 'all' ? null : k, folder: null, open: null, c: null })}>{t(`files.tab.${k}`)}</button>)}</div>;

  return <div className={`page-wrap wide files${over ? ' drop-over' : ''}`} {...dropProps}>
    <div className="page-title-row">
      <div><h1 className="page-h1">{t('files.title')}</h1><p className="dim">{t('files.sub')}</p>
        {mode === 'sample' && <p className="page-note"><Icon name="info" size={13} />{t('files.sampleNote')}</p>}</div>
      <div className="row-actions files-actions">
        <button type="button" className="btn sm" onClick={() => go({ drive: 1 })}><FIcon name="drive" />{t('files.drive')}</button>
        {tab === 'all' && <button type="button" className="btn sm" onClick={() => setDialog({ kind: 'newFolder', name: '' })}><Icon name="folder" size={13} />{t('files.newFolder')}</button>}
        {tab !== 'trash' && <button type="button" className="btn sm primary" disabled={!!progress} onClick={() => input.current?.click()}><FIcon name="upload" />{progress ? t('files.uploading', progress) : t('files.upload')}</button>}
        <button type="button" className="icon-btn" aria-label={t('more')} onClick={pageMenu}><Icon name="dots" /></button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { const l = [...e.target.files]; e.target.value = ''; upload(l, tab === 'customers' && cust ? { customerId: cust } : {}); }} />
      </div>
    </div>
    {tab !== 'customers' && <div className="page-tabbar files-tabbar">{tabs}</div>}

    {tab === 'all' && <>
      <div className="files-bar">
        <label className="search-field files-search"><Icon name="search" size={14} /><input className="input" type="search" value={qInput} placeholder={t('files.search')} onChange={(e) => setQ(e.target.value)} aria-label={t('files.search')} /></label>
        <select className="input files-cust" value={custFilter} onChange={(e) => setCustFilter(e.target.value)} aria-label={t('files.col.customer')}>
          <option value="">{t('files.anyCustomer')}</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </div>
      <div className="chips files-cats" role="group" aria-label={t('files.col.category')}>
        <button type="button" className={`chip${!cat ? ' on' : ''}`} aria-pressed={!cat} onClick={() => setCat(null)}>{t('files.all')} <span className="dim">{files.length}</span></button>
        {CATEGORIES.filter((c) => counts[c] || c === cat).map((c) => <button key={c} type="button" className={`chip${cat === c ? ' on' : ''}`} aria-pressed={cat === c} onClick={() => setCat((v) => (v === c ? null : c))}><span className={`dot ${badgeTone(c)}`} aria-hidden="true" />{catLabel(c)} <span className="dim">{counts[c] ?? 0}</span></button>)}
      </div>
      <button type="button" className={`files-drop${over ? ' on' : ''}`} disabled={!!progress} onClick={() => input.current?.click()}>
        <FIcon name="upload" size={18} /><span><strong>{progress ? t('files.uploading', progress) : t('files.drop')}</strong><small className="dim">{t('files.dropHint')}</small></span>
      </button>
      {inFolder && !cat && !custFilter && path.length > 0 && <nav className="files-crumbs" aria-label="breadcrumb">
        <button type="button" className="link-btn" onClick={() => go({ folder: null })}>{t('files.root')}</button>
        {path.map((fo, i) => <span key={fo.id}><Icon name="chevron" size={11} className="dim" />{i === path.length - 1 ? <strong>{fo.name}</strong> : <button type="button" className="link-btn" onClick={() => go({ folder: fo.id })}>{fo.name}</button>}</span>)}
      </nav>}
      {subs.length > 0 && <div className="files-folders">{subs.map((fo) => <div key={fo.id} className="files-folder">
        <button type="button" className="files-folder-main" onClick={() => go({ folder: fo.id })} onContextMenu={(e) => folderMenu(e, fo)}><Icon name="folder" size={18} /><span>{fo.name}</span></button>
        <button type="button" className="icon-btn" aria-label={t('more')} onClick={(e) => folderMenu(e, fo)}><Icon name="dots" size={14} /></button></div>)}</div>}
      {data.error && data.files && <p className="bizui-error" role="alert">{t(data.error)}</p>}
      {/* 목록을 못 읽었으면 '아직 올린 파일이 없습니다'와 함께 보이지 않게 — 읽기 문구와 다시 시도(OFC-08) */}
      {!data.files && data.error && !data.loading ? <LoadFail text={t(data.error === 'files.err.request' ? 'load.readFail' : data.error)} onRetry={refresh} />
        : !data.files && data.loading ? <p className="dim" role="status">{t('files.loading')}</p>
        : shown.length === 0 && subs.length === 0 ? <div className="empty-state"><Icon name="folder" size={20} /><p>{searching || cat || custFilter ? t('files.noResult') : folder ? t('files.emptyFolder') : t('files.empty')}</p></div>
          : shown.length > 0 && <div className="table-wrap files-table-wrap" data-sel-scope="files"><table className="table files-table">
            <thead><tr>
              <th className="files-check"><input type="checkbox" checked={allSel} aria-label={t('files.selAll')} onChange={() => setSel(allSel ? new Set() : new Set(shown.map((f) => f.id)))} /></th>
              <th>{t('files.col.name')}</th><th className="c-cat">{t('files.col.category')}</th><th className="c-cust">{t('files.col.customer')}</th><th className="c-kind">{t('files.col.kind')}</th>
              <th className="num c-size">{t('files.col.size')}</th><th className="c-ocr">{t('files.col.ocr')}</th><th className="c-tags">{t('files.col.tags')}</th><th className="c-date">{t('files.col.date')}</th><th className="files-act" />
            </tr></thead>
            <tbody>{shown.map((f) => <tr key={f.id} className={sel.has(f.id) ? 'on' : ''} {...selProps(sel, f.id)} onContextMenu={(e) => rowMenu(e, f)}>
              <td className="files-check"><input type="checkbox" checked={sel.has(f.id)} aria-label={f.title} onChange={() => toggle(f.id)} /></td>
              <td><button type="button" className="files-name" onClick={() => go({ open: f.id })}><FIcon name={kindKey(f)} size={15} /><span className="files-title">{f.title}</span>
                {f.source !== 'upload' && t(`files.src.${f.source}`) !== `files.src.${f.source}` && <span className={`badge ${badgeTone(f.source)}`}>{t(`files.src.${f.source}`)}</span>}</button></td>
              <td className="c-cat"><button type="button" className={`badge files-cat ${badgeTone(f.category ?? 'general')}`} onClick={(e) => catMenu(e, [f])}>{catLabel(f.category)}</button></td>
              <td className="c-cust dim">{custName(f.customer_id) ?? '—'}</td>
              <td className="c-kind"><span className={`badge ${badgeTone(kindKey(f))}`}>{t(`files.kind.${kindKey(f)}`)}</span></td>
              <td className="num c-size">{f.kind === 'file' ? fmtBytes(f.size ?? 0) : '—'}</td>
              <td className="c-ocr">{ocrBadge(f) ?? <span className="dim">—</span>}</td>
              <td className="c-tags">{(f.tags ?? []).length ? <span className="files-tags">{f.tags.slice(0, 3).map((x) => <span key={x} className={`badge ${tagTone(x)}`}>{x}</span>)}{f.tags.length > 3 && <span className="badge">+{f.tags.length - 3}</span>}</span> : <span className="dim">—</span>}</td>
              <td className="c-date dim">{day(f.created_at)}</td>
              <td className="files-act"><button type="button" className="icon-btn" aria-label={t('more')} onClick={(e) => rowMenu(e, f)}><Icon name="dots" size={14} /></button></td>
            </tr>)}</tbody></table></div>}
      {data.more && <p className="dim small">{t('files.more')}</p>}
      <UsageLine usage={data.usage} />
    </>}

    {tab === 'customers' && <CustomersView space={space} tabs={tabs} customers={customers} files={all.files ?? []} cust={cust} onUpload={(list, c, category) => upload(list, { customerId: c, category })} />}
    {tab === 'trash' && <TrashView space={space} data={data} act={act} setDialog={setDialog} />}

    {over && tab !== 'trash' && <div className="files-overlay" aria-hidden="true"><FIcon name="upload" size={22} /><p>{t('files.dropHere')}</p></div>}
    {openId && <Suspense fallback={null}><Preview space={space} id={openId} customers={customers} folders={folders} onClose={() => go({ open: null })} /></Suspense>}
    {p.get('drive') && <Suspense fallback={null}><Drive space={space} folderId={tab === 'all' ? folder : null} onClose={() => go({ drive: null })} /></Suspense>}
    <FolderDialogs space={space} dialog={dialog} setDialog={setDialog} folders={folders} folder={folder} act={act} />
  </div>;
}

function FolderDialogs({ space, dialog, setDialog, folders, folder, act }) {
  const [target, setTarget] = useState('');
  useEffect(() => { setTarget(''); }, [dialog]);
  if (!dialog) return null;
  const close = () => setDialog(null);
  if (dialog.kind === 'newFolder' || dialog.kind === 'renameFolder') {
    const submit = (e) => { e.preventDefault(); const name = dialog.name.trim(); if (!name) return;
      act(() => (dialog.kind === 'newFolder' ? createFolder(space, name, folder) : renameFolder(space, dialog.folder.id, name)), dialog.kind === 'newFolder' ? 'files.folderCreated' : 'files.saved', { name }).then((ok) => ok && close()); };
    return <Modal open title={t(dialog.kind === 'newFolder' ? 'files.newFolder' : 'files.rename')} onClose={close}
      footer={<><button type="button" className="btn" onClick={close}>{t('files.cancel')}</button><button type="submit" form="files-folder-form" className="btn primary" disabled={!dialog.name.trim()}>{t(dialog.kind === 'newFolder' ? 'files.create' : 'files.save')}</button></>}>
      <form id="files-folder-form" onSubmit={submit}><label className="field-block"><span className="label">{t('files.folderName')}</span>
        <input className="input" maxLength={120} value={dialog.name} onChange={(e) => setDialog({ ...dialog, name: e.target.value })} /></label></form>
    </Modal>;
  }
  if (dialog.kind === 'move') {
    const opts = folders.filter((fo) => !dialog.folder || canMoveFolder(folders, dialog.folder.id, fo.id));
    const label = (fo) => folderPath(folders, fo.id).map((x) => x.name).join(' / ');
    const run = () => act(async () => {
      const to = target || null;
      if (dialog.folder) await moveFolder(space, dialog.folder.id, to);
      else for (const f of dialog.files) await updateFile(space, f.id, { folder_id: to });
    }, 'files.saved').then((ok) => ok && close()); // 실패하면 창을 열어 둔다(OFC-05)
    return <Modal open title={t(dialog.folder ? 'files.folderMove' : 'files.move')} onClose={close}
      footer={<><button type="button" className="btn" onClick={close}>{t('files.cancel')}</button><button type="button" className="btn primary" onClick={run}>{t('files.save')}</button></>}>
      <label className="field-block"><span className="label">{t('files.moveTo')}</span>
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">{t('files.root')}</option>
          {opts.map((fo) => <option key={fo.id} value={fo.id}>{label(fo)}</option>)}</select></label>
    </Modal>;
  }
  if (dialog.kind === 'purge') {
    const rows = dialog.files;
    return <Modal open title={t('files.purgeTitle')} onClose={close}
      footer={<><button type="button" className="btn" onClick={close}>{t('files.cancel')}</button><button type="button" className="btn danger" onClick={() => act(() => purgeFiles(space, rows), 'files.purged').then(close)}>{t('files.purge')}</button></>}>
      <p>{rows.length === 1 ? t('files.purgeBody', { name: rows[0].title }) : t('files.purgeMany', { n: rows.length })}</p>
    </Modal>;
  }
  return null;
}

function TrashView({ space, data, act, setDialog }) {
  const rows = data.files ?? [];
  const mine = (f) => data.manager || f.created_by === data.me;
  // 여러 개 되살리기·영구 삭제(11차) — 행의 단일 동작과 같다. 영구 삭제는 원래 확인 창을 거친다
  const [sel] = useSelection('files-trash', { keys: rows.map((f) => f.id), actions: (keys, clear) => {
    const list = rows.filter((f) => keys.includes(f.id)), own = list.filter(mine);
    return [{ label: t('files.restore'), icon: 'refresh', run: () => act(() => restoreFiles(space, keys), 'files.restored', { n: keys.length }).then(clear) },
      own.length > 0 && { label: t('files.purge'), icon: 'trash', danger: true, run: () => setDialog({ kind: 'purge', files: own }) }];
  } });
  return <>
    <p className="dim small files-trash-hint">{t('files.trashHint')}</p>
    {!data.files && data.loading ? <p className="dim">{t('files.loading')}</p> : rows.length === 0 ? <div className="empty-state"><Icon name="trash" size={20} /><p>{t('files.trashEmpty')}</p></div>
      : <div className="table-wrap" data-sel-scope="files-trash"><table className="table files-table files-trash-table"><thead><tr><th>{t('files.col.name')}</th><th className="c-cat">{t('files.col.category')}</th><th className="c-date">{t('files.col.deleted')}</th><th className="c-left" /><th className="files-act" /></tr></thead>
        <tbody>{rows.map((f) => <tr key={f.id} {...selProps(sel, f.id)}>
          <td><span className="files-name static"><FIcon name={kindKey(f)} size={15} /><span className="files-title">{f.title}</span></span></td>
          <td className="c-cat"><span className={`badge ${badgeTone(f.category ?? 'general')}`}>{catLabel(f.category)}</span></td>
          <td className="c-date dim">{day(f.deleted_at)}</td><td className="dim small c-left">{t('files.daysLeft', { n: daysLeft(f) })}</td>
          <td className="files-act"><div className="files-trash-act"><button type="button" className="btn sm" onClick={() => act(() => restoreFiles(space, [f.id]), 'files.restored', { n: 1 })}>{t('files.restore')}</button>
            {mine(f) && <button type="button" className="btn sm ghost" onClick={() => setDialog({ kind: 'purge', files: [f] })}>{t('files.purge')}</button>}</div></td>
        </tr>)}</tbody></table></div>}
  </>;
}

function CustomersView({ space, tabs, customers, files, cust, onUpload }) {
  const missing = useMemo(() => new Set(missingBizcert(customers, files).map((c) => c.id)), [customers, files]);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [head, setHead] = useState(null); // 오른쪽 머리(거래처 이름·요약·붙이기)가 들어갈 자리 — 탭 줄과 같은 가로 줄
  const count = (id) => files.filter((f) => f.customer_id === id).length;
  const list = customers.filter((c) => !onlyMissing || missing.has(c.id));
  // 고른 거래처가 없으면 목록 첫 거래처(결재함이 '전체'를 고른 채 여는 것처럼 — 오른쪽이 빈 채로 열리지 않게)
  const current = customers.find((c) => c.id === cust) ?? (cust ? null : list[0] ?? null);
  // 결재함·일지와 같은 폴더 보기(.fold) — 왼쪽 목록 부품·행 높이·폭·고른 표시를 그대로 쓰고, 탭 줄이 같은 격자 첫 줄에 들어간다
  return <div className="fold files-cust-split">
    <div className="files-cust-tabs">{tabs}</div>
    <div className="files-cust-head" ref={setHead} />
    {!customers.length ? <div className="empty-state files-cust-none"><Icon name="person" size={20} /><p>{t('files.cust.none')}</p></div> : <>
      <nav className="fold-nav files-cust-list" aria-label={t('files.tab.customers')}>
        {missing.size > 0 && <button type="button" className={`fold-item${onlyMissing ? ' on' : ''}`} aria-pressed={onlyMissing} onClick={() => setOnlyMissing((v) => !v)}>
          <span className="fold-ico"><span className="dot ask" /></span><span className="fold-name">{t('files.cust.missingOnly')}</span><span className="fold-n">{missing.size}</span></button>}
        {list.map((c) => <button key={c.id} type="button" className={`fold-item${c.id === current?.id ? ' on' : ''}`} aria-current={c.id === current?.id ? 'true' : undefined} onClick={() => go({ c: c.id })}>
          <span className="fold-ico"><Icon name="person" size={12} /></span><span className="fold-name">{c.name}</span>
          {c.status === 'closed' ? <span className="badge">{t('files.cust.closed')}</span> : missing.has(c.id) && <span className="dot ask" title={t('files.cust.missing')} aria-label={t('files.cust.missing')} />}
          <span className="fold-n">{count(c.id)}</span></button>)}
      </nav>
      <section className="fold-main files-cust-main">
        {current ? <CustomerFiles space={space} customer={current} headTarget={head} onUpload={(l, category) => onUpload(l, current.id, category)} /> : <p className="dim fold-none">{t('files.cust.pick')}</p>}
      </section>
    </>}
  </div>;
}

/** 구글이 돌려보내는 자리(/me/files/connect?code&state 또는 ?error) — 서버가 토큰을 받아 봉인·저장한 뒤 드라이브 창으로 */
export function DriveConnect({ query }) {
  useLang();
  const [error, setError] = useState(null);
  useEffect(() => {
    const p = new URLSearchParams(query ?? '');
    if (p.get('error')) { setError('state'); return; }
    import('./drive.js').then((m) => m.driveFinish(p.get('code'), p.get('state')))
      .then(({ address }) => { showToast(t('files.dv.connected', { addr: address })); navigate('/me/files?drive=1', { replace: true }); })
      .catch((e) => setError(e.code ?? 'request'));
  }, [query]);
  return <div className="empty-state"><Icon name="folder" size={22} />
    {!error ? <p>{t('files.dv.connecting')}</p> : <><p>{t(`files.err.${['state', 'scopes', 'not_configured', 'expired'].includes(error) ? error : 'request'}`)}</p>
      <button type="button" className="btn" onClick={() => navigate('/me/files?drive=1', { replace: true })}>{t('files.drive')}</button></>}
  </div>;
}
