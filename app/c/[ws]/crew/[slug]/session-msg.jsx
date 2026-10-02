'use client';
// 세션 메시지 화면 조각 — 1:1 채팅 입력창의 `@` 자동 완성과, 세션 메시지 줄(출처 표지 m.src.kind === 'session')의 접힌 카드.
// 채팅 화면(page.jsx)에는 연결만 둔다(바깥에서 들어온 글 카드 작업과 합칠 때 충돌을 줄이려고 파일을 나눴다).
//
// 출처 표지(m.src) — 서버 src/session-msg.mjs가 붙인다:
//   { kind: 'session', dir: 'out'|'in'|'reply'|'notice', id, room, roomName, from, fromName, to, toName, code?, late? }
//   out    = A 방, 사장이 보낸 줄(사장 말풍선 그대로 — 이 파일은 그리지 않는다)
//   in     = B 방, 받은 메시지(via:'session' 사용자 줄)
//   reply  = A 방, B의 답(사장이 보낸 경우 crew 줄 = 답 카드, 크루가 보낸 경우 via:'session' 사용자 줄 = 깨움 알림)
//   notice = A 방, 상한·기한·재시작·실패 안내(code)
import { useEffect, useState } from 'react';
import { Markdown } from '../../../../ui';
import { sessionCandidates, mentionToken, sessionBody } from './session-msg-parse.mjs';

/** 입력 맨 앞의 `@부분` 자동 완성 — ↑↓ 이동, Enter·Tab 완성. onKeyDown이 true면 이 키는 처리됐다. */
export function useSessionMention({ input, setInput, crew, selfSlug, disabled = false, onPicked }) {
  const list = disabled ? null : sessionCandidates(input, crew, selfSlug);
  const open = !!list?.length;
  const [idx, setIdx] = useState(0);
  useEffect(() => { setIdx(0); }, [input]);
  const sel = open ? Math.min(idx, list.length - 1) : 0;
  const pick = (a) => { setInput(`@${mentionToken(a)} `); onPicked?.(); };
  const onKeyDown = (e) => {
    if (!open || e.nativeEvent?.isComposing) return false;
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pick(list[sel]); return true; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx((i) => (e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length));
      return true;
    }
    return false;
  };
  return { open, list: list ?? [], sel, setIdx, pick, onKeyDown };
}

/** 자동 완성 패널 — 입력창 위(래퍼가 position: relative). '/' 커맨더와 같은 룩. */
export function SessionMentionPanel({ sm, t }) {
  if (!sm.open) return null;
  return (
    <div className="card card-float" role="listbox" aria-label={t('chat.session.mentionTitle')} style={{
      position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 40, minWidth: 260, maxWidth: 'min(420px, 100%)',
      maxHeight: 300, overflowY: 'auto', padding: 6, boxShadow: '0 8px 28px rgba(0,0,0,.14)',
    }}>
      <div style={{ padding: '4px 8px 2px', fontSize: 11, color: 'var(--fg-3)' }}>{t('chat.session.mentionTitle')}</div>
      {sm.list.map((a, i) => (
        <button key={a.slug} type="button" role="option" aria-selected={i === sm.sel}
          onMouseDown={(e) => e.preventDefault()} onClick={() => sm.pick(a)} onMouseEnter={() => sm.setIdx(i)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: i === sm.sel ? 'var(--card-2)' : 'none',
            border: 0, borderRadius: 7, cursor: 'pointer', padding: '6px 8px', fontSize: 12.5, color: 'var(--fg)' }}>
          <span style={{ fontWeight: 650, flex: 'none' }}>@{a.name}</span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-3)', fontSize: 11.5 }}>{a.role}</span>
        </button>
      ))}
      <div style={{ padding: '4px 8px 2px', fontSize: 11, color: 'var(--fg-3)', borderTop: '1px solid var(--border-soft)', marginTop: 4 }}>{t('chat.session.mentionHint')}</div>
    </div>
  );
}

/** 이 줄을 세션 메시지 카드로 그릴까 — 보낸 줄(out)은 사장 말풍선 그대로. */
export const isSessionCard = (m) => m?.src?.kind === 'session' && m.src.dir !== 'out';

/** 출처 줄 문구 */
function sourceLine(m, t) {
  const s = m.src;
  if (s.dir === 'in') return s.from === 'captain' ? t('chat.session.in.captain', { room: s.roomName ?? s.room }) : t('chat.session.in.crew', { name: s.fromName ?? s.from });
  if (s.dir === 'reply') return m.who === 'user' ? t('chat.session.wake', { name: s.fromName ?? s.from }) : t(s.late ? 'chat.session.replyLate' : 'chat.session.reply', { name: s.fromName ?? s.from });
  return null;
}

/** 세션 메시지 카드 — 출처 줄 + 앞 2줄, ▾로 펼친다. 안내(notice)는 한 줄. */
export function SessionMsgCard({ m, t, ws }) {
  const [open, setOpen] = useState(false);
  const s = m.src;
  if (s.dir === 'notice') {
    return (
      <div className="fade-up" data-session-msg="notice" style={{ alignSelf: 'flex-start', maxWidth: '85%', fontSize: 12, color: 'var(--fg-2)', padding: '6px 12px', borderRadius: 10, background: 'var(--card-2)' }}>
        {t(`chat.session.notice.${['cap', 'expired', 'restart'].includes(s.code) ? s.code : 'failed'}`, { name: s.fromName ?? s.from })}
      </div>
    );
  }
  const body = sessionBody(m);
  const preview = body.replace(/\n\s*\n/g, '\n'); // 접힌 두 줄을 빈 줄에 쓰지 않는다
  const rich = open && m.who === 'crew'; // 펼친 답은 마크다운으로(크루 답과 같은 렌더)
  const more = preview.split('\n').length > 2 || preview.length > 140 || (m.who === 'crew' && preview !== body); // 접어 둘 것이 없으면 ▾를 그리지 않는다(한 줄 답)
  const clamp = open ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap' };
  return (
    <div className="fade-up" data-session-msg={s.dir} style={{ alignSelf: 'flex-start', maxWidth: '85%', minWidth: 0, display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 11.5, color: 'var(--fg-3)', padding: '0 4px' }}>{sourceLine(m, t)}</span>
      <div className="card" style={{ padding: '10px 13px', fontSize: 12.5, color: 'var(--fg-2)', minWidth: 0, display: 'grid', gap: 4 }}>
        {rich ? <Markdown text={body} wsId={ws} /> : <span style={clamp}>{open ? body : preview}</span>}
        {more && <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
          style={{ justifySelf: 'start', background: 'none', border: 0, padding: 0, cursor: 'pointer', fontSize: 11.5, color: 'var(--fg-3)', fontFamily: 'inherit' }}>
          {open ? `▴ ${t('chat.session.collapse')}` : `▾ ${t('chat.session.expand')}`}
        </button>}
      </div>
    </div>
  );
}
