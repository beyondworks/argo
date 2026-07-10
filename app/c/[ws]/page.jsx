'use client';
// 데크(Deck) — 크루를 영입하고, 크루 카드와 최근 기억을 한눈에 본다.
import { use, useEffect, useState } from 'react';
import { Avatar, Oars, api, timeAgo, tsFromRel } from '../../ui';

const HIRE_STAGES = ['지원서를 읽는 중', '페르소나 카드를 쓰는 중', '승선 준비 중'];

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
    <div style={{ maxWidth: 780 }}>
      <div className="eyebrow">데크</div>
      <h1 className="display" style={{ fontSize: 30, margin: '6px 0 26px' }}>
        어떤 전문가와 항해할까요?
      </h1>

      <form onSubmit={hire} className="card" style={{ display: 'flex', gap: 10, padding: 13, alignItems: 'center' }}>
        <input
          className="input"
          style={{ border: 'none', background: 'transparent', boxShadow: 'none', fontSize: 15 }}
          placeholder="한 줄로 적어주세요 — 예: 뉴스레터를 쓰는 시니어 에디터"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={hiring}
        />
        <button className="btn btn-gold" disabled={hiring || !prompt.trim()}>
          {hiring ? <Oars /> : '크루 영입'}
        </button>
      </form>
      {hiring && (
        <p style={{ marginTop: 10, fontSize: 12.5, color: 'var(--gold-2)' }}>
          {HIRE_STAGES[stage]}… 카드가 완성되면 바로 승선합니다.
        </p>
      )}
      {error && <p style={{ marginTop: 10, fontSize: 13, color: 'var(--danger)' }}>{error}</p>}

      <section style={{ marginTop: 40 }}>
        {data === null ? (
          <div className="empty"><Oars /></div>
        ) : agents.length === 0 ? (
          <div className="empty">
            아직 크루가 없습니다. 위에 한 줄만 적으면 전문 크루가 승선합니다.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
            {agents.map((a, i) => (
              <div key={a.slug} className="card lift fade-up" style={{ padding: 20, animationDelay: `${0.05 * i}s`, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <Avatar name={a.name} />
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: 16 }}>{a.name}</strong>
                    <div style={{ fontSize: 12.5, color: 'var(--gold-2)' }}>{a.role}</div>
                  </div>
                </div>
                {a.expertise.length > 0 && (
                  <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5, color: 'var(--ink-2)' }}>
                    {a.expertise.map((x) => (
                      <li key={x} style={{ display: 'flex', gap: 8 }}>
                        <span style={{ color: 'var(--gold)', flex: 'none' }}>·</span>
                        <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{x}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <a href={`/c/${ws}/crew/${a.slug}`} className="btn" style={{ justifyContent: 'center', marginTop: 'auto' }}>
                  대화하기
                </a>
              </div>
            ))}
          </div>
        )}
      </section>

      {(data?.memories ?? []).length > 0 && (
        <section style={{ marginTop: 44 }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>최근 기억</div>
          <div className="card" style={{ padding: '6px 0' }}>
            {data.memories.map((m) => (
              <a
                key={m.rel}
                href={`/c/${ws}/vault?doc=${encodeURIComponent(m.rel)}`}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 14, padding: '10px 18px', borderBottom: '1px solid var(--line-soft)' }}
              >
                <span style={{ fontSize: 13, color: 'var(--ink-2)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{m.title}</span>
                <span style={{ fontSize: 11.5, color: 'var(--ink-3)', flex: 'none' }}>
                  {m.links.length > 0 && <span style={{ color: 'var(--gold)', marginRight: 8 }}>연결 {m.links.length}</span>}
                  {timeAgo(tsFromRel(m.rel) ?? m.mtime)}
                </span>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
