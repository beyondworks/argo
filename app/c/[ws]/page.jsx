'use client';
// 데크 — 아르고호 계기판. 좌: 본 계기(메트릭·영입·기억·차트), 우: 보조 계기 레일(기억 그래프·명판·토큰).
import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Avatar, Icon, Bars, Dial, Num, Spinner, Skeleton, useScrollLock, InputModal, api, imeGuard, timeAgo, tsFromRel } from '../../ui';
import { Graph2D } from './graph2d'; // 데크 별자리도 기억 페이지와 같은 2D 그래프(유건 지시 2026-08-21: 옛 3D 잔존 지적)
import { anyRunnerUsable, runnerNeedsReconnect, usableRunnerNames } from '../../runner-connect';
import { useLang } from '../../i18n';
import { useTasks } from './tasks-context';

export default function Deck({ params }) {
  const { ws } = use(params);
  const { t, lang } = useLang();
  // 작성 중 크루 수 — 셸이 폴링하는 /tasks running(사이드바 링·작업 독 배지와 같은 목록). 데크는 따로 폴링하지 않는다.
  const running = (useTasks()?.running ?? []).length;
  const HIRE_STAGES = [t('deck.hireStage1'), t('deck.hireStage2'), t('deck.hireStage3')];
  const router = useRouter();
  const [data, setData] = useState(null);
  const [docs, setDocs] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [hireName, setHireName] = useState('');
  const [hireTeam, setHireTeam] = useState('');
  const [hireOpts, setHireOpts] = useState(false);
  const [hiring, setHiring] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const hireRef = useRef(null); // 사이드바 '크루 추가'가 포커스+깜빡 대상으로 삼는 입력창



  function load() {
    api(`/api/companies/${ws}`).then(setData).catch((e) => setError(String(e.message)));
    api(`/api/companies/${ws}/vault`).then((d) => setDocs(d.docs)).catch(() => setDocs([]));
  }
  useEffect(load, [ws]);

  useEffect(() => {
    const h = (e) => setQ(String(e.detail || '').toLowerCase());
    window.addEventListener('argo:search', h);
    window.addEventListener('argo:refresh', load);
    return () => {
      window.removeEventListener('argo:search', h);
      window.removeEventListener('argo:refresh', load);
    };
  }, [ws]);

  useEffect(() => {
    if (!hiring) return;
    const t = setInterval(() => setStage((s) => Math.min(s + 1, HIRE_STAGES.length - 1)), 9000);
    return () => clearInterval(t);
  }, [hiring]);

  // 사이드바 '크루 추가' → 이 입력창으로 스크롤·포커스 + 하이라이트 깜빡 (새로고침 대신).
  // 같은 페이지는 argo:hire 이벤트로, 다른 페이지에서 넘어온 경우는 sessionStorage 플래그로.
  useEffect(() => {
    const focusHire = () => {
      const el = hireRef.current;
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.querySelector('input')?.focus();
      el.classList.remove('blink-focus');
      void el.offsetWidth; // 리플로우로 애니메이션 재시작
      el.classList.add('blink-focus');
      clearTimeout(blinkT);
      blinkT = setTimeout(() => el.classList.remove('blink-focus'), 1600);
    };
    let pending, blinkT;
    try {
      if (sessionStorage.getItem('argo:hire')) { sessionStorage.removeItem('argo:hire'); pending = setTimeout(focusHire, 140); }
    } catch { /* 프라이빗 모드 */ }
    const onHire = () => { try { sessionStorage.removeItem('argo:hire'); } catch { /* noop */ } focusHire(); };
    window.addEventListener('argo:hire', onHire);
    return () => { window.removeEventListener('argo:hire', onHire); clearTimeout(pending); clearTimeout(blinkT); };
  }, []);

  async function hire(e) {
    e.preventDefault();
    if (!prompt.trim() || hiring) return;
    setHiring(true); setStage(0); setError('');
    try {
      await api(`/api/companies/${ws}/agents`, { prompt, name: hireName, team: hireTeam });
      setPrompt(''); setHireName(''); setHireOpts(false);
      load();
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (err) {
      setError(String(err.message));
    } finally {
      setHiring(false);
    }
  }

  const stats = data?.stats;
  const agents = (data?.agents ?? []).filter(
    (a) => !q || `${a.name} ${a.role} ${a.expertise.join(' ')}`.toLowerCase().includes(q)
  );
  const memories = (data?.memories ?? []).filter((m) => !q || m.title.toLowerCase().includes(q));
  const lastTs = data?.memories?.[0] ? (tsFromRel(data.memories[0].rel) ?? data.memories[0].mtime) : null;
  // 연결 밀도 — 기억 대비 자동 링크 쌍 비율 (기억이 얼마나 서로 엮여 있나)
  const density = stats && data.memoryCount > 1
    ? Math.min((stats.links / (data.memoryCount - 1)) * 100, 100)
    : 0;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="page-head" style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span className="microlabel">{t('deck.crewControl', { name: data?.company?.name ?? '' })}</span>
        <span className="microlabel">{new Date().toLocaleDateString('sv-SE')}</span>
      </div>

      <AiKeyBanner ws={ws} />

      <div className="deck-grid">
        {/* ── 본 계기 열 — 지표 4장·크루 영입이 맨 위(유건 2026-08-23), 그 아래 아침 조회·결재함·최근 기억 ── */}
        <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            {stats ? (
              <>
                <div className="metric card invert fade-up">
                  <div className="metric-top">
                    <span className="microlabel">{t('deck.memory')}</span>
                    <span className="chip">{t('deck.todayPlus', { n: stats.today })}</span>
                  </div>
                  <Num value={data.memoryCount} unit={t('common.count')} size={40} />
                  <div className="metric-sub">{t('deck.notesJournal', { notes: stats.notes, conv: stats.conversations })}</div>
                  <div className="metric-sub2">
                    {(() => { // 복리 신호 — 쓸수록 회사가 배우고 있다는 걸 보여준다
                      const week = Date.now() - 7 * 86400000;
                      const learned = (docs ?? []).filter((d) => d.dir === 'notes' && d.mtime > week).length;
                      return learned > 0 ? t('deck.learnedTopics', { n: learned }) : (lastTs ? t('deck.lastRecorded', { t: timeAgo(lastTs, lang) }) : t('deck.noRecordYet'));
                    })()}
                  </div>
                </div>
                <div className="metric card fade-up" style={{ animationDelay: '0.04s' }}>
                  <div className="metric-top">
                    <span className="microlabel">{t('deck.crew')}</span>
                    <span className="chip" style={running > 0 ? { borderColor: 'var(--accent)' } : undefined}><span className="dot" />{running > 0 ? t('deck.working') : t('deck.standby')}</span>
                  </div>
                  <Num value={data.agents.length} unit={t('common.people')} />
                  <div className="metric-sub">{running === 0 ? t('deck.allStandby') : (data.agents.length > 0 && running >= data.agents.length) ? t('deck.allWriting') : t('deck.someWriting', { n: running })}</div>
                  <div className="metric-sub2">{t('deck.hireByPrompt')}</div>
                </div>
                <div className="metric card fade-up" style={{ animationDelay: '0.08s', alignItems: 'center' }}>
                  <div className="metric-top" style={{ width: '100%' }}>
                    <span className="microlabel">{t('deck.linkDensity')}</span>
                    <span className="chip">{t('deck.linksPair', { n: stats.links })}</span>
                  </div>
                  <Dial value={density} label={t('deck.linked')} />
                </div>
                <div className="metric card fade-up" style={{ animationDelay: '0.12s' }}>
                  <div className="metric-top">
                    <span className="microlabel">{t('deck.composition')}</span>
                    <span className="chip">{t('deck.vault')}</span>
                  </div>
                  <div style={{ display: 'grid', gap: 12, marginTop: 6 }}>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5 }}>
                        <span style={{ fontWeight: 600 }}>{t('deck.conversations')}</span>
                        <span className="mono" style={{ color: 'var(--fg-2)' }}>{stats.conversations}</span>
                      </div>
                      <div className="meter"><div className="meter-track"><div className="meter-fill" style={{ width: `${data.memoryCount ? (stats.conversations / data.memoryCount) * 100 : 0}%` }} /></div></div>
                    </div>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5 }}>
                        <span style={{ fontWeight: 600 }}>{t('deck.notes')}</span>
                        <span className="mono" style={{ color: 'var(--fg-2)' }}>{stats.notes}</span>
                      </div>
                      <div className="meter"><div className="meter-track"><div className="meter-fill" style={{ width: `${data.memoryCount ? (stats.notes / data.memoryCount) * 100 : 0}%` }} /></div></div>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              [0, 1, 2, 3].map((i) => <Skeleton key={i} h={150} style={{ borderRadius: 18 }} />)
            )}
          </div>

          <form ref={hireRef} onSubmit={hire} className="input-bar">
            <span style={{ color: 'var(--fg-3)', display: 'inline-flex' }}><Icon name="bolt" size={15} /></span>
            <input suppressHydrationWarning
              placeholder={t('deck.hirePlaceholder')}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={hiring}
              {...imeGuard}
            />
            {!hiring && <span className="kbd">↵</span>}
            <button type="button" className="btn sm" onClick={() => setHireOpts((v) => !v)} disabled={hiring}>
              {t('deck.options')} {hireOpts ? '▴' : '▾'}
            </button>
            <button className="btn btn-primary" disabled={hiring || !prompt.trim()}>
              {hiring ? <Spinner /> : <Icon name="plus" size={14} />}
              {t('deck.hireBtn')}
            </button>
          </form>
          {/* 페르소나 예시 — "뭐라고 써야 하지?"의 빈 화면을 없앤다(사용자 피드백 2026-07-25: 유튜브
              설명처럼 예제가 있으면 초보자가 쓰기 편하다). 클릭하면 입력창에 채워지고 바로 수정 가능. */}
          {!hiring && !prompt.trim() && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '0 4px' }}>
              <span className="microlabel" style={{ flex: 'none' }}>{t('deck.hireExamples')}</span>
              {[t('deck.hireEx1'), t('deck.hireEx2'), t('deck.hireEx3')].map((ex) => (
                <button key={ex} type="button" className="chip" style={{ cursor: 'pointer' }}
                  onClick={() => { setPrompt(ex); hireRef.current?.querySelector('input')?.focus(); }}>
                  {ex}
                </button>
              ))}
            </div>
          )}
          {hireOpts && (
            <div className="card fade-up" style={{ padding: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="microlabel">{t('deck.optionsLabel')}</span>
              <input suppressHydrationWarning
                placeholder={t('deck.namePlaceholder')}
                value={hireName}
                onChange={(e) => setHireName(e.target.value)}
                {...imeGuard}
                style={{ flex: 1, minWidth: 150, height: 32, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13 }}
              />
              <input suppressHydrationWarning
                placeholder={t('deck.teamPlaceholder')}
                value={hireTeam}
                onChange={(e) => setHireTeam(e.target.value)}
                list="argo-teams"
                {...imeGuard}
                style={{ flex: 1, minWidth: 130, height: 32, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13 }}
              />
              <datalist id="argo-teams">
                {[...new Set((data?.agents ?? []).map((a) => a.team).filter(Boolean))].map((tm) => <option key={tm} value={tm} />)}
              </datalist>
            </div>
          )}
          {hiring && <p style={{ fontSize: 12.5, color: 'var(--fg-2)', fontWeight: 600, padding: '0 4px' }}>{t('deck.hiringStage', { stage: HIRE_STAGES[stage] })}</p>}
          {error && <p style={{ fontSize: 13, color: 'var(--danger)', padding: '0 4px' }}>{error}</p>}

          {/* 크루 목록은 사이드바가 단일 진실(영입 즉시 거기 생긴다) — 데크엔 빈 상태 안내만 남긴다 */}
          {data && agents.length === 0 && (
            <p style={{ color: 'var(--fg-2)', fontSize: 13, padding: '0 4px' }}>{q ? t('deck.noCrewMatch') : t('deck.noCrewYet')}</p>
          )}

          <MorningBrief ws={ws} agents={data?.agents ?? []} />
          <ApprovalsCard ws={ws} agents={data?.agents ?? []} />

          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-head">
              <span className="card-title"><Icon name="doc" size={14} />{t('deck.recentMemory')}</span>
              <span className="rule" />
              <Link href={`/c/${ws}/vault`} className="btn sm">{t('deck.allMemory')}</Link>
            </div>
            {data === null ? (
              <div style={{ padding: '0 18px 18px' }}><Skeleton h={90} /></div>
            ) : memories.length === 0 ? (
              <p style={{ padding: '2px 20px 18px', color: 'var(--fg-2)', fontSize: 13 }}>
                {q ? t('deck.noMemoryMatch') : t('deck.noMemoryYet')}
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>{t('deck.colTitle')}</th><th style={{ width: 100 }}>{t('deck.colType')}</th><th style={{ width: 76 }}>{t('deck.colLinks')}</th><th style={{ width: 92 }}>{t('deck.colTime')}</th></tr>
                </thead>
                <tbody>
                  {memories.map((m) => (
                    <tr key={m.rel} onClick={() => router.push(`/c/${ws}/vault?doc=${encodeURIComponent(m.rel)}`)}>
                      <td style={{ fontWeight: 600, maxWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{m.title}</td>
                      <td><span className="pill"><span className="dot" />{m.dir === 'notes' ? t('deck.typeNote') : t('deck.typeConversation')}</span></td>
                      <td className="mono" style={{ fontSize: 12 }}>{m.links.length > 0 ? m.links.length : '—'}</td>
                      <td className="mono" style={{ color: 'var(--fg-3)', fontSize: 11.5 }}>{timeAgo(tsFromRel(m.rel) ?? m.mtime, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <div className="card-head" style={{ alignItems: 'flex-start' }}>
              <div>
                <span className="card-title">{t('deck.dailyMemory')}</span>
                <div className="microlabel" style={{ marginTop: 3 }}>{t('deck.last14days')}</div>
              </div>
              {stats && (
                <div style={{ display: 'flex', gap: 24, textAlign: 'right' }}>
                  <div>
                    <div className="microlabel">{t('deck.total')}</div>
                    <div className="num" style={{ fontSize: 19 }}>{data.memoryCount}</div>
                  </div>
                  <div>
                    <div className="microlabel">{t('deck.links')}</div>
                    <div className="num" style={{ fontSize: 19 }}>{stats.links}</div>
                  </div>
                </div>
              )}
            </div>
            <div style={{ padding: '6px 20px 16px' }}>
              {stats ? <Bars data={stats.daily} /> : <Skeleton h={100} />}
            </div>
          </div>
        </div>

        {/* ── 우측 보조 계기 레일 ── */}
        <div style={{ display: 'grid', gap: 14 }}>
          <div className="card" style={{ padding: '15px 18px 8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="card-title">{t('deck.constellation')}</span>
              {/* 크게 보기 = 기억 페이지의 그래프 탭(같은 렌더러·같은 인터랙션) — 별도 모달 유지 안 함 */}
              <button className="chip" onClick={() => router.push(`/c/${ws}/vault`)} style={{ cursor: 'pointer' }}>{t('deck.viewLarge')}</button>
            </div>
            {docs === null || data === null ? (
              <Skeleton h={200} style={{ margin: '8px 0' }} />
            ) : (
              <div style={{ height: 220, margin: '4px -6px 0' }}>
                <Graph2D docs={docs} agents={data.agents} compact onSelectDoc={(rel) => router.push(`/c/${ws}/vault?doc=${encodeURIComponent(rel)}`)} />
              </div>
            )}
            <p className="microlabel" style={{ textAlign: 'center', padding: '2px 0 6px' }}>
              {docs && data
                ? t('deck.nodesMemories', { nodes: 1 + new Set(data.agents.map((a) => a.team).filter(Boolean)).size + data.agents.length + docs.length, mem: docs.length })
                : ''}
            </p>
          </div>
          <Nameplate company={data?.company} memoryCount={data?.memoryCount} links={stats?.links} crew={data?.agents?.length} />
          <TokenPanel usage={data?.usage} budgetUsd={data?.company?.budgetUsd} payroll={data?.payroll} agents={data?.agents ?? []} />
        </div>
      </div>

    </div>
  );
}

/** AI 러너 배너 — 쓸 수 있는 러너가 하나도 없으면(첫 실행·재로그인·연결 끊김) 데크 상단에 안내.
    Claude만 보던 옛 판정은 Codex 등 다른 러너 연결자에게 오경보를 냈다(실사용 신고) — 러너 전체 판정으로 교체.
    클릭 시 설정의 러너 연결 섹션으로 직행(?ai=1 딥링크), 연결 직후 argo:refresh로 자동 소거. */
function AiKeyBanner({ ws }) {
  const { t } = useLang();
  const router = useRouter();
  const [state, setState] = useState(null); // null(양호·로딩) | 'missing' | 'invalid'(끊김 — 재연결)
  useEffect(() => {
    let alive = true;
    const check = () => api(`/api/companies/${ws}/keys`).then((k) => {
      if (!alive) return;
      if (anyRunnerUsable(k.runners)) setState(null);
      else setState(runnerNeedsReconnect(k.runners) ? 'invalid' : 'missing');
    }).catch(() => { /* 상태 확인 실패 — 오경보 대신 침묵 */ });
    check();
    window.addEventListener('argo:refresh', check);
    return () => { alive = false; window.removeEventListener('argo:refresh', check); };
  }, [ws]);
  if (!state) return null;
  // 테두리·아이콘 = 테마 액센트 — 경고색 고정 링이 테마와 무관하게 튀던 것 교정(유건 지시 2026-07-19)
  return (
    <div className="card fade-up" style={{ padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderColor: 'var(--accent)' }}>
      <span style={{ color: 'var(--accent)', display: 'inline-flex' }}><Icon name="bolt" size={15} /></span>
      <span style={{ fontSize: 13, flex: 1, minWidth: 200 }}>{t(state === 'invalid' ? 'deck.runner.reconnect' : 'deck.runner.banner')}</span>
      <button className="btn btn-primary sm" style={{ flex: 'none' }} onClick={() => router.push(`/c/${ws}/settings?ai=1`)}>
        {t('deck.aiKey.cta')}
      </button>
    </div>
  );
}

/** 결재함 — 크루가 올린 대기 결재. 승인/거절 즉시 반영, 실행 결과는 해당 크루 대화에 쌓인다. */
function ApprovalsCard({ ws, agents }) {
  const { t } = useLang();
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState('');

  function load() {
    api(`/api/companies/${ws}/approvals`).then((d) => setItems(d.approvals)).catch(() => setItems([]));
  }
  useEffect(load, [ws]);
  useEffect(() => {
    window.addEventListener('argo:refresh', load);
    const t = setInterval(load, 20000); // 크루 턴 중에 올라오는 결재를 놓치지 않게 저속 폴
    return () => { window.removeEventListener('argo:refresh', load); clearInterval(t); };
  }, [ws]);

  const pending = (items ?? []).filter((a) => a.status === 'pending');
  if (!pending.length) return null;
  const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? slug;

  async function resolve(id, approve) {
    setBusy(id);
    try {
      await api(`/api/companies/${ws}/approvals`, { id, approve });
      load();
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="card fade-up" style={{ padding: '16px 18px' }}>
      <div className="card-head">
        <span className="microlabel">{t('deck.approvalsTitle')}</span>
        <span className="rule" />
        <span className="chip"><span className="dot" />{t('deck.pending', { n: pending.length })}</span>
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
        {pending.map((a) => (
          <div key={a.id} className="row" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Avatar name={nameOf(a.slug)} size={26} />
            <Link href={`/c/${ws}/crew/${a.slug}`} title={t('deck.approvalOpen')}
              style={{ flex: 1, minWidth: 0, color: 'inherit', textDecoration: 'none' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{a.action}</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-2)', marginTop: 2 }}>
                {nameOf(a.slug)}{a.from ? ` (${t('deck.approvalFrom', { name: nameOf(a.from) })})` : ''} · {a.reason}
              </div>
            </Link>
            {busy === a.id ? <Spinner /> : (
              <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
                <button className="btn sm btn-primary" onClick={() => resolve(a.id, true)}>{t('deck.approve')}</button>
                <button className="btn sm" onClick={() => resolve(a.id, false)}>{t('deck.reject')}</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}



const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : String(n));

/** 토큰 계기 — 입력/출력·캐시 적중률·턴당 비용.
    팩트: 에이전트 작업은 입력(맥락)≫출력이 정상. 효율 = ①캐시 적중률(캐시 읽기는 정가의 ~1/10) ②턴당 비용. */
/** 아침 조회 — 출근하면 책상 위 보고서. 최근 16시간의 일과 결재 대기를 한 장으로(모델 호출 없음). */
function MorningBrief({ ws, agents }) {
  const { t, lang } = useLang();
  const [ev, setEv] = useState(null);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    api(`/api/companies/${ws}/activity`).then((d) => setEv(d.events ?? [])).catch(() => setEv([]));
    api(`/api/companies/${ws}/approvals`).then((d) => setPending((d.approvals ?? []).filter((a) => (a.status ?? 'pending') === 'pending').length)).catch(() => {});
  }, [ws]);
  if (!ev) return null;
  const since = Date.now() - 16 * 3600_000;
  const recent = ev.filter((e) => new Date(e.ts).getTime() > since);
  const turns = recent.filter((e) => e.type === 'turn' && e.ok !== false);
  const errors = recent.filter((e) => e.ok === false);
  const learned = recent.filter((e) => e.type === 'memory' && e.ok !== false);
  if (!recent.length && !pending) return null; // 보고할 게 없으면 조용히 — 노이즈 금지
  const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? slug ?? '';
  return (
    <div className="card fade-up" style={{ padding: '14px 18px', display: 'grid', gap: 8 }}>
      <div className="card-head" style={{ padding: 0, border: 'none' }}>
        <span className="microlabel">{t('deck.brief.title')}</span>
        <span className="rule" />
        <span className="microlabel">{t('deck.brief.window')}</span>
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12.5 }}>
        <span><b className="mono">{turns.length}</b> {t('deck.brief.turns')}</span>
        <span><b className="mono">{learned.length}</b> {t('deck.brief.learned')}</span>
        <span style={errors.length ? { color: 'var(--danger)' } : { color: 'var(--fg-3)' }}><b className="mono">{errors.length}</b> {t('deck.brief.errors')}</span>
        <span style={pending ? { fontWeight: 650 } : { color: 'var(--fg-3)' }}><b className="mono">{pending}</b> {t('deck.brief.pending')}</span>
      </div>
      {turns.slice(0, 3).reverse().map((e, i) => (
        <div key={i} style={{ fontSize: 12, color: 'var(--fg-2)', display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', flex: 'none', width: 56 }}>{timeAgo(new Date(e.ts).getTime(), lang)}</span>
          <span style={{ fontWeight: 600, flex: 'none' }}>{nameOf(e.slug)}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.gist}</span>
        </div>
      ))}
    </div>
  );
}

function TokenPanel({ usage, budgetUsd, payroll, agents }) {
  const { t, fmtMoney } = useLang();
  if (!usage) return <Skeleton h={170} style={{ borderRadius: 18 }} />;
  const u = usage.today.turns > 0 ? usage.today : usage.total;
  const scope = usage.today.turns > 0 ? t('deck.scope.today') : t('deck.scope.total');
  if (usage.total.turns === 0) {
    return (
      <div className="card" style={{ padding: '15px 18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="card-title">{t('deck.token')}</span>
          <span className="microlabel">{t('deck.tokenUsage')}</span>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--fg-3)', marginTop: 8 }}>
          {t('deck.tokenPending')}
        </p>
      </div>
    );
  }
  const hit = Math.round(u.cacheHitRate * 100);
  return (
    <div className="card" style={{ padding: '15px 18px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span className="card-title">{t('deck.token')}</span>
        <span className="chip">{t('deck.turnsScope', { scope, n: u.turns })}</span>
      </div>

      {/* 입력(맥락) / 출력(생성) — 입력≫출력이 정상 형태 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <div className="microlabel">{t('deck.in')}</div>
          <div className="num" style={{ fontSize: 21 }}>{fmtTok(u.contextTotal)}</div>
        </div>
        <div>
          <div className="microlabel">{t('deck.out')}</div>
          <div className="num" style={{ fontSize: 21 }}>{fmtTok(u.output)}</div>
        </div>
      </div>

      {/* 월 예산 계기 — 상한 대비 지출 (오픈클로 "예측 불가 비용" 정반대편) */}
      {budgetUsd > 0 && usage.month?.hasCost && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5 }}>
            <span style={{ fontWeight: 600 }}>{t('deck.monthBudget')}</span>
            <span className="mono" style={{ color: usage.month.costUsd >= budgetUsd ? 'var(--danger)' : 'var(--fg-2)' }}>
              {fmtMoney(usage.month.costUsd, { approx: false })} / {fmtMoney(budgetUsd, { approx: false })}
            </span>
          </div>
          <div className="meter"><div className="meter-track"><div className="meter-fill" style={{ width: `${Math.min((usage.month.costUsd / budgetUsd) * 100, 100)}%` }} /></div></div>
          <div className="metric-sub2" style={{ marginTop: 4 }}>{t('deck.budgetStop')}</div>
        </div>
      )}

      {/* 급여 대장 — 이번 달 크루별 인건비. 비용을 회사 언어로 */}
      {payroll?.some((p) => p.hasCost) && (
        <div style={{ marginTop: 12, display: 'grid', gap: 7 }}>
          <span className="microlabel">{t('deck.payroll')}</span>
          {payroll.filter((p) => p.hasCost).slice(0, 5).map((p) => {
            const max = Math.max(...payroll.map((x) => x.costUsd), 0.0001);
            const crew = agents?.find((a) => a.slug === p.slug);
            return (
              <div key={p.slug}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 3 }}>
                  <span style={{ fontWeight: 600 }}>{crew?.name ?? p.slug}</span>
                  <span className="mono" style={{ color: 'var(--fg-2)' }}>{fmtMoney(p.costUsd, { approx: false })} · {t('deck.payrollTurns', { n: p.turns })}</span>
                </div>
                <div className="meter"><div className="meter-track"><div className="meter-fill" style={{ width: `${(p.costUsd / max) * 100}%` }} /></div></div>
              </div>
            );
          })}
        </div>
      )}

      {/* 효율 ① 캐시 적중률 */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5 }}>
          <span style={{ fontWeight: 600 }}>{t('deck.cacheHitRate')}</span>
          <span className="mono" style={{ color: 'var(--fg-2)' }}>{hit}%</span>
        </div>
        <div className="meter"><div className="meter-track"><div className="meter-fill" style={{ width: `${hit}%` }} /></div></div>
        <div className="metric-sub2" style={{ marginTop: 4 }}>{t('deck.cacheHint')}</div>
      </div>

      {/* 효율 ② + 형태 지표 */}
      <div style={{ display: 'grid', gap: 5, marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, borderBottom: '1px dashed var(--border-soft)', paddingBottom: 5 }}>
          <span className="microlabel">{t('deck.costPerTurn')}</span>
          <span className="mono" style={{ fontSize: 11 }}>
            {u.costPerTurn != null ? fmtMoney(u.costPerTurn, { approx: false }) : '—'}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, borderBottom: '1px dashed var(--border-soft)', paddingBottom: 5 }}>
          <span className="microlabel">{t('deck.contextPerOutput')}</span>
          <span className="mono" style={{ fontSize: 11 }}>{u.inPerOut.toFixed(0)} : 1</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <span className="microlabel">{t('deck.cumulative')}</span>
          <span className="mono" style={{ fontSize: 11 }}>
            {fmtTok(usage.total.contextTotal)} in · {fmtTok(usage.total.output)} out
            {usage.total.hasCost ? ` · ${fmtMoney(usage.total.costUsd, { approx: false })}` : ''}
          </span>
        </div>
      </div>
      <div className="metric-sub2" style={{ marginTop: 8 }}>
        {t('deck.shapeHint')}
      </div>
    </div>
  );
}

/** 명판 — 선박 제원판. 회사의 스펙을 계기판 명판처럼. */
function Nameplate({ company, memoryCount, links, crew }) {
  const { t } = useLang();
  // 엔진 = 실제 연결된 러너 이름 — 'Claude Agent SDK' 하드코딩은 Gemini만 연결한 사용자에게
  // "클로드로 도는 건가" 혼란을 줬다(실사용 신고 2026-07-20). 연결 직후 argo:refresh로 즉시 갱신.
  const [engines, setEngines] = useState(null); // null = 로딩
  const wsId = company?.id;
  useEffect(() => {
    if (!wsId) return;
    let alive = true;
    const pull = () => api(`/api/companies/${wsId}/keys`)
      .then((k) => { if (alive) setEngines(usableRunnerNames(k.runners)); })
      .catch(() => {});
    pull();
    window.addEventListener('argo:refresh', pull);
    return () => { alive = false; window.removeEventListener('argo:refresh', pull); };
  }, [wsId]);
  if (!company) return <Skeleton h={150} style={{ borderRadius: 18 }} />;
  const rows = [
    [t('deck.nameplate.unit'), company.id],
    [t('deck.nameplate.captain'), company.owner],
    [t('deck.nameplate.commissioned'), String(company.created ?? '').slice(0, 10)],
    [t('deck.nameplate.crew'), `${crew ?? 0}`],
    [t('deck.nameplate.vault'), t('deck.nameplate.vaultVal', { n: memoryCount ?? 0, links: links ?? 0 })],
    [t('deck.nameplate.engine'), engines === null ? '—' : (engines.join(' · ') || t('deck.nameplate.engineNone'))],
  ];
  return (
    <div className="card" style={{ padding: '15px 18px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span className="card-title">{company.name}</span>
        <span className="microlabel">{t('deck.snArgo')}</span>
      </div>
      {/* minmax(0,1fr) — 기본 auto 트랙은 min-content까지 자라, nowrap 값(등록번호·엔진 목록)이 행 전체를 카드 밖으로
          밀어냈다(제보 2026-08-21 2회째: 값 span의 minWidth:0만으로는 트랙 자체의 성장을 못 막는다) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 5 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, borderBottom: '1px dashed var(--border-soft)', paddingBottom: 5 }}>
            <span className="microlabel" style={{ flex: 'none' }}>{k}</span>
            {/* minWidth:0 — flex 자식은 기본 min-width:auto라 nowrap 값이 줄지 않고 카드를 뚫는다(제보 2026-08-21: 등록번호·선장 이메일) */}
            <span className="mono" title={v} style={{ fontSize: 11, textAlign: 'right', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
        <span className="barcode" aria-hidden="true" />
        <span className="microlabel">{t('deck.sailTogether')}</span>
      </div>
    </div>
  );
}
