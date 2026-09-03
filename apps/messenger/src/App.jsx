// Argo 메신저 — 조직·채널·메시지·크루·결재 카드. 데이터는 Supabase 직결(RLS가 경계), 실시간은 private topic org:<id> 방송.
// 룩은 Argo 앱과 동일: 클래스(.shell .side .nav-item .btn .chip .pill .input-bar .msg-user .msg-crew .card .fade-up)와
// 컴포넌트(Icon·Avatar·Markdown·DropUp)를 globals.css/ui.jsx에서 그대로 쓴다. 메신저 고유 배치만 styles.css.
// 1차 범위(MESSENGER-DESIGN.md P1): 로그인 · 조직/초대 · 공개/비공개 채널 · 메시지 · @멘션 · 첨부 · 결재 카드 · 크루 부재중 · 타이핑.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, configured, q } from './supabase.js';
import { t as tm, readLang } from './i18n.js';
import { useLang } from '@argo/i18n';
import { useTheme, THEMES } from '@argo/theme';
import { Icon, Avatar, Markdown, DropUp, Logo, imeGuardWith } from '@argo/ui';

const AWAY_MS = 90_000;
const PAGE = 100;
const fmtTs = (iso, lang) => new Date(iso).toLocaleTimeString(lang === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' });

/** 메신저 사전 t — 언어 상태는 Argo LanguageProvider(cmd+/ 전환·localStorage argo-lang)를 그대로 쓴다. */
function useT() { const { lang, setLang, t: ta } = useLang(); return { lang, setLang, ta, t: (k, vars) => tm(k, lang, vars) }; }

export default function App() {
  const { t } = useT();
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    if (!supabase) { setSession(null); return; }
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  if (!configured) return <div className="msgr-auth"><div className="card"><Logo size={15} /><p style={{ color: 'var(--danger)', fontSize: 13 }}>{t('auth.notConfigured')}</p></div></div>;
  if (session === undefined) return <div className="msgr-auth"><span className="microlabel">{t('ui.loading')}</span></div>;
  if (!session) return <Auth />;
  return <Shell session={session} />;
}

/* ─── 로그인: 이메일 OTP(운영). 개발 빌드에서는 비밀번호 로그인도(로컬 스택엔 메일 서버가 없다). ─── */
function Auth() {
  const { t, lang, setLang } = useT();
  const [email, setEmail] = useState(''); const [code, setCode] = useState(''); const [pw, setPw] = useState('');
  const [sent, setSent] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const run = async (fn) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return (
    <div className="msgr-auth"><form className="card fade-up" onSubmit={(e) => e.preventDefault()}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Logo size={15} /><span className="microlabel">{t('app.title')}</span>
      </div>
      <label className="input-bar"><input type="email" placeholder={t('auth.email')} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
      {!sent ? (
        <button className="btn btn-primary" disabled={busy || !email} onClick={() => run(async () => { await q(supabase.auth.signInWithOtp({ email })); setSent(true); })}>{t('auth.sendCode')}</button>
      ) : (<>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fg-2)' }}>{t('auth.sent')}</p>
        <label className="input-bar"><input placeholder={t('auth.code')} value={code} onChange={(e) => setCode(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={busy || !code} onClick={() => run(async () => { await q(supabase.auth.verifyOtp({ email, token: code.trim(), type: 'email' })); })}>{t('auth.verify')}</button>
      </>)}
      {import.meta.env.DEV && (<>
        <label className="input-bar"><input type="password" placeholder={t('auth.password')} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        <button className="btn" disabled={busy || !email || !pw} onClick={() => run(async () => { await q(supabase.auth.signInWithPassword({ email, password: pw })); })}>{t('auth.verify')} (dev)</button>
      </>)}
      {err && <p style={{ margin: 0, color: 'var(--danger)', fontSize: 12.5 }}>{err}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button type="button" className="btn sm" onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')}>{t('ui.lang')}</button></div>
    </form></div>
  );
}

/* ─── 셸: 사이드바(조직·채널·크루·멤버) + 본문 ─── */
function Shell({ session }) {
  const { t, ta, lang, setLang } = useT();
  const { theme, setTheme } = useTheme();
  const uid = session.user.id;
  const [orgs, setOrgs] = useState(null); const [orgId, setOrgId] = useState(null);
  const [channels, setChannels] = useState([]); const [chId, setChId] = useState(null);
  const [members, setMembers] = useState([]); const [crews, setCrews] = useState([]);
  const [err, setErr] = useState(''); const [note, setNote] = useState('');
  const [tick, setTick] = useState(0);
  const rt = useRef(null);
  const loadOrgs = useCallback(async () => {
    const rows = await q(supabase.from('msgr_org_members').select('org_id, role, msgr_orgs(id, name, slug)').eq('user_id', uid).is('removed_at', null));
    const list = rows.filter((r) => r.msgr_orgs).map((r) => ({ id: r.org_id, role: r.role, ...r.msgr_orgs }));
    setOrgs(list);
    setOrgId((cur) => cur && list.some((o) => o.id === cur) ? cur : (list[0]?.id ?? null));
  }, [uid]);
  useEffect(() => { // 초대 링크 수락(?invite=code)
    const code = new URLSearchParams(location.search).get('invite');
    (async () => {
      try {
        if (code) { await q(supabase.rpc('msgr_accept_invite', { code })); history.replaceState(null, '', location.pathname); setNote(t('org.joined')); }
        await loadOrgs();
      } catch (e) { setErr(e.message); await loadOrgs().catch(() => {}); }
    })();
  }, [loadOrgs]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadOrg = useCallback(async (id) => {
    if (!id) return;
    const [chs, mems, crs] = await Promise.all([
      q(supabase.from('msgr_channels').select('id, kind, name, topic, crew_memory, created_by').eq('org_id', id).is('archived_at', null).order('created_at')),
      q(supabase.from('msgr_org_members').select('user_id, role, display_name').eq('org_id', id).is('removed_at', null)),
      q(supabase.from('msgr_crews').select('id, owner_user_id, slug, display_name, role_text, hosting, status, allow, last_seen_at').eq('org_id', id).eq('status', 'active')),
    ]);
    setChannels(chs); setMembers(mems); setCrews(crs);
    setChId((cur) => cur && chs.some((c) => c.id === cur) ? cur : (chs[0]?.id ?? null));
  }, []);
  useEffect(() => { loadOrg(orgId).catch((e) => setErr(e.message)); }, [orgId, loadOrg]);
  const [event, setEvent] = useState(null); const [typing, setTyping] = useState({});
  useEffect(() => { // Realtime — 조직 topic 하나. 방송은 id·채널만 싣는다(본문은 RLS를 지난 조회로).
    if (!orgId) return;
    let ch;
    (async () => {
      await supabase.realtime.setAuth(session.access_token);
      ch = supabase.channel(`org:${orgId}`, { config: { private: true } })
        .on('broadcast', { event: 'message' }, ({ payload }) => setEvent({ kind: 'message', ...payload, at: Date.now() }))
        .on('broadcast', { event: 'approval' }, ({ payload }) => setEvent({ kind: 'approval', ...payload, at: Date.now() }))
        .on('broadcast', { event: 'typing' }, ({ payload }) => setTyping((m) => ({ ...m, [`${payload.channel_id}:${payload.crew_id}`]: Date.now() })))
        .subscribe((status, e) => { if (import.meta.env.DEV) console.log('[rt]', status, e?.message ?? ''); });
      rt.current = ch;
      if (import.meta.env.DEV) window.__argoRt = ch;
    })();
    return () => { ch?.unsubscribe(); rt.current = null; };
  }, [orgId, session.access_token]);
  useEffect(() => { const iv = setInterval(() => setTick((x) => x + 1), 15_000); return () => clearInterval(iv); }, []);
  useEffect(() => { if (tick % 2 === 0 && orgId) loadOrg(orgId).catch(() => {}); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const org = orgs?.find((o) => o.id === orgId);
  const me = members.find((m) => m.user_id === uid);
  const isAdmin = org && ['owner', 'admin'].includes(org.role);
  const nameOfUser = (id) => members.find((m) => m.user_id === id)?.display_name || id?.slice(0, 8) || '?';
  const crewOf = (id) => crews.find((c) => c.id === id);
  const createOrg = async () => {
    const name = prompt(t('org.name')); if (!name?.trim()) return;
    const slug = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'org'}-${Date.now().toString(36).slice(-4)}`;
    try { const o = await q(supabase.from('msgr_orgs').insert({ name: name.trim(), slug, owner_user_id: uid }).select('id').single()); await loadOrgs(); setOrgId(o.id); } catch (e) { setErr(e.message); }
  };
  const invite = async () => {
    try {
      const row = await q(supabase.from('msgr_invites').insert({ org_id: orgId, role: 'member', created_by: uid }).select('code').single());
      const link = `${location.origin}${location.pathname}?invite=${row.code}`;
      await navigator.clipboard?.writeText(link).catch(() => {});
      setNote(`${t('org.inviteMade')} ${link}`);
    } catch (e) { setErr(e.message); }
  };
  const createChannel = async () => {
    const name = prompt(t('ch.name')); if (!name?.trim()) return;
    const priv = confirm(`${t('ch.private')}?`);
    try {
      const c = await q(supabase.from('msgr_channels').insert({ org_id: orgId, kind: priv ? 'private' : 'public', name: name.trim(), created_by: uid }).select('id').single());
      if (priv) await q(supabase.from('msgr_channel_members').insert({ channel_id: c.id, member_kind: 'user', member_id: uid, added_by: uid }));
      await loadOrg(orgId); setChId(c.id);
    } catch (e) { setErr(e.message); }
  };
  const themeGroups = useMemo(() => [
    { label: ta('settings.family.graphite'), items: ['graphite', 'graphite-light', 'graphite-dark'].map((v) => ({ value: v, label: ta(`settings.theme.${v}`) })) },
    { label: 'Argo', items: ['argo', 'argo-light', 'argo-dark'].map((v) => ({ value: v, label: ta(`settings.theme.${v}`) })) },
    { label: '…', items: THEMES.filter((v) => !/^(graphite|argo)/.test(v)).map((v) => ({ value: v, label: ta(`settings.theme.${v}`) })) },
  ], [ta]);
  if (orgs === null) return <div className="msgr-auth"><span className="microlabel">{t('ui.loading')}</span></div>;
  const channel = channels.find((c) => c.id === chId);
  return (
    <div className="shell">
      <aside className="side">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 4px 6px' }}>
          <Logo size={13} />
          <span style={{ flex: 1 }} />
          <DropUp value={orgId ?? ''} placeholder={t('org.pick')} width={130} height={26} ariaLabel={t('org.pick')}
            groups={[{ label: t('org.pick'), items: orgs.map((o) => ({ value: o.id, label: o.name, badge: o.role })) }]} onChange={setOrgId} />
          <button type="button" className="btn sm btn-icon" style={{ width: 26, height: 26 }} onClick={createOrg} title={t('org.new')} aria-label={t('org.new')}><Icon name="plus" size={13} /></button>
        </div>
        {!orgs.length && <p style={{ padding: '4px 10px', fontSize: 12.5, color: 'var(--fg-3)' }}>{t('org.none')}</p>}
        <div className="side-group-row"><span className="side-group" style={{ flex: 1 }}>{t('ch.list')}</span>
          <button type="button" className="btn sm btn-icon" style={{ width: 24, height: 24, border: 0, color: 'var(--fg-3)', margin: '12px 0 2px' }} onClick={createChannel} disabled={!orgId} title={t('ch.new')} aria-label={t('ch.new')}><Icon name="plus" size={12} /></button></div>
        {channels.map((c) => (
          <button key={c.id} type="button" className={`nav-item${c.id === chId ? ' active' : ''}`} onClick={() => setChId(c.id)}>
            <span className="mono" style={{ width: 14, textAlign: 'center', color: c.id === chId ? 'inherit' : 'var(--fg-3)' }}>{c.kind === 'private' ? '🔒' : c.kind === 'dm' ? '✉' : '#'}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
          </button>
        ))}
        <div className="side-group">{t('org.crews')}</div>
        {crews.map((c) => { const on = c.last_seen_at && Date.now() - Date.parse(c.last_seen_at) < AWAY_MS; return (
          <div key={c.id} className="msgr-crew-row" title={`${c.role_text ?? ''} · ${nameOfUser(c.owner_user_id)}`}>
            <Avatar name={c.display_name} sm />
            <span style={{ minWidth: 0, flex: 1 }}><span style={{ display: 'block', color: 'var(--fg)', fontWeight: 500 }}>{c.display_name}</span><span className="nav-sub">{c.role_text}</span></span>
            <span className={`pill${on ? ' ok' : ''}`}><span className="dot" />{on ? t('crew.online') : t('crew.away')}</span>
          </div>
        ); })}
        {!crews.length && <p style={{ padding: '2px 10px', fontSize: 12, color: 'var(--fg-3)' }}>{t('org.crewsHint')}</p>}
        <div className="side-group-row"><span className="side-group" style={{ flex: 1 }}>{t('org.members')} · {members.length}</span>
          {isAdmin && <button type="button" className="btn sm" style={{ margin: '12px 0 2px' }} onClick={invite}>{t('org.invite')}</button>}</div>
        <div className="msgr-members">
          {members.map((m) => <div key={m.user_id} className="msgr-member"><Avatar name={m.display_name || m.user_id} sm /><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.display_name || m.user_id.slice(0, 8)}</span><span className="chip role">{m.role}</span></div>)}
        </div>
        <div className="side-footer" style={{ flexWrap: 'wrap' }}>
          <Avatar name={me?.display_name || session.user.email} sm />
          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{me?.display_name || session.user.email}</span>
          <button type="button" className="btn sm" onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')}>{t('ui.lang')}</button>
          <DropUp value={theme} groups={themeGroups} onChange={setTheme} width={150} height={28} align="left" ariaLabel={t('ui.theme.family')} />
          <button type="button" className="btn sm" onClick={() => supabase.auth.signOut()}>{t('auth.signOut')}</button>
        </div>
      </aside>
      <main className="msgr-main">
        <div className="topbar">
          <span className="topbar-title">{channel ? `${channel.kind === 'private' ? '🔒 ' : '# '}${channel.name}` : t('app.title')}</span>
          {channel?.topic && <span style={{ fontSize: 12.5, color: 'var(--fg-3)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{channel.topic}</span>}
          <span style={{ flex: 1 }} />
          {channel?.crew_memory === false && <span className="chip" title={t('ch.crewMemory')}>memory off</span>}
          {org && <span className="chip">{org.name}</span>}
        </div>
        {(err || note) && (
          <div className="msgr-notice">
            <span style={{ color: err ? 'var(--danger)' : 'var(--fg-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{err ? `${t('ui.error')}: ${err}` : note}</span>
            <button type="button" className="btn sm btn-icon" style={{ width: 24, height: 24, border: 0 }} onClick={() => { setErr(''); setNote(''); }} aria-label="×">×</button>
          </div>
        )}
        {chId ? <Channel key={chId} channel={channel} orgId={orgId} uid={uid} members={members} crews={crews} nameOfUser={nameOfUser} crewOf={crewOf} event={event} typing={typing} rt={rt} onError={setErr} /> : <div className="msgr-empty">{t('ch.empty')}</div>}
      </main>
    </div>
  );
}

/* ─── 채널 본문: 스레드 + 컴포저 ─── */
function Channel({ channel, orgId, uid, members, crews, nameOfUser, crewOf, event, typing, rt, onError }) {
  const { t, lang } = useT();
  const [msgs, setMsgs] = useState([]); const [aps, setAps] = useState({}); const [atts, setAtts] = useState({});
  const feed = useRef(null);
  const chId = channel.id;
  const load = useCallback(async (afterId = 0) => {
    const rows = await q(supabase.from('msgr_messages').select('id, author_kind, author_user_id, crew_id, kind, body, mentions, reply_to, created_at, deleted_at')
      .eq('channel_id', chId).gt('id', afterId).order('id', { ascending: afterId ? true : false }).limit(PAGE));
    const list = afterId ? rows : rows.reverse();
    setMsgs((cur) => { const seen = new Set(cur.map((m) => m.id)); return afterId ? [...cur, ...list.filter((m) => !seen.has(m.id))] : list; });
    const ids = list.map((m) => m.id);
    if (ids.length) {
      const a = await q(supabase.from('msgr_attachments').select('id, message_id, storage_path, name, mime, bytes').in('message_id', ids));
      setAtts((cur) => { const n = { ...cur }; for (const r of a) (n[r.message_id] ??= []).push(r); return n; });
    }
    const apRows = await q(supabase.from('msgr_crew_approvals').select('id, crew_id, approval_id, action, reason, status, decided_by, decided_at, message_id').eq('channel_id', chId));
    setAps(Object.fromEntries(apRows.map((r) => [r.id, r])));
  }, [chId]);
  useEffect(() => { load().catch((e) => onError(e.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!event) return;
    if ((event.kind === 'message' || event.kind === 'approval') && event.channel_id === chId) load(msgs.at(-1)?.id ?? 0).catch(() => {});
  }, [event]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { feed.current?.scrollTo({ top: feed.current.scrollHeight }); }, [msgs.length]);
  // 폴링 폴백(10s) — Realtime이 끊기거나 구독이 거부돼도 새 메시지가 화면에 도달한다(정본은 언제나 조회, 방송은 깨우기 신호)
  useEffect(() => { const iv = setInterval(() => load(msgs.at(-1)?.id ?? 0).catch(() => {}), 10_000); return () => clearInterval(iv); }, [load, msgs]);
  const decide = async (ap, status) => {
    const res = await supabase.from('msgr_crew_approvals').update({ status, decided_by: uid, decided_at: new Date().toISOString() }).eq('id', ap.id).select('id');
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t('ap.ownerOnly')); // RLS 0행 = 소유자가 아니다
    load(msgs.at(-1)?.id ?? 0).catch(() => {});
  };
  const typingNames = Object.entries(typing).filter(([k, at]) => k.startsWith(`${chId}:`) && Date.now() - at < 6000).map(([k]) => crewOf(k.split(':')[1])?.display_name).filter(Boolean);
  return (<>
    <div className="msgr-thread" ref={feed}>
      <div className="thread">
        {!msgs.length && <div className="msgr-empty">{t('ch.empty')}</div>}
        {msgs.map((m) => <Message key={m.id} m={m} uid={uid} lang={lang} t={t} nameOfUser={nameOfUser} crewOf={crewOf} aps={aps} atts={atts[m.id] ?? []} decide={decide} parent={m.reply_to ? msgs.find((x) => x.id === m.reply_to) : null} />)}
      </div>
    </div>
    <Composer chId={chId} orgId={orgId} uid={uid} members={members} crews={crews} rt={rt} typingNames={typingNames} onSent={() => load(msgs.at(-1)?.id ?? 0).catch(() => {})} onError={onError} />
  </>);
}

function Message({ m, uid, lang, t, nameOfUser, crewOf, aps, atts, decide, parent }) {
  const [copied, setCopied] = useState(false);
  const crew = m.crew_id ? crewOf(m.crew_id) : null;
  const name = m.author_kind === 'user' ? nameOfUser(m.author_user_id) : (crew?.display_name ?? '크루');
  const ap = m.kind === 'approval_card' ? aps[(m.mentions ?? []).find((x) => x.kind === 'approval')?.id] : null;
  const body = m.deleted_at ? '' : m.body;
  const copy = () => { navigator.clipboard?.writeText(body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  const mine = m.author_kind === 'user' && m.author_user_id === uid;
  const quote = parent && <div className="msgr-quote">↩ {parent.author_kind === 'user' ? nameOfUser(parent.author_user_id) : crewOf(parent.crew_id)?.display_name}: {parent.body}</div>;
  const attRow = atts.length > 0 && <div>{atts.map((a) => <Attachment key={a.id} a={a} />)}</div>;
  if (mine) return ( // 내 글 — 크루 대화의 사장 말풍선(우측·primary)과 같은 문법
    <div className="msg-wrap fade-up" style={{ alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '75%' }}>
      <div className="msg-user" style={{ alignSelf: 'auto', maxWidth: '100%', whiteSpace: 'pre-wrap' }}>{quote}{body}</div>
      {attRow}
      <div className="msg-actions"><span className="ts mono" style={{ fontSize: 10, color: 'var(--fg-3)', padding: '2px 4px' }}>{fmtTs(m.created_at, lang)}</span><button type="button" onClick={copy}>{copied ? t('ui.copied') : t('ui.copy')}</button></div>
    </div>
  );
  return ( // 동료·크루 글 — 좌측, 아바타 + 카드(크루는 Markdown)
    <div className={`${m.author_kind === 'crew' ? 'msg-crew' : 'msgr-peer'} fade-up`}>
      <Avatar name={name} sm />
      <div className="msg-wrap">
        <div className="msgr-who"><span>{name}</span>{crew?.role_text && <span className="nav-sub" style={{ display: 'inline' }}>{crew.role_text}</span>}<span className="ts">{fmtTs(m.created_at, lang)}</span></div>
        {ap ? (
          <div className="card invert" style={{ padding: '12px 15px', display: 'grid', gap: 8, minWidth: 0 }}>
            <span className="microlabel">{ap.status === 'pending' ? t('ap.pending') : t(`ap.${ap.status}`)}</span>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{ap.action}</div>
            {ap.reason && <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{ap.reason}</div>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {ap.status === 'pending' ? (<>
                <button type="button" className="btn btn-primary sm" onClick={() => decide(ap, 'approved')}><Icon name="check" size={12} />{t('ap.approve')}</button>
                <button type="button" className="btn sm" onClick={() => decide(ap, 'rejected')}>{t('ap.reject')}</button>
                <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{t('ap.ownerOnly')}</span>
              </>) : <span className="pill"><span className="dot" />{t('ap.by', { name: nameOfUser(ap.decided_by) })}</span>}
            </div>
          </div>
        ) : m.kind === 'system' ? (
          <div className="card" style={{ padding: '8px 12px' }}><span className="msgr-sys">{body}</span></div>
        ) : (
          <div className="card" style={{ padding: m.author_kind === 'crew' ? '13px 16px' : '9px 13px', minWidth: 0 }}>
            {quote}
            {m.author_kind === 'crew' ? <Markdown text={body} /> : <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5 }}>{body}</div>}
          </div>
        )}
        {attRow}
        {!ap && <div className="msg-actions"><button type="button" onClick={copy}>{copied ? t('ui.copied') : t('ui.copy')}</button></div>}
      </div>
    </div>
  );
}
function Attachment({ a }) {
  const open = async () => {
    const { data, error } = await supabase.storage.from('msgr').createSignedUrl(a.storage_path, 600); // 서명 URL(단수명) — 버킷 정책은 채널 단위
    if (error) return alert(error.message);
    window.open(data.signedUrl, '_blank', 'noopener');
  };
  return <button type="button" className="chip msgr-att" onClick={open}><Icon name="clip" size={11} />{a.name}{a.bytes ? <span>{Math.round(a.bytes / 1024)}KB</span> : null}</button>;
}

/* ─── 컴포저: Argo 입력바 + @멘션 팝업(사람·크루) + Enter 전송(IME 조합 제외) + 첨부 ─── */
function Composer({ chId, orgId, uid, members, crews, rt, typingNames, onSent, onError }) {
  const { t } = useT();
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [files, setFiles] = useState([]);
  const [pop, setPop] = useState(null); const [sel, setSel] = useState(0);
  const [mentions, setMentions] = useState([]);
  const ta = useRef(null); const fileRef = useRef(null);
  const candidates = useMemo(() => {
    if (!pop) return [];
    const needle = pop.q.toLowerCase();
    const list = [...crews.map((c) => ({ kind: 'crew', id: c.id, name: c.display_name, sub: c.role_text })), ...members.map((m) => ({ kind: 'user', id: m.user_id, name: m.display_name || m.user_id.slice(0, 8), sub: m.role }))];
    return list.filter((x) => !needle || x.name.toLowerCase().includes(needle)).slice(0, 8);
  }, [pop, crews, members]);
  const autosize = (el) => { if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 132)}px`; };
  const onChange = (e) => {
    const v = e.target.value; setText(v); autosize(e.target);
    const upto = v.slice(0, e.target.selectionStart);
    const m = upto.match(/(?:^|\s)@([^\s@]*)$/);
    setPop(m ? { q: m[1], start: upto.length - m[1].length - 1 } : null); setSel(0);
  };
  const pick = (c) => {
    const before = text.slice(0, pop.start); const after = text.slice(ta.current.selectionStart);
    const next = `${before}@${c.name} ${after}`;
    setText(next); setMentions((ms) => ms.some((x) => x.id === c.id) ? ms : [...ms, c]); setPop(null);
    requestAnimationFrame(() => { ta.current?.focus(); const p = before.length + c.name.length + 2; ta.current?.setSelectionRange(p, p); autosize(ta.current); });
  };
  const send = async () => {
    const body = text.trim(); if (!body || busy) return;
    setBusy(true);
    try {
      const ment = mentions.filter((x) => body.includes(`@${x.name}`)).map(({ kind, id }) => ({ kind, id }));
      const row = await q(supabase.from('msgr_messages').insert({ channel_id: chId, author_kind: 'user', author_user_id: uid, body, mentions: ment, client_msg_id: crypto.randomUUID() }).select('id').single());
      for (const f of files) {
        const path = `${orgId}/${chId}/${row.id}/${f.name.replace(/[\\/]/g, '_')}`;
        const up = await supabase.storage.from('msgr').upload(path, f, { contentType: f.type || 'application/octet-stream' });
        if (up.error) { onError(`${t('msg.attachFail')}: ${f.name} — ${up.error.message}`); continue; }
        await q(supabase.from('msgr_attachments').insert({ message_id: row.id, org_id: orgId, storage_path: path, name: f.name, mime: f.type, bytes: f.size }));
      }
      setText(''); setMentions([]); setFiles([]); if (ta.current) ta.current.style.height = 'auto'; onSent();
    } catch (e) { onError(e.message); } finally { setBusy(false); }
  };
  const onKey = (e) => {
    if (pop && candidates.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % candidates.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + candidates.length) % candidates.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(candidates[sel]); return; }
      if (e.key === 'Escape') { setPop(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  return (
    <div className="msgr-compose"><div>
      {pop && candidates.length > 0 && (
        <div className="msgr-pop card" role="listbox">
          {candidates.map((c, i) => <button key={`${c.kind}:${c.id}`} type="button" role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(c); }}>
            <Avatar name={c.name} sm /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span><span className="microlabel">{c.kind === 'crew' ? 'crew' : c.sub}</span>
          </button>)}
        </div>
      )}
      <form className="input-bar" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input hidden multiple type="file" ref={fileRef} onChange={(e) => { setFiles([...e.target.files]); e.target.value = ''; }} />
        <textarea ref={ta} rows={1} value={text} onChange={onChange} {...imeGuardWith(onKey)} placeholder={t('msg.placeholder')} />
        <button className="btn btn-primary btn-icon" disabled={busy || !text.trim()} aria-label={t('msg.send')} title={t('msg.send')}><Icon name="send" size={15} /></button>
      </form>
      <div className="msgr-subrow">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" className="btn btn-icon sm" style={{ border: 0, width: 26, color: 'var(--fg-3)' }} onClick={() => fileRef.current?.click()} disabled={busy} aria-label={t('msg.attach')} title={t('msg.attach')}><Icon name="clip" size={14} /></button>
          {files.map((f) => <span key={f.name} className="chip">{f.name}</span>)}
          <span className="msgr-typing">{typingNames.length ? t('msg.typing', { name: typingNames.join(', ') }) : ''}</span>
        </div>
        <span className="microlabel" style={{ fontSize: 9 }}>{t('msg.mentionHint')}</span>
      </div>
    </div></div>
  );
}
