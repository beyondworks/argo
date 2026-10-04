// 거래 칸반(유건 9/29) — 칸 = 단계(견적 → 계약 → 계산서 발행 → 입금 완료), 카드 = 거래. 버튼 하나가 다음 단계로 넘기는 장부 동작 하나다.
// 카드에는 메모·페이지 연결·단계 기록이 계속 따라다닌다. 취소된 거래는 '취소 거래'에서만 본다.
import { useEffect, useId, useState } from 'react';
import { t, getLang } from '../core/i18n.js';
import { baseOf } from '../core/commands.js';
import { navigate } from '../core/router.jsx';
import { useStore } from '../core/store.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Icon } from '../ui/Icon.jsx';
import { menuProps } from '../ui/Menu.jsx';
import { setUi } from '../core/ui-state.js';
import { dealText } from '../core/crew-items.js';
import { Redact, Hide } from './Redact.jsx';
import { OwnerField } from './Owners.jsx';
import { businessError } from './data.js';
import { useMarketing, marketingError } from './marketing-data.js';
import { STAGES, DEAL_GROUPS, dealAmounts, dealStage, nextStep, revertStep, canCancel, stageDate, groupDeals, overdueDays, kstToday, editForm } from './deal-model.js';

const label = (key) => t(`bizui.${key}`);
const money = (amount) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(amount || 0));
const day = (value) => (value ? new Date(value).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '');
const kstDay = (value) => new Date(Date.parse(value) + 9 * 3600e3).toISOString().slice(0, 10); // 한국 날짜
const today = () => kstDay(new Date().toISOString());
// kind(18차 화면 전체 가리기): 건명은 할 일 제목처럼 그대로, 금액은 가린다
const orderRedact = (order, field, run, blocked) => ({ on: order.redacted?.includes(field), kind: field === 'title' ? 'title' : 'amount', disabled: blocked, cellKey: `order:${order.id}:${field}`, onToggle: () => run('redact.set', { entity: 'order', id: order.id, field, on: !order.redacted?.includes(field) }).catch(() => {}) });

// 묶기는 사람마다 이 기기에 기억한다(보기 설정과 같은 성격 — 서버에 쓰지 않는다)
const GROUP_KEY = 'argo-office-deal-group';
const readGroup = () => { try { const v = localStorage.getItem(GROUP_KEY); return DEAL_GROUPS.includes(v) ? v : 'stage'; } catch { return 'stage'; } };
const keepGroup = (v) => { try { localStorage.setItem(GROUP_KEY, v); } catch { /* 사생활 창 — 기억만 못 한다 */ } };
const monthName = (key) => new Date(`${key}-01T00:00:00`).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { year: 'numeric', month: 'long' });
/** 입금 예정일 글자(날짜 문자열 그대로 — 시간대 영향 없음) */
const dueText = (d, long = false) => new Date(`${d}T00:00:00Z`).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { timeZone: 'UTC', ...(long ? { year: 'numeric', month: '2-digit', day: '2-digit' } : { month: '2-digit', day: '2-digit' }) });
/** 입금 예정일 표시(14차) — 지났으면 '입금 지연 N일' 글자 배지, 아니면 흐린 '입금 예정 MM.DD'. 입금 완료·취소 거래는 표시하지 않는다(색 막대 없이 글자로만) */
function DueMark({ order, amounts, stage, today, long = false }) {
  if (!order.due_on || stage === 'paid' || stage === 'cancelled') return null;
  const late = overdueDays(order, amounts, today);
  return late > 0 ? <span className="badge danger">{t('bizui.late', { n: late })}</span> : <span className="dim small mono">{t('bizui.dueShort', { d: dueText(order.due_on, long) })}</span>;
}

/** 에이전트에게 맡기기(17차 A-5) — 이 거래를 글자(거래처·단계·금액·품목·메모)로 뽑아 맡기기 창에. 크루는 창에서 고른다(메일·페이지 메뉴와 같은 길) */
export const assignDeal = (space, order, data, amounts, stage) => setUi({ assign: { space, items: [{ kind: 'deal', id: order.id, label: order.title, text: dealText(order, data, { t, money, amounts, stage }) }] } });

