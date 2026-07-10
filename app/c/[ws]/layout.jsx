'use client';
// 회사 앱셸 — 라벨 사이드바(회사/크루 그룹 + 사용자 footer) + 헤더(타이틀·검색).
import { use, useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { StarMark, Icon, Avatar, Skeleton, Clock, api } from '../../ui';
import { useLang } from '../../i18n';

export default function CompanyShell({ children, params }) {
  const { ws } = use(params);
  const { t } = useLang();
  const pathname = usePathname();
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');

  const refresh = useCallback(() => {
    api(`/api/companies/${ws}`).then(setData).catch(() => setData({ missing: true }));
  }, [ws]);

  useEffect(() => {
    refresh();
    window.addEventListener('argo:refresh', refresh);
    return () => window.removeEventListener('argo:refresh', refresh);
  }, [refresh]);

  // 헤더 검색 → 페이지가 구독해 목록을 필터링한다.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('argo:search', { detail: q }));
  }, [q]);
  useEffect(() => { setQ(''); }, [pathname]);

  const agents = data?.agents ?? [];
  const crewMatch = pathname.match(/\/crew\/([^/]+)/);
  const currentCrew = crewMatch && agents.find((a) => a.slug === crewMatch[1]);
  const title = pathname.endsWith('/vault') ? t('nav.memory')
    : pathname.endsWith('/routines') ? t('nav.routines')
    : pathname.endsWith('/market') ? t('nav.market')
    : pathname.endsWith('/activity') ? t('nav.activity')
    : pathname.endsWith('/settings') ? t('nav.settings')
    : currentCrew ? currentCrew.name : t('nav.deck');
  // 사이드바 크루 — 팀별 그룹 (팀 없는 크루는 마지막)
  const teams = [...new Set(agents.map((a) => a.team).filter(Boolean))];
  const grouped = [...teams.map((t) => [t, agents.filter((a) => a.team === t)]), ['', agents.filter((a) => !a.team)]]
    .filter(([, list]) => list.length > 0);

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
        {grouped.map(([team, list]) => (
          <div key={team || '_none'}>
            <div className="side-group">{team || t('nav.crewCount', { n: agents.length })}</div>
            {list.map((a) => {
              const href = `/c/${ws}/crew/${a.slug}`;
              const active = pathname === href;
              return (
                <a key={a.slug} href={href} className={`nav-item${active ? ' active' : ''}`} style={{ paddingTop: 6, paddingBottom: 6 }}>
                  <Avatar name={a.name} sm />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', lineHeight: 1.3 }}>{a.name}</span>
                    <span style={{ display: 'block', fontSize: 10.5, fontWeight: 400, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.3 }}>
                      {a.role}
                    </span>
                  </span>
                </a>
              );
            })}
          </div>
        ))}
        <a href={`/c/${ws}`} className="nav-item" style={{ color: 'var(--fg-3)', fontSize: 12.5 }}>
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
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {data?.company?.name ?? ''}
            </span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--fg-3)' }}>
              {data?.company?.owner ?? ''}
            </span>
          </span>
        </div>
      </aside>

      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header className="topbar">
          <span className="topbar-title">{title}</span>
          <div style={{ flex: 1 }} />
          <Clock />
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
