// 업무 사전 등록(biz.*/bizui.*/mkt.*) — core/i18n.js는 이걸 정적으로 갖지 않는다(첫 화면 150KB 상한, 유건 9/26).
import { cloneElement, lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import './register-i18n.js';
import { t, useLang, getLang } from '../core/i18n.js';
import { baseOf } from '../core/commands.js';
import { Link, navigate } from '../core/router.jsx';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { Peek } from '../ui/Peek.jsx';
import { CustomerCard, ItemCard, assignCustomers } from './Cards.jsx';
import { Icon } from '../ui/Icon.jsx';
import { InfoTip } from '../ui/InfoTip.jsx';
import { openMenu, menuProps, mergeHandlers } from '../ui/Menu.jsx';
import { useBusiness, businessError } from './data.js';
import { BusinessDashboard } from './Dashboard.jsx';
import Marketing from './Marketing.jsx';
import { DealBoard, DealDetail } from './DealBoard.jsx';
import { Redact, Hide, HideIn } from './Redact.jsx';
import { bulkRedactRows, redactDefaults, redactState } from './cell-pick.js';
import { redactMenu } from './redact-rule.js';
import { hideAllOn } from '../core/hide-all.js';
import { dealAmounts, CUSTOMER_SORTS, sortCustomers, CUSTOMER_VIEWS, attentionOf, filterCustomers, kstToday, linkedDeals, amountEditable, lineInUse, orderUpdate } from './deal-model.js';
import { OrderLines } from './OrderLines.jsx';
import './business.css';
import { BUSINESS_MODULES } from '../core/module-registry.js';
import { useSelection, selProps } from '../core/selection.js';
import { SortableContext, useSortable, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore, saveLayout } from '../core/store.js';
import { readTabs, writeTabs, canHide, pickTab, tabBar, afterHide } from './tab-model.js';

/** 업무 탭 — 끌어서 순서를 바꾸고, 우클릭(터치는 길게 누르기)으로 숨긴다(사람마다, biztabs:me — 유건 9/30). 켜기·끄기는 조직 설정 그대로.
 *  hidden: 숨긴 탭인데 주소로 들어와 보고 있는 탭 — 탭 줄 제자리에 '숨긴 탭'으로 표시한다 */
function BizTab({ id, to, on, hidden, move, menu, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `biztab:${id}`, data: { kind: 'biztab', id, group: 'biztab', move, label: children } });
  const { onTouchStart, ...mouse } = listeners ?? {}; // 터치는 길게 누르기 = 메뉴
  return <Link ref={setNodeRef} to={to} style={{ transform: CSS.Translate.toString(transform), transition }} className={`tab${on ? ' on' : ''}${hidden ? ' tab-hidden' : ''}${isDragging ? ' dragging' : ''}`} aria-current={on ? 'page' : undefined} title={hidden ? label('tabHiddenMark') : undefined} {...attributes} {...mergeHandlers(mouse, menuProps(menu))} role="link">
    {hidden && <Icon name="eyeOff" size={12} />}{children}
  </Link>;
}