/** 조직 사람 이름 — 담당자로 묶을 때만 한 번 부른다(내 공간은 담당자가 없다) */
function usePeople(on, call) {
  const [people, setPeople] = useState(null);
  useEffect(() => {
    if (!on || !call || people) return undefined;
    let live = true;
    call('office_org_people').then((rows) => { if (live) setPeople(rows ?? []); }).catch(() => { if (live) setPeople([]); });
    return () => { live = false; };
  }, [on, call, people]);
  return people;
}

export function DealBoard({ data, blocked, run, openOrder, space, call }) {
  const [view, setView] = useState('active');
  const groups = DEAL_GROUPS.filter((g) => g !== 'owner' || space !== 'me');
  const [chosen, setChosen] = useState(readGroup);
  const group = groups.includes(chosen) ? chosen : 'stage';
  const people = usePeople(group === 'owner', call);
  const [step, setStep] = useState(null);
  const [drag, setDrag] = useState(null); // 끄는 카드 { id, next, back } — 바로 다음 칸은 다음 단계, 바로 앞 칸은 되돌리기(유건 9/29)
  const deals = data.orders.map((order) => { const amounts = dealAmounts(order, data.lines, data.entries); return { order, amounts, stage: dealStage(order, amounts) }; });
  const cancelled = deals.filter((d) => d.stage === 'cancelled');
  const customer = (id) => data.customers.find((c) => c.id === id)?.name ?? '—';
  const laneName = (key) => group === 'stage' ? label(`stage.${key}`)
    : group === 'customer' ? customer(key)
    : group === 'owner' ? (key === 'none' ? label('owners.none') : people ? people.find((p) => p.user_id === key)?.name ?? label('owners.former') : '…')
    : key === 'none' ? label('group.noMonth') : monthName(key);
  const lanes = groupDeals(deals.filter((d) => d.stage !== 'cancelled'), group, (key) => (group === 'customer' ? customer(key) : group === 'owner' ? people?.find((p) => p.user_id === key)?.name ?? '' : key));
  const clips = (id) => (data.links ?? []).filter((l) => l.order_id === id).length;
  const today = kstToday();
  const card = ({ order, amounts, stage }) => {
    const next = nextStep(order, amounts);
    const when = stageDate(order, data.activity ?? [])[stage];
    const back = revertStep(order, amounts);
    const forward = next && next.to !== next.stage ? next : null; // '남은 금액 청구'처럼 같은 칸에 머무는 동작은 끌기 대상이 아니다
    const movable = group === 'stage' && !blocked && !!(forward || back); // 끌어서 단계 넘기기는 진행 상황 칸에서만
    const startDrag = (event) => {
      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', order.id);
      setDrag({ id: order.id, title: order.title, min: when ? kstDay(when) : undefined, next: forward, back });
    };
    return <article className={`deal-card${drag?.id === order.id ? ' dragging' : ''}`} key={order.id} draggable={movable} onDragStart={movable ? startDrag : undefined} onDragEnd={() => setDrag(null)}
      {...menuProps(() => [{ label: t('crew.assign'), icon: 'hand', run: () => assignDeal(space, order, data, amounts, stage) }])}>
      <button type="button" className="bizui-link" onClick={() => openOrder(order.id)}><Redact {...orderRedact(order, 'title', run, blocked)} focusable={false}>{order.title}</Redact></button>
      <div className="deal-card-meta">{group !== 'stage' && <span className="badge">{label(`stage.${stage}`)}</span>}{group !== 'customer' && <span className="who">{customer(order.customer_id)}</span>}{when && <span className="mono">{group === 'customer' ? '' : '· '}{day(when)}</span>}</div>
      {order.due_on && stage !== 'paid' && <div className="deal-card-due"><DueMark order={order} amounts={amounts} stage={stage} today={today} /></div>}
      <div className="deal-card-foot">
        <span className="deal-card-amount"><Redact {...orderRedact(order, 'amount', run, blocked)}>{money(amounts.supply)}</Redact></span>
        <span className="spacer" />
        {clips(order.id) > 0 && <span className="clip" title={label('attachments')}><Icon name="doc" size={12} />{clips(order.id)}</span>}
        {next && <button type="button" className="btn sm" disabled={blocked} onClick={() => setStep({ ...next, title: order.title, min: when ? kstDay(when) : undefined })}>{label(`next.${next.to === next.stage ? 'invoiceRest' : next.to}`)}</button>}
      </div>
    </article>;
  };
  return <>
    <div className="deal-view"><div className="seg" role="tablist">{['active', 'cancelled'].map((key) => <button key={key} type="button" role="tab" aria-selected={view === key} className={`seg-btn${view === key ? ' on' : ''}`} onClick={() => setView(key)}>{label(`view.${key}`)}{key === 'cancelled' && cancelled.length ? ` ${cancelled.length}` : ''}</button>)}</div>{view === 'active' && <select className="input deal-group" value={group} aria-label={label('group')} onChange={(e) => { setChosen(e.target.value); keepGroup(e.target.value); }}>{groups.map((g) => <option key={g} value={g}>{label('group')}: {label(`group.${g}`)}</option>)}</select>}<span className="dim small">{label('basisSupply')}</span></div>{/* 카드·합계 = 공급가(분석·성과 기록과 같은 기준, 유건 9/30) */}
    {view === 'active'
      ? <div className={`deal-board by-${group}`} style={{ '--lanes': lanes.length }}>{lanes.map(({ key: stage, deals: lane }) => {
          const drop = drag && (drag.next?.to === stage ? { ...drag.next, title: drag.title, min: drag.min } : drag.back?.to === stage ? { ...drag.back, revert: true, title: drag.title, min: drag.min } : null);
          const dropProps = drag ? { onDragOver: (event) => { if (drop) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }, onDrop: (event) => { event.preventDefault(); if (drop) setStep(drop); setDrag(null); } } : {};
          return <section className={`deal-lane${group === 'stage' ? ` stage-${stage}` : ''}${drag ? (drop ? ' drop-ok' : ' drop-no') : ''}`} key={stage} aria-label={laneName(stage)} {...dropProps}>
          <header className="deal-lane-head"><h2>{laneName(stage)}</h2><span className="count">{lane.length}</span><span className="sum"><Hide k={`lane:${group}:${stage}:sum`} focusable={false}>{money(lane.reduce((n, d) => n + d.amounts.supply, 0))}</Hide></span></header>
          {lane.length ? lane.map(card) : <p className="deal-empty">{label('laneEmpty')}</p>}
        </section>; })}</div>
      : cancelled.length ? <div className="table-wrap bizui-table-wrap"><table className="table bizui-table"><thead><tr><th>{label('titleField')}</th><th>{label('customer')}</th><th>{label('cancelledAt')}</th><th className="num">{label('total')}</th></tr></thead>
          <tbody>{cancelled.map(({ order, amounts }) => <tr key={order.id}><td><button className="bizui-link" onClick={() => openOrder(order.id)}>{order.title}</button></td><td>{customer(order.customer_id)}</td><td className="mono">{day(order.cancelled_at)}</td><td className="num"><Redact {...orderRedact(order, 'amount', run, blocked)}>{money(amounts.supply)}</Redact></td></tr>)}</tbody></table></div>
        : <p className="empty-state">{label('noCancelled')}</p>}
    {step && <StepForm step={step} blocked={blocked} dismiss={() => setStep(null)} run={run} />}
  </>;
}

