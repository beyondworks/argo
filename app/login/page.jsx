'use client';
// 로그인 — 매직링크(비밀번호 없음) + 구글. 인증 off(로컬 모드)면 안내만 하고 홈으로 보낸다.
import { useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { Logo, Spinner, imeGuard } from '../ui';
import { useLang } from '../i18n';

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export default function Login() {
  const { t } = useLang();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

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
          <div className="empty" style={{ padding: '18px 14px' }}>{t('login.sent', { email })}</div>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--fg-3)', fontSize: 11 }}>
          <span className="rule" style={{ flex: 1 }} /> {t('login.or')} <span className="rule" style={{ flex: 1 }} />
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <button className="btn" onClick={() => oauth('google')} style={{ justifyContent: 'center' }}>{t('login.google')}</button>
          <button className="btn" onClick={() => oauth('github')} style={{ justifyContent: 'center' }}>{t('login.github')}</button>
        </div>
        {error && <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0 }}>{error}</p>}
      </div>
    </div>
  );
}
