'use client';
// 로그인 — 이메일 코드(비밀번호 없음) + Google·GitHub.
// 데스크톱 앱(웹뷰)은 소셜 로그인 창을 못 띄운다(Google이 임베디드 웹뷰 차단, 패스키 팝업 불가) →
// 앱은 "브라우저 핸드오프": 진짜 브라우저를 열어 로그인하고, pairing code로 세션을 앱에 넘긴다.
import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { Logo, Spinner, imeGuard } from '../ui';
import { useLang } from '../i18n';

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const randCode = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');

export default function Login() {
  const { t } = useLang();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [isApp, setIsApp] = useState(false);
  const [waiting, setWaiting] = useState(false); // 앱: 브라우저 로그인 대기 중

  const supabase = URL_ENV && KEY_ENV ? createBrowserClient(URL_ENV, KEY_ENV) : null;

  useEffect(() => {
    setIsApp('__TAURI_INTERNALS__' in window || navigator.userAgent.includes('Tauri'));
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err) setError(t('login.oauthFailed', { msg: err }));

    // 브라우저 쪽: ?pair=CODE 로 열렸다면 = 앱의 로그인 창. 로그인이 끝나면 세션을 그 코드에 봉인.
    const pair = params.get('pair');
    if (pair && supabase) {
      supabase.auth.getSession().then(({ data }) => {
        if (data.session) bindAndClose(pair, data.session);
      });
      const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
        if (session) bindAndClose(pair, session);
      });
      return () => sub.subscription.unsubscribe();
    }
  }, [t]); // eslint-disable-line

  async function bindAndClose(pair, session) {
    await fetch('/api/auth/pair/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pair, access_token: session.access_token, refresh_token: session.refresh_token }),
    }).catch(() => {});
    setError(''); setWaiting(false); setSent(false);
    document.title = 'Argo';
    window.__argoPaired = true; // 화면 전환용
    location.replace('/login?paired=1');
  }

  if (!URL_ENV || !KEY_ENV) {
    return (
      <Shell><p style={{ color: 'var(--fg-2)', fontSize: 13.5 }}>{t('login.localMode')}</p>
        <a className="btn btn-primary sm" href="/">{t('login.goHome')}</a></Shell>
    );
  }

  // 브라우저: 페어링 완료 안내(앱으로 돌아가라)
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('paired')) {
    return <Shell><h1 style={{ fontSize: 19, fontWeight: 700, margin: 0 }}>{t('login.pairedTitle')}</h1>
      <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('login.pairedBody')}</p></Shell>;
  }

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
    } catch (err) { setError(String(err.message || err)); } finally { setBusy(false); }
  }

  async function verifyCode(e) {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const { error: err } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
      if (err) throw err;
      window.location.href = '/';
    } catch (err) { setError(String(err.message || err)); setBusy(false); }
  }

  // 웹: 그 자리에서 OAuth. 앱: 브라우저 핸드오프.
  async function oauth(provider) {
    setError('');
    if (isApp) return oauthViaBrowser(provider);
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider, options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (err) setError(String(err.message || err));
  }

  // 앱: 진짜 브라우저를 열어 로그인 → pairing code로 세션 회수 → 앱 웹뷰에 세션 설정
  async function oauthViaBrowser(provider) {
    const pair = randCode();
    setWaiting(true); setError('');
    try {
      await fetch('/api/auth/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair }) });
      const origin = window.location.origin;
      // 브라우저에서 provider 로그인 → 완료되면 /login?pair= 로 되돌아와 세션 봉인
      const authUrl = `${URL_ENV}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(`${origin}/login?pair=${pair}`)}`;
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(authUrl);
      // 폴링 — 브라우저가 세션을 봉인하면 회수
      const started = Date.now();
      while (Date.now() - started < 5 * 60_000) {
        await new Promise((r) => setTimeout(r, 2000));
        const res = await fetch(`/api/auth/pair?code=${pair}`).then((r) => r.json()).catch(() => ({ status: 'pending' }));
        if (res.status === 'ready') {
          await supabase.auth.setSession(res.session); // 앱 웹뷰 쿠키에 세션 설정
          window.location.href = '/';
          return;
        }
        if (res.status === 'expired') break;
      }
      setError(t('login.pairTimeout'));
    } catch (err) {
      setError(String(err.message || err));
    } finally { setWaiting(false); }
  }

  return (
    <Shell>
      <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
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
                <input inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder={t('login.codePlaceholder')}
                  value={code} onChange={(e) => setCode(e.target.value)} {...imeGuard} />
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
            <input type="email" required autoFocus placeholder={t('login.emailPlaceholder')}
              value={email} onChange={(e) => setEmail(e.target.value)} {...imeGuard} />
          </div>
          <button className="btn btn-primary" disabled={busy || !email.trim()} style={{ justifyContent: 'center' }}>
            {busy ? <Spinner size={13} /> : t('login.sendLink')}
          </button>
        </form>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--fg-3)', fontSize: 11 }}>
        <span className="rule" style={{ flex: 1 }} /> {t('login.or')} <span className="rule" style={{ flex: 1 }} />
      </div>
      {waiting ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--fg-2)' }}>
          <Spinner size={14} /> {t('login.waitingBrowser')}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <button className="btn" onClick={() => oauth('google')} style={{ justifyContent: 'center' }}>{t('login.google')}</button>
          <button className="btn" onClick={() => oauth('github')} style={{ justifyContent: 'center' }}>{t('login.github')}</button>
          {isApp && <span style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.5 }}>{t('login.appHandoffNote')}</span>}
        </div>
      )}
      {error && <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0 }}>{error}</p>}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card fade-up" style={{ width: 'min(420px, 100%)', padding: '34px 32px', display: 'grid', gap: 18 }}>
        <Logo />
        {children}
      </div>
    </div>
  );
}
