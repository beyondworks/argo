// Argo 메신저 — 조직·채널·메시지·크루·결재 슬립. 데이터는 Supabase 직결(RLS가 경계), 실시간은 private topic org:<id> 방송.
// 룩 = linen v2(apps/messenger/design): 타임라인 척추 · 사람 원/크루 타일 · 2단 다크 독 · 결재 슬립 · 자체 아이콘(icons.jsx).
// Argo 부품은 .shell/.side(테마 토큰 스코프)·.btn·Markdown·imeGuardWith만 쓰고, 나머지는 styles.css의 .msgr-*.
// 1차 범위(MESSENGER-DESIGN.md P1): 로그인 · 조직/초대 · 공개/비공개 채널 · 메시지 · @멘션 · 첨부 · 결재 · 크루 부재중 · 타이핑.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, configured, q } from './supabase.js';
import { t as tm } from './i18n.js';
import { useLang } from '@argo/i18n';
import { useTheme, THEMES } from '@argo/theme';
import { Markdown, imeGuardWith } from '@argo/ui';
import { Sprite, I, STAR_D } from './icons.jsx';

const AWAY_MS = 90_000;
/** 크루 등급(부록 I·K) — 서버 함수 msgr_crew_tier와 같은 규칙: 조직 서비스 계정이 소유하고 상주 노드에서 돌면 회사 크루, 그 외는 개인(파견) 크루. 화면 표시용이며 판정 정본은 서버. */
export const crewTier = (crew, org) => (org?.service_user_id && crew?.owner_user_id === org.service_user_id && crew?.hosting === 'resident') ? 'company' : 'personal';
const PAGE = 100;
const CHIP_MAX = 6; // 채널 칩 랩 상한 — 초과분은 점선 '+N' 칩 뒤로(평가 v2: 태그 구름 방지)
const ATTACH_MAX = 25 * 1024 * 1024; // 브리지 ATTACH_MAX(src/gateway/msgr.mjs)와 같은 값 — 받는 쪽에서만 거절하면 보낸 사람은 이유를 모른다
const fmtTs = (iso, lang) => new Date(iso).toLocaleTimeString(lang === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' });
const dayKey = (iso) => new Date(iso).toDateString();
const fmtDay = (iso, lang) => { const d = new Date(iso); return lang === 'en'
  ? [d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), d.toLocaleDateString('en-US', { weekday: 'long' })]
  : [d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }), d.toLocaleDateString('ko-KR', { weekday: 'long' })]; };

/** 메신저 사전 t — 언어 상태는 Argo LanguageProvider(cmd+/ 전환·localStorage argo-lang)를 그대로 쓴다. */
function useT() { const { lang, setLang, t: ta } = useLang(); return { lang, setLang, ta, t: (k, vars) => tm(k, lang, vars) }; }

/** 아바타 — 사람은 원, 크루는 둥근 사각 타일 + 옐로 별(시안 v2 모티프 ②). */
function Av({ name, crew, size, company = false }) { // company: 회사 크루(조직 배지 — 별 대신 각진 해시), 그 외 크루는 별 배지(부록 I·K 등급 표시)
  return <span className={`msgr-av${crew ? ' crew' : ''}${company ? ' company' : ''}${size ? ` ${size}` : ''}`}>{(name || '?').slice(0, 1)}{crew && <span className="star">{company ? <I name="hash" size={8} /> : <svg viewBox="0 0 16 16"><path d={STAR_D} /></svg>}</span>}</span>;
}
/** 본문 속 @멘션을 굵게·줄바꿈 금지로(평가 1차: @와 이름 사이 줄바꿈). */
function Body({ text }) {
  // 앞이 문자열 시작/공백일 때만 멘션(이메일의 @domain은 제외 — 검수 M4)
  const parts = String(text ?? '').split(/((?:^|(?<=\s))@[^\s@]+)/g);
  return parts.map((p, i) => p.startsWith('@') ? <span key={i} className="msgr-mention">{p}</span> : p);
}

export default function App() {
  const { t } = useT();
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    if (!supabase) { setSession(null); return; }
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  let body;
  if (!configured) body = <div className="msgr-auth"><div className="msgr-card"><div className="body"><p style={{ color: 'var(--danger)' }}>{t('auth.notConfigured')}</p></div></div></div>;
  else if (session === undefined) body = <div className="msgr-auth"><span className="msgr-klabel">{t('ui.loading')}</span></div>;
  else if (!session) body = <Auth />;
  else body = <Shell session={session} />;
  return <><Sprite />{body}</>;
}

/* ─── 로그인: 머리띠 카드 + 이메일 OTP(운영). 개발 빌드에서는 비밀번호 로그인도(로컬 스택엔 메일 서버가 없다). ─── */
function Auth() {
  const { t, lang, setLang } = useT();
  const [email, setEmail] = useState(''); const [code, setCode] = useState(''); const [pw, setPw] = useState('');
  const [sent, setSent] = useState(false); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const run = async (fn) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  return (
    <div className="msgr-auth"><form className="msgr-card" onSubmit={(e) => e.preventDefault()}>
      <div className="band"><svg width="14" height="14" viewBox="0 0 16 16"><path d={STAR_D} /></svg>ARGO<span className="tag">{t('auth.tag')}</span></div>
      <div className="body">
        <h1>{t('auth.title')}</h1>
        <p>{t('auth.desc')}</p>
        <label className="msgr-field"><I name="at" /><input type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
        {!sent ? (
          <button className="btn btn-primary" disabled={busy || !email} onClick={() => run(async () => { await q(supabase.auth.signInWithOtp({ email })); setSent(true); })}>{t('auth.sendCode')} <I name="up" size={14} /></button>
        ) : (<>
          <p>{t('auth.sent')}</p>
          <label className="msgr-field"><I name="lock" /><input placeholder={t('auth.code')} value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <button className="btn btn-primary" disabled={busy || !code} onClick={() => run(async () => { await q(supabase.auth.verifyOtp({ email, token: code.trim(), type: 'email' })); })}>{t('auth.verify')}</button>
        </>)}
        {import.meta.env.DEV && (<>
          <label className="msgr-field"><I name="lock" /><input type="password" placeholder={t('auth.password')} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <button className="btn" disabled={busy || !email || !pw} onClick={() => run(async () => { await q(supabase.auth.signInWithPassword({ email, password: pw })); })}>{t('auth.verify')} (dev)</button>
        </>)}
        {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}
        <div className="foot"><I name="lock" size={13} /><span style={{ flex: 1 }}>{t('auth.foot')}</span><button type="button" className="btn sm" onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')}>{t('ui.lang')}</button></div>
      </div>
    </form></div>
  );
}

