'use client';
// 활동 — "내가 없는 동안 무슨 일이, 무엇을 남겼나". 리서치 원칙: 검증 비용을 줄이는 화면.
// 기본 뷰는 판단이 필요한 것(결재·오류)과 상태 변경(기억·크루·연결)만, 정상 턴은 '전체'로 접는다.
import { use, useEffect, useMemo, useState } from 'react';
import { Avatar, Skeleton, Spinner, api, timeAgo } from '../../../ui';
import { useLang, stageLabel } from '../../../i18n';

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
  const { t, lang } = useLang();
  const SOURCE = { deck: t('activity.source.deck'), messenger: t('activity.source.messenger'), routine: t('activity.source.routine'), delegate: t('activity.source.delegate'), trial: t('activity.source.trial'), room: t('activity.source.room') };
  // 필터 정의 — '주요'가 opinionated default (정상 대화 턴 제외)
  const FILTERS = [
    ['main', t('activity.filter.main')],
    ['approval', t('activity.filter.approval')],
    ['memory', t('activity.filter.memory')],
    ['error', t('activity.filter.error')],
    ['all', t('activity.filter.all')],
  ];
  const [events, setEvents] = useState(null);
  const [agents, setAgents] = useState([]);
  const [filter, setFilter] = useState('main');
  const [q, setQ] = useState('');
  // 실행 이력 드릴다운 — 펼친 행 인덱스 / 재실행 중 표시 / 재실행 시작 안내
  const [open, setOpen] = useState(-1);
  const [rerunning, setRerunning] = useState(-1);
  const [rerunNote, setRerunNote] = useState(-1);

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

  const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? (slug || t('activity.company'));

  // 재실행 — 같은 크루에게 원 지시를 다시 보낸다(실패 지점 재실행). 완료를 기다리지 않는다.
  async function rerun(i, e) {
    if (rerunning >= 0) return;
    setRerunning(i); setRerunNote(-1);
    try {
      // 결과는 크루 스레드에 쌓인다 — 활동 화면은 시작만 확인하고 손을 뗀다
      fetch(`/api/companies/${ws}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: e.slug, message: e.msg }),
      }).then(() => window.dispatchEvent(new Event('argo:refresh'))).catch(() => {});
      await new Promise((r) => setTimeout(r, 600)); // 시작 체감 — 버튼이 즉시 되돌아오지 않게
      setRerunNote(i);
    } finally {
      setRerunning(-1);
    }
  }

  // 이벤트 → 화면 행 (제목·설명·산출물 링크·칩)
  const row = (e) => {
    if (e.type === 'turn') {
      return {
        who: e.source === 'delegate' && e.from ? `${nameOf(e.from)} → ${nameOf(e.slug)}` : nameOf(e.slug),
        avatar: nameOf(e.slug),
        desc: isError(e) ? e.error : (e.gist || t('activity.instructionDone')),
        chip: isError(e) ? t('activity.error') : (SOURCE[e.source] ?? t('activity.conversation')),
        danger: isError(e),
        href: e.journalRel ? `/c/${ws}/vault?doc=${encodeURIComponent(e.journalRel)}` : null,
        linkLabel: t('deck.log'),
        ms: e.ms,
      };
    }
    if (e.type === 'memory') {
      const verb = { edit: t('activity.editByOwner'), delete: t('activity.op.delete') }[e.op] ?? t('activity.op.update');
      return {
        who: e.op ? t('activity.memory') : t('activity.memoryConsolidate'), avatar: t('activity.memory').slice(0, 1),
        desc: isError(e) ? e.error : (e.notes?.length ? t('activity.topicNoteVerb', { verb, notes: e.notes.join(', ') }) : t('activity.topicNoteVerbOnly', { verb })),
        chip: isError(e) ? t('activity.error') : t('activity.learned'), danger: isError(e),
        href: e.op === 'delete' ? null : `/c/${ws}/vault`, linkLabel: t('activity.memory'),
      };
    }
    if (e.type === 'approval') {
      const st = { pending: t('activity.approvalStatus.pending'), approved: t('activity.approvalStatus.approved'), rejected: t('activity.approvalStatus.rejected') }[e.status] ?? e.status;
      return {
        who: nameOf(e.slug), avatar: nameOf(e.slug), desc: e.action,
        chip: t('activity.approvalPrefix', { status: st }), danger: false,
        href: e.status === 'pending' ? `/c/${ws}` : `/c/${ws}/crew/${e.slug}`,
        linkLabel: e.status === 'pending' ? t('activity.approvalsLink') : t('activity.chatLink'),
      };
    }
    if (e.type === 'crew') {
      const op = { hire: t('activity.crewOp.hire'), fire: t('activity.crewOp.fire'), update: t('activity.crewOp.update'), team: t('activity.crewOp.team') }[e.op] ?? e.op;
      return { who: e.name || nameOf(e.slug), avatar: e.name || nameOf(e.slug), desc: op, chip: t('activity.crew'), href: e.slug ? `/c/${ws}/crew/${e.slug}` : null, linkLabel: t('activity.card') };
    }
    if (e.type === 'gateway') {
      return { who: e.kind === 'telegram' ? t('activity.telegram') : t('activity.slack'), avatar: t('activity.connected').slice(0, 1), desc: t('activity.gatewayPaired'), chip: t('activity.connected'), href: `/c/${ws}/settings`, linkLabel: t('activity.settings') };
    }
    return { who: e.type, avatar: '?', desc: '', chip: e.type };
  };

  const list = useMemo(() => (events ?? [])
    .filter((e) => inFilter(e, filter))
    .map((e) => ({ e, r: row(e) }))
    .filter(({ r }) => !q || `${r.who} ${r.desc} ${r.chip}`.toLowerCase().includes(q)),
  [events, filter, q, agents, lang]); // lang — 언어 토글 시 행 라벨(row가 t() 사용) 재계산

  // 우측 레일 — 오늘 요약 + 크루별 처리량
  // '오늘' 경계는 로컬(KST 등) 기준 — UTC로 자르면 KST 오전엔 오늘 한 일이 0으로 보였다.
  // sv-SE 로케일은 로컬 시간대의 YYYY-MM-DD를 낸다(일지·room·settings가 이미 쓰는 방식).
  const localDay = (d) => new Date(d).toLocaleDateString('sv-SE');
  const today = localDay(Date.now());
  const todayEv = (events ?? []).filter((e) => localDay(e.ts) === today);
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
        <span className="microlabel">{t('activity.header')}</span>
        <span className="microlabel">{new Date().toLocaleDateString('sv-SE')}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 316px', gap: 14, alignItems: 'start' }}>
        <div className="card" style={{ padding: '16px 18px' }}>
          <div className="card-head">
            <span className="microlabel">{t('activity.timeline')}</span>
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
              {filter === 'error' ? t('activity.noError') : t('activity.noMatch')}
            </div>
          ) : (
            <div /* 템플릿 없는 grid는 트랙이 max-content로 자라 nowrap 텍스트가 카드를 뚫는다 — minmax(0,1fr) 고정 */
              style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', marginTop: 8 }}>
              {list.map(({ e, r }, i) => {
                const expandable = e.type === 'turn' && (e.msg || e.steps?.length); // 실행 이력 드릴다운 대상
                return (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}>
                <div className="row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 8px', cursor: expandable ? 'pointer' : 'default' }}
                  onClick={() => expandable && setOpen((o) => (o === i ? -1 : i))}>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', width: 62, flex: 'none' }}>{timeAgo(new Date(e.ts).getTime(), lang)}</span>
                  <Avatar name={r.avatar} size={24} />
                  {/* 클리핑은 블록 컨테이너에 — 인라인 span은 overflow를 자르지 못해 긴 오류문이 레이아웃을 뚫는다 */}
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.desc}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.who}</span>
                    <span style={{ fontSize: 11.5, color: r.danger ? 'var(--danger)' : 'var(--fg-2)', marginLeft: 8 }}>
                      {r.desc}
                    </span>
                  </div>
                  {r.href && (
                    <a href={r.href} className="mono" onClick={(ev) => ev.stopPropagation()} style={{ fontSize: 10.5, color: 'var(--fg-2)', textDecoration: 'underline', textUnderlineOffset: 3, flex: 'none' }}>
                      {t('activity.linkArrow', { label: r.linkLabel })}
                    </a>
                  )}
                  <span className="chip" style={{ flex: 'none', ...(r.danger ? { color: 'var(--danger)', borderColor: 'var(--danger)' } : {}) }}>{r.chip}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', width: 38, textAlign: 'right', flex: 'none' }}>
                    {r.ms != null ? `${(r.ms / 1000).toFixed(0)}s` : ''}
                  </span>
                </div>
                {open === i && expandable && (
                  <div className="fade-up" style={{ margin: '0 8px 10px 74px', padding: '11px 14px', borderRadius: 10, background: 'var(--card-2)', display: 'grid', gap: 9, fontSize: 12 }}>
                    {e.msg && (
                      <div style={{ minWidth: 0 }}>
                        <span className="microlabel">{t('activity.instruction')}</span>
                        <p style={{ margin: '3px 0 0', color: 'var(--fg-2)', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{e.msg}</p>
                      </div>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <span className="microlabel">{t('activity.steps')}</span>
                      {e.steps?.length ? (
                        <div style={{ display: 'grid', gap: 3, marginTop: 4 }}>
                          {e.steps.map((s, j) => (
                            <div key={j} className="mono" style={{ fontSize: 11, color: 'var(--fg-2)', display: 'flex', gap: 10, minWidth: 0 }}>
                              <span style={{ color: 'var(--fg-3)', width: 42, flex: 'none', textAlign: 'right' }}>+{(s.t / 1000).toFixed(0)}s</span>
                              <span style={{ flex: 'none' }}>{stageLabel(t, s.stage, s.detail)}</span>
                              {s.detail && <span style={{ color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.detail}</span>}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p style={{ margin: '3px 0 0', color: 'var(--fg-3)' }}>{t('activity.noSteps')}</p>
                      )}
                    </div>
                    {e.msg && e.source !== 'delegate' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <button className="btn sm" disabled={rerunning >= 0} onClick={() => rerun(i, e)}>
                          {rerunning === i ? <Spinner size={11} /> : t('activity.rerun')}
                        </button>
                        {rerunNote === i && (
                          <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
                            {t('activity.rerunStarted')} <a href={`/c/${ws}/crew/${e.slug}`} style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}>{t('activity.chatLink')} ↗</a>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
                </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gap: 14 }}>
          <div className="card" style={{ padding: '16px 18px' }}>
            <div className="card-head">
              <span className="microlabel">{t('activity.today')}</span>
              <span className="rule" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
              {[
                [t('activity.turnsProcessed'), stat.turns, false],
                [t('activity.topicsLearned'), stat.learned, false],
                [t('activity.approvalRequests'), stat.approvals, false],
                [t('activity.errors'), stat.errors, true],
              ].map(([k, v, errKey]) => (
                <div key={k}>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 600, color: errKey && v > 0 ? 'var(--danger)' : 'var(--fg)' }}>{v}</div>
                  <div className="microlabel" style={{ marginTop: 2 }}>{k}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: '16px 18px' }}>
            <div className="card-head">
              <span className="microlabel">{t('activity.todayByCrew')}</span>
              <span className="rule" />
            </div>
            <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
              {byCrew.map((c) => (
                <div key={c.slug}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5 }}>
                    <span style={{ fontWeight: 600 }}>{c.name}</span>
                    <span className="mono" style={{ color: 'var(--fg-2)' }}>{t('activity.turnsCount', { n: c.count })}</span>
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
