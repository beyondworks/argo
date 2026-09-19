// 초대 창 하나로 통일(설계서 invite-ux-spec 2-1) — 채널 패널·조직 메뉴·빈 상태가 모두 이 창을 연다.
// 창을 열면 링크가 이미 만들어져 있고, 들어갈 채널·설정을 바꾸면 새 링크를 만든다(이전 링크는 유효 — 관리 목록에서 취소).
// 권한 표시(총괄 확정 2026-09-18): 조직 관리자 = 멤버·게스트, 채널 자유(비공개 포함). 관리자 아닌 채널 관리자 = 그 채널 게스트만.
// 서버가 최종 판정한다(정비사 #610: 방장 아닌 비공개 = msgr_invite_channel_forbidden, 멤버의 조직 초대 = RLS 거절).
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { I } from './icons.jsx';
import './invite-dialog.css';
import { EXPIRY_DAYS, MAX_USES, GUEST_DAYS, invitePerms, channelPick, settingsSummary } from './invite-flow.mjs';

// 선택지가 적은 설정은 한 번에 누르는 알약(네이티브 select는 클릭이 는다 — 총괄 결정)
function Seg({ label, value, options, onPick }) {
  return <span className="msgr-seg" role="radiogroup" aria-label={label}>{options.map(([v, text]) => <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={value === v ? 'active' : ''} onClick={() => onPick(v)}>{text}</button>)}</span>;
}

