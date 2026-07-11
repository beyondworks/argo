'use client';
// 크루 채팅 — 스레드 영속(새로고침해도 이어짐), 카드 열람·편집·해고, 실패 시 재시도.
import { use, useCallback, useEffect, useRef, useState } from 'react';
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
  // 세션 적재 레일 — 새 대화로 넘긴 이전 대화들이 좌측에 쌓이고, 클릭으로 읽기 전용 열람
  const [sessions, setSessions] = useState([]);
  const [viewing, setViewing] = useState(null); // 보관 세션 id (null = 현재 대화)
  const [archMsgs, setArchMsgs] = useState(null);
  const loadSessions = useCallback(() => {
    api(`/api/companies/${ws}/chat/sessions?slug=${encodeURIComponent(slug)}`)
      .then((d) => setSessions(d.sessions ?? [])).catch(() => {});
  }, [ws, slug]);
  useEffect(loadSessions, [loadSessions]);
  async function openSession(id) {
    if (!id) { setViewing(null); setArchMsgs(null); return; }
    try {
      const d = await api(`/api/companies/${ws}/chat/sessions?slug=${encodeURIComponent(slug)}&id=${encodeURIComponent(id)}`);
      setViewing(id); setArchMsgs(d.messages ?? []);
    } catch (e) { setError(String(e.message)); }
  }
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
  // 실제 진행 단계 — "작성중" 대신 지금 무엇을 하는지 (기억 탐색/명령 실행/결재 대기)
  const [liveStage, setLiveStage] = useState(null);

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
          setLiveStage(r.status ?? null); // 결재 후속·루틴·메신저발 턴도 진행 카드가 보인다
        })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, [ws, slug, busy]);

  // 이 크루의 대기 결재 — 대화창에서 바로 승인/거절 (데크 결재함은 백업 창구)
  const [pendings, setPendings] = useState([]);
  const [resolving, setResolving] = useState('');
  useEffect(() => {
    let alive = true;
    const pull = () => api(`/api/companies/${ws}/approvals`)
      .then((d) => { if (alive) setPendings((d.approvals ?? []).filter((a) => a.status === 'pending' && a.slug === slug)); })
      .catch(() => {});
    pull();
    const t1 = setInterval(pull, busy ? 2500 : 5000);
    return () => { alive = false; clearInterval(t1); };
  }, [ws, slug, busy]);

  async function resolvePending(id, approve) {
    if (resolving) return;
    setResolving(id);
    try {
      await api(`/api/companies/${ws}/approvals`, { id, approve });
      setPendings((cur) => cur.filter((p) => p.id !== id));
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) {
      setError(String(e.message));
    } finally {
      setResolving('');
    }
  }

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setStage((s) => Math.min(s + 1, WAIT_STAGES.length - 1)), 14000);
    return () => clearInterval(t);
  }, [busy]);

  const working = busy || !!liveStage; // 내가 보낸 턴 + 결재 후속·루틴·메신저발 턴
  useEffect(() => {
    if (!working) { setElapsed(0); return; }
    if (busy) startRef.current = Date.now();
    const tick = () => setElapsed(Date.now() - (busy ? startRef.current : (liveStage?.startedAt ?? Date.now())));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [busy, working, liveStage?.startedAt]);

  // 진행 단계 고빈도 폴 — 내 턴이 도는 동안 2.5초 간격
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
    setViewing(null); setArchMsgs(null);
    loadSessions(); // 방금 넘긴 대화가 좌측 레일에 적재된다
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '216px minmax(0, 1fr)', gap: 18, alignItems: 'start' }}>
      {/* 세션 레일 — 대화가 여기 적재된다. 무템플릿 grid는 트랙이 max-content로 자라 긴 제목이 폭을 밀어낸다 — minmax(0,1fr) 고정 */}
      <div style={{ position: 'sticky', top: 72, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, width: 216 }}>
        <span className="microlabel" style={{ padding: '2px 6px 4px' }}>
          {t('chat.sessions.title')}{sessions.length ? ` · ${sessions.length + 1}` : ''}
        </span>
        <button className={`nav-item${!viewing ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => openSession(null)}>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{t('chat.sessions.current')}</span>
            <span className="nav-sub">{thread?.length ? t('chat.sessions.msgs', { n: thread.length }) : t('chat.newSession')}</span>
          </span>
        </button>
        {sessions.map((s) => (
          <button key={s.id} className={`nav-item${viewing === s.id ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => openSession(s.id)}>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.gist || t('chat.sessions.untitled')}</span>
              <span className="nav-sub">{new Date(s.ts).toLocaleDateString('sv-SE')} · {t('chat.sessions.msgs', { n: s.count })}</span>
            </span>
          </button>
        ))}
        {sessions.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--fg-3)', padding: '2px 6px', lineHeight: 1.5 }}>{t('chat.sessions.empty')}</span>}
      </div>
    <div
      style={{ maxWidth: 760, width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 160px)', position: 'relative' }}
      onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
    >
      {dragOver && <div className="drop-overlay">{t('chat.dropHere')}</div>}
      {/* 스티키 헤더 — 긴 대화를 내려도 이름·카드·새 대화가 항상 손에 닿는다(topbar 56px 아래 고정).
          배경은 블러+반투명 — 단색(--bg)은 그라데이션 캔버스 테마에서 이질적인 띠로 보인다 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12,
        position: 'sticky', top: 56, zIndex: 15, padding: '12px 14px 10px',
        margin: '0 -14px 12px',
        background: 'color-mix(in srgb, var(--bg) 62%, transparent)',
        backdropFilter: 'blur(16px) saturate(1.3)', WebkitBackdropFilter: 'blur(16px) saturate(1.3)',
        borderRadius: '0 0 14px 14px',
      }}>
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
        {!viewing && thread?.length === 0 && !busy && (
          <div className="empty fade-up">
            {agent?.tone && <p style={{ marginBottom: 6, color: 'var(--fg-2)' }}>"{agent.tone}"</p>}
            {t('chat.firstPrompt')}
          </div>
        )}
        {((viewing ? archMsgs : thread) ?? []).map((m, i) =>
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
        {!viewing && pendings.map((p) => (
          <div key={p.id} className="msg-crew fade-up">
            <Avatar name={agent?.name} sm />
            <div className="card" style={{ padding: '13px 16px', minWidth: 0, flex: 1, borderColor: 'var(--accent)' }}>
              <div className="microlabel" style={{ marginBottom: 6, color: 'var(--accent)' }}>
                {p.kind === 'capability' ? t('chat.approval.capTitle') : t('chat.approval.pendingTitle')}
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 650 }}>{p.action}</div>
              {p.reason && <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: '4px 0 0', lineHeight: 1.55 }}>{p.reason}</p>}
              <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
                <button className="btn btn-primary sm" disabled={!!resolving} onClick={() => resolvePending(p.id, true)}>
                  {resolving === p.id ? <Spinner size={12} /> : (p.kind === 'capability' ? t('chat.approval.yes') : t('common.approve'))}
                </button>
                <button className="btn sm" disabled={!!resolving} onClick={() => resolvePending(p.id, false)}>
                  {p.kind === 'capability' ? t('chat.approval.no') : t('common.reject')}
                </button>
              </div>
            </div>
          </div>
        ))}
        {!viewing && working && (
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

      {viewing ? (
        <div className="card" style={{ position: 'sticky', bottom: 20, marginTop: 24, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--fg-2)' }}>
          <Icon name="doc" size={13} /> {t('chat.sessions.readonly')}
          <span style={{ flex: 1 }} />
          <button className="btn btn-primary sm" onClick={() => openSession(null)}>{t('chat.sessions.back')}</button>
        </div>
      ) : (
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
      )}

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
    </div>
  );
}

/** 카드 패널 — 카드가 곧 시스템 프롬프트. 열람·편집·해고(깃헙식 확인). */
function CardPanel({ ws, slug, agentName, onClose, onFired }) {
  const { t, fmtMoney } = useLang();
  const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));
  const [md, setMd] = useState(null);
  const [profile, setProfile] = useState({ recent: [], skills: [] });
  const [meta, setMeta] = useState({});
  const [stats, setStats] = useState(null); // { turns, contextTotal, output, costUsd, avgMs, topTools }
  const [ruleInput, setRuleInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [fireOpen, setFireOpen] = useState(false);
  const [firing, setFiring] = useState(false);
  // 기억 카드 — 회사가 아는 사장 (vault/notes/사장-프로필.md)
  const [boss, setBoss] = useState(null); // { items: [{section, text}] }
  const [bossInput, setBossInput] = useState('');
  const [bossSection, setBossSection] = useState('취향');
  async function saveBoss(items) {
    try {
      const r = await fetch(`/api/companies/${ws}/boss-profile`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setBoss(d);
    } catch (e) { setMsg(String(e.message)); }
  }
  // 텔레그램 직통 봇 — 이 크루의 개인 연락처
  const [tgBot, setTgBot] = useState(null); // { hasToken, botUsername, paired }
  const [tgAlive, setTgAlive] = useState(false);
  const [tgToken, setTgToken] = useState('');
  const [tgBusy, setTgBusy] = useState(false);
  const [tgMsg, setTgMsg] = useState('');

  const loadTg = useCallback(() => {
    api(`/api/companies/${ws}/connections`).then((d) => {
      setTgBot(d.connections?.telegram?.agents?.[slug] ?? { hasToken: false });
      setTgAlive(!!d.gateway?.agents?.[slug]?.alive);
    }).catch(() => {});
  }, [ws, slug]);

  useEffect(() => {
    api(`/api/companies/${ws}/agents/${slug}`)
      .then((d) => { setMd(d.md); setMeta(d.meta ?? {}); setStats(d.stats ?? null); setProfile({ recent: d.recent ?? [], skills: d.skills ?? [] }); })
      .catch((e) => setMsg(String(e.message)));
    api(`/api/companies/${ws}/boss-profile`).then(setBoss).catch(() => setBoss({ items: [] }));
    loadTg();
    const iv = setInterval(loadTg, 10000);
    return () => clearInterval(iv);
  }, [ws, slug, loadTg]);

  async function tgConnect() {
    if (tgBusy || !tgToken.trim()) return;
    setTgBusy(true); setTgMsg('');
    try {
      const d = await api(`/api/companies/${ws}/agents/${slug}/telegram`, { token: tgToken });
      setTgBot(d.connections?.telegram?.agents?.[slug] ?? { hasToken: true });
      setTgToken(''); setTgMsg(t('chat.tg.pairHint'));
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) { setTgMsg(String(e.message)); } finally { setTgBusy(false); }
  }
  async function tgDisconnect() {
    if (tgBusy) return;
    setTgBusy(true); setTgMsg('');
    try {
      await fetch(`/api/companies/${ws}/agents/${slug}/telegram`, { method: 'DELETE' });
      setTgBot({ hasToken: false }); setTgAlive(false);
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (e) { setTgMsg(String(e.message)); } finally { setTgBusy(false); }
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(next = md) {
    if (saving || next === null) return;
    setSaving(true); setMsg('');
    try {
      await fetch(`/api/companies/${ws}/agents/${slug}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ md: next }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
      window.dispatchEvent(new Event('argo:refresh'));
      setMsg(t('chat.saved'));
    } catch (e) {
      setMsg(String(e.message));
    } finally {
      setSaving(false);
    }
  }

  // 규칙(## 일하는 방식) — 카드 md에서 파싱해 보여주고, 추가하면 그 섹션에 불릿으로 append 후 즉시 저장
  const rules = (() => {
    const m = (md ?? '').match(/## 일하는 방식\s*\n([\s\S]*?)(?=\n## |$)/);
    return m ? m[1].split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter((l) => l && !l.startsWith('(')) : [];
  })();
  function addRule() {
    const text = ruleInput.trim();
    if (!text || md === null) return;
    const h = '## 일하는 방식';
    let next;
    const i = md.indexOf(h);
    if (i === -1) {
      next = `${md.trimEnd()}\n\n${h}\n- ${text}\n`;
    } else {
      const rest = md.indexOf('\n## ', i + h.length);
      const end = rest === -1 ? md.length : rest;
      next = `${md.slice(0, end).trimEnd()}\n- ${text}\n${rest === -1 ? '' : md.slice(end)}`;
    }
    setMd(next); setRuleInput('');
    save(next);
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
        <div style={{ padding: '0 20px 18px', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflowY: 'auto' }}>
          {/* 크루 프로필 — 자주 하는 업무와 적용 스킬이 카드에서 한눈에 */}
          <div style={{ display: 'grid', gap: 8 }}>
            <span className="microlabel">{t('chat.recentWork')}</span>
            {profile.recent.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{t('chat.noRecentWork')}</span>
            ) : (
              <div style={{ display: 'grid', gap: 3 }}>
                {profile.recent.slice(0, 5).map((r, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--fg-2)', display: 'flex', gap: 7, alignItems: 'center', minWidth: 0 }}>
                    <span style={{ width: 5, height: 5, borderRadius: 999, flex: 'none', background: r.ok ? 'var(--ok)' : 'var(--danger)' }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.gist}</span>
                  </div>
                ))}
              </div>
            )}
            {profile.skills.length > 0 && (
              <>
                <span className="microlabel" style={{ marginTop: 4 }}>{t('chat.activeSkills')} · {profile.skills.length}</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {profile.skills.map((s) => <span key={s.id} className="chip">{s.title}</span>)}
                </div>
              </>
            )}
          </div>
          {/* 상세 정보 — 처리량·토큰·비용·많이 쓴 도구 (usage.jsonl 집계) */}
          <div style={{ display: 'grid', gap: 8 }}>
            <span className="microlabel">
              {t('chat.card.stats')}
              {(meta.runner || meta.model) && (
                <span className="mono" style={{ marginLeft: 8, color: 'var(--fg-3)', textTransform: 'none', letterSpacing: 0 }}>
                  {meta.runner || 'claude'}{meta.model ? ` · ${meta.model}` : ''}
                </span>
              )}
            </span>
            {!stats || stats.turns === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{t('chat.card.noStats')}</span>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                  {[
                    [t('chat.card.turns'), String(stats.turns)],
                    [t('chat.card.tokens'), `${fmtTok(stats.contextTotal)} / ${fmtTok(stats.output)}`],
                    [t('chat.card.cost'), stats.costUsd != null ? fmtMoney(stats.costUsd, { approx: false }) : '—'],
                    [t('chat.card.avgTime'), stats.avgMs != null ? `${(stats.avgMs / 1000).toFixed(0)}s` : '—'],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <div className="mono" style={{ fontSize: 15, fontWeight: 650 }}>{v}</div>
                      <div className="microlabel" style={{ marginTop: 2 }}>{k}</div>
                    </div>
                  ))}
                </div>
                {stats.topTools?.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                    <span className="microlabel">{t('chat.card.topTools')}</span>
                    {stats.topTools.map((tool) => (
                      <span key={tool.name} className="chip mono" style={{ fontSize: 10.5 }}>{tool.name} ×{tool.count}</span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          {/* 규칙 — 카드의 "일하는 방식" 섹션을 그대로 파싱. 추가하면 카드에 불릿으로 붙고 즉시 저장 */}
          <div style={{ display: 'grid', gap: 7 }}>
            <span className="microlabel">{t('chat.card.rules')} · {rules.length}</span>
            {rules.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{t('chat.card.noRules')}</span>
            ) : (
              <div style={{ display: 'grid', gap: 4 }}>
                {rules.map((r, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--fg-2)', display: 'flex', gap: 7 }}>
                    <span style={{ color: 'var(--fg-3)', flex: 'none' }}>{i + 1}.</span>
                    <span>{r}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <input suppressHydrationWarning value={ruleInput} onChange={(e) => setRuleInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); addRule(); } }}
                placeholder={t('chat.card.addRulePh')}
                style={{ flex: 1, height: 30, padding: '0 10px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12 }} />
              <button className="btn sm" disabled={saving || !ruleInput.trim()} onClick={addRule}>{t('chat.card.add')}</button>
            </div>
          </div>
          {/* 기억 카드 — 회사가 아는 사장. 크루가 대화에서 자동 축적, 여기서 정정("그거 잊어") */}
          <div style={{ display: 'grid', gap: 7 }}>
            <span className="microlabel">{t('chat.boss.title')}{boss?.items?.length ? ` · ${boss.items.length}` : ''}</span>
            {!boss ? <Skeleton h={40} /> : boss.items.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{t('chat.boss.empty')}</span>
            ) : (
              <div style={{ display: 'grid', gap: 4 }}>
                {boss.items.map((it, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--fg-2)', display: 'flex', gap: 7, alignItems: 'center', minWidth: 0 }}>
                    <span className="chip" style={{ flex: 'none', fontSize: 10 }}>{t(`chat.boss.sec.${it.section}`)}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>{it.text}</span>
                    <button className="btn sm" style={{ flex: 'none', padding: '1px 8px', fontSize: 10.5 }}
                      title={t('chat.boss.forget')}
                      onClick={() => saveBoss(boss.items.filter((_, j) => j !== i))}>
                      {t('chat.boss.forget')}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select value={bossSection} onChange={(e) => setBossSection(e.target.value)}
                style={{ height: 30, padding: '0 8px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12 }}>
                {['취향', '결정', '금지'].map((s) => <option key={s} value={s}>{t(`chat.boss.sec.${s}`)}</option>)}
              </select>
              <input suppressHydrationWarning value={bossInput} onChange={(e) => setBossInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && bossInput.trim()) { e.preventDefault(); saveBoss([...(boss?.items ?? []), { section: bossSection, text: bossInput.trim() }]); setBossInput(''); } }}
                placeholder={t('chat.boss.addPh')}
                style={{ flex: 1, height: 30, padding: '0 10px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12 }} />
              <button className="btn sm" disabled={!bossInput.trim()}
                onClick={() => { saveBoss([...(boss?.items ?? []), { section: bossSection, text: bossInput.trim() }]); setBossInput(''); }}>
                {t('chat.card.add')}
              </button>
            </div>
          </div>
          {/* 텔레그램 직통 봇 — 이 크루의 개인 연락처. 연결되면 그린 도트 */}
          <div style={{ display: 'grid', gap: 7, padding: '12px 14px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="microlabel">{t('chat.tg.title')}</span>
              {tgBot?.hasToken && (
                <span className="chip" style={{ color: tgAlive ? 'var(--ok)' : 'var(--warn)', borderColor: 'currentColor' }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: 'currentColor', display: 'inline-block', marginRight: 5 }} />
                  {tgAlive ? t('chat.tg.live') : t('chat.tg.waiting')}
                  {tgBot.paired ? ` · ${t('chat.tg.paired')}` : ''}
                </span>
              )}
              {tgBot?.botUsername && <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)' }}>{tgBot.botUsername}</span>}
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('chat.tg.help')}</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {tgBot?.hasToken ? (
                <button className="btn sm" disabled={tgBusy} onClick={tgDisconnect}>{t('chat.tg.disconnect')}</button>
              ) : (
                <>
                  <input suppressHydrationWarning type="password" value={tgToken} onChange={(e) => setTgToken(e.target.value)}
                    placeholder={t('chat.tg.placeholder')}
                    style={{ flex: 1, height: 30, padding: '0 10px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12 }} />
                  <button className="btn btn-primary sm" disabled={tgBusy || !tgToken.trim()} onClick={tgConnect}>
                    {tgBusy ? <Spinner size={12} /> : t('chat.tg.connect')}
                  </button>
                </>
              )}
              <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>{tgMsg}</span>
            </div>
          </div>
          <span className="microlabel">{t('chat.card.raw')}</span>
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
            <button className="btn btn-primary sm" onClick={() => save()} disabled={saving || md === null}>
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
