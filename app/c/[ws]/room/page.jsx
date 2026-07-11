'use client';
// 회의실 — 사장 + 여러 크루가 한 방에서. "@이름"으로 부르면 그 크루들이 순서대로 발언한다.
// 좌측 레일에 지난 회의가 적재되고(회의 마치기), 클릭으로 읽기 전용 열람 — 맥락 공유가 눈에 보이는 화면.
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Icon, Markdown, ArgoSpinner, Skeleton, api, imeGuard } from '../../../ui';
import { useLang } from '../../../i18n';

export default function Room({ params }) {
  const { ws } = use(params);
  const { t } = useLang();
  const [agents, setAgents] = useState([]);
  const [messages, setMessages] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef(null);
  // 회의 적재 레일 — 마친 회의들이 좌측에 쌓인다
  const [sessions, setSessions] = useState([]);
  const [viewing, setViewing] = useState(null); // 보관 회의 id (null = 현재 회의)
  const [archMsgs, setArchMsgs] = useState(null);

  const loadSessions = useCallback(() => {
    api(`/api/companies/${ws}/room/sessions`).then((d) => setSessions(d.sessions ?? [])).catch(() => {});
  }, [ws]);

  function load() {
    api(`/api/companies/${ws}/room`).then((d) => setMessages(d.messages ?? [])).catch(() => setMessages([]));
    api(`/api/companies/${ws}/agents`).then((d) => setAgents(d.agents ?? [])).catch(() => {});
  }
  useEffect(load, [ws]);
  useEffect(loadSessions, [loadSessions]);
  useEffect(() => {
    const iv = setInterval(() => { if (!busy) api(`/api/companies/${ws}/room`).then((d) => setMessages(d.messages ?? [])).catch(() => {}); }, 8000);
    return () => clearInterval(iv);
  }, [ws, busy]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages, busy]);

  const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? slug;

  async function openSession(id) {
    if (!id) { setViewing(null); setArchMsgs(null); return; }
    try {
      const d = await api(`/api/companies/${ws}/room/sessions?id=${encodeURIComponent(id)}`);
      setViewing(id); setArchMsgs(d.messages ?? []);
    } catch (e) { setError(String(e.message)); }
  }

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

  async function endMeeting() {
    if (busy || !window.confirm(t('room.endConfirm'))) return;
    try {
      const r = await fetch(`/api/companies/${ws}/room`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setMessages([]); setError('');
      loadSessions(); // 방금 마친 회의가 좌측 레일에 적재된다
      window.dispatchEvent(new Event('argo:refresh')); // 항해일지에 회의록이 바로 잡힌다
    } catch (e2) { setError(String(e2.message)); }
  }

  // @자동 힌트 — 입력 끝이 @word면 매칭 크루 제안
  const mention = input.match(/@(\S*)$/);
  const suggests = mention
    ? agents.filter((a) => a.name.toLowerCase().startsWith(mention[1].toLowerCase()) || a.slug.startsWith(mention[1].toLowerCase())).slice(0, 4)
    : [];

  const shown = viewing ? archMsgs : messages;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '216px minmax(0, 1fr)', gap: 18, alignItems: 'start', height: 'calc(100vh - 118px)' }}>
      {/* 회의 레일 — 마친 회의가 적재된다. 무템플릿 grid 함정 방지: minmax(0,1fr) */}
      <div style={{ position: 'sticky', top: 72, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, width: 216 }}>
        <span className="microlabel" style={{ padding: '2px 6px 4px' }}>
          {t('room.sessions.title')}{sessions.length ? ` · ${sessions.length}` : ''}
        </span>
        <button className={`nav-item${!viewing ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => openSession(null)}>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{t('room.sessions.current')}</span>
            <span className="nav-sub">{messages?.length ? t('chat.sessions.msgs', { n: messages.length }) : t('room.sessions.idle')}</span>
          </span>
        </button>
        {sessions.map((s) => (
          <button key={s.id} className={`nav-item${viewing === s.id ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => openSession(s.id)}>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.topic || t('chat.sessions.untitled')}</span>
              <span className="nav-sub">{new Date(s.ts).toLocaleDateString('sv-SE')} · {t('chat.sessions.msgs', { n: s.count })}</span>
            </span>
          </button>
        ))}
        {sessions.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--fg-3)', padding: '2px 6px', lineHeight: 1.5 }}>{t('room.sessions.empty')}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 12, height: '100%', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="microlabel">{t('room.header')}</span>
          <span className="rule" style={{ flex: 1 }} />
          {!viewing && (messages?.length ?? 0) > 0 && (
            <button className="btn sm" disabled={busy} onClick={endMeeting}>{t('room.end')}</button>
          )}
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
          {shown === null ? <Skeleton h={200} /> : shown.length === 0 ? (
            <div className="empty">{t('room.empty')}</div>
          ) : (
            <div style={{ display: 'grid', gap: 14 }}>
              {shown.map((m, i) => m.who === 'user' ? (
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
              {!viewing && busy && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--fg-2)', fontSize: 12.5 }}>
                  <ArgoSpinner size={16} /> {t('room.meeting')}
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {viewing ? (
          <div className="card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--fg-2)' }}>
            <Icon name="doc" size={13} /> {t('room.sessions.readonly')}
            <span style={{ flex: 1 }} />
            <button className="btn btn-primary sm" onClick={() => openSession(null)}>{t('chat.sessions.back')}</button>
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}
