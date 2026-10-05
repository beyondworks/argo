// 회사 정보(트랙 C, 유건 10/2) — 인트라넷 회사 정보(Notion DB)를 오피스가 원본으로. 사업자·계좌·연락처·세무·기타 항목.
// 멤버는 보고, 관리자(owner·admin)만 고친다. 지운 항목은 '최근 지운 항목'에서 되살린다. 견적·계약 서식(트랙 A)이 '서식에 들어가는 값'을 읽는다.
import { useId, useMemo, useState } from 'react';
import { t, registerDict, useLang } from '../core/i18n.js';
import { useCompany, companyWrite } from '../core/company.js';
import { CATEGORIES, COMPANY_KEYS, KEY_CATEGORY, DOC_KEYS, IMAGE_KEYS, isImage, guessKey, groupItems, itemPayload, moveInCategory, keyMenu, sealFileOk } from '../core/company-model.js';
import { navigate } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { openMenu, menuProps } from '../ui/Menu.jsx';
import { Icon } from '../ui/Icon.jsx';
import { Redact } from '../business/Redact.jsx';
import { redactState } from '../business/cell-pick.js';
import { redactMenu } from '../business/redact-rule.js';
import { hideAllOn } from '../core/hide-all.js';
import { useSelection, selProps } from '../core/selection.js';
import { setUi } from '../core/ui-state.js';
import { companyText } from '../core/crew-items.js';
import { COMPANY_DICT } from './company-i18n.js';
import './perf.css';
import './company.css';

registerDict(COMPANY_DICT);
const fail = (e) => showToast(t(e.message));
const LABEL_HINTS = COMPANY_KEYS.map(([k]) => k);
const MAX_IMAGE = 200000;
/** 도장·로고 그림 → data:image 주소. 로고: SVG는 그대로(작으면), 그 밖은 512px 안으로 줄여 PNG(크면 WebP).
 *  도장(png: true): PNG만 받고 PNG 그대로 — 투명 배경을 지킨다(WebP로 바꾸지 않는다, 유건 10/2 13차). 작으면 올린 파일 그대로, 크면 512px 안 PNG로 */
async function readImage(file, { png = false } = {}) {
  const asUrl = (f) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = no; r.readAsDataURL(f); });
  if (png && !sealFileOk({ type: file.type, head: new Uint8Array(await file.slice(0, 8).arrayBuffer()) })) throw new Error('png');
  if (file.type === 'image/svg+xml' && file.size < MAX_IMAGE * 0.7) return asUrl(file);
  return asUrl(file).then((src) => new Promise((ok, no) => {
    const img = new Image();
    img.onload = () => {
      if (png && Math.max(img.width, img.height) <= 512 && src.length <= MAX_IMAGE) { ok(src); return; }
      const k = Math.min(1, 512 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let out = c.toDataURL('image/png');
      if (out.length > MAX_IMAGE && !png) out = c.toDataURL('image/webp', 0.85);
      if (out.length > MAX_IMAGE) no(new Error('big')); else ok(out);
    };
    img.onerror = no; img.src = src;
  }));
}

