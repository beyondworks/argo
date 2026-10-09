// 견적·계약·전자서명 화면(메뉴 '견적·계약') — 인트라넷 /quote-contract + /esign 두 화면을 한 화면의 두 탭으로.
// 주소가 곧 상태: ?new=quote|contract(&order=거래|&from=문서) 작성 · ?tab=esign · ?esign=new 새 서명 요청 · ?setup=<서명 id> 세팅 · ?open=<서명 id>|doc:<문서 id> 옆 패널.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import './register-i18n.js';
import './docs.css';
import { t, useLang, getLang } from '../core/i18n.js';
import { navigate } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import { getMode } from '../core/session.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Panel } from '../ui/Panel.jsx';
import { Icon } from '../ui/Icon.jsx';
import { openMenu } from '../ui/Menu.jsx';
import { useBusiness } from '../business/data.js';
import { getCompanyInfo } from './company-info.js';
import { backend } from './backend.js';
import { emptyDoc, fromDeal, fromCustomer, quoteToContract, won, isoDay } from './model.js';
import { partyLabel, draftSigners, signedFilename, signedCount } from './esign-model.js';
import { DocEditor } from './DocEditor.jsx';
import { EsignSetup } from './EsignSetup.jsx';
import { fileToDocStore, hasDocStore } from './doc-store-bridge.js';
import { fileSignedCopies } from './filing.js';
import { mailAccounts, resendLink, sendCompletedNotice } from './esign-flow.js';
import { DOC } from './doc-text.js';
import { useSelection, selProps } from '../core/selection.js';
import { Hide, Redact } from '../business/Redact.jsx';
import { setUi } from '../core/ui-state.js';
import { quoteText } from '../core/crew-items.js';
import { badgeTone } from '../ui/badge-tone.js';

const DocZoom = lazy(() => import('./DocZoom.jsx'));
const when = (v) => (v ? new Date(v).toLocaleString(getLang() === 'en' ? 'en-US' : 'ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const day = (v) => (v ? new Date(v).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—');
const STATUS_BADGE = { draft: '', sent: 'warn', completed: 'ok', cancelled: 'danger' };
/** 보낸 뒤 전원이 서명했는데 아직 완료가 아니면 서명본 만들기가 중간에 끊긴 것 — 취소 대신 '완료 다시 시도' */
const allSigned = (e) => e.status === 'sent' && e.signers.length > 0 && e.signers.every((s) => s.status === 'signed');

/** 내려받기 — 브라우저가 저장 */
export function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 패널 안 PDF — 위에 '크게 보기'(작성 화면 미리보기와 같은 창, 같은 돋보기 줄) */
function PdfFrame({ bytes, title, filename }) {
  const url = useMemo(() => (bytes ? URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })) : null), [bytes]);
  const [zoom, setZoom] = useState(false);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (!url) return <div className="docs-pdf boot" aria-busy="true" />;
  return <div className="docs-pdf-wrap">
    <button type="button" className="btn sm docs-pdf-zoom" onClick={() => setZoom(true)}><Icon name="expand" size={13} />{t('docs.zoom.open')}</button>
    <div className="ha ha-cover"><iframe className="docs-pdf" title={title} src={url} /></div>{/* 화면 전체 가리기 중 흐림 — 누르고 있으면 보인다(18차 검수 M3) */}
    {zoom && <Suspense fallback={null}><DocZoom title={title} pdf={bytes} onClose={() => setZoom(false)} onDownload={async () => download(bytes, filename || `${title}.pdf`)} /></Suspense>}
  </div>;
}

export function useDocs(space) {
  const [state, setState] = useState({ data: null, error: null });
  const reload = useCallback(async () => {
    try { const be = await backend(); setState({ data: await be.load(space), error: null }); }
    catch (e) { console.warn('[office docs] load', e); setState((s) => ({ data: s.data, error: e?.code === 'schema' ? 'docs.err.schema' : 'docs.err.load' })); }
  }, [space]);
  useEffect(() => {
    reload();
    // 다른 탭에서 서명이 끝났을 수 있어 창으로 돌아오면 다시 읽는다 — 30초에 한 번까지(읽기만, 폴링 없음)
    let at = Date.now();
    const onFocus = () => { if (Date.now() - at < 30_000) return; at = Date.now(); reload(); };
    const onRefresh = () => reload();
    window.addEventListener('focus', onFocus); window.addEventListener('office:docs-refresh', onRefresh);
    return () => { window.removeEventListener('focus', onFocus); window.removeEventListener('office:docs-refresh', onRefresh); };
  }, [reload]);
  return { ...state, reload };
}

