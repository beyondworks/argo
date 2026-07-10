'use client';
// 활동 — "내가 없는 동안 무슨 일이, 무엇을 남겼나". 리서치 원칙: 검증 비용을 줄이는 화면.
// 기본 뷰는 판단이 필요한 것(결재·오류)과 상태 변경(기억·크루·연결)만, 정상 턴은 '전체'로 접는다.
import { use, useEffect, useMemo, useState } from 'react';
import { Avatar, Skeleton, api, timeAgo } from '../../../ui';

const SOURCE = { deck: '데크', messenger: '메신저', routine: '루틴', delegate: '위임' };

// 필터 정의 — '주요'가 opinionated default (정상 대화 턴 제외)
const FILTERS = [
  ['main', '주요'],
  ['approval', '결재'],
  ['memory', '기억'],
  ['error', '오류'],
  ['all', '전체'],
];
const isError = (e) => e.ok === false;
const inFilter = (e, f) => {
  if (f === 'all') return true;
  if (f === 'error') return isError(e);
  if (f === 'approval') return e.type === 'approval';
  if (f === 'memory') return e.type === 'memory';
  // 주요 = 결재 + 오류 + 기억 + 크루/연결 운영 (정상 턴 제외)
  return e.type !== 'turn' || isError(e);
};

