'use client';
// 회의실 — 사장 + 여러 크루가 한 방에서. "@이름"으로 부르면 그 크루들이 순서대로 발언한다.
// 맥락 공유(제품의 최장점)가 눈에 보이는 화면: 뒤 크루는 앞 크루의 발언을 보고 보탠다.
import { use, useEffect, useRef, useState } from 'react';
import { Avatar, Icon, Markdown, ArgoSpinner, Skeleton, api, imeGuard } from '../../../ui';
import { useLang } from '../../../i18n';

export default function Room({ params }) {
  const { ws } = use(params);
  const { t, lang } = useLang();
  const [agents, setAgents] = useState([]);
  const [messages, setMessages] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);

  function load() {
    api(`/api/companies/${ws}/room`).then((d) => setMessages(d.messages ?? [])).catch(() => setMessages([]));
    api(`/api/companies/${ws}/agents`).then((d) => setAgents(d.agents ?? [])).catch(() => {});
  }
  useEffect(load, [ws]);
  useEffect(() => {
    const iv = setInterval(() => { if (!busy) api(`/api/companies/${ws}/room`).then((d) => setMessages(d.messages ?? [])).catch(() => {}); }, 8000);
    return () => clearInterval(iv);
  }, [ws, busy]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages, busy]);

  const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? slug;

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true); setError('');
    setMessages((m) => [...(m ?? []), { who: 'user', text, ts: Date.now() }]);
    setInput('');
    try {
      const d = await api(`/api/companies/${ws}/room`, { message: text });
      setMessages(d.room?.messages ?? []);
    } catch (err) {
      setError(String(err.message));
    } finally {
      setBusy(false);
    }
  }

  // @자동 힌트 — 입력 끝이 @word면 매칭 크루 제안
  const mention = input.match(/@(\S*)$/);
  const suggests = mention
    ? agents.filter((a) => a.name.toLowerCase().startsWith(mention[1].toLowerCase()) || a.slug.startsWith(mention[1].toLowerCase())).slice(0, 4)
    : [];

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 12, height: 'calc(100vh - 118px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="microlabel">{t('room.header')}</span>
        <span className="rule" style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {agents.map((a) => (
            <button key={a.slug} className="chip" style={{ cursor: 'pointer' }} title={a.role}
              onClick={() => setInput((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}@${a.name} `)}>
              @{a.name}
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: '16px 18px', overflowY: 'auto', minHeight: 0 }}>
        {messages === null ? <Skeleton h={200} /> : messages.length === 0 ? (
          <div className="empty">{t('room.empty')}</div>
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            {messages.map((m, i) => m.who === 'user' ? (
              <div key={i} style={{ justifySelf: 'end', maxWidth: '78%' }}>
                <div className="bubble-user" style={{ background: 'var(--primary)', color: '#fff', borderRadius: 14, padding: '9px 13px', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{m.text}</div>
              </div>
            ) : (
              <div key={i} style={{ display: 'flex', gap: 10, maxWidth: '86%' }}>
                <Avatar name={nameOf(m.who)} size={26} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 650, marginBottom: 3 }}>{nameOf(m.who)}</div>
                  <div style={{ fontSize: 13.5 }}><Markdown text={m.text} /></div>
                </div>
              </div>
            ))}
            {busy && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--fg-2)', fontSize: 12.5 }}>
                <ArgoSpinner size={16} /> {t('room.meeting')}
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        {suggests.length > 0 && (
          <div style={{ display: 'flex', gap: 5 }}>
            {suggests.map((a) => (
              <button key={a.slug} className="chip" style={{ cursor: 'pointer' }}
                onClick={() => setInput(input.replace(/@\S*$/, `@${a.name} `))}>@{a.name} — {a.role}</button>
            ))}
          </div>
        )}
        {error && <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0 }}>{error}</p>}
        <form onSubmit={send} className="input-bar">
          <input suppressHydrationWarning
            placeholder={t('room.placeholder')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            {...imeGuard}
          />
          <button className="btn btn-primary btn-icon" disabled={busy || !input.trim()} aria-label={t('chat.send')}>
            <Icon name="send" size={15} />
          </button>
        </form>
        <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: 0 }}>{t('room.hint')}</p>
      </div>
    </div>
  );
}
