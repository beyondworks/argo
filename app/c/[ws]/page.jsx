'use client';
// 데크 — 아르고호 계기판. 좌: 본 계기(메트릭·영입·크루·기억·차트), 우: 보조 계기 레일(별자리·항해일지·명판).
import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Avatar, Icon, Bars, Dial, Num, Spinner, Skeleton, useScrollLock, InputModal, api, imeGuard, timeAgo, tsFromRel } from '../../ui';
import { Constellation3D, GraphModal } from './graphview';
import { anyRunnerUsable, runnerNeedsReconnect, usableRunnerNames } from '../../runner-connect';
import { useLang } from '../../i18n';

export default function Deck({ params }) {
  const { ws } = use(params);
  const { t, lang } = useLang();
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
  const [graphOpen, setGraphOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null); // 크루 신원 수정 모달
  const [renameTarget, setRenameTarget] = useState(null); // 팀 이름변경 입력 모달 대상(현재 팀명)
  const hireRef = useRef(null); // 사이드바 '크루 추가'가 포커스+깜빡 대상으로 삼는 입력창

  // 팀 이름변경 — window.prompt(Tauri 무동작) 대신 인앱 InputModal. onConfirm(새 이름)
  async function doRenameTeam(to) {
    const team = renameTarget;
    setRenameTarget(null);
    if (!to?.trim() || to.trim() === team) return;
    const res = await fetch(`/api/companies/${ws}/agents`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: team, to: to.trim() }),
    });
    if (!res.ok) { setError((await res.json()).error); return; }
    load();
    window.dispatchEvent(new Event('argo:refresh'));
  }

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
        {/* ── 본 계기 열 — "지금 판단할 것"(결재)이 지표보다 먼저다 ── */}
        <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
          <MorningBrief ws={ws} agents={data?.agents ?? []} />
          <ApprovalsCard ws={ws} agents={data?.agents ?? []} />

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
                    <span className="chip"><span className="dot" />{t('deck.standby')}</span>
                  </div>
                  <Num value={data.agents.length} unit={t('common.people')} />
                  <div className="metric-sub">{t('deck.allStandby')}</div>
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

          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-head">
              <span className="card-title"><Icon name="user" size={14} />{t('deck.crewTitle')}</span>
              <span className="rule" />
              <span className="pill"><span className="dot" />{t('deck.onDuty', { n: agents.length })}</span>
            </div>
            {data === null ? (
              <div style={{ padding: '0 18px 18px' }}><Skeleton h={90} /></div>
            ) : agents.length === 0 ? (
              <p style={{ padding: '2px 20px 18px', color: 'var(--fg-2)', fontSize: 13 }}>
                {q ? t('deck.noCrewMatch') : t('deck.noCrewYet')}
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr><th style={{ width: 170 }}>{t('deck.colName')}</th><th>{t('deck.colRole')}</th><th>{t('deck.colExpertise')}</th><th style={{ width: 100 }}>{t('deck.colStatus')}</th><th style={{ width: 90 }} /></tr>
                </thead>
                <tbody>
                  {[...new Set(agents.map((a) => a.team || ''))].sort((a, b) => (a === '') - (b === '')).map((team) => (
                    [
                      agents.some((a) => (a.team || '') !== '') && (
                        <tr key={`t-${team}`} style={{ cursor: 'default' }}>
                          <td colSpan={5} style={{ padding: '5px 20px', background: 'var(--card-2)' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                              <span className="microlabel">{team || t('deck.unassigned')}</span>
                              {team && (
                                <button
                                  className="microlabel"
                                  style={{ cursor: 'pointer', color: 'var(--fg-3)', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                                  title={t('deck.renameTeam')}
                                  onClick={() => setRenameTarget(team)}
                                >
                                  <Icon name="edit" size={11} />
                                </button>
                              )}
                            </span>
                          </td>
                        </tr>
                      ),
                      ...agents.filter((a) => (a.team || '') === team).map((a) => (
                        <tr key={a.slug} onClick={() => router.push(`/c/${ws}/crew/${a.slug}`)}>
                          <td>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                              <Avatar name={a.name} sm />
                              <span style={{ fontWeight: 650 }}>{a.name}</span>
                            </span>
                          </td>
                          <td style={{ color: 'var(--fg-2)', fontSize: 12.5 }}>{a.role}</td>
                          <td style={{ color: 'var(--fg-3)', fontSize: 12, maxWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                            {a.expertise.join(' · ')}
                          </td>
                          <td><span className="pill ok"><span className="dot" />{t('deck.waiting')}</span></td>
                          <td>
                            <span style={{ display: 'inline-flex', gap: 6 }}>
                              <button
                                className="btn sm btn-icon"
                                style={{ width: 28 }}
                                title={t('deck.editIdentity')}
                                onClick={(e) => { e.stopPropagation(); setEditTarget(a); }}
                              >
                                <Icon name="edit" size={13} />
                              </button>
                              <span className="btn sm">{t('deck.chat')} <Icon name="arrow" size={12} /></span>
                            </span>
                          </td>
                        </tr>
                      )),
                    ]
                  ))}
                </tbody>
              </table>
            )}
          </div>

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
              <button className="chip" onClick={() => setGraphOpen(true)} style={{ cursor: 'pointer' }}>{t('deck.viewLarge')}</button>
            </div>
            {docs === null || data === null ? (
              <Skeleton h={200} style={{ margin: '8px 0' }} />
            ) : (
              <Constellation3D company={data.company} delegations={data.delegations} agents={data.agents} docs={docs} onOpen={() => setGraphOpen(true)} onSelectDoc={(rel) => router.push(`/c/${ws}/vault?doc=${encodeURIComponent(rel)}`)} />
            )}
            <p className="microlabel" style={{ textAlign: 'center', padding: '2px 0 6px' }}>
              {docs && data
                ? t('deck.nodesMemories', { nodes: 1 + new Set(data.agents.map((a) => a.team).filter(Boolean)).size + data.agents.length + docs.length, mem: docs.length })
                : ''}
            </p>
          </div>
          <VoyageLog docs={docs} agents={data?.agents ?? []} />
          <Nameplate company={data?.company} memoryCount={data?.memoryCount} links={stats?.links} crew={data?.agents?.length} />
          <TokenPanel usage={data?.usage} budgetUsd={data?.company?.budgetUsd} payroll={data?.payroll} agents={data?.agents ?? []} />
        </div>
      </div>

      {editTarget && (
        <CrewEditModal
          ws={ws}
          agent={editTarget}
          teams={[...new Set((data?.agents ?? []).map((a) => a.team).filter(Boolean))]}
          onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); load(); window.dispatchEvent(new Event('argo:refresh')); }}
        />
      )}

      {graphOpen && docs && data && (
        <GraphModal
          ws={ws}
          company={data.company}
          agents={data.agents}
          delegations={data.delegations}
          docs={docs}
          onClose={() => setGraphOpen(false)}
          onSelect={(rel) => router.push(`/c/${ws}/vault?doc=${encodeURIComponent(rel)}`)}
        />
      )}

      {renameTarget != null && (
        <InputModal
          title={t('deck.renameTeam')}
          label={t('deck.renameTeamPrompt', { team: renameTarget })}
          defaultValue={renameTarget}
          confirmLabel={t('common.save')}
          onConfirm={doRenameTeam}
          onClose={() => setRenameTarget(null)}
        />
      )}
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

/** 항해일지 — 기록·연결 이벤트의 모노 타임라인. */
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
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{a.action}</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-2)', marginTop: 2 }}>
                {nameOf(a.slug)}{a.from ? ` (${t('deck.approvalFrom', { name: nameOf(a.from) })})` : ''} · {a.reason}
              </div>
            </div>
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

function VoyageLog({ docs, agents }) {
  const { t } = useLang();
  const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? slug;
  const entries = (docs ?? []).slice(0, 30).map((d) => {
    const slug = d.rel
      .replace(/^(conversations|notes|journal)\//, '')
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '')
      .replace(/^\d{4}-\d{2}-\d{2}-/, '') // 일지: journal/YYYY-MM-DD-<slug>
      .replace(/\.md$/, '');
    const ts = tsFromRel(d.rel) ?? d.mtime;
    const dt = new Date(ts);
    const hhmm = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    const note = d.dir === 'notes';
    return { rel: d.rel, hhmm, label: note ? d.title : t('deck.crewJournal', { name: nameOf(slug) }), links: d.links.length, note };
  });
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-head" style={{ paddingBottom: 8 }}>
        <span className="card-title">{t('deck.voyageLog')}</span>
        <span className="microlabel">{t('deck.log')}</span>
      </div>
      {docs === null ? (
        <div style={{ padding: '0 18px 16px' }}><Skeleton h={80} /></div>
      ) : entries.length === 0 ? (
        <p style={{ padding: '0 18px 16px', color: 'var(--fg-3)', fontSize: 12.5 }}>{t('deck.noLogYet')}</p>
      ) : (
        <div /* 기록이 늘어도 카드가 자라지 않는다 — 하단 라인 고정, 안에서 스크롤 */
          style={{ padding: '0 0 8px', maxHeight: 330, overflowY: 'auto' }}>
          {entries.map((e) => (
            <div key={e.rel} className="row" style={{ padding: '8px 18px', gap: 10 }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', flex: 'none' }}>{e.hhmm}</span>
              <span style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                <strong>{e.label}</strong>{e.note ? t('deck.learned') : t('deck.recorded')}
              </span>
              {e.links > 0 && <span className="mono" style={{ fontSize: 10, color: 'var(--fg-2)', flex: 'none' }}>LINK {e.links}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 크루 신원 수정 — 이름·역할·팀. 슬러그·기록은 유지된다. */
function CrewEditModal({ ws, agent, teams, onClose, onSaved }) {
  const { t } = useLang();
  useScrollLock();
  // runner '' = 미지정(자동) — 'claude' 기본값을 박으면 저장 시 자동 크루가 클로드 고정으로 둔갑한다(러너 오표시 계열)
  const [form, setForm] = useState({ name: agent.name, role: agent.role, team: agent.team || '', model: agent.model || '', runner: agent.runner || '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  // 러너 카탈로그 + 로컬 인증 상태 — Claude Code 외에는 각 CLI의 OAuth 로그인(구독)을 빌린다
  const [runners, setRunners] = useState(null);
  useEffect(() => { api(`/api/runners?ws=${ws}`).then((d) => setRunners(d.runners)).catch(() => setRunners([])); }, [ws]);
  const curRunner = runners?.find((r) => r.id === form.runner);
  const runnerLabel = (r) => r.name + (r.authed ? '' : r.installed ? ` — ${t('runner.needLogin')}` : ` — ${t('runner.notInstalled')}`);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(e) {
    e.preventDefault();
    if (saving || !form.name.trim()) return;
    setSaving(true); setErr('');
    try {
      const res = await fetch(`/api/companies/${ws}/agents/${agent.slug}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      onSaved();
    } catch (e2) {
      setErr(String(e2.message));
      setSaving(false);
    }
  }

  const field = { height: 34, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13 };
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'var(--overlay)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <form onSubmit={save} className="card fade-up" style={{ width: 'min(440px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title">{t('deck.editCrewInfo')}</span>
          <span className="microlabel">{agent.slug}</span>
          <span className="rule" />
          <button type="button" className="btn sm" onClick={onClose}>{t('deck.closeEsc')}</button>
        </div>
        <div style={{ padding: '0 20px 18px', display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">{t('deck.fieldName')}</span>
            <input suppressHydrationWarning value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={field} {...imeGuard} autoFocus />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">{t('deck.fieldRole')}</span>
            <input suppressHydrationWarning value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={field} {...imeGuard} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">{t('deck.fieldTeamHint')}</span>
            <input suppressHydrationWarning value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} list="argo-teams-edit" style={field} {...imeGuard} />
            <datalist id="argo-teams-edit">
              {teams.map((tm) => <option key={tm} value={tm} />)}
            </datalist>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">{t('deck.fieldRunnerHint')}</span>
            <select value={form.runner} style={field} disabled={runners === null}
              onChange={(e) => {
                const next = runners?.find((r) => r.id === e.target.value);
                // 러너를 바꾸면 그 러너의 첫 모델을 바로 선택 — "기본" 가짜 항목 없이 항상 실제 모델
                setForm({ ...form, runner: e.target.value, model: next?.models?.[0]?.id ?? '' });
              }}>
              {/* 로딩 폴백으로 가짜 Claude 항목을 만들지 않는다 — select 자체가 disabled(runners === null) */}
              <option value="">{t('runner.autoOption')}</option>
              {(runners ?? []).map((r) => (
                <option key={r.id} value={r.id} disabled={!r.authed}>{runnerLabel(r)}</option>
              ))}
            </select>
            {curRunner && !curRunner.authed && (
              <span style={{ fontSize: 11.5, color: 'var(--warn)' }}>{t('runner.authHint', { name: curRunner.name })}</span>
            )}
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">{t('deck.fieldModelHint')}</span>
            {/* 현재 러너가 미연결(레거시)이면 모델 선택도 잠금 — 설정에서 연결 후 활성화 */}
            <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} style={field}
              disabled={curRunner && !curRunner.authed}>
              {!form.model && <option value="" disabled>—</option>}{/* 레거시 미선택 크루 표시용 */}
              {(curRunner?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.label}{m.gated ? ` — ${t('runner.gatedBadge')}` : ''}</option>
              ))}
            </select>
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary sm" disabled={saving || !form.name.trim()}>
              {saving ? <Spinner size={12} /> : t('deck.save')}
            </button>
            <span className="metric-sub2">{t('deck.saveHint')}</span>
            {err && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span>}
          </div>
        </div>
      </form>
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
      <div style={{ display: 'grid', gap: 5 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, borderBottom: '1px dashed var(--border-soft)', paddingBottom: 5 }}>
            <span className="microlabel">{k}</span>
            <span className="mono" style={{ fontSize: 11, textAlign: 'right', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{v}</span>
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
