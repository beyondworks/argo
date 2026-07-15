'use client';
// 홈 — 회사 목록과 생성. 계기판 톤의 조용한 온보딩.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Logo, Icon, Avatar, Spinner, Skeleton, api, imeGuard, timeAgo } from './ui';
import { useLang } from './i18n';

export default function Home() {
  const { t, lang } = useLang();
  const router = useRouter();
  const [companies, setCompanies] = useState(null);
  const [name, setName] = useState('');
  const [presets, setPresets] = useState([]);
  const [preset, setPreset] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [pairState, setPairState] = useState(''); // '' | 'waiting' | 'done'
  const [pairError, setPairError] = useState('');
  const pairPollRef = useRef(null); // 폴링 setInterval — 언마운트 시 정리해 누수 방지
  // 호스팅 인증(authOn)이면 다른 기기 회사는 계정 동기화로 자동 수신 — 코드 붙여넣기 UI는 authOn=false일 때만
  const [authOn, setAuthOn] = useState(false);
  const [me, setMe] = useState(null); // /api/me = { authOn, user } — 상단바 계정 컨트롤(로그인/로그아웃)의 원천

  useEffect(() => {
    // lang 의존 — 프리셋 picker 라벨이 UI 언어를 따르고, cmd+/ 전환 시 즉시 갱신된다
    api(`/api/companies?lang=${lang}`).then((d) => { setCompanies(d.companies); setPresets(d.presets ?? []); }).catch((e) => setError(String(e.message)));
    api('/api/me').then((d) => { setMe(d); setAuthOn(!!d.authOn); }).catch(() => {});
  }, [lang]);

  // 컴포넌트 언마운트(회사 생성으로 페이지 이탈 등) 시 폴링 interval 누수 방지 — 브리프 코드에 없던 보강
  useEffect(() => () => { if (pairPollRef.current) clearInterval(pairPollRef.current); }, []);

  async function create(e) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true); setError('');
    try {
      const { company, firstCrew } = await api('/api/companies', { name, preset, lang });
      // 아하 모먼트 — 프리셋 회사는 첫 크루 채팅으로 직행: 시운전(첫 인사+샘플 산출물)이 눈앞에서 도착한다
      router.push(firstCrew ? `/c/${company.id}/crew/${firstCrew}` : `/c/${company.id}`);
    } catch (err) {
      setError(String(err.message)); setCreating(false);
    }
  }

  async function pair(e) {
    e.preventDefault();
    if (!pairCode.trim() || pairState === 'waiting') return;
    setPairError('');
    try {
      await api('/api/pair/accept', { code: pairCode.trim() });
      setPairState('waiting'); setPairCode('');
      // 동기화 첫 사이클이 회사를 내려줄 때까지 폴링 (2초 × 최대 60회 — RunnerRow 관례)
      let n = 0;
      if (pairPollRef.current) clearInterval(pairPollRef.current);
      pairPollRef.current = setInterval(async () => {
        try {
          const d = await api('/api/companies');
          if (d.companies.length > 0) { setCompanies(d.companies); setPairState('done'); clearInterval(pairPollRef.current); pairPollRef.current = null; }
        } catch { /* 다음 틱 재시도 */ }
        if (++n >= 60) { clearInterval(pairPollRef.current); pairPollRef.current = null; setPairState(''); setPairError(t('home.pair.timeout')); }
      }, 2000);
    } catch (err) { setPairError(String(err.message)); }
  }

  return (
    <div>
      <header className="topbar" style={{ justifyContent: 'space-between' }}>
        <Logo />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <span className="microlabel" style={{ whiteSpace: 'nowrap' }}>{t('home.tagline')}</span>
          {/* 계정 컨트롤 — 인증 모드(authOn)일 때만. 로그인 상태면 이메일+로그아웃, 아니면 로그인.
              로컬 1인 모드(authOn=false)는 계정 개념이 없어 표시하지 않는다. */}
          {me?.authOn && (
            me.user ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {me.user.email && (
                  <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {me.user.email}
                  </span>
                )}
                <form action="/auth/signout" method="post" style={{ flex: 'none' }}>
                  <button className="btn sm" title={t('login.signOut')}>{t('login.signOut')}</button>
                </form>
              </span>
            ) : (
              <a className="btn sm" href="/login">{t('home.signIn')}</a>
            )
          )}
        </div>
      </header>

      <main style={{ maxWidth: 660, margin: '0 auto', padding: '64px 24px 90px' }}>
        <div className="fade-up" style={{ marginBottom: 30 }}>
          <div className="microlabel" style={{ marginBottom: 12 }}>{t('home.boarding')}</div>
          <h1 style={{ fontSize: 26, fontWeight: 750, letterSpacing: '-0.02em', lineHeight: 1.32 }}>
            {t('home.headline1')}<br />{t('home.headline2')}
          </h1>
          <p style={{ fontSize: 14, color: 'var(--fg-2)', marginTop: 10, maxWidth: 440 }}>
            {t('home.desc')}
          </p>
        </div>

        <form onSubmit={create} className="input-bar fade-up" style={{ animationDelay: '0.06s' }}>
          <input suppressHydrationWarning
            placeholder={t('home.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
            autoFocus
            {...imeGuard}
          />
          <button className="btn btn-primary" disabled={creating || !name.trim()}>
            {creating ? <Spinner /> : <Icon name="plus" size={14} />}
            {t('home.createBtn')}
          </button>
        </form>
        {error && <p style={{ color: 'var(--danger)', marginTop: 10, fontSize: 13 }}>{error}</p>}

        {/* 시작 프리셋 — 고르면 크루 2명 + 아침 브리핑 루틴이 즉시 꾸려진다 (빈 배로도 출항 가능) */}
        <div className="fade-up" style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', animationDelay: '0.1s' }}>
          <span className="microlabel" style={{ marginRight: 2 }}>{t('home.startCrewLabel')}</span>
          <button type="button" className="chip" onClick={() => setPreset('')}
            style={{ cursor: 'pointer', ...(preset === '' ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' } : {}) }}>
            {t('home.emptyShip')}
          </button>
          {presets.map((p) => (
            <button key={p.key} type="button" className="chip" onClick={() => setPreset(p.key)} title={p.desc}
              style={{ cursor: 'pointer', ...(preset === p.key ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' } : {}) }}>
              {p.label}
            </button>
          ))}
          {preset && (
            <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
              {presets.find((p) => p.key === preset)?.desc}{t('home.morningBriefingIncluded')}
            </span>
          )}
        </div>

        <section style={{ marginTop: 42 }}>
          <div className="microlabel" style={{ marginBottom: 10 }}>{t('home.myCompanies')}</div>
          {companies === null ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <Skeleton h={70} style={{ borderRadius: 16 }} />
              <Skeleton h={70} style={{ borderRadius: 16 }} />
            </div>
          ) : companies.length === 0 ? (
            <div className="empty">{t('home.noCompanies')}</div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {companies.map((c, i) => (
                <a
                  key={c.id}
                  href={`/c/${c.id}`}
                  className="card card-i fade-up"
                  style={{ padding: '15px 18px', display: 'flex', alignItems: 'center', gap: 13, animationDelay: `${0.04 * i}s` }}
                >
                  <Avatar name={c.name} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{c.name}</div>
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', marginTop: 1 }}>{timeAgo(c.created, lang)}{t('home.createdSuffix')}</div>
                  </div>
                  <span className="chip">{t('nav.crewCount', { n: c.crew })}</span>
                  <span className="chip">{t('home.memoryCount', { n: c.memories })}</span>
                  <span style={{ color: 'var(--fg-3)', display: 'inline-flex' }}><Icon name="arrow" size={15} /></span>
                </a>
              ))}
            </div>
          )}
        </section>

        {/* M-1 페어링 — 다른 기기의 회사를 연결 코드로 가져온다 (회사가 이미 있어도 추가 연결 가능) */}
        <section style={{ marginTop: 34 }}>
          {authOn ? (
            <p className="microlabel">{t('home.pair.loginMode')}</p>
          ) : (
            <>
              <div className="microlabel" style={{ marginBottom: 8 }}>{t('home.pair.title')}</div>
              <p style={{ fontSize: 12.5, color: 'var(--fg-2)', marginBottom: 10 }}>{t('home.pair.desc')}</p>
              {pairState === 'waiting' ? (
                <p style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}><Spinner size={13} />{t('home.pair.waiting')}</p>
              ) : pairState === 'done' ? (
                <p style={{ fontSize: 13, color: 'var(--fg-2)' }}>{t('home.pair.done')}</p>
              ) : (
                <form onSubmit={pair} className="input-bar">
                  <input suppressHydrationWarning className="mono" style={{ fontSize: 12 }}
                    placeholder={t('home.pair.placeholder')}
                    value={pairCode} onChange={(e) => setPairCode(e.target.value)} {...imeGuard} />
                  <button className="btn" disabled={!pairCode.trim()}>{t('home.pair.btn')}</button>
                </form>
              )}
              {pairError && <p style={{ color: 'var(--danger)', marginTop: 8, fontSize: 12.5 }}>{pairError}</p>}
            </>
          )}
        </section>

        <footer className="microlabel" style={{ marginTop: 70 }}>
          {t('home.footer')}
        </footer>
      </main>
    </div>
  );
}
