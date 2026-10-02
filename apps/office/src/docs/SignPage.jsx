// 서명 페이지(로그인 없이 /sign/<토큰>) — 인트라넷 app/sign/[token]/page.tsx를 오피스 모양으로.
// 순서: 링크 확인 → 본인 이메일 확인 → 문서 위 칸 채우기(서명 만들기·서명 그림 올리기·글자 넣기, 이전/다음 안내) → 제출.
// 완료·취소된 계약은 잠그고, 이미 낸 사람은 다시 낼 수 없다. 화면 글자는 사전(ko/en), 문서·메일 서식은 한국어.
import { useEffect, useRef, useState } from 'react';
import './register-i18n.js';
import './docs.css';
import { t, useLang } from '../core/i18n.js';
import { Icon } from '../ui/Icon.jsx';
import { backend } from './backend.js';
import { detectFields } from './detect.js';
import { signedFilename } from './esign-model.js';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const uid = () => Math.random().toString(36).slice(2, 9);
const ERR = { invalid: 'sign.err.invalid', email: 'sign.err.email', completed: 'sign.err.completed', cancelled: 'sign.err.cancelled', already: 'sign.err.already', empty: 'sign.err.empty', tampered: 'sign.err.tampered' };
const errKey = (e) => ERR[e?.code] ?? 'sign.err.request';

function Shell({ children, narrow }) {
  return <div className="sign-page"><div className={`sign-wrap${narrow ? ' narrow' : ''}`}>{children}</div></div>;
}
function Lock({ icon, title, body }) {
  return <Shell narrow><div className="sign-card sign-lock"><Icon name={icon} size={26} /><h1>{t(title)}</h1><p className="dim">{t(body)}</p></div></Shell>;
}