/* ─── 셸: 레일(조직·채널 칩·크루 카드·멤버 스택) + 본문 ─── */
function Shell({ session }) {
  const { t } = useT();
  const uid = session.user.id;
  const [orgs, setOrgs] = useState(null); const [orgId, setOrgId] = useState(null);
  const [channels, setChannels] = useState([]); const [chId, setChId] = useState(null);
  const [members, setMembers] = useState([]); const [crews, setCrews] = useState([]);
  const [chMembers, setChMembers] = useState([]); // 현재 채널의 msgr_channel_members(비공개·DM)
  const [ent, setEnt] = useState(null); const [policy, setPolicy] = useState(null); // msgr_org_entitlements(plan·seats) — 좌석 표시·한도 안내
  const [dmMembers, setDmMembers] = useState({}); // dm 채널 id → 멤버 행(레일 라벨용: 나 아닌 참가자)
  const [err, setErr] = useState(''); const [note, setNote] = useState('');
  const [tick, setTick] = useState(0);
  const [rail, setRail] = useState(false); // 폰 폭: 메뉴 버튼으로 레일 열기
  const [allChips, setAllChips] = useState(false);
  const [page, setPage] = useState('chat'); // 'chat' | 'settings' — 언어·테마·계정은 설정 페이지(유건 실검수 2026-09-03)
  const [orgMenu, setOrgMenu] = useState(false);
  const [sheet, setSheet] = useState(null); // 크루 시트(크루 id) — 허용 범위·소유자·접속
  const [chSheet, setChSheet] = useState(false); // 채널 시트 — 이름·주제·기억·멤버·보관
  const rt = useRef(null);
  const loadOrgs = useCallback(async () => {
    const rows = await q(supabase.from('msgr_org_members').select('org_id, role, msgr_orgs(id, name, slug, service_user_id)').eq('user_id', uid).is('removed_at', null));
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
      } catch (e) { setErr(/msgr_seat_limit/.test(e.message) ? t('seat.limit') : e.message); await loadOrgs().catch(() => {}); }
    })();
  }, [loadOrgs]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadOrg = useCallback(async (id) => {
    if (!id) return;
    const [chs, mems, crs, e, pol] = await Promise.all([
      q(supabase.from('msgr_channels').select('id, kind, name, topic, crew_memory, created_by').eq('org_id', id).is('archived_at', null).order('created_at')),
      q(supabase.from('msgr_org_members').select('user_id, role, display_name').eq('org_id', id).is('removed_at', null)),
      q(supabase.from('msgr_crews').select('id, owner_user_id, slug, display_name, role_text, hosting, status, allow, allow_users, last_seen_at').eq('org_id', id).eq('status', 'active')),
      supabase.from('msgr_org_entitlements').select('plan, seats').eq('org_id', id).maybeSingle().then((r) => r.data ?? null),
      supabase.from('msgr_org_policies').select('allow_default, allow_locked, crew_memory_default, crew_memory_locked, approval_high_by').eq('org_id', id).maybeSingle().then((r) => r.data ?? null), // H-0 조직 정책(없으면 null = 잠금 없음)
    ]);
    setChannels(chs); setMembers(mems); setCrews(crs); setEnt(e); setPolicy(pol);
    setChId((cur) => cur && chs.some((c) => c.id === cur) ? cur : (chs[0]?.id ?? null)); // 라벨용 보조 조회보다 먼저(검수 2R LOW-1: 보조 조회가 던지면 채널 선택이 안 됐다)
    const dmIds = chs.filter((c) => c.kind === 'dm').map((c) => c.id);
    if (dmIds.length) { try { const rows = await q(supabase.from('msgr_channel_members').select('channel_id, member_kind, member_id').in('channel_id', dmIds)); const map = {}; for (const r of rows) (map[r.channel_id] ??= []).push(r); setDmMembers(map); } catch { setDmMembers({}); } } else setDmMembers({});
  }, []);
  useEffect(() => { loadOrg(orgId).catch((e) => setErr(e.message)); }, [orgId, loadOrg]);
  const loadChMembers = useCallback(async (id) => { if (!id) { setChMembers([]); return; } const rows = await q(supabase.from('msgr_channel_members').select('member_kind, member_id, added_by').eq('channel_id', id)); setChMembers(rows); }, []);
  useEffect(() => { loadChMembers(chId).catch(() => setChMembers([])); }, [chId, loadChMembers, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setChSheet(false); }, [chId]); // 채널을 바꿀 때만 닫는다(검수 HIGH-1: tick 의존이면 15초마다 시트가 닫혔다)
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
  useEffect(() => { if (!rail && !orgMenu) return; const on = (e) => { if (e.key === 'Escape') { setRail(false); setOrgMenu(false); } }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [rail, orgMenu]);
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
  // 1:1 대화 — 사람(user) 또는 크루(crew)와. 이미 있으면 열고, 없으면 dm 채널 + 멤버(나·상대·크루면 소유자까지) 생성
  const openDm = async (kind, id) => {
    try {
      const mine = await q(supabase.from('msgr_channel_members').select('channel_id, msgr_channels!inner(id, kind, org_id, archived_at)').eq('member_kind', 'user').eq('member_id', uid));
      const dmIds = mine.filter((r) => r.msgr_channels?.kind === 'dm' && r.msgr_channels.org_id === orgId && !r.msgr_channels.archived_at).map((r) => r.channel_id);
      if (dmIds.length) {
        const others = await q(supabase.from('msgr_channel_members').select('channel_id, member_kind, member_id').in('channel_id', dmIds));
        const wantUsers = new Set(kind === 'crew' ? [uid, crewOf(id)?.owner_user_id].filter(Boolean) : [uid, id]); // 자기 크루면 {나}, 남의 크루면 {나, 소유자}
        const hit = dmIds.find((cid) => { const ms = others.filter((m) => m.channel_id === cid); const users = new Set(ms.filter((m) => m.member_kind === 'user').map((m) => m.member_id)); const crewsIn = ms.filter((m) => m.member_kind === 'crew').map((m) => m.member_id); const sameUsers = users.size === wantUsers.size && [...wantUsers].every((u) => users.has(u)); return sameUsers && (kind === 'crew' ? crewsIn.length === 1 && crewsIn[0] === id : crewsIn.length === 0); });
        if (hit) { setChId(hit); setPage('chat'); setRail(false); setSheet(null); return; }
      }
      const other = kind === 'crew' ? crewOf(id) : members.find((m) => m.user_id === id);
      const name = kind === 'crew' ? other?.display_name : (other?.display_name || id.slice(0, 8));
      const c = await q(supabase.from('msgr_channels').insert({ org_id: orgId, kind: 'dm', name: `dm:${name}`, created_by: uid }).select('id').single());
      const rows = [{ channel_id: c.id, member_kind: 'user', member_id: uid, added_by: uid }, { channel_id: c.id, member_kind: kind, member_id: id, added_by: uid }];
      if (kind === 'crew' && other && other.owner_user_id !== uid) rows.push({ channel_id: c.id, member_kind: 'user', member_id: other.owner_user_id, added_by: uid }); // 크루 = 소유자 동반 규칙
      await q(supabase.from('msgr_channel_members').insert(rows));
      await loadOrg(orgId); setChId(c.id); setPage('chat'); setRail(false); setSheet(null);
    } catch (e) { setErr(e.message); }
  };
  const createChannel = async () => {
    const name = prompt(t('ch.name')); if (!name?.trim()) return;
    const priv = confirm(`${t('ch.private')}?`);
    try {
      const c = await q(supabase.from('msgr_channels').insert({ org_id: orgId, kind: priv ? 'private' : 'public', name: name.trim(), created_by: uid }).select('id').single());
      if (priv) await q(supabase.from('msgr_channel_members').insert({ channel_id: c.id, member_kind: 'user', member_id: uid, added_by: uid }));
      await loadOrg(orgId); setChId(c.id);
    } catch (e) { setErr(/msgr_channel_limit/.test(e.message) ? t('ch.freeLimit') : e.message); }
  };
  if (orgs === null) return <div className="msgr-auth"><span className="msgr-klabel">{t('ui.loading')}</span></div>;
  const channel = channels.find((c) => c.id === chId);
  // 채널 칩 — 정렬: 현재 → 이름순. 6개 초과는 '+N'(펼치기)
  // DM 라벨 = 나 아닌 참가자(검수 MEDIUM-2: 저장된 이름은 생성자 시점). 크루 DM에 다른 사람도 있으면(소유자 동반) '서윤 · 민수'처럼 병기
  const dmName = (c) => { const ms = dmMembers[c.id] ?? []; const crew = ms.find((m) => m.member_kind === 'crew'); const other = ms.find((m) => m.member_kind === 'user' && m.member_id !== uid); if (crew) return [crewOf(crew.member_id)?.display_name ?? c.name.replace(/^dm:/, ''), other ? nameOfUser(other.member_id) : null].filter(Boolean).join(' · '); return other ? nameOfUser(other.member_id) : c.name.replace(/^dm:/, ''); };
  const dms = channels.filter((c) => c.kind === 'dm');
  const sortedCh = [...channels].filter((c) => c.kind !== 'dm').sort((a, b) => (a.id === chId ? -1 : b.id === chId ? 1 : a.name.localeCompare(b.name)));
  const shownCh = allChips ? sortedCh : sortedCh.slice(0, CHIP_MAX);
  return (
    <div className={`shell msgr-shell${rail ? ' rail-open' : ''}`}>
      {rail && <div className="msgr-scrim" onClick={() => setRail(false)} role="presentation" />}
      <aside className="side msgr-side">
        <div className="msgr-brand"><svg width="14" height="14" viewBox="0 0 16 16"><path d={STAR_D} /></svg>ARGO</div>
        <div className="msgr-orgwrap">
          <button type="button" className={`msgr-org${orgMenu ? ' open' : ''}`} onClick={() => setOrgMenu((v) => !v)} aria-haspopup="menu" aria-expanded={orgMenu} title={t('org.switch')}>
            <Av name={org?.name ?? '?'} /><span className="name">{org?.name ?? t('org.pick')}</span><I name="caret" size={14} className="caret" />
          </button>
          {orgMenu && (<>
            <div className="msgr-scrim clear" onClick={() => setOrgMenu(false)} />
            <div className="msgr-menu-pop" role="menu">
              {orgs.map((o) => <button key={o.id} type="button" role="menuitemradio" aria-checked={o.id === orgId} className={o.id === orgId ? 'on' : ''} onClick={() => { setOrgId(o.id); setOrgMenu(false); }}><Av name={o.name} size="sm" /><span className="label">{o.name}</span><span className="msgr-klabel">{t(`role.${o.role}`)}</span></button>)}
              {ent && <div className="seatline"><span className="msgr-klabel">{t('seat.status', { used: members.length, seats: ent.seats, plan: t(`plan.${ent.plan}`) })}</span></div>}
              <div className="sep" />
              <button type="button" role="menuitem" onClick={() => { setOrgMenu(false); createOrg(); }}><span className="msgr-av sm ghost"><I name="plus" size={13} /></span><span className="label">{t('org.new')}</span></button>
            </div>
          </>)}
        </div>
        <div className="msgr-group">{t('ch.list')}<button type="button" className="btn" onClick={createChannel} disabled={!orgId} title={t('ch.new')} aria-label={t('ch.new')}><I name="plus" size={14} /></button></div>
        {channels.length ? (
          <div className="msgr-chips">
            {shownCh.map((c) => (
              <button key={c.id} type="button" className={`msgr-chan${c.id === chId ? ' active' : ''}`} onClick={() => { setChId(c.id); setRail(false); setPage('chat'); }}>
                <I name={c.kind === 'private' ? 'lock' : 'hash'} size={13} /><span>{c.name}</span>
              </button>
            ))}
            {sortedCh.length > CHIP_MAX && <button type="button" className="msgr-chan more" onClick={() => setAllChips((v) => !v)}>{allChips ? '−' : t('ch.more', { n: sortedCh.length - CHIP_MAX })}</button>}
          </div>
        ) : <div className="msgr-hint">{orgId ? t('ch.empty') : t('org.none')}</div>}
        {dms.length > 0 && (<>
          <div className="msgr-group">{t('ch.dms')}</div>
          <div className="msgr-chips">{dms.map((c) => <button key={c.id} type="button" className={`msgr-chan${c.id === chId ? ' active' : ''}`} onClick={() => { setChId(c.id); setRail(false); setPage('chat'); }}><I name="at" size={13} /><span>{dmName(c)}</span></button>)}</div>
        </>)}
        <div className="msgr-group">{t('org.crews')}</div>
        {crews.map((c) => { const on = c.last_seen_at && Date.now() - Date.parse(c.last_seen_at) < AWAY_MS; return (
          <button key={c.id} type="button" className={`msgr-crewcard${sheet === c.id ? ' on' : ''}`} onClick={() => setSheet((s) => s === c.id ? null : c.id)} title={`${c.role_text ?? ''} · ${nameOfUser(c.owner_user_id)}`}>
            <Av name={c.display_name} crew size="lg" company={crewTier(c, org) === 'company'} />
            <span style={{ minWidth: 0 }}>
              <span className="name">{c.display_name}<span className={`st${on ? '' : ' off'}`}><span className={`msgr-dot${on ? ' mark' : ''}`} />{on ? t('crew.online') : t('crew.away')}</span></span>
              <span className="sub">{crewTier(c, org) === 'company' ? t('crew.tier.company.sub', { org: org?.name ?? '', role: c.role_text ?? '' }) : t('crew.tier.personal.sub', { name: nameOfUser(c.owner_user_id), role: c.role_text ?? '' })}</span>
            </span>
          </button>
        ); })}
        {!crews.length && <div className="msgr-hint">{t('org.crewsHint')}</div>}
        <div className="msgr-group">{t('org.members')} · {members.length}{isAdmin && <button type="button" className="btn" onClick={invite} title={t('org.invite')} aria-label={t('org.invite')}><I name="plus" size={14} /></button>}</div>
        <div className="msgr-stack" title={members.map((m) => `${m.display_name || m.user_id.slice(0, 8)} (${t(`role.${m.role}`)})`).join('\n')}>
          {members.slice(0, 6).map((m) => m.user_id === uid ? <Av key={m.user_id} name={m.display_name || m.user_id} /> : <button key={m.user_id} type="button" className="msgr-avbtn" onClick={() => openDm('user', m.user_id)} title={t('dm.with', { name: m.display_name || m.user_id.slice(0, 8) })}><Av name={m.display_name || m.user_id} /></button>)}
          <span className="more">{members.map((m) => m.display_name || m.user_id.slice(0, 8)).join(' · ')}</span>
        </div>
        <div className="msgr-foot">
          <Av name={me?.display_name || session.user.email} size="sm" />
          <span className="name">{me?.display_name || session.user.email}</span>
          <button type="button" className={`btn ghost${page === 'settings' ? ' on' : ''}`} onClick={() => { setPage((p) => p === 'settings' ? 'chat' : 'settings'); setRail(false); }} title={t('ui.settings')} aria-label={t('ui.settings')} aria-pressed={page === 'settings'}><I name="gear" size={15} /></button>
          <button type="button" className="btn ghost" onClick={() => supabase.auth.signOut({ scope: 'local' })} title={t('auth.signOut')} aria-label={t('auth.signOut')}><I name="out" size={15} /></button>
        </div>
      </aside>
      <main className="msgr-main">
        {sheet && crewOf(sheet) && <CrewSheet crew={crewOf(sheet)} org={org} uid={uid} me={me} members={members} policy={policy} channelId={chId} nameOfUser={nameOfUser} onClose={() => setSheet(null)} onChanged={() => loadOrg(orgId).catch(() => {})} onPosted={() => setEvent({ kind: 'message', channel_id: chId, at: Date.now() })} onNote={setNote} onError={setErr} onDm={() => openDm('crew', sheet)} />}
        {chSheet && channel && <ChannelSheet channel={channel} uid={uid} isAdmin={isAdmin} policy={policy} members={members} crews={crews} chMembers={chMembers} nameOfUser={nameOfUser} onClose={() => setChSheet(false)} onChanged={async () => { await loadOrg(orgId).catch(() => {}); await loadChMembers(chId).catch(() => {}); }} onArchived={() => { setChSheet(false); setChId(null); loadOrg(orgId).catch(() => {}); }} onNote={setNote} onError={setErr} />}
        {(err || note) && (
          <div className="msgr-notice">
            <span style={{ color: err ? 'var(--danger)' : 'var(--fg-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{err ? `${t('ui.error')}: ${err}` : note}</span>
            <button type="button" className="btn sm" style={{ border: 0, width: 24, height: 24, padding: 0 }} onClick={() => { setErr(''); setNote(''); }} aria-label="×"><I name="x" size={12} /></button>
          </div>
        )}
        {page === 'settings' ? (
          <Settings session={session} me={me} org={org} isAdmin={!!isAdmin} policy={policy} onChanged={() => loadOrg(orgId).catch((e) => setErr(e.message))} onNote={setNote} onError={setErr} onBack={() => setPage('chat')} onMenu={() => setRail(true)} />
        ) : chId ? (
          <Channel key={chId} channel={channel} orgId={orgId} uid={uid} isAdmin={!!isAdmin} policy={policy} members={members} crews={crews} nameOfUser={nameOfUser} crewOf={crewOf} event={event} typing={typing} onError={setErr} onMenu={() => setRail(true)} onCrew={setSheet} onTitle={() => setChSheet(true)} dmName={dmName} />
        ) : (
          <EmptyOrg org={org} onMenu={() => setRail(true)} createOrg={createOrg} createChannel={createChannel} invite={isAdmin ? invite : null} />
        )}
      </main>
    </div>
  );
}

/* ─── 크루 시트: 소유자·실행 위치·접속 + 누가 시킬 수 있나(소유자만 편집, RLS msgr_crews_update_owner) + 허용 요청 ─── */
function CrewSheet({ crew, org, uid, me, members, policy, channelId, nameOfUser, onClose, onChanged, onPosted, onNote, onError, onDm }) {
  const { t, lang } = useT();
  const owner = crew.owner_user_id === uid;
  const tier = crewTier(crew, org); // H-3: 회사 크루 / 개인(파견) 크루 — 판정 정본은 서버 msgr_crew_tier
  const locked = !!policy?.allow_locked; // H-0: 조직 정책이 잠그면 소유자도 못 바꾼다(서버 트리거 msgr_crew_policy_gate가 최종)
  const [allow, setAllow] = useState(crew.allow); const [list, setList] = useState(crew.allow_users ?? []); const [busy, setBusy] = useState(false);
  useEffect(() => { setAllow(crew.allow); setList(crew.allow_users ?? []); }, [crew.id, crew.allow, crew.allow_users]);
  useEffect(() => { const on = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [onClose]);
  const on = crew.last_seen_at && Date.now() - Date.parse(crew.last_seen_at) < AWAY_MS;
  const canMe = owner || crew.allow === 'all' || (crew.allow === 'list' && (crew.allow_users ?? []).includes(uid));
  const save = async (nextAllow, nextList) => {
    setBusy(true);
    const res = await supabase.from('msgr_crews').update({ allow: nextAllow, allow_users: nextAllow === 'list' ? nextList : [] }).eq('id', crew.id).select('id');
    setBusy(false);
    if (res.error) return onError(/msgr_policy_locked/.test(res.error.message) ? t('err.policyLocked') : res.error.message);
    if (!res.data?.length) return onError(t('crew.allow.readonly', { name: nameOfUser(crew.owner_user_id) })); // RLS 0행
    onNote(t('crew.allow.saved')); onChanged();
  };
  const pickAllow = (v) => { setAllow(v); if (v !== 'list') save(v, []); };
  const toggle = (id) => { const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]; setList(next); save('list', next); };
  const request = async () => {
    if (!channelId) return;
    const ownerName = nameOfUser(crew.owner_user_id); const meName = me?.display_name || uid.slice(0, 8);
    const body = t('crew.request.body', { owner: ownerName, me: meName, crew: crew.display_name });
    const { error } = await supabase.from('msgr_messages').insert({ channel_id: channelId, author_kind: 'user', author_user_id: uid, body, mentions: [{ kind: 'user', id: crew.owner_user_id }], client_msg_id: crypto.randomUUID() });
    if (error) return onError(error.message);
    onNote(t('crew.request.sent')); onPosted?.(); onClose();
  };
  const others = members.filter((m) => m.user_id !== crew.owner_user_id);
  return (
    <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={onClose} />
      <aside className="msgr-crewsheet" role="dialog" aria-label={t('crew.sheet')}>
        <div className="head">
          <Av name={crew.display_name} crew size="lg" company={tier === 'company'} />
          <div style={{ minWidth: 0 }}><div className="name">{crew.display_name}</div><div className="msgr-klabel">{crew.role_text}</div></div>
          <button type="button" className="btn ghost" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={15} /></button>
        </div>
        <div className="facts">
          <div><span className="msgr-klabel">{t('crew.tier')}</span><span className={`msgr-tier ${tier}`}>{tier === 'company' ? t('crew.tier.company') : t('crew.tier.personal')}</span></div>
          <div><span className="msgr-klabel">{t('crew.owner')}</span><span><Av name={nameOfUser(crew.owner_user_id)} size="sm" /> {tier === 'company' ? t('crew.tier.company.owner', { org: org?.name ?? '' }) : nameOfUser(crew.owner_user_id)}</span></div>
          <div><span className="msgr-klabel">{t('tab.crew')}</span><span>{t(`crew.hosting.${crew.hosting === 'resident' ? 'resident' : 'local'}`)}</span></div>
          <div><span className="msgr-klabel">{on ? t('crew.online') : t('crew.away')}</span><span><span className={`msgr-dot${on ? ' mark' : ''}`} /> {crew.last_seen_at ? t('crew.lastSeen', { when: fmtTs(crew.last_seen_at, lang) }) : '—'}</span></div>
        </div>
        <p className="note tier">{tier === 'company' ? t('crew.tier.company.note', { org: org?.name ?? '' }) : t('crew.tier.personal.note', { name: nameOfUser(crew.owner_user_id) })}</p>
        <section>
          <h3>{t('crew.allow')}</h3>
          <p>{t('crew.allow.desc')}</p>
          <div className="msgr-seg" role="radiogroup" aria-label={t('crew.allow')}>
            {['all', 'list', 'owner'].map((v) => <button key={v} type="button" role="radio" aria-checked={allow === v} className={allow === v ? 'active' : ''} disabled={!owner || busy || locked} onClick={() => pickAllow(v)}>{t(`crew.allow.${v}`)}</button>)}
          </div>
          {allow === 'list' && (
            <div className="picks">
              <span className="msgr-klabel">{t('crew.allow.pick')}</span>
              {others.map((m) => <label key={m.user_id} className={`pick${list.includes(m.user_id) ? ' on' : ''}`}><input type="checkbox" checked={list.includes(m.user_id)} disabled={!owner || busy} onChange={() => toggle(m.user_id)} /><Av name={m.display_name || m.user_id} size="sm" /><span>{m.display_name || m.user_id.slice(0, 8)}</span><span className="msgr-klabel">{t(`role.${m.role}`)}</span></label>)}
            </div>
          )}
          {locked ? <p className="note">{t('crew.allow.locked')}</p> : !owner && <p className="note">{t('crew.allow.readonly', { name: nameOfUser(crew.owner_user_id) })}</p>}
          <div className="me">
            <span className={`msgr-dot${canMe ? ' ok' : ''}`} /><span>{canMe ? t('crew.allow.me.yes') : t('crew.allow.me.no')}</span>
            {canMe && <button type="button" className="btn btn-primary sm" onClick={onDm} title={t('dm.crewNote')}><I name="at" size={13} />{t('ui.dm')}</button>}
            {!owner && !canMe && <button type="button" className="btn btn-primary sm" onClick={request} disabled={!channelId}><I name="at" size={13} />{t('crew.request')}</button>}
          </div>
        </section>
      </aside>
    </div>
  );
}

/* ─── 채널 시트: 이름·주제(관리자·생성자) · 크루 기억 스위치 · 멤버(비공개·DM: 사람·크루 추가/내보내기, 크루=소유자 동반) · 보관 ─── */
function ChannelSheet({ channel, uid, isAdmin, policy, members, crews, chMembers, nameOfUser, onClose, onChanged, onArchived, onNote, onError }) {
  const { t } = useT();
  const canEdit = isAdmin || channel.created_by === uid;
  const memLocked = !!policy?.crew_memory_locked; // H-0: 서버 트리거 msgr_channel_policy_gate가 최종
  const [name, setName] = useState(channel.name); const [topic, setTopic] = useState(channel.topic ?? ''); const [busy, setBusy] = useState(false); const [pick, setPick] = useState(null); // 'user' | 'crew'
  useEffect(() => { setName(channel.name); setTopic(channel.topic ?? ''); }, [channel.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const on = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [onClose]);
  const upd = async (patch, okMsg) => {
    setBusy(true);
    const res = await supabase.from('msgr_channels').update(patch).eq('id', channel.id).select('id');
    setBusy(false);
    if (res.error) return onError(/msgr_policy_locked/.test(res.error.message) ? t('err.policyLocked') : res.error.message);
    if (!res.data?.length) return onError(t('ch.noEdit'));
    if (okMsg) onNote(okMsg); await onChanged();
  };
  const saveText = () => upd({ name: name.trim() || channel.name, topic: topic.trim() || null }, t('ch.saved'));
  const addMember = async (kind, id) => {
    setBusy(true);
    const rows = [{ channel_id: channel.id, member_kind: kind, member_id: id, added_by: uid }];
    const crew = kind === 'crew' ? crews.find((c) => c.id === id) : null;
    if (crew && !chMembers.some((m) => m.member_kind === 'user' && m.member_id === crew.owner_user_id)) rows.push({ channel_id: channel.id, member_kind: 'user', member_id: crew.owner_user_id, added_by: uid }); // 크루 = 소유자 동반
    const res = await supabase.from('msgr_channel_members').upsert(rows, { onConflict: 'channel_id,member_kind,member_id' });
    setBusy(false); setPick(null);
    if (res.error) return onError(res.error.message);
    await onChanged();
  };
  const removeMember = async (kind, id) => {
    if (kind === 'user' && crews.some((c) => c.owner_user_id === id && chMembers.some((m) => m.member_kind === 'crew' && m.member_id === c.id))) return onError(t('ch.remove.ownerBlocked')); // 검수 HIGH-3: 소유자가 빠지면 크루가 조용히 죽는다
    setBusy(true);
    const res = await supabase.from('msgr_channel_members').delete().eq('channel_id', channel.id).eq('member_kind', kind).eq('member_id', id).select('member_id');
    setBusy(false);
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t('ch.noEdit'));
    await onChanged();
  };
  const archive = async () => { if (!confirm(t('ch.archive.confirm'))) return; await upd({ archived_at: new Date().toISOString() }); onArchived(); };
  const userIds = new Set(chMembers.filter((m) => m.member_kind === 'user').map((m) => m.member_id));
  const crewIds = new Set(chMembers.filter((m) => m.member_kind === 'crew').map((m) => m.member_id));
  const addableUsers = members.filter((m) => !userIds.has(m.user_id));
  const addableCrews = crews.filter((c) => !crewIds.has(c.id));
  const scoped = channel.kind !== 'public';
  return (
    <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={onClose} />
      <aside className="msgr-crewsheet" role="dialog" aria-label={t('ch.sheet')}>
        <div className="head">
          <span className="msgr-av lg" style={{ borderRadius: 12 }}><I name={channel.kind === 'private' ? 'lock' : channel.kind === 'dm' ? 'at' : 'hash'} size={18} /></span>
          <div style={{ minWidth: 0 }}><div className="name">{channel.kind === 'dm' ? t('ch.kind.dm') : channel.name}</div><div className="msgr-klabel">{t(`ch.kind.${channel.kind}`)}</div></div>
          <button type="button" className="btn ghost" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={15} /></button>
        </div>
        {channel.kind !== 'dm' && (
          <section>
            <label className="field"><span className="msgr-klabel">{t('ch.name')}</span><input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit || busy} /></label>
            <label className="field"><span className="msgr-klabel">{t('ch.topic')}</span><input value={topic} placeholder={t('ch.topic.ph')} onChange={(e) => setTopic(e.target.value)} disabled={!canEdit || busy} /></label>
            {canEdit ? <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || (name === channel.name && (topic || '') === (channel.topic || ''))} onClick={saveText}><I name="check" size={13} />{t('ui.save')}</button></div> : <p className="note">{t('ch.noEdit')}</p>}
          </section>
        )}
        <section>
          <h3>{t('ch.memory')}</h3>
          <label className="switchrow"><input type="checkbox" checked={channel.crew_memory !== false} disabled={!canEdit || busy || memLocked} onChange={(e) => upd({ crew_memory: e.target.checked })} /><span>{channel.crew_memory === false ? t('ch.memory.off') : t('ch.memory.on')}</span></label>
          {memLocked && <p className="note">{t('ch.memory.locked')}</p>}
        </section>
        <section>
          <h3>{t('ch.members')}</h3>
          {!scoped && <p>{t('ch.members.public')}</p>}
          {scoped && (<>
            <div className="picks">
              {chMembers.map((m) => { const isMe = m.member_kind === 'user' && m.member_id === uid; const crew = m.member_kind === 'crew' ? crews.find((c) => c.id === m.member_id) : null; const label = m.member_kind === 'crew' ? (crew?.display_name ?? '?') : nameOfUser(m.member_id); return (
                <div key={`${m.member_kind}:${m.member_id}`} className="pick on"><Av name={label} crew={m.member_kind === 'crew'} size="sm" /><span>{label}</span><span className="msgr-klabel">{m.member_kind === 'crew' ? `${t('org.crews')} · ${nameOfUser(crew?.owner_user_id)}` : t(`role.${members.find((x) => x.user_id === m.member_id)?.role ?? 'member'}`)}</span>{canEdit && !isMe && channel.kind !== 'dm' && <button type="button" className="btn sm" disabled={busy} onClick={() => removeMember(m.member_kind, m.member_id)}>{t('ch.remove')}</button>}</div>
              ); })}
            </div>
            {canEdit && channel.kind !== 'dm' && (
              <div className="row">
                <button type="button" className="btn sm" disabled={busy || !addableUsers.length} onClick={() => setPick(pick === 'user' ? null : 'user')}><I name="plus" size={13} />{t('ch.add.user')}</button>
                <button type="button" className="btn sm" disabled={busy || !addableCrews.length} onClick={() => setPick(pick === 'crew' ? null : 'crew')}><I name="star" size={13} />{t('ch.add.crew')}</button>
              </div>
            )}
            {pick === 'user' && <div className="msgr-chips">{addableUsers.map((m) => <button key={m.user_id} type="button" className="msgr-chan" onClick={() => addMember('user', m.user_id)}><span>{m.display_name || m.user_id.slice(0, 8)}</span></button>)}</div>}
            {pick === 'crew' && (<><div className="msgr-chips">{addableCrews.map((c) => <button key={c.id} type="button" className="msgr-chan" onClick={() => addMember('crew', c.id)}><I name="star" size={13} /><span>{c.display_name}</span></button>)}</div><p className="note">{t('ch.add.crewNote')}</p></>)}
          </>)}
        </section>
        {canEdit && channel.kind !== 'dm' && (
          <section><div className="row"><button type="button" className="btn sm" disabled={busy} onClick={archive}><I name="x" size={13} />{t('ch.archive')}</button></div></section>
        )}
      </aside>
    </div>
  );
}