// 성과 분석은 마케팅 탭 안으로 합쳤다(유건 9/29) — 예전 주소·홈 카드는 마케팅으로 이어진다
const MODULES = BUSINESS_MODULES.map((module) => module.businessTab).filter((key) => key !== 'performance');
const money = (amount) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(amount || 0));
const integer = (value, min = 0, max = 1e12) => Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
const label = (key) => t(`bizui.${key}`);
const date = (value) => new Date(value).toLocaleString(getLang() === 'en' ? 'en-US' : 'ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

function Field({ name, children }) {
  return <label className="field-block bizui-field"><span className="label">{label(name)}</span>{children}</label>;
}
// 숫자 열은 오른쪽 맞춤·Mono(유건 9/29), 수정 열은 머리글 없이 행 끝에 작은 버튼
const NUM = new Set(['price', 'amount', 'total', 'receivable', 'stock', 'reserved', 'available', 'quantity', 'supply', 'vat']);
const cls = (column) => (NUM.has(column) ? 'num' : column === 'edit' || column === 'receive' ? 'act' : undefined);
/** 업무 표 — 행은 끌어 감싸기·⇧/⌘ 클릭·⌘A로 고를 수 있다(11차). 표마다 이미 있는 행 동작(수정·입고)은 한 건씩 여는 창이라 일괄 동작은 없다(선택 막대 = 개수·해제) */
function Table({ columns, rows, select }) {
  const auto = `biz:${useId()}`, scope = select?.scope ?? auto;
  const [own] = useSelection(select ? null : scope, { keys: rows.map((row) => row.key) }), sel = select?.sel ?? own; // select = 표를 쓰는 쪽이 묶음을 등록(거래처 — 일괄 가리기)
  return rows.length ? <div className="table-wrap bizui-table-wrap" data-sel-scope={scope}><table className="table bizui-table"><thead><tr>{columns.map((column) => <th key={column} className={cls(column)}>{cls(column) === 'act' ? '' : label(column)}</th>)}</tr></thead><tbody>{rows.map((row) => cloneElement(row, selProps(sel, row.key)))}</tbody></table></div> : <p className="empty-state">{label('empty')}</p>;
}
const EditButton = ({ disabled, onClick, children }) => <button type="button" className="btn sm ghost" disabled={disabled} onClick={onClick}>{children ?? label('edit')}</button>;
const ENTRY_ORDER = ['invoice', 'payment', 'refund', 'credit']; // 같은 시각이면 업무 순서대로(청구 → 입금)
function EntryRows({ entries, orders, openOrder }) {
  // 청구는 청색, 입금은 녹색, 되돌린 기록(청구 취소·환불)은 붉은색 — 행 전체 글자색, 금액은 굵게(유건 9/29)
  return <Table columns={['date', 'orders', 'kind', 'supply', 'vat', 'amount', 'notes']} rows={entries.slice().sort((a, b) => a.at.localeCompare(b.at) || ENTRY_ORDER.indexOf(a.kind) - ENTRY_ORDER.indexOf(b.kind)).map((entry) => <tr key={entry.id} className={{ invoice: 'entry-bill', payment: 'entry-pay' }[entry.kind] ?? 'entry-back'}>
    <td>{date(entry.at)}</td><td><button className="bizui-link" onClick={() => openOrder(entry.order_id)}>{orders.find((o) => o.id === entry.order_id)?.title || '—'}</button></td>
    <td>{label(entry.kind)}</td><td className="num">{entry.supply == null ? '—' : <Hide k={`entry:${entry.id}:supply`}>{money(entry.supply)}</Hide>}</td><td className="num">{entry.vat == null ? '—' : <Hide k={`entry:${entry.id}:vat`}>{money(entry.vat)}</Hide>}</td><td className="num strong"><Hide k={`entry:${entry.id}:amount`}>{money(entry.amount)}</Hide></td><td>{entry.note && <Redact kind="memo">{entry.note}</Redact>}</td>
  </tr>)} />;
}
const balance = dealAmounts;

const REDACT_FIELDS = ['manager', 'phone', 'email', 'biz_no', 'account'];
// '챙길 것' 카드(14차) — 사업자등록증 판정에 문서함 목록이 필요해 따로 받는다(업무 화면 묶음을 키우지 않게)
const CustomerAttention = lazy(() => import('./CustomerAttention.jsx'));
const CATEGORIES = ['customer', 'partner', 'supplier', 'other'];
const day = (value) => (value ? new Date(value).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—');
const SORT_KEY = 'argo-office-customer-sort';
const readSort = () => { try { const v = localStorage.getItem(SORT_KEY); return CUSTOMER_SORTS.includes(v) ? v : 'name'; } catch { return 'name'; } };
/** 거래처 목록 — 정렬 드롭다운(이름순·거래 건수순·최근 등록순)과 등록일 열(유건 9/30). 등록일은 서버가 돌려줄 때만 보인다(created_at).
 *  14차: 위에 '챙길 것' 카드(계산서 미발행·사업자등록증 미보유·입금 지연 — 누르면 그 거래처만), 보기 고르기(보관함 포함), 거른 보기에는 '챙길 것' 칸 */
function Customers({ data, blocked, run, launch, openCard, space, restore, want }) {
  const [chosen, setChosen] = useState(readSort);
  // 주소 ?view=(18차 홈 '챙길 것'에서 입금 지연·계산서 미발행을 누르면) — 그 보기로 연다. 카드를 열고 닫아 주소에서 빠져도 보던 보기는 그대로
  const [view, setView] = useState(() => (CUSTOMER_VIEWS.includes(want) ? want : 'all'));
  useEffect(() => { if (CUSTOMER_VIEWS.includes(want)) setView(want); }, [want]);
  const [missing, setMissing] = useState(null); // 사업자등록증 없는 거래처 id(문서함을 읽은 뒤)
  const today = kstToday();
  const attention = useMemo(() => attentionOf(data, today), [data, today]);
  const archived = data.customers.filter((row) => row.archived_at).length;
  const dated = data.customers.some((row) => row.created_at);
  const sorts = CUSTOMER_SORTS.filter((key) => key !== 'recent' || dated);
  const sort = sorts.includes(chosen) ? chosen : 'name';
  const pick = (value) => { setChosen(value); try { localStorage.setItem(SORT_KEY, value); } catch { /* 기억만 못 한다 */ } };
  const rows = filterCustomers(data.customers, view, attention, missing);
  const reason = { uninvoiced: (row) => <span className="badge warn">{t('bizui.reason.uninvoiced', { n: attention.uninvoiced.get(row.id)?.length ?? 0 })}</span>,
    overdue: (row) => <span className="badge danger">{t('bizui.late', { n: attention.overdue.get(row.id)?.[0]?.late ?? 0 })}</span>,
    nobizcert: () => <span className="badge warn">{label('reason.nobizcert')}</span> }[view] ?? null;
  return <>
    {data.customers.length > 0 && <><Suspense fallback={null}><CustomerAttention space={space} data={data} attention={attention} view={view} onView={setView} onMissing={setMissing} /></Suspense>
    <div className="biz-list-tools">
      <select className="input" value={view} aria-label={label('cview')} onChange={(e) => setView(e.target.value)}>{CUSTOMER_VIEWS.map((key) => <option key={key} value={key}>{label(`cview.${key}`)}{key === 'archived' && archived ? ` ${archived}` : ''}</option>)}</select>
      {rows.length > 1 && <select className="input" value={sort} aria-label={label('sort')} onChange={(e) => pick(e.target.value)}>{sorts.map((key) => <option key={key} value={key}>{label('sort')}: {label(`sort.${key}`)}</option>)}</select>}
      {view !== 'all' && <button type="button" className="btn sm ghost" onClick={() => setView('all')}>{label('cview.clear')}</button>}
    </div></>}
    {view === 'nobizcert' && !missing ? <p className="bizui-muted" role="status">{label('cview.loading')}</p>
      : view !== 'all' && !rows.length ? <p className="empty-state">{label(view === 'archived' ? 'cview.archivedEmpty' : 'cview.empty')}</p>
      : <CustomerTable key={`${sort}:${view}`} rows={sortCustomers(rows, data.orders, sort)} dated={dated} blocked={blocked} run={run} launch={launch} openCard={openCard} reason={reason} archivedView={view === 'archived'} restore={restore}
        assign={(ids) => assignCustomers(space, data.customers.filter((c) => ids.includes(c.id)), data)} />}
  </>;
}
/** 거래처 표 — 민감 칸은 우클릭으로 가린다(유건 9/29). 여러 칸은 공용 선택 상자(12차): 끌면 사각형에 걸친 칸만, ⇧ + 끌기 = 줄 통째, ⌘ = 영역 더하기 —
 *  고른 칸·줄은 선택 막대·우클릭으로 한 번에 가리기·가림 해제(바뀌는 칸만 redact.bulk 한 번, 토스트 '되돌리기'로 통째로) */
function CustomerTable({ rows, dated, blocked, run, launch, openCard, reason, archivedView, restore, assign }) {
  const scope = `biz:customers:${useId()}`;
  // 바뀌는 칸만, 서버 한도(500칸)씩 나눠 보낸다 — 100줄 넘게 골라도 전체가 거절되지 않게(분리 검수 M4)
  const send = async (items) => { try { for (let i = 0; i < items.length; i += 500) await run('redact.bulk', { items: items.slice(i, i + 500) }); return true; } catch { return false; /* run이 안내를 띄운다 */ } };
  const bulk = useRef(null);
  bulk.current = (items) => send(items).then((ok) => { if (!ok) throw new Error('redact'); });
  const batch = useMemo(() => (items) => bulk.current(items), []); // 칸 고르기 쓰기 묶음 — 표 하나에 하나(같은 함수여야 한 번에 보낸다)
  const rowMenu = (ids, clear) => {
    if (blocked || !ids.length) return [];
    const cells = rows.filter((row) => ids.includes(row.id)).flatMap((row) => REDACT_FIELDS.map((field) => (row.redacted ?? []).includes(field)));
    const st = redactState(cells, Boolean), go = (on) => async () => {
      const items = bulkRedactRows(rows, REDACT_FIELDS, ids, on);
      if (await send(items)) { clear?.(); showToast(t(on ? 'sel.redacted' : 'sel.unredacted', { n: items.length }), { undo: () => send(items.map((x) => ({ ...x, on: !x.on }))) }); }
    };
    // 보관·되살리기(14차) — 보관은 연결된 거래 수·합계를 보여 주는 확인 창, 되살리기는 바로(되돌릴 수 있는 동작이라 이름 입력 확인은 없다)
    const shelf = archivedView ? { label: t('bizui.unarchive'), icon: 'refresh', run: () => { restore(ids); clear?.(); } } : { label: t('bizui.archive'), icon: 'archive', run: () => launch('archive', { ids }) };
    return [...redactMenu([!st.all && { label: t('bizui.redact'), icon: 'eyeOff', run: go(true) }, st.any && { label: t('bizui.unredact'), icon: 'eye', run: go(false) }], hideAllOn(), t), shelf]; // 전체 가리기 중이면 가리기 대신 안내(18차 검수 M1)
  };
  // 에이전트에게 맡기기(17차) — 읽기 전용(blocked)이어도 된다: 장부를 바꾸지 않고 내 크루에게 글자만 보낸다
  const assignItem = (ids, clear) => ({ label: t('crew.assign'), icon: 'hand', run: () => { assign(ids); clear?.(); } });
  const [sel] = useSelection(scope, { keys: rows.map((row) => row.id), actions: (keys, clear) => [...rowMenu(keys, clear), keys.length > 0 && assignItem(keys, clear)] });
  const menu = (event) => { // 고른 행(⇧ 끌기) 위 우클릭 = 고른 행 전체, 고르지 않은 한 줄 우클릭 = 그 거래처 맡기기(가릴 칸은 칸 자체 메뉴가 먼저 받는다)
    const id = event.target.closest?.('[data-sel]')?.dataset.sel;
    if (!id || event.target.closest('[data-cell-on]')) return;
    if (sel.size < 2 || !sel.has(id)) { openMenu(event, [assignItem([id])]); return; }
    const items = [...rowMenu([...sel]), assignItem([...sel])].filter(Boolean);
    event.preventDefault(); openMenu(event, [{ heading: t('sel.count', { n: sel.size }) }, ...items]);
  };
  return <div className="cell-pick" onContextMenu={menu}>
    <Table select={{ scope, sel }} columns={['name', ...(reason ? ['reason'] : []), 'manager', 'phone', 'email', 'biz_no', 'account', 'category', 'customerStatus', ...(dated ? ['createdAt'] : []), 'edit']} rows={rows.map((row) => {
      const hide = (field) => ({ on: row.redacted?.includes(field), disabled: blocked, cellKey: `cust:${row.id}:${field}`, batch, item: { entity: 'customer', id: row.id, field }, defer: sel.size > 1 && sel.has(row.id),
        onToggle: () => run('redact.set', { entity: 'customer', id: row.id, field, on: !row.redacted?.includes(field) }).catch(() => {}) });
      // 줄 어디를 눌러도 오른쪽 패널에 거래처 카드(유건 9/30) — 버튼·가린 값(누르고 있으면 보기)·Ctrl+클릭(맥 우클릭)은 제외
      const open = (event) => {
        if (event.ctrlKey || event.target.closest('button, a, input, select')) return;
        if (event.target.closest('.redact.on')) return;
        openCard('c', row.id);
      };
      return <tr key={row.id} className="row-open" onClick={open}><td><button type="button" className="bizui-link" onClick={() => openCard('c', row.id)}>{row.name}</button></td>{reason && <td>{reason(row)}</td>}<td><Redact {...hide('manager')}>{row.manager || '—'}</Redact></td><td className="mono"><Redact {...hide('phone')}>{row.phone || '—'}</Redact></td><td><Redact {...hide('email')}>{row.email || '—'}</Redact></td><td className="mono"><Redact {...hide('biz_no')}>{row.biz_no || '—'}</Redact></td><td><Redact {...hide('account')}>{row.account || '—'}</Redact></td><td>{label(`category.${row.category ?? 'customer'}`)}</td><td>{label(`status.${row.status ?? 'active'}`)}</td>{dated && <td className="mono">{day(row.created_at)}</td>}<td className="act">{archivedView && <EditButton disabled={blocked} onClick={() => restore([row.id])}>{label('unarchive')}</EditButton>}<EditButton disabled={blocked} onClick={() => launch('customer', row)} /></td></tr>;
    })} />
  </div>;
}

export default function BusinessPage({ space, tab: requested = null, openId, view: wantView = null }) {
  const savedTabs = useStore((st) => st.layouts['biztabs:me']?.items);
  const tab = requested === 'performance' ? 'marketing' : requested;
  useLang();
  const business = useBusiness(space);
  const { data, busy, uncertain, loading, error } = business;
  const [dialog, setDialog] = useState(null), [formError, setFormError] = useState(null);
  useEffect(() => { setDialog(null); setFormError(null); }, [space, business.scopeKey, tab]); // 탭을 옮기면 이전 탭의 실패 안내는 지운다
  const path = `${baseOf(space)}/business`;
  // 카드는 지금 탭 위에서 연다(유건 9/29: 청구·입금에서 거래명을 누르면 거래 탭으로 넘어가 보던 목록을 잃었다). open = 거래 id | c:<거래처> | i:<상품>
  const openRecord = (value) => navigate(`${location.pathname}?open=${encodeURIComponent(value)}`);
  const openOrder = (id) => openRecord(id);
  const openCard = (kind, id) => openRecord(`${kind}:${id}`);
  const closeOrder = () => navigate(location.pathname);
  const blocked = busy || uncertain || !data?.can_write;
  const launch = (kind, value = {}) => { setFormError(null); setDialog({ kind, value }); };
  const run = async (action, payload, { quiet = false } = {}) => { // quiet: 자기 창에서 오류를 보여 주는 호출(단계 창)
    setFormError(null);
    try { const result = await business.mutate(action, payload); showToast(label('saved')); return result; }
    catch (failure) { if (!quiet) setFormError(businessError(failure)); throw failure; }
  };
  // 되살리기 — 확인 없이 바로, 알림에서 다시 보관할 수 있다(14차)
  const restore = (ids) => run('customer.archive', { ids, on: false }).then(() => showToast(t('bizui.unarchivedN', { n: ids.length }), { undo: () => run('customer.archive', { ids, on: true }).catch(() => {}) }), () => {});
  const liveCustomers = data ? data.customers.filter((c) => !c.archived_at).length : 0;
  const enabled = data?.settings?.enabled || MODULES;
  const tabState = readTabs(MODULES, enabled, savedTabs); // 내 탭 순서·숨김(사람마다)
  // 꺼 둔 탭 주소로 오면 분석(숨겼으면 보이는 첫 탭)을, 숨긴 탭 주소로 오면 그 탭을 그대로 보여 준다(링크가 깨지지 않게)
  const current = pickTab(tabState, tab);
  const saveTabs = (op) => {
    const items = writeTabs(tabState, op);
    if (items && saveLayout('biztabs:me', items) === false) { showToast(t('nav.saveFail')); return false; }
    return !!items;
  };
  const hideTab = (key) => { const next = afterHide(tabState, key, current); if (saveTabs({ hide: key }) && next) navigate(`${path}/${next}`); };
  const tabMenu = (key) => () => [
    tabState.hidden.includes(key) ? { label: label('tabShow'), icon: 'eye', run: () => saveTabs({ show: key }) }
      : canHide(tabState, key) ? { label: label('tabHide'), icon: 'eyeOff', run: () => hideTab(key) } : { heading: label('tabLast') },
  ];
  const showHidden = (event) => openMenu(event, [{ heading: label('tabHiddenHead') }, ...tabState.hidden.map((key) => ({ label: label(key), icon: 'eye', run: () => saveTabs({ show: key }) }))], { anchor: event.currentTarget });
  const [settings, setSettings] = useState(false);
  useEffect(() => { if (tab === 'modules') setSettings(true); }, [tab]); // 예전 '모듈 관리' 주소는 켜고 끄기 창으로 연다
  const closeSettings = useCallback(() => { setSettings(false); if (tab === 'modules') navigate(`${path}/${current}`); }, [tab, path, current]);
  const refresh = () => { business.refresh().catch(() => {}); window.dispatchEvent(new Event('office:biz-refresh')); };
  const pageMenu = (event) => openMenu(event, [
    { label: t('biz.refresh'), icon: 'refresh', run: refresh },
    ...(data && data.can_manage !== false ? [{ label: label('modules'), icon: 'layout', run: () => setSettings(true) }] : []),
  ], { anchor: event.currentTarget });
  const addButton = (onAdd, disabled) => <button type="button" className="btn sm" disabled={disabled} onClick={onAdd}><Icon name="plus" size={13} />{label('add')}</button>;
  const tabAction = data && enabledNow(data, current) && {
    customers: addButton(() => launch('customer'), blocked),
    catalog: addButton(() => launch('item', { kind: 'service', price: 0 }), blocked),
    orders: addButton(() => launch('order'), blocked || !liveCustomers || !data.items.length),
    payments: addButton(() => launch('entry', { kind: 'invoice' }), blocked || !data.orders.some((o) => o.status === 'confirmed')),
    inventory: <InfoTip end text={label('singleStock')} />,
  }[current];
  const tabs = tabBar(tabState, current);
  function enabledNow(d, key) { return (d.settings?.enabled || MODULES).includes(key); }
  const [openKind, openRef] = openId?.includes(':') ? openId.split(':') : ['order', openId];
  const order = openKind === 'order' ? data?.orders.find((row) => row.id === openRef) : null;
  const customer = openKind === 'c' ? data?.customers.find((row) => row.id === openRef) : null;
  const item = openKind === 'i' ? data?.items.find((row) => row.id === openRef) : null;
  const dismiss = () => { if (!busy) setDialog(null); };

  return <section className="page-wrap wide bizui-page">
    <header className="page-title-row"><div><h1 className="page-h1">{label('title')}</h1><p className="dim">{label('subtitle')}</p></div><button type="button" className="icon-btn" aria-label={t('more')} disabled={busy || loading} onClick={pageMenu}><Icon name="dots" /></button></header>
    <div className="biz-tabbar">
      <nav className="tabs" aria-label={label('title')}><SortableContext items={tabs.map((key) => `biztab:${key}`)} strategy={horizontalListSortingStrategy}>{tabs.map((key) => <BizTab key={key} id={key} to={`${path}/${key}`} on={current === key} hidden={tabState.hidden.includes(key)} move={(over) => saveTabs({ move: [key, over] })} menu={tabMenu(key)}>{label(key)}</BizTab>)}</SortableContext>
        {tabState.hidden.length > 0 && <button type="button" className="biz-tab-more" aria-haspopup="menu" onClick={showHidden}><Icon name="chevron" size={12} />{t('bizui.tabHiddenN', { n: tabState.hidden.length })}</button>}</nav>
      {tabAction && <div className="biz-tab-actions">{tabAction}</div>}
    </div>
    {((!data && error) || (formError && !dialog && !openId)) && <p className="bizui-error" role="alert">{t(!data && error ? error : formError)}</p>}
    {uncertain && <div className="bizui-error" role="alert"><span>{label('pending')}</span><button className="btn sm" disabled={busy} onClick={() => { setFormError(null); business.retryPending().catch(() => {}); }}>{label('retry')}</button></div>}
    {loading && !data && <p role="status">{t('biz.loading')}</p>}
    {data && <>
      {!data.can_write && <p className="bizui-muted">{label('readOnly')}</p>}
      {!enabled.includes(current) ? <p className="empty-state">{label('disabled')}</p> : <>
        {current === 'analytics' && <BusinessDashboard business={business} space={space} onOpenOrder={openOrder} />}
        {current === 'marketing' && <Marketing space={space} business={business} />}
        {current === 'customers' && <Customers data={data} blocked={blocked} run={run} launch={launch} openCard={openCard} space={space} restore={restore} want={wantView} />}
        {current === 'catalog' && <Table columns={['name', 'kind', 'sku', 'price', 'edit']} rows={data.items.map((row) => <tr key={row.id}><td><button type="button" className="bizui-link" onClick={() => openCard('i', row.id)}>{row.name}</button></td><td>{label(row.kind)}</td><td>{row.sku || '—'}</td><td className="num"><Hide k={`item:${row.id}:price`}>{money(row.price)}</Hide></td><td className="act"><EditButton disabled={blocked} onClick={() => launch('item', row)} /></td></tr>)} />}
        {current === 'orders' && <>{(!liveCustomers || !data.items.length) && <p className="bizui-muted">{label('prerequisites')}</p>}<DealBoard data={data} blocked={blocked} run={run} openOrder={openOrder} space={space} call={business.call} /></>}
        {current === 'inventory' && <><Table columns={['name', 'sku', 'stock', 'reserved', 'available', 'receive']} rows={data.items.filter((item) => item.kind === 'product').map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.sku || '—'}</td><td className="num">{row.stock}</td><td className="num">{row.reserved}</td><td className="num">{row.stock - row.reserved}</td><td className="act"><EditButton disabled={blocked} onClick={() => launch('receive', { item_id: row.id, quantity: 1 })}>{label('receive')}</EditButton></td></tr>)} /><div className="biz-section"><h2>{label('movements')}</h2></div><Table columns={['date', 'name', 'kind', 'quantity', 'orders']} rows={data.movements.map((row) => <tr key={row.id}><td>{date(row.at)}</td><td>{data.items.find((i) => i.id === row.item_id)?.name}</td><td>{label(row.kind)}</td><td className="num">{row.quantity}</td><td>{row.order_id && <button className="bizui-link" onClick={() => openOrder(row.order_id)}>{data.orders.find((o) => o.id === row.order_id)?.title}</button>}</td></tr>)} /></>}
        {current === 'payments' && <EntryRows entries={data.entries} orders={data.orders} openOrder={openOrder} />}
      </>}
      {openId && <Peek onClose={() => { if (!busy) closeOrder(); }} title={order?.title || customer?.name || item?.name || label(`notFound.${openKind}`)}>
        {!order && !customer && !item && <div className="empty-state"><p>{label('notFoundBody')}</p>
          <div className="row-gap"><button type="button" className="btn" disabled={loading} onClick={refresh}><Icon name="refresh" size={13} />{t('biz.refresh')}</button><button type="button" className="btn ghost" onClick={closeOrder}>{label('backToList')}</button></div></div>}
        {formError && <p className="bizui-error" role="alert">{t(formError)}</p>}
        {uncertain && <div className="bizui-error" role="alert"><p>{label('pending')}</p><button className="btn" disabled={busy} onClick={() => { setFormError(null); business.retryPending().catch(() => {}); }}>{label('retry')}</button></div>}
        {order && <DealDetail order={order} data={data} blocked={blocked} launch={launch} run={run} space={space} refresh={() => business.refresh().catch(() => {})} call={business.call} />}
        {customer && <CustomerCard customer={customer} data={data} blocked={blocked} run={run} launch={launch} openOrder={openOrder} space={space} restore={restore} />}
        {item && <ItemCard item={item} data={data} blocked={blocked} launch={launch} openOrder={openOrder} />}
      </Peek>}
      {settings && <Modal open title={label('modules')} onClose={closeSettings} footer={<button type="button" className="btn" onClick={closeSettings}>{label('cancel')}</button>}>
        {(formError || error) && <p className="bizui-error" role="alert">{t(formError || error)}</p>}
        {uncertain && <div className="bizui-error" role="alert"><span>{label('pending')}</span><button className="btn sm" disabled={busy} onClick={() => { setFormError(null); business.retryPending().catch(() => {}); }}>{label('retry')}</button></div>}
        <p className="dim small">{label('moduleHelp')}</p>
        <div className="bizui-module-list">{MODULES.map((key) => <label className="switch-row" key={key}><span>{label(key)}</span><input role="switch" type="checkbox" checked={enabled.includes(key)} disabled={blocked || data.can_manage === false} onChange={(event) => run('settings.save', { ...data.settings, enabled: event.target.checked ? [...enabled, key] : enabled.filter((m) => m !== key) }).catch(() => {})} /></label>)}</div>
      </Modal>}
      {dialog && <BusinessForm key={`${dialog.kind}:${dialog.value.id || ''}`} dialog={dialog} data={data} blocked={blocked} busy={busy} error={formError} dismiss={dismiss} submit={async (action, payload) => {
        const result = await run(action, payload); setDialog(null);
        if (action === 'order.create') openOrder(result.id);
        if (action === 'customer.archive') showToast(t('bizui.archivedN', { n: payload.ids.length }), { undo: () => restore(payload.ids) }); // 보관은 알림에서 바로 되돌린다
      }} />}
    </>}
  </section>;
}