export function InviteDialog({ org, channels, isAdmin, hostOf = new Set(), initialChannelIds = [], initialRole, create, discard = null, shareText, linkOf, onClose, onManage, errorText, t, phone = false }) {
  const perm = invitePerms({ isAdmin, hostOf });
  const [s, setS] = useState(() => ({ role: initialRole ?? (perm.member ? 'member' : 'guest'), expiryDays: 7, maxUses: null, guestDays: 30 })); // 기본: 멤버 7일·제한 없음, 게스트 7일·1회·이용 30일(총괄 확정)
  const eligible = useMemo(() => channels.filter((c) => c.kind !== 'dm'), [channels]);
  const [picked, setPicked] = useState(() => {
    const ok = initialChannelIds.filter((id) => { const c = eligible.find((x) => x.id === id); return c && channelPick(c, { isAdmin, hostOf }, s.role).ok; });
    return s.role === 'guest' ? ok.slice(0, 1) : ok;
  });
  const [open, setOpen] = useState(false); // 링크 설정 접힘
  const [link, setLink] = useState(null); const [busy, setBusy] = useState(true); const [err, setErr] = useState(null); const [copied, setCopied] = useState(false);
  const copyRef = useRef(null); const dialog = useRef(null); const seq = useRef(0);
  // 이 창에서 만든 링크 — 복사하지 않은 채 새 링크로 바뀌거나 창을 닫으면 취소한다(쌓임 방지, 총괄 2026-09-18). 복사한 링크는 이미 건너갔을 수 있어 둔다.
  const cur = useRef(null); // { id, code, copied }
  const drop = (inv) => { if (inv && !inv.copied && discard) discard(inv.id).catch(() => {}); };
  useEffect(() => () => { seq.current = -1; drop(cur.current); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 선택·설정이 바뀌면 새 링크(짧게 모아서) — 늦게 온 옛 응답은 버린다.
  // 옛 링크는 그 순간 지운다: 옛 설정(예: 멤버)의 링크가 새 설정(게스트) 화면에 남아 복사되면 권한이 넘어간다(D32).
  const needChannel = s.role === 'guest' && picked.length === 0; // 서버가 거절(msgr_invite_guest_one_channel) — 만들지 않는다
  useEffect(() => {
    const my = ++seq.current; drop(cur.current); cur.current = null; setLink(null); setErr(null); setBusy(!needChannel); // 화면에서 지운 링크는 복사할 수 없다 — 안 건너갔으면 바로 정리
    if (needChannel) return undefined;
    const timer = setTimeout(async () => {
      try { const made = await create({ role: s.role, channelIds: picked, expiryDays: s.expiryDays, maxUses: s.role === 'guest' ? 1 : s.maxUses, guestDays: s.guestDays });
        if (seq.current !== my) { drop(made); return; } // 늦게 온 옛 응답·닫힌 창 — 보여 준 적 없는 링크
        cur.current = { ...made, copied: false };
        setLink(made.code); setBusy(false);
      } catch (e) { if (seq.current === my) { setErr(errorText ? errorText(e) : e.message); setBusy(false); } }
    }, link ? 200 : 0);
    return () => clearTimeout(timer);
  }, [s.role, s.expiryDays, s.maxUses, s.guestDays, picked.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!busy && link) copyRef.current?.focus(); }, [busy, !!link]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!copied) return undefined; const id = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(id); }, [copied]);

  const toggle = (c) => {
    if (!channelPick(c, { isAdmin, hostOf }, s.role).ok) return;
    setPicked((cur) => s.role === 'guest' ? [c.id] : cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id]);
  };
  const setRole = (role) => { if (role === 'member' && !perm.member) return; setS((x) => ({ ...x, role }));
    setPicked((cur) => { const ok = cur.filter((id) => channelPick(eligible.find((c) => c.id === id), { isAdmin, hostOf }, role).ok); return role === 'guest' ? ok.slice(0, 1) : ok; }); };
  const markCopied = () => { if (cur.current) cur.current.copied = true; };
  const copy = async () => { if (!link) return; markCopied(); try { await navigator.clipboard.writeText(shareText ? shareText(link, { channels: names, days: s.expiryDays }) : link); setCopied(true); } catch { setErr(t('inv.copy.fail')); } };
  const keydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter((x) => x.getClientRects().length);
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  };
  const names = picked.map((id) => eligible.find((c) => c.id === id)?.name).filter(Boolean);
  // 부제 = 행선지 문장(칩과 겹치는 채널 나열 대신). 채널이 없으면 경고색 — 멤버는 복사를 막지 않고, 게스트는 채널을 고를 때까지 링크가 없다
  const sub = needChannel ? t('inv.sub.guestNone') : names.length === 0 ? t('inv.sub.none') : names.length === 1 ? t('inv.sub.one', { name: names[0] }) : t('inv.sub.more', { name: names[0], n: names.length - 1 });
  const lockTip = (why) => t(why === 'guestPrivate' ? 'inv.ch.guestPrivateTip' : 'inv.ch.lockedTip');

  return createPortal(
    <div className={`shell inv-overlay${phone ? ' phone' : ''}`} onKeyDown={keydown} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="inv-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="inv-title">
        {phone && <div className="inv-grab" aria-hidden="true" />}
        <header className="inv-head">
          <div><h2 id="inv-title">{t('inv.title', { org: org.name })}</h2><p className={`inv-sub${names.length ? '' : ' warn'}`}>{sub}</p></div>
          <button type="button" className="btn ghost inv-x" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={16} /></button>
        </header>

        <div className="inv-link">
          <input className="msgr-input" readOnly value={busy ? t('inv.making') : (link ? (linkOf ? linkOf(link) : link) : '')} aria-label={t('inv.link')} onFocus={(e) => e.target.select()} onCopy={markCopied} />{/* 손으로 선택해 복사해도 건너간 링크로 친다 */}
          <button type="button" ref={copyRef} className={`btn btn-primary inv-copy${copied ? ' done' : ''}`} onClick={copy} disabled={!link || busy} aria-live="polite">
            <I name={copied ? 'check' : 'copy'} size={14} />{copied ? t('inv.copied') : t('inv.copy')}
          </button>
        </div>
        <p className="inv-hint" role="status">{needChannel ? t('inv.pickChannel') : t('inv.pasteHint')}</p>
        {err && <p className="inv-err" role="alert">{err}</p>}
        <div className="inv-body">

        <div className="inv-sec">
          <div className="inv-label">{t(s.role === 'guest' ? 'inv.channel.guest' : 'inv.channels')}</div>
          <div className="inv-chips" role="group" aria-label={t('inv.channels')}>
            {eligible.map((c) => { const p = channelPick(c, { isAdmin, hostOf }, s.role); const on = picked.includes(c.id);
              return <button key={c.id} type="button" role={s.role === 'guest' ? 'radio' : 'checkbox'} aria-checked={on} aria-disabled={!p.ok || undefined}
                className={`inv-chip${on ? ' on' : ''}${p.ok ? '' : ' locked'}`} onClick={() => toggle(c)} title={p.ok ? undefined : lockTip(p.why)}>
                <I name={c.kind === 'private' ? 'lock' : 'hash'} size={12} /><span>{c.name}</span>{on && <I name="check" size={12} />}
              </button>; })}
          </div>
          {s.role === 'guest' && <p className="inv-note">{t('inv.guest.one')}</p>}
        </div>

        <div className="inv-sec">
          <button type="button" className="inv-fold" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <span className="inv-label">{t('inv.settings')}</span><span className="inv-sum">{settingsSummary(s, t)}</span><I name="caret" size={13} className="caret" />
          </button>
          {open && <div className="inv-settings">
            <div className="inv-row"><span>{t('inv.role')}</span>
              <span className="msgr-seg" role="radiogroup" aria-label={t('inv.role')}>
                <button type="button" role="radio" aria-checked={s.role === 'member'} className={s.role === 'member' ? 'active' : ''} disabled={!perm.member} title={perm.member ? undefined : t('inv.role.memberLocked')} onClick={() => setRole('member')}>{t('inv.role.member')}</button>
                <button type="button" role="radio" aria-checked={s.role === 'guest'} className={s.role === 'guest' ? 'active' : ''} disabled={!perm.guest} onClick={() => setRole('guest')}>{t('inv.role.guest')}</button>
              </span></div>
            {!perm.member && <p className="inv-note">{t('inv.role.memberLocked')}</p>}
            <div className="inv-row"><span>{t('inv.expiry')}</span>
              <Seg label={t('inv.expiry')} value={s.expiryDays} options={EXPIRY_DAYS.map((d) => [d, d == null ? t('inv.expiry.none') : t('inv.days', { n: d })])} onPick={(v) => setS((x) => ({ ...x, expiryDays: v }))} /></div>
            {s.role === 'member'
              ? <div className="inv-row"><span>{t('inv.uses')}</span>
                  <Seg label={t('inv.uses')} value={s.maxUses} options={MAX_USES.map((n) => [n, n == null ? t('inv.uses.unlimitedShort') : t('inv.uses.n', { n })])} onPick={(v) => setS((x) => ({ ...x, maxUses: v }))} /></div>
              : <div className="inv-row"><span>{t('inv.guest.days')}</span>
                  <Seg label={t('inv.guest.days')} value={s.guestDays} options={GUEST_DAYS.map((d) => [d, t('inv.days', { n: d })])} onPick={(v) => setS((x) => ({ ...x, guestDays: v }))} /></div>}
          </div>}
        </div>

        {onManage && <footer className="inv-foot"><button type="button" className="inv-manage" onClick={onManage}>{t('inv.manage')}</button></footer>}
        </div>
      </section>
    </div>, document.body);
}

