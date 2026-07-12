'use client';
// 앱 핸드오프 착지점 — 브라우저가 여기로 돌아온다. Supabase가 세션을 URL 조각(#access_token)으로
// 주므로(implicit) 서버는 못 읽는다 → 클라이언트가 supabase-js로 조각을 파싱해 세션을 얻고,
// pair 코드에 봉인한다. 그러면 앱이 폴링으로 회수해 스스로 로그인·전면화된다.
import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { Logo, Spinner } from '../../ui';
import { useLang } from '../../i18n';

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export default function Paired() {
  const { t } = useLang();
  const [state, setState] = useState('binding'); // binding | done | error
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!URL_ENV || !KEY_ENV) { setState('error'); setMsg('config'); return; }
    const pair = new URLSearchParams(window.location.search).get('pair');
    if (!pair) { setState('error'); setMsg('no_pair'); return; }
    const supabase = createBrowserClient(URL_ENV, KEY_ENV); // detectSessionInUrl 기본 on — 조각 파싱
    (async () => {
      // 조각 파싱이 끝나길 잠깐 기다린 뒤 세션 확보(getSession 재시도)
      let session = null;
      for (let i = 0; i < 10 && !session; i++) {
        const { data } = await supabase.auth.getSession();
        session = data.session;
        if (!session) await new Promise((r) => setTimeout(r, 400));
      }
      if (!session) { setState('error'); setMsg('no_session'); return; }
      const res = await fetch('/api/auth/pair/bind', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: pair, access_token: session.access_token, refresh_token: session.refresh_token }),
      }).then((r) => r.json()).catch(() => ({ ok: false }));
      setState(res.ok ? 'done' : 'error');
      if (!res.ok) setMsg('bind_failed');
      history.replaceState(null, '', '/auth/paired'); // 조각(토큰) URL에서 제거
    })();
  }, []);

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card fade-up" style={{ width: 'min(420px, 100%)', padding: '34px 32px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
        <Logo />
        {state === 'binding' && <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--fg-2)', fontSize: 13.5 }}><Spinner size={14} /> {t('login.pairing')}</div>}
        {state === 'done' && (
          <>
            <h1 style={{ fontSize: 19, fontWeight: 700, margin: 0 }}>{t('login.pairedTitle')}</h1>
            <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('login.pairedBody')}</p>
            <button className="btn sm" onClick={() => window.close()} style={{ justifySelf: 'start' }}>{t('login.closeWindow')}</button>
          </>
        )}
        {state === 'error' && (
          <>
            <h1 style={{ fontSize: 19, fontWeight: 700, margin: 0, color: 'var(--danger)' }}>{t('login.pairErrTitle')}</h1>
            <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('login.pairErrBody')}</p>
          </>
        )}
      </div>
    </div>
  );
}
