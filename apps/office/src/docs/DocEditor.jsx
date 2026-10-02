// 견적서·계약서 작성 — 왼쪽 입력, 오른쪽 실제 서식 미리보기(인트라넷은 만들고 나서야 PDF로 볼 수 있었다).
// 입력 칸은 인트라넷 app/quote-contract/page.tsx와 같고, 서식에는 있었지만 화면에 없던 칸(작성일·유효기간·옵션 표·착수 기준·비고·부제)도 연다.
// 'PDF 만들기'는 브라우저 안에서 PDF를 만들어(pdf/html-to-pdf.js) 보관하고, 거래·문서함에 잇는다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../core/i18n.js';
import { showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { getCompanyInfo } from './company-info.js';
import { renderDocHtml, PREVIEW_FONT_CSS } from './templates.js';
import { emptyItem, docTotals, validateDoc, quoteInput, contractInput, docTitle, docFilename, docSummary, applyBizcert, matchCustomer, dealPlan, won, TAX_TYPES } from './model.js';
import { sha256Hex } from './esign-model.js';
import { backend } from './backend.js';
import { fileToDocStore } from './doc-store-bridge.js';
import { DOC } from './doc-text.js';

const lines = (v) => (Array.isArray(v) ? v.join('\n') : v ?? '');

function Field({ label, hint, wide, children }) {
  return <label className={`field-block docs-field${wide ? ' wide' : ''}`}><span className="label">{label}</span>{children}{hint && <span className="dim small">{hint}</span>}</label>;
}

function ItemsEditor({ items, setItems, catalog = [] }) {
  const upd = (i, k, v) => setItems(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  const totals = docTotals(items);
  return <div className="docs-items">
    <div className="docs-item-head" aria-hidden="true"><span>{t('docs.item.name')}</span><span className="num">{t('docs.item.price')}</span><span className="num">{t('docs.item.qty')}</span><span>{t('docs.item.tax')}</span><span className="num">{t('docs.item.amount')}</span><span /></div>
    {items.map((it, i) => <div className="docs-item" key={i}>
      <div className="docs-item-name">
        <input className="input" placeholder={t('docs.item.name')} aria-label={t('docs.item.name')} value={it.name} onChange={(e) => upd(i, 'name', e.target.value)} maxLength={200} />
        <input className="input sub" placeholder={t('docs.item.desc')} aria-label={t('docs.item.desc')} value={it.desc} onChange={(e) => upd(i, 'desc', e.target.value)} maxLength={500} />
      </div>
      <input className="input num" type="number" min="0" step="1" placeholder="0" aria-label={t('docs.item.price')} value={it.unitPrice} onChange={(e) => upd(i, 'unitPrice', e.target.value)} />
      <input className="input num" type="number" min="0" step="1" aria-label={t('docs.item.qty')} value={it.qty} onChange={(e) => upd(i, 'qty', e.target.value)} />
      <select className="input" aria-label={t('docs.item.tax')} value={it.taxType ?? 'taxable'} onChange={(e) => upd(i, 'taxType', e.target.value)}>{TAX_TYPES.map((k) => <option key={k} value={k}>{t(`docs.tax.${k}`)}</option>)}</select>
      <span className="num mono">{won((Number(it.unitPrice) || 0) * (Number(it.qty) || 0))}</span>
      <button type="button" className="icon-btn" aria-label={t('docs.item.remove')} disabled={items.length === 1} onClick={() => setItems(items.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></button>
    </div>)}
    <div className="docs-items-foot">
      <button type="button" className="btn sm ghost" onClick={() => setItems([...items, emptyItem()])}><Icon name="plus" size={13} />{t('docs.item.add')}</button>
      {catalog.length > 0 && <select className="input sm" value="" aria-label={t('docs.item.fromCatalog')} onChange={(e) => { const it = catalog.find((c) => c.id === e.target.value); if (!it) return; const blank = items.length === 1 && !items[0].name.trim(); const row = { ...emptyItem(), name: it.name, unitPrice: String(it.price) }; setItems(blank ? [row] : [...items, row]); }}>
        <option value="">{t('docs.item.fromCatalog')}</option>{catalog.map((c) => <option key={c.id} value={c.id}>{c.name} · {won(c.price)}</option>)}</select>}
      <span className="spacer" />
      <span className="dim small mono">{t('docs.supply')} {won(totals.supply)} · {t('docs.vat')} {won(totals.vat)} · <strong className="docs-total">{t('docs.total')} {won(totals.total)}{t('docs.wonUnit')}</strong></span>
    </div>
  </div>;
}

function OptionEditor({ option, setOption }) {
  const rows = option.rows ?? [];
  const upd = (i, k, v) => setOption({ ...option, rows: rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)) });
  return <details className="docs-option" open={rows.length > 0}>
    <summary>{t('docs.option.title')}<span className="dim small"> · {t('docs.option.hint')}</span></summary>
    <Field label={t('docs.option.heading')}><input className="input" value={option.title ?? ''} placeholder={t('docs.option.headingPh')} onChange={(e) => setOption({ ...option, title: e.target.value })} maxLength={200} /></Field>
    {rows.map((r, i) => <div className="docs-option-row" key={i}>
      <input className="input" placeholder={t('docs.option.name')} value={r.name} onChange={(e) => upd(i, 'name', e.target.value)} maxLength={100} />
      <input className="input num" type="number" min="0" placeholder={t('docs.option.price')} value={r.unitPrice} onChange={(e) => upd(i, 'unitPrice', e.target.value)} />
      <input className="input" placeholder={t('docs.option.condition')} value={r.condition} onChange={(e) => upd(i, 'condition', e.target.value)} maxLength={500} />
      <button type="button" className="icon-btn" aria-label={t('docs.item.remove')} onClick={() => setOption({ ...option, rows: rows.filter((_, j) => j !== i) })}><Icon name="trash" size={14} /></button>
    </div>)}
    <button type="button" className="btn sm ghost" onClick={() => setOption({ ...option, rows: [...rows, { name: '', unitPrice: '', condition: '' }] })}><Icon name="plus" size={13} />{t('docs.option.add')}</button>
  </details>;
}

/** 미리보기 — 794px(210mm) 폭 서식을 칸 폭에 맞춰 줄인다. 입력이 멈추고 0.25초 뒤에 다시 그린다 */
function Preview({ html, pages }) {
  const box = useRef(null);
  const [scale, setScale] = useState(0.5);
  const [shown, setShown] = useState(html);
  useEffect(() => { const id = setTimeout(() => setShown(html), 250); return () => clearTimeout(id); }, [html]);
  useEffect(() => {
    const el = box.current; if (!el) return undefined;
    const ro = new ResizeObserver(() => setScale(Math.min(1, el.clientWidth / 794)));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const h = pages * 1123;
  return <div className="docs-preview" ref={box} style={{ height: h * scale }}>
    <iframe title={t('docs.preview')} srcDoc={shown} sandbox="allow-same-origin" style={{ width: 794, height: h, transform: `scale(${scale})` }} tabIndex={-1} />
  </div>;
}

/** kind: 'quote'|'contract' · initial: 입력값 · business: useBusiness(space) · onDone(row) */
export function DocEditor({ space, kind, initial, business, onDone, onCancel }) {
  const [doc, setDoc] = useState(initial);
  const [company, setCompany] = useState(null);
  const [busy, setBusy] = useState(null); // 진행 단계 사전 키
  const [errors, setErrors] = useState([]);
  const [ocr, setOcr] = useState(null);
  const [sealSupplier, setSealSupplier] = useState(false);
  const [asDeal, setAsDeal] = useState(kind === 'quote' && !initial.orderId);
  const fileRef = useRef(null);
  const data = business?.data;
  const canDeal = !!data?.can_write;
  useEffect(() => { let live = true; getCompanyInfo(space).then((c) => { if (live) { setCompany(c); setSealSupplier(!!c.seal && kind === 'contract'); } }); return () => { live = false; }; }, [space, kind]);
  const set = (k, v) => setDoc((d) => ({ ...d, [k]: v }));
  const setParty = (k, v) => setDoc((d) => ({ ...d, party: { ...d.party, [k]: v } }));
  const input = useMemo(() => (kind === 'contract' ? contractInput(doc) : quoteInput(doc)), [doc, kind]);
  const html = useMemo(() => (company ? renderDocHtml(kind, input, company, { fontCss: PREVIEW_FONT_CSS, sealSupplier }) : ''), [kind, input, company, sealSupplier]);
  const pages = kind === 'contract' ? 3 : 2 + Math.max(1, Math.ceil(input.items.length / 7));
  const customers = data?.customers ?? [];
  const order = data?.orders?.find((o) => o.id === doc.orderId);

  /** 거래처를 고르면(이름이 정확히 같을 때) 거래처 id를 잇고, 계약서면 비어 있는 갑 칸을 거래처 정보로 채운다 */
  const pickCustomer = (name) => {
    const c = customers.find((x) => x.name === name);
    setDoc((d) => {
      const next = { ...d, customer: name, customerId: c?.id ?? (d.customerId && customers.find((x) => x.id === d.customerId)?.name === name ? d.customerId : '') };
      if (c && kind === 'contract') {
        const p = d.party ?? {};
        next.party = { company: p.company || c.name, bizNo: p.bizNo || c.biz_no || '', ceo: p.ceo || c.ceo || '', address: p.address || c.address || '', contact: p.contact || [c.manager, c.phone].filter(Boolean).join(' / '), email: p.email || c.email || '' };
      }
      return next;
    });
  };

  const onCert = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setOcr({ step: 'start' });
    try {
      const { readBizcert } = await import('./bizcert-ocr.js');
      const r = await readBizcert(space, file, { onStep: (step) => setOcr({ step }) });
      if (r.error === 'type') { setOcr(null); showToast(t('docs.ocr.type')); return; }
      const found = Object.values(r.fields ?? {}).filter(Boolean).length;
      setDoc((d) => applyBizcert(d, r.fields));
      setOcr({ done: true, fields: r.fields, via: r.via });
      showToast(found ? t('docs.ocr.done') : t('docs.ocr.none'));
    } catch (err) { console.warn('[office docs] OCR', err); setOcr(null); showToast(t('docs.ocr.fail')); }
  };

  /** 읽은 사업자등록증 값을 거래처에도 저장(거래처 카드가 비어 있던 칸만이 아니라 지금 갑 칸 값으로) */
  const saveToCustomer = async () => {
    const c = customers.find((x) => x.id === doc.customerId);
    if (!c) return;
    try {
      await business.mutate('customer.save', { ...c, name: c.name, biz_no: doc.party.bizNo || c.biz_no, ceo: doc.party.ceo || c.ceo, address: doc.party.address || c.address, email: c.email, version: c.version });
      showToast(t('docs.ocr.savedCustomer'));
    } catch { showToast(t('docs.err.customerSave')); }
  };

  const submit = async (event) => {
    event.preventDefault();
    const errs = validateDoc(doc);
    setErrors(errs);
    if (errs.length) return;
    try {
      setBusy('docs.step.pdf');
      const { htmlToPdf } = await import('./pdf/html-to-pdf.js');
      const { bytes } = await htmlToPdf(renderDocHtml(kind, input, company, { sealSupplier }));
      setBusy('docs.step.save');
      const totals = docTotals(input.items);
      const be = await backend();
      let row = await be.saveDoc(space, {
        kind, title: docTitle(doc), customer_name: input.customer, customer_id: doc.customerId || null, order_id: doc.orderId || null,
        input: { ...doc, sealSupplier }, pdf: bytes, pdf_hash: await sha256Hex(bytes), filename: docFilename(doc), supply: totals.supply, vat: totals.vat, total: totals.total,
      });
      let orderId = doc.orderId, dealError = null;
      // 견적서로 거래 등록(인트라넷 quotes route:38-61 — 실패해도 문서는 그대로 남는다)
      if (!orderId && asDeal && canDeal && kind === 'quote') {
        setBusy('docs.step.deal');
        try {
          const plan = dealPlan(doc, data);
          const customerId = plan.customer_id ?? (await business.mutate('customer.save', plan.newCustomer)).id;
          const lineRows = [];
          for (const l of plan.lines) lineRows.push({ item_id: l.item_id ?? (await business.mutate('item.save', l.newItem)).id, quantity: l.quantity, unit_price: l.unit_price, tax_type: l.tax_type });
          orderId = (await business.mutate('order.create', { title: plan.title, customer_id: customerId, lines: lineRows })).id;
          row = await be.saveDoc(space, { ...row, input: { ...row.input, orderId, customerId }, order_id: orderId, customer_id: customerId });
        } catch (err) { dealError = err?.message ?? 'deal'; }
      }
      if (orderId && canDeal) {
        await business.mutate('link.add', { order_id: orderId, kind: 'file', ref: `office-doc:${row.id}`, title: row.title }).catch(() => {});
      }
      setBusy('docs.step.file');
      const customer = customers.find((c) => c.id === (row.customer_id ?? doc.customerId)) ?? matchCustomer(input.customer, customers);
      await fileToDocStore(space, { file: new Blob([bytes], { type: 'application/pdf' }), filename: docFilename(doc), title: row.title, category: kind, customerId: customer?.id, customerName: input.customer, dealId: orderId || undefined, tags: [DOC.kind[kind], input.customer].filter(Boolean), summary: docSummary(doc), refDoc: row.id });
      showToast(t(kind === 'contract' ? 'docs.made.contract' : 'docs.made.quote'));
      if (dealError) showToast(t('docs.err.deal'));
      onDone(row, { bytes, orderId, dealError });
    } catch (err) {
      console.warn('[office docs] make failed', err);
      setErrors([err?.code === 'quota' ? 'docs.err.quota' : 'docs.err.make']);
    } finally { setBusy(null); }
  };

  const ocrText = ocr?.step === 'ocr' ? t('docs.ocr.reading') : ocr?.step && !ocr.done ? t('docs.ocr.loading') : null;
  return <form className="docs-editor" onSubmit={submit}>
    <div className="docs-form">
      {order && <p className="docs-from"><Icon name="deal" size={13} />{t('docs.fromDeal', { title: order.title })}</p>}
      <div className="docs-grid">
        <Field label={t(kind === 'contract' ? 'docs.f.contractTitle' : 'docs.f.title')}><input className="input" value={doc.title} onChange={(e) => set('title', e.target.value)} placeholder={t(kind === 'contract' ? 'docs.ph.contractTitle' : 'docs.ph.title')} maxLength={200} /></Field>
        <Field label={`${t(kind === 'contract' ? 'docs.f.customerA' : 'docs.f.customer')} *`}>
          <input className="input" list={`docs-customers-${kind}`} value={doc.customer} onChange={(e) => pickCustomer(e.target.value)} placeholder={t(kind === 'contract' ? 'docs.ph.customerA' : 'docs.ph.customer')} maxLength={200} required aria-required="true" />
          <datalist id={`docs-customers-${kind}`}>{customers.map((c) => <option key={c.id} value={c.name} />)}</datalist>
          {doc.customerId ? <span className="dim small"><Icon name="check" size={11} /> {t('docs.linkedCustomer')}</span> : doc.customer && customers.length > 0 && <span className="dim small">{t('docs.newCustomer')}</span>}
        </Field>
        {kind === 'contract' && <Field label={t('docs.f.serviceSummary')} wide><input className="input" value={doc.serviceSummary} onChange={(e) => set('serviceSummary', e.target.value)} placeholder={t('docs.ph.serviceSummary')} maxLength={300} /></Field>}
        <Field label={t(kind === 'contract' ? 'docs.f.subtitle' : 'docs.f.summary')} wide><input className="input" value={doc.summary} onChange={(e) => set('summary', e.target.value)} placeholder={t(kind === 'contract' ? 'docs.ph.subtitle' : 'docs.ph.summary')} maxLength={300} /></Field>
        <Field label={t('docs.f.date')}><input className="input" type="date" value={doc.date} onChange={(e) => set('date', e.target.value)} required /></Field>
        {kind === 'quote' && <Field label={t('docs.f.validUntil')}>
          <div className="docs-inline"><input className="input" type="date" value={doc.validUntil} disabled={doc.showValid === false} onChange={(e) => set('validUntil', e.target.value)} /><label className="docs-check"><input type="checkbox" checked={doc.showValid !== false} onChange={(e) => set('showValid', e.target.checked)} />{t('docs.f.showValid')}</label></div>
        </Field>}
      </div>

      {kind === 'contract' && <section className="docs-card">
        <header className="docs-card-head"><h3>{t('docs.party.title')}</h3>
          <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={onCert} />
          <button type="button" className="btn sm" disabled={!!ocrText} onClick={() => fileRef.current?.click()}><Icon name="file" size={13} />{ocrText ?? t('docs.ocr.button')}</button>
        </header>
        <div className="docs-grid">
          <Field label={t('docs.party.company')}><input className="input" value={doc.party.company} onChange={(e) => setParty('company', e.target.value)} placeholder={t('docs.ph.company')} maxLength={200} /></Field>
          <Field label={t('docs.party.bizNo')}><input className="input mono" value={doc.party.bizNo} onChange={(e) => setParty('bizNo', e.target.value)} placeholder="000-00-00000" maxLength={20} /></Field>
          <Field label={t('docs.party.ceo')}><input className="input" value={doc.party.ceo} onChange={(e) => setParty('ceo', e.target.value)} placeholder={t('docs.ph.ceo')} maxLength={100} /></Field>
          <Field label={t('docs.party.contact')}><input className="input" value={doc.party.contact} onChange={(e) => setParty('contact', e.target.value)} placeholder={t('docs.ph.contact')} maxLength={200} /></Field>
          <Field label={t('docs.party.email')}><input className="input" type="email" value={doc.party.email} onChange={(e) => setParty('email', e.target.value)} placeholder="signer@client.com" maxLength={320} /></Field>
          <Field label={t('docs.party.address')} wide><input className="input" value={doc.party.address} onChange={(e) => setParty('address', e.target.value)} maxLength={500} /></Field>
        </div>
        <p className="dim small">{t('docs.party.hint')}</p>
        {ocr?.done && <div className="docs-ocr-result" role="status"><span>{t(`docs.ocr.via.${ocr.via}`)} · {['company', 'bizNo', 'ceo', 'address'].filter((k) => ocr.fields?.[k]).map((k) => t(`docs.party.${k}`)).join(', ') || t('docs.ocr.nothing')}</span>
          {doc.customerId && canDeal && <button type="button" className="btn sm" onClick={saveToCustomer}>{t('docs.ocr.toCustomer')}</button>}</div>}
      </section>}

      {kind === 'contract' && <div className="docs-grid">
        <Field label={t('docs.f.purpose')} wide><input className="input" value={doc.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder={t('docs.ph.purpose')} maxLength={300} /></Field>
        <Field label={t('docs.f.scope')}><textarea className="input area" rows={3} value={lines(doc.scope)} onChange={(e) => set('scope', e.target.value)} placeholder={t('docs.ph.scope')} /></Field>
        <Field label={t('docs.f.scopeNote')}><textarea className="input area" rows={3} value={doc.scopeNote} onChange={(e) => set('scopeNote', e.target.value)} placeholder={t('docs.ph.scopeNote')} maxLength={1000} /></Field>
      </div>}

      <Field label={`${t(kind === 'contract' ? 'docs.f.contractItems' : 'docs.f.items')} *`} wide><ItemsEditor items={doc.items} setItems={(v) => set('items', v)} catalog={data?.items ?? []} /></Field>
      <OptionEditor option={doc.option ?? { title: '', rows: [] }} setOption={(v) => set('option', v)} />

      {kind === 'quote' ? <div className="docs-grid">
        <Field label={t('docs.f.terms')}><textarea className="input area" rows={3} value={lines(doc.terms)} onChange={(e) => set('terms', e.target.value)} placeholder={t('docs.ph.terms')} /></Field>
        <Field label={t('docs.f.notes')} hint={t('docs.f.notesHint')}><textarea className="input area" rows={3} value={lines(doc.notes)} onChange={(e) => set('notes', e.target.value)} placeholder={t('docs.ph.notes')} /></Field>
      </div> : <div className="docs-grid">
        <Field label={t('docs.f.payment')}><select className="input" value={doc.payment} onChange={(e) => set('payment', e.target.value)}><option value="split">{t('docs.payment.split')}</option><option value="full">{t('docs.payment.full')}</option></select></Field>
        <Field label={t('docs.f.ip')}><select className="input" value={doc.ip} onChange={(e) => set('ip', e.target.value)}><option value="service">{t('docs.ip.service')}</option><option value="product">{t('docs.ip.product')}</option></select></Field>
        <Field label={t('docs.f.startBasis')}><input className="input" value={doc.startBasis} onChange={(e) => set('startBasis', e.target.value)} placeholder={DOC.startBasis[doc.payment === 'full' ? 'full' : 'split']} maxLength={200} /></Field>
        <Field label={t('docs.f.schedule')}><input className="input" value={doc.schedule} onChange={(e) => set('schedule', e.target.value)} placeholder={t('docs.ph.schedule')} maxLength={300} /></Field>
        <Field label={t('docs.f.method')}><input className="input" value={doc.method} onChange={(e) => set('method', e.target.value)} placeholder={t('docs.ph.method')} maxLength={200} /></Field>
        <Field label={t('docs.f.deliverable')}><input className="input" value={doc.deliverable} onChange={(e) => set('deliverable', e.target.value)} placeholder={t('docs.ph.deliverable')} maxLength={300} /></Field>
        <Field label={t('docs.f.note')} wide><input className="input" value={doc.note} onChange={(e) => set('note', e.target.value)} placeholder={t('docs.ph.note')} maxLength={1000} /></Field>
        {company?.seal && <label className="docs-check wide"><input type="checkbox" checked={sealSupplier} onChange={(e) => setSealSupplier(e.target.checked)} /><span>{t('docs.f.seal')}<span className="dim small"> · {t('docs.f.sealHint')}</span></span></label>}
      </div>}

      {kind === 'quote' && !doc.orderId && canDeal && <label className="docs-check"><input type="checkbox" checked={asDeal} onChange={(e) => setAsDeal(e.target.checked)} /><span>{t('docs.f.asDeal')}<span className="dim small"> · {t('docs.f.asDealHint')}</span></span></label>}
      {company && !company.bizNo && <p className="docs-warn small" role="note"><Icon name="info" size={13} />{t('docs.companyMissing')}</p>}
      {errors.length > 0 && <div className="bizui-error" role="alert">{errors.map((e) => <p key={e}>{t(e)}</p>)}</div>}
      <div className="docs-actions">
        <button type="button" className="btn" disabled={!!busy} onClick={onCancel}>{t('docs.cancel')}</button>
        <button type="submit" className="btn primary" disabled={!!busy || !company}>{busy ? t(busy) : t(kind === 'contract' ? 'docs.make.contract' : 'docs.make.quote')}</button>
      </div>
    </div>
    <aside className="docs-preview-col" aria-label={t('docs.preview')}>
      <div className="docs-preview-head"><span className="label">{t('docs.preview')}</span><span className="dim small">{t('docs.pages', { n: pages })}</span></div>
      {company ? <Preview html={html} pages={pages} /> : <div className="docs-preview boot" aria-busy="true" />}
    </aside>
  </form>;
}
