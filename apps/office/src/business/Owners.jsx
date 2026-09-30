// 거래 담당자(유건 9/29) — 성과 기록의 담당 거래 매출이 여기서 사람에게 연결된다.
// 바꾸기는 관리자만, 바꿀 때마다 사유와 함께 서버 이력(office_business_owner_history)에 남는다.
import { useEffect, useId, useState } from 'react';
import { t } from '../core/i18n.js';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { businessError } from './data.js';

const label = (key) => t(`bizui.${key}`);

export function OwnerField({ order, call, canManage, blocked, refresh }) {
  const formId = useId();
  const [people, setPeople] = useState(null);
  const [editing, setEditing] = useState(false), [pick, setPick] = useState([]), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  useEffect(() => { // 조직 사람 목록 — 카드를 열 때 한 번
    let live = true;
    call('office_org_people').then((rows) => { if (live) setPeople(rows ?? []); }).catch(() => { if (live) setPeople([]); });
    return () => { live = false; };
  }, [call]);
  const owners = order.owners ?? [];
  const name = (id) => people?.find((p) => p.user_id === id)?.name ?? label('owners.former');
  const open = () => { setPick(owners); setReason(''); setError(null); setEditing(true); };
  const toggle = (id) => setPick((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
  const same = pick.length === owners.length && pick.every((id) => owners.includes(id));
  const save = async (event) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await call('office_business_owners_set', { p_order: order.id, p_owners: pick, p_reason: reason.trim() });
      setEditing(false); showToast(label('owners.saved')); refresh();
    } catch (failure) { setError(businessError(failure)); } finally { setBusy(false); }
  };
  return <div className="deal-owners">
    <span className="label">{label('owners.field')}</span>
    <span className="names">{owners.length ? owners.map(name).join(', ') : <span className="dim">{label('owners.none')}</span>}</span>
    {canManage && <button type="button" className="btn ghost sm" disabled={blocked || !people} onClick={open}>{label('owners.change')}</button>}
    <Modal open={editing} title={label('owners.title')} onClose={() => { if (!busy) setEditing(false); }} footer={<>
      <button type="button" className="btn" disabled={busy} onClick={() => setEditing(false)}>{label('cancel')}</button>
      <button type="submit" form={formId} className="btn primary" disabled={busy || same || !reason.trim()}>{label('save')}</button></>}>
      <form id={formId} className="deal-owner-form" onSubmit={save}>
        <p className="dim small">{label('owners.hint')}</p>
        <div className="deal-owner-list">{(people ?? []).map((p) => <label key={p.user_id} className="check-row">
          <input type="checkbox" checked={pick.includes(p.user_id)} onChange={() => toggle(p.user_id)} />{p.name}</label>)}</div>
        <label className="field-block"><span className="label">{label('owners.reason')}</span>
          <input className="input" maxLength={500} value={reason} placeholder={label('owners.reasonHint')} onChange={(e) => setReason(e.target.value)} /></label>
        {error && <p className="biz-error" role="alert">{t(error)}</p>}
      </form>
    </Modal>
  </div>;
}
