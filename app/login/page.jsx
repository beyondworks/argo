'use client';
// 로그인 — 이메일 코드(비밀번호 없음) + Google·GitHub.
// 데스크톱 앱(웹뷰)은 소셜 로그인 창을 못 띄운다(Google이 임베디드 웹뷰 차단, 패스키 팝업 불가) →
// 앱은 "브라우저 핸드오프": 진짜 브라우저를 열어 로그인하고, pairing code로 세션을 앱에 넘긴다.
import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { Logo, Spinner, imeGuard } from '../ui';
import { useLang } from '../i18n';

const CONTACT = process.env.NEXT_PUBLIC_ARGO_CONTACT || '';
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
  const [waiting, setWaiting] = useState(false); // 앱: 브라우저 로그인 대기 중

  const supabase = URL_ENV && KEY_ENV ? createBrowserClient(URL_ENV, KEY_ENV) : null;

  useEffect(() => {
    setIsApp('__TAURI_INTERNALS__' in window || navigator.userAgent.includes('Tauri'));
    const err = new URLSearchParams(window.location.search).get('error');
    if (err) setError(t('login.oauthFailed', { msg: err }));
  }, [t]); // eslint-disable-line

  // 매직링크는 이메일의 링크를 새 탭에서 열어 로그인한다 — 그때 이 "원래 창"이 멈춰있지 않고 홈으로 자동 복귀하도록
  // 세션 성립을 폴링한다. (같은 탭 코드 입력은 verifyCode가 즉시 이동하므로 무관. 로컬 모드는 sent가 없어 미동작.)
  // device·cookie 모드 모두: 다른 탭이 로그인하면 공유 쿠키/마커로 이 창의 /api/me가 사용자를 반환한다.
  useEffect(() => {
    if (!sent) return;
    let stop = false;
    const iv = setInterval(async () => {
      try {
        const r = await fetch('/api/me');
        if (!r.ok) return; // 미로그인 = 미들웨어 401 → 계속 대기
        const d = await r.json();
        if (!stop && d?.user) { stop = true; clearInterval(iv); window.location.href = '/'; }
      } catch { /* 다음 틱 재시도 */ }
    }, 2500);
    return () => { stop = true; clearInterval(iv); };
  }, [sent]);

  if (!URL_ENV || !KEY_ENV) {
    return (
      <Shell><p style={{ color: 'var(--fg-2)', fontSize: 13.5 }}>{t('login.localMode')}</p>
        <a className="btn btn-primary sm" href="/">{t('login.goHome')}</a></Shell>
    );
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
      // 서버가 OTP를 검증 — 세션은 브라우저에 남지 않고 기기 파일로만 발급된다
      const resp = await fetch('/api/device/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), token: code.trim() }),
      });
      // 비루프백(클라우드/워커) — 기기 세션 대신 쿠키 모델(기존 경로). 루프백은 서버 경유가 세션 단일 소유자.
      // 라우트의 루프백 게이트는 verifyOtp 호출 전에 403을 반환하므로 코드는 아직 소비되지 않았다.
      if (resp.status === 403) {
        const { error: err } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
        if (err) throw err;
        window.location.href = '/';
        return;
      }
      const res = await resp.json();
      if (res.error) throw new Error(res.error);
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
    setWaiting(true); setError('');
    try {
      // 서버가 code(브라우저용)+verifier(앱 전용 시크릿)를 생성 — 브라우저엔 code만 넘긴다
      const reg = await fetch('/api/auth/pair', { method: 'POST' }).then((r) => r.json()).catch(() => null);
      if (!reg?.code || !reg?.verifier) { setWaiting(false); setError(t('login.openFailed')); return; }
      const { code, verifier } = reg;
      const origin = window.location.origin;
      // 브라우저에서 provider 로그인 → /auth/paired가 사용자 승인 후 세션을 이 code에 봉인
      const authUrl = `${URL_ENV}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(`${origin}/auth/paired?pair=${code}`)}`;
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      try {
        await openUrl(authUrl);
      } catch {
        setWaiting(false);
        setError(t('login.openFailed')); // 긴 URL 노출 없이 짧게 — 스코프·플러그인 문제 시
        return;
      }
      // 폴링 — 브라우저가 세션을 봉인하면 code+verifier로 회수
      const started = Date.now();
      while (Date.now() - started < 5 * 60_000) {
        await new Promise((r) => setTimeout(r, 2000));
        const res = await fetch(`/api/auth/pair?code=${code}&verifier=${verifier}`).then((r) => r.json()).catch(() => ({ status: 'pending' }));
        if (res.status === 'ready') {
          // 브라우저가 회수한 세션을 서버가 검증해 기기 파일로 귀속 — 브라우저 세션은 앱에 남기지 않는다
          const link = await fetch('/api/device/link', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: res.session.access_token, refresh_token: res.session.refresh_token }),
          }).then((r) => r.json());
          if (link.error) { setError(String(link.error)); setWaiting(false); return; }
          try { // 앱을 스스로 전면으로 — 브라우저에서 돌아올 필요 없이 이어진다
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().setFocus();
          } catch { /* 포커스는 장식 — 실패해도 로그인은 완료 */ }
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
      {error && <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: 'var(--fg-3)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <a href="/legal" style={{ color: 'inherit' }}>{t('legal.link')}</a>
        {CONTACT && <a href={`mailto:${CONTACT}?subject=${encodeURIComponent(t('legal.feedbackSubject'))}`} style={{ color: 'inherit' }}>{t('legal.feedback')}</a>}
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card fade-up" style={{ width: 'min(420px, 100%)', maxWidth: '100%', padding: '34px 32px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18 }}>
        <Logo />
        {children}
      </div>
    </div>
  );
}
