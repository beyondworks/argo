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
const ATTACH_MAX = 25 * 1024 * 1024; // 브리지 ATTACH_MAX(src/gateway/msgr.mjs)와 같은 값 — 받는 쪽에서만 거절하면 보낸 사람은 이유를 모른다
const fmtTs = (iso, lang) => new Date(iso).toLocaleTimeString(lang === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' });
const dayKey = (iso) => new Date(iso).toDateString();
/** 오늘이면 시각만, 아니면 날짜+시각 — 초대 만료(7일 뒤)·노드 마지막 응답·기록처럼 며칠 전후일 수 있는 시각용(시간만 보이면 "오늘 02:31"로 읽힌다 — I-4 실측) */
const fmtWhen = (iso, lang) => { const d = new Date(iso); const time = fmtTs(iso, lang); if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(lang === 'en' ? 'en-US' : 'ko-KR', { month: 'short', day: 'numeric' })} ${time}`; };
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
          <span className="msgr-klabel devsep">{t('auth.devOnly')}</span>
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
  const [ent, setEnt] = useState(null); const [policy, setPolicy] = useState(null);
  const orgLocked = ent?.ls_status === 'past_due' || ent?.ls_status === 'unpaid'; // J-2: 결제 문제 = 읽기 전용(서버 msgr_org_locked가 최종) // msgr_org_entitlements(plan·seats) — 좌석 표시·한도 안내
  const [dmMembers, setDmMembers] = useState({}); // dm 채널 id → 멤버 행(레일 라벨용: 나 아닌 참가자)
  const [err, setErr] = useState(''); const [note, setNote] = useState('');
  const [tick, setTick] = useState(0);
  const [rail, setRail] = useState(false); // 폰 폭: 메뉴 버튼으로 레일 열기
  const [page, setPage] = useState('chat'); // 'chat' | 'settings' | 'docs' — 언어·테마·계정은 설정 페이지(유건 실검수 2026-09-03), 문서 = 조직 문서(G-1)
  const [orgMenu, setOrgMenu] = useState(false);
  const [sheet, setSheet] = useState(null); // 크루 시트(크루 id) — 허용 범위·소유자·접속
  const [chSheet, setChSheet] = useState(false); // 채널 시트 — 이름·주제·기억·멤버·보관
  const rt = useRef(null);
  const loadOrgs = useCallback(async () => {
    const rows = await q(supabase.from('msgr_org_members').select('org_id, role, msgr_orgs(id, name, slug, owner_user_id, service_user_id, node_seen_at, pending_owner_user_id, successor_user_id, auto_join_domain, auto_join_role)').eq('user_id', uid).is('removed_at', null));
    const list = rows.filter((r) => r.msgr_orgs).map((r) => ({ id: r.org_id, role: r.role, ...r.msgr_orgs }));
    setOrgs(list);
    setOrgId((cur) => cur && list.some((o) => o.id === cur) ? cur : (list[0]?.id ?? null));
    setJoinable(await q(supabase.rpc('msgr_joinable_orgs')).catch(() => [])); // J-3: 내 이메일 도메인으로 들어갈 수 있는 조직(서버가 판정)
  }, [uid]);
  const joinDomain = async (o) => {
    try { await q(supabase.rpc('msgr_join_by_domain', { org: o.id })); setNote(t('org.joined')); await loadOrgs(); setOrgId(o.id); }
    catch (e) { setErr(/msgr_seat_limit/.test(e.message) ? t('seat.limit') : e.message); }
  };
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
      q(supabase.from('msgr_channels').select('id, kind, name, topic, crew_memory, personal_crews, created_by, admin_user_ids').eq('org_id', id).is('archived_at', null).order('created_at')),
      q(supabase.from('msgr_org_members').select('user_id, role, display_name, expires_at').eq('org_id', id).is('removed_at', null)),
      q(supabase.from('msgr_crews').select('id, owner_user_id, slug, display_name, role_text, hosting, status, allow, allow_users, last_seen_at').eq('org_id', id).eq('status', 'active')),
      supabase.from('msgr_org_entitlements').select('plan, seats, ls_status').eq('org_id', id).maybeSingle().then((r) => r.data ?? null),
      supabase.from('msgr_org_policies').select('allow_default, allow_locked, crew_memory_default, crew_memory_locked, approval_high_by, approver_user_ids, crew_create, crew_runner, crew_model, guest_seats').eq('org_id', id).maybeSingle().then((r) => r.data ?? null), // H-0 조직 정책(없으면 null = 잠금 없음)
    ]);
    const orgRow = orgs.find((o) => o.id === id);
    crs.sort((a, b) => (crewTier(b, orgRow) === 'company') - (crewTier(a, orgRow) === 'company') || a.display_name.localeCompare(b.display_name, 'ko')); // 순서 고정: 회사 크루 먼저, 이름순(QA: 화면마다 순서가 달랐다)
    setChannels(chs); setMembers(mems); setCrews(crs); setEnt(e); setPolicy(pol);
    setChId((cur) => cur && chs.some((c) => c.id === cur) ? cur : (chs[0]?.id ?? null)); // 라벨용 보조 조회보다 먼저(검수 2R LOW-1: 보조 조회가 던지면 채널 선택이 안 됐다)
    const dmIds = chs.filter((c) => c.kind === 'dm').map((c) => c.id);
    if (dmIds.length) { try { const rows = await q(supabase.from('msgr_channel_members').select('channel_id, member_kind, member_id').in('channel_id', dmIds)); const map = {}; for (const r of rows) (map[r.channel_id] ??= []).push(r); setDmMembers(map); } catch { setDmMembers({}); } } else setDmMembers({});
  }, [orgs]);
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
        .on('broadcast', { event: 'message' }, ({ payload }) => { setEvent({ kind: 'message', ...payload, at: Date.now() }); notifyMention(payload); })
        .on('broadcast', { event: 'approval' }, ({ payload }) => { setEvent({ kind: 'approval', ...payload, at: Date.now() }); notifyApproval(payload); })
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
  // F2-5 로컬 알림 — 앱이 숨겨졌거나 다른 채널을 보고 있을 때만. 본문은 싣지 않는다(방송 payload에도 본문이 없다 — RLS 통과 조회가 정본).
  const notifyRef = useRef({ channels, members, chId, uid, isAdmin, page });
  notifyRef.current = { channels, members, chId, uid, isAdmin, page };
  const osNotify = (title, body, tag) => { try { if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return; const n = new Notification(title, { body, tag }); n.onclick = () => { window.focus(); n.close(); }; } catch { /* 알림 불가 환경 */ } };
  const shouldNotify = (channelId) => { const r = notifyRef.current; return document.visibilityState === 'hidden' || r.page !== 'chat' || r.chId !== channelId; };
  const notifyMention = (payload) => {
    const r = notifyRef.current;
    if (!payload || payload.author_user_id === r.uid) return;
    const mentioned = Array.isArray(payload.mentions) && payload.mentions.some((m) => m?.kind === 'user' && m.id === r.uid);
    if (!mentioned || !shouldNotify(payload.channel_id)) return;
    const ch = r.channels.find((c) => c.id === payload.channel_id); const who = r.members.find((m) => m.user_id === payload.author_user_id);
    osNotify(t('notify.mention', { name: who?.display_name || '?', channel: ch?.name ?? '' }), '', `m:${payload.id}`);
  };
  const notifyApproval = (payload) => {
    const r = notifyRef.current;
    if (!payload || payload.status !== 'pending' || !r.isAdmin || !shouldNotify(payload.channel_id)) return; // 확정권 정본은 서버 — 관리자에게만 알린다(저위험은 소유자가 카드에서 본다)
    const ch = r.channels.find((c) => c.id === payload.channel_id);
    osNotify(t('notify.approval', { channel: ch?.name ?? '' }), '', `a:${payload.id}`);
  };
  const nameOfUser = (id) => members.find((m) => m.user_id === id)?.display_name || id?.slice(0, 8) || '?';
  const crewOf = (id) => crews.find((c) => c.id === id);
  const [newOrg, setNewOrg] = useState(null); // 인라인 폼 상태(문자열) — 네이티브 prompt 금지(QA: 사용성·룩 불일치)
  const [joinable, setJoinable] = useState([]); // J-3 도메인 자동 가입 후보
  const [newCh, setNewCh] = useState(null);   // { name, kind }
  const createOrg = async (name) => {
    if (!name?.trim()) return;
    const slug = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'org'}-${Date.now().toString(36).slice(-4)}`;
    try { const o = await q(supabase.from('msgr_orgs').insert({ name: name.trim(), slug, owner_user_id: uid }).select('id').single()); setNewOrg(null); setOrgMenu(false); await loadOrgs(); setOrgId(o.id); } catch (e) { setErr(e.message); }
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
  const createChannel = async ({ name, kind } = newCh ?? {}) => {
    if (!name?.trim()) return;
    const priv = kind === 'private';
    try {
      const c = await q(supabase.from('msgr_channels').insert({ org_id: orgId, kind: priv ? 'private' : 'public', name: name.trim(), created_by: uid }).select('id').single());
      if (priv) await q(supabase.from('msgr_channel_members').insert({ channel_id: c.id, member_kind: 'user', member_id: uid, added_by: uid }));
      setNewCh(null); await loadOrg(orgId); setChId(c.id); setPage('chat');
    } catch (e) { setErr(/msgr_channel_limit/.test(e.message) ? t('ch.freeLimit') : e.message); }
  };
  const openNewCh = () => { setNewCh({ name: '', kind: 'public' }); setRail(true); };
  if (orgs === null) return <div className="msgr-auth"><span className="msgr-klabel">{t('ui.loading')}</span></div>;
  const channel = channels.find((c) => c.id === chId);
  // 채널 중심 구조(유건 지시 2026-09-04): 레일은 채널·1:1만, 크루·멤버는 "이 채널의 구성"으로 본다. 공개 채널 = 조직 멤버 전원 + 이 채널에서 일할 수 있는 크루(채널 정책), 비공개·DM = 채널 멤버.
  const usableCrews = channel?.personal_crews && channel.personal_crews !== 'allowed' ? crews.filter((c) => crewTier(c, org) === 'company') : crews;
  const chPeople = !channel ? [] : channel.kind === 'public' ? members : members.filter((m) => chMembers.some((x) => x.member_kind === 'user' && x.member_id === m.user_id));
  const chCrews = !channel ? [] : channel.kind === 'public' ? usableCrews : crews.filter((c) => chMembers.some((x) => x.member_kind === 'crew' && x.member_id === c.id));
  // 채널 칩 — 정렬: 현재 → 이름순. 6개 초과는 '+N'(펼치기)
  // DM 라벨 = 나 아닌 참가자(검수 MEDIUM-2: 저장된 이름은 생성자 시점). 크루 DM에 다른 사람도 있으면(소유자 동반) '서윤 · 민수'처럼 병기
  const dmName = (c) => { const ms = dmMembers[c.id] ?? []; const crew = ms.find((m) => m.member_kind === 'crew'); const other = ms.find((m) => m.member_kind === 'user' && m.member_id !== uid); if (crew) return [crewOf(crew.member_id)?.display_name ?? c.name.replace(/^dm:/, ''), other ? nameOfUser(other.member_id) : null].filter(Boolean).join(' · '); return other ? nameOfUser(other.member_id) : c.name.replace(/^dm:/, ''); };
  const dms = channels.filter((c) => c.kind === 'dm');
  const sortedCh = [...channels].filter((c) => c.kind !== 'dm').sort((a, b) => (a.kind === 'private') - (b.kind === 'private') || a.name.localeCompare(b.name)); // 공개 먼저·이름순 고정(선택한 채널을 위로 끌어올리면 목록이 뛴다)
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
              {joinable.map((o) => <button key={`j-${o.id}`} type="button" role="menuitem" className="join" onClick={() => { setOrgMenu(false); joinDomain(o); }}><Av name={o.name} size="sm" /><span className="label">{o.name}</span><span className="msgr-klabel">{t('org.join.cta')}</span></button>)}
              {ent && <div className="seatline"><span className="msgr-klabel">{t('seat.status', { used: members.length, seats: ent.seats, plan: t(`plan.${ent.plan}`) })}</span></div>}
              <div className="sep" />
              {isAdmin && <button type="button" role="menuitem" onClick={() => { setOrgMenu(false); invite(); }}><span className="msgr-av sm ghost"><I name="copy" size={13} /></span><span className="label">{t('org.invite')}</span></button>}
              {newOrg === null
                ? <button type="button" role="menuitem" onClick={() => setNewOrg('')}><span className="msgr-av sm ghost"><I name="plus" size={13} /></span><span className="label">{t('org.new')}</span></button>
                : <form className="msgr-inline" onSubmit={(e) => { e.preventDefault(); createOrg(newOrg); }}>
                    <input className="msgr-input" placeholder={t('org.name')} value={newOrg} onChange={(e) => setNewOrg(e.target.value)} autoFocus maxLength={80} />
                    <div className="acts"><button type="submit" className="btn btn-primary sm" disabled={!newOrg.trim()}><I name="check" size={13} />{t('ui.create')}</button><button type="button" className="btn sm" onClick={() => setNewOrg(null)}>{t('ui.cancel')}</button></div>
                  </form>}
            </div>
          </>)}
        </div>
        <div className="msgr-railbody">
        <div className="msgr-group">{t('ch.list')}<button type="button" className="btn" onClick={() => newCh ? setNewCh(null) : openNewCh()} disabled={!orgId} title={t('ch.new')} aria-label={t('ch.new')} aria-expanded={!!newCh}><I name={newCh ? 'x' : 'plus'} size={14} /></button></div>
        {newCh && (
          <form className="msgr-inline" onSubmit={(e) => { e.preventDefault(); createChannel(); }}>
            <input className="msgr-input" placeholder={t('ch.name')} value={newCh.name} onChange={(e) => setNewCh((c) => ({ ...c, name: e.target.value }))} autoFocus maxLength={80} />
            <div className="msgr-seg" role="radiogroup" aria-label={t('ch.new.kind')}>
              {[['public', t('ch.new.public')], ['private', t('ch.new.private')]].map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={newCh.kind === v} className={newCh.kind === v ? 'active' : ''} onClick={() => setNewCh((c) => ({ ...c, kind: v }))}><I name={v === 'private' ? 'lock' : 'hash'} size={12} />{l}</button>)}
            </div>
            <div className="acts"><button type="submit" className="btn btn-primary sm" disabled={!newCh.name.trim()}><I name="check" size={13} />{t('ui.create')}</button><button type="button" className="btn sm" onClick={() => setNewCh(null)}>{t('ui.cancel')}</button></div>
          </form>
        )}
        {channels.length ? (
          <div className="msgr-list">
            {sortedCh.map((c) => (
              <button key={c.id} type="button" className={`item${c.id === chId ? ' active' : ''}`} onClick={() => { setChId(c.id); setRail(false); setPage('chat'); }}>
                <I name={c.kind === 'private' ? 'lock' : 'hash'} size={14} /><span className="name">{c.name}</span>
              </button>
            ))}
          </div>
        ) : <div className="msgr-hint">{orgId ? t('ch.empty') : t('org.none')}</div>}
        {dms.length > 0 && (<>
          <div className="msgr-group">{t('ch.dms')}</div>
          <div className="msgr-list">{dms.map((c) => <button key={c.id} type="button" className={`item${c.id === chId ? ' active' : ''}`} onClick={() => { setChId(c.id); setRail(false); setPage('chat'); }}><I name="at" size={14} /><span className="name">{dmName(c)}</span></button>)}</div>
        </>)}
        <div className="msgr-railhint">{t('rail.hint')}</div>
        </div>
        <div className="msgr-foot">
          <Av name={me?.display_name || session.user.email} size="sm" />
          <span className="name">{me?.display_name || session.user.email}</span>
          <button type="button" className={`btn ghost${page === 'docs' ? ' on' : ''}`} onClick={() => { setPage((p) => p === 'docs' ? 'chat' : 'docs'); setRail(false); }} title={t('docs.title')} aria-label={t('docs.title')} aria-pressed={page === 'docs'} disabled={!org}><I name="doc" size={15} /></button>
          <button type="button" className={`btn ghost${page === 'settings' ? ' on' : ''}`} onClick={() => { setPage((p) => p === 'settings' ? 'chat' : 'settings'); setRail(false); }} title={t('ui.settings')} aria-label={t('ui.settings')} aria-pressed={page === 'settings'}><I name="gear" size={15} /></button>
          <button type="button" className="btn ghost" onClick={() => supabase.auth.signOut({ scope: 'local' })} title={t('auth.signOut')} aria-label={t('auth.signOut')}><I name="out" size={15} /></button>
        </div>
      </aside>
      <main className="msgr-main">
        {sheet && crewOf(sheet) && <CrewSheet crew={crewOf(sheet)} org={org} uid={uid} me={me} members={members} policy={policy} channelId={chId} nameOfUser={nameOfUser} onClose={() => setSheet(null)} onChanged={() => loadOrg(orgId).catch(() => {})} onPosted={() => setEvent({ kind: 'message', channel_id: chId, at: Date.now() })} onNote={setNote} onError={setErr} onDm={() => openDm('crew', sheet)} />}
        {chSheet && channel && <ChannelSheet channel={channel} org={org} uid={uid} isAdmin={isAdmin} policy={policy} members={members} crews={crews} chMembers={chMembers} people={chPeople} chCrews={chCrews} ent={ent} onInvite={isAdmin ? invite : null} onCrew={(id) => { setChSheet(false); setSheet(id); }} onDm={(id) => openDm('user', id)} nameOfUser={nameOfUser} onClose={() => setChSheet(false)} onChanged={async () => { await loadOrg(orgId).catch(() => {}); await loadChMembers(chId).catch(() => {}); }} onArchived={() => { setChSheet(false); setChId(null); loadOrg(orgId).catch(() => {}); }} onNote={setNote} onError={setErr} />}
        {orgLocked && <div className="msgr-notice locked"><span>{t(isAdmin ? 'org.locked.admin' : 'org.locked')}</span></div>}
        {(err || note) && (
          <div className="msgr-notice">
            <span style={{ color: err ? 'var(--danger)' : 'var(--fg-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{err ? `${t('ui.error')}: ${err}` : note}</span>
            <button type="button" className="btn sm" style={{ border: 0, width: 24, height: 24, padding: 0 }} onClick={() => { setErr(''); setNote(''); }} aria-label="×"><I name="x" size={12} /></button>
          </div>
        )}
        {page === 'docs' && org ? (
          <Docs org={org} isAdmin={!!isAdmin} channels={channels} chId={chId} uid={uid} nameOfUser={nameOfUser} onNote={setNote} onError={setErr} onBack={() => setPage('chat')} onMenu={() => setRail(true)} />
        ) : page === 'settings' ? (
          <Settings session={session} me={me} uid={uid} org={org} isAdmin={!!isAdmin} policy={policy} members={members} nameOfUser={nameOfUser} onChanged={() => loadOrg(orgId).catch((e) => setErr(e.message))} onOrgsChanged={() => loadOrgs().catch((e) => setErr(e.message))} onNote={setNote} onError={setErr} onBack={() => setPage('chat')} onMenu={() => setRail(true)} />
        ) : chId ? (
          <Channel key={chId} channel={channel} orgId={orgId} org={org} uid={uid} isAdmin={!!isAdmin} locked={orgLocked} policy={policy} members={members} crews={crews} people={chPeople} chCrews={chCrews} nameOfUser={nameOfUser} crewOf={crewOf} event={event} typing={typing} onError={setErr} onMenu={() => setRail(true)} onCrew={setSheet} onTitle={() => setChSheet(true)} dmName={dmName} />
        ) : (
          <EmptyOrg org={org} onMenu={() => setRail(true)} createOrg={() => { setOrgMenu(true); setNewOrg(''); }} createChannel={openNewCh} invite={isAdmin ? invite : null} joinable={joinable} joinDomain={joinDomain} />
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
function ChannelSheet({ channel, org, uid, isAdmin, policy, members, crews, chMembers, people = [], chCrews = [], ent, onInvite, onCrew, onDm, nameOfUser, onClose, onChanged, onArchived, onNote, onError }) {
  const { t } = useT();
  const chAdmins = channel.admin_user_ids ?? [];
  const canEdit = isAdmin || channel.created_by === uid || chAdmins.includes(uid); // J-1: 채널 관리자도 설정·멤버 관리(최종은 RLS msgr_can_manage_channel)
  const canAssignAdmins = (isAdmin || channel.created_by === uid) && channel.kind !== 'dm'; // 지정은 조직 관리자·생성자만(자기 증식 방지 — 서버 트리거와 동일)
  const toggleChAdmin = async (userId) => { const next = chAdmins.includes(userId) ? chAdmins.filter((x) => x !== userId) : [...chAdmins, userId]; await upd({ admin_user_ids: next }, t('ch.admin.saved')); };
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
    if (res.error) return onError(/msgr_channel_personal_blocked/.test(res.error.message) ? t('err.channelPersonalBlocked') : res.error.message); // I-3: 서버 게이트의 거절을 정직한 문구로
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
  const [confirmArchive, setConfirmArchive] = useState(false); // 네이티브 confirm 대신 2단계 버튼(QA)
  const archive = async () => { await upd({ archived_at: new Date().toISOString() }); onArchived(); };
  const userIds = new Set(chMembers.filter((m) => m.member_kind === 'user').map((m) => m.member_id));
  const crewIds = new Set(chMembers.filter((m) => m.member_kind === 'crew').map((m) => m.member_id));
  const addableUsers = members.filter((m) => !userIds.has(m.user_id));
  const addableCrews = crews.filter((c) => !crewIds.has(c.id) && ((channel.personal_crews ?? 'allowed') !== 'blocked' || crewTier(c, org) === 'company')); // I-3: 차단 채널엔 회사 크루만 후보(안 될 버튼 노출 금지 — 최종은 서버 게이트)
  const scoped = channel.kind !== 'public';
  const nodeOn = !!org?.service_user_id; // I-5: 회사 노드가 있어야 회사 크루를 만들 수 있다(서버 RLS도 거절)
  const crewCreate = policy?.crew_create ?? 'channel_admin';
  const canCreateCrew = channel.kind !== 'dm' && nodeOn && (isAdmin || crewCreate === 'member' || (crewCreate === 'channel_admin' && canEdit)); // 권한 행렬 — 최종은 RLS msgr_can_create_crew
  const [newCrew, setNewCrew] = useState(null); const [requests, setRequests] = useState([]); const doneSeen = useRef(null);
  const [guestDays, setGuestDays] = useState(30); // J-4: 비공개 채널 게스트 링크(채널 관리자도 발급 — 최종은 RLS)
  const guestInvite = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_invites').insert({ org_id: org.id, role: 'guest', channel_id: channel.id, guest_days: guestDays, created_by: uid }).select('code').single();
    setBusy(false);
    if (res.error) return onError(res.error.message);
    const link = `${location.origin}${location.pathname}?invite=${res.data.code}`;
    await navigator.clipboard?.writeText(link).catch(() => {});
    onNote(`${t('ch.guest.made', { days: guestDays })} ${link}`);
  };
  const loadRequests = useCallback(async () => {
    const rows = await q(supabase.from('msgr_crew_requests').select('id, name, status, error, crew_id, created_at, done_at').eq('org_id', org.id).eq('channel_id', channel.id).order('created_at', { ascending: false }).limit(10));
    setRequests(rows);
    const done = rows.filter((r) => r.status === 'done').map((r) => r.id).join(',');
    if (doneSeen.current !== null && doneSeen.current !== done) onChanged(); // 노드가 만들었다 → 참여 구성 다시 읽기
    doneSeen.current = done;
  }, [org?.id, channel.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!nodeOn || channel.kind === 'dm') return; loadRequests().catch(() => {}); const iv = setInterval(() => loadRequests().catch(() => {}), 3000); return () => clearInterval(iv); }, [loadRequests, nodeOn, channel.kind]);
  const submitCrew = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_crew_requests').insert({ org_id: org.id, channel_id: newCrew.orgWide ? null : channel.id, name: newCrew.name.trim(), role_text: newCrew.role.trim(), prompt: newCrew.prompt.trim(), created_by: uid }).select('id');
    setBusy(false);
    if (res.error) return onError(res.error.message);
    setNewCrew(null); onNote(t('ch.crew.new.sent')); loadRequests().catch(() => {});
  };
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
        {channel.kind !== 'dm' && (
          <section>
            <h3>{t('ch.personal')}</h3>
            <p>{t('ch.personal.desc')}</p>
            <div className="msgr-seg" role="radiogroup" aria-label={t('ch.personal')}>
              {['allowed', 'read_only', 'blocked'].map((v) => <button key={v} type="button" role="radio" aria-checked={(channel.personal_crews ?? 'allowed') === v} className={(channel.personal_crews ?? 'allowed') === v ? 'active' : ''} disabled={!canEdit || busy} onClick={() => upd({ personal_crews: v }, t('ch.personal.saved'))}>{t(`ch.personal.${v}`)}</button>)}
            </div>
            {(channel.personal_crews ?? 'allowed') === 'blocked' && <p className="note">{t('ch.personal.blocked.note')}</p>}
          </section>
        )}
        <section>
          <h3>{t('ch.composition')}</h3>
          <p>{scoped ? t('ch.composition.scoped') : t('ch.composition.public')}</p>
          {!scoped && <p className="note">{t('ch.composition.public.noAdd')}</p>}
          <div className="msgr-rows">
            <div className="msgr-klabel">{t('ch.people')} · {people.length}</div>
            {people.map((m) => { const isMe = m.user_id === uid; return (
              <div key={`u:${m.user_id}`} className="row">
                <Av name={m.display_name || m.user_id} size="sm" /><span className="name">{m.display_name || m.user_id.slice(0, 8)}</span><span className="sub">{t(`role.${m.role}`)}{isMe ? ` · ${t('ui.me')}` : ''}{(chAdmins.includes(m.user_id) || channel.created_by === m.user_id) && <span className="msgr-tag">{channel.created_by === m.user_id ? t('ch.admin.creator') : t('ch.admin')}</span>}</span>
                {canAssignAdmins && !isMe && channel.created_by !== m.user_id && <button type="button" className={`btn sm ghost${chAdmins.includes(m.user_id) ? ' on' : ''}`} disabled={busy} onClick={() => toggleChAdmin(m.user_id)} title={chAdmins.includes(m.user_id) ? t('ch.admin.unset') : t('ch.admin.set')} aria-label={chAdmins.includes(m.user_id) ? t('ch.admin.unset') : t('ch.admin.set')}><I name="gear" size={13} /></button>}
                {!isMe && <button type="button" className="btn sm ghost" onClick={() => onDm?.(m.user_id)} title={t('ui.dm')} aria-label={t('ui.dm')}><I name="at" size={13} /></button>}
                {scoped && canEdit && channel.kind !== 'dm' && !isMe && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => removeMember('user', m.user_id)} title={t('ch.remove')} aria-label={t('ch.remove')}><I name="x" size={13} /></button>}
              </div>
            ); })}
            <div className="msgr-klabel">{t('ch.crews')} · {chCrews.length}</div>
            {!chCrews.length && <p className="empty">{scoped ? t('ch.crews.none.scoped') : t('ch.crews.none')}</p>}
            {chCrews.map((c) => { const on = c.last_seen_at && Date.now() - Date.parse(c.last_seen_at) < AWAY_MS; const company = crewTier(c, org) === 'company'; return (
              <div key={`c:${c.id}`} className="row">
                <Av name={c.display_name} crew size="sm" company={company} /><span className="name">{c.display_name}</span>
                <span className="sub">{company ? t('crew.tier.company.sub', { org: org?.name ?? '', role: c.role_text ?? '' }) : t('crew.tier.personal.sub', { name: nameOfUser(c.owner_user_id), role: c.role_text ?? '' })}</span>
                <span className={`msgr-dot${on ? ' mark' : ''}`} title={on ? t('crew.online') : t('crew.away')} />
                <button type="button" className="btn sm ghost" onClick={() => onCrew?.(c.id)} title={t('ch.open.crew')} aria-label={t('ch.open.crew')}><I name="star" size={13} /></button>
                {scoped && canEdit && channel.kind !== 'dm' && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => removeMember('crew', c.id)} title={t('ch.remove')} aria-label={t('ch.remove')}><I name="x" size={13} /></button>}
              </div>
            ); })}
          </div>
          {scoped && canEdit && channel.kind !== 'dm' && (<>
            <div className="row">
              <button type="button" className="btn sm" disabled={busy || !addableUsers.length} onClick={() => setPick(pick === 'user' ? null : 'user')}><I name="plus" size={13} />{t('ch.add.user')}</button>
              <button type="button" className="btn sm" disabled={busy || !addableCrews.length} onClick={() => setPick(pick === 'crew' ? null : 'crew')}><I name="star" size={13} />{t('ch.add.crew')}</button>
            </div>
            {pick === 'user' && (<>
              <div className="msgr-chips">{addableUsers.map((m) => <button key={m.user_id} type="button" className="msgr-chan" onClick={() => addMember('user', m.user_id)}><span>{m.display_name || m.user_id.slice(0, 8)}</span></button>)}</div>
              <p className="note">{t('ch.add.user.pool', { n: members.length, seats: ent?.seats ?? '?', plan: t(`plan.${ent?.plan ?? 'free'}`) })}{onInvite && <> <button type="button" className="btn sm" onClick={onInvite}><I name="copy" size={12} />{t('org.invite')}</button></>}</p>
            </>)}
            {channel.kind === 'private' && (
              <div className="row">
                <span className="msgr-klabel">{t('ch.guest')}</span>
                <div className="msgr-seg" role="radiogroup" aria-label={t('ch.guest.days')}>{[7, 30, 90].map((d) => <button key={d} type="button" role="radio" aria-checked={guestDays === d} className={guestDays === d ? 'active' : ''} onClick={() => setGuestDays(d)}>{t('ch.guest.day', { n: d })}</button>)}</div>
                <button type="button" className="btn sm" disabled={busy} onClick={guestInvite}><I name="copy" size={13} />{t('ch.guest.link')}</button>
              </div>
            )}
            {pick === 'crew' && (<><div className="msgr-chips">{addableCrews.map((c) => <button key={c.id} type="button" className="msgr-chan" onClick={() => addMember('crew', c.id)}><I name="star" size={13} /><span>{c.display_name}</span></button>)}</div><p className="note">{t('ch.add.crew.note')}</p></>)}
          </>)}
          {channel.kind !== 'dm' && (canCreateCrew || (isAdmin && !nodeOn)) && (
            <div className="msgr-crewnew">
              {!nodeOn ? <p className="note">{t('ch.crew.new.noNode')}</p> : newCrew ? (
                <form className="msgr-inline" onSubmit={(e) => { e.preventDefault(); submitCrew(); }}>
                  <input className="msgr-input" placeholder={t('ch.crew.new.name')} value={newCrew.name} onChange={(e) => setNewCrew({ ...newCrew, name: e.target.value })} autoFocus maxLength={40} />
                  <input className="msgr-input" placeholder={t('ch.crew.new.role')} value={newCrew.role} onChange={(e) => setNewCrew({ ...newCrew, role: e.target.value })} maxLength={60} />
                  <textarea className="msgr-input area" placeholder={t('ch.crew.new.prompt')} value={newCrew.prompt} onChange={(e) => setNewCrew({ ...newCrew, prompt: e.target.value })} maxLength={2000} rows={3} />
                  {isAdmin && <label className="switchrow"><input type="checkbox" checked={newCrew.orgWide} onChange={(e) => setNewCrew({ ...newCrew, orgWide: e.target.checked })} /><span>{t('ch.crew.new.orgWide')}</span></label>}
                  <div className="acts"><button type="submit" className="btn btn-primary sm" disabled={busy || !newCrew.name.trim() || !newCrew.prompt.trim()}><I name="check" size={13} />{t('ch.crew.new.submit')}</button><button type="button" className="btn sm" onClick={() => setNewCrew(null)}>{t('ui.cancel')}</button></div>
                  <p className="note">{t('ch.crew.new.desc')}</p>
                </form>
              ) : <div className="row"><button type="button" className="btn sm" disabled={busy} onClick={() => setNewCrew({ name: '', role: '', prompt: '', orgWide: false })}><I name="plus" size={13} />{t('ch.crew.new')}</button></div>}
              {requests.filter((r) => r.status !== 'done' || Date.now() - Date.parse(r.done_at ?? r.created_at) < 120_000).map((r) => (
                <div key={r.id} className="row req"><span className="name">{r.name}</span><span className={`sub ${r.status}`}>{r.status === 'pending' ? t('ch.crew.new.pending') : r.status === 'failed' ? t('ch.crew.new.failed', { why: r.error ?? '' }) : t('ch.crew.new.done')}</span></div>
              ))}
            </div>
          )}
        </section>
        {canEdit && channel.kind !== 'dm' && (
          <section>
            {!confirmArchive
              ? <div className="row"><button type="button" className="btn sm" disabled={busy} onClick={() => setConfirmArchive(true)}><I name="x" size={13} />{t('ch.archive')}</button></div>
              : <div className="confirm"><p>{t('ch.archive.confirm')}</p><div className="row"><button type="button" className="btn btn-primary sm danger" disabled={busy} onClick={archive}><I name="x" size={13} />{t('ch.archive')}</button><button type="button" className="btn sm" onClick={() => setConfirmArchive(false)}>{t('ui.cancel')}</button></div></div>}
          </section>
        )}
      </aside>
    </div>
  );
}

