'use client';
// 회사 앱셸 — shadcn 스타일 사이드바(로고 → 메뉴 → 크루)를 모든 회사 화면이 공유한다.
import { use, useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Logo, Icon, Avatar, Skeleton, api } from '../../ui';

export default function CompanyShell({ children, params }) {
  const { ws } = use(params);
  const pathname = usePathname();
  const [data, setData] = useState(null);

  const refresh = useCallback(() => {
    api(`/api/companies/${ws}`).then(setData).catch(() => setData({ missing: true }));
  }, [ws]);

  useEffect(() => {
    refresh();
    window.addEventListener('argo:refresh', refresh);
    return () => window.removeEventListener('argo:refresh', refresh);
  }, [refresh]);

  const nav = [
    { href: `/c/${ws}`, icon: 'deck', label: '데크' },
    { href: `/c/${ws}/vault`, icon: 'memory', label: '기억' },
  ];

  return (
    <div className="shell">
      <aside className="side">
        <a href="/" className="nav-item" style={{ marginBottom: 6 }}>
          <Logo size={14} />
        </a>

        <div style={{ padding: '2px 10px 12px' }}>
          {data && !data.missing ? (
            <>
              <div style={{ fontSize: 14.5, fontWeight: 650, letterSpacing: '-0.015em' }}>{data.company?.name}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 1 }}>
                크루 {data.agents?.length ?? 0} · 기억 {data.memoryCount ?? 0}
              </div>
            </>
          ) : (
            <><Skeleton h={17} w={120} /><Skeleton h={12} w={80} style={{ marginTop: 6 }} /></>
          )}
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {nav.map((n) => (
            <a key={n.href} href={n.href} className={`nav-item${pathname === n.href ? ' active' : ''}`}>
              <Icon name={n.icon} />
              {n.label}
            </a>
          ))}
        </nav>

        <div style={{ marginTop: 18, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="section-label" style={{ padding: '0 10px' }}>크루</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' }}>
            {(data?.agents ?? []).map((a) => {
              const href = `/c/${ws}/crew/${a.slug}`;
              return (
                <a key={a.slug} href={href} className={`nav-item${pathname === href ? ' active' : ''}`} style={{ paddingTop: 6, paddingBottom: 6 }}>
                  <Avatar name={a.name} sm />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', lineHeight: 1.3 }}>{a.name}</span>
                    <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.3 }}>
                      {a.role}
                    </span>
                  </span>
                </a>
              );
            })}
            {data && !data.missing && (data.agents ?? []).length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--fg-3)', padding: '2px 10px' }}>아직 크루가 없습니다</span>
            )}
          </div>
        </div>

        <a href={`/c/${ws}`} className="nav-item" style={{ color: 'var(--fg-3)', fontSize: 12 }}>
          <Icon name="plus" size={14} />
          크루 영입은 데크에서
        </a>
      </aside>

      <main className="main">
        <div className="main-inner">
          {data?.missing ? (
            <div className="empty" style={{ marginTop: 40 }}>
              이 회사를 찾을 수 없습니다. <a href="/" style={{ color: 'var(--accent)', fontWeight: 600 }}>홈으로 돌아가기</a>
            </div>
          ) : children}
        </div>
      </main>
    </div>
  );
}