/* ─── 설정 페이지: 언어 · 테마(아르고와 같은 가족×모드) · 계정 ─── */
const FAMILIES = [['linen', 'settings.family.linen'], ['graphite', 'settings.family.graphite'], ['argo', 'settings.family.argo']];
const MODES = [['', 'set.mode.system'], ['-light', 'set.mode.light'], ['-dark', 'set.mode.dark']];
const FAMILY_CODES = FAMILIES.flatMap(([f]) => MODES.map(([s]) => `${f}${s}`));
function Settings({ session, me, org, isAdmin, policy, onChanged, onNote, onError, onBack, onMenu }) {
  const { t, ta, lang, setLang } = useT();
  const { theme, setTheme } = useTheme();
  const family = FAMILIES.map(([f]) => f).find((f) => theme === f || theme.startsWith(`${f}-`)) ?? null;
  const mode = family ? theme.slice(family.length) : null;
  const skins = THEMES.filter((c) => !FAMILY_CODES.includes(c));
  return (<>
    <div className="msgr-top">
      <button type="button" className="msgr-menu" onClick={onMenu} aria-label={t('ui.menu')}><I name="menu" /></button>
      <span className="title"><I name="gear" size={18} />{t('ui.settings')}</span>
      <button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button>
    </div>
    <div className="msgr-thread"><div className="msgr-settings">
      <section className="msgr-setcard">
        <h2>{t('set.lang')}</h2><p>{t('set.lang.desc')}</p>
        <div className="msgr-seg" role="radiogroup" aria-label={t('set.lang')}>
          {[['ko', '한국어'], ['en', 'English']].map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={lang === v} className={lang === v ? 'active' : ''} onClick={() => setLang(v)}>{l}</button>)}
        </div>
      </section>
      <section className="msgr-setcard">
        <h2>{t('set.theme')}</h2><p>{t('set.theme.desc')}</p>
        <div className="row">
          <span className="msgr-klabel">{t('set.family')}</span>
          <div className="msgr-seg" role="radiogroup" aria-label={t('set.family')}>
            {FAMILIES.map(([f, label]) => <button key={f} type="button" role="radio" aria-checked={family === f} className={family === f ? 'active' : ''} onClick={() => setTheme(`${f}${mode ?? ''}`)}>{ta(label)}</button>)}
          </div>
        </div>
        <div className="row">
          <span className="msgr-klabel">{t('set.mode')}</span>
          <div className="msgr-seg" role="radiogroup" aria-label={t('set.mode')}>
            {MODES.map(([s, label]) => <button key={s} type="button" role="radio" aria-checked={family != null && mode === s} className={family != null && mode === s ? 'active' : ''} onClick={() => setTheme(`${family ?? 'linen'}${s}`)}>{t(label)}</button>)}
          </div>
        </div>
        <div className="row">
          <span className="msgr-klabel">{t('set.skins')}</span>
          <div className="msgr-chips">{skins.map((c) => <button key={c} type="button" className={`msgr-chan${theme === c ? ' active' : ''}`} onClick={() => setTheme(c)} title={ta(`settings.theme.${c}`)}><span>{ta(`settings.theme.${c}`).split(' — ')[0]}</span></button>)}</div>
        </div>
      </section>
      {org && policy && <PolicyCard org={org} isAdmin={isAdmin} policy={policy} onChanged={onChanged} onNote={onNote} onError={onError} />}
      <section className="msgr-setcard">
        <h2>{t('set.account')}</h2><p>{t('set.account.desc')}</p>
        <div className="row"><Av name={me?.display_name || session.user.email} /><span style={{ fontWeight: 600 }}>{me?.display_name || '—'}</span><span className="msgr-klabel">{session.user.email}</span></div>
        <div className="row"><button type="button" className="btn sm" onClick={() => supabase.auth.signOut({ scope: 'local' })}><I name="out" size={13} />{t('auth.signOut')}</button></div>
      </section>
    </div></div>
  </>);
}

