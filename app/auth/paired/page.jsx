'use client';
// 앱 핸드오프 착지점 — 브라우저가 여기로 돌아온다. Supabase가 세션을 URL 조각(#access_token)으로
// 주므로(implicit) 서버는 못 읽는다 → 클라이언트가 supabase-js로 조각을 파싱해 세션을 얻고,
// pair 코드에 봉인한다. 그러면 앱이 폴링으로 회수해 스스로 로그인·전면화된다.
import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Logo, Spinner } from '../../ui';
import { useLang } from '../../i18n';

const URL_ENV = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY_ENV = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export default function Paired() {
  const { t } = useLang();
  const [state, setState] = useState('checking'); // checking | confirm | binding | done | error
  const [msg, setMsg] = useState('');
  const [session, setSession] = useState(null);
  const [pair, setPair] = useState('');

  useEffect(() => {
    if (!URL_ENV || !KEY_ENV) { setState('error'); setMsg('config'); return; }
    const p = new URLSearchParams(window.location.search).get('pair');
    if (!p) { setState('error'); setMsg('no_pair'); return; }
    setPair(p);
    // 비영속 인메모리 클라이언트 — 봉인 토큰의 단일 소유자는 앱(단일 소유자 원칙), 이 탭은 파싱만 한다.
    // 세션이 탭 메모리에만 존재(탭 닫으면 소멸)하고 자동 갱신도 없어 refresh 토큰 이중 소유가 원천 차단된다.
    const supabase = createClient(URL_ENV, KEY_ENV, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: true }, // 조각(#access_token) 파싱
    });
    (async () => {
      // 조각 파싱이 끝나길 잠깐 기다린 뒤 세션 확보(getSession 재시도)
      let s = null;
      for (let i = 0; i < 10 && !s; i++) {
        const { data } = await supabase.auth.getSession();
        s = data.session;
        if (!s) await new Promise((r) => setTimeout(r, 400));
      }
      history.replaceState(null, '', '/auth/paired'); // 조각(토큰) URL에서 제거
      if (!s) { setState('error'); setMsg('no_session'); return; }
      // 자동 봉인하지 않는다 — drive-by(무클릭) 링크로 세션이 탈취되지 않도록 명시적 승인 대기.
      setSession(s);
      setState('confirm');
    })();
  }, []);

  // 사용자가 "이 기기 로그인"을 눌렀을 때만 세션을 code에 봉인한다.
  async function approve() {
    if (!session || !pair) return;
    setState('binding');
    const res = await fetch('/api/auth/pair/bind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pair, access_token: session.access_token, refresh_token: session.refresh_token }),
    }).then((r) => r.json()).catch(() => ({ ok: false }));
    setState(res.ok ? 'done' : 'error');
    if (!res.ok) setMsg('bind_failed');
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card fade-up" style={{ width: 'min(420px, 100%)', padding: '34px 32px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
        <Logo />
        {state === 'checking' && <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--fg-2)', fontSize: 13.5 }}><Spinner size={14} /> {t('login.pairing')}</div>}
        {state === 'confirm' && (
          <>
            <h1 style={{ fontSize: 19, fontWeight: 700, margin: 0 }}>{t('login.pairConfirmTitle')}</h1>
            <p style={{ fontSize: 13, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('login.pairConfirmBody')}</p>
            <button className="btn btn-primary sm" onClick={approve} style={{ justifySelf: 'start' }}>{t('login.pairApprove')}</button>
          </>
        )}
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
