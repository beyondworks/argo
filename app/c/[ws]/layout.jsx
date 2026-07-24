'use client';
// 회사 앱셸 — 라벨 사이드바(회사/크루 그룹 + 사용자 footer) + 헤더(타이틀·검색).
import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { StarMark, Icon, Avatar, Skeleton, Clock, ArgoSpinner, FeedbackModal, api } from '../../ui';
import { useLang, stageLabel } from '../../i18n';
import { useAppUpdate } from '../../use-app-update';

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
              <Link key={r.slug} className="task-row" href={`/c/${ws}/crew/${r.slug}`} onClick={() => setOpen(false)}>
                <ArgoSpinner size={14} />
                <span className="t-main">
                  <span className="t-title">{r.name} — {stageLabel(t, r.stage, r.detail)}</span>
                  <span className="t-sub mono">{r.stage === 'runner' ? '' : (r.detail || '')}</span>
                </span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtRun(Date.now() - r.startedAt)}
                </span>
              </Link>
            ))}
            {running.length === 0 && (
              <div style={{ padding: '14px 12px', fontSize: 12.5, color: 'var(--fg-3)' }}>{t('tasks.emptyRunning')}</div>
            )}
            {recent.length > 0 && (
              <div className="microlabel" style={{ padding: '10px 12px 4px' }}>{t('tasks.recent')}</div>
            )}
            {recent.map((e, i) => (
              <Link key={i} className="task-row" href={e.slug ? `/c/${ws}/crew/${e.slug}` : `/c/${ws}/activity`} onClick={() => setOpen(false)}>
                <span style={{ width: 6, height: 6, borderRadius: 999, flex: 'none', background: e.ok ? 'var(--ok)' : 'var(--danger)' }} aria-hidden="true" />
                <span className="t-main">
                  <span className="t-title">{e.gist || t(`tasks.type.${e.type}`)}</span>
                  <span className="t-sub">
                    {[e.gist ? t(`tasks.type.${e.type}`) : '', e.slug ?? '', e.ok ? '' : t('tasks.failed')].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)' }}>{fmtDur(e.ms)}</span>
              </Link>
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
  // 같은 페이지 재클릭 = 무동작 — 소프트 내비 전환(Link) 후에도 동일 URL 재이동으로 페이지 상태가 리셋되는 것을 막는다.
  const navClick = (href) => (e) => { if (pathname === href) e.preventDefault(); };
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  // 인증 상태 — 사이드바 하단에 로그인 이메일·로그아웃 노출(로컬 모드면 owner 표기 유지)
  const [me, setMe] = useState(null);
  const [fbOpen, setFbOpen] = useState(false); // 베타 피드백 모달
  useEffect(() => { api('/api/me').then(setMe).catch(() => {}); }, []);

  // 상단 버전 뱃지 — 데스크톱 앱에서는 네이티브 설치 버전 + Tauri 업데이터가 단일 진실(설정 카드와 동일 소스).
  // 새 버전이 있으면 뱃지가 '업데이트'로 바뀌고, 클릭하면 바로 다운로드·설치·재시작한다.
  const { current: appVersion, available: updateVersion, phase: updPhase, install: installUpdate } = useAppUpdate();

  // 크루 안읽음 배지 — 서버 chatTs(chats/<slug>.json mtime) vs 로컬 확인 시각(localStorage argo-seen:{ws}).
  // null = 로드 전(오탐 방지). 처음 보는 크루는 현재 상태를 기준선으로 삼아 설치 직후 전 크루 배지가 켜지지 않게 한다.
  const seenKey = `argo-seen:${ws}`;
  const [seen, setSeen] = useState(null);
  useEffect(() => {
    try { setSeen(JSON.parse(localStorage.getItem(seenKey) || '{}')); } catch { setSeen({}); }
  }, [seenKey]);
  useEffect(() => {
    if (!seen || !data?.agents) return;
    const next = { ...seen };
    let dirty = false;
    for (const a of data.agents) {
      if (a.chatTs == null) continue;
      // 보고 있는 크루는 즉시 확인 처리, 기준선 없는 크루는 지금 상태를 확인으로 기록
      if ((pathname === `/c/${ws}/crew/${a.slug}` || next[a.slug] === undefined) && next[a.slug] !== a.chatTs) {
        next[a.slug] = a.chatTs; dirty = true;
      }
    }
    if (dirty) {
      setSeen(next);
      try { localStorage.setItem(seenKey, JSON.stringify(next)); } catch { /* 프라이빗 모드 — 배지만 부정확 */ }
    }
  }, [data, seen, pathname, ws, seenKey]);

  const refresh = useCallback(() => {
    api(`/api/companies/${ws}`).then(setData).catch(() => setData({ missing: true }));
  }, [ws]);

  // 크루 고정/해제 — company.json.crewPinned 갱신 후 재조회. 비파괴·즉시(확인 불필요).
  const togglePin = useCallback(async (slug) => {
    const cur = new Set(data?.company?.crewPinned ?? []);
    cur.has(slug) ? cur.delete(slug) : cur.add(slug);
    const next = [...cur];
    // 낙관적 반영 — 연속 클릭 시 다음 핸들러가 stale 스냅샷을 읽어 이전 핀을 덮는 것을 막는다(lost-update 방지).
    setData((d) => (d?.company ? { ...d, company: { ...d.company, crewPinned: next } } : d));
    try {
      await fetch(`/api/companies/${ws}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ crewPinned: next }),
      });
      refresh();
    } catch { refresh(); /* 실패 시 서버 정본으로 되돌린다 */ }
  }, [ws, data, refresh]);

  useEffect(() => {
    refresh();
    window.addEventListener('argo:refresh', refresh);
    // 주기 재조회 — 루틴·메신저발 턴처럼 이 탭이 모르는 대화 갱신을 안읽음 배지가 잡아내려면 폴이 필요하다(로컬 API라 가볍다)
    const iv = setInterval(refresh, 30000);
    return () => { window.removeEventListener('argo:refresh', refresh); clearInterval(iv); };
  }, [refresh]);

  // 크루 순서 저장 — company.json.crewOrder(slug 배열). 낙관 반영 후 서버 기록(crewPinned과 동일 계약).
  const [dragSlug, setDragSlug] = useState(null);
  const [dropSlug, setDropSlug] = useState(null);
  const saveOrder = useCallback(async (next) => {
    setData((d) => (d?.company ? { ...d, company: { ...d.company, crewOrder: next } } : d));
    try {
      await fetch(`/api/companies/${ws}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ crewOrder: next }),
      });
    } catch { refresh(); /* 실패 시 서버 정본으로 되돌린다 */ }
  }, [ws, refresh]);

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

  // 표시 순서 — crewOrder에 있는 크루가 그 순서대로 앞에, 없는 크루는 기본(이름순) 뒤에. sort는 안정 정렬.
  const orderIdx = new Map((data?.company?.crewOrder ?? []).map((s, i) => [s, i]));
  const agents = [...(data?.agents ?? [])].sort((a, b) => (orderIdx.get(a.slug) ?? 1e9) - (orderIdx.get(b.slug) ?? 1e9));
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
  // 사이드바 크루 — 고정(pin) 크루는 최상단 '고정' 그룹으로, 나머지는 팀별 그룹(팀 없는 크루는 마지막).
  // 고정은 company.json.crewPinned(slug 배열). 아코디언 접힘 상태는 localStorage 유지.
  const pinnedSet = new Set(data?.company?.crewPinned ?? []);
  const pinnedAgents = agents.filter((a) => pinnedSet.has(a.slug));
  const rest = agents.filter((a) => !pinnedSet.has(a.slug));
  const teams = [...new Set(rest.map((a) => a.team).filter(Boolean))];
  const grouped = [
    ...(pinnedAgents.length ? [['__pinned__', pinnedAgents]] : []),
    ...teams.map((tm) => [tm, rest.filter((a) => a.team === tm)]),
    ['', rest.filter((a) => !a.team)],
  ].filter(([, list]) => list.length > 0);
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
        <Link href="/" className="nav-item" style={{ gap: 8, marginBottom: 4 }}>
          <span style={{ color: 'var(--fg)', display: 'inline-flex' }}><StarMark size={15} /></span>
          <span className="mono" style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg)', letterSpacing: '0.16em' }}>ARGO</span>
        </Link>

        <div className="side-group">{t('nav.company')}</div>
        <Link href={`/c/${ws}`} onClick={navClick(`/c/${ws}`)} className={`nav-item${pathname === `/c/${ws}` ? ' active' : ''}`}>
          <Icon name="deck" size={16} /> {t('nav.deck')}
        </Link>
        <Link href={`/c/${ws}/room`} onClick={navClick(`/c/${ws}/room`)} className={`nav-item${pathname.endsWith('/room') ? ' active' : ''}`}>
          <Icon name="user" size={16} /> {t('nav.room')}
        </Link>
        <Link href={`/c/${ws}/compete`} onClick={navClick(`/c/${ws}/compete`)} className={`nav-item${pathname.endsWith('/compete') ? ' active' : ''}`}>
          <Icon name="bolt" size={16} /> {t('nav.compete')}
        </Link>
        <Link href={`/c/${ws}/vault`} onClick={navClick(`/c/${ws}/vault`)} className={`nav-item${pathname.endsWith('/vault') ? ' active' : ''}`}>
          <Icon name="memory" size={16} /> {t('nav.memory')}
        </Link>
        <Link href={`/c/${ws}/routines`} onClick={navClick(`/c/${ws}/routines`)} className={`nav-item${pathname.endsWith('/routines') ? ' active' : ''}`}>
          <Icon name="clock" size={16} /> {t('nav.routines')}
        </Link>
        <Link href={`/c/${ws}/activity`} onClick={navClick(`/c/${ws}/activity`)} className={`nav-item${pathname.endsWith('/activity') ? ' active' : ''}`}>
          <Icon name="bolt" size={16} /> {t('nav.activity')}
        </Link>
        <Link href={`/c/${ws}/market`} onClick={navClick(`/c/${ws}/market`)} className={`nav-item${pathname.endsWith('/market') ? ' active' : ''}`}>
          <Icon name="market" size={16} /> {t('nav.market')}
        </Link>

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
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {team === '__pinned__' && <Icon name="pin" size={10} style={{ color: 'var(--primary)' }} />}
                {team === '__pinned__' ? t('nav.pinned') : (team || t('nav.crewCount', { n: list.length }))}
              </span>
              {isCollapsed && <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--fg-3)' }}>{list.length}</span>}
            </button>
            {!isCollapsed && list.map((a) => {
              const href = `/c/${ws}/crew/${a.slug}`;
              const active = pathname === href;
              const pinned = pinnedSet.has(a.slug);
              // 안읽음 — 기준선(seen)이 있고 그 뒤에 대화 파일이 갱신됐으면. 보고 있는 크루는 위 효과가 즉시 확인 처리.
              const unread = !active && a.chatTs != null && seen?.[a.slug] !== undefined && a.chatTs > seen[a.slug];
              return (
                // pin 버튼은 <a>의 형제로 둔다 — a 안에 button을 넣으면 hydration mismatch(React #418). div로 감싸 position 기준을 잡는다(세션 레일 .rail-item과 동일 패턴).
                // 행 자체가 드래그 소스/타깃 — 놓으면 끌던 크루가 이 행 앞으로 온다(crewOrder 저장).
                // 드롭은 같은 그룹(고정/팀) 안에서만 허용 — crewOrder는 그룹 내부 순서만 정하므로, 그룹을
                // 가로지르는 드롭은 표시선만 뜨고 반영이 안 되는 거짓 피드백이 된다(분리 검수 지적 2026-07-21).
                <div key={a.slug} className="crew-row" draggable
                  onDragStart={(e) => { setDragSlug(a.slug); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', a.slug); } catch { /* 구형 브라우저 */ } }}
                  onDragEnd={() => { setDragSlug(null); setDropSlug(null); }}
                  onDragOver={(e) => { if (dragSlug && dragSlug !== a.slug && list.some((x) => x.slug === dragSlug)) { e.preventDefault(); setDropSlug(a.slug); } }}
                  onDragLeave={() => setDropSlug((s) => (s === a.slug ? null : s))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!dragSlug || dragSlug === a.slug || !list.some((x) => x.slug === dragSlug)) return;
                    const flat = agents.map((x) => x.slug).filter((s) => s !== dragSlug);
                    flat.splice(flat.indexOf(a.slug), 0, dragSlug);
                    saveOrder(flat);
                    setDragSlug(null); setDropSlug(null);
                  }}
                  style={{ position: 'relative', ...(dragSlug === a.slug ? { opacity: 0.45 } : {}), ...(dropSlug === a.slug && dragSlug ? { boxShadow: 'inset 0 2px 0 var(--primary)' } : {}) }}>
                  <Link href={href} onClick={navClick(href)} draggable={false} className={`nav-item${active ? ' active' : ''}`} style={{ paddingTop: 6, paddingBottom: 6, paddingRight: 30 }}>
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
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.3 }}>
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                        {unread && <span title={t('nav.unread')} aria-label={t('nav.unread')} style={{ flex: 'none', width: 6, height: 6, borderRadius: 999, background: 'var(--primary)' }} />}
                      </span>
                      <span className="nav-sub">{a.role}</span>
                    </span>
                  </Link>
                  {/* 고정 토글 — pinned면 상시 골드, 아니면 행 hover 시 노출(.crew-row:hover .crew-pin). preventDefault로 링크 이동 차단.
                      활성 행 배경이 골드(--primary)라 골드 핀이 묻힌다 — 활성이면 온-골드 전경색(--primary-fg)으로 대비 확보(세션 레일과 동일 규칙, 실사용 신고 2026-07-21). */}
                  <button type="button" className={`crew-pin${pinned ? ' pinned' : ''}`}
                    title={pinned ? t('nav.unpin') : t('nav.pin')} aria-label={pinned ? t('nav.unpin') : t('nav.pin')}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePin(a.slug); }}
                    style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', display: 'grid', placeItems: 'center', width: 22, height: 22, border: 0, background: 'transparent', color: pinned ? (active ? 'var(--primary-fg)' : 'var(--primary)') : (active ? 'var(--primary-fg-dim)' : 'var(--fg-3)'), cursor: 'pointer', borderRadius: 6 }}>
                    <Icon name="pin" size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          );
        })}
        <Link
          href={`/c/${ws}`}
          className="nav-item"
          style={{ color: 'var(--fg-3)', fontSize: 12.5 }}
          onClick={(e) => {
            // 새 탭/새 창(cmd·ctrl·shift·중클릭)은 기본 앵커 동작 보존 — 좌클릭만 가로챈다.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            // 새로고침 대신 — Deck의 크루 추가 입력창으로 스크롤·포커스 + 깜빡.
            e.preventDefault();
            try { sessionStorage.setItem('argo:hire', '1'); } catch { /* 프라이빗 모드 */ }
            if (pathname === `/c/${ws}`) window.dispatchEvent(new Event('argo:hire'));
            else router.push(`/c/${ws}`);
          }}
        >
          <Icon name="plus" size={15} /> {t('nav.hire')}
        </Link>

        {/* 베타 피드백 — 인앱 모달로 작성 후 서버가 Supabase에 저장(브라우저 안 열림). 클라우드(로그인) 모드에서만. */}
        {me?.authOn && (
          <button
            type="button"
            className="nav-item"
            style={{ marginTop: 'auto', color: 'var(--fg-2)', width: '100%', textAlign: 'left', cursor: 'pointer', background: 'none', border: 0 }}
            onClick={() => setFbOpen(true)}
            title={t('nav.feedback')}
          >
            <Icon name="send" size={15} />
            <span style={{ flex: 1 }}>{t('nav.feedback')}</span>
            <span className="mono" style={{ fontSize: 9, letterSpacing: '0.06em', color: 'var(--primary)', border: '1px solid var(--primary-fg-line)', borderRadius: 4, padding: '1px 4px' }}>{t('feedback.beta')}</span>
          </button>
        )}
        <Link
          href={`/c/${ws}/settings`}
          onClick={navClick(`/c/${ws}/settings`)}
          className={`nav-item${pathname.endsWith('/settings') ? ' active' : ''}`}
          style={me?.authOn ? undefined : { marginTop: 'auto' }}
        >
          <Icon name="settings" size={16} /> {t('nav.settings')}
        </Link>
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
          {appVersion && (updateVersion ? (
            // 새 버전 발행됨 — 칩이 골드 '업데이트'로 바뀌고, 클릭하면 바로 다운로드·설치·재시작한다.
            <button type="button" onClick={installUpdate} disabled={updPhase === 'installing'}
              className="chip mono" title={t('topbar.updateTitle', { v: updateVersion })}
              style={{ flex: 'none', fontSize: 10.5, color: 'var(--primary-strong)', borderColor: 'var(--primary)', cursor: updPhase === 'installing' ? 'default' : 'pointer' }}>
              {updPhase === 'installing' ? <ArgoSpinner size={10} /> : <span className="dot" style={{ background: 'var(--primary)' }} aria-hidden="true" />}
              {updPhase === 'installing' ? t('settings.update.installing') : t('topbar.update')}
            </button>
          ) : (
            <span className="chip mono" title={t('topbar.version')} style={{ flex: 'none', fontSize: 10.5, color: 'var(--fg-3)' }}>
              v{appVersion}
            </span>
          ))}
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
              {t('shell.notFound')} <Link href="/" style={{ color: 'var(--primary-strong)', fontWeight: 700 }}>{t('shell.backHome')}</Link>
            </div>
          ) : children}
        </main>
      </div>
      {fbOpen && <FeedbackModal onClose={() => setFbOpen(false)} />}
    </div>
  );
}