export default function Company({ space }) {
  useLang();
  const { data, profile, error, loading, reload } = useCompany(space);
  const [edit, setEdit] = useState(null), [confirm, setConfirm] = useState(null), [sel, setSel] = useState(() => new Set()), [peek, setPeek] = useState({});
  const manager = data?.role === 'manager';
  const items = data?.items ?? [];
  const groups = useMemo(() => groupItems(items), [items]);
  if (space === 'me') return <div className="page-wrap"><Head /><div className="empty-state"><Icon name="building" size={20} /><p>{t('company.orgOnly')}</p></div></div>;

  const openNew = (patch = {}) => setEdit({ id: crypto.randomUUID(), label: '', value: '', notes: '', category: 'basic', key: null, keyTouched: false, isNew: true, ...patch });
  const openEdit = (x) => manager && setEdit({ ...x, keyTouched: true });
  const run = async (action, payload, done) => { try { const r = await companyWrite(space, action, payload); await reload(); if (done) showToast(t(done)); return r; } catch (e) { fail(e); throw e; } };
  const move = (x, dir) => { const ids = moveInCategory(items, x.id, dir); if (ids) run('items.order', { ids }).catch(() => {}); };
  const toggleRedact = (x) => (manager ? run('item.save', { ...itemPayload(x), redacted: !x.redacted }).catch(() => {}) : setPeek((p) => ({ ...p, [x.id]: !(p[x.id] ?? x.redacted) })));
  const hidden = (x) => (manager ? x.redacted : peek[x.id] ?? x.redacted);
  const del = async () => {
    const ids = confirm.ids;
    try { for (const id of ids) await companyWrite(space, 'item.delete', { id }); } catch (e) { fail(e); }
    setConfirm(null); setSel(new Set()); await reload();
    showToast(ids.length > 1 ? t('company.deletedN', { n: ids.length }) : t('company.deleted'));
  };
  const toggleSel = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allIds = items.map((x) => x.id), all = allIds.length > 0 && allIds.every((id) => sel.has(id));
  // 여러 개 고르기(11차) — 체크박스와 같은 선택. 고른 항목 한 번에 가리기·가림 해제(관리자는 저장, 멤버는 내 화면에서만 — 값 하나 가림과 같은 규칙)·삭제(확인 창)
  const redactable = (x) => x.value && !(IMAGE_KEYS.includes(x.key) && isImage(x.value));
  const redactMany = (ids, clear) => {
    const list = items.filter((x) => ids.includes(x.id) && redactable(x)), st = redactState(list, hidden);
    const apply = async (pairs) => { // [[항목, 가림]] — 관리자는 바뀌는 것만 저장하고 한 번 다시 읽는다
      if (!manager) { setPeek((p) => ({ ...p, ...Object.fromEntries(pairs.map(([x, on]) => [x.id, on])) })); return true; }
      try { for (const [x, on] of pairs) await companyWrite(space, 'item.save', { ...itemPayload(x), redacted: on }); return true; } catch (e) { fail(e); return false; } finally { await reload(); }
    };
    const go = (on) => async () => {
      const pairs = list.filter((x) => hidden(x) !== on).map((x) => [x, on]);
      if (!pairs.length || !(await apply(pairs))) return;
      clear?.();
      showToast(t(on ? 'sel.redacted' : 'sel.unredacted', { n: pairs.length }), { undo: () => apply(pairs.map(([x]) => [{ ...x, redacted: !on }, !on])) });
    };
    return redactMenu([!st.all && list.length > 0 && { label: t('bizui.redact'), icon: 'eyeOff', run: go(true) }, st.any && { label: t('bizui.unredact'), icon: 'eye', run: go(false) }], hideAllOn(), t); // 전체 가리기 중이면 안내(18차 검수 M1)
  };
  // 에이전트에게 맡기기(17차 A-5) — 고른 항목을 "이름: 값" 글자로. 계좌·사업자번호·법인등록번호·도장/로고는 값을 싣지 않는다(core/crew-items.js). 멤버도 된다(가린 값도 글자에는 들어간다 — 가림은 화면용)
  const assignItem = (ids, clear) => ({ label: t('crew.assign'), icon: 'hand', run: () => {
    const list = items.filter((x) => ids.includes(x.id));
    setUi({ assign: { space, items: [{ kind: 'company', id: ids.join(','), label: list.length === 1 ? list[0].label : t('company.crewItems', { n: list.length }), text: companyText(list, t) }] } });
    clear?.();
  } });
  useSelection('company', { value: sel, onChange: setSel, keys: allIds, actions: (keys, clear) => [...redactMany(keys, clear), keys.length > 0 && assignItem(keys, clear), manager && { label: t('company.deleteSel'), icon: 'trash', danger: true, run: () => setConfirm({ ids: keys }) }] });
  // 고른 항목 위 우클릭 = 고른 것 전체, 고르지 않은 한 줄 우클릭 = 그 항목 맡기기(값 칸은 가리기 메뉴가 먼저 받는다)
  // 우클릭·터치 길게 누르기·메뉴 키 모두(공용 menuProps) — 폰에서 멤버가 회사 정보를 맡길 길이 없었다(17차 A 검수 LOW-6). 끌어서 고른 칸 위는 menuProps가 전역 칸 메뉴에 맡긴다
  const rowItems = (x) => (sel.size > 1 && sel.has(x.id) ? [...redactMany([...sel]), assignItem([...sel], () => setSel(new Set()))].filter(Boolean) : [assignItem([x.id])]);

  return <div className="page-wrap wide perf company">
    <Head right={manager && <button type="button" className="btn primary sm" onClick={() => openNew()}><Icon name="plus" size={13} />{t('company.add')}</button>} />
    {error && <p className="biz-error" role="alert">{t(error)}</p>}
    {!data ? <p className="dim small" role="status">{loading ? t('company.loading') : ''}</p> : <>
      <DocsCard profile={profile} items={items} manager={manager} hidden={hidden} onFill={(key) => openNew({ key, keyTouched: true, label: t(`company.key.${key}`), category: KEY_CATEGORY[key] })} />
      {!manager && <p className="dim small">{t('company.readOnly')}</p>}
      {manager && items.length > 0 && <div className="co-bulk" role="toolbar" aria-label={t('company.deleteSel')}>
        <label className="co-check"><input type="checkbox" checked={all} onChange={() => setSel(all ? new Set() : new Set(allIds))} aria-label={t('company.selectAll')} /><span>{sel.size ? t('company.selectedN', { n: sel.size }) : t('company.selectAll')}</span></label>
        {sel.size > 0 && <button type="button" className="btn ghost sm danger-text" onClick={() => setConfirm({ ids: [...sel] })}><Icon name="trash" size={13} />{t('company.deleteSel')}</button>}
      </div>}
      {!groups.length ? <div className="empty-state"><Icon name="building" size={20} /><p>{t('company.empty')}</p><p className="dim small">{t(manager ? 'company.emptyManager' : 'company.emptyMember')}</p></div>
        : <div className="co-groups" data-sel-scope="company">{groups.map((g) => <section key={g.category} className={`module co-group cat-${g.category}`} aria-label={t(`company.cat.${g.category}`)}>
          <header className="module-head"><span className={`co-cat cat-${g.category}`}>{t(`company.cat.${g.category}`)}</span><span className="dim small">{t('company.count', { n: g.items.length })}</span></header>
          <ul className="co-rows">{g.items.map((x, i) => <li key={x.id} className="co-row" {...selProps(sel, x.id)} {...menuProps(() => rowItems(x))}>
            {manager && <input type="checkbox" className="co-row-check" checked={sel.has(x.id)} onChange={() => toggleSel(x.id)} aria-label={t('company.select', { name: x.label })} />}
            <div className="co-row-main">
              {manager ? <button type="button" className="co-label link-btn" onClick={() => openEdit(x)}>{x.label}</button> : <strong className="co-label">{x.label}</strong>}
              {x.value && (IMAGE_KEYS.includes(x.key) && isImage(x.value) ? <img className="co-img" src={x.value} alt={x.label} /> : <Redact on={hidden(x)} kind={nameKind(x.key)} cellKey={`company:${x.id}`} defer={sel.size > 1 && sel.has(x.id)} onToggle={() => toggleRedact(x)}><span className="co-value">{x.value}</span></Redact>)}
              {x.notes && <small className="co-notes dim"><Redact kind="memo">{x.notes}</Redact></small>}
            </div>
            {x.key && <button type="button" className="badge co-key" aria-haspopup="menu" title={`${t('company.f.key')}: ${t(`company.key.${x.key}`)}`} onClick={(e) => openMenu(e, [
              { heading: t('company.keyHead', { key: t(`company.key.${x.key}`) }) },
              ...keyMenu(x, { manager }).map((m) => (m.edit ? { label: t('company.keyChange'), icon: 'draft', run: () => openEdit(x) }
                : { label: t(m.id === 'quote' ? 'company.keyQuote' : 'company.keyContract'), icon: 'file', run: () => navigate(`${baseOf(space)}/${m.to}`) })),
            ], { anchor: e.currentTarget })}><Icon name="file" size={11} />{t('company.docShort')}{x.label !== t(`company.key.${x.key}`) ? ` · ${t(`company.key.${x.key}`)}` : ''}</button>}
            {x.source === 'notion' && <span className="badge dim" title={t('company.fromNotion')}>N</span>}
            {manager && <button type="button" className="icon-btn co-more" aria-label={t('company.more')} onClick={(e) => openMenu(e, [
              { label: t('company.edit'), icon: 'draft', run: () => openEdit(x) },
              assignItem([x.id]),
              ...(i > 0 ? [{ label: t('company.up'), icon: 'chevron', run: () => move(x, -1) }] : []),
              ...(i < g.items.length - 1 ? [{ label: t('company.down'), icon: 'chevron', run: () => move(x, 1) }] : []),
              { sep: true }, { label: t('company.delete'), icon: 'trash', danger: true, run: () => setConfirm({ ids: [x.id], name: x.label }) },
            ], { anchor: e.currentTarget })}><Icon name="dots" size={14} /></button>}
          </li>)}</ul>
        </section>)}</div>}
      {manager && data.deleted?.length > 0 && <section className="module co-trash" aria-label={t('company.trash')}>
        <header className="module-head"><Icon name="trash" size={15} /><h3>{t('company.trash')}</h3></header>
        <ul className="co-rows">{data.deleted.map((d) => <li key={d.history_id} className="co-row">
          <div className="co-row-main"><span className="co-label">{d.label}</span><small className="dim">{t(`company.cat.${CATEGORIES.includes(d.category) ? d.category : 'other'}`)}</small></div>
          <button type="button" className="btn sm" onClick={() => run('item.restore', { history_id: d.history_id }, 'company.restored').catch(() => {})}>{t('company.restore')}</button>
        </li>)}</ul>
      </section>}
    </>}
    {edit && <ItemForm edit={edit} setEdit={setEdit} onSave={(p) => run('item.save', p, 'company.saved').then(() => setEdit(null)).catch(() => {})} onDelete={() => { setConfirm({ ids: [edit.id], name: edit.label }); setEdit(null); }} />}
    {confirm && <Modal open title={t('company.deleteTitle')} onClose={() => setConfirm(null)} footer={<>
      <button type="button" className="btn" onClick={() => setConfirm(null)}>{t('company.cancel')}</button>
      <button type="button" className="btn danger" onClick={del}>{t('company.delete')}</button></>}>
      <p>{confirm.ids.length > 1 ? t('company.deleteManyBody', { n: confirm.ids.length }) : t('company.deleteBody', { name: confirm.name ?? '' })}</p>
    </Modal>}
  </div>;
}

