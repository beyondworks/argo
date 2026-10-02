// '/파일' 창 안쪽 — 문서함 검색·고르기, 또는 새 파일 올리기(올리면 문서함에 저장되고 바로 본문에 들어간다).
import { useRef, useState } from 'react';
import { t } from '../core/i18n.js';
import { Icon } from '../ui/Icon.jsx';
import { fmtBytes } from '../core/files.js';
import { useFiles, uploadOne, refreshFiles } from './api.js';
import { kindOf } from './model.js';
import { FIcon } from './FIcon.jsx';

export default function FilePicker({ space, onPick }) {
  const [q, setQ] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState(null);
  const data = useFiles(space, { q });
  const input = useRef(null);
  const upload = async (file) => {
    if (!file) return;
    setBusy(true); setErr(null);
    const r = await uploadOne(space, file).catch(() => ({ ok: false, reason: 'request' }));
    setBusy(false);
    if (!r.ok) { setErr(r.reason); return; }
    await refreshFiles();
    onPick({ id: r.file.id, title: r.file.title });
  };
  return <div className="file-pick">
    <div className="drive-tools">
      <label className="search-field files-search grow"><Icon name="search" size={14} /><input className="input" type="search" value={q} placeholder={t('files.search')} aria-label={t('files.search')} onChange={(e) => setQ(e.target.value)} /></label>
      <button type="button" className="btn primary" disabled={busy} onClick={() => input.current?.click()}><FIcon name="upload" />{t('files.blockUpload')}</button>
      <input ref={input} type="file" hidden onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; upload(f); }} />
    </div>
    {err && <p className="bizui-error" role="alert">{t(`files.reason.${err}`) !== `files.reason.${err}` ? t(`files.reason.${err}`) : t('files.err.request')}</p>}
    <p className="label">{t('files.blockPick')}</p>
    <div className="file-pick-list">
      {!data.files ? <div className="skeleton-lines"><span /><span /></div> : !data.files.length ? <p className="dim small">{t('files.noResult')}</p>
        : data.files.slice(0, 100).map((f) => <button key={f.id} type="button" className="list-row" onClick={() => onPick({ id: f.id, title: f.title })}>
          <FIcon name={f.kind === 'link' ? 'link' : kindOf(f.filename || f.title, f.mime)} size={14} /><span className="grow files-title">{f.title}</span>
          <small className="dim">{f.kind === 'file' ? fmtBytes(f.size ?? 0) : ''}</small></button>)}
    </div>
  </div>;
}