/* ─── 조직 정책 카드(H-0): 관리자만 편집(RLS msgr_policies_update), 멤버는 열람. 잠금 = 조직 전체 강제(서버 트리거) ─── */
function PolicyCard({ org, isAdmin, policy, onChanged, onNote, onError }) {
  const { t } = useT();
  const [draft, setDraft] = useState(policy); const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(policy); }, [policy]);
  const dirty = ['allow_default', 'allow_locked', 'crew_memory_default', 'crew_memory_locked', 'approval_high_by'].some((k) => draft?.[k] !== policy?.[k]);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const save = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_org_policies').update({ allow_default: draft.allow_default, allow_locked: draft.allow_locked, crew_memory_default: draft.crew_memory_default, crew_memory_locked: draft.crew_memory_locked, approval_high_by: draft.approval_high_by }).eq('org_id', org.id).select('org_id');
    setBusy(false);
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t('set.policy.adminOnly'));
    onNote(t('set.policy.saved')); onChanged();
  };
  const ro = !isAdmin || busy;
  return (
    <section className="msgr-setcard">
      <h2>{t('set.policy')}</h2><p>{t('set.policy.desc')}</p>
      <div className="row">
        <span className="msgr-klabel">{t('set.policy.allow')}</span>
        <div className="msgr-seg" role="radiogroup" aria-label={t('set.policy.allow')}>
          {['all', 'list', 'owner'].map((v) => <button key={v} type="button" role="radio" aria-checked={draft.allow_default === v} className={draft.allow_default === v ? 'active' : ''} disabled={ro} onClick={() => set({ allow_default: v })}>{t(`crew.allow.${v}`)}</button>)}
        </div>
        <label className="switchrow"><input type="checkbox" checked={!!draft.allow_locked} disabled={ro} onChange={(e) => set({ allow_locked: e.target.checked })} /><span>{t('set.policy.lock')}</span></label>
      </div>
      <div className="row">
        <span className="msgr-klabel">{t('set.policy.memory')}</span>
        <label className="switchrow"><input type="checkbox" checked={draft.crew_memory_default !== false} disabled={ro} onChange={(e) => set({ crew_memory_default: e.target.checked })} /><span>{draft.crew_memory_default === false ? t('ch.memory.off') : t('ch.memory.on')}</span></label>
        <label className="switchrow"><input type="checkbox" checked={!!draft.crew_memory_locked} disabled={ro} onChange={(e) => set({ crew_memory_locked: e.target.checked })} /><span>{t('set.policy.lock')}</span></label>
      </div>
      <div className="row">
        <span className="msgr-klabel">{t('set.policy.approval')}</span>
        <div className="msgr-seg" role="radiogroup" aria-label={t('set.policy.approval')}>
          {['admin', 'owner'].map((v) => <button key={v} type="button" role="radio" aria-checked={(draft.approval_high_by ?? 'admin') === v} className={(draft.approval_high_by ?? 'admin') === v ? 'active' : ''} disabled={ro} onClick={() => set({ approval_high_by: v })}>{t(`set.policy.approval.${v}`)}</button>)}
        </div>
        <span className="note">{t('set.policy.approval.desc')}</span>
      </div>
      <p className="note">{t('set.policy.limit')}</p>
      {isAdmin ? <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !dirty} onClick={save}><I name="check" size={13} />{t('ui.save')}</button></div> : <p className="note">{t('set.policy.adminOnly')}</p>}
    </section>
  );
}