export default function SignPage({ token }) {
  useLang();
  const [phase, setPhase] = useState('loading');
  const [masked, setMasked] = useState('');
  const [email, setEmail] = useState('');
  const [gateErr, setGateErr] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [info, setInfo] = useState(null);
  const [slots, setSlots] = useState([]);
  const [sig, setSig] = useState('');
  const [activeIdx, setActiveIdx] = useState(-1);
  const [pending, setPending] = useState(null); // 'text' — 문서를 눌러 놓기
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signErr, setSignErr] = useState('');
  const [done, setDone] = useState(null);
  const [, force] = useState(0);
  const holder = useRef(null), wrap = useRef(null), fileRef = useRef(null), gesture = useRef(null), pendingRef = useRef(null), rendered = useRef(false);
  pendingRef.current = pending;

  useEffect(() => {
    document.title = 'e-sign';
    backend().then((be) => be.publicState(token)).then((d) => {
      if (d.status === 'completed') setPhase('completed');
      else if (d.status === 'cancelled') setPhase('cancelled');
      else { setMasked(d.maskedEmail ?? ''); setPhase('gate'); }
    }).catch((e) => { setGateErr(t(errKey(e))); setPhase('invalid'); });
  }, [token]);

  async function verify(e) {
    e?.preventDefault();
    if (!email.trim()) { setGateErr(t('sign.err.emailEmpty')); return; }
    setVerifying(true); setGateErr('');
    try {
      const be = await backend();
      const d = await be.publicOpen(token, email.trim());
      setInfo(d);
      if (d.fields?.length) {
        setSlots(d.fields.map((f) => ({ id: f.id || uid(), page: f.page, kind: f.kind, xr: f.xr, yr: f.yr, wr: f.wr, hr: f.hr, ...(f.kind === 'signature' ? {} : { text: f.kind === 'date' ? today() : '', sizeR: Math.max(0.014, Math.min(0.03, (f.hr || 0.03) * 0.6)) }) })));
        setActiveIdx(0);
      }
      setPhase(d.alreadySigned ? 'alreadySigned' : 'signing');
    } catch (err) { setGateErr(t(errKey(err))); } finally { setVerifying(false); }
  }

  useEffect(() => {
    if (phase !== 'signing' || !info?.pdf || rendered.current || !holder.current) return;
    rendered.current = true;
    (async () => {
      const { renderPdf } = await import('./pdf/view.js');
      const { items } = await renderPdf(info.pdf, holder.current, { maxWidth: 820, onPage: (layer, page) => layer.addEventListener('click', (e) => onPageClick(e, page)) });
      if (!info.fields?.length) { // 소유자가 놓은 칸이 없으면 자동 감지(인트라넷 sign page:168-182)
        const found = detectFields(items);
        setSlots(found.map((f) => ({ id: f.id, page: f.page, kind: f.kind, xr: f.xr, yr: f.yr, wr: f.wr, hr: f.hr, auto: true, ...(f.kind === 'text' ? { text: '', sizeR: Math.max(0.014, Math.min(0.03, f.hr * 0.75)) } : {}) })));
        setActiveIdx(found.length ? 0 : -1);
      }
      force((n) => n + 1);
    })().catch(() => setSignErr(t('sign.err.render')));
  }, [phase, info]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phase !== 'signing') return undefined;
    const on = () => force((n) => n + 1);
    window.addEventListener('scroll', on, true); window.addEventListener('resize', on);
    return () => { window.removeEventListener('scroll', on, true); window.removeEventListener('resize', on); };
  }, [phase]);

  const layerOf = (page) => holder.current?.querySelector(`[data-page="${page}"]`) ?? null;
  function onPageClick(e, page) {
    const kind = pendingRef.current;
    if (!kind || gesture.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xr = Math.max(0, Math.min(0.95, (e.clientX - rect.left) / rect.width)), yr = Math.max(0, Math.min(0.95, (e.clientY - rect.top) / rect.height));
    setSlots((p) => [...p, kind === 'signature' ? { id: uid(), page, kind: 'signature', xr, yr, wr: 0.16, hr: 0.05, imgDataUrl: pendingSig.current } : { id: uid(), page, kind: 'text', xr, yr, wr: 0.3, hr: 0.03, text: '', sizeR: 0.02 }]);
    setPending(null); setSignErr('');
  }
  const pendingSig = useRef('');
  const update = (id, patch) => setSlots((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const remove = (id) => setSlots((p) => p.filter((x) => x.id !== id));
  /** 서명을 정하면 빈 서명란 전부에 들어간다(인트라넷 sign page:207-211). 빈 서명란이 없으면 문서를 눌러 놓는다 */
  function applySignature(img) {
    setSig(img); setModal(false);
    setSlots((p) => {
      if (!p.some((s) => s.kind === 'signature' && !s.imgDataUrl)) { pendingSig.current = img; setPending('signature'); return p; }
      return p.map((s) => (s.kind === 'signature' && !s.imgDataUrl ? { ...s, imgDataUrl: img } : s));
    });
  }
  function scrollTo(idx) {
    const s = slots[idx]; if (!s) return;
    setActiveIdx(idx);
    const layer = layerOf(s.page); if (!layer) return;
    const lr = layer.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + lr.top + s.yr * lr.height - window.innerHeight * 0.42, behavior: 'smooth' });
    if (s.kind !== 'signature') setTimeout(() => document.getElementById(`ta-${s.id}`)?.focus(), 450);
  }
  function next() {
    if (!slots.length) return;
    const ni = activeIdx < slots.length - 1 ? activeIdx + 1 : 0;
    const s = slots[ni];
    if (s?.kind === 'signature' && !sig && !s.imgDataUrl) setModal(true);
    scrollTo(ni);
  }
  const prev = () => slots.length && scrollTo(activeIdx > 0 ? activeIdx - 1 : slots.length - 1);
  function start(e, it, type) {
    if (type === 'move' && e.target.closest('.del,.rz,textarea')) return;
    e.preventDefault(); e.stopPropagation();
    setActiveIdx(slots.findIndex((x) => x.id === it.id));
    const lr = layerOf(it.page).getBoundingClientRect();
    gesture.current = { type, id: it.id, kind: it.kind, sx: e.clientX, sy: e.clientY, xr0: it.xr, yr0: it.yr, wr0: it.wr, sr0: it.sizeR || 0.02, lw: lr.width, lh: lr.height };
    const move = (ev) => {
      const g = gesture.current; if (!g) return;
      if (g.type === 'move') update(g.id, { xr: Math.max(0, Math.min(0.99, g.xr0 + (ev.clientX - g.sx) / g.lw)), yr: Math.max(0, Math.min(0.99, g.yr0 + (ev.clientY - g.sy) / g.lh)) });
      else if (g.kind !== 'signature') update(g.id, { sizeR: Math.max(0.012, Math.min(0.09, g.sr0 + (ev.clientY - g.sy) / g.lh)) });
      else update(g.id, { wr: Math.max(0.05, Math.min(1, g.wr0 + (ev.clientX - g.sx) / g.lw)) });
    };
    const up = () => { setTimeout(() => { gesture.current = null; }, 0); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  function onUpload(e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg)$/.test(f.type)) { setSignErr(t('sign.err.imageType')); return; }
    if (f.size > 2 * 1024 * 1024) { setSignErr(t('sign.err.imageSize')); return; }
    const rd = new FileReader();
    rd.onload = () => applySignature(String(rd.result));
    rd.readAsDataURL(f);
  }
  async function submit() {
    const items = slots.filter((s) => (s.kind === 'signature' ? s.imgDataUrl : (s.text || '').trim()))
      .map((s) => ({ page: s.page, kind: s.kind === 'signature' ? 'signature' : 'text', xr: s.xr, yr: s.yr, wr: s.wr, imgDataUrl: s.imgDataUrl, text: s.text, sizeR: s.sizeR }));
    if (!items.length) { setSignErr(t('sign.err.empty')); return; }
    const emptyRequired = slots.filter((s) => s.kind === 'signature' && !s.imgDataUrl && !s.auto).length;
    if (emptyRequired) { setSignErr(t('sign.err.missingSig', { n: emptyRequired })); return; } // 오피스 추가: 소유자가 놓은 서명란을 비운 채 낼 수 없다
    setBusy(true); setSignErr('');
    try { const be = await backend(); const r = await be.publicSubmit(token, email.trim(), items); setDone(r); setPhase('done'); }
    catch (err) { setSignErr(t(errKey(err))); } finally { setBusy(false); }
  }

  if (phase === 'loading') return <Shell narrow><p className="dim" role="status">{t('biz.loading')}</p></Shell>;
  if (phase === 'completed') return <Lock icon="lock" title="sign.completed.title" body="sign.completed.body" />;
  if (phase === 'cancelled') return <Lock icon="x" title="sign.cancelled.title" body="sign.cancelled.body" />;
  if (phase === 'alreadySigned') return <Lock icon="check" title="sign.already.title" body="sign.already.body" />;
  if (phase === 'invalid') return <Lock icon="info" title="sign.invalid.title" body="sign.invalid.body" />;
  if (phase === 'done') return <Shell narrow><div className="sign-card sign-lock"><Icon name="check" size={26} /><h1>{t('sign.done.title')}</h1><p className="dim">{t(done?.done ? 'sign.done.all' : 'sign.done.body')}</p>
    {done?.final && <button type="button" className="btn" onClick={() => { const url = URL.createObjectURL(new Blob([done.final], { type: 'application/pdf' })); Object.assign(document.createElement('a'), { href: url, download: signedFilename(done.title) }).click(); setTimeout(() => URL.revokeObjectURL(url), 10_000); }}>{t('sign.done.download')}</button>}</div></Shell>;
  if (phase === 'gate') return <Shell narrow>
    <p className="sign-brand">e‑<em>sign</em></p>
    <form className="sign-card" onSubmit={verify}>
      <h1>{t('sign.gate.title')}</h1>
      <p className="dim">{t('sign.gate.body', { email: masked })}</p>
      <label className="field-block"><span className="label">{t('sign.gate.email')}</span><input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus /></label>
      {gateErr && <p className="bizui-error" role="alert">{gateErr}</p>}
      <button type="submit" className="btn primary" disabled={verifying}>{verifying ? t('sign.gate.checking') : t('sign.gate.submit')}</button>
    </form>
  </Shell>;

  const hb = wrap.current?.getBoundingClientRect();
  const total = slots.length;
  const filled = slots.filter((s) => (s.kind === 'signature' ? s.imgDataUrl : (s.text || '').trim())).length;
  const activeSlot = slots[activeIdx];
  const textActive = !!activeSlot && activeSlot.kind !== 'signature';
  const bump = (d) => activeSlot && update(activeSlot.id, { sizeR: Math.max(0.01, Math.min(0.09, (activeSlot.sizeR || 0.02) + d)) });
  return <div className="sign-page">
    <div className="sign-wrap sign-two">
      <aside className="sign-side"><div className="sign-card">
        <p className="sign-brand">e‑<em>sign</em></p>
        <p className="dim small">{t('sign.help', { name: info.signer.name })}</p>
        <div className="sign-tools">
          <button type="button" className="btn" onClick={() => setModal(true)}><Icon name="draft" size={13} />{t('sign.make')}</button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}><Icon name="file" size={13} />{t('sign.upload')}</button>
          <button type="button" className="btn" onClick={() => setPending('text')}><Icon name="doc" size={13} />{t('sign.addText')}</button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden onChange={onUpload} />
        </div>
        {sig && <div className="sign-ready"><span className="badge ok">{t('sign.ready')}</span><img src={sig} alt={t('sign.make')} /></div>}
        {pending && <p className="sign-pending small" role="status">{t(pending === 'text' ? 'sign.pendingText' : 'sign.pendingSig')}</p>}
        {textActive && <div className="sign-font"><span className="dim small">{t('sign.fontSize')}</span><button type="button" className="btn sm" aria-label={t('sign.smaller')} onClick={() => bump(-0.003)}>−</button><button type="button" className="btn sm" aria-label={t('sign.bigger')} onClick={() => bump(0.003)}>＋</button></div>}
        <div className="sign-progress">
          <p className="small"><strong>{total ? t('sign.slot', { i: Math.min(activeIdx + 1, total), n: total }) : t('sign.noSlots')}</strong> · {t('sign.filled', { f: filled, n: total })}</p>
          {total > 0 && <div className="sign-nav"><button type="button" className="btn" onClick={prev}>{t('sign.prev')}</button><button type="button" className="btn" onClick={next}>{t('sign.next')}</button></div>}
          <button type="button" className="btn primary block" disabled={busy} onClick={submit}>{busy ? t('sign.submitting') : t('sign.submit')}</button>
          {signErr && <p className="bizui-error" role="alert">{signErr}</p>}
        </div>
      </div></aside>
      <main className="sign-doc">
        <h1 className="page-h1">{info.contract.title}</h1>
        <div ref={wrap} className="esign-pages"><div ref={holder} />
          {hb && slots.map((it, idx) => {
            const layer = layerOf(it.page); if (!layer) return null;
            const lr = layer.getBoundingClientRect();
            const width = it.wr * lr.width;
            const height = it.kind === 'signature' ? Math.max(it.hr * lr.height, width * 0.4) : undefined;
            const empty = it.kind === 'signature' ? !it.imgDataUrl : !(it.text || '').trim();
            return <div key={it.id} className={`sign-slot${idx === activeIdx ? ' active' : ''}${empty ? ' empty' : ''}`} style={{ top: lr.top - hb.top + it.yr * lr.height, left: lr.left - hb.left + it.xr * lr.width, width, height }}>
              <div className="body" onPointerDown={(e) => start(e, it, 'move')} onClick={() => { setActiveIdx(idx); if (it.kind === 'signature' && !it.imgDataUrl) { if (sig) update(it.id, { imgDataUrl: sig }); else setModal(true); } }}>
                {it.kind === 'signature' ? (it.imgDataUrl ? <img src={it.imgDataUrl} alt="" /> : <span className="ph">{t('sign.slotSig')}</span>)
                  : <textarea id={`ta-${it.id}`} value={it.text} rows={1} placeholder={t('sign.slotText')} style={{ fontSize: (it.sizeR || 0.02) * lr.height }}
                    onChange={(ev) => { update(it.id, { text: ev.target.value }); ev.target.style.height = 'auto'; ev.target.style.height = `${ev.target.scrollHeight}px`; }} onFocus={() => setActiveIdx(idx)} onPointerDown={(e) => e.stopPropagation()} />}
              </div>
              <button type="button" className="del" aria-label={t('docs.item.remove')} onClick={() => remove(it.id)}><Icon name="x" size={12} /></button>
              <div className="rz" onPointerDown={(e) => start(e, it, 'resize')} title={t('sign.resize')} />
            </div>;
          })}
        </div>
      </main>
    </div>
    {modal && <SignModal onClose={() => setModal(false)} onSave={applySignature} />}
  </div>;
}

