'use client';
// 설정 카드 "휴대폰에서 열기" — 토글·주소 선택·QR·코드·연결된 폰 목록. 서버는 /api/mobile(루프백 전용).
// 데스크톱에서 보이는 모바일 관련 **유일한** 변화다(계획 정본 ~/.claude/plans/pc-eventual-steele.md).
// 설정 페이지(1784줄) 밖 파일로 둔다 — 설정 본문엔 한 줄(<MobileCard />)만 들어간다.
import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { ConfirmModal, Spinner, timeAgo } from '../../ui';
import { useLang } from '../../i18n';
import { fieldStyle } from '../../runner-connect';

// ui.jsx api()는 body 유무로 POST만 낸다 — PUT/DELETE가 필요해 이 카드 전용 호출기를 둔다.
async function call(method, body) {
  const res = await fetch('/api/mobile', { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function MobileCard() {
  const { t, lang } = useLang();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [addr, setAddr] = useState('');
  const [revoke, setRevoke] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const pull = () => call('GET').then((d) => { setSt(d); setError(''); }).catch((e) => setError(String(e.message)));
  useEffect(() => { pull(); }, []);
  // 켜져 있을 때만 폴링 — 폰이 페어링되면 목록에 바로 뜨고, 코드 만료 카운트다운이 산다.
  useEffect(() => {
    if (!st?.enabled) return;
    const t1 = setInterval(pull, 5000);
    const t2 = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [st?.enabled]);
  // 주소 기본값 — LAN(비 Tailscale) 우선. 사용자가 고른 값은 유지.
  useEffect(() => {
    if (!st?.addresses?.length) return;
    if (!addr || !st.addresses.some((a) => a.ip === addr)) setAddr((st.addresses.find((a) => !a.tailscale) || st.addresses[0]).ip);
  }, [st, addr]);

  const url = st?.enabled && st.pending && addr ? `http://${addr}:${st.port}/m/pair?c=${st.pending.code}` : '';
  const svg = useMemo(() => {
    if (!url) return '';
    const q = qrcode(0, 'M'); q.addData(url); q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [url]);
  const secsLeft = st?.pending ? Math.max(0, Math.round((st.pending.exp - now) / 1000)) : 0;

  async function run(fn) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(String(e.message)); }
    setBusy(false);
  }
  const toggle = (on) => run(async () => setSt(await call('PUT', { enabled: on })));
  const newCode = () => run(async () => { await call('POST', {}); await pull(); });
  const doRevoke = () => run(async () => { await call('DELETE', { id: revoke.id }); setRevoke(null); await pull(); });

  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="card-title" style={{ flex: 1 }}>{t('mobile.title')}</span>
        {st && (
          <>
            <span className="chip" style={{ color: st.enabled ? 'var(--ok)' : 'var(--fg-3)' }}>{st.enabled ? t('mobile.on') : t('mobile.off')}</span>
            <button type="button" className={`btn sm ${st.enabled ? '' : 'btn-primary'}`} disabled={busy} onClick={() => toggle(!st.enabled)}
              aria-pressed={st.enabled} aria-label={t('mobile.toggle')}>
              {busy ? <Spinner size={12} /> : null}{st.enabled ? t('mobile.turnOff') : t('mobile.turnOn')}
            </button>
          </>
        )}
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('mobile.help')}</p>
      {!st ? (error ? null : <Spinner size={14} />) : st.enabled && (
        <>
          <label style={{ display: 'grid', gap: 5 }}>
            <span className="microlabel">{t('mobile.address')}</span>
            {st.addresses?.length ? (
              <select value={addr} onChange={(e) => setAddr(e.target.value)} style={fieldStyle}>
                {st.addresses.map((a) => <option key={a.ip} value={a.ip}>{a.ip}{a.tailscale ? ' — Tailscale' : ''} ({a.iface})</option>)}
              </select>
            ) : <span style={{ fontSize: 12.5, color: 'var(--danger)' }}>{t('mobile.noAddress')}</span>}
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{t('mobile.addrHint')}</span>
          </label>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
            {svg ? (
              <div aria-label={url} style={{ width: 148, height: 148, flex: 'none', background: '#fff', padding: 8, borderRadius: 10 }}
                dangerouslySetInnerHTML={{ __html: svg }} />
            ) : (
              <div style={{ width: 148, height: 148, flex: 'none', display: 'grid', placeItems: 'center', border: '1px dashed var(--border)', borderRadius: 10, fontSize: 12, color: 'var(--fg-3)' }}>
                {t('mobile.expired')}
              </div>
            )}
            <div style={{ display: 'grid', gap: 8, minWidth: 200, flex: 1 }}>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0 }}>{t('mobile.scan')}</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span className="microlabel">{t('mobile.code')}</span>
                <span className="mono" style={{ fontSize: 26, letterSpacing: 5, fontWeight: 600 }}>{st.pending ? st.pending.code : '——————'}</span>
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{st.pending ? t('mobile.expiresIn', { s: secsLeft }) : t('mobile.expired')}</span>
              </div>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', wordBreak: 'break-all' }}>{addr ? `http://${addr}:${st.port}/m/pair` : ''}</span>
              <button type="button" className="btn sm" disabled={busy} onClick={newCode} style={{ alignSelf: 'flex-start' }}>{t('mobile.newCode')}</button>
            </div>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <span className="microlabel">{t('mobile.paired')}</span>
            {st.pairs.length === 0 ? <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>{t('mobile.none')}</span> : st.pairs.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                <span style={{ flex: 1 }}>{p.name || 'Phone'} <span style={{ color: 'var(--fg-3)' }}>· {t('mobile.lastSeen', { when: timeAgo(p.lastSeen, lang) })}</span></span>
                <button type="button" className="btn sm" onClick={() => setRevoke(p)}>{t('mobile.revoke')}</button>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: 0, lineHeight: 1.6 }}>{t('mobile.firewall')} {t('mobile.noForward')}</p>
        </>
      )}
      {error && <p role="alert" style={{ fontSize: 12, color: 'var(--danger)', margin: 0 }}>{error}</p>}
      {revoke && (
        <ConfirmModal title={t('mobile.revokeTitle')} description={t('mobile.revokeDesc')} confirmLabel={t('mobile.revoke')} busy={busy}
          onConfirm={doRevoke} onClose={() => setRevoke(null)} />
      )}
    </div>
  );
}
