'use client';
// 크루 채팅 — 유저는 라벤더 버블, 크루는 플랫. 턴마다 민트 기억 칩.
import { use, useEffect, useRef, useState } from 'react';
import { Avatar, Icon, Markdown, Dots, api } from '../../../../ui';

const WAIT_STAGES = ['기억을 살피는 중', '작업 중', '결과를 정리하는 중'];

export default function CrewChat({ params }) {
  const { ws, slug } = use(params);
  const [agent, setAgent] = useState(null);
  const [thread, setThread] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState('');
  const sessionRef = useRef(null);
  const endRef = useRef(null);

  useEffect(() => {
    api(`/api/companies/${ws}`)
      .then((d) => setAgent(d.agents.find((a) => a.slug === slug) ?? { name: slug, role: '' }))
      .catch(() => setAgent({ name: slug, role: '' }));
    setThread([]); sessionRef.current = null;
  }, [ws, slug]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [thread, busy]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setStage((s) => Math.min(s + 1, WAIT_STAGES.length - 1)), 14000);
    return () => clearInterval(t);
  }, [busy]);

  async function send(e) {
    e.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput(''); setError(''); setBusy(true); setStage(0);
    setThread((t) => [...t, { who: 'user', text: message }]);
    try {
      const r = await api(`/api/companies/${ws}/chat`, { slug, message, sessionId: sessionRef.current });
      sessionRef.current = r.sessionId;
      setThread((t) => [...t, { who: 'crew', text: r.reply, handover: r.handover }]);
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (err) {
      setError(String(err.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 170px)' }}>
      <div className="thread" style={{ flex: 1 }}>
        {thread.length === 0 && !busy && (
          <div className="card fade-up" style={{ padding: '30px 28px', textAlign: 'center' }}>
            <div style={{ display: 'grid', placeItems: 'center', gap: 10 }}>
              <Avatar name={agent?.name} />
              <div>
                <div style={{ fontSize: 15, fontWeight: 750 }}>{agent?.name ?? ''}</div>
                <span className="chip lav" style={{ marginTop: 4 }}>{agent?.role}</span>
              </div>
              {agent?.tone && <p style={{ color: 'var(--ink-2)', fontSize: 13 }}>"{agent.tone}"</p>}
              <p style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>
                첫 지시를 내려보세요. 매 턴의 결과는 회사 기억에 남고, 비슷한 기억끼리 이어집니다.
              </p>
            </div>
          </div>
        )}
        {thread.map((m, i) =>
          m.who === 'user' ? (
            <div key={i} className="msg-user fade-up">{m.text}</div>
          ) : (
            <div key={i} className="msg-crew fade-up">
              <Avatar name={agent?.name} sm />
              <div className="card" style={{ minWidth: 0, padding: '14px 18px' }}>
                <Markdown text={m.text} />
                {m.handover && (
                  <a className="memo-chip" href={`/c/${ws}/vault?doc=${encodeURIComponent(m.handover.rel)}`}>
                    <Icon name="memory" size={12} />
                    기억에 기록됨
                    {m.handover.linked?.length > 0 && <span>· 관련 기억 {m.handover.linked.length}건과 연결</span>}
                  </a>
                )}
              </div>
            </div>
          )
        )}
        {busy && (
          <div className="msg-crew">
            <Avatar name={agent?.name} sm />
            <div className="card" style={{ padding: '13px 18px', display: 'flex', alignItems: 'center', gap: 10, color: 'var(--ink-2)', fontSize: 13 }}>
              <Dots /> {WAIT_STAGES[stage]}…
            </div>
          </div>
        )}
        {error && <p style={{ fontSize: 13, color: 'var(--coral)' }}>{error}</p>}
        <div ref={endRef} />
      </div>

      <form onSubmit={send} className="input-pill" style={{ position: 'sticky', bottom: 20, marginTop: 24, boxShadow: 'var(--shadow-pop)' }}>
        <input
          placeholder={`${agent?.name ?? '크루'}에게 지시하기`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <button className="btn btn-dark btn-icon" disabled={busy || !input.trim()} aria-label="보내기">
          <Icon name="send" size={15} />
        </button>
      </form>
    </div>
  );
}
