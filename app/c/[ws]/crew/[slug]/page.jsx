'use client';
// 크루 채팅 — 스레드 영속(새로고침해도 이어짐), 카드 열람·편집·해고, 실패 시 재시도.
import { use, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Avatar, Icon, Markdown, ArgoSpinner, Spinner, Skeleton, DangerModal, api, imeGuard } from '../../../../ui';
import { useLang } from '../../../../i18n';

/** 경과 시간 — 1:07 형태. 턴이 도는 동안 1초마다 갱신된다. */
const fmtElapsed = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export default function CrewChat({ params }) {
  const { ws, slug } = use(params);
  const { t } = useLang();
  const WAIT_STAGES = [t('chat.waitStage1'), t('chat.waitStage2'), t('chat.waitStage3')];
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
  // 첨부 — 업로드 즉시 vault/files/에 저장되고, 보내기 전까지 입력바 위에 칩으로 대기한다
  const [att, setAtt] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  // 경과 타이머 — 보낸 순간부터 1초 단위
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);

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

  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    startRef.current = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - startRef.current), 1000);
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

  /** 파일 추가 — 드롭·붙여넣기·클립 버튼 모두 이 관문을 지난다. 업로드 즉시 vault/files/ 저장. */
  async function addFiles(fileList) {
    const files = [...(fileList ?? [])].filter(Boolean);
    if (!files.length || uploading) return;
    setUploading(true); setError('');
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('file', f));
      const r = await fetch(`/api/companies/${ws}/chat/upload`, { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setAtt((cur) => [...cur, ...d.files].slice(0, 8));
    } catch (err) {
      setError(t('chat.attachFailed', { msg: String(err.message) }));
    } finally {
      setUploading(false);
    }
  }

  async function send(e) {
    e.preventDefault();
    const message = input.trim();
    if (!message || busy || uploading) return;
    const attachments = att;
    setInput(''); setAtt([]); setError(''); setBusy(true); setStage(0);
    setThread((t) => [...(t ?? []), { who: 'user', text: message, ...(attachments.length ? { attachments } : {}) }]);
    try {
      const r = await api(`/api/companies/${ws}/chat`, { slug, message, sessionId: sessionRef.current, attachments });
      sessionRef.current = r.sessionId;
      setThread((t) => [...t, { who: 'crew', text: r.reply, handover: r.handover }]);
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (err) {
      // 실패 턴은 서버에 저장되지 않는다 — 입력·첨부를 복원해 바로 재시도할 수 있게
      setThread((cur) => cur.slice(0, -1));
      setInput(message); setAtt(attachments);
      setError(t('chat.turnFailed', { msg: String(err.message) }));
    } finally {
      setBusy(false);
    }
  }

  async function newChat() {
    if (busy) return;
    if (!window.confirm(t('chat.newChatConfirm'))) return;
    await fetch(`/api/companies/${ws}/chat?slug=${encodeURIComponent(slug)}`, { method: 'DELETE' });
    setThread([]); sessionRef.current = null; setError('');
  }

  return (
    <div
      style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 160px)', position: 'relative' }}
      onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
    >
      {dragOver && <div className="drop-overlay">{t('chat.dropHere')}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <Avatar name={agent?.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 650 }}>{agent?.name ?? ''}</div>
          <div style={{ fontSize: 12, color: 'var(--fg-2)' }}>{agent?.role}</div>
        </div>
        {sessionRef.current ? (
          <span className="pill ok"><span className="dot" />{t('chat.sessionOngoing')}</span>
        ) : (
          <span className="pill"><span className="dot" />{t('chat.newSession')}</span>
        )}
        <button className="btn sm" onClick={() => setCardOpen(true)}>{t('chat.card')}</button>
        <button className="btn sm" onClick={newChat} disabled={busy || !(thread?.length)}>{t('chat.newChat')}</button>
      </div>

      <div className="thread" style={{ flex: 1 }}>
        {thread === null && (
          <><Skeleton h={46} w="60%" /><Skeleton h={90} /></>
        )}
        {thread?.length === 0 && !busy && (
          <div className="empty fade-up">
            {agent?.tone && <p style={{ marginBottom: 6, color: 'var(--fg-2)' }}>"{agent.tone}"</p>}
            {t('chat.firstPrompt')}
          </div>
        )}
        {(thread ?? []).map((m, i) =>
          m.who === 'user' ? (
            <div key={i} className="msg-user fade-up">
              {m.attachments?.length > 0 && (
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: m.text ? 8 : 0 }}>
                  {m.attachments.map((a, j) => a.isImage ? (
                    <img key={j} className="att-thumb" src={`/api/companies/${ws}/files?rel=${encodeURIComponent(a.rel)}`} alt={a.name} />
                  ) : (
                    <span key={j} className="att-chip" style={{ borderColor: 'var(--primary-fg-line)', background: 'transparent', color: 'inherit' }}>
                      <Icon name="clip" size={11} /><span className="name">{a.name}</span>
                    </span>
                  ))}
                </span>
              )}
              {m.text}
            </div>
          ) : (
            <div key={i} className="msg-crew fade-up">
              <Avatar name={agent?.name} sm />
              <div className="card" style={{ minWidth: 0, padding: '13px 16px' }}>
                <Markdown text={m.text} />
                {m.handover && (
                  <a className="memo-chip" href={`/c/${ws}/vault?doc=${encodeURIComponent(m.handover.rel)}`}>
                    <Icon name="memory" size={12} />
                    {t('chat.recordedInMemory')}
                    {m.handover.linked?.length > 0 && <span>{t('chat.linkedMemories', { n: m.handover.linked.length })}</span>}
                  </a>
                )}
              </div>
            </div>
          )
        )}
        {busy && (
          <div className="msg-crew">
            <Avatar name={agent?.name} sm />
            <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, color: 'var(--fg-2)', fontSize: 13, flex: 1, minWidth: 0 }}>
              <ArgoSpinner size={15} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t('chat.stageEllipsis', { stage: liveStage?.stage ?? WAIT_STAGES[stage] })}
                {liveStage?.detail && (
                  <span className="mono" style={{ fontSize: 11, color: 'var(--fg-3)', marginLeft: 8 }}>{liveStage.detail}</span>
                )}
              </span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums', flex: 'none' }}>
                {fmtElapsed(elapsed)}
              </span>
            </div>
          </div>
        )}
        {error && <p style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</p>}
        <div ref={endRef} />
      </div>

      <div style={{ position: 'sticky', bottom: 20, marginTop: 24, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(att.length > 0 || uploading) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {att.map((a, i) => (
              <span key={i} className="att-chip">
                <Icon name="clip" size={11} />
                <span className="name">{a.name}</span>
                <button type="button" onClick={() => setAtt((c) => c.filter((_, j) => j !== i))} aria-label={t('common.delete')}>✕</button>
              </span>
            ))}
            {uploading && <span className="att-chip"><Spinner size={11} /> {t('chat.uploading')}</span>}
          </div>
        )}
        <form onSubmit={send} className="input-bar" style={{ background: 'var(--card-2)' }}>
          <button type="button" className="btn btn-icon sm" style={{ border: 0, flex: 'none', color: 'var(--fg-3)' }}
            onClick={() => fileRef.current?.click()} disabled={busy} aria-label={t('chat.attach')} title={t('chat.attach')}>
            <Icon name="clip" size={14} />
          </button>
          <input hidden multiple type="file" ref={fileRef} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <input suppressHydrationWarning
            placeholder={t('chat.inputPlaceholder', { name: agent?.name ?? t('chat.crewFallback') })}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
            disabled={busy}
            autoFocus
            {...imeGuard}
          />
          <button className="btn btn-primary btn-icon" disabled={busy || uploading || !input.trim()} aria-label={t('chat.send')}>
            <Icon name="send" size={15} />
          </button>
        </form>
      </div>

      {cardOpen && (
        <CardPanel
          agentName={agent?.name}
          ws={ws}
          slug={slug}
          onClose={() => setCardOpen(false)}
          onFired={() => { window.dispatchEvent(new Event('argo:refresh')); router.push(`/c/${ws}`); }}
        />
      )}
    </div>
  );
}

