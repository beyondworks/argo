'use client';
// 로그인 — 매직링크/6자리 코드(비밀번호 없음) + Google·GitHub.
// 데스크톱 앱(웹뷰)에서는 소셜 로그인이 원리상 안 된다(Google이 임베디드 웹뷰를 차단,
// 패스키 시스템 팝업도 웹뷰에 안 뜸) — 앱은 이메일 코드 로그인으로 안내한다.
import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { Logo, Spinner, imeGuard } from '../ui';
import { useLang } from '../i18n';

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export default function Login() {
  const { t } = useLang();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [isApp, setIsApp] = useState(false);

  useEffect(() => {
    // Tauri 웹뷰 감지 — 소셜 버튼을 숨기고 코드 로그인으로 안내
    setIsApp('__TAURI_INTERNALS__' in window || navigator.userAgent.includes('Tauri'));
    // 소셜 콜백 실패가 조용히 되돌아오지 않도록 — 에러를 화면에 노출(진단 가능하게)
    const err = new URLSearchParams(window.location.search).get('error');
    if (err) setError(t('login.oauthFailed', { msg: err }));
  }, [t]);

  if (!URL_ENV || !KEY_ENV) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center', display: 'grid', gap: 14, justifyItems: 'center' }}>
          <Logo />
          <p style={{ color: 'var(--fg-2)', fontSize: 13.5 }}>{t('login.localMode')}</p>
          <a className="btn btn-primary sm" href="/">{t('login.goHome')}</a>
        </div>
      </div>
    );
  }

  const supabase = createBrowserClient(URL_ENV, KEY_ENV);

  async function sendLink(e) {
    e.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (err) throw err;
      setSent(true);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  // 메일 속 6자리 코드로 세션 교환 — 팝업·패스키가 안 되는 환경(데스크톱 앱)의 정식 경로
  async function verifyCode(e) {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const { error: err } = await supabase.auth.verifyOtp({
        email: email.trim(), token: code.trim(), type: 'email',
      });
      if (err) throw err;
      window.location.href = '/';
    } catch (err) {
      setError(String(err.message || err));
      setBusy(false);
    }
  }

  async function oauth(provider) {
    setError('');
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (err) setError(String(err.message || err));
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card fade-up" style={{ width: 'min(420px, 100%)', padding: '34px 32px', display: 'grid', gap: 18 }}>
        <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
          <Logo />
          <h1 style={{ fontSize: 21, fontWeight: 750, letterSpacing: '-0.01em', margin: 0 }}>{t('login.title')}</h1>
          <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('login.subtitle')}</p>
        </div>
        {sent ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="empty" style={{ padding: '14px 14px' }}>{t('login.sent', { email })}</div>
            <form onSubmit={verifyCode} style={{ display: 'grid', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.5 }}>{t('login.codeHint')}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <div className="input-bar" style={{ background: 'var(--card-2)', flex: 1 }}>
                  <input
                    inputMode="numeric" autoComplete="one-time-code" autoFocus
                    placeholder={t('login.codePlaceholder')}
                    value={code} onChange={(e) => setCode(e.target.value)}
                    {...imeGuard}
                  />
                </div>
                <button className="btn btn-primary" disabled={busy || !code.trim()} style={{ flex: 'none' }}>
                  {busy ? <Spinner size={13} /> : t('login.verifyCode')}
                </button>
              </div>
            </form>
          </div>
        ) : (
          <form onSubmit={sendLink} style={{ display: 'grid', gap: 10 }}>
            <div className="input-bar" style={{ background: 'var(--card-2)' }}>
              <input
                type="email" required autoFocus
                placeholder={t('login.emailPlaceholder')}
                value={email} onChange={(e) => setEmail(e.target.value)}
                {...imeGuard}
              />
            </div>
            <button className="btn btn-primary" disabled={busy || !email.trim()} style={{ justifyContent: 'center' }}>
              {busy ? <Spinner size={13} /> : t('login.sendLink')}
            </button>
          </form>
        )}
        {isApp ? (
          <p style={{ fontSize: 12, color: 'var(--fg-3)', margin: 0, lineHeight: 1.55 }}>{t('login.appNote')}</p>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--fg-3)', fontSize: 11 }}>
              <span className="rule" style={{ flex: 1 }} /> {t('login.or')} <span className="rule" style={{ flex: 1 }} />
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              <button className="btn" onClick={() => oauth('google')} style={{ justifyContent: 'center' }}>{t('login.google')}</button>
              <button className="btn" onClick={() => oauth('github')} style={{ justifyContent: 'center' }}>{t('login.github')}</button>
            </div>
          </>
        )}
        {error && <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0 }}>{error}</p>}
      </div>
    </div>
  );
}