/** 빈 상태 — 척추 위 단계 노드가 다음 행동을 가르친다(조직 없음 / 채널 없음). */
function EmptyOrg({ org, onMenu, createOrg, createChannel, invite }) {
  const { t } = useT();
  const steps = org ? [
    ['mark', t('ch.step1'), t('ch.step1.sub'), <button key="a" type="button" className="btn btn-primary sm" onClick={createChannel}><I name="hash" size={13} />{t('ch.new')}</button>],
    ['', t('ch.step2'), t('ch.step2.sub'), invite ? <button key="b" type="button" className="btn sm" onClick={invite}><I name="copy" size={13} />{t('org.invite')}</button> : null],
    ['', t('ch.step3'), t('ch.step3.sub'), null],
  ] : [
    ['mark', t('org.step.create'), t('org.step.create.sub'), <button key="a" type="button" className="btn btn-primary sm" onClick={createOrg}><I name="plus" size={13} />{t('org.new')}</button>],
    ['', t('org.step.invite'), t('org.step.invite.sub'), null],
  ];
  return (<>
    <div className="msgr-top"><button type="button" className="msgr-menu" onClick={onMenu} aria-label={t('ui.menu')}><I name="menu" /></button><span className="title">{org?.name ?? t('app.title')}</span><span className="topic">{org ? t('ch.empty') : t('org.none')}</span></div>
    <div className="msgr-thread" style={{ display: 'flex' }}><div className="msgr-empty">
      <span className="msgr-klabel">{org ? t('ch.list') : t('org.pick')}</span>
      <h1>{org ? t('ch.noChannelTitle') : t('org.noneTitle')}</h1>
      <p>{org ? t('ch.noChannelDesc') : t('org.noneDesc')}</p>
      <div className="msgr-steps">
        {steps.map(([mark, title, sub, act], i) => (
          <div key={i} className="msgr-step"><span className={`num${mark ? ' mark' : ''}`}>{i + 1}</span><div className="card"><div><b>{title}</b><span>{sub}</span></div>{act}</div></div>
        ))}
      </div>
    </div></div>
  </>);
}