/** 카드 패널 — 카드가 곧 시스템 프롬프트. 열람·편집·해고(깃헙식 확인). */
function CardPanel({ ws, slug, agentName, onClose, onFired }) {
  const { t } = useLang();
  const [md, setMd] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [fireOpen, setFireOpen] = useState(false);
  const [firing, setFiring] = useState(false);

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
      setMsg(t('chat.saved'));
    } catch (e) {
      setMsg(String(e.message));
    } finally {
      setSaving(false);
    }
  }

  async function fire() {
    setFiring(true);
    await fetch(`/api/companies/${ws}/agents/${slug}`, { method: 'DELETE' });
    onFired();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'var(--overlay)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <div className="card fade-up" style={{ width: 'min(680px, 100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title">{t('chat.cardTitle')}</span>
          <span className="microlabel">{t('chat.systemPromptEq')}</span>
          <span className="rule" />
          <button className="btn sm" onClick={onClose}>{t('chat.closeEsc')}</button>
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
              {saving ? <Spinner size={12} /> : t('chat.save')}
            </button>
            <span style={{ fontSize: 12, color: msg === t('chat.saved') ? 'var(--fg-2)' : 'var(--danger)' }}>{msg}</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => setFireOpen(true)}>{t('chat.fire')}</button>
          </div>
        </div>
      </div>
      {fireOpen && (
        <DangerModal
          title={t('chat.fireTitle')}
          description={t('chat.fireDesc')}
          requireText={agentName || slug}
          phraseKey="danger.phrase.fire"
          confirmLabel={t('chat.fireConfirm')}
          busy={firing}
          onConfirm={fire}
          onClose={() => setFireOpen(false)}
        />
      )}
    </div>
  );
}