function Head({ right }) {
  return <div className="page-title-row"><div><h1 className="page-h1">{t('company.title')}</h1><p className="dim">{t('company.subtitle')}</p></div>{right}</div>;
}

// 화면 전체 가리기(18차)에서도 그대로 보이는 값 — 회사 이름(상호·등록 상호). 나머지(사업자번호·계좌·연락처·주소 등)는 가린다
const nameKind = (key) => (key === 'name' || key === 'reg_name' ? 'name' : undefined);

/** 서식에 들어가는 값 — 견적서·계약서 공급자 칸. 빈 칸은 관리자가 바로 채운다 */
function DocsCard({ profile, items, manager, hidden, onFill }) {
  const value = { name: profile.name, ceo: profile.ceo, biz_no: profile.bizNo, address: profile.address, open_date: profile.openDate, biz_type: profile.bizType, biz_item: profile.bizItem, manager: profile.manager, phone: profile.phone, email: profile.email };
  const itemOf = (k) => items.find((x) => x.key === k) ?? items.find((x) => !x.key && guessKey(x.label) === k);
  return <section className="module co-docs" aria-label={t('company.docs')}>
    <header className="module-head"><Icon name="file" size={15} /><h3>{t('company.docs')}</h3>
      <span className={`badge${profile.missing.length ? ' late' : ''}`}>{profile.missing.length ? t('company.docsMissing', { n: profile.missing.length }) : t('company.docsReady')}</span></header>
    <p className="dim small co-docs-hint">{t('company.docsHint')}</p>
    <dl className="co-docs-grid">{DOC_KEYS.map((k) => { const it = itemOf(k); return <div key={k} className={`co-doc${value[k] ? '' : ' empty'}`}>
      <dt>{t(`company.key.${k}`)}</dt>
      <dd>{value[k] ? <Redact on={!!it && hidden(it)} kind={nameKind(k)} focusable={false}><span>{value[k]}</span></Redact> : manager ? <button type="button" className="link-btn" onClick={() => onFill(k)}><Icon name="plus" size={12} />{t('company.fill')}</button> : <span className="dim">—</span>}</dd>
    </div>; })}
      <div className="co-doc"><dt>{t('company.cat.bank')}</dt><dd>{profile.accounts.length ? profile.accounts.map((a) => a.label).join(' · ') : <span className="dim">—</span>}</dd></div>
      <div className="co-doc"><dt>{t('company.images')}</dt><dd className="co-doc-imgs">{IMAGE_KEYS.map((k) => profile[k] ? <img key={k} className="co-img" src={profile[k]} alt={t(`company.key.${k}`)} title={t(`company.key.${k}`)} />
        : manager ? <button key={k} type="button" className="link-btn" onClick={() => onFill(k)}><Icon name="plus" size={12} />{t(`company.key.${k}`)}</button> : null)}{!manager && !profile.seal && !profile.logo && <span className="dim">—</span>}</dd></div>
    </dl>
  </section>;
}