export default function Activity({ params }) {
  const { ws } = use(params);
  const [events, setEvents] = useState(null);
  const [agents, setAgents] = useState([]);
  const [filter, setFilter] = useState('main');
  const [q, setQ] = useState('');

  function load() {
    api(`/api/companies/${ws}/activity`).then((d) => setEvents(d.events)).catch(() => setEvents([]));
    api(`/api/companies/${ws}/agents`).then((d) => setAgents(d.agents)).catch(() => {});
  }
  useEffect(load, [ws]);
  useEffect(() => {
    const h = (e) => setQ(String(e.detail || '').toLowerCase());
    window.addEventListener('argo:search', h);
    window.addEventListener('argo:refresh', load);
    const t = setInterval(load, 20000);
    return () => { window.removeEventListener('argo:search', h); window.removeEventListener('argo:refresh', load); clearInterval(t); };
  }, [ws]);

  const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? (slug || '회사');

  // 이벤트 → 화면 행 (제목·설명·산출물 링크·칩)
  const row = (e) => {
    if (e.type === 'turn') {
      return {
        who: e.source === 'delegate' && e.from ? `${nameOf(e.from)} → ${nameOf(e.slug)}` : nameOf(e.slug),
        avatar: nameOf(e.slug),
        desc: isError(e) ? e.error : (e.gist || '지시 수행'),
        chip: isError(e) ? '오류' : (SOURCE[e.source] ?? '대화'),
        danger: isError(e),
        href: e.journalRel ? `/c/${ws}/vault?doc=${encodeURIComponent(e.journalRel)}` : null,
        linkLabel: '일지',
        ms: e.ms,
      };
    }
    if (e.type === 'memory') {
      const verb = { edit: '사장이 직접 수정', delete: '삭제' }[e.op] ?? '갱신';
      return {
        who: e.op ? '기억' : '기억 정리', avatar: '기',
        desc: isError(e) ? e.error : (e.notes?.length ? `주제 노트 ${verb} — ${e.notes.join(', ')}` : `주제 노트 ${verb}`),
        chip: isError(e) ? '오류' : '배움', danger: isError(e),
        href: e.op === 'delete' ? null : `/c/${ws}/vault`, linkLabel: '기억',
      };
    }
    if (e.type === 'approval') {
      const st = { pending: '요청', approved: '승인', rejected: '거절' }[e.status] ?? e.status;
      return {
        who: nameOf(e.slug), avatar: nameOf(e.slug), desc: e.action,
        chip: `결재 ${st}`, danger: false,
        href: e.status === 'pending' ? `/c/${ws}` : `/c/${ws}/crew/${e.slug}`,
        linkLabel: e.status === 'pending' ? '결재함' : '대화',
      };
    }
    if (e.type === 'crew') {
      const op = { hire: '영입', fire: '하선', update: '정보 변경', team: '팀 개편' }[e.op] ?? e.op;
      return { who: e.name || nameOf(e.slug), avatar: e.name || nameOf(e.slug), desc: op, chip: '크루', href: e.slug ? `/c/${ws}/crew/${e.slug}` : null, linkLabel: '카드' };
    }
    if (e.type === 'gateway') {
      return { who: e.kind === 'telegram' ? '텔레그램' : '슬랙', avatar: '연', desc: '메신저 페어링 완료', chip: '연결', href: `/c/${ws}/settings`, linkLabel: '설정' };
    }
    return { who: e.type, avatar: '?', desc: '', chip: e.type };
  };

  const list = useMemo(() => (events ?? [])
    .filter((e) => inFilter(e, filter))
    .map((e) => ({ e, r: row(e) }))
    .filter(({ r }) => !q || `${r.who} ${r.desc} ${r.chip}`.toLowerCase().includes(q)),
  [events, filter, q, agents]);

  // 우측 레일 — 오늘 요약 + 크루별 처리량
  const today = new Date().toISOString().slice(0, 10);
  const todayEv = (events ?? []).filter((e) => String(e.ts).startsWith(today));
  const stat = {
    turns: todayEv.filter((e) => e.type === 'turn' && e.ok !== false).length,
    approvals: todayEv.filter((e) => e.type === 'approval' && e.status === 'pending').length,
    learned: todayEv.filter((e) => e.type === 'memory' && e.ok !== false).reduce((n, e) => n + (e.notes?.length ?? 0), 0),
    errors: todayEv.filter(isError).length,
  };
  const byCrew = agents.map((a) => ({ ...a, count: todayEv.filter((e) => e.type === 'turn' && e.slug === a.slug).length }));
  const maxCount = Math.max(1, ...byCrew.map((c) => c.count));

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span className="microlabel">Activity · 회사 활동</span>
        <span className="microlabel">{new Date().toISOString().slice(0, 10)}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 316px', gap: 14, alignItems: 'start' }}>
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="card-head">
            <span className="microlabel">Timeline</span>
            <span className="rule" />
            <div style={{ display: 'flex', gap: 6 }}>
              {FILTERS.map(([k, label]) => (
                <button key={k} className="chip" onClick={() => setFilter(k)}
                  style={filter === k ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)', cursor: 'pointer' } : { cursor: 'pointer' }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {events === null ? <Skeleton h={300} /> : list.length === 0 ? (
            <div className="empty">
              {filter === 'error' ? '오류가 없습니다 — 순항 중입니다.' : '해당하는 활동이 없습니다.'}
            </div>
          ) : (
            <div style={{ display: 'grid', marginTop: 8 }}>
              {list.map(({ e, r }, i) => (
                <div key={i} className="row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 8px' }}>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', width: 62, flex: 'none' }}>{timeAgo(new Date(e.ts).getTime())}</span>
                  <Avatar name={r.avatar} size={24} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.who}</span>
                    <span style={{ fontSize: 11.5, color: r.danger ? 'var(--danger)' : 'var(--fg-2)', marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.desc}
                    </span>
                  </div>
                  {r.href && (
                    <a href={r.href} className="mono" style={{ fontSize: 10.5, color: 'var(--fg-2)', textDecoration: 'underline', textUnderlineOffset: 3, flex: 'none' }}>
                      {r.linkLabel} ↗
                    </a>
                  )}
                  <span className="chip" style={{ flex: 'none', ...(r.danger ? { color: 'var(--danger)', borderColor: 'var(--danger)' } : {}) }}>{r.chip}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', width: 38, textAlign: 'right', flex: 'none' }}>
                    {r.ms != null ? `${(r.ms / 1000).toFixed(0)}s` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gap: 14 }}>
          <div className="card" style={{ padding: '16px 18px' }}>
            <div className="card-head">
              <span className="microlabel">Today</span>
              <span className="rule" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
              {[['처리한 턴', stat.turns], ['배운 주제', stat.learned], ['결재 요청', stat.approvals], ['오류', stat.errors]].map(([k, v]) => (
                <div key={k}>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 600, color: k === '오류' && v > 0 ? 'var(--danger)' : 'var(--fg)' }}>{v}</div>
                  <div className="microlabel" style={{ marginTop: 2 }}>{k}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: '16px 18px' }}>
            <div className="card-head">
              <span className="microlabel">Today by Crew</span>
              <span className="rule" />
            </div>
            <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
              {byCrew.map((c) => (
                <div key={c.slug}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5 }}>
                    <span style={{ fontWeight: 600 }}>{c.name}</span>
                    <span className="mono" style={{ color: 'var(--fg-2)' }}>{c.count}턴</span>
                  </div>
                  <div className="meter"><div className="meter-track"><div className="meter-fill" style={{ width: `${(c.count / maxCount) * 100}%` }} /></div></div>
                </div>
              ))}
              {!byCrew.length && <Skeleton h={80} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
