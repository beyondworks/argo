'use client';
// 데크 — 아르고호 계기판. 좌: 본 계기(메트릭·영입·크루·기억·차트), 우: 보조 계기 레일(별자리·항해일지·명판).
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar, Icon, Bars, Dial, Num, Spinner, Skeleton, api, imeGuard, timeAgo, tsFromRel } from '../../ui';
import { Constellation3D, GraphModal } from './graphview';

const HIRE_STAGES = ['지원서를 읽는 중', '페르소나 카드를 쓰는 중', '합류 준비 중'];

export default function Deck({ params }) {
  const { ws } = use(params);
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
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span className="microlabel">Crew Control · {data?.company?.name ?? ''}</span>
        <span className="microlabel">{new Date().toISOString().slice(0, 10)}</span>
      </div>

      <div className="deck-grid">
        {/* ── 본 계기 열 ── */}
        <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            {stats ? (
              <>
                <div className="metric card invert fade-up">
                  <div className="metric-top">
                    <span className="microlabel">Memory</span>
                    <span className="chip">오늘 +{stats.today}</span>
                  </div>
                  <Num value={data.memoryCount} unit="건" size={40} />
                  <div className="metric-sub">대화 {stats.conversations} · 노트 {stats.notes}</div>
                  <div className="metric-sub2">{lastTs ? `마지막 기록 ${timeAgo(lastTs)}` : '아직 기록 없음'}</div>
                </div>
                <div className="metric card fade-up" style={{ animationDelay: '0.04s' }}>
                  <div className="metric-top">
                    <span className="microlabel">Crew</span>
                    <span className="chip"><span className="dot" />Standby</span>
                  </div>
                  <Num value={data.agents.length} unit="명" />
                  <div className="metric-sub">전원 대기 중</div>
                  <div className="metric-sub2">한 줄 프롬프트로 영입</div>
                </div>
                <div className="metric card fade-up" style={{ animationDelay: '0.08s', alignItems: 'center' }}>
                  <div className="metric-top" style={{ width: '100%' }}>
                    <span className="microlabel">Link Density</span>
                    <span className="chip">{stats.links}쌍</span>
                  </div>
                  <Dial value={density} label="linked" />
                </div>
                <div className="metric card fade-up" style={{ animationDelay: '0.12s' }}>
                  <div className="metric-top">
                    <span className="microlabel">Composition</span>
                    <span className="chip">Vault</span>
                  </div>
                  <div style={{ display: 'grid', gap: 12, marginTop: 6 }}>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5 }}>
                        <span style={{ fontWeight: 600 }}>대화 기록</span>
                        <span className="mono" style={{ color: 'var(--fg-2)' }}>{stats.conversations}</span>
                      </div>
                      <div className="meter"><div className="meter-track"><div className="meter-fill" style={{ width: `${data.memoryCount ? (stats.conversations / data.memoryCount) * 100 : 0}%` }} /></div></div>
                    </div>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5 }}>
                        <span style={{ fontWeight: 600 }}>지식 노트</span>
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

          <ApprovalsCard ws={ws} agents={data?.agents ?? []} />

          <form onSubmit={hire} className="input-bar">
            <span style={{ color: 'var(--fg-3)', display: 'inline-flex' }}><Icon name="bolt" size={15} /></span>
            <input suppressHydrationWarning
              placeholder="어떤 전문가가 필요하세요? — 예: 뉴스레터를 쓰는 시니어 에디터"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={hiring}
              {...imeGuard}
            />
            {!hiring && <span className="kbd">↵</span>}
            <button type="button" className="btn sm" onClick={() => setHireOpts((v) => !v)} disabled={hiring}>
              옵션 {hireOpts ? '▴' : '▾'}
            </button>
            <button className="btn btn-primary" disabled={hiring || !prompt.trim()}>
              {hiring ? <Spinner /> : <Icon name="plus" size={14} />}
              크루 영입
            </button>
          </form>
          {hireOpts && (
            <div className="card fade-up" style={{ padding: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="microlabel">Options</span>
              <input suppressHydrationWarning
                placeholder="이름 (비우면 자동 작명)"
                value={hireName}
                onChange={(e) => setHireName(e.target.value)}
                {...imeGuard}
                style={{ flex: 1, minWidth: 150, height: 32, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13 }}
              />
              <input suppressHydrationWarning
                placeholder="팀 (예: 마케팅)"
                value={hireTeam}
                onChange={(e) => setHireTeam(e.target.value)}
                list="argo-teams"
                {...imeGuard}
                style={{ flex: 1, minWidth: 130, height: 32, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13 }}
              />
              <datalist id="argo-teams">
                {[...new Set((data?.agents ?? []).map((a) => a.team).filter(Boolean))].map((t) => <option key={t} value={t} />)}
              </datalist>
            </div>
          )}
          {hiring && <p style={{ fontSize: 12.5, color: 'var(--fg-2)', fontWeight: 600, padding: '0 4px' }}>{HIRE_STAGES[stage]}… 완료되면 바로 합류합니다.</p>}
          {error && <p style={{ fontSize: 13, color: 'var(--danger)', padding: '0 4px' }}>{error}</p>}

          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-head">
              <span className="card-title"><Icon name="user" size={14} />크루</span>
              <span className="rule" />
              <span className="pill"><span className="dot" />{agents.length}명 상주</span>
            </div>
            {data === null ? (
              <div style={{ padding: '0 18px 18px' }}><Skeleton h={90} /></div>
            ) : agents.length === 0 ? (
              <p style={{ padding: '2px 20px 18px', color: 'var(--fg-2)', fontSize: 13 }}>
                {q ? '검색과 일치하는 크루가 없습니다.' : '아직 크루가 없습니다. 위 입력창에 한 줄만 적어보세요.'}
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr><th style={{ width: 170 }}>Name</th><th>Role</th><th>Expertise</th><th style={{ width: 100 }}>Status</th><th style={{ width: 90 }} /></tr>
                </thead>
                <tbody>
                  {[...new Set(agents.map((a) => a.team || ''))].sort((a, b) => (a === '') - (b === '')).map((team) => (
                    [
                      agents.some((a) => (a.team || '') !== '') && (
                        <tr key={`t-${team}`} style={{ cursor: 'default' }}>
                          <td colSpan={5} style={{ padding: '5px 20px', background: 'var(--card-2)' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                              <span className="microlabel">{team || '무소속'}</span>
                              {team && (
                                <button
                                  className="microlabel"
                                  style={{ cursor: 'pointer', color: 'var(--fg-3)', display: 'inline-flex', alignItems: 'center', gap: 3 }}
                                  title="팀 이름 변경"
                                  onClick={async () => {
                                    const to = window.prompt(`"${team}" 팀의 새 이름:`, team);
                                    if (!to?.trim() || to.trim() === team) return;
                                    const res = await fetch(`/api/companies/${ws}/agents`, {
                                      method: 'PATCH', headers: { 'content-type': 'application/json' },
                                      body: JSON.stringify({ from: team, to }),
                                    });
                                    if (!res.ok) { setError((await res.json()).error); return; }
                                    load();
                                    window.dispatchEvent(new Event('argo:refresh'));
                                  }}
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
                          <td><span className="pill ok"><span className="dot" />대기</span></td>
                          <td>
                            <span style={{ display: 'inline-flex', gap: 6 }}>
                              <button
                                className="btn sm btn-icon"
                                style={{ width: 28 }}
                                title="이름·역할·팀 수정"
                                onClick={(e) => { e.stopPropagation(); setEditTarget(a); }}
                              >
                                <Icon name="edit" size={13} />
                              </button>
                              <span className="btn sm">대화 <Icon name="arrow" size={12} /></span>
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
              <span className="card-title"><Icon name="doc" size={14} />최근 기억</span>
              <span className="rule" />
              <a href={`/c/${ws}/vault`} className="btn sm">기억 전체</a>
            </div>
            {data === null ? (
              <div style={{ padding: '0 18px 18px' }}><Skeleton h={90} /></div>
            ) : memories.length === 0 ? (
              <p style={{ padding: '2px 20px 18px', color: 'var(--fg-2)', fontSize: 13 }}>
                {q ? '검색과 일치하는 기억이 없습니다.' : '크루와 첫 대화를 나누면 여기에 쌓입니다.'}
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Title</th><th style={{ width: 100 }}>Type</th><th style={{ width: 76 }}>Links</th><th style={{ width: 92 }}>Time</th></tr>
                </thead>
                <tbody>
                  {memories.map((m) => (
                    <tr key={m.rel} onClick={() => router.push(`/c/${ws}/vault?doc=${encodeURIComponent(m.rel)}`)}>
                      <td style={{ fontWeight: 600, maxWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{m.title}</td>
                      <td><span className="pill"><span className="dot" />{m.dir === 'notes' ? '노트' : '대화'}</span></td>
                      <td className="mono" style={{ fontSize: 12 }}>{m.links.length > 0 ? m.links.length : '—'}</td>
                      <td className="mono" style={{ color: 'var(--fg-3)', fontSize: 11.5 }}>{timeAgo(tsFromRel(m.rel) ?? m.mtime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <div className="card-head" style={{ alignItems: 'flex-start' }}>
              <div>
                <span className="card-title">일별 기억 적립</span>
                <div className="microlabel" style={{ marginTop: 3 }}>Last 14 Days · Conversations + Notes</div>
              </div>
              {stats && (
                <div style={{ display: 'flex', gap: 24, textAlign: 'right' }}>
                  <div>
                    <div className="microlabel">Total</div>
                    <div className="num" style={{ fontSize: 19 }}>{data.memoryCount}</div>
                  </div>
                  <div>
                    <div className="microlabel">Links</div>
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
              <span className="card-title">별자리</span>
              <button className="chip" onClick={() => setGraphOpen(true)} style={{ cursor: 'pointer' }}>크게 보기 ↗</button>
            </div>
            {docs === null || data === null ? (
              <Skeleton h={200} style={{ margin: '8px 0' }} />
            ) : (
              <Constellation3D company={data.company} delegations={data.delegations} agents={data.agents} docs={docs} onOpen={() => setGraphOpen(true)} />
            )}
            <p className="microlabel" style={{ textAlign: 'center', padding: '2px 0 6px' }}>
              {docs && data
                ? `${1 + new Set(data.agents.map((a) => a.team).filter(Boolean)).size + data.agents.length + docs.length} Nodes · ${docs.length} Memories`
                : ''}
            </p>
          </div>
          <VoyageLog docs={docs} agents={data?.agents ?? []} />
          <Nameplate company={data?.company} memoryCount={data?.memoryCount} links={stats?.links} crew={data?.agents?.length} />
          <TokenPanel usage={data?.usage} />
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
          company={data.company}
          agents={data.agents}
          delegations={data.delegations}
          docs={docs}
          onClose={() => setGraphOpen(false)}
          onSelect={(rel) => router.push(`/c/${ws}/vault?doc=${encodeURIComponent(rel)}`)}
        />
      )}
    </div>
  );
}

/** 항해일지 — 기록·연결 이벤트의 모노 타임라인. */
/** 결재함 — 크루가 올린 대기 결재. 승인/거절 즉시 반영, 실행 결과는 해당 크루 대화에 쌓인다. */
function ApprovalsCard({ ws, agents }) {
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
        <span className="microlabel">Approvals</span>
        <span className="rule" />
        <span className="chip"><span className="dot" />대기 {pending.length}</span>
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
        {pending.map((a) => (
          <div key={a.id} className="row" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Avatar name={nameOf(a.slug)} size={26} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{a.action}</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-2)', marginTop: 2 }}>
                {nameOf(a.slug)} · {a.reason}
              </div>
            </div>
            {busy === a.id ? <Spinner /> : (
              <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
                <button className="btn sm btn-primary" onClick={() => resolve(a.id, true)}>승인</button>
                <button className="btn sm" onClick={() => resolve(a.id, false)}>거절</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function VoyageLog({ docs, agents }) {
  const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? slug;
  const entries = (docs ?? []).slice(0, 8).map((d) => {
    const slug = d.rel
      .replace(/^(conversations|notes)\//, '')
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '')
      .replace(/\.md$/, '');
    const ts = tsFromRel(d.rel) ?? d.mtime;
    const t = new Date(ts);
    const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    return { rel: d.rel, hhmm, name: nameOf(slug), links: d.links.length, note: d.dir === 'notes' };
  });
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-head" style={{ paddingBottom: 8 }}>
        <span className="card-title">항해일지</span>
        <span className="microlabel">Log</span>
      </div>
      {docs === null ? (
        <div style={{ padding: '0 18px 16px' }}><Skeleton h={80} /></div>
      ) : entries.length === 0 ? (
        <p style={{ padding: '0 18px 16px', color: 'var(--fg-3)', fontSize: 12.5 }}>아직 기록이 없습니다.</p>
      ) : (
        <div style={{ padding: '0 0 8px' }}>
          {entries.map((e) => (
            <div key={e.rel} className="row" style={{ padding: '8px 18px', gap: 10 }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', flex: 'none' }}>{e.hhmm}</span>
              <span style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                <strong>{e.name}</strong>{e.note ? ' 지식 노트 작성' : ' 기록 남김'}
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
  const [form, setForm] = useState({ name: agent.name, role: agent.role, team: agent.team || '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

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
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(37,39,30,0.25)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <form onSubmit={save} className="card fade-up" style={{ width: 'min(440px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title">크루 정보 수정</span>
          <span className="microlabel">{agent.slug}</span>
          <span className="rule" />
          <button type="button" className="btn sm" onClick={onClose}>닫기 ESC</button>
        </div>
        <div style={{ padding: '0 20px 18px', display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">Name</span>
            <input suppressHydrationWarning value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={field} {...imeGuard} autoFocus />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">Role</span>
            <input suppressHydrationWarning value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={field} {...imeGuard} />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="microlabel">Team — 비우면 무소속</span>
            <input suppressHydrationWarning value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} list="argo-teams-edit" style={field} {...imeGuard} />
            <datalist id="argo-teams-edit">
              {teams.map((t) => <option key={t} value={t} />)}
            </datalist>
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary sm" disabled={saving || !form.name.trim()}>
              {saving ? <Spinner size={12} /> : '저장'}
            </button>
            <span className="metric-sub2">기록·별자리의 과거 흔적은 그대로 유지됩니다</span>
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
function TokenPanel({ usage }) {
  if (!usage) return <Skeleton h={170} style={{ borderRadius: 18 }} />;
  const t = usage.today.turns > 0 ? usage.today : usage.total;
  const scope = usage.today.turns > 0 ? 'Today' : 'Total';
  if (usage.total.turns === 0) {
    return (
      <div className="card" style={{ padding: '15px 18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="card-title">토큰</span>
          <span className="microlabel">Usage</span>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--fg-3)', marginTop: 8 }}>
          다음 턴부터 사용량이 기록됩니다.
        </p>
      </div>
    );
  }
  const hit = Math.round(t.cacheHitRate * 100);
  return (
    <div className="card" style={{ padding: '15px 18px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span className="card-title">토큰</span>
        <span className="chip">{scope} · {t.turns}턴</span>
      </div>

      {/* 입력(맥락) / 출력(생성) — 입력≫출력이 정상 형태 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <div className="microlabel">In · 읽은 맥락</div>
          <div className="num" style={{ fontSize: 21 }}>{fmtTok(t.contextTotal)}</div>
        </div>
        <div>
          <div className="microlabel">Out · 생성</div>
          <div className="num" style={{ fontSize: 21 }}>{fmtTok(t.output)}</div>
        </div>
      </div>

      {/* 효율 ① 캐시 적중률 */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5 }}>
          <span style={{ fontWeight: 600 }}>캐시 적중률</span>
          <span className="mono" style={{ color: 'var(--fg-2)' }}>{hit}%</span>
        </div>
        <div className="meter"><div className="meter-track"><div className="meter-fill" style={{ width: `${hit}%` }} /></div></div>
        <div className="metric-sub2" style={{ marginTop: 4 }}>높을수록 같은 맥락을 싸게 재사용 (캐시 읽기 ≈ 정가의 1/10)</div>
      </div>

      {/* 효율 ② + 형태 지표 */}
      <div style={{ display: 'grid', gap: 5, marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, borderBottom: '1px dashed var(--border-soft)', paddingBottom: 5 }}>
          <span className="microlabel">턴당 비용</span>
          <span className="mono" style={{ fontSize: 11 }}>
            {t.costPerTurn != null ? `$${t.costPerTurn.toFixed(3)}` : '—'}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, borderBottom: '1px dashed var(--border-soft)', paddingBottom: 5 }}>
          <span className="microlabel">출력 1당 맥락</span>
          <span className="mono" style={{ fontSize: 11 }}>{t.inPerOut.toFixed(0)} : 1</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <span className="microlabel">누적</span>
          <span className="mono" style={{ fontSize: 11 }}>
            {fmtTok(usage.total.contextTotal)} in · {fmtTok(usage.total.output)} out
            {usage.total.hasCost ? ` · $${usage.total.costUsd.toFixed(2)}` : ''}
          </span>
        </div>
      </div>
      <div className="metric-sub2" style={{ marginTop: 8 }}>
        입력이 출력보다 큰 것이 정상입니다 — 근거를 충분히 읽고 짧게 생성하는 형태.
      </div>
    </div>
  );
}

/** 명판 — 선박 제원판. 회사의 스펙을 계기판 명판처럼. */
function Nameplate({ company, memoryCount, links, crew }) {
  if (!company) return <Skeleton h={150} style={{ borderRadius: 18 }} />;
  const rows = [
    ['Unit', company.id],
    ['Captain', company.owner],
    ['Commissioned', String(company.created ?? '').slice(0, 10)],
    ['Crew', `${crew ?? 0}`],
    ['Vault', `${memoryCount ?? 0} rec · ${links ?? 0} link`],
    ['Engine', 'Claude Agent SDK'],
  ];
  return (
    <div className="card" style={{ padding: '15px 18px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span className="card-title">{company.name}</span>
        <span className="microlabel">S/N ARGO-01</span>
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
        <span className="microlabel">Sail Together</span>
      </div>
    </div>
  );
}
