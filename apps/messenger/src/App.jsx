// Argo 메신저 — 조직·채널·메시지·크루·결재 카드. 데이터는 Supabase 직결(RLS가 경계), 실시간은 private topic org:<id> 방송.
// 1차 범위(설계 MESSENGER-DESIGN.md P1): 로그인 · 조직/초대 · 공개/비공개 채널 · 메시지 · @멘션(사람·크루) · 첨부 · 결재 카드 · 크루 부재중 · 타이핑.
// 제외(불변식 3): 스레드 UI·리액션·읽음·검색·편집.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { supabase, configured, q } from './supabase.js';
import { t, readLang } from './i18n.js';

const AWAY_MS = 90_000;
const PAGE = 100;
const initials = (s) => (s || '?').trim().slice(0, 2);
const fmtTs = (iso, lang) => new Date(iso).toLocaleTimeString(lang === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' });
marked.setOptions({ breaks: true, gfm: true });
const md = (s) => ({ __html: marked.parse(String(s ?? '').replace(/<[^>]*>/g, '')) }); // 태그 제거 후 마크다운만(간이 — 후속: 공유 Markdown 컴포넌트)

function useLang() {
  const [lang, setLang] = useState(readLang());
  useEffect(() => {
    const onKey = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); setLang((l) => (l === 'ko' ? 'en' : 'ko')); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { try { localStorage.setItem('argo-lang', lang); } catch { /* 무해 */ } document.documentElement.lang = lang; }, [lang]);
  return [lang, setLang];
}
function useTheme() {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('argo-msgr-theme') || ''; } catch { return ''; } });
  useEffect(() => { if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; try { localStorage.setItem('argo-msgr-theme', theme); } catch { /* 무해 */ } }, [theme]);
  return [theme, setTheme];
}

export default function App() {
  const [lang, setLang] = useLang();
  const [theme, setTheme] = useTheme();
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    if (!supabase) { setSession(null); return; }
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  const ui = { lang, setLang, theme, setTheme };
  if (!configured) return <div className="auth"><div className="card"><Brand lang={lang} /><p className="err">{t('auth.notConfigured', lang)}</p></div></div>;
  if (session === undefined) return <div className="auth"><p className="muted">{t('ui.loading', lang)}</p></div>;
  if (!session) return <Auth ui={ui} />;
  return <Shell ui={ui} session={session} />;
}

function Brand({ lang }) { return <div className="brand"><img src="/icon.svg" alt="" />{t('app.title', lang)}</div>; }

/* ─── 로그인: 이메일 OTP(운영). 개발 빌드에서는 비밀번호 로그인도(로컬 스택엔 메일 서버가 없다). ─── */
function Auth({ ui: { lang, setLang } }) {
  const [email, setEmail] = useState(''); const [code, setCode] = useState(''); const [pw, setPw] = useState('');
  const [sent, setSent] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const run = async (fn) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return (
    <div className="auth"><form className="card" onSubmit={(e) => e.preventDefault()}>
      <Brand lang={lang} />
      <input className="input" type="email" placeholder={t('auth.email', lang)} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      {!sent ? (
        <button className="btn primary" disabled={busy || !email} onClick={() => run(async () => { await q(supabase.auth.signInWithOtp({ email })); setSent(true); })}>{t('auth.sendCode', lang)}</button>
      ) : (<>
        <p className="muted">{t('auth.sent', lang)}</p>
        <input className="input" placeholder={t('auth.code', lang)} value={code} onChange={(e) => setCode(e.target.value)} />
        <button className="btn primary" disabled={busy || !code} onClick={() => run(async () => { await q(supabase.auth.verifyOtp({ email, token: code.trim(), type: 'email' })); })}>{t('auth.verify', lang)}</button>
      </>)}
      {import.meta.env.DEV && (<>
        <input className="input" type="password" placeholder={t('auth.password', lang)} value={pw} onChange={(e) => setPw(e.target.value)} />
        <button className="btn" disabled={busy || !email || !pw} onClick={() => run(async () => { await q(supabase.auth.signInWithPassword({ email, password: pw })); })}>{t('auth.verify', lang)} (dev)</button>
      </>)}
      {err && <p className="err">{err}</p>}
      <button type="button" className="btn small" onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')}>{t('ui.lang', lang)}</button>
    </form></div>
  );
}

