'use client';
// 폰 페어링 페이지 — PC 설정 카드의 QR(/m/pair?c=CODE)이 여기로 온다. 코드가 있으면 바로 제출하고, 없거나
// 실패하면 코드 입력 폼. 성공 = 토큰 쿠키가 실렸으니 홈으로. 401로 튕긴 폰(해제·토글 off)도 여기서 다시 연결한다.
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Logo, Spinner } from '../../ui';
import { useLang } from '../../i18n';

const deviceName = () => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : 'Phone';
};

export default function PairPage() {
  return <Suspense><Pair /></Suspense>;
}

function Pair() {
  const { t, lang } = useLang();
  const sp = useSearchParams();
  const initial = sp.get('c') || '';
  const [code, setCode] = useState(initial);
  const [busy, setBusy] = useState(!!initial);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(c) {
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/mobile/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c, name: deviceName(), lang }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setDone(true);
      window.location.replace('/m/home'); // 첫 회사로 직행(회사 선택 랜딩은 폰 셸 밖 화면)
    } catch (e) {
      setError(String(e.message || e));
      setBusy(false);
    }
  }
  useEffect(() => { if (initial) submit(initial); }, [initial]); // QR로 왔으면 바로 제출 — initial은 마운트 후 불변

  return (
    <div style={{ minHeight: 'calc(100vh / var(--z, 1))', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card fade-up" style={{ width: 'min(380px, 100%)', padding: '28px 26px', display: 'grid', gap: 14, textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}><Logo size={18} /></div>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{t('mobile.pair.title')}</h1>
        {done ? (
          <p style={{ fontSize: 13.5, color: 'var(--fg-2)' }}>{t('mobile.pair.done')}</p>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.6, margin: 0 }}>{t('mobile.pair.help')}</p>
            <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) submit(code.trim()); }} style={{ display: 'grid', gap: 10 }}>
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={8}
                autoCapitalize="characters" autoComplete="one-time-code" inputMode="text" aria-label={t('mobile.pair.code')}
                style={{ fontSize: 22, letterSpacing: 6, textAlign: 'center', padding: '10px 12px', fontFamily: 'var(--mono)' }} />
              <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()} style={{ justifyContent: 'center', padding: '10px 14px' }}>
                {busy ? <Spinner size={13} /> : null}{busy ? t('mobile.pair.connecting') : t('mobile.pair.submit')}
              </button>
            </form>
            {error && <p role="alert" style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0 }}>{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
