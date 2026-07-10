'use client';
// 크루 채팅 — 스레드 영속(새로고침해도 이어짐), 카드 열람·편집·해고, 실패 시 재시도.
import { use, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar, Icon, Markdown, Dots, Spinner, Skeleton, api, imeGuard } from '../../../../ui';

const WAIT_STAGES = ['기억을 살피는 중', '작업 중', '결과를 정리하는 중'];

export default function CrewChat({ params }) {
  const { ws, slug } = use(params);
  const router = useRouter();
  const [agent, setAgent] = useState(null);
  const [thread, setThread] = useState(null); // null = 로딩
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState('');
  const [cardOpen, setCardOpen] = useState(false);
  const sessionRef = useRef(null);
  const endRef = useRef(null);

  useEffect(() => {
    setThread(null); setError(''); sessionRef.current = null;
    api(`/api/companies/${ws}`)
      .then((d) => setAgent(d.agents.find((a) => a.slug === slug) ?? { name: slug, role: '' }))
      .catch(() => setAgent({ name: slug, role: '' }));
    api(`/api/companies/${ws}/chat?slug=${encodeURIComponent(slug)}`)
      .then((t) => { setThread(t.messages ?? []); sessionRef.current = t.sessionId ?? null; })
      .catch(() => setThread([]));
  }, [ws, slug]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [thread, busy]);

  // 다른 창구(텔레그램·슬랙·루틴·결재 후속)에서 붙은 대화를 웹에도 반영 — 채널을 오가도 맥락은 하나다.
  useEffect(() => {
    const t = setInterval(() => {
      if (busy) return; // 내가 보내는 중엔 낙관적 UI를 덮지 않는다
      api(`/api/companies/${ws}/chat?slug=${encodeURIComponent(slug)}`)
        .then((r) => {
          const msgs = r.messages ?? [];
          setThread((cur) => (cur !== null && msgs.length > cur.length ? msgs : cur));
          if (r.sessionId) sessionRef.current = r.sessionId;
        })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, [ws, slug, busy]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setStage((s) => Math.min(s + 1, WAIT_STAGES.length - 1)), 14000);
    return () => clearInterval(t);
  }, [busy]);

  // 실제 진행 단계 폴 — "작성중" 대신 지금 무엇을 하는지(기억 탐색/명령 실행/결재 대기)를 보여준다
  const [liveStage, setLiveStage] = useState(null);
  useEffect(() => {
    if (!busy) { setLiveStage(null); return; }
    const t = setInterval(() => {
      api(`/api/companies/${ws}/chat?slug=${encodeURIComponent(slug)}`)
        .then((r) => setLiveStage(r.status ?? null))
        .catch(() => {});
    }, 2500);
    return () => clearInterval(t);
  }, [busy, ws, slug]);

  async function send(e) {
    e.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput(''); setError(''); setBusy(true); setStage(0);
    setThread((t) => [...(t ?? []), { who: 'user', text: message }]);
    try {
      const r = await api(`/api/companies/${ws}/chat`, { slug, message, sessionId: sessionRef.current });
      sessionRef.current = r.sessionId;
      setThread((t) => [...t, { who: 'crew', text: r.reply, handover: r.handover }]);
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (err) {
      // 실패 턴은 서버에 저장되지 않는다 — 입력을 복원해 바로 재시도할 수 있게
      setThread((t) => t.slice(0, -1));
      setInput(message);
      setError(`턴 실패: ${String(err.message)} — 입력을 복원했습니다. 다시 보내보세요.`);
    } finally {
      setBusy(false);
    }
  }

  async function newChat() {
    if (busy) return;
    if (!window.confirm('새 대화를 시작할까요? 지금 스레드는 지워지지만, 회사 기억(vault)은 그대로 남습니다.')) return;
    await fetch(`/api/companies/${ws}/chat?slug=${encodeURIComponent(slug)}`, { method: 'DELETE' });
    setThread([]); sessionRef.current = null; setError('');
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 160px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <Avatar name={agent?.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 650 }}>{agent?.name ?? ''}</div>
          <div style={{ fontSize: 12, color: 'var(--fg-2)' }}>{agent?.role}</div>
        </div>
        {sessionRef.current ? (
          <span className="pill ok"><span className="dot" />세션 이어가는 중</span>
        ) : (
          <span className="pill"><span className="dot" />새 세션</span>
        )}
        <button className="btn sm" onClick={() => setCardOpen(true)}>카드</button>
        <button className="btn sm" onClick={newChat} disabled={busy || !(thread?.length)}>새 대화</button>
      </div>

      <div className="thread" style={{ flex: 1 }}>
        {thread === null && (
          <><Skeleton h={46} w="60%" /><Skeleton h={90} /></>
        )}
        {thread?.length === 0 && !busy && (
          <div className="empty fade-up">
            {agent?.tone && <p style={{ marginBottom: 6, color: 'var(--fg-2)' }}>"{agent.tone}"</p>}
            첫 지시를 내려보세요. 매 턴의 결과는 회사 기억에 남고, 비슷한 기억끼리 이어집니다.
          </div>
        )}
        {(thread ?? []).map((m, i) =>
          m.who === 'user' ? (
            <div key={i} className="msg-user fade-up">{m.text}</div>
          ) : (
            <div key={i} className="msg-crew fade-up">
              <Avatar name={agent?.name} sm />
              <div className="card" style={{ minWidth: 0, padding: '13px 16px' }}>
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
            <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, color: 'var(--fg-2)', fontSize: 13 }}>
              <Dots /> {liveStage ?? WAIT_STAGES[stage]}…
            </div>
          </div>
        )}
        {error && <p style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</p>}
        <div ref={endRef} />
      </div>

      <form onSubmit={send} className="input-bar" style={{ position: 'sticky', bottom: 20, marginTop: 24, background: 'var(--card-2)' }}>
        <input suppressHydrationWarning
          placeholder={`${agent?.name ?? '크루'}에게 지시하기`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          autoFocus
          {...imeGuard}
        />
        <button className="btn btn-primary btn-icon" disabled={busy || !input.trim()} aria-label="보내기">
          <Icon name="send" size={15} />
        </button>
      </form>

      {cardOpen && (
        <CardPanel
          ws={ws}
          slug={slug}
          onClose={() => setCardOpen(false)}
          onFired={() => { window.dispatchEvent(new Event('argo:refresh')); router.push(`/c/${ws}`); }}
        />
      )}
    </div>
  );
}

/** 카드 패널 — 카드가 곧 시스템 프롬프트. 열람·편집·해고. */
function CardPanel({ ws, slug, onClose, onFired }) {
  const [md, setMd] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api(`/api/companies/${ws}/agents/${slug}`)
      .then((d) => setMd(d.md))
      .catch((e) => setMsg(String(e.message)));
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ws, slug, onClose]);

  async function save() {
    if (saving || md === null) return;
    setSaving(true); setMsg('');
    try {
      await fetch(`/api/companies/${ws}/agents/${slug}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ md }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
      window.dispatchEvent(new Event('argo:refresh'));
      setMsg('저장됨 — 다음 턴부터 반영됩니다.');
    } catch (e) {
      setMsg(String(e.message));
    } finally {
      setSaving(false);
    }
  }

  async function fire() {
    if (!window.confirm('이 크루를 해고할까요? 카드는 .archive/로 보관되고, 남긴 기억은 회사에 그대로 남습니다.')) return;
    await fetch(`/api/companies/${ws}/agents/${slug}`, { method: 'DELETE' });
    onFired();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(37,39,30,0.25)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <div className="card fade-up" style={{ width: 'min(680px, 100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title">크루 카드</span>
          <span className="microlabel">= System Prompt</span>
          <span className="rule" />
          <button className="btn sm" onClick={onClose}>닫기 ESC</button>
        </div>
        <div style={{ padding: '0 20px 18px', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          {md === null ? (
            <Skeleton h={220} />
          ) : (
            <textarea
              value={md}
              onChange={(e) => setMd(e.target.value)}
              spellCheck={false}
              style={{
                width: '100%', minHeight: 320, resize: 'vertical',
                background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12,
                padding: '12px 14px', outline: 'none',
                fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.65,
              }}
            />
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-primary sm" onClick={save} disabled={saving || md === null}>
              {saving ? <Spinner size={12} /> : '저장'}
            </button>
            <span style={{ fontSize: 12, color: msg.includes('저장됨') ? 'var(--fg-2)' : 'var(--danger)' }}>{msg}</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={fire}>해고</button>
          </div>
        </div>
      </div>
    </div>
  );
}
