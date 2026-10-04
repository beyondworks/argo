// 구글 드라이브 창(인트라넷 app/drive/page.tsx) — 보기 5종·시작 화면 고정·즐겨찾기·폴더 경로·뒤로/앞으로·이름 검색·새 폴더를 그대로 두고,
// 오피스 결정(유건 10/2)대로 고른 파일을 문서함으로 '가져오기'(사본 보관) 또는 '링크로 붙이기'. 문서함 파일을 지금 폴더로 '보내기'(?send=<파일>).
import { useCallback, useEffect, useState } from 'react';
import { t, useLang } from '../core/i18n.js';
import { navigate } from '../core/router.jsx';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { fmtBytes } from '../core/files.js';
import { driveStatus, driveConnect, driveDisconnect, driveList, driveImport, driveLink, driveExport, driveMkdir, readFavs, toggleFav, readPin, setPin } from './drive.js';
import { FIcon } from './FIcon.jsx';
import { HideIn } from '../business/Redact.jsx';
import { day, withQuery } from './FilesPage.jsx';

const VIEWS = ['home', 'mydrive', 'shared', 'drives', 'starred'];
const ICON = { home: 'history', mydrive: 'drive', shared: 'person', drives: 'box', starred: 'star' };
const native = (m) => String(m ?? '').startsWith('application/vnd.google-apps.');
const canImport = (f) => !f.isFolder && (!native(f.mimeType) || /document|presentation|spreadsheet|drawing/.test(f.mimeType));
const kindIcon = (f) => (f.isFolder ? null : /pdf/.test(f.mimeType) ? 'pdf' : /^image\//.test(f.mimeType) ? 'image' : native(f.mimeType) || /document|sheet|presentation|text/.test(f.mimeType) ? 'doc' : 'other');
const errText = (e) => t(`files.err.${['not_connected', 'expired', 'scopes', 'too_big', 'link_only', 'storage', 'limit', 'not_configured'].includes(e?.code) ? e.code : 'request'}`);

export default function Drive({ space, folderId, onClose }) {
  useLang();
  const send = new URLSearchParams(location.search).get('send');
  const [status, setStatus] = useState(null);
  const [nav, setNav] = useState(() => ({ stack: [{ view: readPin() ?? 'mydrive', path: [], q: '' }], at: 0 }));
  const cur = nav.stack[nav.at];
  const [rows, setRows] = useState(null), [error, setError] = useState(null), [loading, setLoading] = useState(false);
  const [qInput, setQ] = useState(''), [sel, setSel] = useState(() => new Set()), [favs, setFavs] = useState(readFavs), [pin, setPinState] = useState(readPin);
  const [busy, setBusy] = useState(false), [mk, setMk] = useState(null), [needWrite, setNeedWrite] = useState(false);

  useEffect(() => { driveStatus().then(setStatus).catch(() => setStatus({ configured: true, connected: false })); }, []);
  const folder = cur.path.at(-1)?.id ?? null;
  const load = useCallback(() => {
    setLoading(true); setError(null); setSel(new Set());
    return driveList({ view: cur.view, folder: folder ?? '', q: cur.q }).then((d) => { setRows(d.files ?? []); return true; }).catch((e) => { setRows([]); setError(e); if (e.code === 'expired') setStatus((s) => ({ ...s, expired: true })); return false; }).finally(() => setLoading(false));
  }, [cur.view, folder, cur.q]);
  useEffect(() => { if (status?.connected) load(); }, [status?.connected, load]);

  const push = (s) => setNav((n) => ({ stack: [...n.stack.slice(0, n.at + 1), s], at: n.at + 1 }));
  const openFolder = (f) => push({ view: cur.view, path: [...cur.path, { id: f.id, name: f.name }], q: '' });
  const togglePin = (v) => { const next = pin === v ? null : v; setPin(next); setPinState(next); };
  const picked = (rows ?? []).filter((f) => sel.has(f.id));
  const close = () => { onClose(); if (send) navigate(withQuery({ drive: null, send: null })); };
  const connect = (write = false) => driveConnect({ write }).then((how) => { if (how === 'desktop') showToast(t('files.dv.desktop')); }).catch((e) => showToast(errText(e)));

  const doImport = async () => {
    const ok = picked.filter(canImport), linkOnly = picked.length - ok.length;
    setBusy(true);
    try { const done = await driveImport(space, ok, { folderId }); showToast(t('files.dv.imported', { n: done.length }) + (linkOnly ? ` · ${t('files.dv.linkOnly')}` : '')); setSel(new Set()); }
    catch (e) { showToast(errText(e)); } finally { setBusy(false); }
  };
  const doLink = async () => { setBusy(true); try { const n = await driveLink(space, picked.filter((f) => !f.isFolder && f.webViewLink), { folderId }); showToast(t('files.dv.linked', { n })); setSel(new Set()); } catch (e) { showToast(errText(e)); } finally { setBusy(false); } };
  const doSend = async () => {
    if (!status?.write) { setNeedWrite(true); return; }
    setBusy(true);
    try { for (const id of send.split(',').filter(Boolean).slice(0, 50)) await driveExport(space, id, folder ?? 'root'); showToast(t('files.sentDrive')); close(); } // 여러 개(인트라넷 드라이브 여러 파일 올리기)
    catch (e) { if (e.code === 'need_write') setNeedWrite(true); else showToast(errText(e)); } finally { setBusy(false); }
  };
  const doMkdir = async (e) => {
    e.preventDefault();
    if (!status?.write) { setNeedWrite(true); setMk(null); return; }
    try { const out = await driveMkdir(mk.trim(), folder ?? 'root'); showToast(t('files.dv.folderMade', { name: out.name })); setMk(null); load(); }
    catch (er) { if (er.code === 'need_write') setNeedWrite(true); else showToast(errText(er)); }
  };

  const body = !status ? <div className="skeleton-lines"><span /><span /></div>
    : !status.configured ? <div className="empty-state"><FIcon name="drive" size={22} /><p>{t('files.dv.notConfigured')}</p></div>
      : !status.connected ? <div className="empty-state drive-connect"><FIcon name="drive" size={24} /><h3>{t('files.dv.connectTitle')}</h3><p>{t('files.dv.connectBody')}</p>
        <button type="button" className="btn primary" onClick={() => connect(false)}>{t('files.dv.connect')}</button></div>
        : <div className="drive">
          <nav className="drive-nav" aria-label={t('files.drive')}>
            {[...(pin ? [pin] : []), ...VIEWS.filter((v) => v !== pin)].map((v) => <div key={v} className="drive-nav-row">
              <button type="button" className={`nav-item${cur.view === v && !cur.q && !cur.path.length ? ' on' : ''}`} onClick={() => push({ view: v, path: [], q: '' })}>
                {v === 'mydrive' ? <FIcon name="drive" size={15} /> : <Icon name={ICON[v]} size={15} />}<span className="nav-label">{t(`files.dv.${v}`)}</span></button>
              <button type="button" className={`icon-btn drive-pin${pin === v ? ' on' : ''}`} aria-pressed={pin === v} title={t(pin === v ? 'files.dv.unpin' : 'files.dv.pin')} aria-label={t(pin === v ? 'files.dv.unpin' : 'files.dv.pin')} onClick={() => togglePin(v)}><FIcon name="pin" size={13} /></button>
            </div>)}
            {pin && <p className="dim small drive-start">{t('files.dv.start', { v: t(`files.dv.${pin}`) })}</p>}
            <p className="dim small drive-acct">{status.sample ? t('files.dv.sample') : <HideIn text={t('files.dv.account', { addr: '\n' })} kind="contact">{status.address}</HideIn>}</p>
            {!status.sample && <button type="button" className="link-btn small" onClick={() => driveDisconnect().then(() => { showToast(t('files.dv.disconnected')); setStatus({ configured: true, connected: false }); }).catch((e) => showToast(errText(e)))}>{t('files.dv.disconnect')}</button>}
          </nav>
          <section className="drive-main">
            <div className="drive-tools">
              <form className="search-field files-search grow" onSubmit={(e) => { e.preventDefault(); push({ view: cur.view, path: cur.path, q: qInput.trim() }); }}>
                <Icon name="search" size={14} /><input className="input" type="search" value={qInput} placeholder={t('files.dv.search')} aria-label={t('files.dv.search')} onChange={(e) => setQ(e.target.value)} /></form>
              <button type="button" className="icon-btn" aria-label={t('files.refresh')} onClick={() => load().then((ok) => ok && showToast(t('files.refreshed')))} disabled={loading}><Icon name="refresh" /></button>
              <button type="button" className="btn" onClick={() => setMk('')}><Icon name="folder" size={13} />{t('files.newFolder')}</button>
            </div>
            {(status.expired || error?.code === 'expired' || error?.code === 'scopes') && <div className="mail-banner"><span className="dot ask" />{t('files.dv.expired')}<button type="button" className="btn sm" onClick={() => connect(status.write)}>{t('files.dv.reconnect')}</button></div>}
            {needWrite && <div className="mail-banner"><span className="dot ask" />{t('files.dv.needWrite')}<button type="button" className="btn sm" onClick={() => connect(true)}>{t('files.dv.grantWrite')}</button></div>}
            {error && !['expired', 'scopes'].includes(error.code) && <p className="bizui-error" role="alert">{errText(error)}</p>}
            {cur.q ? <p className="dim small">{t('files.dv.result', { q: cur.q, n: rows?.length ?? 0 })}</p>
              : cur.path.length > 0 && <nav className="files-crumbs"><button type="button" className="link-btn" onClick={() => push({ view: cur.view, path: [], q: '' })}>{t(`files.dv.${cur.view}`)}</button>
                {cur.path.map((c, i) => <span key={c.id}><Icon name="chevron" size={11} className="dim" />{i === cur.path.length - 1 ? <strong>{c.name}</strong> : <button type="button" className="link-btn" onClick={() => push({ view: cur.view, path: cur.path.slice(0, i + 1), q: '' })}>{c.name}</button>}</span>)}</nav>}
            {favs.length > 0 && !cur.q && !cur.path.length && <div className="drive-favs"><span className="label"><Icon name="star" size={12} /> {t('files.dv.fav')}</span>
              {favs.map((f) => <span key={f.id} className="chip"><button type="button" className="link-btn" onClick={() => (f.isFolder ? push({ view: cur.view, path: [{ id: f.id, name: f.name }], q: '' }) : f.webViewLink && window.open(f.webViewLink, '_blank', 'noopener'))}>
                {f.isFolder ? <Icon name="folder" size={12} /> : <FIcon name={kindIcon(f)} size={12} />} {f.name}</button>
                <button type="button" className="drive-star on" aria-label={t('files.dv.favRemove')} onClick={() => setFavs(toggleFav(f))}><Icon name="star" size={12} /></button></span>)}</div>}
            <div className="drive-list" role="list">
              {rows === null || (loading && !rows.length) ? <div className="skeleton-lines"><span /><span /><span /></div>
                : !rows.length ? <p className="dim drive-empty">{t('files.dv.empty')}</p>
                  : rows.map((f) => { const fav = favs.some((x) => x.id === f.id); return <div key={f.id} role="listitem" className={`drive-row${sel.has(f.id) ? ' on' : ''}`}>
                    {send ? <span /> : <input type="checkbox" disabled={f.isFolder} checked={sel.has(f.id)} aria-label={f.name} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })} />}
                    {f.isFolder ? <Icon name="folder" size={16} /> : <FIcon name={kindIcon(f)} size={16} />}
                    <button type="button" className="drive-name" title={f.name} onClick={() => (f.isFolder ? openFolder(f) : f.webViewLink && window.open(f.webViewLink, '_blank', 'noopener'))}>{f.name}</button>
                    <span className="dim small c-owner">{f.owners ?? ''}</span>
                    <span className="dim small num c-size">{f.isFolder || f.size == null ? '' : fmtBytes(f.size)}</span>
                    <span className="dim small c-date">{f.modifiedTime ? day(f.modifiedTime) : ''}</span>
                    <button type="button" className={`drive-star${fav ? ' on' : ''}`} aria-pressed={fav} aria-label={t(fav ? 'files.dv.favRemove' : 'files.dv.favAdd')} title={t(fav ? 'files.dv.favRemove' : 'files.dv.favAdd')} onClick={() => setFavs(toggleFav(f))}><Icon name="star" size={14} /></button>
                    {!f.isFolder && f.webViewLink ? <a className="icon-btn sm" href={f.webViewLink} target="_blank" rel="noreferrer noopener" aria-label={t('files.openDrive')} title={t('files.openDrive')}><FIcon name="link" size={14} /></a> : <span />}
                  </div>; })}
            </div>
          </section>
        </div>;

  const footer = status?.connected && <>
    {send ? <><span className="dim small">{t('files.dv.pickFolder')}</span><span className="spacer" /><button type="button" className="btn" onClick={close}>{t('files.cancel')}</button>
      <button type="button" className="btn primary" disabled={busy} onClick={doSend}><FIcon name="upload" />{t('files.dv.sendHere')}</button></>
      : <><span className="dim small">{picked.length ? t('files.sel', { n: picked.length }) : ''}</span><span className="spacer" />
        <button type="button" className="btn" disabled={busy || !picked.length} onClick={doLink}><FIcon name="link" />{t('files.dv.link')}</button>
        <button type="button" className="btn primary" disabled={busy || !picked.some(canImport)} onClick={doImport}><FIcon name="download" />{t('files.dv.import')}</button></>}
  </>;

  return <>
    <Modal open width={940} title={send ? t('files.toDrive') : t('files.drive')} onClose={close} footer={footer}>{body}</Modal>
    {mk != null && <Modal open title={t('files.newFolder')} onClose={() => setMk(null)} footer={<><button type="button" className="btn" onClick={() => setMk(null)}>{t('files.cancel')}</button><button type="submit" form="drive-mk" className="btn primary" disabled={!mk.trim()}>{t('files.create')}</button></>}>
      <form id="drive-mk" onSubmit={doMkdir}><label className="field-block"><span className="label">{t('files.folderName')}</span><input className="input" maxLength={200} value={mk} onChange={(e) => setMk(e.target.value)} /></label></form>
    </Modal>}
  </>;
}
