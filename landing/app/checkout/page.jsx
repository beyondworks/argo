'use client';

// 랜딩 Pro 결제 — 로그인 먼저(2026-10-10). 요금제 버튼 → 여기서 Argo 계정 로그인(없으면 가입) → 그 계정 id를 붙인 LS 체크아웃.
// 결제가 처음부터 계정 id로 묶이므로 결제 이메일이 달라도, 결제를 먼저 해도 Pro가 그 계정에 바로 연결된다.
// 로그인은 앱과 같은 Supabase 프로젝트(Google·GitHub). 세션은 저장하지 않는다 — 계정 id·이메일만 읽고 끊는다(lib/checkout.js).
// 빌드 env: NEXT_PUBLIC_SUPABASE_URL·NEXT_PUBLIC_SUPABASE_ANON_KEY(공개 값). 없으면 결제 대신 앱 결제 안내를 보인다.
// Supabase Auth Redirect URLs에 https://argo.ceo/checkout 이 있어야 로그인 뒤 여기로 돌아온다.
import { useEffect, useState } from 'react';
import DocShell from '@/components/DocShell';
import { useLang } from '@/lib/i18n';
import { PLAN_BASE, authorizeUrl, checkoutUrl, exchangeCode, newPkce, planOf } from '@/lib/checkout';

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const STORE = 'argo-checkout'; // sessionStorage — { verifier, plan }. 이 탭에서 시작한 로그인만 이어 받는다

const readStore = () => { try { return JSON.parse(sessionStorage.getItem(STORE) || 'null'); } catch { return null; } };
const writeStore = (v) => { try { if (v) sessionStorage.setItem(STORE, JSON.stringify(v)); else sessionStorage.removeItem(STORE); return true; } catch { return false; } };

export default function CheckoutPage() {
  const { t } = useLang();
  const [plan, setPlan] = useState('monthly');
  const [state, setState] = useState('loading'); // loading | login | working | ready | already | error | unconfigured
  const [account, setAccount] = useState(null); // { id, email, url }
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false); // "다른 계정으로" — Google이 마지막 계정을 자동으로 고르지 않게

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const code = q.get('code');
    const saved = readStore();
    const p = planOf(q.get('plan') ?? saved?.plan);
    setPlan(p);
    if (!SB_URL || !SB_KEY) { setState('unconfigured'); return; }
    if (!code) { setState(q.get('error') || q.get('error_description') ? 'error' : 'login'); if (q.get('error')) history.replaceState(null, '', `/checkout?plan=${p}`); return; }
    // 돌아온 코드는 한 번만 쓴다 — 주소에서 바로 지우고, 이 탭의 검증값이 없으면(다른 탭·만료) 다시 로그인
    history.replaceState(null, '', `/checkout?plan=${p}`);
    writeStore(null);
    if (!saved?.verifier) { setState('error'); return; }
    setState('working');
    exchangeCode({ supabaseUrl: SB_URL, anonKey: SB_KEY, code, verifier: saved.verifier })
      .then((user) => {
        const url = checkoutUrl(PLAN_BASE[p], user);
        if (!url) throw new Error('no checkout url');
        setAccount({ ...user, url });
        setState(user.pro ? 'already' : 'ready');
      })
      .catch(() => setState('error'));
  }, []);

  async function login(provider) {
    if (busy) return;
    setBusy(true);
    try {
      const { verifier, challenge } = await newPkce();
      if (!writeStore({ verifier, plan })) throw new Error('storage');
      window.location.href = authorizeUrl({ supabaseUrl: SB_URL, provider, redirectTo: `${window.location.origin}/checkout`, challenge, selectAccount: switching });
    } catch {
      setBusy(false);
      setState('error');
    }
  }

  const price = t(`checkout.plan.${plan}`);
  return (
    <DocShell kicker={t('checkout.kicker')} title={t(state === 'ready' ? 'checkout.readyTitle' : state === 'already' ? 'checkout.alreadyTitle' : 'checkout.title')}>
      <p className="checkout-plan mono-label">{t('checkout.planLabel')} · {price}</p>
      {state === 'loading' && <p className="checkout-status">{t('checkout.loading')}</p>}
      {state === 'working' && <p className="checkout-status" role="status">{t('checkout.working')}</p>}
      {state === 'unconfigured' && (
        <>
          <p>{t('checkout.unconfigured')}</p>
          <div className="checkout-actions"><a className="price-cta" href="/#download">{t('checkout.download')}</a></div>
        </>
      )}
      {(state === 'login' || state === 'error') && (
        <>
          {state === 'error' ? <p className="checkout-error" role="alert">{t('checkout.error')}</p> : <p>{t('checkout.lede')}</p>}
          <div className="checkout-actions">
            <button type="button" className="price-cta hot" onClick={() => login('google')} disabled={busy}>{t('checkout.google')}</button>
            <button type="button" className="price-cta" onClick={() => login('github')} disabled={busy}>{t('checkout.github')}</button>
          </div>
          <p className="checkout-fine">{t('checkout.signupNote')}</p>
        </>
      )}
      {state === 'already' && account && (
        <>
          <p>{t('checkout.alreadyBody')}</p>
          <p className="checkout-account">{account.email || t('checkout.noEmail')}</p>
          <div className="checkout-actions">
            <a className="price-cta" href="/#download">{t('checkout.openApp')}</a>
            <button type="button" className="price-cta ghost" onClick={() => { setAccount(null); setSwitching(true); setState('login'); }}>{t('checkout.switch')}</button>
          </div>
        </>
      )}
      {state === 'ready' && account && (
        <>
          <p>{t('checkout.readyBody')}</p>
          <p className="checkout-account">{account.email || t('checkout.noEmail')}</p>
          <div className="checkout-actions">
            <a className="price-cta hot" href={account.url} data-testid="checkout-continue">{t(`checkout.continue.${plan}`)}</a>
            <button type="button" className="price-cta ghost" onClick={() => { setAccount(null); setSwitching(true); setState('login'); }}>{t('checkout.switch')}</button>
          </div>
          <p className="checkout-fine">{t('checkout.readyNote')}</p>
        </>
      )}
    </DocShell>
  );
}