/** 손으로 서명 그리기 — 빈 캔버스는 받지 않는다 */
function SignModal({ onClose, onSave }) {
  const ref = useRef(null), drawing = useRef(false), inked = useRef(false);
  useEffect(() => {
    const c = ref.current, ctx = c.getContext('2d');
    ctx.lineWidth = 2.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) }; };
    const down = (e) => { drawing.current = true; c.setPointerCapture?.(e.pointerId); const { x, y } = pos(e); ctx.beginPath(); ctx.moveTo(x, y); };
    const move = (e) => { if (!drawing.current) return; const { x, y } = pos(e); ctx.lineTo(x, y); ctx.stroke(); inked.current = true; };
    const up = () => { drawing.current = false; };
    c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => { c.removeEventListener('pointerdown', down); c.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', key); };
  }, [onClose]);
  /** 잉크가 있는 곳만 잘라 PNG로(여백이 서명 크기를 줄이지 않게) */
  const save = () => {
    if (!inked.current) return;
    const c = ref.current, ctx = c.getContext('2d');
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const pad = 8, w = Math.min(width, x1 - x0 + pad * 2), h = Math.min(height, y1 - y0 + pad * 2);
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    out.getContext('2d').drawImage(c, Math.max(0, x0 - pad), Math.max(0, y0 - pad), w, h, 0, 0, w, h);
    onSave(out.toDataURL('image/png'));
  };
  return <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={t('sign.make')} style={{ width: 'min(600px, calc(100vw - 32px))' }}>
      <header className="modal-head"><h2>{t('sign.make')}</h2><button type="button" className="icon-btn x" aria-label={t('close')} onClick={onClose}><Icon name="x" /></button></header>
      <div className="modal-body"><p className="dim small">{t('sign.makeHelp')}</p><canvas ref={ref} width={560} height={220} className="sign-canvas" /></div>
      <footer className="modal-foot"><button type="button" className="btn" onClick={() => { const c = ref.current; c.getContext('2d').clearRect(0, 0, c.width, c.height); inked.current = false; }}>{t('sign.clear')}</button><button type="button" className="btn primary" onClick={save}>{t('sign.use')}</button></footer>
    </div>
  </div>;
}