export default function DocsPage({ space, params }) {
  useLang();
  const business = useBusiness(space);
  const docs = useDocs(space);
  const [company, setCompany] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind:'delete'|'cancel'|'deleteDoc', row }
  const [rename, setRename] = useState(null);
  const [result, setResult] = useState(null); // 방금 만든 문서 { row, bytes }
  useEffect(() => { getCompanyInfo(space).then(setCompany); }, [space]);
  const base = `${baseOf(space)}/contracts`;
  const go = (q) => navigate(q ? `${base}?${new URLSearchParams(q)}` : base);
  const tab = params.get('tab') === 'esign' ? 'esign' : 'docs';
  const newKind = ['quote', 'contract'].includes(params.get('new')) ? params.get('new') : null;
  const setupId = params.get('setup'), openId = params.get('open'), esignNew = params.get('esign') === 'new';
  const data = docs.data;
  const canWrite = !!data?.can_write;
  // 이어 쓰기(?from=문서)는 그 문서의 입력값이 필요하다 — 목록에는 싣지 않으므로 한 건만 따로 읽는다
  const fromId = newKind ? params.get('from') : null;
  const [fromDoc, setFromDoc] = useState(null);
  useEffect(() => {
    if (!fromId) { setFromDoc(null); return; }
    let live = true;
    backend().then((be) => be.getDoc(space, fromId)).then((d) => { if (live) setFromDoc(d); }, () => { if (live) setFromDoc({ id: fromId, missing: true }); });
    return () => { live = false; };
  }, [space, fromId]);

  // 서명 완료를 처음 본 화면이 서명본을 문서함에 한 번 넣는다(트랙 B 문서함이 있을 때만 — markFiled로 한 번만)
  useEffect(() => {
    if (!data || !canWrite || !hasDocStore()) return; // 문서함이 없는 판에서는 표시만 해 두지 않는다(병합 뒤 처음 보는 화면이 넣게)
    const todo = data.esign.filter((e) => e.status === 'completed' && !e.filed_at && e.final_path);
    if (!todo.length) return;
    (async () => {
      const be = await backend();
      await fileSignedCopies(todo, {
        pdf: (e) => be.esignPdf(space, e, 'final'),
        entryOf: (e, bytes) => {
          const doc = data.docs.find((d) => d.id === e.doc_id);
          return { file: new Blob([bytes], { type: 'application/pdf' }), filename: signedFilename(e.title), title: DOC.signedTitle(e.title), category: 'contract', customerId: doc?.customer_id ?? undefined, customerName: doc?.customer_name, dealId: e.order_id ?? undefined, tags: ['signed', DOC.signedTag, DOC.kind.contract], summary: DOC.signedSummary(e.title), refEsign: e.id };
        },
        file: (entry) => fileToDocStore(space, entry),
        mark: (id) => be.markFiled(space, id),
      });
      docs.reload();
    })();
  }, [data, canWrite, space]); // eslint-disable-line react-hooks/exhaustive-deps

  const initial = useMemo(() => {
    if (!newKind) return null;
    const orderId = params.get('order');
    const bd = business.data;
    if (orderId && bd) {
      const order = bd.orders.find((o) => o.id === orderId);
      if (order) return fromDeal(newKind, { order, customer: bd.customers.find((c) => c.id === order.customer_id), lines: bd.lines });
    }
    if (fromId) {
      if (fromDoc?.id !== fromId) return undefined; // 문서를 읽는 중
      const src = fromDoc;
      if (src?.input) {
        if (src.kind === newKind) return { ...emptyDoc(newKind), ...src.input, date: isoDay() };
        const c = quoteToContract(src.input);
        const cust = bd?.customers.find((x) => x.id === c.customerId); // 견적서의 거래처가 원장에 있으면 갑 칸(대표자·사업자번호·주소·연락처)도 채운다
        return cust ? { ...c, party: fromCustomer('contract', cust).party } : c;
      }
    }
    const customerId = params.get('customer');
    if (customerId && bd) { const c = bd.customers.find((x) => x.id === customerId); if (c) return fromCustomer(newKind, c); }
    if ((orderId || customerId) && !bd) return undefined; // 업무 원장을 읽는 중
    return emptyDoc(newKind);
  }, [newKind, params, business.data, fromId, fromDoc]);

  const openDoc = async (row, mode = 'view') => {
    const be = await backend();
    const bytes = await be.docPdf(space, row);
    if (mode === 'download') download(bytes, row.filename || `${row.title}.pdf`);
    return bytes;
  };
  const startEsignFromDoc = async (row) => {
    const be = await backend();
    const bytes = await be.docPdf(space, row);
    const { sha256Hex } = await import('./esign-model.js');
    const input = (await be.getDoc(space, row.id)).input ?? {}; // 목록에는 입력값이 없다
    const signers = draftSigners({ clientCompany: input.party?.company || row.customer_name, clientEmail: input.party?.email, company, sealed: !!input.sealSupplier });
    const esign = await be.createEsign(space, { title: row.title.startsWith(DOC.kind.contract + DOC.titleSep) ? row.title.slice((DOC.kind.contract + DOC.titleSep).length) : row.title, docId: row.id, orderId: row.order_id, pdf: bytes, docHash: await sha256Hex(bytes), signers, autoFields: true });
    showToast(t(signers.length ? 'esign.draft.withSigners' : 'esign.draft.noSigners'));
    navigate(`${base}?${new URLSearchParams({ setup: esign.id })}`);
  };

  // 에이전트에게 맡기기(17차 A-5) — 목록 한 줄(종류·거래처·거래·합계·만든 날)을 글자로. 크루는 맡기기 창에서 고른다
  const assignDocs = (rows) => setUi({ assign: { space, items: rows.map((row) => ({ kind: 'doc', id: row.id, label: row.title, text: quoteText(row, { t, money: (n) => `${won(n)}${t('docs.wonUnit')}`, day, deal: row.order_id ? business.data?.orders.find((o) => o.id === row.order_id)?.title : '' }) })) } });
  const docMenu = (event, row) => openMenu(event, [
    { label: t('docs.act.preview'), icon: 'eye', run: () => go({ open: `doc:${row.id}` }) },
    { label: t('docs.act.download'), icon: 'archive', run: () => openDoc(row, 'download').catch(() => showToast(t('docs.err.file'))) },
    { label: t('crew.assign'), icon: 'hand', run: () => assignDocs([row]) },
    canWrite && { label: t('docs.act.again'), icon: 'copy', run: () => go({ new: row.kind, from: row.id }) },
    canWrite && row.kind === 'quote' && { label: t('docs.act.toContract'), icon: 'doc', run: () => go({ new: 'contract', from: row.id }) },
    canWrite && row.kind === 'contract' && { label: t('docs.act.esign'), icon: 'stamp', run: () => startEsignFromDoc(row).catch(() => showToast(t('esign.err.create'))) },
    canWrite && { sep: true },
    canWrite && { label: t('docs.act.delete'), icon: 'trash', danger: true, run: () => setConfirm({ kind: 'deleteDoc', row }) },
  ], { anchor: event.currentTarget });

  const esignMenu = (event, row) => openMenu(event, [
    row.status === 'draft' && canWrite && { label: t('esign.act.setup'), icon: 'stamp', run: () => go({ setup: row.id }) },
    { label: t('esign.act.view'), icon: 'eye', run: () => go({ tab: 'esign', open: row.id }) },
    row.final_path && { label: t('esign.act.downloadFinal'), icon: 'archive', run: async () => { const be = await backend(); download(await be.esignPdf(space, row, 'final'), signedFilename(row.title)); } },
    canWrite && { label: t('esign.act.rename'), icon: 'draft', run: () => setRename({ row, title: row.title }) },
    canWrite && !['completed', 'cancelled'].includes(row.status) && !allSigned(row) && { label: t('esign.act.cancel'), icon: 'x', run: () => setConfirm({ kind: 'cancel', row }) },
    canWrite && { sep: true },
    canWrite && { label: t('esign.act.delete'), icon: 'trash', danger: true, run: () => setConfirm({ kind: 'delete', row }) },
  ], { anchor: event.currentTarget });

  // 여러 개 고르기(11차) — 문서는 한 번에 다운로드, 전자서명은 완료본 한 번에 받기(행 메뉴와 같은 동작). 지우기·취소는 한 건씩 확인 창으로
  const [docSel] = useSelection(data && tab === 'docs' ? 'docs' : null, { keys: (data?.docs ?? []).map((d) => d.id), actions: (keys, clear) => [
    { label: t('docs.act.download'), icon: 'download', run: () => data.docs.filter((d) => keys.includes(d.id)).reduce((p, row) => p.then(() => openDoc(row, 'download')).catch(() => showToast(t('docs.err.file'))), Promise.resolve()) },
    { label: t('crew.assign'), icon: 'hand', run: () => { assignDocs(data.docs.filter((d) => keys.includes(d.id))); clear?.(); } },
  ] });
  const [esSel] = useSelection(data && tab === 'esign' ? 'esign' : null, { keys: (data?.esign ?? []).map((e) => e.id), actions: (keys) => {
    const done = data.esign.filter((e) => keys.includes(e.id) && e.final_path);
    return [done.length > 0 && { label: t('esign.act.downloadFinal'), icon: 'download', run: async () => { const be = await backend(); for (const row of done) download(await be.esignPdf(space, row, 'final'), signedFilename(row.title)); } }];
  } });

  const runConfirm = async () => {
    const { kind, row } = confirm;
    setConfirm(null);
    try {
      const be = await backend();
      if (kind === 'deleteDoc') await be.deleteDoc(space, row.id);
      if (kind === 'cancel') await be.cancelEsign(space, row.id);
      if (kind === 'delete') await be.deleteEsign(space, row.id);
      showToast(t(`esign.done.${kind}`));
      if (openId === row.id || openId === `doc:${row.id}`) go(tab === 'esign' ? { tab } : null);
      docs.reload();
    } catch { showToast(t('esign.err.action')); }
  };
  const saveRename = async (e) => {
    e.preventDefault();
    const title = rename.title.trim();
    if (!title) return;
    try { const be = await backend(); await be.updateEsign(space, rename.row.id, { title }); setRename(null); docs.reload(); showToast(t('esign.done.rename')); } catch { showToast(t('esign.err.action')); }
  };

  // ── 작성 화면 ──
  if (newKind) return <section className="page-wrap wide docs-page">
    <header className="page-title-row"><div><button type="button" className="page-back" onClick={() => go(null)}><Icon name="back" size={12} />{t('docs.title')}</button><h1 className="page-h1">{t(newKind === 'contract' ? 'docs.new.contract' : 'docs.new.quote')}</h1></div></header>
    {initial ? <DocEditor key={`${newKind}:${params.get('order') ?? ''}:${params.get('from') ?? ''}:${params.get('customer') ?? ''}`} space={space} kind={newKind} initial={initial} business={business}
      onCancel={() => go(null)} onDone={(row, extra) => { setResult({ row, bytes: extra.bytes }); docs.reload(); business.refresh?.().catch?.(() => {}); go(null); }} /> : <p role="status">{t('biz.loading')}</p>}
  </section>;

  // ── 서명 세팅 화면 ──
  if (setupId || esignNew) return <section className="page-wrap wide docs-page">
    <EsignSetup key={setupId ?? 'new'} space={space} esignId={setupId} company={company} onBack={() => go({ tab: 'esign' })} onSent={(id) => { docs.reload(); go({ tab: 'esign', open: id }); }} />
  </section>;

  const openEsign = data?.esign.find((e) => e.id === openId);
  const openDocRow = openId?.startsWith('doc:') ? data?.docs.find((d) => d.id === openId.slice(4)) : null;
  const orders = business.data?.orders ?? [];
  const orderTitle = (id) => orders.find((o) => o.id === id)?.title;
  return <section className="page-wrap wide docs-page">
    <header className="page-title-row"><div><h1 className="page-h1">{t('docs.title')}</h1><p className="dim">{t('docs.subtitle')}</p>
      {getMode() === 'sample' && <p className="page-note"><Icon name="info" size={13} />{t('docs.sampleNote')}</p>}</div>
      {canWrite && <div className="row-actions docs-head-actions">
        <button type="button" className="btn sm" onClick={() => go({ new: 'quote' })}><Icon name="plus" size={13} />{t('docs.new.quote')}</button>
        <button type="button" className="btn sm" onClick={() => go({ new: 'contract' })}><Icon name="plus" size={13} />{t('docs.new.contract')}</button>
        <button type="button" className="btn sm primary" onClick={() => go({ esign: 'new' })}><Icon name="stamp" size={13} />{t('esign.new')}</button>
      </div>}
    </header>
    {result && <div className="docs-result" role="status">
      <Icon name="file" size={15} /><strong>{result.row.title}</strong><span className="dim small">{t('docs.result.saved')}</span><span className="spacer" />
      <button type="button" className="btn sm" onClick={() => go({ open: `doc:${result.row.id}` })}><Icon name="eye" size={13} />{t('docs.act.preview')}</button>
      <button type="button" className="btn sm" onClick={() => download(result.bytes, result.row.filename)}>{t('docs.act.download')}</button>
      {result.row.kind === 'quote' && <button type="button" className="btn sm" onClick={() => go({ new: 'contract', from: result.row.id })}>{t('docs.act.toContract')}</button>}
      {result.row.kind === 'contract' && <button type="button" className="btn sm primary" onClick={() => startEsignFromDoc(result.row).catch(() => showToast(t('esign.err.create')))}><Icon name="stamp" size={13} />{t('docs.act.esign')}</button>}
      <button type="button" className="icon-btn" aria-label={t('close')} onClick={() => setResult(null)}><Icon name="x" size={14} /></button>
    </div>}
    <div className="page-tabbar"><div className="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'docs'} className={`tab${tab === 'docs' ? ' on' : ''}`} onClick={() => go(null)}>{t('docs.tab.docs')}{data ? <span className="dim">{data.docs.length}</span> : null}</button>
      <button type="button" role="tab" aria-selected={tab === 'esign'} className={`tab${tab === 'esign' ? ' on' : ''}`} onClick={() => go({ tab: 'esign' })}>{t('docs.tab.esign')}{data ? <span className="dim">{data.esign.length}</span> : null}</button>
    </div><span className="spacer" /><button type="button" className="icon-btn docs-refresh" aria-label={t('docs.refresh')} title={t('docs.refresh')} onClick={() => Promise.all([docs.reload(), business.refresh?.()]).then(() => showToast(t('docs.refreshed')), () => {})}><Icon name="refresh" size={14} /></button></div>
    {docs.error && <p className="bizui-error" role="alert">{t(docs.error)}</p>}
    {!data && !docs.error && <p role="status">{t('biz.loading')}</p>}
    {data && tab === 'docs' && (data.docs.length ? <div className="table-wrap" data-sel-scope="docs"><table className="table docs-table">
      <thead><tr><th>{t('docs.col.kind')}</th><th>{t('docs.col.title')}</th><th className="hide-sm">{t('docs.col.customer')}</th><th className="hide-sm">{t('docs.col.deal')}</th><th className="num">{t('docs.col.total')}</th><th className="hide-sm">{t('docs.col.created')}</th><th className="act" /></tr></thead>
      <tbody>{data.docs.map((d) => <tr key={d.id} className="row-open" {...selProps(docSel, d.id)} onClick={(e) => { if (!e.target.closest('button')) go({ open: `doc:${d.id}` }); }}>
        <td><span className={`badge ${badgeTone(d.kind)}`}>{t(`docs.kind.${d.kind}`)}</span></td>
        <td className="docs-title-cell">{d.title}</td>
        <td className="hide-sm">{d.customer_name ? <Hide k={`doc:${d.id}:customer`} kind="name">{d.customer_name}</Hide> : '—'}</td>
        <td className="hide-sm">{d.order_id ? <button type="button" className="bizui-link" onClick={() => navigate(`${baseOf(space)}/business/orders?open=${d.order_id}`)}>{orderTitle(d.order_id) ?? t('docs.deal')}</button> : <span className="dim">—</span>}</td>
        <td className="num"><Hide k={`doc:${d.id}:total`}>{won(d.total)}</Hide></td>
        <td className="hide-sm mono">{day(d.created_at)}</td>
        <td className="act"><button type="button" className="icon-btn" aria-label={t('more')} onClick={(e) => docMenu(e, d)}><Icon name="dots" /></button></td>
      </tr>)}</tbody></table></div>
      : <div className="empty-state"><Icon name="doc" size={22} /><p>{t('docs.empty')}</p>{canWrite && <div className="row-actions docs-head-actions"><button type="button" className="btn" onClick={() => go({ new: 'quote' })}>{t('docs.new.quote')}</button><button type="button" className="btn" onClick={() => go({ new: 'contract' })}>{t('docs.new.contract')}</button></div>}</div>)}
    {data && tab === 'esign' && (data.esign.length ? <div className="table-wrap" data-sel-scope="esign"><table className="table docs-table">
      <thead><tr><th>{t('esign.col.title')}</th><th className="hide-sm">{t('esign.col.signers')}</th><th>{t('esign.col.status')}</th><th className="hide-sm">{t('esign.col.created')}</th><th className="hide-sm">{t('esign.col.final')}</th><th className="act" /></tr></thead>
      <tbody>{data.esign.map((e) => { const n = signedCount(e.signers); return <tr key={e.id} className="row-open" {...selProps(esSel, e.id)} onClick={(ev) => { if (!ev.target.closest('button')) go({ tab: 'esign', open: e.id }); }}>
        <td className="docs-title-cell">{e.title}{e.order_id && <span className="dim small"> · {orderTitle(e.order_id) ?? t('docs.deal')}</span>}</td>
        <td className="hide-sm"><span className="docs-signers">{e.signers.map((s) => <span key={s.id} className={s.status === 'signed' ? 'on' : ''} title={t(s.status === 'signed' ? 'esign.signer.signed' : 'esign.signer.pending')}><i />{s.name}</span>)}{!e.signers.length && <span className="dim">—</span>}</span></td>
        <td><span className={`badge ${STATUS_BADGE[e.status]}`}>{t(`esign.status.${e.status}`)}</span>{e.status === 'sent' && <span className="dim small mono"> {n.done}/{n.total}</span>}</td>
        <td className="hide-sm mono">{day(e.created_at)}</td>
        <td className="hide-sm">{e.final_path ? <button type="button" className="bizui-link" onClick={async () => { const be = await backend(); download(await be.esignPdf(space, e, 'final'), signedFilename(e.title)); }}><Icon name="archive" size={12} /> {t('esign.download')}</button> : <span className="dim">—</span>}</td>
        <td className="act"><div className="docs-row-acts">{e.status === 'draft' && canWrite && <button type="button" className="btn sm" onClick={() => go({ setup: e.id })}>{t('esign.act.setupShort')}</button>}<button type="button" className="icon-btn" aria-label={t('more')} onClick={(ev) => esignMenu(ev, e)}><Icon name="dots" /></button></div></td>
      </tr>; })}</tbody></table></div>
      : <div className="empty-state"><Icon name="stamp" size={22} /><p>{t('esign.empty')}</p>{canWrite && <button type="button" className="btn primary" onClick={() => go({ esign: 'new' })}>{t('esign.first')}</button>}</div>)}

    {openDocRow && <DocPanel space={space} row={openDocRow} onClose={() => go(null)} canWrite={canWrite} onEsign={() => startEsignFromDoc(openDocRow).catch(() => showToast(t('esign.err.create')))} go={go} onAssign={() => assignDocs([openDocRow])} />}
    {openEsign && <EsignPanel space={space} row={openEsign} company={company} canWrite={canWrite} onClose={() => go({ tab: 'esign' })} reload={docs.reload} orderTitle={orderTitle(openEsign.order_id)} />}
    {confirm && <Modal open title={t(`esign.confirm.${confirm.kind}.title`)} onClose={() => setConfirm(null)}
      footer={<><button type="button" className="btn" onClick={() => setConfirm(null)}>{t('docs.cancel')}</button><button type="button" className={`btn ${confirm.kind === 'cancel' ? 'primary' : 'danger'}`} onClick={runConfirm}>{t(`esign.confirm.${confirm.kind}.ok`)}</button></>}>
      <p><strong>{confirm.row.title}</strong></p><p className="dim">{t(`esign.confirm.${confirm.kind}.body`)}</p></Modal>}
    {rename && <Modal open title={t('esign.act.rename')} onClose={() => setRename(null)} footer={<><button type="button" className="btn" onClick={() => setRename(null)}>{t('docs.cancel')}</button><button type="submit" form="esign-rename" className="btn primary" disabled={!rename.title.trim()}>{t('docs.save')}</button></>}>
      <form id="esign-rename" onSubmit={saveRename}><label className="field-block"><span className="label">{t('esign.f.title')}</span><input className="input" value={rename.title} maxLength={200} onChange={(e) => setRename({ ...rename, title: e.target.value })} /></label></form></Modal>}
  </section>;
}

