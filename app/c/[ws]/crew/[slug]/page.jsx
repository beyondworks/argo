'use client';
// 크루 채팅 — 세션 resume + 매 턴 vault 핸드오버가 남는 것을 눈으로 보여준다.
import { use, useEffect, useRef, useState } from 'react';
import { Avatar, Markdown, Oars, api } from '../../../../ui';

const WAIT_STAGES = ['기억(vault)을 살피는 중', '작업 중', '결과를 정리하는 중'];

export default function CrewChat({ params }) {
  const { ws, slug } = use(params);
  const [agent, setAgent] = useState(null);
  const [thread, setThread] = useState([]); // {who:'user'|'crew', text, handover?}
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
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 130px)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 14, paddingBottom: 20, borderBottom: '1px solid var(--line-soft)', marginBottom: 26 }}>
        <Avatar name={agent?.name} />
        <div>
          <strong className="display" style={{ fontSize: 21 }}>{agent?.name ?? ''}</strong>
          <div style={{ fontSize: 12.5, color: 'var(--gold-2)' }}>{agent?.role}</div>
        </div>
        {sessionRef.current && <span className="chip" style={{ marginLeft: 'auto' }}>세션 이어가는 중</span>}
      </header>

      <div className="thread" style={{ flex: 1 }}>
        {thread.length === 0 && !busy && (
          <div className="empty" style={{ marginTop: 20 }}>
            {agent?.tone ? <p style={{ marginBottom: 6, color: 'var(--ink-2)' }}>"{agent.tone}"</p> : null}
            첫 지시를 내려보세요. 매 턴의 결과는 회사 기억에 기록되고, 비슷한 기억끼리 이어집니다.
          </div>
        )}
        {thread.map((m, i) =>
          m.who === 'user' ? (
            <div key={i} className="msg user fade-up">
              <div className="bubble">{m.text}</div>
            </div>
          ) : (
            <div key={i} className="msg crew fade-up">
              <Avatar name={agent?.name} sm />
              <div style={{ minWidth: 0 }}>
                <div className="bubble">
                  <Markdown text={m.text} />
                </div>
                {m.handover && (
                  <a className="memo-chip" href={`/c/${ws}/vault?doc=${encodeURIComponent(m.handover.rel)}`}>
                    <span style={{ color: 'var(--gold)' }}>✦</span>
                    기억에 기록됨
                    {m.handover.linked?.length > 0 && <span>· 관련 기억 {m.handover.linked.length}건과 연결</span>}
                  </a>
                )}
              </div>
            </div>
          )
        )}
        {busy && (
          <div className="msg crew">
            <Avatar name={agent?.name} sm />
            <div className="bubble" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--ink-2)', fontSize: 13 }}>
              <Oars /> {WAIT_STAGES[stage]}…
            </div>
          </div>
        )}
        {error && <p style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</p>}
        <div ref={endRef} />
      </div>

      <form onSubmit={send} className="card" style={{ display: 'flex', gap: 10, padding: 12, alignItems: 'center', position: 'sticky', bottom: 24, marginTop: 26 }}>
        <input
          className="input"
          style={{ border: 'none', background: 'transparent', boxShadow: 'none' }}
          placeholder={`${agent?.name ?? '크루'}에게 지시하기`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <button className="btn btn-gold" disabled={busy || !input.trim()}>보내기</button>
      </form>
    </div>
  );
}
