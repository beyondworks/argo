'use client';
// 활동 — 내가 없는 동안 회사가 무슨 일을 했나. 모든 턴·위임·결재가 한 줄씩.
import { use, useEffect, useState } from 'react';
import { Avatar, Skeleton, api, timeAgo } from '../../../ui';

const KIND = {
  chat: { label: '대화', desc: '데크에서 지시' },
  messenger: { label: '메신저', desc: '텔레그램·슬랙에서 지시' },
  routine: { label: '루틴', desc: '예약 자동 실행' },
  delegate: { label: '위임', desc: '동료에게 받은 하위 작업' },
  hire: { label: '영입', desc: '페르소나 카드 생성' },
  consolidate: { label: '기억 정리', desc: '일지를 주제 노트로 정제' },
  approval: { label: '결재', desc: '' },
};
const AP_STATUS = { pending: '요청', approved: '승인', rejected: '거절' };

export default function Activity({ params }) {
  const { ws } = use(params);
  const [events, setEvents] = useState(null);
  const [agents, setAgents] = useState([]);
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

  const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? slug;
  const list = (events ?? []).filter((e) => !q || `${nameOf(e.slug)} ${KIND[e.kind]?.label ?? ''} ${e.action ?? ''}`.toLowerCase().includes(q));

  // 크루별 오늘 처리량 — 상단 요약
  const today = new Date().toISOString().slice(0, 10);
  const todayTurns = (events ?? []).filter((e) => e.kind !== 'approval' && String(e.ts).startsWith(today));
  const byCrew = agents.map((a) => ({ ...a, count: todayTurns.filter((e) => e.slug === a.slug).length }));
  const maxCount = Math.max(1, ...byCrew.map((c) => c.count));

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span className="microlabel">Activity · 회사 활동</span>
        <span className="microlabel">오늘 {todayTurns.length}턴</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 316px', gap: 14, alignItems: 'start' }}>
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="card-head">
            <span className="microlabel">Timeline</span>
            <span className="rule" />
            <span className="chip">최근 {list.length}건</span>
          </div>
          {events === null ? <Skeleton h={300} /> : list.length === 0 ? (
            <div className="empty">아직 활동이 없습니다 — 크루에게 첫 지시를 내려보세요.</div>
          ) : (
            <div style={{ display: 'grid', marginTop: 8 }}>
              {list.map((e, i) => (
                <div key={i} className="row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 8px' }}>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', width: 64, flex: 'none' }}>{timeAgo(new Date(e.ts).getTime())}</span>
                  <Avatar name={nameOf(e.slug)} size={24} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {e.kind === 'delegate' ? `${nameOf(e.from)} → ${nameOf(e.slug)}` : nameOf(e.slug)}
                    </span>
                    <span style={{ fontSize: 11.5, color: 'var(--fg-2)', marginLeft: 8 }}>
                      {e.kind === 'approval' ? `${e.action}` : KIND[e.kind]?.desc ?? ''}
                    </span>
                  </div>
                  <span className="chip" style={{ flex: 'none' }}>
                    {KIND[e.kind]?.label ?? e.kind}{e.kind === 'approval' ? ` ${AP_STATUS[e.status] ?? ''}` : ''}
                  </span>
                  {e.ms != null && <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', width: 44, textAlign: 'right', flex: 'none' }}>{(e.ms / 1000).toFixed(0)}s</span>}
                </div>
              ))}
            </div>
          )}
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
  );
}