/* ─── 셸: 조직·채널·크루 레일 + 채널 본문 ─── */
function Shell({ ui, session }) {
  const { lang, setLang, theme, setTheme } = ui;
  const uid = session.user.id;
  const [orgs, setOrgs] = useState(null); const [orgId, setOrgId] = useState(null);
  const [channels, setChannels] = useState([]); const [chId, setChId] = useState(null);
  const [members, setMembers] = useState([]); const [crews, setCrews] = useState([]);
  const [err, setErr] = useState(''); const [note, setNote] = useState('');
  const [tick, setTick] = useState(0); // 크루 부재중 판정 재계산
  const rt = useRef(null);
  const loadOrgs = useCallback(async () => {
    const rows = await q(supabase.from('msgr_org_members').select('org_id, role, msgr_orgs(id, name, slug)').is('removed_at', null));
    const list = rows.filter((r) => r.msgr_orgs).map((r) => ({ id: r.org_id, role: r.role, ...r.msgr_orgs }));
    setOrgs(list);
    setOrgId((cur) => cur && list.some((o) => o.id === cur) ? cur : (list[0]?.id ?? null));
  }, []);
  // 초대 링크 수락(?invite=code)
  useEffect(() => {
    const code = new URLSearchParams(location.search).get('invite');
    (async () => {
      try {
        if (code) { await q(supabase.rpc('msgr_accept_invite', { code })); history.replaceState(null, '', location.pathname); setNote(t('org.joined', lang)); }
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
  // Realtime — 조직 topic 하나. 방송은 id·채널만 싣는다(본문은 RLS를 지난 조회로).
  const [event, setEvent] = useState(null); const [typing, setTyping] = useState({});
  useEffect(() => {
    if (!orgId) return;
    let ch;
    (async () => {
      await supabase.realtime.setAuth(session.access_token);
      ch = supabase.channel(`org:${orgId}`, { config: { private: true } })
        .on('broadcast', { event: 'message' }, ({ payload }) => setEvent({ kind: 'message', ...payload, at: Date.now() }))
        .on('broadcast', { event: 'approval' }, ({ payload }) => setEvent({ kind: 'approval', ...payload, at: Date.now() }))
        .on('broadcast', { event: 'typing' }, ({ payload }) => setTyping((m) => ({ ...m, [`${payload.channel_id}:${payload.crew_id}`]: Date.now() })))
        .subscribe((status, err) => { if (import.meta.env.DEV) console.log('[rt]', status, err?.message ?? ''); }); // 구독 상태는 개발 콘솔에(실측 진단용)
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
    const name = prompt(t('org.name', lang)); if (!name?.trim()) return;
    const slug = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'org'}-${Date.now().toString(36).slice(-4)}`;
    try { const o = await q(supabase.from('msgr_orgs').insert({ name: name.trim(), slug, owner_user_id: uid }).select('id').single()); await loadOrgs(); setOrgId(o.id); } catch (e) { setErr(e.message); }
  };
  const invite = async () => {
    try {
      const row = await q(supabase.from('msgr_invites').insert({ org_id: orgId, role: 'member', created_by: uid }).select('code').single());
      const link = `${location.origin}${location.pathname}?invite=${row.code}`;
      await navigator.clipboard?.writeText(link).catch(() => {});
      setNote(`${t('org.inviteMade', lang)} ${link}`);
    } catch (e) { setErr(e.message); }
  };
  const createChannel = async () => {
    const name = prompt(t('ch.name', lang)); if (!name?.trim()) return;
    const priv = confirm(`${t('ch.private', lang)}?`);
    try {
      const c = await q(supabase.from('msgr_channels').insert({ org_id: orgId, kind: priv ? 'private' : 'public', name: name.trim(), created_by: uid }).select('id').single());
      if (priv) await q(supabase.from('msgr_channel_members').insert({ channel_id: c.id, member_kind: 'user', member_id: uid, added_by: uid }));
      await loadOrg(orgId); setChId(c.id);
    } catch (e) { setErr(e.message); }
  };
  if (orgs === null) return <div className="auth"><p className="muted">{t('ui.loading', lang)}</p></div>;
  return (
    <div className="shell">
      <aside className="rail">
        <div className="top">
          <select className="input" style={{ width: 'auto', flex: 1 }} value={orgId ?? ''} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            {!orgs.length && <option value="">—</option>}
          </select>
          <button className="btn small" onClick={createOrg} title={t('org.new', lang)}>＋</button>
        </div>
        {!orgs.length && <p className="muted" style={{ padding: '8px 14px' }}>{t('org.none', lang)}</p>}
        <div className="sec"><span>{t('ch.list', lang)}</span><button className="btn small" onClick={createChannel} disabled={!orgId}>{t('ch.new', lang)}</button></div>
        <div className="list">
          {channels.map((c) => <button key={c.id} className={`item${c.id === chId ? ' on' : ''}`} onClick={() => setChId(c.id)}><span className="muted">{c.kind === 'private' ? '🔒' : c.kind === 'dm' ? '✉' : '#'}</span><span className="name">{c.name}</span></button>)}
        </div>
        <div className="sec"><span>{t('org.crews', lang)}</span></div>
        <div className="list">
          {crews.map((c) => { const on = c.last_seen_at && Date.now() - Date.parse(c.last_seen_at) < AWAY_MS; return (
            <div key={c.id} className="item" title={`${c.role_text ?? ''} · ${nameOfUser(c.owner_user_id)}`}><span className={`dot${on ? ' on' : ''}`} /><span className="name">{c.display_name}</span><span className="muted" style={{ fontSize: 11 }}>{on ? t('crew.online', lang) : t('crew.away', lang)}</span></div>
          ); })}
          {!crews.length && <p className="muted" style={{ padding: '4px 14px', fontSize: 12 }}>{t('org.crewsHint', lang)}</p>}
        </div>
        <div className="sec"><span>{t('org.members', lang)} · {members.length}</span>{isAdmin && <button className="btn small" onClick={invite}>{t('org.invite', lang)}</button>}</div>
        <div className="list">{members.map((m) => <div key={m.user_id} className="item"><span className="name">{m.display_name || m.user_id.slice(0, 8)}</span><span className="muted" style={{ fontSize: 11 }}>{m.role}</span></div>)}</div>
        <div className="foot">
          <span className="chip">{me?.display_name || session.user.email}</span>
          <button className="btn small" onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')}>{t('ui.lang', lang)}</button>
          <select className="btn small" value={theme} onChange={(e) => setTheme(e.target.value)} title={t('ui.theme', lang)}><option value="">auto</option><option value="light">light</option><option value="dark">dark</option></select>
          <button className="btn small" onClick={() => supabase.auth.signOut()}>{t('auth.signOut', lang)}</button>
        </div>
      </aside>
      <main className="main">
        {(err || note) && <div style={{ padding: '6px 18px' }}>{err ? <span className="err">{t('ui.error', lang)}: {err} <button className="btn small" onClick={() => setErr('')}>×</button></span> : <span className="muted">{note} <button className="btn small" onClick={() => setNote('')}>×</button></span>}</div>}
        {chId ? <Channel key={chId} channel={channels.find((c) => c.id === chId)} orgId={orgId} uid={uid} lang={lang} members={members} crews={crews} nameOfUser={nameOfUser} crewOf={crewOf} event={event} typing={typing} rt={rt} onError={setErr} /> : <div className="empty">{t('ch.empty', lang)}</div>}
      </main>
    </div>
  );
}

/* ─── 채널 본문: 메시지 목록 + 컴포저 ─── */
function Channel({ channel, orgId, uid, lang, members, crews, nameOfUser, crewOf, event, typing, rt, onError }) {
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
    if (event.kind === 'message' && event.channel_id === chId) load(msgs.at(-1)?.id ?? 0).catch(() => {});
    if (event.kind === 'approval' && event.channel_id === chId) load(msgs.at(-1)?.id ?? 0).catch(() => {});
  }, [event]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { feed.current?.scrollTo({ top: feed.current.scrollHeight }); }, [msgs.length]);
  // 폴링 폴백(10s) — Realtime이 끊기거나 구독이 거부돼도 새 메시지가 화면에 도달한다(정본은 언제나 조회, 방송은 깨우기 신호)
  useEffect(() => { const iv = setInterval(() => load(msgs.at(-1)?.id ?? 0).catch(() => {}), 10_000); return () => clearInterval(iv); }, [load, msgs]);
  const decide = async (ap, status) => {
    const res = await supabase.from('msgr_crew_approvals').update({ status, decided_by: uid, decided_at: new Date().toISOString() }).eq('id', ap.id).select('id');
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t('ap.ownerOnly', lang)); // RLS 0행 = 소유자가 아니다
    load(msgs.at(-1)?.id ?? 0).catch(() => {});
  };
  const typingNames = Object.entries(typing).filter(([k, at]) => k.startsWith(`${chId}:`) && Date.now() - at < 6000).map(([k]) => crewOf(k.split(':')[1])?.display_name).filter(Boolean);
  return (<>
    <div className="head"><h2>{channel.kind === 'private' ? '🔒 ' : '# '}{channel.name}</h2><span className="muted">{channel.topic}</span>{channel.crew_memory === false && <span className="chip" title={t('ch.crewMemory', lang)}>🧠✕</span>}</div>
    <div className="feed" ref={feed}>
      {!msgs.length && <div className="empty">{t('ch.empty', lang)}</div>}
      {msgs.map((m) => <Message key={m.id} m={m} lang={lang} nameOfUser={nameOfUser} crewOf={crewOf} aps={aps} atts={atts[m.id] ?? []} decide={decide} parent={m.reply_to ? msgs.find((x) => x.id === m.reply_to) : null} />)}
    </div>
    <Composer chId={chId} orgId={orgId} uid={uid} lang={lang} members={members} crews={crews} rt={rt} typingNames={typingNames} onSent={() => load(msgs.at(-1)?.id ?? 0).catch(() => {})} onError={onError} />
  </>);
}

function Message({ m, lang, nameOfUser, crewOf, aps, atts, decide, parent }) {
  const crew = m.crew_id ? crewOf(m.crew_id) : null;
  const name = m.author_kind === 'user' ? nameOfUser(m.author_user_id) : (crew?.display_name ?? '크루');
  const ap = m.kind === 'approval_card' ? aps[(m.mentions ?? []).find((x) => x.kind === 'approval')?.id] : null;
  const body = m.deleted_at ? '' : m.body;
  return (
    <div className={`m ${m.author_kind}${m.kind === 'system' ? ' system' : ''}`}>
      <div className="av">{initials(name)}</div>
      <div>
        <div className="who">{name}{crew?.role_text && <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{crew.role_text}</span>}<span className="ts">{fmtTs(m.created_at, lang)}</span></div>
        {parent && <div className="quote">↩ {parent.author_kind === 'user' ? nameOfUser(parent.author_user_id) : crewOf(parent.crew_id)?.display_name}: {parent.body}</div>}
        {ap ? (
          <div className="card-ap">
            <div><strong>{t('ap.pending', lang).replace(t('ap.pending', lang), ap.status === 'pending' ? t('ap.pending', lang) : t(`ap.${ap.status}`, lang))}</strong> — {ap.action}</div>
            {ap.reason && <div className="muted">{ap.reason}</div>}
            <div className="row">
              {ap.status === 'pending' ? (<>
                <button className="btn primary small" onClick={() => decide(ap, 'approved')}>{t('ap.approve', lang)}</button>
                <button className="btn small" onClick={() => decide(ap, 'rejected')}>{t('ap.reject', lang)}</button>
                <span className="muted" style={{ fontSize: 12 }}>{t('ap.ownerOnly', lang)}</span>
              </>) : <span className="muted" style={{ fontSize: 12 }}>{t('ap.by', lang, { name: nameOfUser(ap.decided_by) })}</span>}
            </div>
          </div>
        ) : <div className="body" dangerouslySetInnerHTML={md(body)} />}
        {atts.map((a) => <Attachment key={a.id} a={a} />)}
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
  return <button className="att" onClick={open}>📎 {a.name} <span className="muted">{a.bytes ? `${Math.round(a.bytes / 1024)}KB` : ''}</span></button>;
}

/* ─── 컴포저: @멘션 팝업(사람·크루), Enter 전송(IME 조합 중 제외), 첨부 ─── */
function Composer({ chId, orgId, uid, lang, members, crews, rt, typingNames, onSent, onError }) {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [files, setFiles] = useState([]);
  const [pop, setPop] = useState(null); const [sel, setSel] = useState(0);
  const ta = useRef(null);
  const candidates = useMemo(() => {
    if (!pop) return [];
    const needle = pop.q.toLowerCase();
    const list = [...crews.map((c) => ({ kind: 'crew', id: c.id, name: c.display_name, sub: c.role_text })), ...members.map((m) => ({ kind: 'user', id: m.user_id, name: m.display_name || m.user_id.slice(0, 8), sub: m.role }))];
    return list.filter((x) => !needle || x.name.toLowerCase().includes(needle)).slice(0, 8);
  }, [pop, crews, members]);
  const [mentions, setMentions] = useState([]); // 확정된 멘션 {kind,id,name}
  const onChange = (e) => {
    const v = e.target.value; setText(v);
    const upto = v.slice(0, e.target.selectionStart);
    const m = upto.match(/(?:^|\s)@([^\s@]*)$/);
    setPop(m ? { q: m[1], start: upto.length - m[1].length - 1 } : null); setSel(0);
  };
  const pick = (c) => {
    const before = text.slice(0, pop.start); const after = text.slice(ta.current.selectionStart);
    const next = `${before}@${c.name} ${after}`;
    setText(next); setMentions((ms) => ms.some((x) => x.id === c.id) ? ms : [...ms, c]); setPop(null);
    requestAnimationFrame(() => { ta.current?.focus(); const p = before.length + c.name.length + 2; ta.current?.setSelectionRange(p, p); });
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
        if (up.error) { onError(`${t('msg.attachFail', lang)}: ${f.name} — ${up.error.message}`); continue; }
        await q(supabase.from('msgr_attachments').insert({ message_id: row.id, org_id: orgId, storage_path: path, name: f.name, mime: f.type, bytes: f.size }));
      }
      setText(''); setMentions([]); setFiles([]); onSent();
    } catch (e) { onError(e.message); } finally { setBusy(false); }
  };
  const onKey = (e) => {
    if (e.nativeEvent.isComposing) return; // IME 조합 중 Enter는 확정 키
    if (pop && candidates.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % candidates.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + candidates.length) % candidates.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(candidates[sel]); return; }
      if (e.key === 'Escape') { setPop(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  return (
    <div className="compose">
      {pop && candidates.length > 0 && <div className="popup">{candidates.map((c, i) => <button key={`${c.kind}:${c.id}`} className={i === sel ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(c); }}><span className="chip">{c.kind === 'crew' ? '🤖' : '👤'}</span>{c.name}<span className="muted" style={{ fontSize: 11 }}>{c.sub}</span></button>)}</div>}
      <div className="typing">{typingNames.length ? t('msg.typing', lang, { name: typingNames.join(', ') }) : ''}</div>
      <textarea ref={ta} value={text} onChange={onChange} onKeyDown={onKey} placeholder={t('msg.placeholder', lang)} rows={2} />
      <div className="row">
        <div>
          <label className="btn small" style={{ cursor: 'pointer' }}>{t('msg.attach', lang)}<input type="file" multiple hidden onChange={(e) => setFiles([...e.target.files])} /></label>
          {files.map((f) => <span key={f.name} className="att">{f.name}</span>)}
        </div>
        <button className="btn primary" onClick={send} disabled={busy || !text.trim()}>{t('msg.send', lang)}</button>
      </div>
    </div>
  );
}
