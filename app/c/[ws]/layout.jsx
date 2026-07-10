'use client';
// 회사 앱셸 — 아이콘 레일 + 흰 탑바(검색 필·회사 칩) + 캔버스 콘텐츠.
import { use, useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { StarMark, Icon, Avatar, Skeleton, api } from '../../ui';

export default function CompanyShell({ children, params }) {
  const { ws } = use(params);
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

  // 탑바 검색 → 페이지가 구독해 목록을 필터링한다.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('argo:search', { detail: q }));
  }, [q]);
  useEffect(() => { setQ(''); }, [pathname]);

  const agents = data?.agents ?? [];
  const crewMatch = pathname.match(/\/crew\/([^/]+)/);
  const currentCrew = crewMatch && agents.find((a) => a.slug === crewMatch[1]);
  const title = pathname.endsWith('/vault') ? '기억' : currentCrew ? currentCrew.name : '데크';
  const sub = pathname.endsWith('/vault')
    ? '회사가 쌓아온 항해일지'
    : currentCrew ? currentCrew.role : '크루와 오늘의 항해';

  return (
    <div className="shell">
      <aside className="rail">
        <a href="/" className="rail-logo" title="Argo 홈"><StarMark size={15} /></a>

        <a href={`/c/${ws}`} className={`rail-btn${pathname === `/c/${ws}` ? ' active' : ''}`} title="데크">
          <Icon name="deck" size={18} />
        </a>
        <a href={`/c/${ws}/vault`} className={`rail-btn${pathname.endsWith('/vault') ? ' active' : ''}`} title="기억">
          <Icon name="memory" size={18} />
        </a>

        <div className="rail-sep" />

        {agents.map((a) => {
          const href = `/c/${ws}/crew/${a.slug}`;
          const active = pathname === href;
          return (
            <a key={a.slug} href={href} className={`rail-btn${active ? ' active' : ''}`} title={`${a.name} — ${a.role}`}>
              <Avatar name={a.name} sm />
            </a>
          );
        })}
        <a href={`/c/${ws}`} className="rail-btn" title="크루 영입 — 데크에서">
          <Icon name="plus" size={17} />
        </a>
      </aside>

      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header className="topbar">
          <div style={{ minWidth: 0 }}>
            <div className="topbar-title">{title}</div>
            <div className="topbar-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
          </div>

          <div style={{ flex: 1 }} />

          <label className="search-pill">
            <Icon name="search" size={15} />
            <input placeholder="검색" value={q} onChange={(e) => setQ(e.target.value)} />
            {q && (
              <button onClick={() => setQ('')} style={{ color: 'var(--ink-3)', fontSize: 12, fontWeight: 700 }} aria-label="지우기">✕</button>
            )}
          </label>

          {data && !data.missing ? (
            <a href="/" className="user-pill" title="회사 전환">
              <Avatar name={data.company?.name} sm />
              <span style={{ maxWidth: 140, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{data.company?.name}</span>
            </a>
          ) : (
            <Skeleton h={40} w={120} style={{ borderRadius: 999 }} />
          )}
        </header>

        <main className="content" style={{ width: '100%' }}>
          {data?.missing ? (
            <div className="empty" style={{ marginTop: 40 }}>
              이 회사를 찾을 수 없습니다. <a href="/" style={{ color: 'var(--lav-strong)', fontWeight: 700 }}>홈으로 돌아가기</a>
            </div>
          ) : children}
        </main>
      </div>
    </div>
  );
}