// 받는 쪽 미리보기(설계서 2-2) — 붙여 넣은 코드가 어디로 데려가는지 보여 주고 한 번 눌러 들어간다.
// p = msgr_invite_preview 결과: valid·already_member면 조직·채널·초대한 사람·만료, expired·exhausted·revoked면 org_name만.
export function InvitePreview({ p, avatar = null, busy = false, err = null, onJoin, onOpen, onClose, fmtWhen, t, phone = false }) {
  const main = useRef(null);
  useEffect(() => { main.current?.focus(); }, [p.state]);
  const ok = p.state === 'valid', already = p.state === 'already_member';
  const status = ok ? (p.inviter_name ? t('inv.p.by', { name: p.inviter_name }) : t('inv.p.valid')) : t(`inv.p.${already ? 'already' : p.state}`);
  const keydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
  const channels = p.channels ?? [];
  return createPortal(
    <div className={`shell inv-overlay${phone ? ' phone' : ''}`} onKeyDown={keydown} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="inv-dialog inv-preview" role="dialog" aria-modal="true" aria-labelledby="invp-title">
        {phone && <div className="inv-grab" aria-hidden="true" />}
        <header className="inv-head">
          <div className="invp-org">{avatar}<div><h2 id="invp-title">{p.org_name}</h2><p className={`inv-sub${ok || already ? '' : ' warn'}`}>{status}</p></div></div>
          <button type="button" className="btn ghost inv-x" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={16} /></button>
        </header>
        {(ok || already) && <div className="inv-body">
          <div className="inv-sec">
            <div className="inv-label">{t('inv.channels')}</div>
            {channels.length
              ? <div className="inv-chips">{channels.map((c) => <span key={c.id} className="inv-chip"><I name={c.kind === 'private' ? 'lock' : 'hash'} size={12} /><span>{c.name}</span></span>)}</div>
              : <p className="inv-note">{t('inv.p.noChannels')}</p>}
          </div>
          <p className="inv-note">{[p.role === 'guest' && t('inv.p.guest'), p.expires_at ? t('inv.p.expires', { when: fmtWhen(p.expires_at) }) : t('inv.expiry.never')].filter(Boolean).join(' · ')}</p>
        </div>}
        {err && <p className="inv-err" role="alert">{err}</p>}
        <footer className="invp-acts">
          {ok && <button type="button" ref={main} className="btn btn-primary" disabled={busy} onClick={onJoin}><I name="check" size={14} />{t('inv.p.join')}</button>}
          {already && <button type="button" ref={main} className="btn btn-primary" onClick={onOpen}>{t('inv.p.open')}</button>}
          <button type="button" ref={ok || already ? undefined : main} className="btn" onClick={onClose}>{t(ok ? 'ui.cancel' : 'ui.close')}</button>
        </footer>
      </section>
    </div>, document.body);
}
