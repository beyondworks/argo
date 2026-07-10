'use client';
// 크루 채팅 — 유저는 버블, 크루는 플랫 문서형(코덱스 스타일). 턴마다 기억 칩.
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
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 126px)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 18, borderBottom: '1px solid var(--border)', marginBottom: 26 }}>
        <Avatar name={agent?.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 650, letterSpacing: '-0.015em' }}>{agent?.name ?? ''}</div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{agent?.role}</div>
        </div>
        {sessionRef.current && <span className="chip">세션 이어가는 중</span>}
      </header>

      <div className="thread" style={{ flex: 1 }}>
        {thread.length === 0 && !busy && (
          <div className="empty" style={{ marginTop: 12 }}>
            {agent?.tone && <p style={{ marginBottom: 6, color: 'var(--fg-2)' }}>"{agent.tone}"</p>}
            첫 지시를 내려보세요. 매 턴의 결과는 회사 기억에 남고, 비슷한 기억끼리 이어집니다.
          </div>
        )}
        {thread.map((m, i) =>
          m.who === 'user' ? (
            <div key={i} className="msg-user fade-up">{m.text}</div>
          ) : (
            <div key={i} className="msg-crew fade-up">
              <Avatar name={agent?.name} sm />
              <div style={{ minWidth: 0, paddingTop: 2 }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--fg-2)', fontSize: 13, paddingTop: 4 }}>
              <Dots /> {WAIT_STAGES[stage]}…
            </div>
          </div>
        )}
        {error && <p style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</p>}
        <div ref={endRef} />
      </div>

      <form onSubmit={send} className="input-row" style={{ position: 'sticky', bottom: 20, marginTop: 26, boxShadow: 'var(--shadow-md)' }}>
        <input
          placeholder={`${agent?.name ?? '크루'}에게 지시하기`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <button className="btn btn-primary btn-icon" disabled={busy || !input.trim()} aria-label="보내기">
          <Icon name="send" size={15} />
        </button>
      </form>
    </div>
  );
}