function ItemForm({ edit, setEdit, onSave, onDelete }) {
  const formId = useId(), listId = useId();
  const set = (patch) => setEdit({ ...edit, ...patch });
  const onLabel = (label) => {
    const k = edit.keyTouched ? edit.key : guessKey(label);
    set({ label, key: k, category: !edit.keyTouched && k ? KEY_CATEGORY[k] : edit.category });
  };
  const payload = itemPayload(edit);
  const submit = (e) => { e.preventDefault(); if (payload) onSave(payload); };
  return <Modal open width={520} title={t(edit.isNew ? 'company.add' : 'company.edit')} onClose={() => setEdit(null)} footer={<>
    {!edit.isNew && <button type="button" className="btn ghost danger-text" onClick={onDelete}><Icon name="trash" size={13} />{t('company.delete')}</button>}
    <span className="spacer" />
    <button type="button" className="btn" onClick={() => setEdit(null)}>{t('company.cancel')}</button>
    <button type="submit" form={formId} className="btn primary" disabled={!payload}>{t('company.save')}</button></>}>
    <form id={formId} className="perf-form co-form" onSubmit={submit}>
      <label className="field-block"><span className="label">{t('company.f.label')} *</span>
        <input className="input" list={listId} maxLength={100} value={edit.label} placeholder={t('company.f.labelPh')} onChange={(e) => onLabel(e.target.value)} data-autofocus />
        <datalist id={listId}>{LABEL_HINTS.map((k) => <option key={k} value={t(`company.key.${k}`)} />)}</datalist></label>
      {IMAGE_KEYS.includes(edit.key) ? <div className="field-block"><span className="label">{t('company.f.value')}</span>
        <div className="co-img-pick">{isImage(edit.value) && <img className="co-img big" src={edit.value} alt={edit.label} />}
          <label className="btn sm"><Icon name="plus" size={13} />{t('company.f.image')}<input type="file" accept={edit.key === 'seal' ? 'image/png' : 'image/png,image/jpeg,image/webp,image/svg+xml'} hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) readImage(f, { png: edit.key === 'seal' }).then((value) => set({ value })).catch((err) => showToast(t(err?.message === 'png' ? 'company.f.sealPng' : 'company.f.imageBad'))); }} /></label>
          {edit.value && <button type="button" className="btn ghost sm" onClick={() => set({ value: '' })}>{t('company.f.imageClear')}</button>}</div>
        <p className="dim small">{t(edit.key === 'seal' ? 'company.f.sealHint' : 'company.f.imageHint')}</p></div>
        : <label className="field-block"><span className="label">{t('company.f.value')}</span>
          <input className="input" maxLength={2000} value={edit.value} placeholder={t('company.f.valuePh')} onChange={(e) => set({ value: e.target.value })} /></label>}
      <div className="co-form-row">
        <label className="field-block"><span className="label">{t('company.f.category')}</span>
          <select className="input" value={edit.category} onChange={(e) => set({ category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{t(`company.cat.${c}`)}</option>)}</select></label>
        <label className="field-block"><span className="label">{t('company.f.key')}</span>
          <select className="input" value={edit.key ?? ''} onChange={(e) => set({ key: e.target.value || null, keyTouched: true })}>
            <option value="">{t('company.f.keyNone')}</option>{COMPANY_KEYS.map(([k]) => <option key={k} value={k}>{t(`company.key.${k}`)}</option>)}</select></label>
      </div>
      <label className="field-block"><span className="label">{t('company.f.notes')}</span>
        <textarea className="input" rows={3} maxLength={2000} value={edit.notes} placeholder={t('company.f.notesPh')} onChange={(e) => set({ notes: e.target.value })} /></label>
      <label className="co-check"><input type="checkbox" checked={edit.redacted ?? (edit.category === 'bank' || edit.key === 'biz_no')} onChange={(e) => set({ redacted: e.target.checked })} /><span>{t('company.f.redacted')}</span></label>
    </form>
  </Modal>;
}
