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

// 래퍼는 반드시 모듈 수준에 둔다 — 컴포넌트 안에서 정의하면 React가 렌더마다 다른 타입으로 보고 자식을 전부 재마운트한다.
const EmbeddedWrap = ({ children }) => <div style={{ display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px dashed var(--border-soft)', paddingTop: 12, marginTop: 4 }}>{children}</div>;
const CardWrap = ({ children }) => <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>;

/** 상대시각("마지막 접속 N분 전") — 부모가 폴 결과 동일로 재렌더하지 않으므로 30초마다 스스로 갱신한다(검수 M-2: 동결). */
function TimeAgoLive({ ts }) {
  const { t, lang } = useLang();
  const [, tick] = useState(0);
  useEffect(() => { const iv = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(iv); }, []);
  return <>{t('mobile.lastSeen', { when: timeAgo(ts, lang) })}</>;
}

/** 만료 카운트다운 — 이 span만 1초마다 다시 그린다(부모 카드는 건드리지 않는다). */
function Countdown({ exp }) {
  const { t } = useLang();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now()); // exp가 바뀔 때 즉시 갱신 — 만료로 인터벌이 멎은 뒤 새 코드를 받으면 낡은 now로 "337초"가 뜨던 회귀(검수 M-1)
    if (!exp) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [exp]);
  const s = exp ? Math.max(0, Math.round((exp - now) / 1000)) : 0;
  return <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{exp && s > 0 ? t('mobile.expiresIn', { s }) : t('mobile.expired')}</span>;
}

/** embedded — 회사 정보 카드 안 한 구획으로(카드 래퍼 없이, 위 구분선 + 소제목). 회사 정보 카드의 빈 여백에 앉힌다(유건 2026-09-03).
    폼(<form>) 안에 들어가므로 버튼은 전부 type="button"이다 — 이름 저장 submit을 건드리지 않는다. */
export function MobileCard({ embedded = false } = {}) {
  const { t } = useLang();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [addr, setAddr] = useState('');
  const [revoke, setRevoke] = useState(null);

  // 폴링 응답은 **내용이 바뀌었을 때만** 상태에 반영한다 — 같은 값으로 매번 setState하면 카드 전체가 다시 그려져
  // 열어 둔 주소 드롭다운이 닫히고 드래그 선택이 풀린다(유건 제보 2026-09-03). 카운트다운도 같은 이유로 자식 컴포넌트에 격리.
  const pull = () => call('GET').then((d) => { setSt((prev) => (JSON.stringify(prev) === JSON.stringify(d) ? prev : d)); // 서버 publicView/view()의 키 순서가 고정이라는 전제(순서만 바뀌면 재렌더가 늘 뿐 재마운트는 아님) setError(''); }).catch((e) => setError(String(e.message)));
  useEffect(() => { pull(); }, []);
  // 켜져 있을 때만 폴링 — 폰이 페어링되면 목록에 바로 뜬다.
  useEffect(() => {
    if (!st?.enabled) return;
    const t1 = setInterval(pull, 5000);
    return () => clearInterval(t1);
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

  async function run(fn) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(String(e.message)); }
    setBusy(false);
  }
  const toggle = (on) => run(async () => setSt(await call('PUT', { enabled: on })));
  const newCode = () => run(async () => { await call('POST', {}); await pull(); });
  const doRevoke = () => run(async () => { await call('DELETE', { id: revoke.id }); setRevoke(null); await pull(); });

  const Wrap = embedded ? EmbeddedWrap : CardWrap; // 모듈 수준 컴포넌트 — 렌더마다 새 타입이면 하위 DOM이 매번 재마운트된다(드롭다운·선택 풀림 실측)
  return (
    <Wrap>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className={embedded ? 'microlabel' : 'card-title'} style={{ flex: 1 }}>{t('mobile.title')}</span>
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
                <Countdown exp={st.pending?.exp} />
              </div>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', wordBreak: 'break-all' }}>{addr ? `http://${addr}:${st.port}/m/pair` : ''}</span>
              <button type="button" className="btn sm" disabled={busy} onClick={newCode} style={{ alignSelf: 'flex-start' }}>{t('mobile.newCode')}</button>
            </div>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <span className="microlabel">{t('mobile.paired')}</span>
            {st.pairs.length === 0 ? <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>{t('mobile.none')}</span> : st.pairs.map((p) => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                <span style={{ flex: 1 }}>{p.name || 'Phone'} <span style={{ color: 'var(--fg-3)' }}>· <TimeAgoLive ts={p.lastSeen} /></span></span>
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
    </Wrap>
  );
}
