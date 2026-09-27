// 로그인 — 메신저와 같은 계정(Google·Apple·GitHub). 로컬 개발 스택에서만 이메일·비밀번호 칸이 보인다.
import { useEffect, useState } from 'react';
import { t, useLang } from '../core/i18n.js';
import { signInWith, signInWithPassword } from '../core/session.js';
import { devPasswordLogin, authProviders } from '../core/supabase.js';
import { imeGuardWith } from '../core/ime.js';

export function Login() {
  useLang();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [ext, setExt] = useState(undefined);                      // undefined 읽는 중 | null 모름(전부 보임) | 서버 설정
  useEffect(() => { let live = true; authProviders().then((v) => live && setExt(v)); return () => { live = false; }; }, []);
  const providers = ext === undefined ? [] : ['google', 'apple', 'github'].filter((p) => ext === null || ext[p]);
  const go = async (fn) => { setBusy(true); setError(''); try { await fn(); } catch { setError(t('login.failed')); } finally { setBusy(false); } };
  return (
    <main className="login">
      <div className="login-card">
        <span className="space-mark login-mark">A</span>
        <h1>{t('login.title')}</h1>
        <p className="dim">{t('login.sub')}</p>
        <div className="login-buttons">
          {providers.map((p) => <button key={p} type="button" className="btn block" disabled={busy} onClick={() => go(() => signInWith(p))}>{t(`login.${p}`)}</button>)}
        </div>
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
