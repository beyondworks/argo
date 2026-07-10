'use client';
// 회사 셸 — 좌측 항해 사이드바(회사 정보·메뉴·크루)를 모든 회사 화면이 공유한다.
import { use, useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Wordmark, Avatar, api } from '../../ui';

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
    { href: `/c/${ws}`, label: '데크', hint: '크루와 오늘의 항해' },
    { href: `/c/${ws}/vault`, label: '기억', hint: '회사가 쌓아온 항해일지' },
  ];

  return (
    <div className="shell">
      <aside className="side">
        <a href="/" style={{ display: 'block' }}>
          <Wordmark size={17} />
        </a>

        <div>
          <div className="display" style={{ fontSize: 22, lineHeight: 1.25 }}>
            {data?.company?.name ?? ' '}
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 3 }}>
            {data ? `크루 ${data.agents?.length ?? 0} · 기억 ${data.memoryCount ?? 0}` : ' '}
          </div>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {nav.map((n) => {
            const active = pathname === n.href;
            return (
              <a
                key={n.href}
                href={n.href}
                style={{
                  padding: '9px 12px', borderRadius: 10, fontWeight: 600, fontSize: 13.5,
                  color: active ? 'var(--gold-2)' : 'var(--ink-2)',
                  background: active ? 'var(--gold-dim)' : 'transparent',
                  border: `1px solid ${active ? 'var(--gold-line)' : 'transparent'}`,
                }}
              >
                {n.label}
                <span style={{ display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--ink-3)' }}>{n.hint}</span>
              </a>
            );
          })}
        </nav>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="eyebrow">크루</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto' }}>
            {(data?.agents ?? []).map((a) => {
              const href = `/c/${ws}/crew/${a.slug}`;
              const active = pathname === href;
              return (
                <a
                  key={a.slug}
                  href={href}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
                    borderRadius: 10, background: active ? 'rgba(154,173,214,0.08)' : 'transparent',
                  }}
                >
                  <Avatar name={a.name} sm />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 650, color: active ? 'var(--ink)' : 'var(--ink-2)' }}>{a.name}</span>
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--ink-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.role}</span>
                  </span>
                </a>
              );
            })}
            {data && !data.missing && (data.agents ?? []).length === 0 && (
              <span style={{ fontSize: 12, color: 'var(--ink-3)', padding: '2px 10px' }}>아직 크루가 없습니다</span>
            )}
          </div>
        </div>
      </aside>

      <main className="main">
        {data?.missing ? (
          <div className="empty" style={{ marginTop: 60 }}>
            이 회사를 찾을 수 없습니다. <a href="/" style={{ color: 'var(--gold-2)' }}>항구로 돌아가기</a>
          </div>
        ) : children}
      </main>
    </div>
  );
}
