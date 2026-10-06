// 문서 미리보기(인트라넷 documents/page.tsx:551-648) — 오른쪽 패널(폭 조절·전체 화면). 위: 그림·PDF·글 미리보기, 아래: 읽은 글자(원문 양식, 전문),
// 옆: 이름·분류·거래처·태그·폴더 고치기(인트라넷은 미리보기에서 못 고쳤다). 전체 화면에서는 미리보기와 글자가 나란히.
import { lazy, Suspense, useEffect, useState } from 'react';
import { t, useLang } from '../core/i18n.js';
import { navigate } from '../core/router.jsx';
import { configured } from '../core/supabase.js';
import { Sheet } from '../ui/Panel.jsx';
import { showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { fmtBytes } from '../core/files.js';
import { CATEGORIES, kindOf, ocrable, folderPath, parseTags } from './model.js';
import { getFile, fileBlob, updateFile, trashFiles, restoreFiles, downloadFile, ocrFile, ocrPending, fileError, useFiles } from './api.js';
import { FIcon } from './FIcon.jsx';
import { catLabel, day, kindKey, ocrBadge, withQuery } from './FilesPage.jsx';
import { ShareLinks } from './ShareLinks.jsx'; // 공유 링크(15차 — 메일 큰 첨부·직접 공유)

const DocZoom = lazy(() => import('../docs/DocZoom.jsx')); // PDF 크게 보기 — 견적·계약 미리보기와 같은 창

export default function Preview({ space, id, customers, folders, onClose }) {
  useLang();
  const list = useFiles(space, {}); // 목록이 바뀌면(글자 읽기 끝·다른 곳에서 고침) 다시 읽는다
  const [f, setF] = useState(undefined), [url, setUrl] = useState(null), [text, setText] = useState(null), [err, setErr] = useState(null);
  const [form, setForm] = useState(null), [reading, setReading] = useState(false), [pdf, setPdf] = useState(null), [zoom, setZoom] = useState(false);
  const stamp = list.files?.find((x) => x.id === id)?.updated_at ?? list.at;
  useEffect(() => { let live = true; getFile(space, id).then((x) => { if (!live) return; setF(x); setForm({ title: x.title, tags: (x.tags ?? []).join(', ') }); }).catch(() => live && setF(null)); return () => { live = false; }; }, [space, id, stamp]);
  const kind = f ? kindKey(f) : null, fileId = f?.id;
  useEffect(() => {
    if (!fileId || f.kind !== 'file') return undefined;
    let live = true, made = null;
    setUrl(null); setText(null); setErr(null); setPdf(null);
    const k = kindOf(f.filename || f.title, f.mime);
    if (k !== 'pdf' && k !== 'image' && !/^text\//.test(f.mime) && !/\.(txt|md|csv|json|log)$/i.test(f.filename)) return undefined;
    fileBlob(space, f).then(async (blob) => {
      if (!live) return;
      if (!blob) { setErr('files.previewFail'); return; }
      if (k === 'pdf' || k === 'image') { made = URL.createObjectURL(k === 'pdf' ? new Blob([blob], { type: 'application/pdf' }) : blob); setUrl(made); if (k === 'pdf') setPdf(new Uint8Array(await blob.arrayBuffer())); }
      else setText((await blob.text()).slice(0, 200_000));
    }).catch(() => live && setErr('files.previewFail'));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [space, fileId]);

  const save = async (patch) => { try { await updateFile(space, f.id, patch); showToast(t('files.saved')); } catch (e) { showToast(t(e.message?.startsWith('files.') ? e.message : fileError(e))); } };
  const reread = async () => { setReading(true); showToast(t('files.ocrStarted')); try { const r = await ocrFile(space, f, { auto: true }); showToast(t(r.status === 'done' ? 'files.ocrDone' : 'files.ocrFailed')); } catch { showToast(t('files.ocrFailed')); } finally { setReading(false); } };
  const trash = () => trashFiles(space, [f.id]).then(() => { onClose(); showToast(t('files.trashed', { n: 1 }), { undo: () => restoreFiles(space, [f.id]).catch(() => {}) }); }).catch((e) => showToast(t(fileError(e))));
  const canRead = f && f.kind === 'file' && !f.deleted_at && (ocrable(f) || kindOf(f.filename || f.title, f.mime) === 'doc');

  const footer = f && <>
    {canRead && <button type="button" className="btn" disabled={reading || ocrPending(f.id)} onClick={reread}><Icon name="refresh" size={14} />{t('files.ocrRun')}</button>}
    {f.kind === 'file' && !f.deleted_at && <button type="button" className="btn" onClick={() => navigate(withQuery({ drive: 1, send: f.id, open: null }))}><FIcon name="drive" />{t('files.toDrive')}</button>}
    {!f.deleted_at && <button type="button" className="btn ghost" onClick={trash}><Icon name="trash" size={14} />{t('files.trash')}</button>}
    <span className="spacer" />
    {f.kind === 'file' ? <button type="button" className="btn primary" onClick={() => downloadFile(space, f).catch(() => showToast(t('files.previewFail')))}><FIcon name="download" />{t('files.download')}</button>
      : <a className="btn primary" href={f.link_url} target="_blank" rel="noreferrer noopener"><FIcon name="link" />{t('files.openDrive')}</a>}
  </>;

  return <><Sheet open onClose={onClose} title={f?.title ?? t('files.preview')} footer={footer}>
    {f === undefined ? <div className="skeleton-lines"><span /><span /><span /></div> : !f ? <p className="dim">{t('files.err.missing')}</p> : <div className="files-preview">
      <div className="files-meta">
        <span className="badge">{t(`files.kind.${kind}`)}</span>{ocrBadge(f)}
        {f.kind === 'file' && <span className="dim small">{fmtBytes(f.size ?? 0)}</span>}
        {f.source !== 'upload' && <span className="badge">{t(`files.src.${f.source}`)}</span>}
        <span className="dim small">{t('files.addedBy', { date: day(f.created_at) })}</span>
        {(f.tags ?? []).map((x) => <span key={x} className="badge">{x}</span>)}
        {pdf && <button type="button" className="btn sm files-zoom" onClick={() => setZoom(true)}><Icon name="expand" size={13} />{t('files.zoom')}</button>}
      </div>
      <div className="files-preview-grid">
        <div className="files-view">
          {f.kind === 'link' ? <div className="files-view-empty"><FIcon name="drive" size={22} /><p>{t('files.linkNote')}</p><a className="btn" href={f.link_url} target="_blank" rel="noreferrer noopener">{t('files.openDrive')}</a></div>
            : err ? <div className="files-view-empty"><p>{t(err)}</p></div>
              : kind === 'image' ? (url ? <div className="ha ha-cover"><img src={url} alt={f.title} /></div> : <div className="skeleton-lines"><span /><span /></div>)
                : kind === 'pdf' ? (url ? <div className="ha ha-cover"><iframe src={`${url}#toolbar=0&navpanes=0&view=FitH`} title={f.title} /></div> : <div className="skeleton-lines"><span /><span /></div>)
                  : text != null ? <pre className="files-text ha">{text}</pre>
                    : <div className="files-view-empty"><FIcon name={kind} size={22} /><p>{t('files.noPreview')}</p></div>}
        </div>
        <div className="files-extract">
          <p className="label">{t('files.textHead')}</p>
          {f.full_text || f.summary ? <pre className="files-text mono ha">{f.full_text || f.summary}</pre> : <p className="dim small files-noText">{ocrPending(f.id) || f.ocr_status === 'pending' ? t('files.ocrStarted') : t('files.noText')}</p>}
        </div>
      </div>
      {!f.deleted_at && form && <form className="files-edit" onSubmit={(e) => e.preventDefault()}>
        <label className="field-block"><span className="label">{t('files.field.title')}</span>
          <input className="input" maxLength={300} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} onBlur={() => form.title.trim() && form.title.trim() !== f.title && save({ title: form.title.trim() })} /></label>
        <div className="files-edit-row">
          <label className="field-block"><span className="label">{t('files.field.category')}</span>
            <select className="input" value={f.category} onChange={(e) => save({ category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select></label>
          <label className="field-block"><span className="label">{t('files.field.customer')}</span>
            <select className="input" value={f.customer_id ?? ''} onChange={(e) => save({ customer_id: e.target.value || null })}><option value="">{t('files.noCustomer')}</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field-block"><span className="label">{t('files.field.folder')}</span>
            <select className="input" value={f.folder_id ?? ''} onChange={(e) => save({ folder_id: e.target.value || null })}><option value="">{t('files.root')}</option>{folders.map((fo) => <option key={fo.id} value={fo.id}>{folderPath(folders, fo.id).map((x) => x.name).join(' / ')}</option>)}</select></label>
        </div>
        <label className="field-block"><span className="label">{t('files.field.tags')}</span>
          <input className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} onBlur={() => { const next = parseTags(form.tags); if (next.join('\u0000') !== (f.tags ?? []).join('\u0000')) save({ tags: next }); }} /></label>
        {!configured && <p className="dim small">{t('files.sampleNote')}</p>}
      </form>}
      {f.kind === 'file' && !f.deleted_at && <ShareLinks space={space} file={f} />}
    </div>}
  </Sheet>
    {zoom && pdf && <Suspense fallback={null}><DocZoom title={f.title} pdf={pdf} onClose={() => setZoom(false)} onDownload={() => downloadFile(space, f).catch(() => showToast(t('files.previewFail')))} /></Suspense>}</>;
}
