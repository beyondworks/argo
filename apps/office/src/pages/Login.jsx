// 로그인 — 메신저와 같은 계정(Google·Apple·GitHub). 로컬 개발 스택에서만 이메일·비밀번호 칸이 보인다.
import { useEffect, useRef, useState } from 'react';
import { t, useLang } from '../core/i18n.js';
import { signInWith, signInWithPassword } from '../core/session.js';
import { devPasswordLogin, authProviders } from '../core/supabase.js';
import { imeGuardWith } from '../core/ime.js';
import { isDesktop } from '../core/platform.js';

export function Login() {
  useLang();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const attempt = useRef(null);
  useEffect(() => () => attempt.current?.abort(), []);
  const [ext, setExt] = useState(undefined);                      // undefined 읽는 중 | null 모름(전부 보임) | 서버 설정
  useEffect(() => { let live = true; authProviders().then((v) => live && setExt(v)); return () => { live = false; }; }, []);
  const providers = ext === undefined ? [] : ['google', 'apple', 'github'].filter((p) => ext === null || ext[p]);
  const go = async (fn) => { setBusy(true); setError(''); attempt.current = new AbortController(); try { await fn(attempt.current.signal); } catch (e) { if (e.code !== 'cancelled') setError(t(e.message === 'timeout' || e.message === 'expired' ? 'desktop.loginTimeout' : 'login.failed')); } finally { setBusy(false); attempt.current = null; } };
  return (
    <main className="login">
      <div className="login-card">
        <img className="login-mark" src="/icon-192.png" alt="" /> {/* 오피스 로고(포스트잇 + 연필, 유건 10/10) — 제목이 이름을 말하므로 장식 */}
        <h1>{t('login.title')}</h1>
        <p className="dim">{t('login.sub')}</p>
        <div className="login-buttons">
          {providers.map((p) => <button key={p} type="button" className="btn block" disabled={busy} onClick={() => go((signal) => signInWith(p, { signal }))}>{t(`login.${p}`)}</button>)}
        </div>
        {busy && isDesktop() && <p role="status">{t('desktop.loginWaiting')} <button className="link-btn" type="button" onClick={() => attempt.current?.abort()}>{t('desktop.cancel')}</button></p>}
        {devPasswordLogin && <form className="login-dev" onSubmit={(e) => { e.preventDefault(); go(() => signInWithPassword(email, password)); }}>
          <span className="label">{t('login.dev')}</span>
          <input className="input" type="email" autoComplete="username" placeholder={t('login.email')} value={email} onChange={(e) => setEmail(e.target.value)} {...imeGuardWith()} />
          <input className="input" type="password" autoComplete="current-password" placeholder={t('login.password')} value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="submit" className="btn primary block" disabled={busy || !email || !password}>{t('login.submit')}</button>
        </form>}
        {error && <p className="login-error" role="alert">{error}</p>}
      </div>
    </main>
  );
}