/* ─── 설정 페이지: 언어 · 테마(아르고와 같은 가족×모드) · 계정 ─── */
const FAMILIES = [['linen', 'settings.family.linen'], ['graphite', 'settings.family.graphite'], ['argo', 'settings.family.argo']];
const MODES = [['', 'set.mode.system'], ['-light', 'set.mode.light'], ['-dark', 'set.mode.dark']];
const FAMILY_CODES = FAMILIES.flatMap(([f]) => MODES.map(([s]) => `${f}${s}`));
function Settings({ session, me, uid, org, isAdmin, policy, members = [], nameOfUser, onChanged, onOrgsChanged, onNote, onError, onBack, onMenu }) {
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
      {org && isAdmin && <OrgCard org={org} uid={uid} members={members} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} />}
      {org && policy && <PolicyCard org={org} isAdmin={isAdmin} policy={policy} members={members} onChanged={onChanged} onNote={onNote} onError={onError} />}
      <section className="msgr-setcard">
        <h2>{t('set.account')}</h2><p>{t('set.account.desc')}</p>
        <div className="row"><Av name={me?.display_name || session.user.email} /><span style={{ fontWeight: 600 }}>{me?.display_name || '—'}</span><span className="msgr-klabel">{session.user.email}</span></div>
        {org && me && <DisplayNameRow org={org} me={me} onChanged={onChanged} onNote={onNote} onError={onError} />}
        <div className="row"><NotifyRow /><button type="button" className="btn sm" onClick={() => supabase.auth.signOut({ scope: 'local' })}><I name="out" size={13} />{t('auth.signOut')}</button></div>
      </section>
    </div></div>
  </>);
}

