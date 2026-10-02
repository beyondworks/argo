// 서명 세팅·발송(인트라넷 app/esign/new/page.tsx) — PDF를 고르거나(새 서명 요청) 초안을 불러와, 서명자(갑·을·병…)와
// 서명자별 칸(서명·글자·날짜)을 문서 위에 놓고 보낸다. 칸이 하나도 없으면 문서 글자에서 서명란을 찾아 미리 놓는다(인트라넷 autofields — 서버 대신 여기서).
import { useEffect, useRef, useState } from 'react';
import { t } from '../core/i18n.js';
import { getMode } from '../core/session.js';
import { showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { backend } from './backend.js';
import { autoFields } from './detect.js';
import { PARTY, DEFAULT_SIZE, checkSend, sha256Hex, isEmail } from './esign-model.js';
import { mailAccounts, requestSignatures } from './esign-flow.js';

const KINDS = ['signature', 'text', 'date'];
const KIND_ICON = { signature: 'draft', text: 'doc', date: 'calendar' };
const uid = () => Math.random().toString(36).slice(2, 9);

export function EsignSetup({ space, esignId, company, onBack, onSent }) {
  const [draft, setDraft] = useState(null);       // 불러온 초안(esignId가 있을 때)
  const [title, setTitle] = useState('');
  const [file, setFile] = useState(null);          // 새 요청: 고른 PDF
  const [bytes, setBytes] = useState(null);
  const [signers, setSigners] = useState([{ name: '', email: '' }, { name: '', email: '' }]);
  const [fields, setFields] = useState([]);
  const [active, setActive] = useState(0);
  const [tool, setTool] = useState('signature');
  const [pages, setPages] = useState(0);
  const [autoNote, setAutoNote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(null);          // 발송 결과(링크·메일 여부)
  const [sealedB, setSealedB] = useState(false);   // 원본 계약서에 을 도장을 찍었는가(을이 서명자에서 빠진 이유를 알린다)
  const [account, setAccount] = useState(() => mailAccounts()[0]?.id ?? '');
  const [, force] = useState(0);
  const holder = useRef(null); // pdfjs가 쪽을 그리는 자리(React 자식 없음)
  const wrap = useRef(null);   // 칸을 얹는 자리
  const gesture = useRef(null);
  const ref = useRef({ active: 0, tool: 'signature' });
  ref.current = { active, tool };
  const signersRef = useRef(signers);
  signersRef.current = signers;
  const color = (ord) => `var(--signer-${ord % 5})`;

  // 초안 불러오기
  useEffect(() => {
    if (!esignId) return;
    let live = true;
    (async () => {
      try {
        const be = await backend();
        const e = await be.getEsign(space, esignId).catch((x) => { if (x?.code === 'not_found') return null; throw x; }); // 칸 배치까지 한 건만
        if (!e) { setErr(t('esign.err.missing')); return; }
        if (!live) return;
        setDraft(e); setTitle(e.title);
        if (e.signers.length) setSigners(e.signers.map((s) => ({ name: s.name, email: s.email })));
        setFields((e.fields ?? []).map((f) => ({ ...f, id: f.id || uid() })));
        setBytes(await be.esignPdf(space, e, 'orig'));
        if (e.doc_id) be.getDoc(space, e.doc_id).then((d) => { if (live) setSealedB(!!d?.input?.sealSupplier); }, () => {});
      } catch { setErr(t('esign.err.load')); }
    })();
    return () => { live = false; };
  }, [space, esignId]);

  // PDF 그리기 + 칸이 없으면 자동 감지
  useEffect(() => {
    if (!bytes || !holder.current) return;
    let live = true;
    (async () => {
      const { renderPdf } = await import('./pdf/view.js');
      const { pages: n, items } = await renderPdf(bytes, holder.current, { maxWidth: 780, onPage: (layer, page) => layer.addEventListener('click', (e) => onPageClick(e, page)) });
      if (!live) return;
      setPages(n);
      setFields((cur) => {
        if (cur.length) return cur;
        // 서명자가 정해진 초안(갑만 — 을은 도장)이면 그 밖의 서명자 칸은 놓지 않는다(서명표 을 칸 등)
        const named = signersRef.current.filter((s) => s.name || s.email).length;
        const found = autoFields(items).filter((f) => !named || f.signer_ord < named).map((f) => ({ ...f, id: uid() }));
        setAutoNote(found.length ? found.length : 0);
        return found;
      });
      force((x) => x + 1);
    })().catch((e) => { console.warn('[office esign] render', e); setErr(t('esign.err.render')); });
    return () => { live = false; };
  }, [bytes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = () => force((x) => x + 1);
    window.addEventListener('resize', on); window.addEventListener('scroll', on, true);
    return () => { window.removeEventListener('resize', on); window.removeEventListener('scroll', on, true); };
  }, []);

  const layerOf = (page) => holder.current?.querySelector(`[data-page="${page}"]`) ?? null;
  function onPageClick(e, page) {
    if (gesture.current || e.target.closest('.esign-field')) return;
    const { active: ord, tool: kind } = ref.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const { wr, hr } = DEFAULT_SIZE[kind];
    const xr = Math.max(0, Math.min(1 - wr, (e.clientX - rect.left) / rect.width - wr / 2));
    const yr = Math.max(0, Math.min(1 - hr, (e.clientY - rect.top) / rect.height - hr / 2));
    setFields((f) => [...f, { id: uid(), signer_ord: ord, page, xr, yr, wr, hr, kind, required: true }]);
  }
  const upd = (id, patch) => setFields((f) => f.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const del = (id) => setFields((f) => f.filter((x) => x.id !== id));
  function start(e, it, type) {
    if (type === 'move' && e.target.closest('.del,.rz')) return;
    e.preventDefault(); e.stopPropagation();
    const lr = layerOf(it.page).getBoundingClientRect();
    gesture.current = { type, id: it.id, sx: e.clientX, sy: e.clientY, xr0: it.xr, yr0: it.yr, wr0: it.wr, hr0: it.hr, lw: lr.width, lh: lr.height };
    const move = (ev) => {
      const g = gesture.current; if (!g) return;
      if (g.type === 'move') upd(g.id, { xr: Math.max(0, Math.min(0.99, g.xr0 + (ev.clientX - g.sx) / g.lw)), yr: Math.max(0, Math.min(0.99, g.yr0 + (ev.clientY - g.sy) / g.lh)) });
      else upd(g.id, { wr: Math.max(0.04, Math.min(1, g.wr0 + (ev.clientX - g.sx) / g.lw)), hr: Math.max(0.02, Math.min(0.5, g.hr0 + (ev.clientY - g.sy) / g.lh)) });
    };
    const up = () => { setTimeout(() => { gesture.current = null; }, 0); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  const setSigner = (i, k, v) => setSigners((s) => s.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  const pick = (f) => { setFile(f); setFields([]); setAutoNote(null); setPages(0); if (!title) setTitle(f.name.replace(/\.pdf$/i, '')); f.arrayBuffer().then((b) => setBytes(new Uint8Array(b))); };

  /** 초안으로 저장만(나중에 이어서) — 새 요청이면 초안을 만든다 */
  async function ensureDraft(be) {
    if (draft) { await be.updateEsign(space, draft.id, { title, fields, signers }); return draft; }
    const created = await be.createEsign(space, { title, pdf: bytes, docHash: await sha256Hex(bytes), fields, signers, pages });
    setDraft(created);
    return created;
  }
  const saveDraft = async () => {
    setErr(''); if (!bytes) return setErr(t('esign.err.pdf'));
    setBusy(true);
    try { const be = await backend(); await ensureDraft(be); showToast(t('esign.draftSaved')); } catch { setErr(t('esign.err.action')); } finally { setBusy(false); }
  };
  const submit = async () => {
    setErr('');
    const check = checkSend({ hasPdf: !!bytes, signers, fields, status: draft?.status ?? 'draft' });
    if (check.error) return setErr(t(check.error));
    setBusy(true);
    try {
      const be = await backend();
      const e = await ensureDraft(be);
      const r = await requestSignatures({ space, esign: e, signers: check.signers, fields: check.fields, company, account: account || null });
      setSent(r);
      if (check.warn) showToast(t(check.warn));
    } catch (e2) { setErr(t(e2?.code ? `esign.err.${e2.code}` : 'esign.err.action')); } finally { setBusy(false); }
  };

  const accounts = mailAccounts();
  const sample = getMode() === 'sample';
  // 페이지 머리(유건 10/2 10차) — 견적서 작성 화면과 같은 자리: 뒤로 링크는 머리 위 여백에, 제목은 다른 페이지 제목과 같은 높이
  const head = (title, sub) => <header className="page-title-row"><div><button type="button" className="page-back" onClick={onBack}><Icon name="back" size={12} />{t('docs.tab.esign')}</button>
    <h1 className="page-h1">{title}</h1><p className="dim">{sub}</p></div></header>;
  if (sent) return <div className="esign-sent">
    {head(t('esign.sent.title'), t(sample ? 'esign.sent.sample' : sent.links.every((l) => l.delivery === 'sent') ? 'esign.sent.mailed' : 'esign.sent.linkOnly'))}
    <ul className="docs-signer-list">{sent.links.map((l) => <li key={l.email}><span className="badge">{PARTY[l.ord] ?? l.ord + 1}</span><span><strong>{l.name}</strong> <span className="dim small">{l.email}</span></span><span className="spacer" />
      <span className={`badge ${l.delivery === 'failed' ? 'danger' : l.delivery === 'skipped' ? 'warn' : 'ok'}`}>{t(`esign.delivery.${l.delivery}`)}</span>
      <button type="button" className="btn sm ghost" onClick={() => navigator.clipboard?.writeText(l.link).then(() => showToast(t('esign.copied')), () => {})}><Icon name="copy" size={12} />{t('esign.copyLink')}</button>
      {sample && <a className="btn sm" href={l.link} target="_blank" rel="noreferrer">{t('esign.openLink')}</a>}
    </li>)}</ul>
    <div className="docs-actions"><button type="button" className="btn primary" onClick={() => onSent(sent.esign.id)}>{t('esign.sent.done')}</button></div>
  </div>;

  const hb = wrap.current?.getBoundingClientRect();
  return <>{head(t(draft ? 'esign.setup.title' : 'esign.new'), t(draft ? 'esign.setup.help' : 'esign.new.help'))}<div className="esign-setup">
    <aside className="esign-side">
      <label className="field-block"><span className="label">{t('esign.f.title')}</span><input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={t('esign.ph.title')} /></label>
      <div className="field-block"><span className="label">{t('esign.f.pdf')}</span>
        {esignId ? <span className="chip"><Icon name="file" size={12} />{bytes ? t('esign.pdfLoaded') : t('biz.loading')}</span>
          : <label className="chip docs-file"><Icon name="file" size={12} />{file ? file.name : t('esign.pickPdf')}<input type="file" accept="application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }} /></label>}
      </div>
      <div className="field-block"><span className="label">{t('esign.col.signers')}</span>
        {signers.map((s, i) => <div className="esign-signer" key={i} style={{ '--c': color(i) }}>
          <span className="party">{PARTY[i] ?? i + 1}</span>
          <div className="esign-signer-fields">
            <input className="input" value={s.name} placeholder={t('esign.ph.name')} maxLength={100} onChange={(e) => setSigner(i, 'name', e.target.value)} />
            <input className={`input${s.email && !isEmail(s.email) ? ' bad' : ''}`} type="email" value={s.email} placeholder={t('esign.ph.email')} maxLength={320} onChange={(e) => setSigner(i, 'email', e.target.value)} />
          </div>
          {signers.length > 1 && <button type="button" className="icon-btn" aria-label={t('esign.removeSigner')} onClick={() => { setSigners((p) => p.filter((_, j) => j !== i)); setFields((f) => f.filter((x) => x.signer_ord !== i).map((x) => (x.signer_ord > i ? { ...x, signer_ord: x.signer_ord - 1 } : x))); if (active >= i && active > 0) setActive(active - 1); }}><Icon name="trash" size={13} /></button>}
        </div>)}
        {sealedB && !signers.some((s) => company?.email && s.email === company.email) && <p className="dim small esign-sealed" role="note"><Icon name="stamp" size={13} />{t('esign.sealedB')}</p>}
        {signers.length < 5 && <button type="button" className="btn sm ghost" onClick={() => setSigners((s) => [...s, { name: '', email: '' }])}><Icon name="plus" size={13} />{t('esign.addSigner')}</button>}
        {company?.email && !signers.some((s) => s.email === company.email) && <button type="button" className="btn sm ghost" onClick={() => setSigners((s) => { const i = s.findIndex((x) => !x.name && !x.email); const me = { name: company.name, email: company.email }; return i >= 0 ? s.map((x, j) => (j === i ? me : x)) : [...s, me]; })}><Icon name="person" size={13} />{t('esign.addCompany', { name: company.name })}</button>}
      </div>
      {bytes && <div className="field-block esign-tools"><span className="label">{t('esign.place')} <span className="dim">· {t('esign.placeHint', { n: fields.length })}</span></span>
        <span className="dim small">{t('esign.target')}</span>
        <div className="chips">{signers.map((s, i) => (s.name || s.email || i < 2) && <button type="button" key={i} className={`esign-target${active === i ? ' on' : ''}`} style={{ '--c': color(i) }} onClick={() => setActive(i)}>{PARTY[i] ?? i + 1} {s.name || t('esign.signerN', { n: i + 1 })}</button>)}</div>
        <span className="dim small">{t('esign.kind')}</span>
        <div className="seg">{KINDS.map((k) => <button type="button" key={k} className={`seg-btn${tool === k ? ' on' : ''}`} onClick={() => setTool(k)}><Icon name={KIND_ICON[k]} size={12} /> {t(`esign.kind.${k}`)}</button>)}</div>
        {autoNote != null && <p className="dim small" role="status">{autoNote ? t('esign.autoPlaced', { n: autoNote }) : t('esign.autoNone')}</p>}
      </div>}
      {!sample && <div className="field-block"><span className="label">{t('esign.f.mail')}</span>
        {accounts.length ? <select className="input" value={account} onChange={(e) => setAccount(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.address}</option>)}<option value="">{t('esign.noMailSend')}</option></select>
          : <p className="dim small">{t('esign.noMailAccount')}</p>}</div>}
      {err && <p className="bizui-error" role="alert">{err}</p>}
      <div className="esign-side-actions">
        <button type="button" className="btn" disabled={busy} onClick={saveDraft}>{t('esign.saveDraft')}</button>
        <button type="button" className="btn primary" disabled={busy} onClick={submit}><Icon name="send" size={13} />{busy ? t('esign.sending') : t(draft ? 'esign.sendSetup' : 'esign.send')}</button>
      </div>
    </aside>
    <div className="esign-doc">
      {!bytes ? (esignId ? <div className="esign-drop">{t('biz.loading')}</div>
        : <label className="esign-drop pick"><Icon name="file" size={20} /><span>{t('esign.dropHint')}</span><span className="btn sm">{t('esign.pickPdf')}</span>
          <input type="file" accept="application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); }} /></label>)
        : <div ref={wrap} className="esign-pages"><div ref={holder} />
          {hb && fields.map((it) => {
            const layer = layerOf(it.page); if (!layer) return null;
            const lr = layer.getBoundingClientRect();
            return <div key={it.id} className="esign-field" style={{ '--c': color(it.signer_ord), top: lr.top - hb.top + it.yr * lr.height, left: lr.left - hb.left + it.xr * lr.width, width: it.wr * lr.width, height: it.hr * lr.height }}>
              <div className="body" onPointerDown={(e) => start(e, it, 'move')}>{PARTY[it.signer_ord] ?? ''} {t(`esign.kind.${it.kind}`)}</div>
              <button type="button" className="del" aria-label={t('docs.item.remove')} onClick={() => del(it.id)}><Icon name="x" size={12} /></button>
              <div className="rz" onPointerDown={(e) => start(e, it, 'resize')} />
            </div>;
          })}
        </div>}
    </div>
  </div></>;
}
