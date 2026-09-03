'use client';
// 크루 목록 — 폰 셸의 '크루' 탭이 여는 페이지. 데스크톱은 사이드바가 유일한 목록이라 폰엔 페이지가 필요하다.
// 데이터: 사이드바와 같은 /api/companies/[ws]?light=1(이름·역할·팀·chatTs) + /tasks(진행 단계). 안읽음은 사이드바가 쓰는
// localStorage argo-seen:{ws} 기준선을 그대로 읽는다(쓰지는 않는다 — 기준선 갱신은 Shell 한 곳). 데스크톱에서 URL로
// 열어도 그냥 목록 페이지(무해).
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { Avatar, Skeleton, api } from '../../../ui';
import { useLang, stageLabel } from '../../../i18n';

export default function CrewListPage({ params }) {
  const { ws } = use(params);
  const { t } = useLang();
  const [data, setData] = useState(null);
  const [running, setRunning] = useState({});
  const [pending, setPending] = useState({});
  const [seen, setSeen] = useState({});

  useEffect(() => {
    try { setSeen(JSON.parse(localStorage.getItem(`argo-seen:${ws}`) || '{}')); } catch { /* 배지만 부정확 */ }
    const pull = () => {
      api(`/api/companies/${ws}?light=1`).then(setData).catch(() => setData({ agents: [] }));
      api(`/api/companies/${ws}/tasks`).then((d) => setRunning(Object.fromEntries((d.running ?? []).map((r) => [r.slug, r])))).catch(() => {});
      api(`/api/companies/${ws}/approvals`).then((d) => {
        const m = {};
        for (const a of d.approvals ?? []) if ((a.status ?? 'pending') === 'pending') m[a.slug] = (m[a.slug] ?? 0) + 1;
        setPending(m);
      }).catch(() => {});
    };
    pull();
    const iv = setInterval(pull, 10000);
    return () => clearInterval(iv);
  }, [ws]);

  const orderIdx = new Map((data?.company?.crewOrder ?? []).map((s, i) => [s, i]));
  const agents = [...(data?.agents ?? [])].sort((a, b) => (orderIdx.get(a.slug) ?? 1e9) - (orderIdx.get(b.slug) ?? 1e9));
  const pinned = new Set(data?.company?.crewPinned ?? []);
  const groups = [
    ...(agents.some((a) => pinned.has(a.slug)) ? [[t('nav.pinned'), agents.filter((a) => pinned.has(a.slug))]] : []),
    ...[...new Set(agents.filter((a) => !pinned.has(a.slug)).map((a) => a.team || ''))].map((tm) => [tm, agents.filter((a) => !pinned.has(a.slug) && (a.team || '') === tm)]),
  ];

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="page-head" style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span className="microlabel">{t('mobile.crew.title')}</span>
        <span className="microlabel">{t('nav.crewCount', { n: agents.length })}</span>
      </div>
      {!data ? <Skeleton h={56} /> : agents.length === 0 ? (
        <div className="empty">{t('mobile.crew.empty')}</div>
      ) : groups.map(([label, list]) => (
        <div key={label} className="card" style={{ padding: '4px 6px' }}>
          {label && <div className="side-group" style={{ padding: '8px 10px 4px' }}>{label}</div>}
          {list.map((a) => {
            const run = running[a.slug];
            const unread = a.chatTs != null && seen[a.slug] !== undefined && seen[a.slug] !== a.chatTs;
            const sub = run ? stageLabel(t, run.stage, run.detail) : pending[a.slug] ? t('mobile.crew.approvals', { n: pending[a.slug] }) : unread ? t('mobile.crew.unread') : (a.role || '');
            return (
              <Link key={a.slug} href={`/c/${ws}/crew/${a.slug}`} className="nav-item" style={{ minHeight: 52, gap: 12 }}>
                <Avatar name={a.name} sm />
                <span style={{ minWidth: 0, flex: 1, display: 'grid' }}>
                  <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                  <span style={{ fontSize: 11.5, color: run ? 'var(--primary-strong)' : 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</span>
                </span>
                {run ? <span className="dot" style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--primary)', flex: 'none' }} aria-hidden="true" />
                  : pending[a.slug] ? <span className="chip" style={{ color: 'var(--primary-strong)' }}>{pending[a.slug]}</span>
                  : unread ? <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--primary-strong)', flex: 'none' }} aria-hidden="true" /> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );
}