/* ─── 조직 문서(G-1): 전사(rules/·glossary/·projects/) + 채널 범위. 정본은 서버, 편집권은 RLS(msgr_can_edit_doc) — 화면은 힌트만 ─── */
const DOC_FOLDERS = ['rules', 'glossary', 'projects'];
export const docSlug = (title) => { const s = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); return s || `doc-${Date.now().toString(36)}`; }; // 한글 제목은 시간 기반 슬러그(경로 규칙은 영문·숫자만)
function Docs({ org, isAdmin, channels, chId, uid, nameOfUser, onNote, onError, onBack, onMenu }) {
  const { t, lang } = useT();
  const [docs, setDocs] = useState([]); const [sel, setSel] = useState(null); const [full, setFull] = useState(null);
  const [edit, setEdit] = useState(null); const [busy, setBusy] = useState(false); const [creating, setCreating] = useState(null); // creating: { scope:'org'|channelId, folder, title }
  const load = useCallback(async () => {
    const rows = await q(supabase.from('msgr_org_docs').select('id, channel_id, path, title, version, updated_by, updated_at').eq('org_id', org.id).order('path'));
    setDocs(rows); setSel((cur) => cur && rows.some((d) => d.id === cur) ? cur : (rows[0]?.id ?? null));
  }, [org.id]);
  useEffect(() => { load().catch((e) => onError(e.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // 본문은 선택할 때만
    if (!sel) { setFull(null); return; }
    let on = true;
    supabase.from('msgr_org_docs').select('id, channel_id, path, title, body, version, updated_by, updated_at').eq('id', sel).maybeSingle().then((r) => { if (on) { setFull(r.data ?? null); setEdit(null); } });
    return () => { on = false; };
  }, [sel]);
  const chName = (id) => channels.find((c) => c.id === id)?.name ?? '?';
  const canEdit = (d) => d.channel_id ? true : isAdmin; // 채널 문서는 채널 멤버 누구나(최종 판정은 RLS), 전사는 관리자
  const orgDocs = docs.filter((d) => !d.channel_id); const chDocs = docs.filter((d) => d.channel_id);
  const save = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_org_docs').update({ title: edit.title.trim(), body: edit.body }).eq('id', full.id).select('id');
    setBusy(false);
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t('docs.noEdit'));
    onNote(t('docs.saved')); setEdit(null); await load(); setSel(null); setTimeout(() => setSel(full.id), 0);
  };
  const create = async () => {
    const title = creating.title.trim(); if (!title) return;
    setBusy(true);
    const channel_id = creating.scope === 'org' ? null : creating.scope;
    const res = await supabase.from('msgr_org_docs').insert({ org_id: org.id, channel_id, path: `${creating.folder}/${docSlug(title)}.md`, title, body: '', created_by: uid, updated_by: uid }).select('id').single();
    setBusy(false);
    if (res.error) return onError(/duplicate key|msgr_org_docs_path/.test(res.error.message) ? t('docs.dup') : res.error.message);
    onNote(t('docs.created')); setCreating(null); await load(); setSel(res.data.id);
  };
  const scopes = [['org', t('docs.scope.org')], ...channels.filter((c) => c.kind !== 'dm').map((c) => [c.id, `#${c.name}`])];
  return (<>
    <div className="msgr-top">
      <button type="button" className="msgr-menu" onClick={onMenu} aria-label={t('ui.menu')}><I name="menu" /></button>
      <span className="title"><I name="doc" size={18} />{t('docs.title')}</span>
      <button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button>
    </div>
    <div className="msgr-thread"><div className="msgr-docs">
      <aside className="list">
        <div className="head"><span className="msgr-klabel">{t('docs.scope.org')}</span>{isAdmin && <button type="button" className="btn sm" onClick={() => setCreating({ scope: 'org', folder: 'rules', title: '' })}><I name="plus" size={12} />{t('docs.new')}</button>}</div>
        {!orgDocs.length && <p className="empty">{t('docs.empty.org')}</p>}
        {orgDocs.map((d) => <button key={d.id} type="button" className={`item${sel === d.id ? ' on' : ''}`} onClick={() => setSel(d.id)}><span className="path">{d.path}</span><span className="name">{d.title}</span></button>)}
        <div className="head"><span className="msgr-klabel">{t('docs.scope.channel')}</span>{chId && <button type="button" className="btn sm" onClick={() => setCreating({ scope: chId, folder: 'projects', title: '' })}><I name="plus" size={12} />{t('docs.new')}</button>}</div>
        {!chDocs.length && <p className="empty">{t('docs.empty.channel')}</p>}
        {chDocs.map((d) => <button key={d.id} type="button" className={`item${sel === d.id ? ' on' : ''}`} onClick={() => setSel(d.id)}><span className="path">#{chName(d.channel_id)} · {d.path}</span><span className="name">{d.title}</span></button>)}
      </aside>
      <section className="doc">
        {creating && (
          <div className="new">
            <h2>{t('docs.new.title')}</h2>
            <div className="row"><span className="msgr-klabel">{t('docs.scope')}</span>
              <div className="msgr-seg" role="radiogroup" aria-label={t('docs.scope')}>{scopes.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={creating.scope === v} className={creating.scope === v ? 'active' : ''} disabled={v === 'org' && !isAdmin} onClick={() => setCreating((c) => ({ ...c, scope: v }))}>{l}</button>)}</div></div>
            <div className="row"><span className="msgr-klabel">{t('docs.folder')}</span>
              <div className="msgr-seg" role="radiogroup" aria-label={t('docs.folder')}>{DOC_FOLDERS.map((f) => <button key={f} type="button" role="radio" aria-checked={creating.folder === f} className={creating.folder === f ? 'active' : ''} onClick={() => setCreating((c) => ({ ...c, folder: f }))}>{t(`docs.folder.${f}`)}</button>)}</div></div>
            <input className="msgr-input" placeholder={t('docs.new.placeholder')} value={creating.title} onChange={(e) => setCreating((c) => ({ ...c, title: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} autoFocus />
            <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !creating.title.trim()} onClick={create}><I name="check" size={13} />{t('docs.create')}</button><button type="button" className="btn sm" onClick={() => setCreating(null)}>{t('ui.cancel')}</button></div>
          </div>
        )}
        {!creating && !full && <p className="empty">{docs.length ? t('docs.pick') : t('docs.empty.all')}</p>}
        {!creating && full && (
          <article>
            <header>
              <div><span className="msgr-klabel">{full.channel_id ? `#${chName(full.channel_id)} · ${full.path}` : full.path}</span></div>
              {edit ? <input className="msgr-input" value={edit.title} onChange={(e) => setEdit((x) => ({ ...x, title: e.target.value }))} /> : <h2>{full.title}</h2>}
              <div className="meta">{t('docs.meta', { v: full.version, name: nameOfUser(full.updated_by), when: fmtTs(full.updated_at, lang) })}
                {!edit && canEdit(full) && <button type="button" className="btn sm" onClick={() => setEdit({ title: full.title, body: full.body })}>{t('docs.edit')}</button>}
                {!edit && !canEdit(full) && <span className="note">{t('docs.adminOnly')}</span>}
              </div>
            </header>
            {edit ? (<>
              <textarea className="msgr-input body" value={edit.body} onChange={(e) => setEdit((x) => ({ ...x, body: e.target.value }))} rows={16} />
              <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !edit.title.trim()} onClick={save}><I name="check" size={13} />{t('ui.save')}</button><button type="button" className="btn sm" disabled={busy} onClick={() => setEdit(null)}>{t('ui.cancel')}</button></div>
            </>) : (full.body ? <div className="msgr-sheet"><Markdown text={full.body} /></div> : <p className="empty">{t('docs.blank')}</p>)}
          </article>
        )}
      </section>
    </div></div>
  </>);
}

/* ─── F2-3 본인 표시명 편집(RLS msgr_members_update_self — 역할·제거 표시는 트리거가 막는다) ─── */
function DisplayNameRow({ org, me, onChanged, onNote, onError }) {
  const { t } = useT();
  const [name, setName] = useState(me.display_name ?? ''); const [busy, setBusy] = useState(false);
  useEffect(() => { setName(me.display_name ?? ''); }, [me.display_name]);
  const save = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_org_members').update({ display_name: name.trim() || null }).eq('org_id', org.id).eq('user_id', me.user_id).select('user_id');
    setBusy(false);
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t('set.name.noEdit'));
    onNote(t('set.name.saved')); onChanged();
  };
  return (
    <div className="row">
      <span className="msgr-klabel">{t('set.name')}</span>
      <input className="msgr-input inline" value={name} maxLength={40} placeholder={t('set.name.placeholder')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
      <button type="button" className="btn btn-primary sm" disabled={busy || name.trim() === (me.display_name ?? '')} onClick={save}><I name="check" size={13} />{t('ui.save')}</button>
    </div>
  );
}

/* ─── F2-5 로컬 알림(앱이 열려 있을 때 나를 부르거나 내가 확정할 결재가 오면 OS 알림) — 권한은 여기서만 요청 ─── */
function NotifyRow() {
  const { t } = useT();
  const supported = typeof Notification !== 'undefined';
  const [perm, setPerm] = useState(supported ? Notification.permission : 'unsupported');
  if (!supported) return <span className="note">{t('set.notify.unsupported')}</span>;
  if (perm === 'granted') return <span className="note"><I name="check" size={12} /> {t('set.notify.on')}</span>;
  if (perm === 'denied') return <span className="note">{t('set.notify.denied')}</span>;
  return <button type="button" className="btn sm" onClick={async () => setPerm(await Notification.requestPermission())}><I name="at" size={13} />{t('set.notify.ask')}</button>;
}

/* ─── F2-1·2·3·4 조직 카드(관리자): 조직 이름 · 멤버 역할/제거(2단계) · 초대 만들기/취소 · 감사 기록 ─── */
const ROLES_ASSIGNABLE = ['admin', 'member', 'guest'];
function OrgCard({ org, uid, members, nameOfUser, onChanged, onOrgsChanged, onNote, onError }) {
  const { t, lang } = useT();
  const [name, setName] = useState(org.name); const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState([]); const [inviteRole, setInviteRole] = useState('member');
  const [confirmRemove, setConfirmRemove] = useState(null); const [audit, setAudit] = useState(null);
  const isOwner = org.role === 'owner';
  const admins = members.filter((m) => m.role === 'admin'); // J-2: 이전 제안·승계 대상은 활성 관리자만(서버 트리거와 같은 규칙)
  const iAmNominee = org.pending_owner_user_id === uid;
  const [domain, setDomain] = useState(org.auto_join_domain ?? ''); const [domainRole, setDomainRole] = useState(org.auto_join_role ?? 'member'); // J-3
  useEffect(() => { setDomain(org.auto_join_domain ?? ''); setDomainRole(org.auto_join_role ?? 'member'); }, [org.id, org.auto_join_domain, org.auto_join_role]);
  const saveDomain = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_orgs').update({ auto_join_domain: domain.trim().toLowerCase() || null, auto_join_role: domainRole }).eq('id', org.id).select('id');
    setBusy(false);
    if (res.error) return onError(/msgr_domain_public/.test(res.error.message) ? t('org.domain.public') : /msgr_domain_not_owners/.test(res.error.message) ? t('org.domain.notOwners') : /msgr_owner_only/.test(res.error.message) ? t('org.noEdit') : /auto_join_domain_check/.test(res.error.message) ? t('org.domain.invalid') : res.error.message);
    if (!res.data?.length) return onError(t('org.noEdit'));
    onNote(domain.trim() ? t('org.domain.saved') : t('org.domain.off')); onOrgsChanged();
  };
  const patchOrg = async (patch, okMsg) => {
    setBusy(true);
    const res = await supabase.from('msgr_orgs').update(patch).eq('id', org.id).select('id');
    setBusy(false);
    if (res.error) return onError(/msgr_transfer_not_admin|msgr_successor_not_admin/.test(res.error.message) ? t('org.owner.notAdmin') : /msgr_owner_only/.test(res.error.message) ? t('org.noEdit') : res.error.message);
    if (!res.data?.length) return onError(t('org.noEdit'));
    if (okMsg) onNote(okMsg); onOrgsChanged(); onChanged();
  };
  useEffect(() => { setName(org.name); }, [org.id, org.name]);
  const loadInvites = useCallback(async () => {
    const rows = await q(supabase.from('msgr_invites').select('id, code, role, email, for_node, expires_at, accepted_by, accepted_at, created_at').eq('org_id', org.id).order('created_at', { ascending: false }));
    setInvites(rows);
  }, [org.id]);
  useEffect(() => { loadInvites().catch((e) => onError(e.message)); }, [loadInvites]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveName = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_orgs').update({ name: name.trim() }).eq('id', org.id).select('id');
    setBusy(false);
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t('org.noEdit'));
    onNote(t('org.name.saved')); onOrgsChanged();
  };
  const setRole = async (m, role) => {
    if (role === m.role) return;
    setBusy(true);
    const res = await supabase.from('msgr_org_members').update({ role }).eq('org_id', org.id).eq('user_id', m.user_id).select('user_id');
    setBusy(false);
    if (res.error) return onError(/msgr_owner_only|msgr_member_self_only_name/.test(res.error.message) ? t('org.member.noEdit') : res.error.message);
    if (!res.data?.length) return onError(t('org.member.noEdit'));
    onNote(t('org.member.roleSaved', { name: m.display_name || m.user_id.slice(0, 8), role: t(`role.${role}`) })); onChanged();
  };
  const remove = async (m) => {
    setBusy(true);
    const res = await supabase.from('msgr_org_members').update({ removed_at: new Date().toISOString() }).eq('org_id', org.id).eq('user_id', m.user_id).select('user_id');
    setBusy(false); setConfirmRemove(null);
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t('org.member.noEdit'));
    onNote(t('org.member.removed', { name: m.display_name || m.user_id.slice(0, 8) })); onChanged();
  };
  const makeInvite = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_invites').insert({ org_id: org.id, role: inviteRole, created_by: uid }).select('code').single();
    setBusy(false);
    if (res.error) return onError(res.error.message);
    const link = `${location.origin}${location.pathname}?invite=${res.data.code}`;
    await navigator.clipboard?.writeText(link).catch(() => {});
    onNote(`${t('org.inviteMade')} ${link}`); loadInvites().catch(() => {});
  };
  const revoke = async (inv) => {
    setBusy(true);
    const res = await supabase.from('msgr_invites').delete().eq('id', inv.id).select('id');
    setBusy(false);
    if (res.error) return onError(res.error.message);
    onNote(t('org.invite.revoked')); loadInvites().catch(() => {});
  };
  const loadAudit = async () => {
    const rows = await q(supabase.from('msgr_audit_log').select('id, actor_user_id, actor_crew_id, action, target_kind, target_id, meta, at').eq('org_id', org.id).order('at', { ascending: false }).limit(50));
    setAudit(rows);
  };
  const copyLink = async (inv) => { const link = `${location.origin}${location.pathname}?invite=${inv.code}`; await navigator.clipboard?.writeText(link).catch(() => {}); onNote(`${t('org.invite.copied')} ${link}`); };
  const live = invites.filter((i) => !i.accepted_at && Date.parse(i.expires_at) > Date.now());
  const open = live.filter((i) => !i.for_node); const nodeInvite = live.find((i) => i.for_node) ?? null; // I-4: 노드용 코드는 사람 초대 목록에 섞지 않는다(노드 섹션에서 명령으로)
  const nodeCmd = nodeInvite ? `ARGO_NODE_CODE=${nodeInvite.code} node scripts/msgr-node-bootstrap.mjs` : '';
  const nodeSeen = org.node_seen_at ? Date.parse(org.node_seen_at) : 0; const nodeAlive = !!org.service_user_id && nodeSeen > 0 && Date.now() - nodeSeen < AWAY_MS;
  const nodeStatus = !org.service_user_id ? t('org.node.none') : !nodeSeen ? t('org.node.never') : t(nodeAlive ? 'org.node.on' : 'org.node.off', { when: fmtWhen(org.node_seen_at, lang) });
  const makeNodeInvite = async () => {
    setBusy(true);
    if (nodeInvite) { const d = await supabase.from('msgr_invites').delete().eq('id', nodeInvite.id); if (d.error) { setBusy(false); return onError(d.error.message); } } // 노드 코드는 한 번에 하나 — 다시 만들면 이전 코드 취소(안내 문구와 같은 계약)
    const res = await supabase.from('msgr_invites').insert({ org_id: org.id, role: 'member', for_node: true, created_by: uid }).select('code').single();
    setBusy(false);
    if (res.error) return onError(res.error.message);
    onNote(t('org.node.made')); loadInvites().catch(() => {});
  };
  const copyNodeCmd = async () => { await navigator.clipboard?.writeText(nodeCmd).catch(() => {}); onNote(t('org.node.copied')); };
  return (
    <section className="msgr-setcard">
      <h2>{t('set.org')}</h2><p>{t('set.org.desc')}</p>
      <div className="row">
        <span className="msgr-klabel">{t('org.name')}</span>
        <input className="msgr-input inline" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }} />
        <button type="button" className="btn btn-primary sm" disabled={busy || !name.trim() || name.trim() === org.name} onClick={saveName}><I name="check" size={13} />{t('ui.save')}</button>
      </div>
      {iAmNominee && (
        <div className="msgr-node-cmd">
          <span className="msgr-klabel">{t('org.owner')}</span>
          <p style={{ margin: 0 }}>{t('org.transfer.offered', { name: nameOfUser(org.owner_user_id) })}</p>
          <div className="acts">
            <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => patchOrg({ owner_user_id: uid }, t('org.transfer.accepted'))}><I name="check" size={13} />{t('org.transfer.accept')}</button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => patchOrg({ pending_owner_user_id: null }, t('org.transfer.declined'))}>{t('org.transfer.decline')}</button>
          </div>
        </div>
      )}
      {isOwner && (<>
        <h3>{t('org.owner')}</h3>
        <p>{t('org.owner.desc')}</p>
        <div className="row">
          <span className="msgr-klabel">{t('org.successor')}</span>
          {admins.length ? <div className="picks">{admins.map((m) => { const on = org.successor_user_id === m.user_id; return <button key={m.user_id} type="button" className={`msgr-chan${on ? ' active' : ''}`} aria-pressed={on} disabled={busy} onClick={() => patchOrg({ successor_user_id: on ? null : m.user_id }, t('org.successor.saved'))}><span>{m.display_name || m.user_id.slice(0, 8)}</span></button>; })}</div> : <span className="sub">{t('org.owner.noAdmins')}</span>}
        </div>
        <div className="row">
          <span className="msgr-klabel">{t('org.transfer')}</span>
          {org.pending_owner_user_id
            ? <><span className="msgr-tag">{t('org.transfer.pending', { name: nameOfUser(org.pending_owner_user_id) })}</span><button type="button" className="btn sm ghost" disabled={busy} onClick={() => patchOrg({ pending_owner_user_id: null }, t('org.transfer.cancelled'))} title={t('org.transfer.cancel')} aria-label={t('org.transfer.cancel')}><I name="x" size={13} /></button></>
            : admins.length ? <div className="picks">{admins.map((m) => <button key={m.user_id} type="button" className="msgr-chan" disabled={busy} onClick={() => patchOrg({ pending_owner_user_id: m.user_id }, t('org.transfer.sent', { name: m.display_name || m.user_id.slice(0, 8) }))}><span>{m.display_name || m.user_id.slice(0, 8)}</span></button>)}</div> : <span className="sub">{t('org.owner.noAdmins')}</span>}
        </div>
        <p className="note">{t('org.transfer.desc')}</p>
        <div className="row">
          <span className="msgr-klabel">{t('org.domain')}</span>
          <input className="msgr-input inline" placeholder={t('org.domain.ph')} value={domain} maxLength={253} onChange={(e) => setDomain(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveDomain(); }} />
          <div className="msgr-seg" role="radiogroup" aria-label={t('org.domain.role')}>{['member', 'guest'].map((r) => <button key={r} type="button" role="radio" aria-checked={domainRole === r} className={domainRole === r ? 'active' : ''} onClick={() => setDomainRole(r)}>{t(`role.${r}`)}</button>)}</div>
          <button type="button" className="btn btn-primary sm" disabled={busy || (domain.trim().toLowerCase() === (org.auto_join_domain ?? '') && domainRole === (org.auto_join_role ?? 'member'))} onClick={saveDomain}><I name="check" size={13} />{t('ui.save')}</button>
        </div>
        <p className="note">{org.auto_join_domain ? t('org.domain.on', { domain: org.auto_join_domain, role: t(`role.${org.auto_join_role ?? 'member'}`) }) : t('org.domain.desc')}</p>
      </>)}
      <h3>{t('org.members')} · {members.length}</h3>
      <div className="msgr-rows">
        {members.map((m) => { const isMe = m.user_id === uid; const canEdit = !isMe && m.role !== 'owner'; return (
          <div key={m.user_id} className="row">
            <Av name={m.display_name || m.user_id} size="sm" /><span className="name">{m.display_name || m.user_id.slice(0, 8)}</span>
            {m.role === 'owner' || isMe ? <span className="sub">{t(`role.${m.role}`)}{isMe ? ` · ${t('ui.me')}` : ''}</span>
              : <div className="msgr-seg" role="radiogroup" aria-label={t('org.member.role')}>{ROLES_ASSIGNABLE.map((r) => <button key={r} type="button" role="radio" aria-checked={m.role === r} className={m.role === r ? 'active' : ''} disabled={busy || (r === 'admin' && !isOwner && m.role !== 'admin' && false)} onClick={() => setRole(m, r)}>{t(`role.${r}`)}</button>)}</div>}
            {m.expires_at && <span className={`sub${Date.parse(m.expires_at) < Date.now() ? ' expired' : ''}`}>{Date.parse(m.expires_at) < Date.now() ? t('org.guest.expired') : t('org.guest.until', { when: fmtWhen(m.expires_at, lang) })}</span>}
            {canEdit && confirmRemove !== m.user_id && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setConfirmRemove(m.user_id)} title={t('org.member.remove')} aria-label={t('org.member.remove')}><I name="x" size={13} /></button>}
            {canEdit && confirmRemove === m.user_id && <span className="confirm-inline"><span>{t('org.member.remove.confirm')}</span><button type="button" className="btn btn-primary sm danger" disabled={busy} onClick={() => remove(m)}>{t('org.member.remove')}</button><button type="button" className="btn sm" onClick={() => setConfirmRemove(null)}>{t('ui.cancel')}</button></span>}
          </div>
        ); })}
      </div>
      <h3>{t('org.invites')} · {open.length}</h3>
      <p>{t('org.invites.desc')}</p>
      <div className="row">
        <div className="msgr-seg" role="radiogroup" aria-label={t('org.invite.role')}>{ROLES_ASSIGNABLE.map((r) => <button key={r} type="button" role="radio" aria-checked={inviteRole === r} className={inviteRole === r ? 'active' : ''} onClick={() => setInviteRole(r)}>{t(`role.${r}`)}</button>)}</div>
        <button type="button" className="btn btn-primary sm" disabled={busy} onClick={makeInvite}><I name="copy" size={13} />{t('org.invite.make')}</button>
      </div>
      {open.length > 0 && (
        <div className="msgr-rows">
          {open.map((inv) => (
            <div key={inv.id} className="row">
              <span className="msgr-klabel">{t(`role.${inv.role}`)}</span><span className="name mono">…{inv.code.slice(-8)}</span>
              <span className="sub">{t('org.invite.expires', { when: fmtWhen(inv.expires_at, lang) })}</span>
              <button type="button" className="btn sm ghost" onClick={() => copyLink(inv)} title={t('org.invite.copy')} aria-label={t('org.invite.copy')}><I name="copy" size={13} /></button>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => revoke(inv)} title={t('org.invite.revoke')} aria-label={t('org.invite.revoke')}><I name="x" size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <h3>{t('org.node')}</h3>
      <p>{t('org.node.desc')}</p>
      <div className="row">
        <span className={`msgr-tag${nodeAlive ? ' on' : ''}`}>{nodeStatus}</span>
        {org.service_user_id && <span className="sub">{nameOfUser(org.service_user_id)}</span>}
        <button type="button" className="btn btn-primary sm" disabled={busy} onClick={makeNodeInvite}><I name="doc" size={13} />{t(nodeInvite ? 'org.node.remake' : 'org.node.make')}</button>
      </div>
      {nodeInvite && (
        <div className="msgr-node-cmd">
          <span className="msgr-klabel">{t('org.node.cmd')} · {t('org.invite.expires', { when: fmtWhen(nodeInvite.expires_at, lang) })}</span>
          <code>{nodeCmd}</code>
          <div className="acts">
            <button type="button" className="btn sm" onClick={copyNodeCmd}><I name="copy" size={13} />{t('org.node.copy')}</button>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => revoke(nodeInvite)} title={t('org.invite.revoke')} aria-label={t('org.invite.revoke')}><I name="x" size={13} /></button>
          </div>
          <p className="note">{t('org.node.hint')}</p>
        </div>
      )}
      <h3>{t('org.audit')}</h3>
      {audit === null
        ? <div className="row"><button type="button" className="btn sm" onClick={() => loadAudit().catch((e) => onError(e.message))}><I name="doc" size={13} />{t('org.audit.load')}</button></div>
        : (<div className="msgr-audit">
            {!audit.length && <p className="empty">{t('org.audit.empty')}</p>}
            {audit.map((a) => <div key={a.id} className="row"><span className="when">{fmtWhen(a.at, lang)}</span><span className="who">{a.actor_user_id ? nameOfUser(a.actor_user_id) : (a.actor_crew_id ? t('org.crews') : t('org.audit.system'))}</span><span className="act">{a.action}</span><span className="tgt">{a.target_kind ? `${a.target_kind}${a.target_id ? ` · ${String(a.target_id).slice(0, 12)}` : ''}` : ''}</span></div>)}
            <div className="row"><button type="button" className="btn sm" onClick={() => loadAudit().catch((e) => onError(e.message))}>{t('org.audit.reload')}</button></div>
          </div>)}
    </section>
  );
}

/* ─── 조직 정책 카드(H-0): 관리자만 편집(RLS msgr_policies_update), 멤버는 열람. 잠금 = 조직 전체 강제(서버 트리거) ─── */
function PolicyCard({ org, isAdmin, policy, members = [], onChanged, onNote, onError }) {
  const { t } = useT();
  const [draft, setDraft] = useState(policy); const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(policy); }, [policy]);
  const dirty = ['allow_default', 'allow_locked', 'crew_memory_default', 'crew_memory_locked', 'approval_high_by', 'crew_create', 'crew_runner', 'crew_model', 'guest_seats'].some((k) => draft?.[k] !== policy?.[k]) || JSON.stringify(draft?.approver_user_ids ?? []) !== JSON.stringify(policy?.approver_user_ids ?? []);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const save = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_org_policies').update({ allow_default: draft.allow_default, allow_locked: draft.allow_locked, crew_memory_default: draft.crew_memory_default, crew_memory_locked: draft.crew_memory_locked, approval_high_by: draft.approval_high_by, approver_user_ids: draft.approver_user_ids ?? [], crew_create: draft.crew_create ?? 'channel_admin', crew_runner: draft.crew_runner?.trim() || null, crew_model: draft.crew_model?.trim() || null, guest_seats: !!draft.guest_seats }).eq('org_id', org.id).select('org_id');
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
        <span className="msgr-klabel">{t('set.policy.guests')}</span>
        <label className="switchrow"><input type="checkbox" checked={!!draft.guest_seats} disabled={ro} onChange={(e) => set({ guest_seats: e.target.checked })} /><span>{t('set.policy.guests.seats')}</span></label>
        <span className="note">{t('set.policy.guests.desc')}</span>
      </div>
      <div className="row">
        <span className="msgr-klabel">{t('set.policy.approval')}</span>
        <div className="msgr-seg" role="radiogroup" aria-label={t('set.policy.approval')}>
          {['admin', 'approvers', 'owner'].map((v) => <button key={v} type="button" role="radio" aria-checked={(draft.approval_high_by ?? 'admin') === v} className={(draft.approval_high_by ?? 'admin') === v ? 'active' : ''} disabled={ro} onClick={() => set({ approval_high_by: v })}>{t(`set.policy.approval.${v}`)}</button>)}
        </div>
        <span className="note">{t('set.policy.approval.desc')}</span>
      </div>
      {(draft.approval_high_by === 'approvers') && (
        <div className="row">
          <span className="msgr-klabel">{t('set.policy.approvers')}</span>
          <div className="picks">{members.filter((m) => m.role !== 'owner' && m.role !== 'guest').map((m) => { const on = (draft.approver_user_ids ?? []).includes(m.user_id); /* 게스트 제외: 공개 채널을 못 읽어 결재를 확정할 수 없다 */ return <label key={m.user_id} className={`pick${on ? ' on' : ''}`}><input type="checkbox" checked={on} disabled={ro} onChange={() => set({ approver_user_ids: on ? (draft.approver_user_ids ?? []).filter((x) => x !== m.user_id) : [...(draft.approver_user_ids ?? []), m.user_id] })} /><Av name={m.display_name || m.user_id} size="sm" /><span>{m.display_name || m.user_id.slice(0, 8)}</span></label>; })}</div>
          <span className="note">{t('set.policy.approvers.desc')}</span>
        </div>
      )}
      <div className="row">
        <span className="msgr-klabel">{t('set.policy.crewCreate')}</span>
        <div className="msgr-seg" role="radiogroup" aria-label={t('set.policy.crewCreate')}>
          {['admin', 'channel_admin', 'member'].map((v) => <button key={v} type="button" role="radio" aria-checked={(draft.crew_create ?? 'channel_admin') === v} className={(draft.crew_create ?? 'channel_admin') === v ? 'active' : ''} disabled={ro} onClick={() => set({ crew_create: v })}>{t(`set.policy.crewCreate.${v}`)}</button>)}
        </div>
        <span className="note">{t('set.policy.crewCreate.desc')}</span>
      </div>
      <div className="row">
        <span className="msgr-klabel">{t('set.policy.crewEngine')}</span>
        <input className="msgr-input inline" placeholder={t('set.policy.crewEngine.runner')} value={draft.crew_runner ?? ''} maxLength={32} disabled={ro} onChange={(e) => set({ crew_runner: e.target.value })} />
        <input className="msgr-input inline wide" placeholder={t('set.policy.crewEngine.model')} value={draft.crew_model ?? ''} maxLength={120} disabled={ro} onChange={(e) => set({ crew_model: e.target.value })} />
        <span className="note">{t('set.policy.crewEngine.desc')}</span>
      </div>
      <p className="note">{t('set.policy.limit')}</p>
      {isAdmin ? <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !dirty} onClick={save}><I name="check" size={13} />{t('ui.save')}</button></div> : <p className="note">{t('set.policy.adminOnly')}</p>}
    </section>
  );
}