function DocPanel({ space, row, onClose, canWrite, onEsign, go, onAssign }) {
  const [bytes, setBytes] = useState(null);
  useEffect(() => { let live = true; backend().then((be) => be.docPdf(space, row)).then((b) => { if (live) setBytes(b); }).catch(() => showToast(t('docs.err.file'))); return () => { live = false; }; }, [space, row]);
  return <Panel title={row.title} onClose={onClose} footer={<>
    <button type="button" className="btn" onClick={onAssign}><Icon name="hand" size={13} />{t('crew.assign')}</button>
    <button type="button" className="btn" disabled={!bytes} onClick={() => download(bytes, row.filename || `${row.title}.pdf`)}>{t('docs.act.download')}</button>
    {canWrite && <button type="button" className="btn" onClick={() => go({ new: row.kind, from: row.id })}>{t('docs.act.again')}</button>}
    {canWrite && row.kind === 'contract' && <button type="button" className="btn primary" onClick={onEsign}><Icon name="stamp" size={13} />{t('docs.act.esign')}</button>}
  </>}>
    <dl className="docs-meta"><div><dt>{t('docs.col.customer')}</dt><dd>{row.customer_name ? <Hide k={`doc:${row.id}:customer`} kind="name">{row.customer_name}</Hide> : '—'}</dd></div><div><dt>{t('docs.col.total')}</dt><dd className="mono"><Hide k={`doc:${row.id}:total`}>{won(row.total)}{t('docs.wonUnit')}</Hide></dd></div><div><dt>{t('docs.col.created')}</dt><dd>{when(row.created_at)}</dd></div></dl>
    <PdfFrame bytes={bytes} title={row.title} filename={row.filename} />
  </Panel>;
}

