'use client';
// 데크 — 크루 영입과 크루 카드, 최근 기억.
import { use, useEffect, useState } from 'react';
import { Avatar, Icon, Spinner, Skeleton, api, timeAgo, tsFromRel } from '../../ui';

const HIRE_STAGES = ['지원서를 읽는 중', '페르소나 카드를 쓰는 중', '합류 준비 중'];

export default function Deck({ params }) {
  const { ws } = use(params);
  const [data, setData] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [hiring, setHiring] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState('');

  function load() {
    api(`/api/companies/${ws}`).then(setData).catch((e) => setError(String(e.message)));
  }
  useEffect(load, [ws]);

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

  const agents = data?.agents ?? [];

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 className="page-title">데크</h1>
        <p className="page-sub">필요한 전문가를 한 줄로 적으면 크루로 합류합니다.</p>
      </div>

      <form onSubmit={hire} className="input-row">
        <input
          placeholder="예: 뉴스레터를 쓰는 시니어 에디터"
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
      {hiring && (
        <p style={{ marginTop: 10, fontSize: 12.5, color: 'var(--fg-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          {HIRE_STAGES[stage]}… 완료되면 바로 합류합니다.
        </p>
      )}
      {error && <p style={{ marginTop: 10, fontSize: 13, color: 'var(--danger)' }}>{error}</p>}

      <section style={{ marginTop: 36 }}>
        <div className="section-label">크루 {agents.length > 0 && agents.length}</div>
        {data === null ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Skeleton h={150} /><Skeleton h={150} />
          </div>
        ) : agents.length === 0 ? (
          <div className="empty">아직 크루가 없습니다. 위에 한 줄만 적으면 전문 크루가 합류합니다.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
            {agents.map((a, i) => (
              <a
                key={a.slug}
                href={`/c/${ws}/crew/${a.slug}`}
                className="card card-i fade-up"
                style={{ padding: 18, animationDelay: `${0.04 * i}s`, display: 'flex', flexDirection: 'column', gap: 12 }}
              >
                <div style={{ display: 'flex', gap: 11, alignItems: 'center' }}>
                  <Avatar name={a.name} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 650 }}>{a.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.role}</div>
                  </div>
                </div>
                {a.expertise.length > 0 && (
                  <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12.5, color: 'var(--fg-2)' }}>
                    {a.expertise.map((x) => (
                      <li key={x} style={{ display: 'flex', gap: 7, minWidth: 0 }}>
                        <span style={{ color: 'var(--accent)', flex: 'none' }}>·</span>
                        <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{x}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <span style={{ marginTop: 'auto', fontSize: 12.5, fontWeight: 550, color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  대화하기 <Icon name="back" size={13} style={{ transform: 'rotate(180deg)' }} />
                </span>
              </a>
            ))}
          </div>
        )}
      </section>

      {(data?.memories ?? []).length > 0 && (
        <section style={{ marginTop: 36 }}>
          <div className="section-label">최근 기억</div>
          <div className="card" style={{ overflow: 'hidden' }}>
            {data.memories.map((m) => (
              <a key={m.rel} href={`/c/${ws}/vault?doc=${encodeURIComponent(m.rel)}`} className="row">
                <span style={{ color: 'var(--fg-3)', display: 'inline-flex', flex: 'none' }}><Icon name="doc" size={14} /></span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{m.title}</span>
                {m.links.length > 0 && <span className="chip gold">연결 {m.links.length}</span>}
                <span style={{ fontSize: 12, color: 'var(--fg-3)', flex: 'none' }}>{timeAgo(tsFromRel(m.rel) ?? m.mtime)}</span>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