/** 단계 넘기기·되돌리기 확인 창 — 날짜(기본 오늘, 고칠 수 있음), 입금은 금액을 나눠 받을 수 있다 */
function StepForm({ step, blocked, dismiss, run }) {
  const formId = useId();
  const [at, setAt] = useState(today());
  const [amount, setAmount] = useState(step.payload.amount ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const partial = step.payload.kind === 'payment';
  const titleKey = step.revert ? `back.${step.to}` : `next.${step.to === step.stage ? 'invoiceRest' : step.to}`;
  const send = async (event) => {
    event.preventDefault(); setBusy(true); setError(null);
    const payload = { ...step.payload, ...(step.action === 'order.reopen' ? {} : { at }), ...(partial ? { amount: Number(amount) } : {}) };
    try { await run(step.action, payload, { quiet: true }); dismiss(); } catch (failure) { const key = businessError(failure); setError(key === 'biz.error.dates' ? 'bizui.stepDateInvalid' : key); } finally { setBusy(false); }
  };
  return <Modal open title={label(titleKey)} onClose={() => { if (!busy) dismiss(); }}
    footer={<><button type="button" className="btn" disabled={busy} onClick={dismiss}>{label('cancel')}</button><button type="submit" className="btn primary" form={formId} disabled={blocked || busy}>{label(titleKey)}</button></>}>
    <form id={formId} onSubmit={send} className="bizui-form">
      <p className="dim">{step.title}</p>
      {step.action !== 'order.reopen' && <label className="field-block bizui-field"><span className="label">{label('stepDate')}</span><input className="input" type="date" required min={step.min} max={today()} value={at} onChange={(e) => setAt(e.target.value)} /></label>}
      {step.payload.amount != null && (partial
        ? <label className="field-block bizui-field"><span className="label">{label('amount')}</span><input className="input" type="number" min="1" max={step.payload.amount} step="1" required value={amount} onChange={(e) => setAmount(e.target.value)} /><span className="dim small">{label('limit')}: {money(step.payload.amount)}</span></label>
        : <p>{label('amount')} <strong className="mono"><Hide k={`step:${step.payload.order_id ?? ''}:amount`}>{money(step.payload.amount)}</Hide></strong></p>)}
      {step.revert && <p className="dim small">{label(`backHelp.${step.payload.kind ?? 'reopen'}`)}</p>}
      {error && <p className="bizui-error" role="alert">{t(error)}</p>}
    </form>
  </Modal>;
}

// 들어온 경로(유건 9/29: 마케팅을 안 하는 사업도 쓴다). 캠페인은 마케팅을 켠 공간에서만 선택지에 나온다
const SOURCES = ['referral', 'returning', 'inbound', 'search_sns', 'other'];
function SourceField({ order, data, blocked, run, campaigns, attribution, linkCampaign, refresh, reloadMarketing }) {
  const [name, setName] = useState(order.referrer_name ?? '');
  const value = order.source === 'campaign' && attribution?.campaign_id ? `campaign:${attribution.campaign_id}` : (order.source ?? '');
  const save = (patch) => run('order.source', { id: order.id, source: order.source ?? null, referrer_customer_id: order.referrer_customer_id ?? null, referrer_name: order.referrer_name ?? '', ...patch }).catch(() => {});
  // 서버가 한 번의 쓰기로 경로와 캠페인 연결을 같이 바꾼다(분리 검수 M1) — 캠페인은 연결 저장이 경로=캠페인도 쓰고, 다른 경로는 경로 저장이 연결을 푼다
  const choose = async (next) => {
    if (next.startsWith('campaign:')) { if (await linkCampaign(next.slice(9))) refresh?.(); return; }
    await save({ source: next || null });
    if (attribution?.campaign_id) reloadMarketing?.();
  };
  return <div className="deal-source">
    <label className="field-block bizui-field"><span className="label">{label('source.field')}</span>
      <select className="input" disabled={blocked} value={value} onChange={(e) => choose(e.target.value)}>
        <option value="">{label('source.unknown')}</option>
        {SOURCES.map((key) => <option key={key} value={key}>{label(`source.${key}`)}</option>)}
        {order.source === 'campaign' && !campaigns?.length && <option value="campaign">{label('source.campaign')}</option>}
        {campaigns?.length > 0 && <optgroup label={label('source.campaigns')}>{campaigns.map((c) => <option key={c.id} value={`campaign:${c.id}`}>{c.name}</option>)}</optgroup>}
      </select></label>
    {order.source === 'referral' && <div className="bizui-grid2">
      <label className="field-block bizui-field"><span className="label">{label('source.referrerCustomer')}</span>
        <select className="input" disabled={blocked} value={order.referrer_customer_id ?? ''} onChange={(e) => save({ referrer_customer_id: e.target.value || null })}>
          <option value="">{label('choose')}</option>{data.customers.filter((c) => c.id !== order.customer_id && (!c.archived_at || c.id === order.referrer_customer_id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="field-block bizui-field"><span className="label">{label('source.referrerName')}</span>
        <input className="input" maxLength={100} disabled={blocked} value={name} placeholder={label('source.referrerNameHint')} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() !== (order.referrer_name ?? '')) save({ referrer_name: name.trim() }); }} /></label>
    </div>}
  </div>;
}
// 마케팅이 켜진 공간에서만 마케팅 데이터를 불러온다(꺼진 공간에 쓸데없는 조회를 만들지 않는다)
function CampaignSource(props) {
  const marketing = useMarketing(props.space);
  const attribution = marketing.data?.attributions?.find((a) => a.order_id === props.order.id);
  const linkCampaign = (campaignId) => marketing.mutate('attribution.save', { order_id: props.order.id, campaign_id: campaignId, version: attribution?.version ?? 0 }).then(() => true, (error) => { showToast(t(marketingError(error))); return false; }); // 실패는 알림으로 — 조용히 되돌아가면 저장된 줄 안다
  return <SourceField {...props} campaigns={(marketing.data?.campaigns ?? []).filter((c) => c.status !== 'archived')} attribution={attribution} linkCampaign={linkCampaign} reloadMarketing={() => marketing.refresh().catch(() => {})} />;
}

/** 기록의 메모 — 고친 기록(14차)은 '이전: 값'. 금액 고침은 이전 합계를 원화로, 입금 예정일은 날짜로, 가린 거래의 이전 건명·금액은 가린 채로 */
function noteOf(a, order, run, blocked) {
  if (!['retitle', 'move', 'reprice', 'due'].includes(a.kind)) return <Redact kind="memo">{a.note}</Redact>; // 청구·입금 메모 — 계좌·전화가 적히는 일이 있어 전체 가리기에서 가린다(18차 검수 LOW 5)
  const value = a.kind === 'reprice' && /^\d+$/.test(a.note) ? money(Number(a.note)) : a.kind === 'due' && /^\d{4}-\d{2}-\d{2}$/.test(a.note) ? dueText(a.note, true) : a.note;
  const field = a.kind === 'retitle' ? 'title' : a.kind === 'reprice' ? 'amount' : null;
  return field ? <>{t('bizui.before', { v: '' })}<Redact {...orderRedact(order, field, run, blocked)}>{value}</Redact></> : t('bizui.before', { v: value });
}

/** 카드 상세 — 단계 줄, 금액(공급가액·세액 분리), 다음·되돌리기·취소, 자료(메모·페이지), 기록 */
export function DealDetail({ order, data, blocked, run, space, launch, refresh, call }) {
  const [step, setStep] = useState(null);
  const [note, setNote] = useState('');
  const pages = useStore((s) => s.pages);
  const amounts = dealAmounts(order, data.lines, data.entries);
  const stage = dealStage(order, amounts);
  const next = nextStep(order, amounts), back = revertStep(order, amounts);
  const dates = stageDate(order, data.activity ?? []);
  const links = (data.links ?? []).filter((l) => l.order_id === order.id);
  const log = (data.activity ?? []).filter((a) => a.order_id === order.id).slice().reverse();
  const lines = data.lines.filter((l) => l.order_id === order.id);
  const linkable = pages.filter((p) => p.space === space && !p.template && !links.some((l) => l.kind === 'page' && l.ref === p.id));
  const customer = data.customers.find((c) => c.id === order.customer_id);
  const addNote = async (event) => { event.preventDefault(); if (!note.trim()) return; await run('link.add', { order_id: order.id, kind: 'note', body: note.trim() }).then(() => setNote('')).catch(() => {}); };
  const late = overdueDays(order, amounts, kstToday());
  return <div className="bizui-detail">
    <div className="deal-head">
      <p className="dim">{customer?.name ?? '—'}{stage === 'cancelled' && <> · <span className="badge">{label('view.cancelled')}</span></>}</p>
      <button type="button" className="btn sm" disabled={blocked} onClick={() => launch('orderEdit', editForm(order, data.lines))}><Icon name="draft" size={13} />{label('edit')}</button>
      <button type="button" className="btn sm" onClick={() => assignDeal(space, order, data, amounts, stage)}><Icon name="hand" size={13} />{t('crew.assign')}</button>
    </div>
    {(order.due_on || stage !== 'paid') && stage !== 'cancelled' && <p className="deal-due"><span className="label">{label('dueOn')}</span>
      {order.due_on ? <><span className="mono">{dueText(order.due_on, true)}</span>{late > 0 && <span className="badge danger">{t('bizui.late', { n: late })}</span>}</> : <span className="dim">—</span>}</p>}
    {space !== 'me' && call && <OwnerField order={order} call={call} canManage={!!data.can_manage} blocked={blocked} refresh={refresh} />}
    {(data.settings?.enabled ?? []).includes('marketing') ? <CampaignSource key={order.id} order={order} data={data} blocked={blocked} run={run} space={space} refresh={refresh} /> : <SourceField key={order.id} order={order} data={data} blocked={blocked} run={run} linkCampaign={async () => {}} />}
    {stage !== 'cancelled' && <ol className="deal-steps">{STAGES.map((s, i) => { const at = STAGES.indexOf(stage); return <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''}>{label(`stage.${s}`)}<span className="when">{i <= at && dates[s] ? day(dates[s]) : ''}</span></li>; })}</ol>}
    <dl className="bizui-balances">{[['supply', amounts.supply], ['vat', amounts.vat], ['total', amounts.total], ['invoiced', amounts.invoiced], ['paid', amounts.paid], ['receivable', amounts.receivable]].map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd><Redact {...orderRedact(order, 'amount', run, blocked)}>{money(value)}</Redact></dd></div>)}</dl>
    <div className="bizui-actions">
      {next && <button className="btn primary" disabled={blocked} onClick={() => setStep({ ...next, title: order.title, min: dates[stage] ? kstDay(dates[stage]) : undefined })}>{label(`next.${next.to === next.stage ? 'invoiceRest' : next.to}`)}</button>}
      {back && <button className="btn" disabled={blocked} onClick={() => setStep({ ...back, revert: true, title: order.title, min: dates[stage] ? kstDay(dates[stage]) : undefined })}>{label(`back.${back.to}`)}</button>}
      {canCancel(order, amounts) && <button className="btn" disabled={blocked} onClick={() => launch('cancel', { id: order.id, billed: amounts.invoiced })}>{label('cancelOrder')}</button>}
    </div>
    {/* 거래에서 바로 견적서·계약서(10/2 인트라넷 이식) — 거래처·거래 줄을 채운 작성 화면으로 간다. 만든 문서는 아래 자료에 붙는다 */}
    {stage !== 'cancelled' && <div className="bizui-actions deal-docs">
      <button type="button" className="btn sm" onClick={() => navigate(`${baseOf(space)}/contracts?new=quote&order=${order.id}`)}><Icon name="doc" size={12} /> {label('makeQuote')}</button>
      <button type="button" className="btn sm" onClick={() => navigate(`${baseOf(space)}/contracts?new=contract&order=${order.id}`)}><Icon name="sign" size={12} /> {label('makeContract')}</button>
    </div>}
    {lines.map((line) => <article className="bizui-line" key={line.id}><div className="bizui-line-head"><strong>{line.name}</strong><span className="badge">{label(`tax.${line.tax_type}`)}</span></div>
      <p className="mono">{line.quantity} × <Redact {...orderRedact(order, 'amount', run, blocked)}>{money(line.unit_price)}</Redact> + {label('vat')} <Redact {...orderRedact(order, 'amount', run, blocked)}>{money(line.vat)}</Redact></p>
      {line.kind === 'product' && <p>{label('fulfilled')} <span className="mono">{line.fulfilled}</span> · {label('returned')} <span className="mono">{line.returned}</span></p>}
      {order.status === 'confirmed' && <div className="bizui-actions"><button className="btn sm" disabled={blocked || line.fulfilled >= line.quantity} onClick={() => launch('fulfill', { id: line.id, quantity: line.quantity - line.fulfilled, max: line.quantity - line.fulfilled, kind: line.kind })}>{label(line.kind === 'service' ? 'deliver' : 'ship')}</button>{line.kind === 'product' && <button className="btn sm" disabled={blocked || line.fulfilled <= line.returned} onClick={() => launch('return', { id: line.id, quantity: 1, max: line.fulfilled - line.returned })}>{label('return')}</button>}</div>}
    </article>)}
    <h3>{label('attachments')}</h3>
    {links.length ? <ul className="deal-log">{links.map((l) => <li key={l.id}>
      {l.kind === 'page' ? <button className="bizui-link" onClick={() => navigate(`${baseOf(space)}/p/${l.ref}`)}><Icon name="doc" size={12} /> {pages.find((p) => p.id === l.ref)?.title || l.title || label('untitled')}</button>
        : l.kind === 'file' && l.ref.startsWith('office-doc:') ? <button className="bizui-link" onClick={() => navigate(`${baseOf(space)}/contracts?open=doc:${l.ref.slice(11)}`)}><Icon name="file" size={12} /> {l.title || label('untitled')}</button>
        : <span className="badge">{label(`link.${l.kind}`)}</span>}
      <span className="when">{day(l.created_at)}</span>
      <button type="button" className="btn sm ghost push" disabled={blocked} onClick={() => run('link.remove', { id: l.id }).catch(() => {})}>{label('remove')}</button>
      {l.kind === 'note' && <p><Redact kind="memo">{l.body}</Redact></p>}
    </li>)}</ul> : <p className="dim small">{label('noAttachments')}</p>}
    <form className="deal-note" onSubmit={addNote}>
      <textarea className="input area" maxLength={10000} placeholder={label('notePlaceholder')} value={note} disabled={blocked} onChange={(e) => setNote(e.target.value)} />
      <div className="bizui-actions">
        <button type="submit" className="btn sm" disabled={blocked || !note.trim()}>{label('addNote')}</button>
        {linkable.length > 0 && <select className="input sm" disabled={blocked} value="" aria-label={label('linkPage')} onChange={(e) => { const p = pages.find((x) => x.id === e.target.value); if (p) run('link.add', { order_id: order.id, kind: 'page', ref: p.id, title: p.title || '' }).catch(() => {}); }}>
          <option value="">{label('linkPage')}</option>{linkable.map((p) => <option key={p.id} value={p.id}>{p.title || label('untitled')}</option>)}</select>}
      </div>
    </form>
    <h3>{label('history')}</h3>
    {log.length ? <ul className="deal-log">{log.map((a) => <li key={a.id}><span className="badge">{label(`act.${a.kind}`)}</span><span className="when">{day(a.at)}</span>{a.amount != null && <strong><Redact {...orderRedact(order, 'amount', run, blocked)}>{money(a.amount)}</Redact></strong>}{a.note && <p>{noteOf(a, order, run, blocked)}</p>}</li>)}</ul> : <p className="dim small">{label('empty')}</p>}
    {step && <StepForm step={step} blocked={blocked} dismiss={() => setStep(null)} run={run} />}
  </div>;
}