function EsignPanel({ space, row, company, canWrite, onClose, reload, orderTitle }) {
  const [bytes, setBytes] = useState(null);
  const [events, setEvents] = useState([]);
  const [mails, setMails] = useState([]);
  const [links, setLinks] = useState({});
  const which = row.final_path ? 'final' : 'orig';
  useEffect(() => {
    let live = true;
    backend().then(async (be) => {
      const [b, ev, ml] = await Promise.all([be.esignPdf(space, row, which), be.events(space, row.id), be.mails?.(space, row.id) ?? []]);
      if (live) { setBytes(b); setEvents(ev); setMails(ml); }
    }).catch(() => showToast(t('docs.err.file')));
    return () => { live = false; };
  }, [space, row, which]);
  const accounts = mailAccounts();
  const resend = async (s) => {
    try {
      const l = await resendLink({ space, esign: row, signer: s, company, account: accounts[0]?.id });
      setLinks((x) => ({ ...x, [s.id]: l.link }));
      showToast(t(l.delivery === 'sent' || l.delivery === 'recorded' ? 'esign.resent' : 'esign.linkOnly'));
      reload();
    } catch { showToast(t('esign.err.action')); }
  };
  const copy = (link) => navigator.clipboard?.writeText(link).then(() => showToast(t('esign.copied')), () => {});
  const [finishing, setFinishing] = useState(false);
  const finish = async () => {
    setFinishing(true);
    try { const be = await backend(); await be.finishEsign(space, row.id); showToast(t('esign.finished')); reload(); }
    catch (e) { showToast(t(e?.code === 'tampered' ? 'esign.err.tampered' : 'esign.err.finish')); }
    finally { setFinishing(false); }
  };
  return <Panel title={row.title} onClose={onClose} footer={<>
    {allSigned(row) && canWrite && <button type="button" className="btn primary" disabled={finishing} onClick={finish}>{t('esign.act.finish')}</button>}
    {row.final_path && <button type="button" className="btn primary" onClick={() => download(bytes, signedFilename(row.title))} disabled={!bytes}>{t('esign.act.downloadFinal')}</button>}
    {row.status === 'completed' && canWrite && getMode() !== 'sample' && !row.notified_at && <button type="button" className="btn" disabled={!accounts.length} title={accounts.length ? '' : t('esign.needMail')} onClick={() => sendCompletedNotice({ space, esign: row, account: accounts[0]?.id }).then(() => { showToast(t('esign.noticeSent')); reload(); }, () => showToast(t('esign.err.mail')))}>{t('esign.sendNotice')}</button>}
  </>}>
    <dl className="docs-meta">
      <div><dt>{t('esign.col.status')}</dt><dd><span className={`badge ${STATUS_BADGE[row.status]}`}>{t(`esign.status.${row.status}`)}</span></dd></div>
      <div><dt>{t('esign.col.created')}</dt><dd>{when(row.created_at)}</dd></div>
      {row.sent_at && <div><dt>{t('esign.sentAt')}</dt><dd>{when(row.sent_at)}</dd></div>}
      {row.completed_at && <div><dt>{t('esign.completedAt')}</dt><dd>{when(row.completed_at)}</dd></div>}
      {row.order_id && <div><dt>{t('docs.col.deal')}</dt><dd>{orderTitle ?? t('docs.deal')}{row.order_sync && <span className="dim small"> · {t(row.order_sync === 'confirmed' ? 'esign.sync.confirmed' : row.order_sync.startsWith('skipped') ? 'esign.sync.skipped' : 'esign.sync.failed')}</span>}</dd></div>}
    </dl>
    <section className="docs-sub"><h3>{t('esign.col.signers')}</h3>
      <ul className="docs-signer-list">{row.signers.map((s) => <li key={s.id}>
        <span className={`badge ${s.status === 'signed' ? 'ok' : ''}`}>{partyLabel(s.ord)}</span><span><strong>{s.name}</strong> <span className="dim small"><Hide k={`doc:${row.id}:signer:${s.id}`}>{s.email}</Hide></span></span><span className="spacer" />
        <span className="dim small">{s.status === 'signed' ? `${t('esign.signer.signed')} ${when(s.signed_at)}` : s.opened_at ? `${t('esign.signer.opened')} ${when(s.opened_at)}` : t('esign.signer.pending')}</span>
        {row.status === 'sent' && s.status !== 'signed' && canWrite && <button type="button" className="btn sm" onClick={() => resend(s)}>{t('esign.resend')}</button>}
        {links[s.id] && <button type="button" className="btn sm ghost" onClick={() => copy(links[s.id])}><Icon name="copy" size={12} />{t('esign.copyLink')}</button>}
      </li>)}</ul>
    </section>
    {allSigned(row) && <p className="docs-warn small" role="status">{t('esign.stuck')}</p>}
    {row.final_path && <p className="dim small">{t('esign.finalShown')}</p>}
    <PdfFrame bytes={bytes} title={row.title} filename={row.final_path ? signedFilename(row.title) : undefined} />
    {mails.length > 0 && <section className="docs-sub"><h3>{t('esign.mails')}</h3><p className="dim small">{t('esign.mailsHint')}</p>
      <ul className="docs-log">{mails.slice().reverse().map((m) => <li key={m.id}><span className="mono small">{when(m.at)}</span><span><Redact kind="contact">{m.to}</Redact></span><span className="dim ha">{m.subject}</span>{m.link && <a className="bizui-link" href={m.link} target="_blank" rel="noreferrer">{t('esign.openLink')}</a>}{m.attachment && <span className="badge">{m.attachment}</span>}</li>)}</ul></section>}
    <section className="docs-sub"><h3>{t('esign.events')}</h3>
      <ul className="docs-log">{events.slice().reverse().map((ev) => <li key={ev.id}><span className="mono small">{when(ev.at)}</span><span className="badge">{t(`esign.ev.${ev.action}`)}</span><span className="dim small">{ev.actor === 'owner' ? t('esign.actor.owner') : ev.actor === 'system' ? t('esign.actor.system') : ev.actor}{ev.ip ? ` · ${ev.ip}` : ''}</span></li>)}</ul>
    </section>
  </Panel>;
}
