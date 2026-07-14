'use client';
// 회사 앱셸 — 라벨 사이드바(회사/크루 그룹 + 사용자 footer) + 헤더(타이틀·검색).
import { use, useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { StarMark, Icon, Avatar, Skeleton, Clock, ArgoSpinner, api } from '../../ui';
import { useLang } from '../../i18n';

const fmtRun = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const fmtDur = (ms) => (ms == null ? '' : ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`);

/** 백그라운드 작업 독 — 지금 도는 턴이 있으면 배지가 켜지고, 패널에서 진행·최근 작업을 본다. */
function TasksDock({ ws }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [, forceTick] = useState(0); // 경과 시간 1초 갱신용

  useEffect(() => {
    let alive = true;
    const pull = () => api(`/api/companies/${ws}/tasks`).then((d) => { if (alive) setData(d); }).catch(() => {});
    pull();
    const t1 = setInterval(pull, open ? 3500 : 10000);
    return () => { alive = false; clearInterval(t1); };
  }, [ws, open]);

  useEffect(() => {
    if (!open || !(data?.running?.length)) return;
    const t1 = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t1);
  }, [open, data?.running?.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const running = data?.running ?? [];
  const recent = data?.recent ?? [];
  return (
    <>
      <button className="btn btn-icon" style={{ position: 'relative', flex: 'none' }} onClick={() => setOpen((o) => !o)}
        aria-label={t('tasks.open')} title={t('tasks.title')} aria-expanded={open}>
        <Icon name="tasks" size={15} />
        {running.length > 0 && <span className="tasks-badge" aria-hidden="true" />}
      </button>
      {open && (
        <div className="card tasks-panel" role="dialog" aria-label={t('tasks.title')}>
          <div className="card-head">
            <span className="card-title"><Icon name="tasks" size={13} /> {t('tasks.title')}</span>
            <span className="rule" />
            {running.length > 0 && <span className="chip"><span className="dot" />{t('tasks.running')} {running.length}</span>}
            <button className="btn sm" onClick={() => setOpen(false)}>{t('tasks.close')}</button>
          </div>
          <div className="tasks-list">
            {running.map((r) => (
              <a key={r.slug} className="task-row" href={`/c/${ws}/crew/${r.slug}`} onClick={() => setOpen(false)}>
                <ArgoSpinner size={14} />
                <span className="t-main">
                  <span className="t-title">{r.name} — {r.stage}</span>
                  <span className="t-sub mono">{r.detail || ''}</span>
                </span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtRun(Date.now() - r.startedAt)}
                </span>
              </a>
            ))}
            {running.length === 0 && (
              <div style={{ padding: '14px 12px', fontSize: 12.5, color: 'var(--fg-3)' }}>{t('tasks.emptyRunning')}</div>
            )}
            {recent.length > 0 && (
              <div className="microlabel" style={{ padding: '10px 12px 4px' }}>{t('tasks.recent')}</div>
            )}
            {recent.map((e, i) => (
              <a key={i} className="task-row" href={e.slug ? `/c/${ws}/crew/${e.slug}` : `/c/${ws}/activity`} onClick={() => setOpen(false)}>
                <span style={{ width: 6, height: 6, borderRadius: 999, flex: 'none', background: e.ok ? 'var(--ok)' : 'var(--danger)' }} aria-hidden="true" />
                <span className="t-main">
                  <span className="t-title">{e.gist || t(`tasks.type.${e.type}`)}</span>
                  <span className="t-sub">
                    {[e.gist ? t(`tasks.type.${e.type}`) : '', e.slug ?? '', e.ok ? '' : t('tasks.failed')].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>{fmtDur(e.ms)}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default function CompanyShell({ children, params }) {
  const { ws } = use(params);
  const { t } = useLang();
  const pathname = usePathname();
  const router = useRouter();
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  // 인증 상태 — 사이드바 하단에 로그인 이메일·로그아웃 노출(로컬 모드면 owner 표기 유지)
  const [me, setMe] = useState(null);
  useEffect(() => { api('/api/me').then(setMe).catch(() => {}); }, []);

  const refresh = useCallback(() => {
    api(`/api/companies/${ws}`).then(setData).catch(() => setData({ missing: true }));
  }, [ws]);

  useEffect(() => {
    refresh();
    window.addEventListener('argo:refresh', refresh);
    return () => window.removeEventListener('argo:refresh', refresh);
  }, [refresh]);

  // 크루별 텔레그램 직통 봇 상태 — 연결된 크루는 사이드바에 그린 도트
  const [tgAgents, setTgAgents] = useState({});
  useEffect(() => {
    const load = () => api(`/api/companies/${ws}/connections`).then((d) => {
      const map = {};
      for (const [slug, a] of Object.entries(d.connections?.telegram?.agents ?? {})) {
        if (a.hasToken) map[slug] = !!d.gateway?.agents?.[slug]?.alive;
      }
      setTgAgents(map);
    }).catch(() => {});
    load();
    window.addEventListener('argo:refresh', load);
    const iv = setInterval(load, 30000);
    return () => { window.removeEventListener('argo:refresh', load); clearInterval(iv); };
  }, [ws]);

  // 헤더 검색 → 페이지가 구독해 목록을 필터링한다.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('argo:search', { detail: q }));
  }, [q]);
  useEffect(() => { setQ(''); }, [pathname]);

  const agents = data?.agents ?? [];
  const crewMatch = pathname.match(/\/crew\/([^/]+)/);
  const currentCrew = crewMatch && agents.find((a) => a.slug === crewMatch[1]);
  const title = pathname.endsWith('/vault') ? t('nav.memory')
    : pathname.endsWith('/room') ? t('nav.room')
    : pathname.endsWith('/compete') ? t('nav.compete')
    : pathname.endsWith('/routines') ? t('nav.routines')
    : pathname.endsWith('/market') ? t('nav.market')
    : pathname.endsWith('/activity') ? t('nav.activity')
    : pathname.endsWith('/settings') ? t('nav.settings')
    : currentCrew ? currentCrew.name : t('nav.deck');
  // 사이드바 크루 — 팀별 그룹 (팀 없는 크루는 마지막). 아코디언 접힘 상태는 localStorage 유지.
  const teams = [...new Set(agents.map((a) => a.team).filter(Boolean))];
  const grouped = [...teams.map((t) => [t, agents.filter((a) => a.team === t)]), ['', agents.filter((a) => !a.team)]]
    .filter(([, list]) => list.length > 0);
  const [collapsed, setCollapsed] = useState({});
  useEffect(() => {
    try { setCollapsed(JSON.parse(localStorage.getItem('argo-nav-teams') || '{}')); } catch { /* 손상 시 전부 펼침 */ }
  }, []);
  const toggleTeam = (key) => setCollapsed((c) => {
    const next = { ...c, [key]: !c[key] };
    try { localStorage.setItem('argo-nav-teams', JSON.stringify(next)); } catch { /* 저장 실패해도 동작 */ }
    return next;
  });

  return (
    <div className="shell">
      <aside className="side">
        <a href="/" className="nav-item" style={{ gap: 8, marginBottom: 4 }}>
          <span style={{ color: 'var(--fg)', display: 'inline-flex' }}><StarMark size={15} /></span>
          <span className="mono" style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg)', letterSpacing: '0.16em' }}>ARGO</span>
        </a>

        <div className="side-group">{t('nav.company')}</div>
        <a href={`/c/${ws}`} className={`nav-item${pathname === `/c/${ws}` ? ' active' : ''}`}>
          <Icon name="deck" size={16} /> {t('nav.deck')}
        </a>
        <a href={`/c/${ws}/room`} className={`nav-item${pathname.endsWith('/room') ? ' active' : ''}`}>
          <Icon name="user" size={16} /> {t('nav.room')}
        </a>
        <a href={`/c/${ws}/compete`} className={`nav-item${pathname.endsWith('/compete') ? ' active' : ''}`}>
          <Icon name="bolt" size={16} /> {t('nav.compete')}
        </a>
        <a href={`/c/${ws}/vault`} className={`nav-item${pathname.endsWith('/vault') ? ' active' : ''}`}>
          <Icon name="memory" size={16} /> {t('nav.memory')}
        </a>
        <a href={`/c/${ws}/routines`} className={`nav-item${pathname.endsWith('/routines') ? ' active' : ''}`}>
          <Icon name="clock" size={16} /> {t('nav.routines')}
        </a>
        <a href={`/c/${ws}/activity`} className={`nav-item${pathname.endsWith('/activity') ? ' active' : ''}`}>
          <Icon name="bolt" size={16} /> {t('nav.activity')}
        </a>
        <a href={`/c/${ws}/market`} className={`nav-item${pathname.endsWith('/market') ? ' active' : ''}`}>
          <Icon name="market" size={16} /> {t('nav.market')}
        </a>

        {data === null && <><div className="side-group">{t('common.crew')}</div><Skeleton h={60} style={{ margin: '0 10px' }} /></>}
        {grouped.map(([team, list]) => {
          const key = team || '_none';
          const isCollapsed = !!collapsed[key];
          return (
          <div key={key}>
            <button className="side-group" onClick={() => toggleTeam(key)}
              style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', background: 'none', border: 0, padding: undefined }}
              aria-expanded={!isCollapsed}>
              <span aria-hidden="true" style={{ display: 'inline-block', fontSize: 8, transition: 'transform 0.16s cubic-bezier(0.23, 1, 0.32, 1)', transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}>▾</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{team || t('nav.crewCount', { n: agents.length })}</span>
              {isCollapsed && <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--fg-3)' }}>{list.length}</span>}
            </button>
            {!isCollapsed && list.map((a) => {
              const href = `/c/${ws}/crew/${a.slug}`;
              const active = pathname === href;
              return (
                <a key={a.slug} href={href} className={`nav-item${active ? ' active' : ''}`} style={{ paddingTop: 6, paddingBottom: 6 }}>
                  <span style={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
                    <Avatar name={a.name} sm />
                    {a.slug in tgAgents && (
                      <span title={t('nav.tgConnected')} style={{
                        position: 'absolute', right: -1, bottom: -1, width: 7, height: 7, borderRadius: 999,
                        background: tgAgents[a.slug] ? 'var(--ok)' : 'var(--warn)',
                        boxShadow: '0 0 0 2px var(--bg)',
                      }} />
                    )}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', lineHeight: 1.3 }}>{a.name}</span>
                    <span className="nav-sub">{a.role}</span>
                  </span>
                </a>
              );
            })}
          </div>
          );
        })}
        <a
          href={`/c/${ws}`}
          className="nav-item"
          style={{ color: 'var(--fg-3)', fontSize: 12.5 }}
          onClick={(e) => {
            // 새로고침 대신 — Deck의 크루 추가 입력창으로 스크롤·포커스 + 깜빡.
            e.preventDefault();
            try { sessionStorage.setItem('argo:hire', '1'); } catch { /* 프라이빗 모드 */ }
            if (pathname === `/c/${ws}`) window.dispatchEvent(new Event('argo:hire'));
            else router.push(`/c/${ws}`);
          }}
        >
          <Icon name="plus" size={15} /> {t('nav.hire')}
        </a>

        <a
          href={`/c/${ws}/settings`}
          className={`nav-item${pathname.endsWith('/settings') ? ' active' : ''}`}
          style={{ marginTop: 'auto' }}
        >
          <Icon name="settings" size={16} /> {t('nav.settings')}
        </a>
        <div className="side-footer" style={{ marginTop: 6 }}>
          <Avatar name={data?.company?.name} sm />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {data?.company?.name ?? ''}
            </span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {me?.authOn ? (me.user?.email || '') : (data?.company?.owner ?? '')}
            </span>
          </span>
          {me?.authOn && (
            <form action="/auth/signout" method="post" style={{ flex: 'none' }}>
              <button className="btn sm" title={t('login.signOut')}>{t('login.signOut')}</button>
            </form>
          )}
        </div>
      </aside>

      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header className="topbar">
          <span className="topbar-title">{title}</span>
          {/* 페이지별 컨트롤 슬롯 — 크루 채팅이 세션 상태·카드·새 대화를 포털로 꽂는다(스티키 헤더 대체) */}
          <div id="argo-topbar-slot" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }} />
          <div style={{ flex: 1 }} />
          {process.env.NEXT_PUBLIC_APP_VERSION && (
            <span className="chip mono" title={t('topbar.version')} style={{ flex: 'none', fontSize: 10.5, color: 'var(--fg-3)' }}>
              v{process.env.NEXT_PUBLIC_APP_VERSION}
            </span>
          )}
          <Clock />
          <TasksDock ws={ws} />
          <label className="search-pill">
            <Icon name="search" size={14} />
            <input suppressHydrationWarning placeholder={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button onClick={() => setQ('')} style={{ color: 'var(--fg-3)', fontSize: 12, fontWeight: 700 }} aria-label={t('common.clear')}>✕</button>
            )}
          </label>
        </header>

        <main className="content" style={{ width: '100%' }}>
          {data?.missing ? (
            <div className="empty" style={{ marginTop: 40 }}>
              {t('shell.notFound')} <a href="/" style={{ color: 'var(--primary-strong)', fontWeight: 700 }}>{t('shell.backHome')}</a>
            </div>
          ) : children}
        </main>
      </div>
    </div>
  );
}
