'use client';
// 홈 — 회사 목록과 생성. 계기판 톤의 조용한 온보딩.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Logo, Icon, Avatar, Spinner, Skeleton, ConfirmModal, api, imeGuard, timeAgo } from './ui';
import { AiConnectionCard, ACCOUNT_WS, anyRunnerUsable, runnerNeedsReconnect } from './runner-connect';
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
  // 첫 항해 온보딩 — 회사 0개면 러너 연결 섹션을 보여준다(선택). 회사 생성은 러너와 무관하게
  // 항상 가능하고(유건 지시 2026-07-19: 게이트 제거), 미연결이면 데크 배너가 연결을 안내한다.
  const [acctRunners, setAcctRunners] = useState(null); // 계정 스코프(@account) 러너 상태
  const [runnerNotice, setRunnerNotice] = useState(null); // 러너 없는/끊긴 기존 회사 안내 { ws, name, invalid }
  const [claim, setClaim] = useState(null); // 계정 미연결(주인 없는) 로컬 회사 { count, names, userEmail }
  const [claimAsk, setClaimAsk] = useState(false); // 클레임 확인 모달
  const isGuest = me?.authOn && me?.user?.id === 'local'; // 게스트(로컬 전용) — 상단바에 로그인 CTA
  const onboarding = companies !== null && companies.length === 0;
  const runnerReady = !!acctRunners && anyRunnerUsable(acctRunners);

  useEffect(() => {
    // lang 의존 — 프리셋 picker 라벨이 UI 언어를 따르고, cmd+/ 전환 시 즉시 갱신된다
    api(`/api/companies?lang=${lang}`).then((d) => { setCompanies(d.companies); setPresets(d.presets ?? []); }).catch((e) => setError(String(e.message)));
    api('/api/me').then((d) => { setMe(d); setAuthOn(!!d.authOn); }).catch(() => {});
  }, [lang]);

  // 온보딩 러너 상태 — 카드가 연결/제거 시 쏘는 argo:refresh로 즉시 재판정(연결되면 3단계가 풀린다)
  useEffect(() => {
    if (!onboarding) return;
    let alive = true;
    const load = () => api('/api/account/keys').then((d) => { if (alive) setAcctRunners(d.runners ?? {}); }).catch(() => { if (alive) setAcctRunners({}); });
    load();
    window.addEventListener('argo:refresh', load);
    return () => { alive = false; window.removeEventListener('argo:refresh', load); };
  }, [onboarding]);

  // 기존 회사 러너 점검 — 재로그인·연결 끊김(무효 토큰)을 홈에서 바로 알리고 연결 섹션으로 보낸다
  useEffect(() => {
    if (!companies || companies.length === 0) { setRunnerNotice(null); return; }
    let alive = true;
    Promise.all(companies.map((c) => api(`/api/companies/${c.id}/keys`).then((d) => ({ c, runners: d.runners })).catch(() => null)))
      .then((list) => {
        if (!alive) return;
        const bad = list.filter(Boolean).find((x) => !anyRunnerUsable(x.runners));
        setRunnerNotice(bad ? { ws: bad.c.id, name: bad.c.name, invalid: runnerNeedsReconnect(bad.runners) } : null);
      });
    return () => { alive = false; };
  }, [companies]);

  // 컴포넌트 언마운트(회사 생성으로 페이지 이탈 등) 시 폴링 interval 누수 방지 — 브리프 코드에 없던 보강
  useEffect(() => () => { if (pairPollRef.current) clearInterval(pairPollRef.current); }, []);

  // 클레임 배너 — 실로그인 상태에서 주인 없는(게스트/로컬 시절) 회사가 있으면 계정 귀속을 제안
  useEffect(() => {
    if (!me?.authOn || !me?.user || me.user.id === 'local') { setClaim(null); return; }
    let alive = true;
    api('/api/account/claim')
      .then((d) => { if (alive) setClaim(d.count > 0 ? d : null); })
      .catch(() => { if (alive) setClaim(null); }); // 비루프백 403 등 — 배너 없음이 정상
    return () => { alive = false; };
  }, [me]);

  async function doClaim() {
    setClaimAsk(false);
    try {
      await api('/api/account/claim', {});
      window.location.reload(); // 귀속된 회사 목록 + 동기화 상태 재로드
    } catch (err) { setError(String(err.message)); }
  }

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
            me.user && me.user.id !== 'local' ? (
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
              /* 미로그인 + 게스트(로컬 전용) 공통 — 게스트는 로그인하면 클레임 배너로 이어진다 */
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {isGuest && <span className="microlabel" style={{ color: 'var(--fg-3)' }}>{t('home.localOnly')}</span>}
                <a className="btn sm" href="/login">{t('home.signIn')}</a>
              </span>
            )
          )}
        </div>
      </header>

      <main style={{ maxWidth: 660, margin: '0 auto', padding: '64px 24px 90px' }}>
        {/* 클레임 — 게스트/로컬 시절 회사를 로그인 계정에 연결(연결 즉시 동기화 시작) */}
        {claim && (
          <div className="card" style={{ padding: '14px 18px', marginBottom: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              {t('home.claimBanner', { n: claim.count })}
            </span>
            <button className="btn btn-primary sm" onClick={() => setClaimAsk(true)} style={{ flex: 'none' }}>
              {t('home.claimBtn')}
            </button>
          </div>
        )}
        {claimAsk && claim && (
          <ConfirmModal
            title={t('home.claimConfirmTitle')}
            description={t('home.claimConfirm', { names: claim.names.join(', '), email: claim.userEmail })}
            confirmLabel={t('home.claimBtn')}
            onConfirm={doClaim}
            onClose={() => setClaimAsk(false)}
          />
        )}
        {runnerNotice && (
          /* 러너 미연결/끊김 안내 — 누르면 그 회사 설정의 러너 연결 섹션으로 직행(?ai=1) */
          <a href={`/c/${runnerNotice.ws}/settings?ai=1`} className="card card-i fade-up"
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderColor: 'var(--accent)', marginBottom: 22 }}>
            <span style={{ color: 'var(--accent)', display: 'inline-flex' }}><Icon name="bolt" size={15} /></span>
            <span style={{ fontSize: 13, flex: 1, minWidth: 200 }}>{t(runnerNotice.invalid ? 'home.runnerReconnect' : 'home.runnerNotice', { name: runnerNotice.name })}</span>
            <span className="chip" style={{ flex: 'none' }}>{t('deck.aiKey.cta')}</span>
          </a>
        )}
        <div className="fade-up" style={{ marginBottom: 30 }}>
          <div className="microlabel" style={{ marginBottom: 12 }}>{t('home.boarding')}</div>
          <h1 style={{ fontSize: 26, fontWeight: 750, letterSpacing: '-0.02em', lineHeight: 1.32 }}>
            {t('home.headline1')}<br />{t('home.headline2')}
          </h1>
          <p style={{ fontSize: 14, color: 'var(--fg-2)', marginTop: 10, maxWidth: 440 }}>
            {t('home.desc')}
          </p>
        </div>

        {onboarding && (
          /* 첫 항해 — 러너 연결은 선택 단계. 회사 만들기를 막지 않고, 미연결이면 데크 배너가 이어받는다. */
          <div className="fade-up" style={{ display: 'grid', gap: 10, margin: '0 0 22px' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="chip" style={{ color: 'var(--ok)', borderColor: 'currentColor' }}>
                <span className="dot" />{t(me?.authOn ? 'onboard.step1' : 'onboard.step1Local')}
              </span>
              <span className="chip" style={runnerReady ? { color: 'var(--ok)', borderColor: 'currentColor' } : {}}>
                {runnerReady && <span className="dot" />}{t(runnerReady ? 'onboard.step2done' : 'onboard.step2')}
              </span>
              <span className="chip" style={{ color: 'var(--warn)', borderColor: 'currentColor' }}>
                {t('onboard.step3')}
              </span>
            </div>
            {!runnerReady && <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0 }}>{t('onboard.help')}</p>}
            <AiConnectionCard ws={ACCOUNT_WS} accordion />
          </div>
        )}
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