function BusinessForm({ dialog, data, blocked, busy, error, dismiss, submit }) {
  const formId = useId();
  const { kind } = dialog;
  const [value, setValue] = useState({ name: '', email: '', notes: '', ceo: '', biz_no: '', manager: '', phone: '', address: '', account: '', category: 'customer', status: 'active', sku: '', title: '', customer_id: '', due_on: '', quantity: 1, amount: '', order_id: '', note: '', lines: [{ item_id: '', quantity: 1, unit_price: 0 }], ...dialog.value });
  const [invalid, setInvalid] = useState(false);
  const set = (key, next) => setValue((old) => ({ ...old, [key]: next }));
  const input = (key, props = {}) => <input className="input" value={value[key] ?? ''} onChange={(event) => set(key, event.target.value)} disabled={busy} {...props} />;
  const title = { customer: 'customers', item: 'catalog', order: 'orders', orderEdit: 'editDeal', receive: 'receive', fulfill: value.kind === 'service' ? 'deliver' : 'ship', return: 'return', entry: 'payments', cancel: 'cancelOrder' }[kind];
  const heading = kind === 'archive' ? t('bizui.archiveTitle', { n: value.ids.length }) : label(title);
  const editing = kind === 'orderEdit' ? data.orders.find((order) => order.id === value.id) : null; // 수정할 거래(창이 열린 동안 다른 기기가 바꾸면 최신 값으로 판정)
  const editable = editing ? amountEditable(editing, data.activity ?? []) : false; // 금액은 견적 단계까지(계약 금액은 성과 기록에 들어간다)
  // 거래처 고르기 — 보관한 거래처는 빼되, 지금 거래의 거래처는 남긴다(14차)
  const pickable = data.customers.filter((customer) => !customer.archived_at || customer.id === (editing?.customer_id ?? value.customer_id));
  const validLine = (line) => line.item_id && integer(line.quantity, 1, 1e6) && integer(line.unit_price);
  const entryOrder = data.orders.find((order) => order.id === value.order_id);
  const amounts = entryOrder && balance(entryOrder, data.lines, data.entries);
  const entryMax = amounts && ({ invoice: Math.max(0, amounts.total - amounts.invoiced), credit: amounts.invoiced, payment: Math.max(0, amounts.receivable), refund: amounts.paid })[value.kind];
  const send = async (event) => {
    event.preventDefault(); setInvalid(false);
    let action, payload;
    if (kind === 'customer' || kind === 'item') {
      if (!value.name.trim() || (kind === 'item' && !integer(value.price))) { setInvalid(true); return; }
      action = `${kind}.save`; payload = { name: value.name.trim(), ...(value.id ? { id: value.id, version: value.version } : {}) };
      if (kind === 'customer' && value.biz_no && !/^[0-9-]{1,20}$/.test(value.biz_no)) { setInvalid(true); return; }
      Object.assign(payload, redactDefaults(kind, value)); // 새 거래처도 이관과 같이 계좌·사업자번호는 가린 채로 시작(유건 9/29 기본 가림)
      Object.assign(payload, kind === 'customer' ? { email: value.email, notes: value.notes, ceo: value.ceo, biz_no: value.biz_no, manager: value.manager, phone: value.phone, address: value.address, account: value.account, category: value.category, status: value.status } : { kind: value.kind, sku: value.sku, price: Number(value.price) });
    } else if (kind === 'order') {
      if (!value.title.trim() || !value.customer_id || !value.lines.every(validLine)) { setInvalid(true); return; }
      action = 'order.create'; payload = { title: value.title.trim(), customer_id: value.customer_id, ...(value.due_on ? { due_on: value.due_on } : {}), lines: value.lines.map((line) => ({ item_id: line.item_id, quantity: Number(line.quantity), unit_price: Number(line.unit_price), tax_type: line.tax_type ?? 'taxable' })) };
    } else if (kind === 'orderEdit') {
      if (!editing || !value.title.trim() || !value.customer_id || (editable && !value.lines.every(validLine))) { setInvalid(true); return; }
      payload = orderUpdate(editing, data.lines, { title: value.title, customer_id: value.customer_id, due_on: value.due_on, lines: editable ? value.lines : null });
      if (!payload) { dismiss(); showToast(label('noChange')); return; } // 바뀐 것이 없으면 쓰지 않는다
      action = 'order.update';
    } else if (kind === 'archive') { action = 'customer.archive'; payload = { ids: value.ids, on: true };
    } else if (kind === 'entry') {
      if (!value.order_id || !integer(value.amount, 1, entryMax || 0)) { setInvalid(true); return; }
      action = 'entry.create'; payload = { order_id: value.order_id, kind: value.kind, amount: Number(value.amount), note: value.note };
    } else if (kind === 'cancel') { action = 'order.cancel'; payload = { id: value.id }; }
    else {
      if (!integer(value.quantity, 1, Math.min(value.max ?? 1e6, 1e6))) { setInvalid(true); return; }
      action = kind === 'receive' ? 'stock.receive' : `line.${kind}`;
      payload = { ...(kind === 'receive' ? { item_id: value.item_id, note: value.note } : { id: value.id }), quantity: Number(value.quantity) };
    }
    await submit(action, payload).catch(() => {});
  };
  const linked = kind === 'archive' ? linkedDeals(value.ids, data) : null;
  return <Modal open title={heading} onClose={dismiss} width={kind === 'order' || kind === 'orderEdit' ? 720 : 480}
    footer={<><button className="btn" type="button" disabled={busy} onClick={dismiss}>{label('cancel')}</button><button className="btn primary" type="submit" form={formId} disabled={blocked || busy}>{busy ? t('biz.loading') : label(kind === 'cancel' ? 'cancelOrder' : kind === 'archive' ? 'archive' : 'save')}</button></>}>
    <form id={formId} onSubmit={send}><fieldset className="bizui-form bizui-form-fields" disabled={busy}>
    {(kind === 'customer' || kind === 'item') && <Field name="name">{input('name', { required: true, maxLength: 200 })}</Field>}
    {kind === 'customer' && <><div className="bizui-grid2"><Field name="ceo">{input('ceo', { maxLength: 100 })}</Field><Field name="biz_no">{input('biz_no', { maxLength: 20, inputMode: 'numeric', pattern: '[0-9-]*' })}</Field>
      <Field name="manager">{input('manager', { maxLength: 100 })}</Field><Field name="phone">{input('phone', { type: 'tel', maxLength: 50 })}</Field>
      <Field name="email">{input('email', { type: 'email', maxLength: 320 })}</Field><Field name="account">{input('account', { maxLength: 200 })}</Field>
      <Field name="category"><select className="input" value={value.category} onChange={(event) => set('category', event.target.value)}>{CATEGORIES.map((key) => <option key={key} value={key}>{label(`category.${key}`)}</option>)}</select></Field>
      <Field name="customerStatus"><select className="input" value={value.status} onChange={(event) => set('status', event.target.value)}>{['active', 'hold', 'closed'].map((key) => <option key={key} value={key}>{label(`status.${key}`)}</option>)}</select></Field></div>
      <Field name="address">{input('address', { maxLength: 500 })}</Field><Field name="notes"><textarea className="input area" maxLength={10000} value={value.notes} onChange={(event) => set('notes', event.target.value)} /></Field></>}
    {kind === 'item' && <><Field name="kind"><select className="input" value={value.kind} disabled={busy || !!value.id} onChange={(event) => set('kind', event.target.value)}>{['service', 'product'].map((key) => <option key={key} value={key}>{label(key)}</option>)}</select></Field><Field name="sku">{input('sku', { maxLength: 100 })}</Field><Field name="price">{input('price', { type: 'number', min: 0, max: 1e12, step: 1, required: true })}</Field></>}
    {(kind === 'order' || kind === 'orderEdit') && <><Field name="titleField">{input('title', { required: true, maxLength: 200 })}</Field>
      <div className="bizui-grid2"><Field name="customer"><select className="input" required value={value.customer_id} onChange={(event) => set('customer_id', event.target.value)}><option value="">{label('choose')}</option>{pickable.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></Field>
        <Field name="dueOn"><input className="input" type="date" min="2000-01-01" max="2100-12-31" value={value.due_on ?? ''} onChange={(event) => set('due_on', event.target.value)} /></Field></div>
      {editing && value.customer_id !== editing.customer_id ? <p className="bizui-muted">{label('moveHint')}</p> : <p className="bizui-muted">{label('dueOnHint')}</p>}
      {kind === 'orderEdit' && !editable ? <><p className="bizui-muted" role="note">{label('amountLocked')}</p>
        <ul className="card-deals">{data.lines.filter((line) => line.order_id === value.id).map((line) => <li key={line.id}><span className="grow">{line.name}</span><span className="mono dim">{line.quantity} × {money(line.unit_price)}</span><strong className="mono">{money(line.quantity * line.unit_price + Number(line.vat || 0))}</strong></li>)}</ul></>
        : <OrderLines lines={value.lines} onChange={(lines) => set('lines', lines)} items={data.items} busy={busy} locked={(line) => kind === 'orderEdit' && lineInUse(line.id, data)} />}
    </>}
    {kind === 'archive' && <p>{linked.count ? <HideIn text={t('bizui.archiveBody', { deals: linked.count, total: '\n' })} kind="amount">{money(linked.total)}</HideIn> : label('archiveBodyNone')}</p>}
    {['receive', 'fulfill', 'return'].includes(kind) && <Field name="quantity">{input('quantity', { type: 'number', min: 1, max: value.max ?? 1e6, step: 1, required: true })}</Field>}
    {kind === 'entry' && <><Field name="orders"><select className="input" required value={value.order_id} onChange={(event) => set('order_id', event.target.value)}><option value="">{label('choose')}</option>{data.orders.filter((order) => order.status === 'confirmed').map((order) => <option key={order.id} value={order.id}>{order.title}</option>)}</select></Field><Field name="kind"><select className="input" value={value.kind} onChange={(event) => set('kind', event.target.value)}>{['invoice', 'credit', 'payment', 'refund'].map((key) => <option key={key} value={key}>{label(key)}</option>)}</select></Field><Field name="amount">{input('amount', { type: 'number', required: true, min: 1, max: entryMax ?? 1e12, step: 1 })}</Field>{amounts && <p className="bizui-muted">{label('limit')}: {money(entryMax)}</p>}</>}
    {['entry', 'receive'].includes(kind) && <Field name="notes">{input('note', { maxLength: 10000 })}</Field>}
    {kind === 'cancel' && <p>{label(value.billed > 0 ? 'cancelBodyBilled' : 'cancelBody')}</p>}
    {(error || invalid) && <p className="bizui-error" role="alert">{t(error || 'bizui.invalid')}</p>}
  </fieldset></form></Modal>;
}
