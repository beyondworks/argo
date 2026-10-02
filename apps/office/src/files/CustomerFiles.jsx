// 거래처 파일(인트라넷 customers/page.tsx 첨부 + components/customer-hub.tsx '문서' 탭) — 문서함 '거래처별' 보기와 업무 › 거래처 카드가 같이 쓴다.
// 거래처 첨부를 따로 두지 않고 문서함 한 저장소(office_files.customer_id)에 둔다 — 견적서·계약서·서명본·명함이 한 줄로 모인다.
import { useRef, useState } from 'react';
import { t, useLang, registerDict } from '../core/i18n.js';
import { navigate } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import { showToast } from '../ui/Overlay.jsx';
import { openMenu } from '../ui/Menu.jsx';
import { Icon } from '../ui/Icon.jsx';
import { fmtBytes } from '../core/files.js';
import { FILES_DICT } from './files-i18n.js';
import { CUSTOMER_TYPES, groupByCategory, topCategories, uploadSummary } from './model.js';
import { useFiles, uploadMany, updateFile, trashFiles, downloadFile } from './api.js';
import { FIcon } from './FIcon.jsx';

registerDict(FILES_DICT);
const catLabel = (c) => t(`files.cat.${c ?? 'general'}`);
const kindOfRow = (f) => (f.kind === 'link' ? 'link' : /pdf/i.test(f.mime) || /\.pdf$/i.test(f.filename) ? 'pdf' : /^image\//.test(f.mime) ? 'image' : 'doc');
const day = (iso) => (iso ? iso.slice(0, 10).replace(/-/g, '. ') + '.' : '—'); // 인트라넷 허브와 같은 표기

/** onUpload(파일들, 종류) — 주면 그쪽(문서함의 진행 표시)으로, 없으면 여기서 올린다 */
export function CustomerFiles({ space, customer, onUpload }) {
  useLang();
  const data = useFiles(space, { customer: customer.id });
  const [type, setType] = useState('bizcert'); // 인트라넷 기본값(사업자등록증)
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const files = data.files ?? [];
  const groups = groupByCategory(files);
  const hasBizcert = files.some((f) => f.category === 'bizcert');
  const open = (f) => navigate(`${baseOf(space)}/files?tab=customers&c=${encodeURIComponent(customer.id)}&open=${encodeURIComponent(f.id)}`);
  const upload = async (list) => {
    if (!list.length) return;
    if (onUpload) return onUpload(list, type);
    setBusy(true);
    try { const res = await uploadMany(space, list, { customerId: customer.id, category: type }); const s = uploadSummary(list.map((f) => f.name), res); showToast(t(s.key, s.vars)); }
    finally { setBusy(false); }
  };
  const menu = (e, f) => openMenu(e, [
    { label: t('files.open'), icon: 'eye', run: () => open(f) },
    f.kind === 'file' ? { label: t('files.download'), icon: 'share', run: () => downloadFile(space, f).catch(() => showToast(t('files.previewFail'))) } : { label: t('files.openDrive'), icon: 'link', run: () => window.open(f.link_url, '_blank', 'noopener') },
    { label: t('files.setCategory'), icon: 'tag', run: () => openMenu(e, CUSTOMER_TYPES.concat(['quote', 'evidence', 'archive']).filter((c, i, a) => a.indexOf(c) === i).map((c) => ({ label: catLabel(c), checked: f.category === c, run: () => updateFile(space, f.id, { category: c }).catch(() => showToast(t('files.err.request'))) }))) },
    { label: t('files.cust.unlink'), icon: 'x', run: () => updateFile(space, f.id, { customer_id: null }).then(() => showToast(t('files.saved'))).catch(() => showToast(t('files.err.request'))) },
    { sep: true },
    { label: t('files.trash'), icon: 'trash', danger: true, run: () => trashFiles(space, [f.id]).then(() => showToast(t('files.trashed', { n: 1 }))).catch(() => showToast(t('files.err.request'))) },
  ]);
  return <div className="cust-files">
    <header className="cust-files-head">
      <div><h3>{customer.name}</h3><p className="dim small">{files.length ? t('files.cust.top', { n: files.length, top: topCategories(files, catLabel) }) : t('files.cust.files', { n: 0 })}
        {!hasBizcert && customer.status !== 'closed' && <span className="badge warn cust-files-missing">{t('files.cust.missing')}</span>}</p></div>
      <div className="cust-files-add">
        <select className="input" value={type} onChange={(e) => setType(e.target.value)} aria-label={t('files.cust.type')}>{CUSTOMER_TYPES.map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}</select>
        <button type="button" className="btn sm" disabled={busy} onClick={() => input.current?.click()}><FIcon name="upload" />{t('files.cust.add')}</button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { const l = [...e.target.files]; e.target.value = ''; upload(l); }} />
      </div>
    </header>
    {data.error && <p className="bizui-error" role="alert">{t(data.error)}</p>}
    {!data.files && data.loading ? <p className="dim small">{t('files.loading')}</p>
      : !files.length ? <p className="dim small cust-files-empty">{t('files.cust.empty')}</p>
        : <div className="table-wrap"><table className="table cust-files-table"><tbody>
          {groups.map(([cat, list]) => [
            <tr key={`h-${cat}`} className="cust-files-group"><td colSpan={5}>{catLabel(cat)}<span className="dim"> {t('files.cust.n', { n: list.length })}</span></td></tr>,
            ...list.map((f) => <tr key={f.id} onContextMenu={(e) => menu(e, f)}>
              <td><button type="button" className="files-name" onClick={() => open(f)}><FIcon name={kindOfRow(f)} size={14} /><span className="files-title">{f.title}</span></button></td>
              <td className="dim small c-kind">{t(`files.kind.${kindOfRow(f)}`)}</td>
              <td className="num dim small c-size">{f.kind === 'file' ? fmtBytes(f.size ?? 0) : '—'}</td>
              <td className="dim small c-date">{day(f.created_at)}</td>
              <td className="files-act"><button type="button" className="icon-btn" aria-label={t('more')} onClick={(e) => menu(e, f)}><Icon name="dots" size={14} /></button></td>
            </tr>),
          ])}
        </tbody></table></div>}
  </div>;
}
export default CustomerFiles;
