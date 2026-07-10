'use client';
// 데크 — 아르고호 계기판: 계기 숫자·다이얼·틱 진행바·스케줄 표·도트 매트릭스.
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar, Icon, Bars, Dial, Spinner, Skeleton, api, timeAgo, tsFromRel } from '../../ui';

const HIRE_STAGES = ['지원서를 읽는 중', '페르소나 카드를 쓰는 중', '합류 준비 중'];

export default function Deck({ params }) {
  const { ws } = use(params);
  const router = useRouter();
  const [data, setData] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [hiring, setHiring] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  function load() {
    api(`/api/companies/${ws}`).then(setData).catch((e) => setError(String(e.message)));
  }
  useEffect(load, [ws]);

  useEffect(() => {
    const h = (e) => setQ(String(e.detail || '').toLowerCase());
    window.addEventListener('argo:search', h);
    return () => window.removeEventListener('argo:search', h);
  }, []);

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
      await api(`/api/companies/${ws}/agents`, { prompt });
      setPrompt('');
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

      {/* 계기 열 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {stats ? (
          <>
            <div className="metric card invert fade-up">
              <div className="metric-top">
                <span className="microlabel">Memory</span>
                <span className="chip" style={{ borderColor: 'rgba(229,231,217,0.4)', color: 'var(--primary-fg)' }}>오늘 +{stats.today}</span>
              </div>
              <div className="num">{data.memoryCount}<small style={{ color: 'rgba(229,231,217,0.7)' }}>건</small></div>
              <div className="metric-sub">대화 {stats.conversations} · 노트 {stats.notes}</div>
              <div className="metric-sub2">{lastTs ? `마지막 기록 ${timeAgo(lastTs)}` : '아직 기록 없음'}</div>
            </div>
            <div className="metric card fade-up" style={{ animationDelay: '0.04s' }}>
              <div className="metric-top">
                <span className="microlabel">Crew</span>
                <span className="chip"><span className="dot" />Standby</span>
              </div>
              <div className="num">{data.agents.length}<small>명</small></div>
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
          [0, 1, 2, 3].map((i) => <Skeleton key={i} h={140} style={{ borderRadius: 16 }} />)
        )}
      </div>

      {/* 크루 영입 */}
      <form onSubmit={hire} className="input-bar">
        <span style={{ color: 'var(--fg-3)', display: 'inline-flex' }}><Icon name="bolt" size={15} /></span>
        <input
          placeholder="어떤 전문가가 필요하세요? — 예: 뉴스레터를 쓰는 시니어 에디터"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={hiring}
        />
        {!hiring && <span className="kbd">↵</span>}
        <button className="btn btn-primary" disabled={hiring || !prompt.trim()}>
          {hiring ? <Spinner /> : <Icon name="plus" size={14} />}
          크루 영입
        </button>
      </form>
      {hiring && <p style={{ fontSize: 12.5, color: 'var(--fg-2)', fontWeight: 600, padding: '0 4px' }}>{HIRE_STAGES[stage]}… 완료되면 바로 합류합니다.</p>}
      {error && <p style={{ fontSize: 13, color: 'var(--danger)', padding: '0 4px' }}>{error}</p>}

      {/* 크루 — 스케줄 표 */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <span className="card-title"><Icon name="user" size={14} />크루</span>
          <span className="pill"><span className="dot" />{agents.length}명 상주</span>
        </div>
        {data === null ? (
          <div style={{ padding: '0 18px 18px' }}><Skeleton h={90} /></div>
        ) : agents.length === 0 ? (
          <p style={{ padding: '2px 18px 18px', color: 'var(--fg-2)', fontSize: 13 }}>
            {q ? '검색과 일치하는 크루가 없습니다.' : '아직 크루가 없습니다. 위 입력창에 한 줄만 적어보세요.'}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr><th style={{ width: 180 }}>Name</th><th>Role</th><th>Expertise</th><th style={{ width: 110 }}>Status</th><th style={{ width: 92 }} /></tr>
            </thead>
            <tbody>
              {agents.map((a) => (
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
                  <td><span className="btn sm">대화 <Icon name="arrow" size={12} /></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 최근 기억 — 스케줄 표 */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <span className="card-title"><Icon name="doc" size={14} />최근 기억</span>
          <a href={`/c/${ws}/vault`} className="btn sm">기억 전체</a>
        </div>
        {data === null ? (
          <div style={{ padding: '0 18px 18px' }}><Skeleton h={90} /></div>
        ) : memories.length === 0 ? (
          <p style={{ padding: '2px 18px 18px', color: 'var(--fg-2)', fontSize: 13 }}>
            {q ? '검색과 일치하는 기억이 없습니다.' : '크루와 첫 대화를 나누면 여기에 쌓입니다.'}
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Title</th><th style={{ width: 110 }}>Type</th><th style={{ width: 84 }}>Links</th><th style={{ width: 92 }}>Time</th></tr>
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

      {/* 일별 적립 — 도트 매트릭스 */}
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
        <div style={{ padding: '6px 18px 16px' }}>
          {stats ? <Bars data={stats.daily} /> : <Skeleton h={100} />}
        </div>
      </div>
    </div>
  );
}