/* ─── 채널 본문: 상단(제목·멤버 스택·세그먼트 탭) + 척추 스레드 + 2단 독 ─── */
function Channel({ channel, orgId, uid, isAdmin, policy, members, crews, nameOfUser, crewOf, event, typing, onError, onMenu, onCrew, onTitle, dmName }) {
  const { t, lang } = useT();
  const [msgs, setMsgs] = useState(null); const [aps, setAps] = useState({}); const [atts, setAtts] = useState({});
  const [tab, setTab] = useState('all');
  const feed = useRef(null);
  const [sbw, setSbw] = useState(0); // 스레드 스크롤바 폭의 절반 — 독 좌우를 대화 열과 맞춘다(오버레이 스크롤바면 0)
  useEffect(() => { const el = feed.current; if (!el) return; const m = () => setSbw((el.offsetWidth - el.clientWidth) / 2); m(); window.addEventListener('resize', m); return () => window.removeEventListener('resize', m); }, []);
  const chId = channel.id;
  const load = useCallback(async (afterId = 0) => {
    const rows = await q(supabase.from('msgr_messages').select('id, author_kind, author_user_id, crew_id, kind, body, mentions, reply_to, created_at, deleted_at')
      .eq('channel_id', chId).gt('id', afterId).order('id', { ascending: afterId ? true : false }).limit(PAGE));
    const list = afterId ? rows : rows.reverse();
    setMsgs((cur) => { const base = cur ?? []; const seen = new Set(base.map((m) => m.id)); return afterId ? [...base, ...list.filter((m) => !seen.has(m.id))] : list; });
    const ids = list.map((m) => m.id);
    if (ids.length) {
      const a = await q(supabase.from('msgr_attachments').select('id, message_id, storage_path, name, mime, bytes').in('message_id', ids));
      setAtts((cur) => { const n = { ...cur }; for (const r of a) (n[r.message_id] ??= []).push(r); return n; });
    }
    const apRows = await q(supabase.from('msgr_crew_approvals').select('id, crew_id, approval_id, action, reason, status, decided_by, decided_at, message_id, risk').eq('channel_id', chId));
    setAps(Object.fromEntries(apRows.map((r) => [r.id, r])));
  }, [chId]);
  useEffect(() => { load().catch((e) => onError(e.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastId = msgs?.at(-1)?.id ?? 0;
  useEffect(() => {
    if (!event) return;
    if ((event.kind === 'message' || event.kind === 'approval') && event.channel_id === chId) load(lastId).catch(() => {});
  }, [event]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { feed.current?.scrollTo({ top: feed.current.scrollHeight }); }, [msgs?.length]);
  // 폴링 폴백(10s) — Realtime이 끊기거나 구독이 거부돼도 새 메시지가 화면에 도달한다(정본은 언제나 조회, 방송은 깨우기 신호)
  useEffect(() => { const iv = setInterval(() => load(lastId).catch(() => {}), 10_000); return () => clearInterval(iv); }, [load, lastId]);
  const decide = async (ap, status) => {
    const res = await supabase.from('msgr_crew_approvals').update({ status, decided_by: uid, decided_at: new Date().toISOString() }).eq('id', ap.id).select('id');
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t(ap.risk === 'high' ? 'ap.approverOnly' : 'ap.ownerOnly')); // RLS 0행 = 결재권 없음(최종 판정은 서버 msgr_can_decide)
    load(lastId).catch(() => {});
  };
  const typingCrews = Object.entries(typing).filter(([k, at]) => k.startsWith(`${chId}:`) && Date.now() - at < 6000).map(([k]) => crewOf(k.split(':')[1])).filter(Boolean);
  const apOf = (m) => m.kind === 'approval_card' ? aps[(m.mentions ?? []).find((x) => x.kind === 'approval')?.id] : null;
  const isMention = (m) => (m.mentions ?? []).some((x) => x.kind === 'user' && x.id === uid);
  const all = msgs ?? [];
  // 배지 수와 탭 모수는 같은 술어(검수 M2): 결재 탭 = 대기 중인 결재만
  const isPending = (m) => apOf(m)?.status === 'pending';
  const counts = { mention: all.filter(isMention).length, approval: all.filter(isPending).length, crew: all.filter((m) => m.author_kind === 'crew').length };
  const shown = all.filter((m) => tab === 'all' || (tab === 'mention' && isMention(m)) || (tab === 'approval' && isPending(m)) || (tab === 'crew' && m.author_kind === 'crew'));
  const rows = []; let day = null;
  for (const m of shown) {
    const k = dayKey(m.created_at);
    if (k !== day) { day = k; const [d, w] = fmtDay(m.created_at, lang); const today = k === new Date().toDateString(); rows.push(<div key={`d${k}`} className="msgr-tnode"><span className={`msgr-dot${today ? ' mark' : ''}`} /><span className="msgr-klabel"><b>{d}</b> {w}</span></div>); }
    rows.push(<Message key={m.id} m={m} uid={uid} lang={lang} t={t} nameOfUser={nameOfUser} crewOf={crewOf} isAdmin={isAdmin} policy={policy} ap={apOf(m)} atts={atts[m.id] ?? []} decide={decide} parent={m.reply_to ? all.find((x) => x.id === m.reply_to) : null} onCrew={onCrew} />);
  }
  const tabs = [['all', null, 0], ['mention', 'at', counts.mention], ['approval', 'stamp', counts.approval], ['crew', 'star', counts.crew]];
  return (<>
    <div className="msgr-top">
      <button type="button" className="msgr-menu" onClick={onMenu} aria-label={t('ui.menu')}><I name="menu" /></button>
      <button type="button" className="title msgr-titlebtn" onClick={onTitle} title={t('ch.sheet')}><I name={channel.kind === 'private' ? 'lock' : channel.kind === 'dm' ? 'at' : 'hash'} size={18} />{channel.kind === 'dm' ? dmName(channel) : channel.name}<I name="caret" size={13} className="caret" /></button>
      {channel.topic && <span className="topic">{channel.topic}</span>}
      {channel.crew_memory === false && <span className="msgr-klabel" title={t('ch.crewMemory')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><I name="memoff" size={13} />{t('ch.memoryOff')}</span>}
      <div className="members" title={t('ui.members')}>{members.slice(0, 4).map((m) => <Av key={m.user_id} name={m.display_name || m.user_id} size="sm" />)}{crews.slice(0, 2).map((c) => <Av key={c.id} name={c.display_name} crew size="sm" />)}</div>
      <div className="msgr-seg" role="tablist">{tabs.map(([k, ic, n]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{ic && <I name={ic} size={13} />}{t(`tab.${k}`)}{n > 0 && <span className="n">{n}</span>}</button>)}</div>
    </div>
    <div className="msgr-thread" ref={feed}>
      <div className="msgr-spine">
        {msgs === null && <div className="msgr-row ghost"><span className="msgr-av" /><div className="msgr-skel"><i /><i /><i /></div></div>}
        {msgs !== null && !all.length && <div className="msgr-row ghost"><span className="msgr-av" /><div className="msgr-sys">{t('ch.empty')}</div></div>}
        {rows}
        {typingCrews.map((c) => <div key={`typing-${c.id}`} className="msgr-row"><Av name={c.display_name} crew /><div><div className="who">{c.display_name}<span className="role">{c.role_text}</span></div><div className="msgr-typing"><i /><i /><i /></div></div></div>)}
      </div>
    </div>
    <Composer chId={chId} orgId={orgId} uid={uid} members={members} crews={crews} channel={channel} sbw={sbw} typingCrews={typingCrews} onSent={() => load(lastId).catch(() => {})} onError={onError} />
  </>);
}

function Message({ m, uid, lang, t, nameOfUser, crewOf, isAdmin, policy, ap, atts, decide, parent, onCrew }) {
  const [copied, setCopied] = useState(false);
  const crew = m.crew_id ? crewOf(m.crew_id) : null;
  const name = m.author_kind === 'user' ? nameOfUser(m.author_user_id) : (crew?.display_name ?? t('org.crews'));
  const body = m.deleted_at ? '' : m.body;
  const copy = () => { navigator.clipboard?.writeText(body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  const mine = m.author_kind === 'user' && m.author_user_id === uid;
  const quote = parent && <div className="msgr-quote"><I name="reply" size={13} />{parent.author_kind === 'user' ? nameOfUser(parent.author_user_id) : crewOf(parent.crew_id)?.display_name}: {parent.body}</div>;
  const attRow = atts.length > 0 && <div>{atts.map((a) => <Attachment key={a.id} a={a} />)}</div>;
  const acts = !ap && !m.deleted_at && <div className="msgr-acts"><button type="button" onClick={copy}><I name="copy" size={12} />{copied ? t('ui.copied') : t('ui.copy')}</button></div>;
  if (mine) return ( // 내 글 — 척추 반대편 차콜 버블(20/6/20/20)
    <div className="msgr-mine">
      <div className="bubble">{quote}{m.deleted_at ? <i>{t('msg.deleted')}</i> : <Body text={body} />}</div>
      {attRow}
      <div className="meta"><I name="check" size={12} /><span className="mono">{fmtTs(m.created_at, lang)}</span></div>
      {acts}
    </div>
  );
  const isCrew = m.author_kind === 'crew';
  return ( // 동료·크루 글 — 척추 위 아바타(사람 원 / 크루 타일), 크루 답은 척추에 붙는 시트
    <div className="msgr-row">
      {isCrew && crew ? <button type="button" className="msgr-avbtn" onClick={() => onCrew?.(crew.id)} title={t('crew.sheet')}><Av name={name} crew /></button> : <Av name={name} crew={isCrew} />}
      <div style={{ minWidth: 0 }}>
        <div className="who">{isCrew && crew ? <button type="button" className="msgr-namebtn" onClick={() => onCrew?.(crew.id)}>{name}</button> : name}{crew?.role_text && <span className="role">{crew.role_text} · {t('org.crews')}</span>}<span className="ts">{fmtTs(m.created_at, lang)}</span></div>
        {m.deleted_at ? <div className="msgr-sys">{t('msg.deleted')}</div>
          : ap ? <Slip ap={ap} uid={uid} lang={lang} t={t} crew={crew} nameOfUser={nameOfUser} decide={decide} isAdmin={isAdmin} policy={policy} />
          : m.kind === 'system' ? <div className="msgr-sys">{body}</div>
          : isCrew ? <div className="msgr-sheet">{quote}<Markdown text={body} /></div>
          : <div className="text">{quote}<Body text={body} /></div>}
        {attRow}
        {acts}
      </div>
    </div>
  );
}

/** 결재 슬립 — 머리띠(요청=옐로 / 확정=차콜 / 만료=회색) + 본문 + 도장 실. 보는 사람이 소유자면 버튼, 아니면 대기 표시. */
function Slip({ ap, uid, lang, t, crew, nameOfUser, decide, isAdmin, policy }) {
  // 결재권 판정은 화면용 — 최종은 RLS(msgr_can_decide, decide의 0행 처리). 크루가 목록에 없으면(비활성 등) 소유자 미상으로 보고 버튼을 띄운다(검수 M1).
  const owner = crew ? crew.owner_user_id === uid : true;
  const high = ap.risk === 'high';
  const byAdmin = high && (policy?.approval_high_by ?? 'admin') !== 'owner'; // H-1: 고위험은 정책의 결재권자(기본 관리자)
  const can = byAdmin ? !!isAdmin : owner;
  const ownerName = nameOfUser(crew?.owner_user_id);
  const cls = `msgr-slip ${ap.status}${ap.status === 'pending' && !can ? ' wait' : ''}${high ? ' high' : ''}`;
  const band = ap.status === 'pending' ? (can ? t('ap.request') : (byAdmin ? t('ap.wait.admin') : t('ap.wait', { name: ownerName }))) : t(`ap.${ap.status}.band`);
  const bandIcon = ap.status === 'expired' ? 'clock' : 'stamp';
  const when = ap.decided_at ? fmtTs(ap.decided_at, lang) : '';
  return (
    <div className={cls}>
      <div className="band"><I name={bandIcon} size={14} />{band}{high && <span className="msgr-klabel risk">{t('ap.high')}</span>}<span className="id">{ap.approval_id}</span></div>
      <div className="body">
        <div className="action">{ap.action}</div>
        {ap.reason && <div className="reason">{ap.reason}</div>}
        <div className="row2">
          {ap.status === 'pending' && can && (<>
            <button type="button" className="btn btn-primary sm" onClick={() => decide(ap, 'approved')}><I name="check" size={13} />{t('ap.approve')}</button>
            <button type="button" className="btn sm" onClick={() => decide(ap, 'rejected')}><I name="x" size={13} />{t('ap.reject')}</button>
          </>)}
          {ap.status === 'pending' && !can && <span className="note">{byAdmin ? t('ap.adminNote') : t('ap.ownerNote')}</span>}
          {ap.status === 'approved' && <span className="msgr-seal ok"><I name="check" />{nameOfUser(ap.decided_by)} · {when}</span>}
          {ap.status === 'rejected' && <span className="msgr-seal no"><I name="x" />{nameOfUser(ap.decided_by)} · {when}</span>}
          {ap.status === 'expired' && <span className="msgr-seal"><I name="clock" />{t('ap.noDecision')}</span>}
        </div>
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
  return <button type="button" className="msgr-file" onClick={open}><I name="doc" size={13} />{a.name}{a.bytes ? <span>{Math.round(a.bytes / 1024)}KB</span> : null}</button>;
}

/* ─── 2단 다크 독: 입력 줄 + 도구 줄(첨부·멘션 │ 기억 상태) + 옐로 원형 전송. @멘션 팝업(사람·크루), Enter 전송(IME 조합 제외) ─── */
function Composer({ chId, orgId, uid, members, crews, channel, sbw = 0, typingCrews, onSent, onError }) {
  const { t } = useT();
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [files, setFiles] = useState([]);
  const [pop, setPop] = useState(null); const [sel, setSel] = useState(0);
  const [uploading, setUploading] = useState(''); // 올리는 중인 파일 이름
  const [mentions, setMentions] = useState([]);
  const ta = useRef(null); const fileRef = useRef(null);
  const candidates = useMemo(() => {
    if (!pop) return [];
    const needle = pop.q.toLowerCase();
    const list = [...crews.map((c) => ({ kind: 'crew', id: c.id, name: c.display_name, sub: c.role_text })), ...members.map((m) => ({ kind: 'user', id: m.user_id, name: m.display_name || m.user_id.slice(0, 8), sub: m.role }))];
    return list.filter((x) => !needle || x.name.toLowerCase().includes(needle)).slice(0, 8);
  }, [pop, crews, members]);
  const autosize = (el) => { if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 200)}px`; };
  const detect = (v, caret) => { const upto = v.slice(0, caret); const m = upto.match(/(?:^|\s)@([^\s@]*)$/); setPop(m ? { q: m[1], start: upto.length - m[1].length - 1 } : null); setSel(0); };
  const onChange = (e) => { const v = e.target.value; setText(v); autosize(e.target); detect(v, e.target.selectionStart); };
  const insertAt = () => { // 도구 줄 '멘션' — 커서 자리에 @를 넣고 팝업을 연다
    const el = ta.current; const pos = el?.selectionStart ?? text.length;
    const before = text.slice(0, pos); const sp = before && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${sp}@${text.slice(pos)}`; setText(next);
    requestAnimationFrame(() => { el?.focus(); const p = before.length + sp.length + 1; el?.setSelectionRange(p, p); autosize(el); detect(next, p); });
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
      // 멘션 = 팝업에서 고른 것 + 본문의 @이름을 크루·멤버 이름과 대조한 것(직접 타이핑한 @준도 멘션으로 — 실검수 2026-09-03: 팝업 없이 쓰면 mentions가 비어 크루가 응답하지 않았다)
      const byName = [...crews.map((c) => ({ kind: 'crew', id: c.id, name: c.display_name })), ...members.map((m) => ({ kind: 'user', id: m.user_id, name: m.display_name || m.user_id.slice(0, 8) }))];
      const seen = new Set(); const ment = [];
      for (const x of [...mentions, ...byName]) { if (!x.name || seen.has(`${x.kind}:${x.id}`)) continue; if (new RegExp(`(?:^|\\s)@${x.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s,.!?:;])`).test(body)) { seen.add(`${x.kind}:${x.id}`); ment.push({ kind: x.kind, id: x.id }); } }
      const row = await q(supabase.from('msgr_messages').insert({ channel_id: chId, author_kind: 'user', author_user_id: uid, body, mentions: ment, client_msg_id: crypto.randomUUID() }).select('id').single());
      for (const f of files) {
        setUploading(f.name);
        const path = `${orgId}/${chId}/${row.id}/${f.name.replace(/[\\/]/g, '_')}`;
        const up = await supabase.storage.from('msgr').upload(path, f, { contentType: f.type || 'application/octet-stream' });
        if (up.error) { onError(`${t('msg.attachFail')}: ${f.name} — ${up.error.message}`); continue; }
        await q(supabase.from('msgr_attachments').insert({ message_id: row.id, org_id: orgId, storage_path: path, name: f.name, mime: f.type, bytes: f.size }));
      }
      setText(''); setMentions([]); setFiles([]); if (ta.current) ta.current.style.height = 'auto'; onSent();
    } catch (e) { onError(e.message); } finally { setBusy(false); setUploading(''); }
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
    <div className="msgr-dock" style={{ '--sbw': `${sbw}px` }}><div>
      {pop && candidates.length > 0 && (
        <div className="msgr-pop" role="listbox">
          {candidates.map((c, i) => <button key={`${c.kind}:${c.id}`} type="button" role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(c); }}>
            <Av name={c.name} crew={c.kind === 'crew'} size="sm" /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span><span className="msgr-klabel tag">{c.kind === 'crew' ? t('org.crews') : t(`role.${c.sub}`)}</span>
          </button>)}
        </div>
      )}
      <form className="msgr-composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input hidden multiple type="file" ref={fileRef} onChange={(e) => { const all = [...e.target.files]; const big = all.filter((f) => f.size > ATTACH_MAX); if (big.length) onError(big.map((f) => t('att.tooBig', { name: f.name })).join(' ')); setFiles(all.filter((f) => f.size <= ATTACH_MAX)); e.target.value = ''; }} />
        <textarea ref={ta} rows={1} value={text} onChange={onChange} {...imeGuardWith(onKey)} placeholder={t('msg.placeholder2')} />
        <div className="msgr-tools">
          <button type="button" className="tb" onClick={() => fileRef.current?.click()} disabled={busy} title={t('msg.attach')}><I name="clip" size={15} /><span>{t('msg.attach')}</span></button>
          <button type="button" className="tb" onClick={insertAt} disabled={busy} title={t('msg.mention')}><I name="at" size={15} /><span>{t('msg.mention')}</span></button>
          {(files.length > 0 || channel.crew_memory === false) && <span className="sep" />}
          {files.map((f) => <span key={f.name} className={`filechip${uploading === f.name ? ' busy' : ''}`}><I name="doc" size={12} />{f.name}<span className="msgr-klabel">{uploading === f.name ? t('att.uploading') : `${Math.max(1, Math.round(f.size / 1024))}KB`}</span></span>)}
          {channel.crew_memory === false && <span className="tb on" title={t('ch.crewMemory')}><I name="memoff" size={15} /><span>{t('ch.memoryOff')}</span></span>}
          <button className="send" disabled={busy || !text.trim()} aria-label={t('msg.send')} title={t('msg.send')}><I name="up" size={16} /></button>
        </div>
      </form>
      <div className="msgr-sub">
        <span className="typing-line">{typingCrews.length > 0 && <><span className="msgr-dot mark" />{t('msg.typing', { name: typingCrews.map((c) => c.display_name).join(', ') })}</>}</span>
      </div>
    </div></div>
  );
}
