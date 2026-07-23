'use client';
// 로그인 — 이메일 코드(비밀번호 없음) + Google·GitHub.
// 데스크톱 앱(웹뷰)은 소셜 로그인 창을 못 띄운다(Google이 임베디드 웹뷰 차단, 패스키 팝업 불가) →
// 앱은 "브라우저 핸드오프": 진짜 브라우저를 열어 로그인하고, pairing code로 세션을 앱에 넘긴다.
import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { Logo, Spinner } from '../ui';
import { useLang } from '../i18n';

const CONTACT = process.env.NEXT_PUBLIC_ARGO_CONTACT || '';
const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const LOOPBACK_RE = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/;

export default function Login() {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [isApp, setIsApp] = useState(false);
  const [isLoopback, setIsLoopback] = useState(false); // 로컬 전용 시작은 이 컴퓨터(루프백)에서만
  const [waiting, setWaiting] = useState(false); // 앱: 브라우저 로그인 대기 중

  const supabase = URL_ENV && KEY_ENV ? createBrowserClient(URL_ENV, KEY_ENV) : null;

  useEffect(() => {
    setIsApp('__TAURI_INTERNALS__' in window || navigator.userAgent.includes('Tauri'));
    setIsLoopback(LOOPBACK_RE.test(window.location.hostname));
    const err = new URLSearchParams(window.location.search).get('error');
    if (err) setError(t('login.oauthFailed', { msg: err }));
  }, [t]); // eslint-disable-line

  if (!URL_ENV || !KEY_ENV) {
    return (
      <Shell><p style={{ color: 'var(--fg-2)', fontSize: 13.5 }}>{t('login.localMode')}</p>
        <a className="btn btn-primary sm" href="/">{t('login.goHome')}</a></Shell>
    );
  }

  // 로컬 전용 시작 — 로그인 없이 이 컴퓨터에서만. 나중에 로그인하면 회사를 계정에 연결(클레임)할 수 있다.
  async function startGuest() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/device/guest', { method: 'POST' }).then((r) => r.json());
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
      {waiting ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--fg-2)' }}>
          <Spinner size={14} /> {t('login.waitingBrowser')}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => oauth('google')} disabled={busy} style={{ justifyContent: 'center' }}>{t('login.google')}</button>
          <button className="btn" onClick={() => oauth('github')} disabled={busy} style={{ justifyContent: 'center' }}>{t('login.github')}</button>
          {isApp && <span style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.5 }}>{t('login.appHandoffNote')}</span>}
        </div>
      )}
      {/* 로컬 전용 — 이 컴퓨터(루프백)에서만. 호스티드 웹은 게스트 격리 불가라 미노출 */}
      {isLoopback && !waiting && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--fg-3)', fontSize: 11 }}>
            <span className="rule" style={{ flex: 1 }} /> {t('login.or')} <span className="rule" style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <button className="btn" onClick={startGuest} disabled={busy} style={{ justifyContent: 'center' }}>
              {busy ? <Spinner size={13} /> : t('login.guestBtn')}
            </button>
            <span style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.55 }}>{t('login.guestNote')}</span>
          </div>
        </>
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