/** 빈 상태 — 척추 위 단계 노드가 다음 행동을 가르친다(조직 없음 / 채널 없음). */
function EmptyOrg({ org, onMenu, createOrg, createChannel, invite, joinable = [], joinDomain }) {
  const { t } = useT();
  const steps = org ? [
    ['mark', t('ch.step1'), t('ch.step1.sub'), <button key="a" type="button" className="btn btn-primary sm" onClick={createChannel}><I name="hash" size={13} />{t('ch.new')}</button>],
    ['', t('ch.step2'), t('ch.step2.sub'), invite ? <button key="b" type="button" className="btn sm" onClick={invite}><I name="copy" size={13} />{t('org.invite')}</button> : null],
    ['', t('ch.step3'), t('ch.step3.sub'), null],
  ] : [
    ...(joinable.length ? [['mark', t('org.step.join'), t('org.step.join.sub'), <div key="j" className="msgr-chips">{joinable.map((o) => <button key={o.id} type="button" className="msgr-chan" onClick={() => joinDomain(o)}><span>{o.name}</span><span className="msgr-klabel">{t('org.join.cta')}</span></button>)}</div>]] : []), // J-3: 회사 도메인 계정이면 초대 없이 바로
    [joinable.length ? '' : 'mark', t('org.step.create'), t('org.step.create.sub'), <button key="a" type="button" className="btn btn-primary sm" onClick={createOrg}><I name="plus" size={13} />{t('org.new')}</button>],
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
function Channel({ channel, orgId, org, uid, isAdmin, locked = false, policy, members, crews, people = [], chCrews = [], nameOfUser, crewOf, event, typing, onError, onMenu, onCrew, onTitle, dmName }) {
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
    const apRows = await q(supabase.from('msgr_crew_approvals').select('id, crew_id, approval_id, action, reason, status, decided_by, decided_at, message_id, risk, kind, payload').eq('channel_id', chId));
    setAps(Object.fromEntries(apRows.map((r) => [r.id, r])));
  }, [chId]);
  useEffect(() => { load().catch((e) => onError(e.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastId = msgs?.at(-1)?.id ?? 0;
  useEffect(() => {
    if (!event) return;
    if ((event.kind === 'message' || event.kind === 'approval') && event.channel_id === chId) load(lastId).catch(() => {});
  }, [event]); // eslint-disable-line react-hooks/exhaustive-deps
  const stick = useRef(true); // 바닥 고정 여부 — 사용자가 바닥에서 40px 넘게 올려두면 false(QA: 열릴 때 30px 모자라게 멈춰 마지막 메시지가 가려졌다)
  useEffect(() => { stick.current = true; }, [chId]);
  useEffect(() => {
    const el = feed.current; if (!el) return;
    const onScroll = () => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
    el.addEventListener('scroll', onScroll, { passive: true });
    const toBottom = () => { if (stick.current) el.scrollTop = el.scrollHeight; };
    const ro = new ResizeObserver(toBottom); // 렌더 뒤 높이 변화(Markdown·첨부·타이핑 표시)에도 바닥을 따라간다
    const spine = el.firstElementChild; if (spine) ro.observe(spine);
    toBottom();
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, [chId]);
  useEffect(() => { const el = feed.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [msgs?.length]);
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
    rows.push(<Message key={m.id} m={m} uid={uid} lang={lang} t={t} nameOfUser={nameOfUser} crewOf={crewOf} isAdmin={isAdmin} policy={policy} ap={apOf(m)} atts={atts[m.id] ?? []} decide={decide} parent={m.reply_to ? all.find((x) => x.id === m.reply_to) : null} onCrew={onCrew} onError={onError} />);
  }
  const tabs = [['all', null, 0], ['mention', 'at', counts.mention], ['approval', 'stamp', counts.approval], ['crew', 'star', counts.crew]];
  return (<>
    <div className="msgr-top">
      <button type="button" className="msgr-menu" onClick={onMenu} aria-label={t('ui.menu')}><I name="menu" /></button>
      <button type="button" className="title msgr-titlebtn" onClick={onTitle} title={t('ch.sheet')}><I name={channel.kind === 'private' ? 'lock' : channel.kind === 'dm' ? 'at' : 'hash'} size={18} />{channel.kind === 'dm' ? dmName(channel) : channel.name}<I name="caret" size={13} className="caret" /></button>
      {channel.topic && <span className="topic">{channel.topic}</span>}
      {channel.crew_memory === false && <span className="msgr-klabel" title={t('ch.crewMemory')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><I name="memoff" size={13} />{t('ch.memoryOff')}</span>}
      <button type="button" className="members" onClick={onTitle} title={t('ch.composition')} aria-label={t('ch.composition')}>{people.slice(0, 4).map((m) => <Av key={m.user_id} name={m.display_name || m.user_id} size="sm" />)}{chCrews.slice(0, 3).map((c) => <Av key={c.id} name={c.display_name} crew size="sm" company={crewTier(c, org) === 'company'} />)}<span className="n">{t('ch.composition.count', { p: people.length, c: chCrews.length })}</span></button>
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
    <Composer chId={chId} orgId={orgId} org={org} uid={uid} members={members} crews={crews} channel={channel} locked={locked} sbw={sbw} typingCrews={typingCrews} onSent={() => load(lastId).catch(() => {})} onError={onError} />
  </>);
}

function Message({ m, uid, lang, t, nameOfUser, crewOf, isAdmin, policy, ap, atts, decide, parent, onCrew, onError }) {
  const [copied, setCopied] = useState(false);
  const crew = m.crew_id ? crewOf(m.crew_id) : null;
  const name = m.author_kind === 'user' ? nameOfUser(m.author_user_id) : (crew?.display_name ?? t('org.crews'));
  const body = m.deleted_at ? '' : m.body;
  const copy = () => { navigator.clipboard?.writeText(body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  const mine = m.author_kind === 'user' && m.author_user_id === uid;
  const quote = parent && <div className="msgr-quote"><I name="reply" size={13} /><span className="q">{parent.author_kind === 'user' ? nameOfUser(parent.author_user_id) : crewOf(parent.crew_id)?.display_name}: {parent.body}</span></div>; // 긴 원문은 한 줄 말줄임(QA: 카드 밖으로 잘림)
  const attRow = atts.length > 0 && <div>{atts.map((a) => <Attachment key={a.id} a={a} onError={onError} />)}</div>;
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
  const mode = policy?.approval_high_by ?? 'admin';
  const byAdmin = high && mode !== 'owner'; // H-1: 고위험은 정책의 결재권자(기본 관리자). J-1: 'approvers'면 지정 결재권자도
  const isApprover = (policy?.approver_user_ids ?? []).includes(uid);
  const can = byAdmin ? (!!isAdmin || (mode === 'approvers' && isApprover)) : owner;
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
        {ap.kind === 'org_doc' && ap.payload && (
          <div className="docprop">
            <div className="msgr-klabel">{t('ap.orgDoc')} · {ap.payload.scope === 'org' ? t('docs.scope.org') : t('docs.scope.channel')} · {ap.payload.path}</div>
            <div className="title">{ap.payload.title}</div>
            <div className="msgr-sheet"><Markdown text={String(ap.payload.body ?? '').slice(0, 1200)} />{String(ap.payload.body ?? '').length > 1200 && <p className="note">{t('ap.orgDoc.more')}</p>}</div>
            {ap.status === 'approved' && <p className="note">{t('ap.orgDoc.applied')}</p>}
          </div>
        )}
        <div className="row2">
          {ap.status === 'pending' && can && (<>
            <button type="button" className="btn btn-primary sm" onClick={() => decide(ap, 'approved')}><I name="check" size={13} />{t('ap.approve')}</button>
            <button type="button" className="btn sm" onClick={() => decide(ap, 'rejected')}><I name="x" size={13} />{t('ap.reject')}</button>
          </>)}
          {ap.status === 'pending' && !can && <span className="note">{byAdmin ? (mode === 'approvers' ? t('ap.approverNote') : t('ap.adminNote')) : t('ap.ownerNote')}</span>}
          {ap.status === 'approved' && <span className="msgr-seal ok"><I name="check" />{nameOfUser(ap.decided_by)} · {when}</span>}
          {ap.status === 'rejected' && <span className="msgr-seal no"><I name="x" />{nameOfUser(ap.decided_by)} · {when}</span>}
          {ap.status === 'expired' && <span className="msgr-seal"><I name="clock" />{t('ap.noDecision')}</span>}
        </div>
      </div>
    </div>
  );
}
function Attachment({ a, onError }) {
  const open = async () => {
    const { data, error } = await supabase.storage.from('msgr').createSignedUrl(a.storage_path, 600); // 서명 URL(단수명) — 버킷 정책은 채널 단위
    if (error) return onError?.(error.message);
    window.open(data.signedUrl, '_blank', 'noopener');
  };
  return <button type="button" className="msgr-file" onClick={open}><I name="doc" size={13} />{a.name}{a.bytes ? <span>{Math.round(a.bytes / 1024)}KB</span> : null}</button>;
}

/* ─── 2단 다크 독: 입력 줄 + 도구 줄(첨부·멘션 │ 기억 상태) + 옐로 원형 전송. @멘션 팝업(사람·크루), Enter 전송(IME 조합 제외) ─── */
function Composer({ chId, orgId, org, uid, members, crews, channel, locked = false, sbw = 0, typingCrews, onSent, onError }) {
  const { t } = useT();
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [files, setFiles] = useState([]);
  const [pop, setPop] = useState(null); const [sel, setSel] = useState(0);
  const [uploading, setUploading] = useState(''); // 올리는 중인 파일 이름
  const [mentions, setMentions] = useState([]);
  const ta = useRef(null); const fileRef = useRef(null);
  const candidates = useMemo(() => {
    if (!pop) return [];
    const needle = pop.q.toLowerCase();
    const usable = channel?.personal_crews && channel.personal_crews !== 'allowed' ? crews.filter((c) => crewTier(c, org) === 'company') : crews; // I-3: 이 채널이 회사 크루만이면 개인 크루는 멘션 후보에서 뺀다(안 될 버튼 노출 금지 — 최종 판정은 서버)
    const list = [...usable.map((c) => ({ kind: 'crew', id: c.id, name: c.display_name, sub: c.role_text })), ...members.map((m) => ({ kind: 'user', id: m.user_id, name: m.display_name || m.user_id.slice(0, 8), sub: m.role }))];
    return list.filter((x) => !needle || x.name.toLowerCase().includes(needle)).slice(0, 8);
  }, [pop, crews, members, channel?.personal_crews, org]);
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
          <button className="send" disabled={busy || locked || !text.trim()} aria-label={t('msg.send')} title={locked ? t('org.locked.short') : t('msg.send')}><I name="up" size={16} /></button>
        </div>
      </form>
      <div className="msgr-sub">
        <span className="typing-line">{typingCrews.length > 0 && <><span className="msgr-dot mark" />{t('msg.typing', { name: typingCrews.map((c) => c.display_name).join(', ') })}</>}</span>
      </div>
    </div></div>
  );
}
