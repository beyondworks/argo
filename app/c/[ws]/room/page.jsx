'use client';
// 회의실 — 사장 + 여러 크루가 한 방에서. "@이름"으로 부르면 그 크루들이 순서대로 발언한다.
// 좌측 레일에 지난 회의가 적재되고(회의 마치기), 클릭으로 읽기 전용 열람 — 맥락 공유가 눈에 보이는 화면.
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Icon, Markdown, ArgoSpinner, Skeleton, InputModal, api, imeGuard } from '../../../ui';
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
  const [renameSess, setRenameSess] = useState(null); // 회의명 편집 모달 대상
  // 회의명 편집·고정 — 채팅 세션 레일과 동일 계약(PATCH {id,title}|{id,pinned})
  async function doRenameSess(title) {
    const sess = renameSess; setRenameSess(null);
    if (!sess) return;
    try {
      await fetch(`/api/companies/${ws}/room/sessions`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: sess.id, title }),
      });
      loadSessions();
    } catch { /* 레일 갱신 실패는 다음 로드에서 복구 */ }
  }
  async function doTogglePin(sess) {
    try {
      await fetch(`/api/companies/${ws}/room/sessions`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: sess.id, pinned: !sess.pinned }),
      });
      loadSessions();
    } catch { /* 동일 */ }
  }
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
    if (busy) return;
    // 회의록은 서버(endMeeting)가 journal + .archive로 남기므로 비파괴 — 확인창 없이 바로 마친다.
    // window.confirm은 Tauri 데스크톱 웹뷰에서 막혀 무동작 → 제거(새 대화와 동일 근본 원인).
    try {
      const r = await fetch(`/api/companies/${ws}/room`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setMessages([]); setError('');
      loadSessions(); // 방금 마친 회의가 좌측 레일에 적재된다
      window.dispatchEvent(new Event('argo:refresh')); // 항해일지에 회의록이 바로 잡힌다
    } catch (e2) { setError(String(e2.message)); }
  }

  // @멘션 드롭업 — 입력 끝이 @word면 입력창 위로 후보 패널이 열린다(칩 가로 나열이 크루 수만큼
  // 옆으로 흘러 지저분했다 — 유건 지시 2026-07-21: 드롭다운식 + 위로). @all이 항상 첫 후보.
  const mention = input.match(/@(\S*)$/);
  const mq = mention ? mention[1].toLowerCase() : '';
  const suggests = mention
    ? agents.filter((a) => !mq || a.name.toLowerCase().startsWith(mq) || a.slug.startsWith(mq)).slice(0, 12)
    : [];
  const suggestAll = !!mention && agents.length > 1 && (!mq || 'all'.startsWith(mq) || '전체'.startsWith(mention[1]));
  const completeMention = (name) => setInput(input.replace(/@\S*$/, `@${name} `));
  const mentionOpen = !!mention && (suggestAll || suggests.length > 0);

  const shown = viewing ? archMsgs : messages;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '216px minmax(0, 1fr)', gap: 18, alignItems: 'start', height: 'calc(100vh - 100px)', marginBottom: -70 }}>
      {/* height offset 100 = topbar(56)+상단패딩(26)+하단여백(18). marginBottom -70 = 원래 오프셋 170과의 차 —
          .content 하단 패딩(88) 중 70을 상쇄해 body 스크롤을 막으면서 입력창을 아래로 내려 대화 영역을 넓힌다. 메시지 컬럼 minHeight:0과 한 세트(회의실·컨테스트·DM 동일). */}
      {/* 회의 레일 — 마친 회의가 적재된다. 무템플릿 grid 함정 방지: minmax(0,1fr) */}
      <div className="side-rail" style={{ position: 'sticky', top: 72, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, width: 216 }}>
        <span className="microlabel" style={{ padding: '2px 6px 4px' }}>
          {t('room.sessions.title')}{sessions.length ? ` · ${sessions.length}` : ''}
        </span>
        <button className={`nav-item${!viewing ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => openSession(null)}>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{t('room.sessions.current')}</span>
            <span className="nav-sub">{messages?.length ? t('chat.sessions.msgs', { n: messages.length }) : t('room.sessions.idle')}</span>
          </span>
        </button>
        {sessions.map((s) => {
          const active = viewing === s.id;
          const pinColor = active ? 'var(--primary-fg)' : 'var(--primary)'; // 활성 골드 배경 위 골드 핀 겹침 방지(세션 레일 공통)
          const actColor = active ? 'var(--primary-fg)' : 'var(--fg-3)';
          return (
          <div key={s.id} className="rail-item" style={{ position: 'relative' }}>
            <button className={`nav-item${active ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer', paddingRight: 48 }} onClick={() => openSession(s.id)}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600 }}>
                  {s.pinned && <Icon name="pin" size={11} style={{ flex: 'none', color: pinColor }} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title || s.topic || t('chat.sessions.untitled')}</span>
                </span>
                <span className="nav-sub">{new Date(s.ts).toLocaleDateString('sv-SE')} · {t('chat.sessions.msgs', { n: s.count })}</span>
              </span>
            </button>
            <span className="rail-actions" style={{ position: 'absolute', right: 5, top: 7, display: 'flex', gap: 1 }}>
              <button type="button" title={s.pinned ? t('chat.sessions.unpin') : t('chat.sessions.pin')} aria-label={s.pinned ? t('chat.sessions.unpin') : t('chat.sessions.pin')}
                onClick={(e) => { e.stopPropagation(); doTogglePin(s); }}
                style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, border: 0, background: 'transparent', color: s.pinned ? pinColor : actColor, cursor: 'pointer', borderRadius: 6 }}>
                <Icon name="pin" size={12} />
              </button>
              <button type="button" title={t('chat.sessions.rename')} aria-label={t('chat.sessions.rename')}
                onClick={(e) => { e.stopPropagation(); setRenameSess(s); }}
                style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, border: 0, background: 'transparent', color: actColor, cursor: 'pointer', borderRadius: 6 }}>
                <Icon name="edit" size={12} />
              </button>
            </span>
          </div>
          );
        })}
        {sessions.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--fg-3)', padding: '2px 6px', lineHeight: 1.5 }}>{t('room.sessions.empty')}</span>}
      </div>

      {renameSess && (
        <InputModal
          title={t('chat.sessions.renameTitle')}
          defaultValue={renameSess.title || renameSess.topic || ''}
          placeholder={t('chat.sessions.renamePh')}
          confirmLabel={t('common.save')}
          onConfirm={doRenameSess}
          onClose={() => setRenameSess(null)}
        />
      )}

      <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 12, height: '100%', minWidth: 0, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="microlabel">{t('room.header')}</span>
          <span className="rule" style={{ flex: 1 }} />
          {!viewing && (messages?.length ?? 0) > 0 && (
            <button className="btn sm" disabled={busy} onClick={endMeeting}>{t('room.end')}</button>
          )}
        </div>

        <div className="card" style={{ padding: '16px 18px', overflowY: 'auto', minHeight: 0 }}>
          {shown === null ? <Skeleton h={200} /> : shown.length === 0 ? (
            <div className="empty">{t('room.empty')}</div>
          ) : (
            <div style={{ display: 'grid', gap: 14 }}>
              {shown.map((m, i) => m.who === 'user' ? (
                <div key={i} style={{ justifySelf: 'end', maxWidth: '78%' }}>
                  <div className="bubble-user" style={{ background: 'var(--primary)', color: 'var(--primary-fg)', borderRadius: 14, padding: '9px 13px', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{m.text}</div>
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
            {error && <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0 }}>{error}</p>}
            {/* 멘션 드롭업의 위치 기준 — 입력바를 relative로 감싼다 */}
            <div style={{ position: 'relative' }}>
              {mentionOpen && (
                <div className="card card-float" role="listbox" style={{
                  position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 40,
                  minWidth: 280, maxWidth: 420, maxHeight: 300, overflowY: 'auto', padding: 6,
                  boxShadow: '0 8px 28px rgba(0,0,0,.14)',
                }}>
                  <div className="microlabel" style={{ padding: '4px 8px 2px' }}>{t('room.mention')}</div>
                  {/* @all — 전 크루 호출(서버 runRoomTurn이 @all/@전체를 전원 발언으로 해석). 항상 첫 후보 = Enter 완성 대상 */}
                  {suggestAll && (
                    <button type="button" role="option" onClick={() => completeMention('all')}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 0, borderRadius: 7, cursor: 'pointer', padding: '6px 8px', fontSize: 12.5 }}>
                      <span className="mono" style={{ color: 'var(--primary-strong)', fontWeight: 650 }}>@all</span>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-3)', fontSize: 11.5 }}>{t('room.allCrew')}</span>
                    </button>
                  )}
                  {suggests.map((a) => (
                    <button key={a.slug} type="button" role="option" onClick={() => completeMention(a.name)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 0, borderRadius: 7, cursor: 'pointer', padding: '6px 8px', fontSize: 12.5, color: 'var(--fg)' }}>
                      <span style={{ fontWeight: 650, flex: 'none' }}>@{a.name}</span>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-3)', fontSize: 11.5 }}>{a.role}</span>
                    </button>
                  ))}
                </div>
              )}
              <form onSubmit={send} className="input-bar">
                <input suppressHydrationWarning
                  placeholder={t('room.placeholder')}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={busy}
                  {...imeGuard}
                  onKeyDown={(e) => {
                    // {...imeGuard} 뒤에 두어 onKeyDown을 이 핸들러가 갖는다 — IME 조합 Enter 차단 포함
                    if (e.key !== 'Enter') return;
                    if (e.nativeEvent.isComposing) { e.preventDefault(); return; }
                    // 멘션 패널이 열려 있으면 Enter = 첫 후보 완성(전송 아님)
                    if (mentionOpen) { e.preventDefault(); completeMention(suggestAll ? 'all' : suggests[0].name); }
                  }}
                />
                <button className="btn btn-primary btn-icon" disabled={busy || !input.trim()} aria-label={t('chat.send')}>
                  <Icon name="send" size={15} />
                </button>
              </form>
            </div>
            <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: 0 }}>{t('room.hint')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
