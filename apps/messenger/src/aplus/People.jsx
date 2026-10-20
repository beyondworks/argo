// 메신저 A+ '사람' 탭(2026-10-20 유건: 사람 채팅까지 넣고 한 번에 공개) — 팀 공간 · 채널 · 사람 1:1 · 초대 보내기/받기 · 멤버 목록.
// 자료는 source(실제 = source.mjs, 화면 시험 = fake.mjs)로만. 판단은 people.mjs, 문구는 사전(i18n.js 'people.*'), 색은 globals.css 토큰만.
// 사람 채팅도 Pro 전용 — 최종 판정은 서버 거부 코드(msgr2_pro_required)다. 읽기는 탭·방을 열 때와 공간·방·초대 사건 때만(주기 조회 없음).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I } from '../icons.jsx';
import { peopleErrorKey, peopleGate, nameProblem, roomRows, memberRows, canInvite, canCreateRoom, NAME_MAX } from './people.mjs';
import { inviteLeft } from '../v2/invite-box.mjs';
import { inviteShareText, parseInviteCode } from '../invite.mjs';

const initials = (name) => String(name || '?').trim().slice(0, 1).toUpperCase();
export function PFace({ name, size = 32, muted = false, square = false }) { return <span className={`ap-face${muted ? ' muted' : ''}${square ? ' square' : ''}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">{initials(name)}</span>; }

/** 사람 탭 상태: 공간 목록·고른 공간·그 공간 자료·받은 초대. 탭을 처음 열 때 읽고, 사건이 오면 500ms 묶어 한 번 다시 읽는다. */
export function usePeople({ source, active }) {
  const [gate, setGate] = useState('loading'); // loading | open | pro | closed | error
  const [spaces, setSpaces] = useState([]);
  const [spaceId, setSpaceId] = useState(null);
  const [data, setData] = useState(null); // { rooms, members, people, agents }
  const [invites, setInvites] = useState([]);
  const started = useRef(false);
  const spaceIdRef = useRef(null);
  const fail = useCallback((e) => setGate(peopleGate(e)), []);
  const loadSpace = useCallback((id) => { if (!id) { setData({ rooms: [], members: [], people: [], agents: [] }); return Promise.resolve(); } return source.space(id).then(setData, fail); }, [source, fail]);
  const loadAll = useCallback(async (pick = null) => {
    try {
      const [list, inv] = await Promise.all([source.spaces(), source.myInvites().catch(() => null)]);
      setSpaces(list); if (inv) setInvites(inv);
      const id = pick && list.some((s) => s.id === pick) ? pick : (spaceIdRef.current && list.some((s) => s.id === spaceIdRef.current) ? spaceIdRef.current : list[0]?.id ?? null);
      setSpaceId(id); setGate('open');
      await loadSpace(id);
    } catch (e) { fail(e); }
  }, [source, loadSpace, fail]);
  spaceIdRef.current = spaceId;
  useEffect(() => { if (active && !started.current) { started.current = true; loadAll(); } }, [active, loadAll]);
  useEffect(() => { // 공간·방·초대 사건 — 짧은 창에 묶어 한 번만 다시 읽는다(셸 room-events와 같은 묶음 창)
    let timer = null;
    const off = source.on('people', () => { if (!started.current) return; clearTimeout(timer); timer = setTimeout(() => loadAll(), 500); });
    return () => { clearTimeout(timer); off?.(); };
  }, [source, loadAll]);
  const pickSpace = useCallback((id) => { setSpaceId(id); setData(null); loadSpace(id); }, [loadSpace]);
  const space = spaces.find((s) => s.id === spaceId) ?? null;
  const names = useMemo(() => Object.fromEntries((data?.people ?? []).map((p) => [p.user_id, p.name])), [data]);
  const rows = useMemo(() => roomRows({ rooms: data?.rooms ?? [], members: data?.members ?? [], uid: source.uid, names }), [data, names, source.uid]);
  const members = useMemo(() => memberRows({ people: data?.people ?? [], agents: data?.agents ?? [], uid: source.uid }), [data, source.uid]);
  return { gate, spaces, space, spaceId, data, invites, setInvites, rows, members, names, pickSpace, reload: loadAll, reloadSpace: () => loadSpace(spaceIdRef.current), retry: () => { setGate('loading'); loadAll(); } };
}

/** 사람 탭 목록(왼쪽 레일 또는 휴대폰 한 칸). */
export function PeopleList({ t, p, openId, onOpen, onSheet, purchase }) {
  if (p.gate === 'loading') return <p className="ap-note ap-muted">{t('aplus.loading')}</p>;
  if (p.gate === 'pro') return <div className="ap-note ap-pro"><span className="ap-tag">Pro</span><strong>{t('people.pro.title')}</strong><p>{t('people.pro.body')}</p><div className="ap-row">{purchase?.url ? <a className="btn sm btn-primary" href={purchase.url} target="_blank" rel="noreferrer">{t('aplus.free.upgrade')}</a> : null}<button type="button" className="btn sm" onClick={p.retry}>{t('aplus.plan.recheck')}</button></div></div>;
  if (p.gate === 'closed') return <div className="ap-note"><strong>{t('aplus.closed.title')}</strong><p>{t('people.closed')}</p></div>;
  if (p.gate === 'error') return <div className="ap-note"><p>{t('aplus.load.failed')}</p><button type="button" className="btn sm" onClick={p.retry}><I name="retry" size={14} />{t('aplus.retry')}</button></div>;
  const { channels, dms } = p.rows;
  return <div className="ap-people">
    {p.invites.length > 0 && <section className="ap-sec"><h3>{t('people.inv.inbox', { n: p.invites.length })}</h3><ul className="ap-rows">{p.invites.map((v) => { const left = inviteLeft(v.expiresAt); return (
      <li key={v.id}><button type="button" className="ap-rowbtn ap-invrow" onClick={() => onSheet({ kind: 'preview', code: v.code })}>
        <PFace name={v.spaceName} size={32} square />
        <span className="ap-rowtext"><span className="ap-rowname">{v.spaceName}</span><span className="ap-rowsub">{t('people.inv.from', { name: v.inviterName || t('people.someone') })} · {t(left.key, { n: left.n })}</span></span>
        <span className="ap-pill on">{t('people.inv.view')}</span>
      </button></li>); })}</ul></section>}
    {!p.spaces.length ? <div className="ap-note"><strong>{t('people.none.title')}</strong><p>{t('people.none.body')}</p><div className="ap-row"><button type="button" className="btn sm btn-primary" onClick={() => onSheet({ kind: 'newSpace' })}><I name="plus" size={14} />{t('people.space.new')}</button><button type="button" className="btn sm" onClick={() => onSheet({ kind: 'join' })}>{t('people.join')}</button></div></div> : <>
      <button type="button" className="ap-spacebtn" onClick={() => onSheet({ kind: 'spaces' })} aria-haspopup="dialog">
        <PFace name={p.space?.name} size={28} square /><span className="ap-rowtext"><span className="ap-rowname">{p.space?.name}</span><span className="ap-rowsub">{t(`people.role.${p.space?.role ?? 'member'}`)} · {t('people.members.n', { n: p.members.humans.length })}</span></span><I name="caret" size={14} />
      </button>
      {p.data === null ? <p className="ap-note ap-muted">{t('aplus.loading')}</p> : <>
        <section className="ap-sec"><h3>{t('people.channels')}{canCreateRoom(p.space) && <button type="button" className="ap-iconbtn sm" onClick={() => onSheet({ kind: 'newChannel' })} aria-label={t('people.channel.new')}><I name="plus" size={15} /></button>}</h3>
          {!channels.length ? <p className="ap-note ap-muted">{t('people.channels.none')}</p> : <ul className="ap-rows">{channels.map((r) => (
            <li key={r.id}><button type="button" className={`ap-rowbtn${openId === r.id ? ' on' : ''}`} onClick={() => onOpen({ kind: 'room', roomId: r.id })}>
              <span className="ap-hash" aria-hidden="true"><I name={r.private ? 'lock' : 'hash'} size={15} /></span>
              <span className="ap-rowtext"><span className="ap-rowname">{r.name}{r.readOnly ? <span className="ap-pill">{t('people.readOnly.tag')}</span> : r.legacy ? <span className="ap-pill">{t('people.legacy.tag')}</span> : null}</span>{r.last ? <span className="ap-rowsub">{r.last}</span> : null}</span>
              {r.unread > 0 && <span className="ap-badge" aria-label={t('aplus.unread', { n: r.unread })}>{r.unread}</span>}
            </button></li>))}</ul>}
        </section>
        <section className="ap-sec"><h3>{t('people.dms')}<button type="button" className="ap-iconbtn sm" onClick={() => onSheet({ kind: 'members' })} aria-label={t('people.dm.new')}><I name="chatplus" size={15} /></button></h3>
          {!dms.length ? <p className="ap-note ap-muted">{t('people.dms.none')}</p> : <ul className="ap-rows">{dms.map((r) => (
            <li key={r.id}><button type="button" className={`ap-rowbtn${openId === r.id ? ' on' : ''}`} onClick={() => onOpen({ kind: 'room', roomId: r.id })}>
              <PFace name={r.name} />
              <span className="ap-rowtext"><span className="ap-rowname">{r.name}{r.legacy && <span className="ap-pill">{t('people.legacy.tag')}</span>}</span><span className="ap-rowsub">{r.last || t('aplus.dm.start')}</span></span>
              {r.unread > 0 && <span className="ap-badge" aria-label={t('aplus.unread', { n: r.unread })}>{r.unread}</span>}
            </button></li>))}</ul>}
        </section>
      </>}
    </>}
  </div>;
}

/** 사람 탭의 머리 단추(휴대폰 머리줄·레일 위): 초대(owner·admin), 멤버. */
export function PeopleActions({ t, p, onSheet, cls = 'btn sm' }) {
  if (p.gate !== 'open' || !p.space) return null;
  return <>
    {canInvite(p.space) && <button type="button" className={cls} onClick={() => onSheet({ kind: 'invite' })} aria-label={t('people.invite')}><I name="personplus" size={14} /><span>{t('people.invite')}</span></button>}
    <button type="button" className={cls} onClick={() => onSheet({ kind: 'members' })} aria-label={t('people.members')}><I name="person" size={14} /><span>{t('people.members')}</span></button>
  </>;
}

function Sheet({ title, onClose, children, t }) {
  useEffect(() => { const on = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [onClose]);
  return <div className="ap-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className="ap-sheet" role="dialog" aria-modal="true" aria-label={title}>
    <header><h2>{title}</h2><button type="button" className="ap-iconbtn" onClick={onClose} aria-label={t('aplus.close')}><I name="x" size={18} /></button></header>{children}</div></div>;
}

/** 사람 탭 시트 모음. sheet = { kind: spaces|newSpace|newChannel|invite|members|preview|join, code? }. */
export function PeopleSheets({ t, source, p, sheet, setSheet, onOpen, setToast }) {
  if (!sheet) return null;
  const close = () => setSheet(null);
  const k = sheet.kind;
  if (k === 'spaces') return <Sheet t={t} title={t('people.spaces')} onClose={close}><div className="ap-form">
    <ul className="ap-rows">{p.spaces.map((s) => <li key={s.id}><button type="button" className={`ap-rowbtn${s.id === p.spaceId ? ' on' : ''}`} onClick={() => { p.pickSpace(s.id); close(); }}><PFace name={s.name} size={28} square /><span className="ap-rowtext"><span className="ap-rowname">{s.name}</span><span className="ap-rowsub">{t(`people.role.${s.role}`)}</span></span>{s.id === p.spaceId && <I name="check" size={16} />}</button></li>)}</ul>
    <div className="ap-row"><button type="button" className="btn sm" onClick={() => setSheet({ kind: 'newSpace' })}><I name="plus" size={14} />{t('people.space.new')}</button><button type="button" className="btn sm" onClick={() => setSheet({ kind: 'join' })}>{t('people.join')}</button></div>
  </div></Sheet>;
  if (k === 'newSpace') return <NameSheet t={t} title={t('people.space.new')} label={t('people.space.name')} ph={t('people.space.ph')} hint={t('people.space.hint')} onClose={close}
    onSubmit={async (name) => { const id = await source.createSpace(name); close(); await p.reload(id); }} />;
  if (k === 'newChannel') return <NameSheet t={t} title={t('people.channel.new')} label={t('people.channel.name')} ph={t('people.channel.ph')} priv onClose={close}
    onSubmit={async (name, priv) => { const id = await source.createChannel(p.spaceId, name, priv); close(); await p.reloadSpace(); onOpen({ kind: 'room', roomId: id }); }} />;
  if (k === 'members') return <MembersSheet t={t} p={p} onClose={close} onDm={async (userId) => { try { const roomId = await source.openUserDm(userId, p.spaceId); close(); await p.reloadSpace(); onOpen({ kind: 'room', roomId }); } catch (e) { setToast(t(peopleErrorKey(e) ?? 'aplus.load.failed')); } }} />;
  if (k === 'invite') return <InviteSheet t={t} source={source} p={p} onClose={close} />;
  if (k === 'join') return <JoinSheet t={t} onClose={close} onCode={(code) => setSheet({ kind: 'preview', code })} />;
  if (k === 'preview') return <PreviewSheet t={t} source={source} code={sheet.code} onClose={close}
    onAccepted={async (spaceId) => { p.setInvites((l) => l.filter((v) => v.code !== sheet.code)); close(); await p.reload(spaceId); setToast(t('people.inv.joined')); }}
    onDeclined={() => { p.setInvites((l) => l.filter((v) => v.code !== sheet.code)); close(); }} />;
  return null;
}

function NameSheet({ t, title, label, ph, hint = '', priv = false, onClose, onSubmit }) {
  const [name, setName] = useState(''); const [isPriv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const problem = nameProblem(name);
  const submit = async () => { if (problem || busy) return; setBusy(true); setErr(''); try { await onSubmit(name.trim(), isPriv); } catch (e) { setErr(t(peopleErrorKey(e) ?? 'people.createFailed')); } finally { setBusy(false); } };
  return <Sheet t={t} title={title} onClose={onClose}><div className="ap-form">
    <label className="ap-field"><span>{label}</span><input value={name} maxLength={NAME_MAX + 10} onChange={(e) => setName(e.target.value)} placeholder={ph} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit(); }} /></label>
    {priv && <label className="ap-check"><input type="checkbox" checked={isPriv} onChange={(e) => setPriv(e.target.checked)} /><span><strong>{t('people.channel.private')}</strong><span className="ap-muted">{t('people.channel.privateHint')}</span></span></label>}
    {hint && <p className="ap-hint"><I name="person" size={14} />{hint}</p>}
    {problem === 'long' && <p className="ap-error">{t('people.name.long', { n: NAME_MAX })}</p>}
    {err && <p className="ap-error">{err}</p>}
    <div className="ap-row end"><button type="button" className="btn" onClick={onClose}>{t('aplus.cancel')}</button><button type="button" className="btn btn-primary" disabled={!!problem || busy} onClick={submit}>{busy ? t('aplus.working') : t('aplus.meet.create')}</button></div>
  </div></Sheet>;
}

function MembersSheet({ t, p, onClose, onDm }) {
  const { humans, agents } = p.members;
  return <Sheet t={t} title={t('people.members.title', { space: p.space?.name ?? '' })} onClose={onClose}><div className="ap-form">
    <section className="ap-sec"><h3>{t('people.members.people', { n: humans.length })}</h3><ul className="ap-rows">{humans.map((m) => (
      <li key={m.id}><div className="ap-rowbtn static mid"><PFace name={m.name} /><span className="ap-rowtext"><span className="ap-rowname">{m.name}{m.me && <span className="ap-pill">{t('people.me')}</span>}</span><span className="ap-rowsub">{t(`people.role.${m.role}`)}</span></span>
        {!m.me && <button type="button" className="btn sm" onClick={() => onDm(m.id)}><I name="chat" size={14} />{t('people.dm.open')}</button>}</div></li>))}</ul></section>
    {agents.length > 0 && <section className="ap-sec"><h3>{t('people.members.agents', { n: agents.length })}</h3><ul className="ap-rows">{agents.map((a) => (
      <li key={a.id}><div className="ap-rowbtn static mid"><PFace name={a.name} muted={a.paused} /><span className="ap-rowtext"><span className="ap-rowname">{a.name}{a.paused && <span className="ap-pill">{t('aplus.dm.paused')}</span>}</span><span className="ap-rowsub">{a.mine ? t('people.agent.mine') : t('people.agent.other')}</span></span></div></li>))}</ul></section>}
  </div></Sheet>;
}

const SHARE_KEYS = { 'inv.share.how': 'people.share.how', 'org.join.code': 'people.join' };
function InviteSheet({ t, source, p, onClose }) {
  const [contacts, setContacts] = useState(null); const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(''); const [err, setErr] = useState(''); const [sent, setSent] = useState([]); const [copied, setCopied] = useState(false);
  useEffect(() => { source.contacts(p.spaceId).then(setContacts, () => setContacts([])); }, [source, p.spaceId]);
  const named = async (c) => { if (busy) return; setBusy(c.id); setErr(''); try { await source.createInvite(p.spaceId, { userId: c.id }); setSent((s) => [...s, c.id]); } catch (e) { setErr(t(peopleErrorKey(e) ?? 'people.inv.failed', { name: c.name })); } finally { setBusy(''); } };
  const link = async () => { if (busy) return; setBusy('link'); setErr(''); try { const r = await source.createInvite(p.spaceId); setCode(r?.code ?? null); } catch (e) { setErr(t(peopleErrorKey(e) ?? 'people.inv.failed', { name: '' })); } finally { setBusy(''); } };
  const shareT = (k, v) => t(SHARE_KEYS[k] ?? k, v); // 안내문의 '어디에 붙여 넣나'는 A+ 메뉴 이름으로(옛 '조직 메뉴'가 아니다)
  const text = code ? inviteShareText(code, { t: shareT, inviter: p.names[source.uid] || t('people.someone'), org: p.space?.name ?? '', days: 7 }) : '';
  const copy = async () => { try { await navigator.clipboard?.writeText(text); setCopied(true); } catch { setCopied(false); } };
  return <Sheet t={t} title={t('people.invite.title', { space: p.space?.name ?? '' })} onClose={onClose}><div className="ap-form">
    <div className="ap-callout"><I name="lock" size={16} /><div><strong>{t('people.invite.proTitle')}</strong><p>{t('people.invite.proBody')}</p></div></div>
    <section className="ap-sec"><h3>{t('people.invite.known')}</h3>
      {contacts === null ? <p className="ap-muted">{t('aplus.loading')}</p> : !contacts.length ? <p className="ap-muted">{t('people.invite.knownNone')}</p> : <ul className="ap-rows">{contacts.map((c) => (
        <li key={c.id}><div className="ap-rowbtn static mid"><PFace name={c.name} /><span className="ap-rowtext"><span className="ap-rowname">{c.name}</span></span>
          {sent.includes(c.id) ? <span className="ap-pill on">{t('people.invite.sent')}</span> : <button type="button" className="btn sm" disabled={!!busy} onClick={() => named(c)}>{busy === c.id ? t('aplus.working') : t('people.invite.send')}</button>}</div></li>))}</ul>}
    </section>
    <section className="ap-sec"><h3>{t('people.invite.link')}</h3>
      {code ? <><pre className="ap-code">{text}</pre><div className="ap-row"><button type="button" className="btn sm btn-primary" onClick={copy}><I name="copy" size={14} />{copied ? t('people.invite.copied') : t('people.invite.copy')}</button></div></>
        : <><p className="ap-muted">{t('people.invite.linkHint')}</p><div className="ap-row"><button type="button" className="btn sm" disabled={!!busy} onClick={link}><I name="link" size={14} />{busy === 'link' ? t('aplus.working') : t('people.invite.makeLink')}</button></div></>}
    </section>
    {err && <p className="ap-error" role="alert">{err}</p>}
  </div></Sheet>;
}

function JoinSheet({ t, onClose, onCode }) {
  const [raw, setRaw] = useState(''); const [bad, setBad] = useState(false);
  const go = () => { const code = parseInviteCode(raw); if (!code) { setBad(true); return; } onCode(code); };
  return <Sheet t={t} title={t('people.join')} onClose={onClose}><div className="ap-form">
    <label className="ap-field"><span>{t('people.join.label')}</span><input value={raw} onChange={(e) => { setRaw(e.target.value); setBad(false); }} placeholder={t('people.join.ph')} /></label>
    {bad && <p className="ap-error">{t('people.join.bad')}</p>}
    <div className="ap-row end"><button type="button" className="btn" onClick={onClose}>{t('aplus.cancel')}</button><button type="button" className="btn btn-primary" disabled={!raw.trim()} onClick={go}>{t('people.join.next')}</button></div>
  </div></Sheet>;
}

function PreviewSheet({ t, source, code, onClose, onAccepted, onDeclined }) {
  const [v, setV] = useState(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState('');
  useEffect(() => { source.previewInvite(code).then(setV, (e) => setErr(t(peopleErrorKey(e) ?? 'aplus.load.failed'))); }, [source, code, t]);
  const accept = async () => { if (busy) return; setBusy('accept'); setErr(''); try { const r = await source.acceptInvite(code); await onAccepted(r?.space_id ?? v?.space_id ?? null); } catch (e) { setErr(t(/\bmsgr2_pro_required\b/.test(`${e?.message ?? ''}`) ? 'people.inv.needPro' /* 무료면 초대는 남는다 — Pro가 된 뒤 다시 참여 */ : peopleErrorKey(e) ?? 'people.inv.acceptFailed')); } finally { setBusy(''); } };
  const decline = async () => { if (busy) return; setBusy('decline'); setErr(''); try { await source.declineInvite(code); onDeclined(); } catch { setErr(t('people.inv.declineFailed')); } finally { setBusy(''); } };
  const left = v ? inviteLeft(v.expires_at) : null;
  return <Sheet t={t} title={t('people.inv.title')} onClose={onClose}><div className="ap-form">
    {!v && !err && <p className="ap-muted">{t('aplus.loading')}</p>}
    {v && v.state !== 'valid' && <p className="ap-note">{t('people.inv.gone')}</p>}
    {v && v.state === 'valid' && <>
      <div className="ap-invcard"><PFace name={v.space_name} size={44} square /><div><strong>{v.space_name}</strong><p className="ap-muted">{t('people.inv.from', { name: v.inviter_name || t('people.someone') })} · {t(left.key, { n: left.n })}</p>
        {v.rooms?.length > 0 && <p className="ap-muted">{t('people.inv.rooms', { names: v.rooms.map((r) => `#${r.name}`).join(', ') })}</p>}</div></div>
      <p className="ap-hint"><I name="lock" size={14} />{t('people.inv.proNote')}</p>
      {v.already_member && <p className="ap-hint">{t('people.inv.already')}</p>}
    </>}
    {err && <p className="ap-error" role="alert">{err}</p>}
    {v?.state === 'valid' && <div className="ap-row end"><button type="button" className="btn" disabled={!!busy} onClick={decline}>{busy === 'decline' ? t('aplus.working') : t('people.inv.decline')}</button><button type="button" className="btn btn-primary" disabled={!!busy} onClick={accept}>{busy === 'accept' ? t('aplus.working') : t('people.inv.accept')}</button></div>}
  </div></Sheet>;
}
