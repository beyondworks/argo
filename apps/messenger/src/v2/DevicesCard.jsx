// 메신저 v2 기기 관리(U6c-2a ④) — 설정 → 내 계정 안의 카드 하나(기존 msgr-setcard 모양). 플래그가 켜졌을 때만 그린다.
// 서버: msgr2_devices_list(내 기기, 세션 id·푸시 토큰은 주지 않음, state는 읽을 때 계산), msgr2_device_revoke(앱 기기만, 그 기기에 device_revoked 방송).
// 읽는 때: 카드를 열 때 한 번, 로그아웃한 뒤 한 번(주기 조회 없음). 모든 기기 로그아웃 = 다른 기기를 하나씩 폐기한 뒤 이 기기도 폐기하고 로그아웃.
import { useCallback, useEffect, useState } from 'react';
import { ConfirmModal } from '@argo/ui';
import { deviceRows } from './devices.mjs';

export function DevicesCard({ client, t, lang, onSignedOut, onError, onNote }) {
  const [rows, setRows] = useState(null); const [err, setErr] = useState(false);
  const [ask, setAsk] = useState(null); // { kind: 'one', row } | { kind: 'all' }
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await client.rpc('msgr2_devices_list');
    if (r.error) { setErr(true); return; }
    setErr(false); setRows(r.data ?? []);
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  const view = deviceRows(rows ?? [], { lang });
  const revoke = async (id) => { const r = await client.rpc('msgr2_device_revoke', { p_device: id }); if (r.error) throw new Error(r.error.message); return r.data; };
  const confirm = async () => {
    if (!ask) return; setBusy(true);
    try {
      if (ask.kind === 'one') { await revoke(ask.row.id); onNote?.(t('v2.dev.revoked')); setAsk(null); await load(); return; }
      // 모든 기기: 다른 기기 먼저(이 기기를 먼저 폐기하면 그 뒤 요청이 거부된다), 마지막에 이 기기
      for (const d of view.filter((x) => x.active && !x.current)) await revoke(d.id);
      const me = view.find((x) => x.current && x.active);
      if (me) await revoke(me.id).catch(() => {}); // 이 기기는 폐기 방송이 먼저 와서 로그아웃될 수도 있다
      setAsk(null); onSignedOut?.('v2.dev.all.done');
    } catch { onError?.(t('v2.dev.revokeFailed')); await load().catch(() => {}); } finally { setBusy(false); }
  };
  const others = view.filter((x) => x.active && !x.current).length;
  return (
    <section className="msgr-setcard msgr-v2-devices">
      <h2>{t('v2.dev.title')}</h2><p>{t('v2.dev.desc')}</p>
      {err && <p className="note" role="alert">{t('v2.dev.failed')} <button type="button" className="btn sm ghost" onClick={() => load()}>{t('v2.dev.retry')}</button></p>}
      {rows && !view.length && <p className="note">{t('v2.dev.empty')}</p>}
      {view.length > 0 && <div className="msgr-rows">
        {view.map((d) => (
          <div key={d.id} className={`row${d.active ? '' : ' dim'}`}>
            <div className="msgr-v2-dev">
              <strong>{t(`v2.dev.kind.${d.kind}`)}{d.current && <span className="msgr-klabel"> · {t('v2.dev.current')}</span>}</strong>
              <span className="sub">{[t(`v2.dev.app.${d.app}`), d.version, t('v2.dev.seen', { when: d.when })].filter(Boolean).join(' · ')}</span>
            </div>
            <span className="msgr-klabel">{t(`v2.dev.state.${d.state}`)}</span>
            {d.active && !d.current && <button type="button" className="btn sm" disabled={busy} onClick={() => setAsk({ kind: 'one', row: d })}>{t('v2.dev.revoke')}</button>}
          </div>
        ))}
      </div>}
      {view.some((x) => x.active) && <div className="row"><button type="button" className="btn sm danger" disabled={busy} onClick={() => setAsk({ kind: 'all' })}>{t('v2.dev.all')}</button>{others > 0 && <span className="msgr-klabel">{t('v2.dev.others', { n: others })}</span>}</div>}
      {ask && <ConfirmModal title={t(ask.kind === 'all' ? 'v2.dev.all.title' : 'v2.dev.revoke.title')} description={t(ask.kind === 'all' ? 'v2.dev.all.desc' : 'v2.dev.revoke.desc')}
        confirmLabel={t(ask.kind === 'all' ? 'v2.dev.all' : 'v2.dev.revoke')} busy={busy} onConfirm={confirm} onClose={() => { if (!busy) setAsk(null); }} />}
    </section>
  );
}
