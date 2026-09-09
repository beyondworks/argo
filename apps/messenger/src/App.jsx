// Argo 메신저 — 조직·채널·메시지·크루·결재 슬립. 데이터는 Supabase 직결(RLS가 경계), 실시간은 private topic org:<id> 방송.
// 룩 = linen v2(apps/messenger/design): 타임라인 척추 · 사람 원/크루 타일 · 2단 다크 독 · 결재 슬립 · 자체 아이콘(icons.jsx).
// Argo 부품은 .shell/.side(테마 토큰 스코프)·.btn·Markdown·imeGuardWith만 쓰고, 나머지는 styles.css의 .msgr-*.
// 1차 범위(MESSENGER-DESIGN.md P1): 로그인 · 조직/초대 · 공개/비공개 채널 · 메시지 · @멘션 · 첨부 · 결재 · 크루 부재중 · 타이핑.
import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Graph3D } from './graph3d.jsx';
import * as Panes from './panes.mjs'; import { GRAPH_TAB, MAX_PANES } from './panes.mjs'; // 창·탭 전이(순수) // 활동 그래프 3D(옵시디언식 구·궤도 회전) — 구성은 @argo/graph2d-core 재사용
import { supabase, configured, q } from './supabase.js';
import { customServer, SB_URL } from './supabase.js';
import { readProfile, writeProfile, clearProfile, normalizeUrl, hostOf } from './server-profile.mjs';
import { handoff } from './oauth-handoff.mjs';
import { UpdateBar } from './update.jsx';
import { t as tm } from './i18n.js';
import { useLang } from '@argo/i18n';
import { useTheme, THEMES } from '@argo/theme';
import { Markdown, imeGuardWith } from '@argo/ui';
import { EMOJI_GROUPS, bumpEmoji, topEmoji, searchEmoji } from './emoji.js';
import { Sprite, I, STAR_D } from './icons.jsx';
const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const AWAY_MS = 90_000;
/** 크루 등급(부록 I·K) — 서버 함수 msgr_crew_tier와 같은 규칙: 조직 서비스 계정이 소유하고 상주 노드에서 돌면 회사 크루, 그 외는 개인(파견) 크루. 화면 표시용이며 판정 정본은 서버. */
export const crewTier = (crew, org) => (crew?.hosting === 'bot' || (org?.service_user_id && crew?.owner_user_id === org.service_user_id && crew?.hosting === 'resident')) ? 'company' : 'personal'; // 봇(외부 에이전트)도 회사 등급 — 서버 msgr_crew_tier와 같은 규칙(부록 N)
const PAGE = 100;
const ATTACH_MAX = 25 * 1024 * 1024; // 브리지 ATTACH_MAX(src/gateway/msgr.mjs)와 같은 값 — 받는 쪽에서만 거절하면 보낸 사람은 이유를 모른다
const fmtTs = (iso, lang) => new Date(iso).toLocaleTimeString(lang === 'en' ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' });
const dayKey = (iso) => new Date(iso).toDateString();
/** 서버 거절 원문 → 사람 문구(검수 M-5: RLS·check 제약 원문이 그대로 뜨던 자리들의 공통 매핑). 모르는 오류는 원문 유지(정직). */
const friendlyErr = (msg, t) => /row-level security/.test(msg) ? t('err.denied') : /_check\b|violates check constraint/.test(msg) ? t('err.invalid') : /msgr_seat_limit/.test(msg) ? t('seat.limit') : /msgr_org_locked|read-only/.test(msg) ? t('org.locked.short') : msg;
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
/** 조용한 시간 판정 — from>to면 자정을 넘는 구간(22~7). */
function inQuiet(qh) { if (!qh) return false; const h = new Date().getHours(); return qh.from <= qh.to ? (h >= qh.from && h < qh.to) : (h >= qh.from || h < qh.to); }
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
  if (!configured) body = <div className="msgr-auth"><div className="msgr-card"><div className="body"><p style={{ color: 'var(--danger)' }}>{t('auth.notConfigured')}</p><ServerRow t={t} open /></div></div></div>;
  else if (session === undefined) body = <div className="msgr-auth"><span className="msgr-klabel">{t('ui.loading')}</span></div>;
  else if (!session) body = <Auth />;
  else body = <Shell session={session} />;
  return <><Sprite /><UpdateBar t={t} />{body}</>;
}

/* ─── 서버 선택(부록 L): 기본 Argo 클라우드 / 회사 서버(셀프호스트 Supabase) — 프로필은 이 기기에만, 저장 뒤 새로고침 ─── */
function ServerRow({ t, open = false }) {
  const cur = readProfile(localStorage);
  const [edit, setEdit] = useState(open);
  const [url, setUrl] = useState(cur?.url ?? ''); const [anon, setAnon] = useState(cur?.anon ?? ''); const [bad, setBad] = useState(false);
  const save = () => { if (!normalizeUrl(url) || !anon.trim()) { setBad(true); return; } writeProfile(localStorage, { url, anon }); location.reload(); };
  const reset = () => { clearProfile(localStorage); location.reload(); };
  return (
    <details className="msgr-server" open={edit} onToggle={(e) => setEdit(e.currentTarget.open)}>
      <summary><I name="hash" size={12} />{customServer ? t('auth.server.custom', { host: hostOf(SB_URL) }) : t('auth.server.cloud')}<span className="msgr-klabel">{t('auth.server')}</span></summary>
      <p>{t('auth.server.desc')}</p>
      <label className="msgr-field"><I name="at" /><input placeholder="https://supabase.company.com" value={url} onChange={(e) => { setUrl(e.target.value); setBad(false); }} spellCheck={false} /></label>
      <label className="msgr-field"><I name="lock" /><input placeholder={t('auth.server.key')} value={anon} onChange={(e) => { setAnon(e.target.value); setBad(false); }} spellCheck={false} /></label>
      {bad && <p style={{ color: 'var(--danger)' }}>{t('auth.server.bad')}</p>}
      <div className="row"><button type="button" className="btn sm btn-primary" onClick={save} disabled={!url || !anon}>{t('auth.server.save')}</button>{customServer && <button type="button" className="btn sm ghost" onClick={reset}>{t('auth.server.reset')}</button>}</div>
    </details>
  );
}

/* ─── 로그인: 머리띠 카드 + 브라우저 핸드오프(Google·GitHub — Argo 앱과 같은 계정·같은 방식). 개발 빌드에서는 비밀번호 로그인도(로컬 스택엔 OAuth가 없다). ─── */
function Auth() {
  const { t, lang, setLang } = useT();
  const [email, setEmail] = useState(''); const [pw, setPw] = useState('');
  const [waiting, setWaiting] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const run = async (fn) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  // 앱 웹뷰는 provider 창을 못 띄운다 → 셸이 루프백 브리지를 열고 진짜 브라우저에서 로그인, pairing code로 세션 회수(oauth-handoff.mjs·src-tauri/src/pair.rs).
  // 브라우저(dev·vite preview)에서는 셸이 없어 버튼이 정직하게 안내한다(auth.err.notApp) — 로컬 스택 실측은 dev 비밀번호 로그인으로.
  const viaBrowser = (provider) => run(async () => {
    setWaiting(provider);
    try {
      const deps = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now };
      if (inTauri()) { deps.invoke = (await import('@tauri-apps/api/core')).invoke; deps.openUrl = (await import('@tauri-apps/plugin-opener')).openUrl; }
      const tokens = await handoff({ supabaseUrl: SB_URL, provider }, deps);
      await q(supabase.auth.setSession(tokens)); // 세션 단일 소유자 = 이 앱(브라우저 탭은 파싱만 하고 버린다)
      try { if (inTauri()) (await import('@tauri-apps/api/window')).getCurrentWindow().setFocus(); } catch { /* 포커스는 장식 */ }
    } catch (e) {
      const k = { not_app: 'auth.err.notApp', start_failed: 'auth.err.start', open_failed: 'auth.err.open', timeout: 'auth.err.timeout', expired: 'auth.err.expired' }[e.message];
      throw new Error(k ? t(k) : e.message);
    } finally { setWaiting(''); }
  });
  return (
    <div className="msgr-auth"><form className="msgr-card" onSubmit={(e) => e.preventDefault()}>
      <div className="band"><svg width="14" height="14" viewBox="0 0 16 16"><path d={STAR_D} /></svg>ARGO<span className="tag">{t('auth.tag')}</span></div>
      <div className="body">
        <h1>{t('auth.title')}</h1>
        <p>{t('auth.desc')}</p>
        {waiting ? (
          <p className="msgr-wait"><span className="msgr-klabel">{t('auth.waiting')}</span><button type="button" className="btn sm ghost" onClick={() => location.reload()}>{t('auth.cancel')}</button></p>
        ) : (<>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => viaBrowser('google')}>{t('auth.google')}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => viaBrowser('github')}>{t('auth.github')}</button>
        </>)}
        {(import.meta.env.DEV || import.meta.env.VITE_DEV_LOGIN === '1') && (<> {/* VITE_DEV_LOGIN=1: 로컬 스택을 보는 검수용 번들에서만(OAuth가 없다) — 발행 빌드엔 넣지 않는다 */}
          <span className="msgr-klabel devsep">{t('auth.devOnly')}</span>
          <label className="msgr-field"><I name="at" /><input type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="msgr-field"><I name="lock" /><input type="password" placeholder={t('auth.password')} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <button className="btn" disabled={busy || !email || !pw} onClick={() => run(async () => { await q(supabase.auth.signInWithPassword({ email, password: pw })); })}>{t('auth.verify')} (dev)</button>
        </>)}
        {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}
        <ServerRow t={t} />
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
  const [members, setMembers] = useState([]); const [crews, setCrews] = useState([]); const [myAvailable, setMyAvailable] = useState([]); // 부록 M: 내 파견 전 크루(status available — 아르고 브리지가 미러)
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
  const [chSheetAdd, setChSheetAdd] = useState(null); // 시트를 열 때 바로 펼칠 패널('crew') — 상단 "크루" 버튼(유건 지적 2026-09-08: 크루를 채널에 넣는 UI가 안 보임)
  const [mentionReq, setMentionReq] = useState(null); // 시트 "@로 부르기" → 작성창에 멘션 삽입
  const [inbox, setInbox] = useState([]); const [inboxSeen, setInboxSeen] = useState(() => readInboxSeen()); const [inboxPrev, setInboxPrev] = useState(0); // 알림함 v1
  const [railSort, setRailSort] = useState(() => { try { const v = localStorage.getItem('argo-msgr-rail-sort'); return v === 'added' ? 'added' : 'name'; } catch { return 'name'; } }); // 내 에이전트 정렬: name(이름순) | added(추가순) — 소속별·그룹은 뺐다(유건 결정 2026-09-09: 평평한 목록)
  const pickSort = (v) => { setRailSort(v); try { localStorage.setItem('argo-msgr-rail-sort', v); } catch {} };
  const [meMenu, setMeMenu] = useState(false);
  const [settingsTab, setSettingsTab] = useState(null); // 알림함·프로필 메뉴에서 설정의 특정 탭으로
  const [searchQ, setSearchQ] = useState(''); const [searchRes, setSearchRes] = useState(null); const searchRef = useRef(null); // 앱 내 검색(유건 지시 2026-09-09): 메시지 본문·사람·에이전트, ⌘K
  useEffect(() => { const on = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setRail(true); searchRef.current?.focus(); } }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, []);
  const runSearch = async (raw) => {
    const qs = raw.trim(); if (!qs || !org) { setSearchRes(null); return; }
    setPage('search'); setRail(false);
    const like = `%${qs.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const msgs = await q(supabase.from('msgr_messages').select('id, channel_id, author_kind, author_user_id, crew_id, body, created_at').eq('org_id', org.id).is('deleted_at', null).ilike('body', like).order('id', { ascending: false }).limit(60)).catch(() => []);
    const lc = qs.toLowerCase();
    setSearchRes({ q: qs, msgs, people: members.filter((m) => (m.display_name || '').toLowerCase().includes(lc)), agents: crews.filter((c) => c.display_name.toLowerCase().includes(lc) || (c.role_text || '').toLowerCase().includes(lc)), channels: channels.filter((c) => c.kind !== 'dm' && (c.name || '').toLowerCase().includes(lc)) });
  }; // 하단 프로필(이름) 클릭 → 메뉴(내 계정·로그아웃) — 로그아웃 버튼은 여기로(유건 지시 2026-09-09)
  const [friends, setFriends] = useState([]); // 친구·요청(msgr_my_friends) — 레일 '친구' 절·알림함·설정 카드가 같이 쓴다
  const loadFriends = useCallback(async () => { setFriends(await q(supabase.rpc('msgr_my_friends')).catch(() => [])); }, []);
  useEffect(() => { if (uid) loadFriends(); }, [uid, tick, loadFriends]);
  const [botKinds, setBotKinds] = useState([]); // 내 에이전트 출처(헤르메스·오픈클로) — 훅은 조기 return보다 앞에(실측: 순서 오류로 빈 화면)
  useEffect(() => { if (!orgId) { setBotKinds([]); return; } q(supabase.from('msgr_bots').select('crew_id, kind').eq('org_id', orgId).is('revoked_at', null)).then(setBotKinds).catch(() => setBotKinds([])); }, [orgId, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const rt = useRef(null);
  const loadOrgs = useCallback(async () => {
    const rows = await q(supabase.from('msgr_org_members').select('org_id, role, msgr_orgs(id, name, slug, owner_user_id, service_user_id, node_seen_at, pending_owner_user_id, successor_user_id, auto_join_domain, auto_join_role, deleted_at, node_info)').eq('user_id', uid).is('removed_at', null));
    const list = rows.filter((r) => r.msgr_orgs && !r.msgr_orgs.deleted_at).map((r) => ({ id: r.org_id, role: r.role, ...r.msgr_orgs }));
    setOrgs(list);
    setOrgId((cur) => cur && list.some((o) => o.id === cur) ? cur : (list[0]?.id ?? null));
    setJoinable(await q(supabase.rpc('msgr_joinable_orgs')).catch(() => [])); // J-3: 내 이메일 도메인으로 들어갈 수 있는 조직(서버가 판정)
    setDeletedOrgs(await q(supabase.rpc('msgr_my_deleted_orgs')).catch(() => [])); // J-5: 내가 소유한 삭제 예정 조직(30일 안 복구 가능)
  }, [uid]);
  const restoreOrg = async (o) => {
    try { await q(supabase.rpc('msgr_restore_org', { org: o.id })); setNote(t('org.restore.done', { name: o.name })); await loadOrgs(); setOrgId(o.id); }
    catch (e) { setErr(/msgr_restore_expired/.test(e.message) ? t('org.restore.expired') : e.message); }
  };
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
      q(supabase.from('msgr_crews').select('id, owner_user_id, slug, display_name, role_text, hosting, status, allow, allow_users, last_seen_at, folder, created_at').eq('org_id', id).in('status', ['active', 'available'])).then((rows) => { setMyAvailable(rows.filter((r) => r.status === 'available' && r.owner_user_id === uid).sort((x, y) => x.display_name.localeCompare(y.display_name, 'ko'))); return rows.filter((r) => r.status === 'active'); }),
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
  // 부록 M: 그 자리 파견 — available → active(허용 범위는 조직 정책 기본값, 잠금이면 서버 게이트가 맞춘다) → 채널 멤버(+소유자 동반). 채널 없이 부르면 조직에만 파견.
  const dispatchCrew = useCallback(async (crew, channelId = null) => {
    const allow = policy?.allow_default ?? 'all';
    const up = await supabase.from('msgr_crews').update({ status: 'active', allow, allow_users: [] }).eq('id', crew.id).select('id');
    if (up.error) throw new Error(up.error.message);
    const ch = channels.find((c) => c.id === channelId);
    if (channelId && ch && ch.kind !== 'public') { // 공개 채널은 파견만으로 참여(멤버 행 없음) — 비공개·DM만 멤버 행
      const rows = [{ channel_id: channelId, member_kind: 'crew', member_id: crew.id, added_by: uid }, { channel_id: channelId, member_kind: 'user', member_id: uid, added_by: uid }];
      const res = await supabase.from('msgr_channel_members').upsert(rows, { onConflict: 'channel_id,member_kind,member_id' });
      if (res.error && !/msgr_channel_personal_blocked/.test(res.error.message)) throw new Error(res.error.message);
      if (res.error) throw new Error(t('err.channelPersonalBlocked'));
    }
    await loadOrg(orgId);
  }, [policy, uid, orgId, loadOrg, t, channels]);
  const loadChMembers = useCallback(async (id) => { if (!id) { setChMembers([]); return; } const rows = await q(supabase.from('msgr_channel_members').select('member_kind, member_id, added_by').eq('channel_id', id)); setChMembers(rows); }, []);
  useEffect(() => { loadChMembers(chId).catch(() => setChMembers([])); }, [chId, loadChMembers, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setChSheet(false); }, [chId]); // 채널을 바꿀 때만 닫는다(검수 HIGH-1: tick 의존이면 15초마다 시트가 닫혔다)
  const [unread, setUnread] = useState({}); const [muted, setMuted] = useState(() => new Set()); const [quiet, setQuiet] = useState(null); // P0(2026-09-09): 채널별 안 읽음·음소거·조용한 시간
  const loadUnread = useCallback(async () => { if (!orgId) return; const rows = await q(supabase.rpc('msgr_unread', { org: orgId })).catch(() => null); if (rows) setUnread(Object.fromEntries(rows.map((r) => [r.channel_id, { n: r.n, mention: r.mention }]))); }, [orgId]);
  useEffect(() => { loadUnread(); }, [loadUnread, tick]);
  useEffect(() => { if (!uid) return; q(supabase.from('msgr_channel_prefs').select('channel_id, muted').eq('user_id', uid)).then((rows) => setMuted(new Set(rows.filter((r) => r.muted).map((r) => r.channel_id)))).catch(() => {}); q(supabase.from('msgr_profiles').select('quiet_from, quiet_to').eq('user_id', uid).maybeSingle()).then((p) => setQuiet(p && p.quiet_from != null && p.quiet_to != null ? { from: p.quiet_from, to: p.quiet_to } : null)).catch(() => {}); }, [uid, tick]);
  const toggleMute = async (c) => { const on = !muted.has(c.id); try { await q(supabase.from('msgr_channel_prefs').upsert({ channel_id: c.id, user_id: uid, muted: on, updated_at: new Date().toISOString() })); setMuted((s) => { const n = new Set(s); if (on) n.add(c.id); else n.delete(c.id); return n; }); } catch (e) { setErr(e.message); } };
  const markRead = useCallback(async (channelId, lastId) => { setUnread((u) => (u[channelId]?.n ? { ...u, [channelId]: { n: 0, mention: 0 } } : u)); try { await q(supabase.from('msgr_reads').upsert({ channel_id: channelId, user_id: uid, last_read_id: lastId, updated_at: new Date().toISOString() })); } catch { /* 커서 저장 실패는 다음 조회에서 다시 */ } }, [uid]);
  const [event, setEvent] = useState(null); const [typing, setTyping] = useState({}); const [progress, setProgress] = useState({}); // progress = 실행 카드(단계·도구·사고 과정) 스냅샷, 키 channel:crew
  useEffect(() => { // Realtime — 조직 topic 하나. 방송은 id·채널만 싣는다(본문은 RLS를 지난 조회로).
    if (!orgId) return;
    let ch;
    (async () => {
      await supabase.realtime.setAuth(session.access_token);
      ch = supabase.channel(`org:${orgId}`, { config: { private: true } })
        .on('broadcast', { event: 'message' }, ({ payload }) => { setEvent({ kind: 'message', ...payload, at: Date.now() }); notifyMention(payload); })
        .on('broadcast', { event: 'approval' }, ({ payload }) => { setEvent({ kind: 'approval', ...payload, at: Date.now() }); notifyApproval(payload); })
        .on('broadcast', { event: 'typing' }, ({ payload }) => setTyping((m) => ({ ...m, [`${payload.channel_id}:${payload.crew_id}`]: Date.now() })))
        .on('broadcast', { event: 'reaction' }, ({ payload }) => setEvent({ kind: 'reaction', ...payload, at: Date.now() }))
        .on('broadcast', { event: 'edit' }, ({ payload }) => setEvent({ kind: 'edit', ...payload, at: Date.now() }))
        .on('broadcast', { event: 'progress' }, ({ payload }) => setProgress((m) => ({ ...m, [`${payload.channel_id}:${payload.crew_id}`]: { ...payload, at: Date.now() } })))
        .subscribe((status, e) => { if (import.meta.env.DEV) console.log('[rt]', status, e?.message ?? ''); });
      rt.current = ch;
      if (import.meta.env.DEV) window.__argoRt = ch;
    })();
    return () => { ch?.unsubscribe(); rt.current = null; };
  }, [orgId, session.access_token]);
  useEffect(() => { const iv = setInterval(() => setTick((x) => x + 1), 15_000); return () => clearInterval(iv); }, []);
  useEffect(() => { if (event?.kind === 'message') loadUnread(); }, [event]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!rail && !orgMenu) return; const on = (e) => { if (e.key === 'Escape') { setRail(false); setOrgMenu(false); } }; window.addEventListener('keydown', on); return () => window.removeEventListener('keydown', on); }, [rail, orgMenu]);
  useEffect(() => { if (tick % 2 === 0 && orgId) loadOrg(orgId).catch(() => {}); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const org = orgs?.find((o) => o.id === orgId);
  useEffect(() => { // 알림함 v1(클라이언트 집계): 나를 멘션한 글 · 내 글에 달린 크루 답글 · 대기 결재 · DM 새 글. 읽음 기준은 이 기기(localStorage) — 서버 표(msgr_notifications)는 친구 요청과 함께 v2.
    if (!org || !uid) { setInbox([]); return; }
    let dead = false;
    (async () => {
      const dmIds = channels.filter((c) => c.kind === 'dm').map((c) => c.id);
      const cols = 'id, channel_id, author_kind, author_user_id, crew_id, body, created_at, reply_to';
      const [ments, mine, aps, dms] = await Promise.all([
        q(supabase.from('msgr_messages').select(cols).eq('org_id', org.id).is('deleted_at', null).contains('mentions', JSON.stringify([{ kind: 'user', id: uid }])).order('id', { ascending: false }).limit(40)).catch(() => []),
        q(supabase.from('msgr_messages').select('id').eq('org_id', org.id).eq('author_user_id', uid).order('id', { ascending: false }).limit(200)).catch(() => []),
        q(supabase.from('msgr_crew_approvals').select('id, channel_id, crew_id, action, reason, created_at').eq('org_id', org.id).eq('status', 'pending').order('created_at', { ascending: false }).limit(40)).catch(() => []),
        dmIds.length ? q(supabase.from('msgr_messages').select(cols).in('channel_id', dmIds).is('deleted_at', null).or(`author_user_id.neq.${uid},author_user_id.is.null`).order('id', { ascending: false }).limit(40)).catch(() => []) : [],
      ]);
      const myIds = mine.map((m) => m.id);
      const replies = myIds.length ? await q(supabase.from('msgr_messages').select(cols).eq('org_id', org.id).eq('author_kind', 'crew').in('reply_to', myIds).is('deleted_at', null).order('id', { ascending: false }).limit(40)).catch(() => []) : [];
      if (dead) return;
      const item = (kind, m) => ({ kind, key: `${kind}:${m.id}`, channel_id: m.channel_id, at: m.created_at, who: m.author_kind === 'crew' ? m.crew_id : m.author_user_id, whoKind: m.author_kind === 'crew' ? 'crew' : 'user', text: m.body ?? '' });
      const list = [...ments.map((m) => item('mention', m)), ...replies.map((m) => item('reply', m)), ...dms.map((m) => item('dm', m)),
        ...friends.filter((f) => f.status === 'pending' && f.requested_by !== uid).map((f) => ({ kind: 'friend', key: `friend:${f.user_id}`, channel_id: null, at: f.created_at, who: f.user_id, whoKind: 'user', text: t('inbox.friend.text', { name: f.display_name || f.handle || '' }), friendName: f.display_name || f.handle })),
        ...aps.map((a) => ({ kind: 'approval', key: `approval:${a.id}`, channel_id: a.channel_id, at: a.created_at, who: a.crew_id, whoKind: 'crew', text: a.reason ? `${a.action} — ${a.reason}` : a.action }))];
      const seenKeys = new Set();
      setInbox(list.filter((it) => !seenKeys.has(it.key) && seenKeys.add(it.key)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 80));
    })();
    return () => { dead = true; };
  }, [org?.id, uid, tick, channels, friends]); // eslint-disable-line react-hooks/exhaustive-deps
  const inboxUnread = org ? inbox.filter((it) => Date.parse(it.at) > (inboxSeen[org.id] ?? 0)).length : 0;
  const openInbox = () => { if (!org) return; setInboxPrev(inboxSeen[org.id] ?? 0); const next = { ...inboxSeen, [org.id]: Date.now() }; setInboxSeen(next); writeInboxSeen(next); setPage('inbox'); setRail(false); };
  const me = members.find((m) => m.user_id === uid);
  const isAdmin = org && ['owner', 'admin'].includes(org.role);
  // F2-5 로컬 알림 — 앱이 숨겨졌거나 다른 채널을 보고 있을 때만. 본문은 싣지 않는다(방송 payload에도 본문이 없다 — RLS 통과 조회가 정본).
  const notifyRef = useRef({ channels, members, chId, uid, isAdmin, page, muted, quiet });
  notifyRef.current = { channels, members, chId, uid, isAdmin, page, muted, quiet };
  const osNotify = (title, body, tag) => { try { if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return; const n = new Notification(title, { body, tag }); n.onclick = () => { window.focus(); n.close(); }; } catch { /* 알림 불가 환경 */ } };
  const shouldNotify = (channelId) => { const r = notifyRef.current; if (r.muted.has(channelId) || inQuiet(r.quiet)) return false; return document.visibilityState === 'hidden' || r.page !== 'chat' || r.chId !== channelId; }; // 음소거 채널·조용한 시간엔 OS 알림 없음(P0 2026-09-09)
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
  const crewOf = (id) => crews.find((c) => c.id === id) ?? myAvailable.find((c) => c.id === id); // 파견 해제된 내 크루도 시트로 연다(다시 파견·허용 범위)
  const [newOrg, setNewOrg] = useState(null); // 인라인 폼 상태(문자열) — 네이티브 prompt 금지(QA: 사용성·룩 불일치)
  const [joinable, setJoinable] = useState([]); // J-3 도메인 자동 가입 후보
  const [railMenu, setRailMenu] = useState(null); const [railConfirm, setRailConfirm] = useState(null); // 레일 행 '…' 메뉴(채널 설정·나가기·보관, 1:1 나가기) — 유건 지적 2026-09-04
  useEffect(() => { if (!railMenu) return; const off = () => { setRailMenu(null); setRailConfirm(null); }; window.addEventListener('click', off); return () => window.removeEventListener('click', off); }, [railMenu]);
  const leaveChannel = async (c) => {
    setRailMenu(null); setRailConfirm(null);
    const mine = crews.filter((cr) => cr.owner_user_id === uid).map((cr) => cr.id);
    if (mine.length) { // 내 크루가 그 채널에 있으면 내가 빠지는 순간 크루가 조용히 죽는다(검수 HIGH-3) — 먼저 크루를 빼게 한다
      const stuck = await q(supabase.from('msgr_channel_members').select('member_id').eq('channel_id', c.id).eq('member_kind', 'crew').in('member_id', mine)).catch(() => null);
      if (!stuck) return setErr(t('ch.leave.checkFailed')); // 조회 실패면 통과가 아니라 중단(검수 LOW: fail-open)
      if (stuck.length) return setErr(t('ch.leave.blocked'));
    }
    const res = await supabase.from('msgr_channel_members').delete().eq('channel_id', c.id).eq('member_kind', 'user').eq('member_id', uid).select('member_id');
    if (res.error) return setErr(friendlyErr(res.error.message, t));
    if (!res.data?.length) return setErr(t('err.denied'));
    setNote(t(c.kind === 'dm' ? 'dm.leave.done' : 'ch.leave.done', { name: c.kind === 'dm' ? dmName(c) : c.name }));
    if (chId === c.id) setChId(null);
    await loadOrg(orgId).catch(() => {});
  };
  const archiveChannel = async (c) => {
    setRailMenu(null); setRailConfirm(null);
    const res = await supabase.from('msgr_channels').update({ archived_at: new Date().toISOString() }).eq('id', c.id).select('id');
    if (res.error) return setErr(friendlyErr(res.error.message, t));
    if (!res.data?.length) return setErr(t('ch.noEdit'));
    setNote(t('ch.archive.done', { name: c.name }));
    if (chId === c.id) setChId(null);
    await loadOrg(orgId).catch(() => {});
  };
  const [deletedOrgs, setDeletedOrgs] = useState([]); // J-5 삭제 예정(복구 가능) 조직
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
      const others = [{ kind, id }];
      if (kind === 'crew' && other && other.owner_user_id !== uid) others.push({ kind: 'user', id: other.owner_user_id }); // 크루 = 소유자 동반 규칙
      const cid = await q(supabase.rpc('msgr_create_channel', { org: orgId, kind: 'dm', name: `dm:${name}`, others })); // 나는 서버가 첫 멤버로 넣는다
      await loadOrg(orgId); setChId(cid); setPage('chat'); setRail(false); setSheet(null);
    } catch (e) { setErr(e.message); }
  };
  const createChannel = async ({ name, kind } = newCh ?? {}) => {
    if (!name?.trim()) return;
    const priv = kind === 'private';
    try {
      if (channels.some((c) => c.kind !== 'dm' && c.name.toLowerCase() === name.trim().toLowerCase())) return setErr(t('ch.dup')); // 검수 M-2: 이름이 기억 페이지 밖에서도 표시 키라 동명은 막는다
      const id = await q(supabase.rpc('msgr_create_channel', { org: orgId, kind: priv ? 'private' : 'public', name: name.trim() })); // 생성+첫 멤버를 서버가 한 번에(생성 직후 열람 예외 폐지 — 검수 HIGH)
      setNewCh(null); await loadOrg(orgId); setChId(id); setPage('chat');
    } catch (e) { setErr(/msgr_channel_limit/.test(e.message) ? t('ch.freeLimit') : friendlyErr(e.message, t)); }
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
  const dmName = (c) => { const ms = dmMembers[c.id] ?? []; const crew = ms.find((m) => m.member_kind === 'crew'); const other = ms.find((m) => m.member_kind === 'user' && m.member_id !== uid); const base = c.name.replace(/^dm:/, ''); const crewName = crew ? (crewOf(crew.member_id)?.display_name ?? base) : (crews.some((k) => k.display_name === base) ? base : null); // 해제 sweep으로 크루가 빠진 1:1도 크루명 유지(사람 1:1과 이름이 겹치던 실측 2026-09-09)
    return [crewName, other ? nameOfUser(other.member_id) : null].filter(Boolean).join(' · ') || base; };
  const dms = channels.filter((c) => c.kind === 'dm');
  const sortedCh = [...channels].filter((c) => c.kind !== 'dm').sort((a, b) => (a.kind === 'private') - (b.kind === 'private') || a.name.localeCompare(b.name)); // 공개 먼저·이름순 고정(선택한 채널을 위로 끌어올리면 목록이 뛴다)
  // '내 에이전트' = 세 출처 한 목록(유건 지시 2026-09-08): 아르고 에이전트 + 내가 연결한 헤르메스·오픈클로(봇). 출처 표시는 msgr_bots.kind.
  const sourceOf = (c) => c.hosting !== 'bot' ? 'argo' : (botKinds.find((b) => b.crew_id === c.id)?.kind ?? 'custom');
  const sortCrews = (list) => [...list].sort((a, b) => railSort === 'added' ? Date.parse(a.created_at ?? 0) - Date.parse(b.created_at ?? 0) : a.display_name.localeCompare(b.display_name, 'ko'));
  const myCrews = sortCrews(crews.filter((c) => c.owner_user_id === uid));
  // 행은 아바타·이름·상태점만(유건 지적 2026-09-09 "레일이 복잡"). 출처는 글자 대신 소속별 정렬일 때 소제목으로.
  const railRow = (c) => <button key={c.id} type="button" className="item" onClick={() => setSheet(c.id)} title={`${c.display_name} · ${t(`rail.src.${sourceOf(c)}`)}${c.role_text ? ` · ${c.role_text}` : ''}`}><Av name={c.display_name} crew size="xs" company={c.hosting === 'bot'} /><span className="name">{c.display_name}</span><span className={`msgr-dot${c.last_seen_at && Date.now() - Date.parse(c.last_seen_at) < AWAY_MS ? ' mark' : ''}`} /></button>;
  // 평평한 목록(유건 결정 2026-09-09). 외부 에이전트(헤르메스·오픈클로 봇)가 있을 때만 '외부' 소제목 하나로 아래에 구분한다.
  const railArgo = myCrews.filter((c) => sourceOf(c) === 'argo'); const railExt = myCrews.filter((c) => sourceOf(c) !== 'argo');
  return (
    <div className={`shell msgr-shell${rail ? ' rail-open' : ''}`}>
      {rail && <div className="msgr-scrim" onClick={() => setRail(false)} role="presentation" />}
      <aside className="side msgr-side">
        <div className="msgr-brand"><svg width="14" height="14" viewBox="0 0 16 16"><path d={STAR_D} /></svg>ARGO</div>
        <div className="msgr-orgwrap">
          <button type="button" className={`msgr-org${orgMenu ? ' open' : ''}`} onClick={() => setOrgMenu((v) => !v)} aria-haspopup="menu" aria-expanded={orgMenu} title={t('org.switch')}>
            <Av name={org?.name ?? '?'} /><span className="name">{org?.name ?? t('org.pick')}</span><I name="caret" size={14} className="caret" />
          </button>
          <form className="msgr-search" onSubmit={(e) => { e.preventDefault(); runSearch(searchQ); }}><I name="at" size={13} /><input ref={searchRef} value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder={t('search.ph')} aria-label={t('search.title')} />{searchQ && <button type="button" className="clear" onClick={() => { setSearchQ(''); setSearchRes(null); if (page === 'search') setPage('chat'); }} aria-label={t('ui.close')}><I name="x" size={12} /></button>}</form>
          {orgMenu && (<>
            <div className="msgr-scrim clear" onClick={() => setOrgMenu(false)} />
            <div className="msgr-menu-pop" role="menu">
              {orgs.map((o) => <button key={o.id} type="button" role="menuitemradio" aria-checked={o.id === orgId} className={o.id === orgId ? 'on' : ''} onClick={() => { setOrgId(o.id); setOrgMenu(false); }}><Av name={o.name} size="sm" /><span className="label">{o.name}</span><span className="msgr-klabel">{t(`role.${o.role}`)}</span></button>)}
              {joinable.map((o) => <button key={`j-${o.id}`} type="button" role="menuitem" className="join" onClick={() => { setOrgMenu(false); joinDomain(o); }}><Av name={o.name} size="sm" /><span className="label">{o.name}</span><span className="msgr-klabel">{t('org.join.cta')}</span></button>)}
              {deletedOrgs.map((o) => <button key={`d-${o.id}`} type="button" role="menuitem" className="join" onClick={() => { setOrgMenu(false); restoreOrg(o); }}><Av name={o.name} size="sm" /><span className="label">{o.name}</span><span className="msgr-klabel">{t('org.restore.cta', { days: Math.max(0, Math.ceil((Date.parse(o.purge_at) - Date.now()) / 86_400_000)) })}</span></button>)}
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
            {sortedCh.map((c) => { const canManage = isAdmin || c.created_by === uid || (c.admin_user_ids ?? []).includes(uid); const open = railMenu === c.id; return (
              <div key={c.id} className={`msgr-railrow${open ? ' open' : ''}`}>
                <button type="button" className={`item${c.id === chId ? ' active' : ''}${unread[c.id]?.n && !muted.has(c.id) ? ' unread' : ''}`} onClick={() => { setChId(c.id); setRail(false); setPage('chat'); }}>
                  <I name={c.kind === 'private' ? 'lock' : 'hash'} size={14} /><span className="name">{c.name}</span>{muted.has(c.id) && <I name="belloff" size={12} className="mi" />}{unread[c.id]?.n > 0 && <span className={`msgr-badge${unread[c.id].mention ? ' mark' : ''}${muted.has(c.id) ? ' dim' : ''}`}>{unread[c.id].n}</span>}
                </button>
                <button type="button" className="more" onClick={(e) => { e.stopPropagation(); setRailMenu(open ? null : c.id); setRailConfirm(null); }} title={t('ch.row.more')} aria-label={t('ch.row.more')} aria-expanded={open}><I name="dots" size={13} /></button>
                {open && (
                  <div className="msgr-rowmenu" role="menu" onClick={(e) => e.stopPropagation()}>
                    <button type="button" role="menuitem" onClick={() => { setRailMenu(null); setChId(c.id); setPage('chat'); setRail(false); setChSheet(true); }}><I name="gear" size={13} />{t('ch.menu.settings')}</button>
                    <button type="button" role="menuitem" onClick={() => { setRailMenu(null); toggleMute(c); }}><I name={muted.has(c.id) ? 'bell' : 'belloff'} size={13} />{t(muted.has(c.id) ? 'ch.unmute' : 'ch.mute')}</button>
                    {c.kind === 'private' && (railConfirm === `leave:${c.id}`
                      ? <button type="button" role="menuitem" className="danger confirm" onClick={() => leaveChannel(c)}><I name="out" size={13} /><span className="cf">{t('ch.leave.confirm')}<span className="note">{t('ch.leave.confirm.note')}</span></span></button>
                      : <button type="button" role="menuitem" onClick={() => setRailConfirm(`leave:${c.id}`)}><I name="out" size={13} />{t('ch.leave')}</button>)}
                    {canManage && (railConfirm === `archive:${c.id}`
                      ? <button type="button" role="menuitem" className="danger confirm" onClick={() => archiveChannel(c)}><I name="x" size={13} /><span className="cf">{t('ch.archive.confirm.short')}<span className="note">{t('ch.archive.confirm.note')}</span></span></button>
                      : <button type="button" role="menuitem" onClick={() => setRailConfirm(`archive:${c.id}`)}><I name="x" size={13} />{t('ch.archive')}</button>)}
                  </div>
                )}
              </div>
            ); })}
          </div>
        ) : <div className="msgr-hint">{orgId ? t('ch.empty') : t('org.none')}</div>}
        {dms.length > 0 && (<>
          <div className="msgr-group">{t('ch.dms')}</div>
          <div className="msgr-list">{dms.map((c) => { const open = railMenu === c.id; const withCrew = (dmMembers[c.id] ?? []).some((m) => m.member_kind === 'crew'); return (
            <div key={c.id} className={`msgr-railrow${open ? ' open' : ''}`}>
              <button type="button" className={`item${c.id === chId ? ' active' : ''}${unread[c.id]?.n && !muted.has(c.id) ? ' unread' : ''}`} onClick={() => { setChId(c.id); setRail(false); setPage('chat'); }}><Av name={dmName(c)} size="xs" crew={withCrew} /><span className="name">{dmName(c)}</span>{muted.has(c.id) && <I name="belloff" size={12} className="mi" />}{unread[c.id]?.n > 0 && <span className={`msgr-badge${muted.has(c.id) ? ' dim' : ' mark'}`}>{unread[c.id].n}</span>}</button>
              <button type="button" className="more" onClick={(e) => { e.stopPropagation(); setRailMenu(open ? null : c.id); setRailConfirm(null); }} title={t('ch.row.more')} aria-label={t('ch.row.more')} aria-expanded={open}><I name="dots" size={13} /></button>
              {open && (
                <div className="msgr-rowmenu" role="menu" onClick={(e) => e.stopPropagation()}>
                  <button type="button" role="menuitem" onClick={() => { setRailMenu(null); toggleMute(c); }}><I name={muted.has(c.id) ? 'bell' : 'belloff'} size={13} />{t(muted.has(c.id) ? 'ch.unmute' : 'ch.mute')}</button>
                  {railConfirm === `leave:${c.id}`
                    ? <button type="button" role="menuitem" className="danger confirm" onClick={() => leaveChannel(c)}><I name="out" size={13} /><span className="cf">{t('dm.leave.confirm')}<span className="note">{t('dm.leave.confirm.note')}</span></span></button>
                    : <button type="button" role="menuitem" onClick={() => setRailConfirm(`leave:${c.id}`)}><I name="out" size={13} />{t('dm.leave')}</button>}
                </div>
              )}
            </div>
          ); })}</div>
        </>)}
        {org && (myAvailable.length > 0 || myCrews.length > 0) && (<>
          <div className="msgr-group">{t('rail.mine')}<span className="right"><select className="msgr-sort" value={railSort} onChange={(e) => pickSort(e.target.value)} aria-label={t('rail.sort')} title={t('rail.sort')}>{['name', 'added'].map((v) => <option key={v} value={v}>{t(`rail.sort.${v}`)}</option>)}</select><span className="msgr-klabel">{myCrews.length}/{myCrews.length + myAvailable.length}</span></span></div>
          <div className="msgr-list mine">
            {railArgo.map(railRow)}
            {railExt.length > 0 && <div className="msgr-folder"><div className="msgr-folderhead"><span className="lbl">{t('rail.src.custom')}</span><span className="msgr-klabel">{railExt.length}</span></div>{railExt.map(railRow)}</div>}
            {myAvailable.map((c) => <button key={c.id} type="button" className="item dim" onClick={() => setSheet(c.id)} title={t('rail.mine.off')}><Av name={c.display_name} crew size="xs" /><span className="name">{c.display_name}</span><span className="msgr-klabel">{t('rail.mine.offShort')}</span></button>)}
          </div>
        </>)}
        </div>
        <div className="msgr-foot">
          <button type="button" className="me" onClick={() => setMeMenu((v) => !v)} aria-haspopup="menu" aria-expanded={meMenu} title={t('ui.me.menu')}>
            <Av name={me?.display_name || session.user.email} size="sm" /><span className="name">{me?.display_name || session.user.email}</span>
          </button>
          {meMenu && (<div className="msgr-rowmenu me" role="menu" onMouseLeave={() => setMeMenu(false)}>
            <button type="button" role="menuitem" onClick={() => { setMeMenu(false); setSettingsTab('me'); setPage('settings'); setRail(false); }}><I name="gear" size={13} />{t('set.tab.me')}</button>
            <button type="button" role="menuitem" className="danger" onClick={() => { setMeMenu(false); supabase.auth.signOut({ scope: 'local' }); }}><I name="out" size={13} />{t('auth.signOut')}</button>
          </div>)}
          {org && <button type="button" className={`btn ghost bell${page === 'inbox' ? ' on' : ''}`} onClick={() => page === 'inbox' ? setPage('chat') : openInbox()} title={t('inbox.title')} aria-label={t('inbox.title')}><I name="bell" size={15} />{inboxUnread > 0 && <span className="n">{inboxUnread > 99 ? '99+' : inboxUnread}</span>}</button>}
          {org && <button type="button" className={`btn ghost${page === 'activity' ? ' on' : ''}`} onClick={() => { setPage((p) => p === 'activity' ? 'chat' : 'activity'); setRail(false); }} title={t('act.title')} aria-label={t('act.title')}><I name="memory" size={15} /></button>}
          <button type="button" className={`btn ghost${page === 'settings' ? ' on' : ''}`} onClick={() => { setPage((p) => p === 'settings' ? 'chat' : 'settings'); setRail(false); }} title={t('ui.settings')} aria-label={t('ui.settings')} aria-pressed={page === 'settings'}><I name="gear" size={15} /></button>
        </div>
      </aside>
      <main className="msgr-main">
        {sheet && crewOf(sheet) && <CrewSheet crew={crewOf(sheet)} org={org} uid={uid} me={me} members={members} policy={policy} channelId={chId} nameOfUser={nameOfUser} onClose={() => setSheet(null)} onChanged={() => loadOrg(orgId).catch(() => {})} onPosted={() => setEvent({ kind: 'message', channel_id: chId, at: Date.now() })} onNote={setNote} onError={setErr} onDm={() => openDm('crew', sheet)} />}
        {chSheet && channel && <ChannelSheet myAvailable={myAvailable} onDispatch={dispatchCrew} channel={channel} org={org} uid={uid} isAdmin={isAdmin} policy={policy} members={members} crews={crews} chMembers={chMembers} people={chPeople} chCrews={chCrews} ent={ent} onInvite={isAdmin ? invite : null} onCrew={(id) => { setChSheet(false); setSheet(id); }} onDm={(id) => openDm('user', id)} nameOfUser={nameOfUser} initialAdd={chSheetAdd} onMention={(c) => { setChSheet(false); setChSheetAdd(null); setMentionReq(c); }} onClose={() => { setChSheet(false); setChSheetAdd(null); }} onChanged={async () => { await loadOrg(orgId).catch(() => {}); await loadChMembers(chId).catch(() => {}); }} onArchived={() => { setChSheet(false); setChId(null); loadOrg(orgId).catch(() => {}); }} onNote={setNote} onError={setErr} />}
        {orgLocked && <div className="msgr-notice locked"><span>{t(isAdmin ? 'org.locked.admin' : 'org.locked')}</span></div>}
        {(err || note) && (
          <div className="msgr-notice">
            <span style={{ color: err ? 'var(--danger)' : 'var(--fg-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{err ? `${t('ui.error')}: ${err}` : note}</span>
            <button type="button" className="btn sm" style={{ border: 0, width: 24, height: 24, padding: 0 }} onClick={() => { setErr(''); setNote(''); }} aria-label="×"><I name="x" size={12} /></button>
          </div>
        )}
        <PageBoundary key={`${page}:${chId ?? ''}`} title={t('ui.pageError')} retry={t('ui.pageError.retry')} onReset={() => setPage('chat')}>
        {page === 'activity' && org ? (
          <Activity org={org} uid={uid} isAdmin={!!isAdmin} channels={channels} members={members} crews={crews} nameOfUser={nameOfUser} onNote={setNote} onError={setErr} onBack={() => setPage('chat')} onMenu={() => setRail(true)} onOpenChannel={(id) => { setChId(id); setPage('chat'); }} />
        ) : page === 'search' && org ? (
          <SearchPage res={searchRes} channels={channels} members={members} crews={crews} nameOfUser={nameOfUser} dmName={dmName} onOpen={(id) => { setChId(id); setPage('chat'); }} onCrew={setSheet} onDm={(id) => openDm('user', id)} onBack={() => setPage('chat')} onMenu={() => setRail(true)} />
        ) : page === 'inbox' && org ? (
          <Inbox items={inbox} prevSeen={inboxPrev} channels={channels} crews={crews} nameOfUser={nameOfUser} dmName={dmName} onOpen={(id) => { if (!id) { setPage('settings'); setSettingsTab('friends'); return; } setChId(id); setPage('chat'); }} onBack={() => setPage('chat')} onMenu={() => setRail(true)} />
        ) : page === 'settings' ? (
          <Settings session={session} me={me} uid={uid} org={org} isAdmin={!!isAdmin} policy={policy} members={members} nameOfUser={nameOfUser} onOpenCrew={setSheet} friends={friends} onFriendsChanged={loadFriends} onDm={(id) => openDm('user', id)} initialTab={settingsTab} onTabUsed={() => setSettingsTab(null)} onChanged={() => loadOrg(orgId).catch((e) => setErr(e.message))} onOrgsChanged={() => loadOrgs().catch((e) => setErr(e.message))} onNote={setNote} onError={setErr} onBack={() => setPage('chat')} onMenu={() => setRail(true)} />
        ) : chId ? (
          <Channel key={chId} channel={channel} orgId={orgId} org={org} uid={uid} isAdmin={!!isAdmin} locked={orgLocked} policy={policy} members={members} crews={crews} people={chPeople} chCrews={chCrews} nameOfUser={nameOfUser} crewOf={crewOf} event={event} typing={typing} progress={progress} onRead={markRead} muted={muted.has(channel.id)} broadcast={(ev, payload) => rt.current?.send({ type: 'broadcast', event: ev, payload }).catch?.(() => {})} onError={setErr} onMenu={() => setRail(true)} onCrew={setSheet} onTitle={() => setChSheet(true)} onCrewAdd={() => { setChSheetAdd('crew'); setChSheet(true); }} mentionReq={mentionReq} onMentionDone={() => setMentionReq(null)} dmName={dmName} />
        ) : (
          <EmptyOrg org={org} onMenu={() => setRail(true)} createOrg={() => { setOrgMenu(true); setNewOrg(''); }} createChannel={openNewCh} invite={isAdmin ? invite : null} joinable={joinable} joinDomain={joinDomain} deletedOrgs={deletedOrgs} restoreOrg={restoreOrg} />
        )}
        </PageBoundary>
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
  // 파견·해제는 메신저에서(유건 지시 2026-09-08). 서버는 status만 본다: available = 지시·답글·채널 멤버 불가(20260907120000 게이트), active = 파견 중.
  const dispatched = crew.status !== 'available'; const [confirmRecall, setConfirmRecall] = useState(false);
  const setDispatch = async (next) => {
    setBusy(true); setConfirmRecall(false);
    const patch = next ? { status: 'active', allow: policy?.allow_default ?? 'owner', allow_users: [] } : { status: 'available' };
    const res = await supabase.from('msgr_crews').update(patch).eq('id', crew.id).select('id');
    setBusy(false);
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t('crew.allow.readonly', { name: nameOfUser(crew.owner_user_id) }));
    onNote(t(next ? 'crew.dispatch.done' : 'crew.recall.done', { name: crew.display_name })); onChanged();
  };
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
          <div><span className="msgr-klabel">{t('crew.owner')}</span><span><Av name={nameOfUser(crew.owner_user_id)} size="sm" /> {tier === 'company' && crew.hosting !== 'bot' ? t('crew.tier.company.owner', { org: org?.name ?? '' }) : nameOfUser(crew.owner_user_id)}</span></div>
          <div><span className="msgr-klabel">{t('tab.crew')}</span><span>{t(`crew.hosting.${crew.hosting === 'resident' ? 'resident' : crew.hosting === 'bot' ? 'bot' : 'local'}`)}</span></div>
          <div><span className="msgr-klabel">{t('crew.dispatch.state')}</span><span><span className={`msgr-dot${dispatched ? ' ok' : ''}`} /> {dispatched ? t('crew.status.active') : t('crew.status.available')}
            {owner && crew.hosting !== 'bot' && !confirmRecall && (dispatched
              ? <button type="button" className="btn sm ghost text" disabled={busy} onClick={() => setConfirmRecall(true)}>{t('crew.recall')}</button>
              : <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => setDispatch(true)}>{t('crew.dispatch')}</button>)}
          </span></div>
          {confirmRecall && <div className="confirm-row"><span className="confirm-inline"><span>{t('crew.recall.confirm')}</span><button type="button" className="btn btn-primary sm danger" disabled={busy} onClick={() => setDispatch(false)}>{t('crew.recall')}</button><button type="button" className="btn sm ghost text" onClick={() => setConfirmRecall(false)}>{t('ui.cancel')}</button></span></div>}
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
function ChannelSheet({ channel, org, uid, isAdmin, policy, members, crews, chMembers, people = [], chCrews = [], ent, myAvailable = [], onDispatch, onInvite, onCrew, onDm, onMention, initialAdd = null, nameOfUser, onClose, onChanged, onArchived, onNote, onError }) {
  const { t } = useT();
  const chAdmins = channel.admin_user_ids ?? [];
  const canEdit = isAdmin || channel.created_by === uid || chAdmins.includes(uid); // J-1: 채널 관리자도 설정·멤버 관리(최종은 RLS msgr_can_manage_channel)
  const canAssignAdmins = (isAdmin || channel.created_by === uid) && channel.kind !== 'dm'; // 지정은 조직 관리자·생성자만(자기 증식 방지 — 서버 트리거와 동일)
  const toggleChAdmin = async (userId) => { const next = chAdmins.includes(userId) ? chAdmins.filter((x) => x !== userId) : [...chAdmins, userId]; await upd({ admin_user_ids: next }, t('ch.admin.saved')); };
  const memLocked = !!policy?.crew_memory_locked; // H-0: 서버 트리거 msgr_channel_policy_gate가 최종
  const [name, setName] = useState(channel.name); const [topic, setTopic] = useState(channel.topic ?? ''); const [busy, setBusy] = useState(false); const [add, setAdd] = useState(initialAdd); // null | 'menu' | 'user' | 'crew' | 'guest' | 'newcrew' — '+ 추가' 하나로 모은다(UX 재구성)
  const [rowMenu, setRowMenu] = useState(null); const [more, setMore] = useState(false); // 행 '…' 메뉴 · '채널 설정' 접힘
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
    setBusy(false); setAdd(null);
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
  const addableUsers = members.filter((m) => !userIds.has(m.user_id) && m.user_id !== org?.service_user_id); // 회사 크루 서버(기계 계정)는 사람 후보가 아니다(실측: 첫 칩이 '회사 노드')
  const addableCrews = crews.filter((c) => !crewIds.has(c.id) && ((channel.personal_crews ?? 'allowed') !== 'blocked' || crewTier(c, org) === 'company')); // I-3: 차단 채널엔 회사 크루만 후보(안 될 버튼 노출 금지 — 최종은 서버 게이트)
  const scoped = channel.kind !== 'public';
  const nodeSet = !!org?.service_user_id; const nodeOn = nodeSet && !!org?.node_seen_at && Date.now() - Date.parse(org.node_seen_at) < AWAY_MS; // I-5·검수 M-4: 노드가 살아 있어야 만들 수 있다(죽은 노드면 영원한 '만드는 중')
  const crewCreate = policy?.crew_create ?? 'channel_admin';
  const myRole = members.find((m) => m.user_id === uid)?.role ?? 'member';
  const canCreateCrew = channel.kind !== 'dm' && nodeOn && myRole !== 'guest' && (isAdmin || crewCreate === 'member' || (crewCreate === 'channel_admin' && canEdit)); // 권한 행렬 — 최종은 RLS msgr_can_create_crew // 권한 행렬 — 최종은 RLS msgr_can_create_crew
  const [newCrew, setNewCrew] = useState(null); const [requests, setRequests] = useState([]); const doneSeen = useRef(null);
  const [guestDays, setGuestDays] = useState(30); // J-4: 비공개 채널 게스트 링크(채널 관리자도 발급 — 최종은 RLS)
  const guestInvite = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_invites').insert({ org_id: org.id, role: 'guest', channel_id: channel.id, guest_days: guestDays, created_by: uid }).select('code').single();
    setBusy(false);
    if (res.error) return onError(friendlyErr(res.error.message, t));
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
    if (res.error) return onError(friendlyErr(res.error.message, t));
    setNewCrew(null); setAdd(null); onNote(t('ch.crew.new.sent')); loadRequests().catch(() => {});
  };
  const canAddPeople = scoped && canEdit && channel.kind !== 'dm' && addableUsers.length > 0;
  const canDispatch = channel.kind !== 'dm' && myAvailable.length > 0 && (channel.personal_crews ?? 'allowed') !== 'blocked'; // 부록 M: 내 파견 전 크루 — 공개 채널은 파견만 하면 자동 참여, 비공개는 파견+멤버
  const canAddCrew = (scoped && canEdit && channel.kind !== 'dm' && addableCrews.length > 0) || canDispatch || (channel.kind === 'public' && chCrews.length > 0); // 공개 채널: 파견 크루 전원이 이미 참여 — '추가'는 @로 부르기
  const canGuest = channel.kind === 'private' && canEdit;
  const showNewCrewItem = channel.kind !== 'dm' && (canCreateCrew || (isAdmin && !nodeOn)); // 관리자에겐 서버가 없거나 죽어도 항목은 보이되 비활성+이유(안 될 버튼 노출 금지의 예외: 왜 안 되는지 알려줘야 하는 자리)
  const canAddAny = canAddPeople || canAddCrew || canGuest || showNewCrewItem;
  const personalLabel = (v) => t(`ch.personal.${v}`);
  const pendingReqs = requests.filter((r) => r.status !== 'done' || Date.now() - Date.parse(r.done_at ?? r.created_at) < 120_000);
  return (
    <div className="msgr-sheetwrap">
      <div className="msgr-scrim clear" onClick={onClose} />
      <aside className="msgr-crewsheet" role="dialog" aria-label={t('ch.sheet')} onClick={() => rowMenu && setRowMenu(null)}>
        <div className="head">
          <span className="msgr-av lg" style={{ borderRadius: 12 }}><I name={channel.kind === 'private' ? 'lock' : channel.kind === 'dm' ? 'at' : 'hash'} size={18} /></span>
          <div style={{ minWidth: 0 }}><div className="name">{channel.kind === 'dm' ? t('ch.kind.dm') : channel.name}</div><div className="msgr-klabel">{channel.kind === 'dm' ? t('ch.kind.dm') : channel.topic || t(`ch.kind.${channel.kind}`)}</div></div>
          <button type="button" className="btn ghost" onClick={onClose} aria-label={t('ui.close')}><I name="x" size={15} /></button>
        </div>
        {/* 1. 누가 있나 — 패널을 여는 이유가 먼저 */}
        <section>
          <div className="sec-head"><h3>{t('ch.who')}</h3><span className="sub">{t('ch.who.count', { p: people.length, c: chCrews.length })}</span></div>
          {!scoped && <p className="note">{t('ch.who.public')}</p>}
          <div className="msgr-rows">
            {people.map((m) => { const isMe = m.user_id === uid; const isCreator = channel.created_by === m.user_id; const isChAdmin = chAdmins.includes(m.user_id); const key = `u:${m.user_id}`; return (
              <div key={key} className="row">
                <Av name={m.display_name || m.user_id} size="sm" /><span className="name">{m.display_name || m.user_id.slice(0, 8)}</span><span className="sub">{t(`role.${m.role}`)}{isMe ? ` · ${t('ui.me')}` : ''}{(isChAdmin || isCreator) && <span className="msgr-tag">{isCreator ? t('ch.admin.creator') : t('ch.admin')}</span>}</span>
                {!isMe && (canAssignAdmins || scoped) && (
                  <span className="msgr-rowmenu-wrap" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="btn sm ghost" onClick={() => setRowMenu(rowMenu === key ? null : key)} title={t('ch.row.more')} aria-label={t('ch.row.more')} aria-expanded={rowMenu === key}><I name="dots" size={13} /></button>
                    {rowMenu === key && (
                      <div className="msgr-rowmenu" role="menu">
                        <button type="button" role="menuitem" onClick={() => { setRowMenu(null); onDm?.(m.user_id); }}><I name="at" size={13} />{t('ui.dm')}</button>
                        {canAssignAdmins && !isCreator && <button type="button" role="menuitem" disabled={busy} onClick={() => { setRowMenu(null); toggleChAdmin(m.user_id); }}><I name="gear" size={13} />{isChAdmin ? t('ch.admin.unset') : t('ch.admin.set')}</button>}
                        {scoped && canEdit && channel.kind !== 'dm' && <button type="button" role="menuitem" className="danger" disabled={busy} onClick={() => { setRowMenu(null); removeMember('user', m.user_id); }}><I name="x" size={13} />{t('ch.remove')}</button>}
                      </div>
                    )}
                  </span>
                )}
              </div>
            ); })}
            {chCrews.map((c) => { const on = c.last_seen_at && Date.now() - Date.parse(c.last_seen_at) < AWAY_MS; const company = crewTier(c, org) === 'company'; const key = `c:${c.id}`; return (
              <div key={key} className="row">
                <Av name={c.display_name} crew size="sm" company={company} /><span className="name">{c.display_name}</span>
                <span className="sub">{company ? t('crew.tier.company.sub', { org: org?.name ?? '', role: c.role_text ?? '' }) : t('crew.tier.personal.sub', { name: nameOfUser(c.owner_user_id), role: c.role_text ?? '' })}</span>
                <span className={`msgr-dot${on ? ' mark' : ''}`} title={on ? t('crew.online') : t('crew.away')} />
                <span className="msgr-rowmenu-wrap" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="btn sm ghost" onClick={() => setRowMenu(rowMenu === key ? null : key)} title={t('ch.row.more')} aria-label={t('ch.row.more')} aria-expanded={rowMenu === key}><I name="dots" size={13} /></button>
                  {rowMenu === key && (
                    <div className="msgr-rowmenu" role="menu">
                      <button type="button" role="menuitem" onClick={() => { setRowMenu(null); onCrew?.(c.id); }}><I name="star" size={13} />{t('ch.open.crew')}</button>
                      {scoped && canEdit && channel.kind !== 'dm' && <button type="button" role="menuitem" className="danger" disabled={busy} onClick={() => { setRowMenu(null); removeMember('crew', c.id); }}><I name="x" size={13} />{t('ch.remove')}</button>}
                    </div>
                  )}
                </span>
              </div>
            ); })}
            {!chCrews.length && <p className="empty">{scoped ? t('ch.crews.none.scoped') : t('ch.crews.none')}</p>}
          </div>
          {pendingReqs.map((r) => (
            <div key={r.id} className="row req"><span className="name">{r.name}</span><span className={`sub ${r.status}`}>{r.status === 'pending' ? (nodeOn ? t('ch.crew.new.pending') : t('ch.crew.new.pendingOff')) : r.status === 'failed' ? t('ch.crew.new.failed', { why: r.error ?? '' }) : t('ch.crew.new.done')}</span></div>
          ))}
          {canAddAny && (
            <div className="msgr-addwrap">
              {add === null && <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => setAdd('menu')}><I name="plus" size={13} />{t('ch.add')}</button>}
              {add === 'menu' && (
                <div className="msgr-addmenu" role="menu">
                  {canAddPeople && <button type="button" role="menuitem" onClick={() => setAdd('user')}><I name="plus" size={14} /><span><b>{t('ch.add.user')}</b><small>{t('ch.add.user.desc')}</small></span></button>}
                  {canAddCrew && <button type="button" role="menuitem" onClick={() => setAdd('crew')}><I name="star" size={14} /><span><b>{t('ch.add.crew')}</b><small>{t('ch.add.crew.desc')}</small></span></button>}
                  {canGuest && <button type="button" role="menuitem" onClick={() => setAdd('guest')}><I name="copy" size={14} /><span><b>{t('ch.add.guest')}</b><small>{t('ch.add.guest.desc')}</small></span></button>}
                  {showNewCrewItem && <button type="button" role="menuitem" disabled={!canCreateCrew} onClick={() => { setAdd('newcrew'); setNewCrew({ name: '', role: '', prompt: '', orgWide: false }); }}><I name="hash" size={14} /><span><b>{t('ch.add.newcrew')}</b><small>{canCreateCrew ? t('ch.add.newcrew.desc') : t(nodeSet ? 'ch.crew.new.nodeOff' : 'ch.crew.new.noNode')}</small></span></button>}
                  <button type="button" role="menuitem" className="cancel" onClick={() => setAdd(null)}>{t('ui.cancel')}</button>
                </div>
              )}
              {add === 'user' && (<>
                <div className="msgr-klabel">{t('ch.add.user')}</div>
                <div className="msgr-chips">{addableUsers.map((m) => <button key={m.user_id} type="button" className="msgr-chan" onClick={() => addMember('user', m.user_id)}><span>{m.display_name || m.user_id.slice(0, 8)}</span></button>)}</div>
                <p className="note">{t('ch.add.user.pool', { n: members.length, seats: ent?.seats ?? '?', plan: t(`plan.${ent?.plan ?? 'free'}`) })}{onInvite && <> <button type="button" className="btn sm" onClick={onInvite}><I name="copy" size={12} />{t('org.invite')}</button></>}</p>
                <div className="acts"><button type="button" className="btn sm" onClick={() => setAdd(null)}>{t('ui.cancel')}</button></div>
              </>)}
              {add === 'crew' && (<>
                {channel.kind === 'public' && chCrews.length > 0 && (<>
                  <div className="msgr-klabel">{t('ch.add.crew.public')}</div>
                  <div className="msgr-chips">{chCrews.map((c) => <button key={c.id} type="button" className="msgr-chan" onClick={() => onMention?.(c)} title={t('ch.add.crew.call')}><I name="at" size={13} /><span>{c.display_name}</span></button>)}</div>
                  <p className="note">{t('ch.add.crew.public.note')}</p>
                </>)}
                {channel.kind !== 'public' && addableCrews.length > 0 && <><div className="msgr-klabel">{t('ch.add.crew')}</div>
                <div className="msgr-chips">{addableCrews.map((c) => <button key={c.id} type="button" className="msgr-chan" onClick={() => addMember('crew', c.id)}><I name="star" size={13} /><span>{c.display_name}</span></button>)}</div></>}
                {channel.kind !== 'public' && !addableCrews.length && !myAvailable.length && <p className="note">{t('ch.add.crew.none')}</p>}
                {myAvailable.length > 0 && (channel.personal_crews ?? 'allowed') !== 'blocked' && (<>
                  <div className="msgr-klabel">{t('ch.add.mine')}</div>
                  <div className="msgr-chips">{myAvailable.map((c) => <button key={c.id} type="button" className="msgr-chan more" disabled={busy} onClick={async () => { setBusy(true); try { await onDispatch(c, channel.id); setAdd(null); onNote?.(t('ch.add.mine.done', { name: c.display_name })); } catch (e) { onError(e.message); } finally { setBusy(false); } }}><I name="plus" size={13} /><span>{c.display_name}</span></button>)}</div>
                  <p className="note">{t('ch.add.mine.note')}</p>
                </>)}
                <p className="note">{t('ch.add.crew.note')}</p>
                <div className="acts"><button type="button" className="btn sm" onClick={() => setAdd(null)}>{t('ui.cancel')}</button></div>
              </>)}
              {add === 'guest' && (
                <div className="msgr-inline">
                  <div className="msgr-klabel">{t('ch.add.guest')}</div>
                  <p className="note">{t('ch.add.guest.desc')}</p>
                  <div className="msgr-seg" role="radiogroup" aria-label={t('ch.guest.days')}>{[7, 30, 90].map((d) => <button key={d} type="button" role="radio" aria-checked={guestDays === d} className={guestDays === d ? 'active' : ''} onClick={() => setGuestDays(d)}>{t('ch.guest.day', { n: d })}</button>)}</div>
                  <div className="acts"><button type="button" className="btn btn-primary sm" disabled={busy} onClick={guestInvite}><I name="copy" size={13} />{t('ch.guest.link')}</button><button type="button" className="btn sm" onClick={() => setAdd(null)}>{t('ui.cancel')}</button></div>
                </div>
              )}
              {add === 'newcrew' && newCrew && (
                <form className="msgr-inline" onSubmit={(e) => { e.preventDefault(); submitCrew(); }}>
                  <div className="msgr-klabel">{t('ch.add.newcrew')}</div>
                  <input className="msgr-input" placeholder={t('ch.crew.new.name')} value={newCrew.name} onChange={(e) => setNewCrew({ ...newCrew, name: e.target.value })} autoFocus maxLength={40} />
                  <input className="msgr-input" placeholder={t('ch.crew.new.role')} value={newCrew.role} onChange={(e) => setNewCrew({ ...newCrew, role: e.target.value })} maxLength={60} />
                  <textarea className="msgr-input area" placeholder={t('ch.crew.new.prompt')} value={newCrew.prompt} onChange={(e) => setNewCrew({ ...newCrew, prompt: e.target.value })} maxLength={2000} rows={3} />
                  {isAdmin && <label className="switchrow"><input type="checkbox" checked={newCrew.orgWide} onChange={(e) => setNewCrew({ ...newCrew, orgWide: e.target.checked })} /><span>{t('ch.crew.new.orgWide')}</span></label>}
                  <div className="acts"><button type="submit" className="btn btn-primary sm" disabled={busy || !newCrew.name.trim() || !newCrew.prompt.trim()}><I name="check" size={13} />{t('ch.crew.new.submit')}</button><button type="button" className="btn sm" onClick={() => { setAdd(null); setNewCrew(null); }}>{t('ui.cancel')}</button></div>
                  <p className="note">{t('ch.crew.new.desc')}</p>
                </form>
              )}
            </div>
          )}
        </section>
        {/* 2. 채널 설정 — 접어 둔다(자주 안 만진다) */}
        <section className="msgr-fold">
          <button type="button" className="fold-head" onClick={() => setMore((v) => !v)} aria-expanded={more}><h3>{t('ch.settings')}</h3><I name="caret" size={14} className={more ? 'open' : ''} /></button>
          {more && (<>
            {channel.kind !== 'dm' && (<>
              <label className="field"><span className="msgr-klabel">{t('ch.name')}</span><input value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit || busy} /></label>
              <label className="field"><span className="msgr-klabel">{t('ch.topic')}</span><input value={topic} placeholder={t('ch.topic.ph')} onChange={(e) => setTopic(e.target.value)} disabled={!canEdit || busy} /></label>
              {canEdit ? <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || (name === channel.name && (topic || '') === (channel.topic || ''))} onClick={saveText}><I name="check" size={13} />{t('ui.save')}</button></div> : <p className="note">{t('ch.noEdit')}</p>}
            </>)}
            <label className="switchrow"><input type="checkbox" checked={channel.crew_memory !== false} disabled={!canEdit || busy || memLocked} onChange={(e) => upd({ crew_memory: e.target.checked })} /><span>{t('ch.memory.on')}</span></label>
            {memLocked && <p className="note">{t('ch.memory.locked')}</p>}
            {channel.kind !== 'dm' && (<>
              <div className="row wrap">
                <span className="msgr-klabel">{t('ch.personal')}</span>
                <div className="msgr-seg" role="radiogroup" aria-label={t('ch.personal')}>
                  {['allowed', 'read_only', 'blocked'].map((v) => <button key={v} type="button" role="radio" aria-checked={(channel.personal_crews ?? 'allowed') === v} className={(channel.personal_crews ?? 'allowed') === v ? 'active' : ''} disabled={!canEdit || busy} onClick={() => upd({ personal_crews: v }, t('ch.personal.saved'))}>{personalLabel(v)}</button>)}
                </div>
              </div>
              {(channel.personal_crews ?? 'allowed') === 'blocked' && <p className="note">{t('ch.personal.blocked.note')}</p>}
              {canEdit && (!confirmArchive
                ? <div className="row"><button type="button" className="btn sm" disabled={busy} onClick={() => setConfirmArchive(true)}><I name="x" size={13} />{t('ch.archive')}</button></div>
                : <div className="confirm"><p>{t('ch.archive.confirm')}</p><div className="row"><button type="button" className="btn btn-primary sm danger" disabled={busy} onClick={archive}><I name="x" size={13} />{t('ch.archive')}</button><button type="button" className="btn sm" onClick={() => setConfirmArchive(false)}>{t('ui.cancel')}</button></div></div>)}
            </>)}
          </>)}
        </section>
      </aside>
    </div>
  );
}

/* ─── 설정 페이지: 언어 · 테마(아르고와 같은 가족×모드) · 계정 ─── */
const FAMILIES = [['linen', 'settings.family.linen'], ['graphite', 'settings.family.graphite'], ['argo', 'settings.family.argo']];
const MODES = [['', 'set.mode.system'], ['-light', 'set.mode.light'], ['-dark', 'set.mode.dark']];
const FAMILY_CODES = FAMILIES.flatMap(([f]) => MODES.map(([s]) => `${f}${s}`));
/* ─── 화면 오류 경계 — 한 화면의 렌더 오류가 앱 전체를 빈 화면으로 만들지 않게(실측 2026-09-04: 설정 탭 ReferenceError로 전체 소실) ─── */
class PageBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { console.error('[msgr] page render error:', err); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="msgr-thread" style={{ display: 'flex' }}><div className="msgr-empty">
        <h1>{this.props.title}</h1>
        <p>{String(this.state.err?.message ?? this.state.err)}</p>
        <div className="row"><button type="button" className="btn btn-primary sm" onClick={() => { this.setState({ err: null }); this.props.onReset?.(); }}>{this.props.retry}</button></div>
      </div></div>
    );
  }
}

/* ─── 알림함 v1(클라이언트 집계) — 나를 부른 글·내 글의 크루 답글·대기 결재·DM 새 글. 읽음 기준은 이 기기. 서버 표(msgr_notifications)는 친구 요청과 함께 v2. ─── */
const INBOX_SEEN_KEY = 'argo-msgr-inbox-seen';
function readInboxSeen() { try { return JSON.parse(localStorage.getItem(INBOX_SEEN_KEY) || '{}') || {}; } catch { return {}; } }
function writeInboxSeen(v) { try { localStorage.setItem(INBOX_SEEN_KEY, JSON.stringify(v)); } catch {} }
/* ─── 프로필(계정 단위): 아이디·표시 이름·찾기 허용 스위치 — msgr_profiles(본인만 쓰기). 친구 찾기의 기준. ─── */
function ProfileCard({ uid, onNote, onError }) {
  const { t } = useT();
  const [p, setP] = useState(null); const [busy, setBusy] = useState(false); const [draft, setDraft] = useState({ handle: '', display_name: '', email_search: false, handle_search: true, accept_requests: true, quiet_from: null, quiet_to: null });
  useEffect(() => { q(supabase.from('msgr_profiles').select('*').eq('user_id', uid).maybeSingle()).then((row) => { setP(row ?? {}); if (row) setDraft({ handle: row.handle ?? '', display_name: row.display_name ?? '', email_search: !!row.email_search, handle_search: row.handle_search !== false, accept_requests: row.accept_requests !== false, quiet_from: row.quiet_from ?? null, quiet_to: row.quiet_to ?? null }); }).catch((e) => onError(e.message)); }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleOk = !draft.handle || /^[a-z0-9][a-z0-9_.]{2,23}$/.test(draft.handle);
  const save = async () => {
    if (!handleOk) return onError(t('profile.handle.bad'));
    setBusy(true);
    const res = await supabase.from('msgr_profiles').upsert({ user_id: uid, handle: draft.handle || null, display_name: draft.display_name.trim() || null, email_search: draft.email_search, handle_search: draft.handle_search, accept_requests: draft.accept_requests, quiet_from: draft.quiet_from, quiet_to: draft.quiet_to, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }).select('*').single();
    setBusy(false);
    if (res.error) return onError(/msgr_profiles_handle_key|duplicate/.test(res.error.message) ? t('profile.handle.taken') : res.error.message);
    setP(res.data); onNote(t('profile.saved'));
  };
  if (p === null) return null;
  return (
    <section className="msgr-setcard">
      <h2>{t('profile.title')}</h2><p>{t('profile.desc')}</p>
      <div className="row"><span className="msgr-klabel" style={{ width: 72 }}>{t('profile.handle')}</span><input className="msgr-input sm" value={draft.handle} onChange={(e) => setDraft({ ...draft, handle: e.target.value.toLowerCase() })} placeholder={t('profile.handle.ph')} maxLength={24} aria-invalid={!handleOk} /></div>
      <div className="row"><span className="msgr-klabel" style={{ width: 72 }}>{t('profile.name')}</span><input className="msgr-input sm" value={draft.display_name} onChange={(e) => setDraft({ ...draft, display_name: e.target.value })} placeholder={t('profile.name.ph')} maxLength={40} /></div>
      <div className="row"><label className="msgr-check"><input type="checkbox" checked={draft.email_search} onChange={(e) => setDraft({ ...draft, email_search: e.target.checked })} /> {t('profile.emailSearch')}</label></div>
      <div className="row"><label className="msgr-check"><input type="checkbox" checked={draft.handle_search} onChange={(e) => setDraft({ ...draft, handle_search: e.target.checked })} /> {t('profile.handleSearch')}</label></div>
      <div className="row"><label className="msgr-check"><input type="checkbox" checked={draft.accept_requests} onChange={(e) => setDraft({ ...draft, accept_requests: e.target.checked })} /> {t('profile.acceptRequests')}</label></div>
      <div className="row"><span className="msgr-klabel" style={{ width: 72 }}>{t('profile.quiet')}</span><label className="msgr-check"><input type="checkbox" checked={draft.quiet_from != null} onChange={(e) => setDraft({ ...draft, quiet_from: e.target.checked ? 22 : null, quiet_to: e.target.checked ? 7 : null })} /> {t('profile.quiet.on')}</label>
        {draft.quiet_from != null && <><select className="msgr-sort" value={draft.quiet_from} onChange={(e) => setDraft({ ...draft, quiet_from: +e.target.value })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{t('profile.quiet.hour', { h })}</option>)}</select><span className="msgr-klabel">~</span><select className="msgr-sort" value={draft.quiet_to ?? 7} onChange={(e) => setDraft({ ...draft, quiet_to: +e.target.value })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{t('profile.quiet.hour', { h })}</option>)}</select></>}
      </div>
      <p className="note">{t('profile.quiet.desc')}</p>
      <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !handleOk} onClick={save}>{t('ui.save')}</button>{!handleOk && <span className="note">{t('profile.handle.bad')}</span>}</div>
    </section>
  );
}

/* ─── 친구(디스코드·슬랙·텔레그램식): 이메일(정확 일치, 상대가 허용) 또는 아이디로 찾아 요청 → 수락. 판정은 전부 서버 RPC(msgr_find_user·msgr_friend_*). ─── */
function FriendsCard({ uid, friends, members, onChanged, onDm, onNote, onError }) {
  const { t, lang } = useT();
  const [qs, setQs] = useState(''); const [res, setRes] = useState(null); const [busy, setBusy] = useState(false);
  const find = async () => { const v = qs.trim(); if (v.length < 3) return setRes([]); setBusy(true); try { setRes(await q(supabase.rpc('msgr_find_user', { q: v }))); } catch (e) { onError(e.message); } finally { setBusy(false); } };
  const call = async (fn, args, ok) => { setBusy(true); try { await q(supabase.rpc(fn, args)); onNote(ok); await onChanged?.(); if (res) await find(); } catch (e) { onError(/msgr_friend_closed/.test(e.message) ? t('friends.err.closed') : /msgr_friend_blocked/.test(e.message) ? t('friends.err.blocked') : e.message); } finally { setBusy(false); } };
  const received = friends.filter((f) => f.status === 'pending' && f.requested_by !== uid);
  const sent = friends.filter((f) => f.status === 'pending' && f.requested_by === uid);
  const accepted = friends.filter((f) => f.status === 'accepted');
  const nameOf = (f) => members.find((m) => m.user_id === f.user_id)?.display_name || f.display_name || f.handle || f.user_id.slice(0, 8); // 같은 조직이면 조직 이름 우선(프로필 미설정 시 이메일 앞부분 대신)
  return (
    <section className="msgr-setcard">
      <h2>{t('friends.title')} · {accepted.length}</h2><p>{t('friends.desc')}</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); find(); }}><input className="msgr-input sm" value={qs} onChange={(e) => setQs(e.target.value)} placeholder={t('friends.find.ph')} /><button type="submit" className="btn sm" disabled={busy || qs.trim().length < 3}>{t('friends.find')}</button></form>
      {res && (<div className="msgr-rows">
        {!res.length && <p className="empty">{t('friends.find.none')}</p>}
        {res.map((r) => <div key={r.user_id} className="row"><Av name={r.display_name || r.handle || '?'} size="sm" /><span className="name">{r.display_name || r.handle}</span><span className="sub">{r.handle ? `@${r.handle}` : ''}</span>
          {r.relation === 'none' && <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => call('msgr_friend_request', { target: r.user_id }, t('friends.sent'))}>{t('friends.request')}</button>}
          {r.relation === 'sent' && <span className="msgr-klabel">{t('friends.state.sent')}</span>}
          {r.relation === 'received' && <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => call('msgr_friend_decide', { other: r.user_id, accept: true }, t('friends.accepted'))}>{t('friends.accept')}</button>}
          {r.relation === 'friend' && <span className="msgr-klabel">{t('friends.state.friend')}</span>}
        </div>)}
      </div>)}
      {received.length > 0 && (<><h3>{t('friends.received')} · {received.length}</h3><div className="msgr-rows">{received.map((f) => <div key={f.user_id} className="row"><Av name={nameOf(f)} size="sm" /><span className="name">{nameOf(f)}</span><span className="sub">{fmtWhen(f.created_at, lang)}</span>
        <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => call('msgr_friend_decide', { other: f.user_id, accept: true }, t('friends.accepted'))}>{t('friends.accept')}</button>
        <button type="button" className="btn sm ghost text" disabled={busy} onClick={() => call('msgr_friend_decide', { other: f.user_id, accept: false }, t('friends.declined'))}>{t('friends.decline')}</button></div>)}</div></>)}
      {sent.length > 0 && (<><h3>{t('friends.sent.h')} · {sent.length}</h3><div className="msgr-rows">{sent.map((f) => <div key={f.user_id} className="row"><Av name={nameOf(f)} size="sm" /><span className="name">{nameOf(f)}</span><span className="sub">{t('friends.state.sent')}</span><button type="button" className="btn sm ghost" disabled={busy} onClick={() => call('msgr_friend_remove', { other: f.user_id, block: false }, t('friends.removed'))} title={t('friends.cancel')} aria-label={t('friends.cancel')}><I name="x" size={13} /></button></div>)}</div></>)}
      <h3>{t('friends.list')}</h3>
      <div className="msgr-rows">
        {!accepted.length && <p className="empty">{t('friends.none')}</p>}
        {accepted.map((f) => { const inOrg = members.some((m) => m.user_id === f.user_id); return (
          <div key={f.user_id} className="row"><Av name={nameOf(f)} size="sm" /><span className="name">{nameOf(f)}</span><span className="sub">{f.handle ? `@${f.handle} · ` : ''}{inOrg ? t('rail.friends.here') : t('friends.notHere')}</span>
            {inOrg ? <button type="button" className="btn sm" onClick={() => onDm?.(f.user_id)}><I name="at" size={13} />{t('ui.dm')}</button> : <span className="msgr-klabel">{t('friends.inviteHint')}</span>}
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => call('msgr_friend_remove', { other: f.user_id, block: false }, t('friends.removed'))} title={t('friends.remove')} aria-label={t('friends.remove')}><I name="x" size={13} /></button>
          </div>); })}
      </div>
    </section>
  );
}

/* ─── 검색 결과 페이지 — 메시지(본문 부분 일치, 이 조직·읽을 수 있는 채널만)·사람·에이전트·채널. 전문 검색(tsvector)은 규모가 커지면 v2. ─── */
function SearchPage({ res, channels, crews, nameOfUser, dmName, onOpen, onCrew, onDm, onBack, onMenu }) {
  const { t, lang } = useT();
  const chName = (id) => { const c = channels.find((x) => x.id === id); return !c ? '' : c.kind === 'dm' ? dmName(c) : `#${c.name}`; };
  const who = (m) => m.author_kind === 'crew' ? (crews.find((c) => c.id === m.crew_id)?.display_name ?? t('org.crews')) : nameOfUser(m.author_user_id);
  const mark = (text) => { if (!res?.q) return text; const i = text.toLowerCase().indexOf(res.q.toLowerCase()); if (i < 0) return text.slice(0, 160); const s = Math.max(0, i - 40); return <>{s > 0 ? '…' : ''}{text.slice(s, i)}<mark>{text.slice(i, i + res.q.length)}</mark>{text.slice(i + res.q.length, i + res.q.length + 120)}</>; };
  const total = res ? res.msgs.length + res.people.length + res.agents.length + res.channels.length : 0;
  return (<>
    <div className="msgr-top">
      <button type="button" className="msgr-menu" onClick={onMenu} aria-label={t('ui.menu')}><I name="menu" /></button>
      <span className="title"><I name="at" size={18} />{t('search.title')}{res && <span className="msgr-klabel">“{res.q}” · {t('search.count', { n: total })}</span>}</span>
      <button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button>
    </div>
    <div className="msgr-thread page"><div className="msgr-inbox msgr-searchres">
      {!res && <p className="empty">{t('search.hint')}</p>}
      {res && !total && <p className="empty">{t('search.none')}</p>}
      {res?.channels.length > 0 && <><div className="msgr-klabel">{t('search.channels')}</div><div className="msgr-chips">{res.channels.map((c) => <button key={c.id} type="button" className="msgr-chan" onClick={() => onOpen(c.id)}><I name={c.kind === 'private' ? 'lock' : 'hash'} size={13} /><span>{c.name}</span></button>)}</div></>}
      {res?.people.length > 0 && <><div className="msgr-klabel">{t('search.people')}</div><div className="msgr-chips">{res.people.map((m) => <button key={m.user_id} type="button" className="msgr-chan" onClick={() => onDm(m.user_id)}><span>{m.display_name || m.user_id.slice(0, 8)}</span></button>)}</div></>}
      {res?.agents.length > 0 && <><div className="msgr-klabel">{t('search.agents')}</div><div className="msgr-chips">{res.agents.map((c) => <button key={c.id} type="button" className="msgr-chan" onClick={() => onCrew(c.id)}><I name="star" size={13} /><span>{c.display_name}</span></button>)}</div></>}
      {res?.msgs.length > 0 && <div className="msgr-klabel">{t('search.messages')} · {res.msgs.length}</div>}
      {res?.msgs.map((m) => (
        <button key={m.id} type="button" className="msgr-inboxrow" onClick={() => onOpen(m.channel_id)}>
          <Av name={who(m)} crew={m.author_kind === 'crew'} size="sm" />
          <span className="body"><span className="line1"><b>{who(m)}</b><span className="msgr-klabel">{chName(m.channel_id)} · {fmtWhen(m.created_at, lang)}</span></span><span className="text">{mark(m.body ?? '')}</span></span>
        </button>
      ))}
    </div></div>
  </>);
}

function Inbox({ items, prevSeen = 0, channels, crews, nameOfUser, dmName, onOpen, onBack, onMenu }) {
  const { t, lang } = useT();
  const [kind, setKind] = useState('all');
  const chName = (id) => { const c = channels.find((x) => x.id === id); return !c ? '' : c.kind === 'dm' ? dmName(c) : `#${c.name}`; };
  const who = (it) => it.whoKind === 'crew' ? (crews.find((c) => c.id === it.who)?.display_name ?? t('org.crews')) : nameOfUser(it.who);
  const shown = items.filter((it) => kind === 'all' || it.kind === kind);
  return (<>
    <div className="msgr-top">
      <button type="button" className="msgr-menu" onClick={onMenu} aria-label={t('ui.menu')}><I name="menu" /></button>
      <span className="title"><I name="bell" size={18} />{t('inbox.title')}</span>
      <button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button>
    </div>
    <div className="msgr-thread page"><div className="msgr-inbox">
      <div className="msgr-seg" role="tablist">{['all', 'mention', 'reply', 'approval', 'dm'].map((k) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>{t(`inbox.kind.${k}`)}{k !== 'all' && items.some((it) => it.kind === k) && <span className="n">{items.filter((it) => it.kind === k).length}</span>}</button>)}</div>
      {!shown.length && <p className="empty">{t('inbox.empty')}</p>}
      {shown.map((it) => (
        <button key={it.key} type="button" className={`msgr-inboxrow${Date.parse(it.at) > prevSeen ? ' new' : ''}`} onClick={() => onOpen(it.channel_id)}>
          <Av name={who(it)} crew={it.whoKind === 'crew'} size="sm" />
          <span className="body"><span className="line1"><b>{who(it)}</b><span className="msgr-klabel">{t(`inbox.kind.${it.kind}`)} · {chName(it.channel_id)} · {fmtWhen(it.at, lang)}</span></span><span className="text">{it.text.slice(0, 160)}</span></span>
        </button>
      ))}
      <p className="note">{t('inbox.note')}</p>
    </div></div>
  </>);
}

function Settings({ session, me, uid, org, isAdmin, policy, members = [], nameOfUser, onOpenCrew, friends = [], onFriendsChanged, onDm, initialTab = null, onTabUsed, onChanged, onOrgsChanged, onNote, onError, onBack, onMenu }) {
  const { t, ta, lang, setLang } = useT();
  const { theme, setTheme } = useTheme();
  const family = FAMILIES.map(([f]) => f).find((f) => theme === f || theme.startsWith(`${f}-`)) ?? null;
  const mode = family ? theme.slice(family.length) : null;
  const skins = THEMES.filter((c) => !FAMILY_CODES.includes(c));
  const tabs = [org && ['members', 'set.tab.members'], org && ['org', 'set.tab.org'], org && ['crews', 'set.tab.crews'], ['friends', 'set.tab.friends'], ['me', 'set.tab.me']].filter(Boolean); // 친구는 설정의 별도 분류(유건 지시 2026-09-09) // 기록은 활동 페이지(트리+그래프)로 — 유건 지시 2026-09-04 // UX 2/3: 세로 3천px 카드 더미 대신 탭 — 자주 쓰는 멤버가 첫 화면
  const [tab, setTab] = useState(org ? 'members' : 'me');
  useEffect(() => { if (initialTab) { setTab(initialTab); onTabUsed?.(); } }, [initialTab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!tabs.some(([k]) => k === tab)) setTab(tabs[0][0]); }, [org?.id, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps
  return (<>
    <div className="msgr-top">
      <button type="button" className="msgr-menu" onClick={onMenu} aria-label={t('ui.menu')}><I name="menu" /></button>
      <span className="title"><I name="gear" size={18} />{t('ui.settings')}</span>
      <button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button>
    </div>
    <div className="msgr-thread page"><div className="msgr-settings tabs">
      <nav className="msgr-setnav" aria-label={t('ui.settings')}>
        {tabs.map(([k, label]) => <button key={k} type="button" className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{t(label)}</button>)}
      </nav>
      <div className="msgr-setbody">
        {tab === 'members' && org && (isAdmin
          ? <OrgCard part="members" org={org} uid={uid} members={members} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} />
          : <section className="msgr-setcard"><h2>{t('org.members')} · {members.length}</h2><div className="msgr-rows">{members.map((m) => <div key={m.user_id} className="row"><Av name={m.display_name || m.user_id} size="sm" /><span className="name">{m.display_name || m.user_id.slice(0, 8)}</span><span className="sub">{m.user_id === org.service_user_id ? t('org.node') : t(`role.${m.role}`)}{m.user_id === uid ? ` · ${t('ui.me')}` : ''}</span></div>)}</div></section>)}
        {tab === 'org' && org && (isAdmin
          ? <OrgCard part="org" org={org} uid={uid} members={members} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} myEmail={session.user.email} />
          : <section className="msgr-setcard"><h2>{t('set.org')}</h2><p>{t('org.noEdit')}</p></section>)}
        {tab === 'crews' && org && (<>
          {isAdmin && <OrgCard part="node" org={org} uid={uid} members={members} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} />}
          {isAdmin && <OrgCard part="agents" org={org} uid={uid} members={members} nameOfUser={nameOfUser} onChanged={onChanged} onOrgsChanged={onOrgsChanged} onNote={onNote} onError={onError} onOpenCrew={onOpenCrew} />}
          {policy && <PolicyCard org={org} isAdmin={isAdmin} policy={policy} members={members} onChanged={onChanged} onNote={onNote} onError={onError} />}
        </>)}
        {tab === 'friends' && <FriendsCard uid={uid} friends={friends} members={members} onChanged={onFriendsChanged} onDm={onDm} onNote={onNote} onError={onError} />}
        {tab === 'me' && (<>
          <section className="msgr-setcard">
            <h2>{t('set.account')}</h2><p>{t('set.account.desc')}</p>
            <div className="row"><Av name={me?.display_name || session.user.email} /><span style={{ fontWeight: 600 }}>{me?.display_name || '—'}</span><span className="msgr-klabel">{session.user.email}</span></div>
            {org && me && <DisplayNameRow org={org} me={me} onChanged={onChanged} onNote={onNote} onError={onError} />}
            <div className="row"><NotifyRow /><button type="button" className="btn sm" onClick={() => supabase.auth.signOut({ scope: 'local' })}><I name="out" size={13} />{t('auth.signOut')}</button></div>
          </section>
          <ProfileCard uid={uid} onNote={onNote} onError={onError} />
          <section className="msgr-setcard">
            <h2>{t('set.lang')}</h2>
            <div className="msgr-seg" role="radiogroup" aria-label={t('set.lang')}>
              {[['ko', '한국어'], ['en', 'English']].map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={lang === v} className={lang === v ? 'active' : ''} onClick={() => setLang(v)}>{l}</button>)}
            </div>
          </section>
          <section className="msgr-setcard">
            <h2>{t('set.theme')}</h2>
            <div className="row">
              <span className="msgr-klabel">{t('set.family')}</span>
              <div className="msgr-seg" role="radiogroup" aria-label={t('set.family')}>
                {FAMILIES.map(([f, label]) => <button key={f} type="button" role="radio" aria-checked={family === f} className={family === f ? 'active' : ''} onClick={() => setTheme(`${f}${mode ?? ''}`)}>{ta(label)}</button>)}
              </div>
            </div>
            <div className="row">
              <span className="msgr-klabel">{t('set.mode')}</span>
              <div className="msgr-seg" role="radiogroup" aria-label={t('set.mode')}>
                {MODES.map(([sfx, label]) => <button key={sfx} type="button" role="radio" aria-checked={family != null && mode === sfx} className={family != null && mode === sfx ? 'active' : ''} onClick={() => setTheme(`${family ?? 'linen'}${sfx}`)}>{t(label)}</button>)}
              </div>
            </div>
            <div className="row">
              <span className="msgr-klabel">{t('set.skins')}</span>
              <div className="msgr-chips">{skins.map((c) => <button key={c} type="button" className={`msgr-chan${theme === c ? ' active' : ''}`} onClick={() => setTheme(c)} title={ta(`settings.theme.${c}`)}><span>{ta(`settings.theme.${c}`).split(' — ')[0]}</span></button>)}</div>
            </div>
          </section>
        </>)}
      </div>
    </div></div>
  </>);
}


/* ─── 활동 페이지(유건 지시 2026-09-04): 아르고 "기억"처럼 — 왼쪽은 조직 → 채널 → 사람·크루·문서 트리, 오른쪽은 같은 룩의 관계 그래프,
   고른 대상의 활동은 문장으로("유건이 민수를 관리자로 바꿈"). 정본은 서버 감사 로그(msgr_audit_log) — 화면은 이름으로 치환만 한다. ─── */
const docRelOf = (d) => `docs/${d.path.replace(/\.md$/, '')}`; // 문서 → 그래프·탭 id(한 곳)

/* 기억 문서 보기·편집(대상 탭) — 조직 문서 = 조직의 기억(부록 G). 편집권 최종 판정은 RLS(전사=관리자·채널=쓰기 가능 멤버) */
function MemDoc({ doc, isAdmin, nameOfUser, chName, onSaved, onNote, onError }) {
  const { t, lang } = useT();
  const [edit, setEdit] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => { setEdit(null); }, [doc.id]);
  const canEdit = (d) => d.channel_id ? true : isAdmin;
  const save = async () => {
    setBusy(true);
    const res = await supabase.from('msgr_org_docs').update({ title: edit.title.trim(), body: edit.body }).eq('id', doc.id).select('id');
    setBusy(false);
    if (res.error) return onError(friendlyErr(res.error.message, t));
    if (!res.data?.length) return onError(t('docs.noEdit'));
    onNote(t('docs.saved')); setEdit(null); await onSaved();
  };
  return (
    <article className="msgr-memdoc">
      <header>
        <span className="msgr-klabel">{doc.channel_id ? `#${chName(doc.channel_id)} · ${doc.path}` : doc.path}</span>
        {edit ? <input className="msgr-input" value={edit.title} onChange={(e) => setEdit((x) => ({ ...x, title: e.target.value }))} /> : <h2>{doc.title}</h2>}
        <div className="meta">{t('docs.meta', { v: doc.version, name: nameOfUser(doc.updated_by), when: fmtTs(doc.updated_at, lang) })}
          {!edit && canEdit(doc) && <button type="button" className="btn sm" onClick={() => setEdit({ title: doc.title, body: doc.body ?? '' })}>{t('docs.edit')}</button>}
          {!edit && !canEdit(doc) && <span className="note">{t('docs.adminOnly')}</span>}
        </div>
      </header>
      {edit ? (<>
        <textarea className="msgr-input body" value={edit.body} onChange={(e) => setEdit((x) => ({ ...x, body: e.target.value }))} rows={16} />
        <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !edit.title.trim()} onClick={save}><I name="check" size={13} />{t('ui.save')}</button><button type="button" className="btn sm" disabled={busy} onClick={() => setEdit(null)}>{t('ui.cancel')}</button></div>
      </>) : (doc.body ? <div className="msgr-sheet"><Markdown text={doc.body} /></div> : <p className="empty">{t('docs.blank')}</p>)}
    </article>
  );
}
/* 새 기억 — 범위(전사/채널)는 열린 탭이 정한다. 종류(규칙집·용어집·프로젝트)만 고른다 */
function MemNew({ org, channelId, uid, onCreated, onNote, onError, onCancel }) {
  const { t } = useT();
  const [creating, setCreating] = useState({ folder: channelId ? 'projects' : 'rules', title: '' }); const [busy, setBusy] = useState(false);
  const create = async () => {
    const title = creating.title.trim(); if (!title) return;
    setBusy(true);
    const res = await supabase.from('msgr_org_docs').insert({ org_id: org.id, channel_id: channelId ?? null, path: `${creating.folder}/${docSlug(title)}.md`, title, body: '', created_by: uid, updated_by: uid }).select('id, path').single();
    setBusy(false);
    if (res.error) return onError(/duplicate key|msgr_org_docs_path/.test(res.error.message) ? t('docs.dup') : friendlyErr(res.error.message, t));
    onNote(t('docs.created')); await onCreated(res.data);
  };
  return (
    <div className="msgr-memnew">
      <div className="row"><span className="msgr-klabel">{t('docs.folder')}</span>
        <div className="msgr-seg" role="radiogroup" aria-label={t('docs.folder')}>{DOC_FOLDERS.map((f) => <button key={f} type="button" role="radio" aria-checked={creating.folder === f} className={creating.folder === f ? 'active' : ''} onClick={() => setCreating((c) => ({ ...c, folder: f }))}>{t(`docs.folder.${f}`)}</button>)}</div></div>
      <input className="msgr-input" placeholder={t('docs.new.placeholder')} value={creating.title} onChange={(e) => setCreating((c) => ({ ...c, title: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} autoFocus />
      <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !creating.title.trim()} onClick={create}><I name="check" size={13} />{t('docs.create')}</button><button type="button" className="btn sm" onClick={onCancel}>{t('ui.cancel')}</button></div>
    </div>
  );
}

/* 활동 트리 행 — Activity 밖 모듈 수준(안에서 정의하면 렌더마다 새 컴포넌트 타입이라 클릭마다 트리가 리마운트된다, 유건 제보 2026-09-04) */
function ActRow({ c, id, label, sub, depth = 0, kids = null, icon = null }) {
  const { openIds, toggle, sel, active, openTab } = c; const has = !!kids; const open = openIds.has(id);
  return (
    <div>
      <button type="button" className={`row${sel === id && active !== 'graph' ? ' active' : ''}`} style={{ paddingLeft: 6 + depth * 12 }} onClick={() => { if (['channels', 'people', 'crews', 'docs'].includes(id)) { toggle(id); return; } openTab(id); if (has && !open) toggle(id); }} onDoubleClick={() => has && toggle(id)}>
        {has ? <span className="caret" style={{ transform: open ? 'rotate(90deg)' : 'none' }} onClick={(e) => { e.stopPropagation(); toggle(id); }}>▸</span> : <span className="caret" />}
        {icon && <I name={icon} size={12} />}
        <span className="lbl">{label}</span>{sub != null && <span className="cnt">{sub}</span>}
      </button>
      {has && open && <div className="tree-kids">{kids}</div>}
    </div>
  );
}

function Activity({ org, uid, isAdmin, channels, members, crews, nameOfUser, onNote, onError, onBack, onMenu, onOpenChannel }) {
  const { t, lang } = useT();
  const [rows, setRows] = useState(null); const [docs, setDocs] = useState([]); const [cm, setCm] = useState([]);
  // 창(pane)·탭 — 아르고 기억 페이지와 같은 모양: 그래프 노드를 누르면 옆 창(새 창)에 열리고, 트리는 포커스 창에 연다(유건 지시 2026-09-04). 전이는 panes.mjs(순수)
  const [st, setSt] = useState(() => ({ panes: [{ id: 1, tabs: [GRAPH_TAB, { id: 'org', kind: 'entity', rel: 'org' }], active: 'graph' }], focus: 1 }));
  const { panes, focus: focusPane } = st;
  const [limits, setLimits] = useState({}); const limitOf = (rel) => limits[rel] ?? 60;
  const [openIds, setOpenIds] = useState(() => new Set(['org', 'channels']));
  const [tabMenu, setTabMenu] = useState(null); // { paneId, id, x, y } — 탭 우클릭 메뉴
  useEffect(() => { for (const el of document.querySelectorAll('.msgr-actpane .vault-tab.active')) el.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }, [panes]);
  const focusP = panes.find((p) => p.id === focusPane) ?? panes[0];
  const focusTab = focusP.tabs.find((x) => x.id === focusP.active) ?? focusP.tabs[0];
  const sel = focusTab?.kind === 'entity' ? focusTab.rel : 'org';
  const openTab = (tab, opts) => setSt((s) => Panes.openTab(s.panes, s.focus, tab, opts));
  const openEntity = (rel, opts) => openTab({ id: rel, kind: 'entity', rel }, opts);
  const relOfDoc = (docRel) => { const id = docRel.replace(/\.md$/, ''); return id.startsWith('org/') ? 'org' : id; };
  const closeTab = (paneId, tabId) => setSt((s) => Panes.closeTab(s.panes, s.focus, paneId, tabId));
  const closeOthers = (paneId, id) => setSt((s) => Panes.closeOthers(s.panes, s.focus, paneId, id));
  const closeRight = (paneId, id) => setSt((s) => Panes.closeRight(s.panes, s.focus, paneId, id));
  const closeAll = (paneId) => setSt((s) => Panes.closeAll(s.panes, s.focus, paneId));
  const setFocusPane = (paneId) => setSt((s) => (s.focus === paneId ? s : { ...s, focus: paneId }));
  const activateTab = (paneId, tabId) => setSt((s) => Panes.setActive(s.panes, s.focus, paneId, tabId));
  const chKey = channels.map((c) => c.id).join(',');
  const load = useCallback(async () => {
    const [a, d, m] = await Promise.all([
      q(supabase.from('msgr_audit_log').select('id, actor_user_id, actor_crew_id, action, target_kind, target_id, meta, at').eq('org_id', org.id).order('at', { ascending: false }).limit(400)).catch(() => []), // 감사 열람은 관리자(RLS) — 멤버는 빈 목록
      q(supabase.from('msgr_org_docs').select('id, channel_id, path, title, body, version, updated_by, updated_at').eq('org_id', org.id).order('path').limit(400)).catch(() => []), // 본문까지 — 문서 탭·[[링크]] 그래프
      channels.length ? q(supabase.from('msgr_channel_members').select('channel_id, member_kind, member_id').in('channel_id', channels.map((c) => c.id))).catch(() => []) : [],
    ]);
    setRows(a); setDocs(d); setCm(m);
  }, [org.id, chKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load().catch((e) => onError(e.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const [creating, setCreating] = useState(null); // 새 기억 폼이 열린 대상(rel)
  const chName = (id) => channels.find((c) => c.id === id)?.name ?? t('act.deletedChannel');
  const crewName = (id) => crews.find((c) => c.id === id)?.display_name ?? t('act.deletedCrew');
  const docTitle = (id) => docs.find((d) => d.id === id)?.title ?? null;
  const roleName = (r) => (r ? t(`role.${r}`) : '');
  // 그래프 문서: rel(stem) = 노드 id, [[links]]가 엣지 — 아르고 기억 그래프의 계약 그대로
  const gbuilt = useMemo(() => {
    const peopleRel = (id) => `people/${id}`; const chRel = (c) => `channels/${c.id}`; const crewRel = (c) => `crews/${c.id}`; const docRel = docRelOf; // 채널은 id로(이름은 유일하지 않다 — 검수 M-2)
    const out = [];
    const visible = channels.filter((c) => c.kind !== 'dm');
    out.push({ rel: `org/${org.slug}.md`, title: org.name, dir: 'doc', links: [...visible.map(chRel), ...members.map((m) => peopleRel(m.user_id))] });
    for (const c of visible) {
      const ms = cm.filter((x) => x.channel_id === c.id);
      const people = c.kind === 'public' ? members.filter((m) => m.role !== 'guest').map((m) => peopleRel(m.user_id)) : ms.filter((x) => x.member_kind === 'user').map((x) => peopleRel(x.member_id));
      const cs = ms.filter((x) => x.member_kind === 'crew').map((x) => `crews/${x.member_id}`);
      const ds = docs.filter((d) => d.channel_id === c.id).map(docRel);
      out.push({ rel: `${chRel(c)}.md`, title: `#${c.name}`, dir: 'doc', links: [...people, ...cs, ...ds] });
    }
    for (const m of members) out.push({ rel: `${peopleRel(m.user_id)}.md`, title: m.display_name || m.user_id.slice(0, 8), dir: 'notes', links: [] });
    for (const c of crews) out.push({ rel: `${crewRel(c)}.md`, title: c.display_name, dir: 'doc', links: [peopleRel(c.owner_user_id)] });
    const wikiLinks = (body) => [...String(body ?? '').matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()); // 본문의 [[제목]]이 기억 사이 엣지(아르고 vault와 같은 문법)
    for (const d of docs) out.push({ rel: `${docRel(d)}.md`, title: d.title, dir: 'doc', links: [...wikiLinks(d.body), ...(d.channel_id ? [] : [`org/${org.slug}`])] });
    return out;
  }, [org, channels, members, crews, docs, cm]);
  const gkey = JSON.stringify(gbuilt); // 내용 키 — 부모가 30초마다 새 배열을 내려도 그래프는 내용이 바뀔 때만 다시 세운다(검수 H-1)
  const gdocs = useMemo(() => gbuilt, [gkey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 선택 대상과 행의 관계
  const relOf = (r) => {
    if (r.target_kind === 'user') return `people/${r.target_id}`;
    if (r.target_kind === 'channel') return channels.some((x) => x.id === r.target_id) ? `channels/${r.target_id}` : null;
    if (r.target_kind === 'crew') return `crews/${r.target_id}`;
    if (r.target_kind === 'doc') { const d = docs.find((x) => x.id === r.target_id); return d ? `docs/${d.path.replace(/\.md$/, '')}` : null; }
    return null;
  };
  const chOf = (r) => r.meta?.channel ?? r.meta?.channel_id ?? (r.target_kind === 'channel' ? r.target_id : null);
  const matches = (r, sel) => {
    if (sel === 'org') return true;
    if (sel.startsWith('channels/')) { const cid = sel.slice(9); return channels.some((x) => x.id === cid) && (chOf(r) === cid || relOf(r) === sel); }
    if (sel.startsWith('people/')) return relOf(r) === sel || `people/${r.actor_user_id}` === sel;
    if (sel.startsWith('crews/')) return relOf(r) === sel || `crews/${r.actor_crew_id}` === sel || `crews/${r.meta?.crew_id}` === sel;
    return relOf(r) === sel;
  };
  const who = (r) => r.actor_user_id ? nameOfUser(r.actor_user_id) : r.actor_crew_id ? crewName(r.actor_crew_id) : t('act.system');
  // 한국어 조사 — 사전 문장의 "이(가)·을(를)·(으)로·은(는)"을 앞말 받침에 맞춰 고른다(영문·숫자 끝은 받침 없음으로)
  const koJosa = (txt) => txt.replace(/(\S)(이\(가\)|을\(를\)|\(으\)로|은\(는\))/g, (all, ch, j) => {
    const code = ch.charCodeAt(0); const hangul = code >= 0xac00 && code <= 0xd7a3; const jong = hangul ? (code - 0xac00) % 28 : 0;
    const pick = { '이(가)': jong ? '이' : '가', '을(를)': jong ? '을' : '를', '(으)로': (jong && jong !== 8) ? '으로' : '로', '은(는)': jong ? '은' : '는' }[j];
    return ch + pick;
  });
  const sentence = (r) => {
    const m = r.meta ?? {}; const a = r.action;
    const p = { who: who(r), target: r.target_kind === 'user' ? nameOfUser(r.target_id) : r.target_kind === 'channel' ? `#${chName(r.target_id)}` : r.target_kind === 'crew' ? crewName(r.target_id) : r.target_kind === 'doc' ? (docTitle(r.target_id) ?? m.path ?? '') : '',
      from: m.from ? (a === 'member.role' || a === 'channel.personal_crews' ? (a === 'member.role' ? roleName(m.from) : t(`ch.personal.${m.from}`)) : nameOfUser(m.from)) : '', to: m.to ? (a === 'member.role' ? roleName(m.to) : a === 'channel.personal_crews' ? t(`ch.personal.${m.to}`) : nameOfUser(m.to)) : '',
      role: roleName(m.role), channel: m.channel || m.channel_id ? `#${chName(m.channel ?? m.channel_id)}` : '', name: m.name ?? '', domain: m.domain ?? '', path: m.path ?? '', n: m.crews_detached ?? 0, days: m.guest_days ?? '', admins: Array.isArray(m.admins) ? m.admins.map(nameOfUser).join(', ') : '' };
    p.detail = (p.role || p.channel) ? ` (${p.role}${p.channel})` : ''; // 초대 수락: 역할·채널이 둘 다 없으면 빈 괄호를 남기지 않는다
    const key = a === 'channel.admins' && !p.admins ? 'act.channel.admins.none' : `act.${a}`;
    const txt = t(key, p);
    const out = txt === key ? t('act.fallback', { who: p.who, action: a }) : txt;
    return lang === 'en' ? out : koJosa(out);
  };
  const entityView = (sel) => {
    const list = (rows ?? []).filter((r) => matches(r, sel)); const shown = list.slice(0, limitOf(sel));
    const days = []; for (const r of shown) { const d = dayKey(r.at); const g = days.find((x) => x.d === d); if (g) g.rows.push(r); else days.push({ d, at: r.at, rows: [r] }); }
    return { list, shown, days };
  };
  const toggle = (id) => setOpenIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const rc = { openIds, toggle, sel, active: focusTab?.id ?? 'graph', openTab: (rel) => openEntity(rel) }; // 트리 행 컨텍스트(ActRow는 모듈 수준 — 리마운트 없음)
  const countFor = (rel) => (rows ?? []).filter((r) => relOf(r) === rel || (rel.startsWith('channels/') && chOf(r) === rel.slice(9))).length;
  const visibleCh = channels.filter((c) => c.kind !== 'dm');
  const entityTitle = (rel) => rel === 'org' ? org.name : rel.startsWith('channels/') ? `#${channels.find((x) => x.id === rel.slice(9))?.name ?? t('act.deletedChannel')}` : rel.startsWith('people/') ? nameOfUser(rel.slice(7)) : rel.startsWith('crews/') ? crewName(rel.slice(6)) : rel.startsWith('docs/') ? (docs.find((d) => `docs/${d.path.replace(/\.md$/, '')}` === rel)?.title ?? rel) : rel;
  return (<>
    <div className="msgr-top">
      <button type="button" className="msgr-menu" onClick={onMenu} aria-label={t('ui.menu')}><I name="menu" /></button>
      <span className="title"><I name="memory" size={18} />{t('act.title')}</span>
      <button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={onBack}><I name="reply" size={13} />{t('ui.back')}</button>
    </div>
    <div className="msgr-actsplit">
      <aside className="msgr-acttree vault-tree">
        <div className="vault-toolbar">
          <button type="button" className={`tb${focusTab?.id === 'graph' ? ' on' : ''}`} onClick={() => openTab(GRAPH_TAB)} title={t('act.tab.graph')} aria-label={t('act.tab.graph')}><I name="memory" size={14} /></button>
          <span style={{ flex: 1 }} />
        </div>
        <div className="msgr-acttree-body">
          <ActRow c={rc} id="org" label={org.name} sub={rows?.length ?? ''} icon="hash" kids={<>
            <ActRow c={rc} id="channels" label={t('act.tree.channels')} sub={visibleCh.length} depth={1} kids={visibleCh.map((c) => {
              const ms = cm.filter((x) => x.channel_id === c.id); const cs = ms.filter((x) => x.member_kind === 'crew'); const ds = docs.filter((d) => d.channel_id === c.id);
              const rel = `channels/${c.id}`;
              return <ActRow c={rc} key={c.id} id={rel} label={c.name} sub={countFor(rel)} depth={2} icon={c.kind === 'private' ? 'lock' : 'hash'} kids={<>
                {cs.map((x) => <ActRow c={rc} key={x.member_id} id={`crews/${x.member_id}`} label={crewName(x.member_id)} sub={countFor(`crews/${x.member_id}`)} depth={3} icon="star" />)}
                {ds.map((d) => <ActRow c={rc} key={d.id} id={`docs/${d.path.replace(/\.md$/, '')}`} label={d.title} depth={3} icon="doc" />)}
                {!cs.length && !ds.length && <div className="tree-empty">{t('act.tree.empty')}</div>}
              </>} />;
            })} />
            <ActRow c={rc} id="people" label={t('act.tree.people')} sub={members.length} depth={1} kids={members.map((m) => <ActRow c={rc} key={m.user_id} id={`people/${m.user_id}`} label={m.display_name || m.user_id.slice(0, 8)} sub={countFor(`people/${m.user_id}`)} depth={2} icon="at" />)} />
            <ActRow c={rc} id="crews" label={t('act.tree.crews')} sub={crews.length} depth={1} kids={crews.map((c) => <ActRow c={rc} key={c.id} id={`crews/${c.id}`} label={c.display_name} sub={countFor(`crews/${c.id}`)} depth={2} icon="star" />)} />
            <ActRow c={rc} id="docs" label={t('act.tree.docs')} sub={docs.filter((d) => !d.channel_id).length} depth={1} kids={docs.filter((d) => !d.channel_id).map((d) => <ActRow c={rc} key={d.id} id={`docs/${d.path.replace(/\.md$/, '')}`} label={d.title} depth={2} icon="doc" />)} />
          </>} />
        </div>
      </aside>
      <div className="msgr-actpanes">
        {panes.map((pane, pi) => {
          const cur = pane.tabs.find((x) => x.id === pane.active) ?? pane.tabs[0]; const isFocus = pane.id === focusPane;
          const ev = cur.kind === 'entity' ? entityView(cur.rel) : null; const sel = cur.kind === 'entity' ? cur.rel : null;
          return (
            <section key={pane.id} className={`msgr-actpane vault-pane${isFocus ? ' focus' : ''}`} style={{ borderLeft: pi > 0 ? '1px solid var(--border)' : 0 }} onMouseDown={() => setFocusPane(pane.id)}>
              <div className="vault-tabs" role="tablist">
                <div className="msgr-tabscroll">{/* 탭만 가로 스크롤 — 창이 많아져도 오른쪽 동작 버튼은 줄바꿈·잘림 없이 제자리(유건 제보 2026-09-04) */}
                {pane.tabs.map((tb) => { const title = tb.kind === 'graph' ? t('act.tab.graph') : entityTitle(tb.rel); return (
                  <div key={tb.id} className={`vault-tab${tb.id === pane.active ? ' active' : ''}`} onClick={() => activateTab(pane.id, tb.id)} onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(pane.id, tb.id); } }} onContextMenu={(e) => { e.preventDefault(); const r = e.currentTarget.closest('.msgr-actpane').getBoundingClientRect(); setTabMenu({ paneId: pane.id, id: tb.id, x: e.clientX - r.left, y: e.clientY - r.top }); }} title={title} role="tab" aria-selected={tb.id === pane.active}>
                    <span className="vault-tab-title">{title}</span>
                    <button type="button" className="vault-tab-x" onClick={(e) => { e.stopPropagation(); closeTab(pane.id, tb.id); }} aria-label={t('act.closeTab')}>×</button>
                  </div>
                ); })}
                </div>
                {cur.kind === 'entity' && panes.length < MAX_PANES && <button type="button" className="msgr-tabact" onClick={() => openEntity(cur.rel, { split: true })}>{t('act.tab.openSide')}</button>}
                {(pane.tabs.length > 1 || panes.length > 1) && <button type="button" className="msgr-tabact" onClick={() => closeAll(pane.id)}>{t('act.tab.closeAll')}</button>}
              </div>
              {tabMenu && tabMenu.paneId === pane.id && <>
                <div className="msgr-menubg" onClick={() => setTabMenu(null)} onContextMenu={(e) => { e.preventDefault(); setTabMenu(null); }} />
                <div className="msgr-rowmenu msgr-tabmenu" style={{ left: tabMenu.x, top: tabMenu.y }} role="menu">
                  <button type="button" onClick={() => { closeTab(pane.id, tabMenu.id); setTabMenu(null); }}>{t('act.closeTab')}</button>
                  <button type="button" onClick={() => { closeOthers(pane.id, tabMenu.id); setTabMenu(null); }}>{t('act.tab.closeOthers')}</button>
                  <button type="button" onClick={() => { closeRight(pane.id, tabMenu.id); setTabMenu(null); }}>{t('act.tab.closeRight')}</button>
                  <button type="button" onClick={() => { closeAll(pane.id); setTabMenu(null); }}>{t('act.tab.closeAll')}</button>
                </div>
              </>}
              <div className="msgr-actbody">
                {cur.kind === 'graph' ? (
                  <Graph3D key="all" docs={gdocs} hint={t('act.graph.hint')} labels={{ zoomIn: t('act.graph.zoomIn'), zoomOut: t('act.graph.zoomOut'), fit: t('act.graph.fit') }} onSelectDoc={(rel) => openEntity(relOfDoc(rel), { split: true })} />
                ) : (
                  <div className="msgr-actlist">
                    {(() => {
                      const doc = sel.startsWith('docs/') ? docs.find((d) => docRelOf(d) === sel) : null;
                      const ch = sel.startsWith('channels/') ? channels.find((x) => x.id === sel.slice(9)) : null;
                      const scopeDocs = doc ? [] : sel === 'org' ? docs.filter((d) => !d.channel_id) : ch ? docs.filter((d) => d.channel_id === ch.id) : sel.startsWith('people/') ? docs.filter((d) => d.updated_by === sel.slice(7)) : [];
                      const canNew = sel === 'org' ? isAdmin : !!ch;
                      return (<>
                        {!doc && <div className="head"><h3>{sel === 'org' ? t('mem.all') : t('mem.of', { name: entityTitle(sel) })}</h3><span className="sub">{scopeDocs.length}</span>
                          {ch && <button type="button" className="btn sm" onClick={() => onOpenChannel(ch.id)}><I name="hash" size={12} />{t('act.openChannel')}</button>}
                          {canNew && creating !== sel && <button type="button" className="btn sm" onClick={() => setCreating(sel)}><I name="plus" size={12} />{t('mem.new')}</button>}
                        </div>}
                        {creating === sel && <MemNew org={org} channelId={ch?.id ?? null} uid={uid} onNote={onNote} onError={onError} onCancel={() => setCreating(null)} onCreated={async (d) => { setCreating(null); await load(); openEntity(`docs/${d.path.replace(/\.md$/, '')}`); }} />}
                        {doc ? <MemDoc doc={doc} isAdmin={isAdmin} nameOfUser={nameOfUser} chName={chName} onSaved={load} onNote={onNote} onError={onError} /> : (
                          <div className="msgr-memlist">
                            {!scopeDocs.length && creating !== sel && <p className="empty">{sel.startsWith('people/') || sel.startsWith('crews/') ? t('mem.none.person') : t('mem.none')}</p>}
                            {DOC_FOLDERS.map((f) => { const fs = scopeDocs.filter((d) => d.path.startsWith(`${f}/`)); return fs.length ? (
                              <div key={f} className="folder"><div className="msgr-klabel">{t(`docs.folder.${f}`)}</div>
                                {fs.map((d) => <button key={d.id} type="button" className="memitem" onClick={(e) => openEntity(docRelOf(d), { split: !!(e.metaKey || e.altKey) })}><I name="doc" size={13} /><span className="name">{d.title}</span><span className="meta">{d.channel_id ? `#${chName(d.channel_id)} · ` : ''}v{d.version} · {nameOfUser(d.updated_by)}</span></button>)}
                              </div>) : null; })}
                          </div>
                        )}
                        {isAdmin && (
                          <details className="msgr-actfold">
                            <summary>{t('mem.activity')}<span className="sub">{ev.list.length}</span></summary>
                            {rows !== null && !ev.list.length && <p className="empty">{t('act.empty')}</p>}
                            {ev.days.map((g) => (
                              <div key={g.d} className="day">
                                <div className="daylabel">{fmtDay(g.at, lang).join(' · ')}</div>
                                {g.rows.map((r) => <div key={r.id} className="item"><span className="when">{fmtTs(r.at, lang)}</span><span className="text">{sentence(r)}</span></div>)}
                              </div>
                            ))}
                            {ev.list.length > ev.shown.length && <div className="row"><button type="button" className="btn sm" onClick={() => setLimits((m) => ({ ...m, [sel]: limitOf(sel) + 60 }))}>{t('act.more')}</button></div>}
                          </details>
                        )}
                      </>);
                    })()}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  </>);
}

/* ─── 조직 문서(G-1): 전사(rules/·glossary/·projects/) + 채널 범위. 정본은 서버, 편집권은 RLS(msgr_can_edit_doc) — 화면은 힌트만 ─── */
const DOC_FOLDERS = ['rules', 'glossary', 'projects'];
export const docSlug = (title) => { const s = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); return s || `doc-${Date.now().toString(36)}`; }; // 한글 제목은 시간 기반 슬러그(경로 규칙은 영문·숫자만)
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
function OrgCard({ org, uid, members, nameOfUser, onChanged, onOrgsChanged, onNote, onError, part = 'org', myEmail = '', onOpenCrew }) {
  const { t, lang } = useT();
  const [name, setName] = useState(org.name); const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState([]);
  const [confirmRemove, setConfirmRemove] = useState(null); const [audit, setAudit] = useState(null); const [memberQ, setMemberQ] = useState(''); const [memberN, setMemberN] = useState(30);
  const isOwner = org.role === 'owner';
  const admins = members.filter((m) => m.role === 'admin' && m.user_id !== org.service_user_id); // J-2: 이전 제안·승계 대상은 활성 관리자만(서버 트리거와 같은 규칙), 서비스 계정 제외
  const iAmNominee = org.pending_owner_user_id === uid;
  const myDomain = String(myEmail ?? '').split('@')[1]?.toLowerCase() ?? ''; // 등록 가능한 도메인은 소유자 로그인 이메일 도메인뿐 — 입력창 대신 토글(UX 2/3)
  const domainOn = !!org.auto_join_domain;
  const toggleDomain = () => patchOrg({ auto_join_domain: domainOn ? null : myDomain, auto_join_role: 'member' }, domainOn ? t('org.domain.off') : t('org.domain.saved'));
  const [transfer, setTransfer] = useState(null); // null | 'pick' | <userId 확인 단계>
  const [nodeGuide, setNodeGuide] = useState(false);
  const nodeSet = !!org.service_user_id; // 서버 계정이 지정돼 있는가(실측: 채널 시트의 이름을 그대로 써 ReferenceError → 앱 전체 빈 화면)
  const [delName, setDelName] = useState(null); // J-5: 이름을 그대로 입력해야 삭제(깃헙식 확인 — 네이티브 confirm 금지)
  const deleteOrg = async () => {
    if (delName.trim() !== org.name) return;
    setBusy(true);
    const res = await supabase.from('msgr_orgs').update({ deleted_at: new Date().toISOString() }).eq('id', org.id).select('id');
    setBusy(false);
    if (res.error) return onError(/msgr_owner_only/.test(res.error.message) ? t('org.noEdit') : res.error.message);
    if (!res.data?.length) return onError(t('org.noEdit'));
    setDelName(null); onNote(t('org.delete.done', { name: org.name })); onOrgsChanged();
  };
  const patchOrg = async (patch, okMsg) => {
    setBusy(true);
    const res = await supabase.from('msgr_orgs').update(patch).eq('id', org.id).select('id');
    setBusy(false);
    if (res.error) return onError(/msgr_transfer_not_admin|msgr_successor_not_admin/.test(res.error.message) ? t('org.owner.notAdmin') : /msgr_domain_public/.test(res.error.message) ? t('org.domain.public') : /msgr_domain_not_owners/.test(res.error.message) ? t('org.domain.notOwners') : /msgr_owner_only/.test(res.error.message) ? t('org.noEdit') : friendlyErr(res.error.message, t));
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
    if (res.error) return onError(friendlyErr(res.error.message, t));
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
  const makeInvite = async (role = 'member') => {
    setBusy(true);
    const res = await supabase.from('msgr_invites').insert({ org_id: org.id, role, created_by: uid }).select('code').single();
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
  const nodeCmdBlock = nodeInvite && (<>
    <code>{nodeCmd}</code>
    <div className="acts"><button type="button" className="btn sm" onClick={copyNodeCmd}><I name="copy" size={13} />{t('org.node.copy')}</button><span className="msgr-klabel">{t('org.invite.expires', { when: fmtWhen(nodeInvite.expires_at, lang) })}</span></div>
  </>);
  // 멤버가 50·100명이 되어도 한 화면에 다 쌓지 않는다(유건 질문 2026-09-09): 검색 + 30명씩 더 보기. 목록 자체는 조직 멤버 표 전체를 이미 받아 두므로 서버 페이징은 1,000명 넘을 때(v2).
  if (part === 'members') { const q = memberQ.trim().toLowerCase(); const shown = members.filter((m) => !q || (m.display_name || '').toLowerCase().includes(q) || (m.user_id || '').includes(q)); return (
    <section className="msgr-setcard">
      <h2>{t('org.members')} · {members.length}</h2>
      {members.length > 8 && <input className="msgr-input sm" value={memberQ} onChange={(e) => { setMemberQ(e.target.value); setMemberN(30); }} placeholder={t('org.members.search')} aria-label={t('org.members.search')} />}
      <div className="msgr-rows">
        {shown.slice(0, memberN).map((m) => { const isMe = m.user_id === uid; const isSvc = m.user_id === org.service_user_id; const canEdit = !isMe && !isSvc && m.role !== 'owner'; return (
          <div key={m.user_id} className="row">
            <Av name={m.display_name || m.user_id} size="sm" /><span className="name">{m.display_name || m.user_id.slice(0, 8)}</span>
            {m.expires_at && <span className={`sub${Date.parse(m.expires_at) < Date.now() ? ' expired' : ''}`}>{Date.parse(m.expires_at) < Date.now() ? t('org.guest.expired') : t('org.guest.until', { when: fmtWhen(m.expires_at, lang) })}</span>}
            {isSvc ? <span className="sub">{t('org.node')}</span> : m.role === 'owner' || isMe ? <span className="sub">{t(`role.${m.role}`)}{isMe ? ` · ${t('ui.me')}` : ''}</span>
              : <div className="msgr-seg right" role="radiogroup" aria-label={t('org.member.role')}>{ROLES_ASSIGNABLE.map((r) => <button key={r} type="button" role="radio" aria-checked={m.role === r} className={m.role === r ? 'active' : ''} disabled={busy} onClick={() => setRole(m, r)}>{t(`role.${r}`)}</button>)}</div>}
            {canEdit && confirmRemove !== m.user_id && <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setConfirmRemove(m.user_id)} title={t('org.member.remove')} aria-label={t('org.member.remove')}><I name="x" size={13} /></button>}
            {canEdit && confirmRemove === m.user_id && <span className="confirm-inline"><span>{t('org.member.remove.confirm')}</span><button type="button" className="btn btn-primary sm danger" disabled={busy} onClick={() => remove(m)}>{t('org.member.remove')}</button><button type="button" className="btn sm" onClick={() => setConfirmRemove(null)}>{t('ui.cancel')}</button></span>}
          </div>
        ); })}
        {shown.length > memberN && <div className="row"><button type="button" className="btn sm" onClick={() => setMemberN((n) => n + 30)}>{t('org.members.more', { n: shown.length - memberN })}</button></div>}
        {!shown.length && <p className="empty">{t('org.members.noMatch')}</p>}
      </div>
      <h3>{t('org.invites.h')}</h3>
      <p>{t('org.invites.desc2')}</p>
      <div className="row">
        <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => makeInvite('member')}><I name="copy" size={13} />{t('org.invite.member')}</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => makeInvite('admin')}>{t('org.invite.admin')}</button>
      </div>
      {open.length > 0 && (
        <div className="msgr-rows">
          {open.map((inv) => (
            <div key={inv.id} className="row">
              <span className="name">{t(`org.invite.kind.${inv.role}`)}</span>
              <span className="sub">{t('org.invite.expires', { when: fmtWhen(inv.expires_at, lang) })}</span>
              <button type="button" className="btn sm ghost" onClick={() => copyLink(inv)} title={t('org.invite.copy')} aria-label={t('org.invite.copy')}><I name="copy" size={13} /></button>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => revoke(inv)} title={t('org.invite.revoke')} aria-label={t('org.invite.revoke')}><I name="x" size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </section>
  ); }

  // ── 부록 N: 외부 에이전트(헤르메스·오픈클로)는 텔레그램·슬랙에 붙듯 **봇**으로 이 메신저에 접속한다. 봇 = 회사 등급 크루 + 토큰(서버 msgr_bots).
  //    토큰 원문은 생성·회전 직후 이 화면에만 있고(setup 상태) 저장·로그하지 않는다. 가용성은 마지막 getUpdates(last_seen_at)뿐 — 종료/재시작 버튼 없음(해제 = 토큰 회수).
  const [bots, setBots] = useState([]); const [setup, setSetup] = useState(null); const [confirmRevoke, setConfirmRevoke] = useState(null); const [openBot, setOpenBot] = useState(null);
  const loadBots = useCallback(async () => { if (part !== 'agents') return; setBots(await q(supabase.from('msgr_bots').select('id, crew_id, kind, name, token_hint, created_by, created_at, rotated_at, revoked_at, last_seen_at, external_id').eq('org_id', org.id).order('created_at'))); }, [org.id, part]);
  useEffect(() => { loadBots().catch((e) => onError(e.message)); }, [loadBots]); // eslint-disable-line react-hooks/exhaustive-deps
  const [auto, setAuto] = useState(null); // 원클릭 연결(앱 안에서만): null | { status: 'running'|'done'|'missing'|'failed', results:[{id,name,ok,steps}], reason }
  const [setups, setSetups] = useState([]); // 이번에 만든/회전한 봇들의 설정(이름·두 줄) — 토큰은 화면 상태로만
  const botOf = (kind, extId) => bots.find((b) => !b.revoked_at && b.kind === kind && b.external_id === extId);
  const mineOf = (kind) => bots.find((b) => !b.revoked_at && b.kind === kind && b.created_by === uid);
  const botUrl = `${SB_URL}/functions/v1/msgr-bot`;
  const botSetup = (token) => `ARGO_MSGR_URL=${botUrl}\nARGO_MSGR_BOT_TOKEN=${token}`; // 다른 컴퓨터용 두 줄(설정 복사)
  const mkOrRotate = async (kind, name, extId) => { // 같은 에이전트(external_id)의 봇이 있으면 회전, 없으면 생성 — 둘 다 토큰 원문은 지금만
    const cur = extId ? botOf(kind, extId) : null;
    if (cur) { const r = await supabase.rpc('msgr_bot_rotate', { bot: cur.id }); if (r.error) throw new Error(r.error.message); return { id: cur.id, token: r.data, name: cur.name }; }
    const r = await supabase.rpc('msgr_bot_create', { org: org.id, kind, name, external_id: extId ?? null }); if (r.error) throw new Error(r.error.message);
    return { id: r.data.bot_id, token: r.data.token, name };
  };
  // [헤르메스 연결하기] = 이 컴퓨터의 헤르메스 프로필(오픈클로는 등록 에이전트) **전원**을 읽어 각각 봇을 만들고(이름 = 그 에이전트 이름) 한 번에 연결(유건 지시 2026-09-08).
  // 앱 밖(브라우저)이거나 CLI가 없으면 봇 하나만 만들고 수동 안내를 보인다.
  const connectAll = async (kind) => {
    setBusy(true); setAuto(null); setSetups([]);
    try {
      let agents = null;
      if (inTauri() && ['hermes', 'openclaw'].includes(kind)) {
        const { invoke } = await import('@tauri-apps/api/core');
        const l = await invoke('agent_list', { kind });
        if (l?.ok && l.agents?.length) agents = l.agents; else if (l?.reason === 'cli_missing') setAuto({ status: 'missing', results: [] });
      }
      if (!agents) { // 수동: 이 컴퓨터에 에이전트가 없거나 앱 밖 — 봇 하나(다른 컴퓨터용)
        const made = await mkOrRotate(kind, kind === 'custom' ? t('org.agents.kind.custom') : t('org.agents.name.mine', { who: nameOfUser(uid), kind: t(`org.agents.kind.${kind}`) }), null);
        setSetups([{ ...made, kind }]); setSetup({ id: made.id, token: made.token, kind }); onNote(t('org.agents.made')); loadBots().catch(() => {}); onChanged?.();
        return;
      }
      const made = [];
      for (const a of agents) made.push({ ...(await mkOrRotate(kind, a.name, `${kind}:${a.id}`)), kind, agentId: a.id, home: a.home ?? '' });
      setSetups(made); setSetup({ id: made[0].id, token: made[0].token, kind }); loadBots().catch(() => {}); onChanged?.();
      setAuto({ status: 'running', results: [] });
      const { invoke } = await import('@tauri-apps/api/core');
      const r = await invoke('agent_connect', { kind, url: botUrl, agents: made.map((m) => ({ id: m.agentId, token: m.token, home: m.home })) });
      const results = (r?.results ?? []).map((x) => ({ ...x, name: made.find((m) => m.agentId === x.id)?.name ?? x.id }));
      setAuto(r?.ok ? { status: 'done', results } : { status: r?.reason === 'cli_missing' ? 'missing' : 'failed', results, reason: r?.reason ?? '' });
      onNote(t('org.agents.made.n', { n: made.length }));
    } catch (e) { onError(String(e?.message ?? e)); setAuto((a) => a?.status === 'running' ? { status: 'failed', results: [], reason: String(e?.message ?? e) } : a); }
    finally { setBusy(false); }
  };
  const autoConnect = async (kind, token, bot) => { // 회전 뒤 다시 연결(봇 하나) — external_id가 있는 봇만 이 컴퓨터에 자동 설정
    if (!inTauri() || !['hermes', 'openclaw'].includes(kind) || !bot?.external_id) { setAuto(null); return; }
    setAuto({ status: 'running', results: [] });
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const id = bot.external_id.split(':').slice(1).join(':');
      const l = await invoke('agent_list', { kind }); const home = l?.agents?.find((a) => a.id === id)?.home ?? '';
      const r = await invoke('agent_connect', { kind, url: botUrl, agents: [{ id, token, home }] });
      const results = (r?.results ?? []).map((x) => ({ ...x, name: bot.name }));
      setAuto(r?.ok ? { status: 'done', results } : { status: r?.reason === 'cli_missing' ? 'missing' : 'failed', results, reason: r?.reason ?? '' });
    } catch (e) { setAuto({ status: 'failed', results: [], reason: String(e?.message ?? e) }); }
  };
  const addBot = (kind) => connectAll(kind);
  const addAnother = async (kind) => { // 다른 컴퓨터·다른 사람의 에이전트: external_id 없는 봇 하나 + 수동 안내
    setBusy(true);
    try { const made = await mkOrRotate(kind, t('org.agents.name.other', { kind: t(`org.agents.kind.${kind}`) }), null); setSetups([{ ...made, kind }]); setSetup({ id: made.id, token: made.token, kind }); setAuto(null); onNote(t('org.agents.made')); loadBots().catch(() => {}); onChanged?.(); }
    catch (e) { onError(String(e?.message ?? e)); } finally { setBusy(false); }
  };
  const rotateBot = async (b) => {
    setBusy(true); const r = await supabase.rpc('msgr_bot_rotate', { bot: b.id }); setBusy(false);
    if (r.error) return onError(r.error.message);
    setSetups([{ id: b.id, token: r.data, name: b.name, kind: b.kind }]); setSetup({ id: b.id, token: r.data, kind: b.kind }); onNote(t('org.agents.rotated')); loadBots().catch(() => {}); autoConnect(b.kind, r.data, b);
  };
  const revokeBot = async (b) => {
    setBusy(true); const r = await supabase.rpc('msgr_bot_revoke', { bot: b.id }); setBusy(false); setConfirmRevoke(null);
    if (r.error) return onError(r.error.message);
    if (setup?.id === b.id) setSetup(null); onNote(t('org.agents.revoke.done')); loadBots().catch(() => {}); onChanged?.();
  };
  const copyAll = async () => { const txt = (setups.length ? setups : [setup]).map((m) => (setups.length > 1 ? `# ${m.name}\n` : '') + botSetup(m.token)).join('\n\n'); await navigator.clipboard?.writeText(txt).catch(() => {}); onNote(t('org.agents.copied')); };
  const botStatus = (b) => {
    const kind = t(`org.agents.kind.${b.kind}`);
    if (!b.last_seen_at) return t('org.agents.waiting', { kind });
    return t(Date.now() - Date.parse(b.last_seen_at) < AWAY_MS ? 'org.agents.on' : 'org.agents.off', { kind, when: fmtWhen(b.last_seen_at, lang) });
  };
  if (part === 'agents') { const liveBots = bots.filter((b) => !b.revoked_at); return (
    <section className="msgr-setcard">
      <h2>{t('org.agents')}</h2><p>{t('org.agents.desc')}</p>
      <div className="row">
        <button type="button" className="btn btn-primary sm" disabled={busy} onClick={() => addBot('hermes')} title={mineOf('hermes') ? t('org.agents.reconnect.title') : undefined}><I name={mineOf('hermes') ? 'at' : 'plus'} size={13} />{mineOf('hermes') ? t('org.agents.reconnect', { kind: t('org.agents.kind.hermes') }) : t('org.agents.add.hermes')}</button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => addBot('openclaw')} title={mineOf('openclaw') ? t('org.agents.reconnect.title') : undefined}>{mineOf('openclaw') ? t('org.agents.reconnect', { kind: t('org.agents.kind.openclaw') }) : t('org.agents.add.openclaw')}</button>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={() => addBot('custom')}>{t('org.agents.add.custom')}</button>
        {(mineOf('hermes') || mineOf('openclaw')) && <span className="msgr-klabel">{t('org.agents.another')} {mineOf('hermes') && <button type="button" className="btn sm ghost text" disabled={busy} onClick={() => addAnother('hermes')}>{t('org.agents.kind.hermes')}</button>}{mineOf('openclaw') && <button type="button" className="btn sm ghost text" disabled={busy} onClick={() => addAnother('openclaw')}>{t('org.agents.kind.openclaw')}</button>}</span>}
      </div>
      {setup && (
        <div className="msgr-node-cmd">
          <span className="msgr-klabel">{t('org.agents.setup.h')}</span>
          {(setups.length ? setups : [{ ...setup, name: '' }]).map((m) => <div key={m.id} className="one">{setups.length > 1 && <span className="msgr-klabel">{m.name}</span>}<code>{botSetup(m.token)}</code></div>)}
          <div className="acts"><button type="button" className="btn sm" onClick={() => copyAll()}><I name="copy" size={13} />{t('org.agents.copy')}</button><button type="button" className="btn sm ghost" onClick={() => setSetup(null)}>{t('ui.close')}</button></div>
          {auto?.status === 'running' && <p className="msgr-auto running"><span className="msgr-dot mark" /> {t('org.agents.auto.running', { kind: t(`org.agents.kind.${setup.kind}`) })}</p>}
          {auto?.status === 'done' && (<div className="msgr-auto done">
            <p><span className="msgr-dot ok" /> {t('org.agents.auto.done.n', { kind: t(`org.agents.kind.${setup.kind}`), n: (auto.results ?? []).length })}</p>
            <ul>{(auto.results ?? []).map((r) => <li key={r.id}><b>{r.name}</b>: {(r.steps ?? []).map((s) => `${s.ok ? '✓' : '✗'} ${t(`org.agents.auto.step.${s.name}`)}`).join(' · ')}</li>)}</ul>
          </div>)}
          {auto?.status === 'failed' && (<div className="msgr-auto failed">
            <p>{t('org.agents.auto.failed', { kind: t(`org.agents.kind.${setup.kind}`) })}</p>
            <ul>{(auto.results ?? []).map((r) => <li key={r.id}><b>{r.name}</b>: {(r.steps ?? []).map((s) => `${s.ok ? '✓' : '✗'} ${t(`org.agents.auto.step.${s.name}`)}${!s.ok && s.detail ? ` — ${String(s.detail).slice(0, 160)}` : ''}`).join(' · ')}</li>)}</ul>
            <div className="acts"><button type="button" className="btn sm" onClick={() => connectAll(setup.kind)}>{t('org.agents.auto.retry')}</button></div>
          </div>)}
          {auto?.status === 'missing' && <p className="msgr-auto missing">{t('org.agents.auto.missing', { kind: t(`org.agents.kind.${setup.kind}`) })}</p>}
          {auto?.status !== 'done' && auto?.status !== 'running' && (<>
            <span className="msgr-klabel">{t('org.agents.setup.manual')}</span>
            <ol className="steps">{/* 유건 질문 2026-09-08 "두 줄을 어디에 넣나" — 앱 밖(브라우저)이거나 이 컴퓨터에 에이전트가 없을 때의 수동 안내 */}
              <li>{t(`org.agents.setup.${setup.kind ?? 'custom'}.1`)}</li>
              <li>{t(`org.agents.setup.${setup.kind ?? 'custom'}.2`)}</li>
              <li>{t(`org.agents.setup.${setup.kind ?? 'custom'}.3`)}</li>
            </ol>
          </>)}
          <p className="note">{auto?.status === 'done' ? t('org.agents.auto.after') : t('org.agents.setup.hint')}</p>
        </div>
      )}
      {!liveBots.length ? <p className="empty">{t('org.agents.none')}</p> : (
        <div className="msgr-rows">
          {liveBots.map((b) => { const on = b.last_seen_at && Date.now() - Date.parse(b.last_seen_at) < AWAY_MS; const opened = openBot === b.id; return (
            <div key={b.id} className={`msgr-botrow${opened ? ' open' : ''}`}>
              <div className="row">
                <button type="button" className="main" onClick={() => setOpenBot(opened ? null : b.id)} aria-expanded={opened} title={t('org.agents.detail.open')}>
                  <Av name={b.name} crew size="sm" company /><span className="name">{b.name}</span>
                  <span className="sub"><span className={`msgr-dot${on ? ' mark' : ''}`} /> {botStatus(b)} · {t('org.agents.by', { name: nameOfUser(b.created_by) })}</span>
                </button>
                {confirmRevoke !== b.id && <><button type="button" className="btn sm ghost text" disabled={busy} onClick={() => rotateBot(b)}>{t('org.agents.rotate')}</button><button type="button" className="btn sm ghost" disabled={busy} onClick={() => setConfirmRevoke(b.id)} title={t('org.agents.revoke')} aria-label={t('org.agents.revoke')}><I name="x" size={13} /></button></>}
                {confirmRevoke === b.id && <span className="confirm-inline"><span>{t('org.agents.revoke.confirm')}</span><button type="button" className="btn btn-primary sm danger" disabled={busy} onClick={() => revokeBot(b)}>{t('org.agents.revoke')}</button><button type="button" className="btn sm ghost text" onClick={() => setConfirmRevoke(null)}>{t('ui.cancel')}</button></span>}
              </div>
              {opened && (
                <div className="msgr-node-cmd detail">
                  <div className="facts">
                    <div><span className="msgr-klabel">{t('org.agents.detail.status')}</span><span>{botStatus(b)}</span></div>
                    <div><span className="msgr-klabel">{t('org.agents.detail.kind')}</span><span>{t(`org.agents.kind.${b.kind}`)}</span></div>
                    <div><span className="msgr-klabel">{t('org.agents.by.label')}</span><span>{nameOfUser(b.created_by)}</span></div>
                    <div><span className="msgr-klabel">{t('org.agents.detail.created')}</span><span>{fmtWhen(b.created_at, lang)}</span></div>
                    <div><span className="msgr-klabel">{t('org.agents.detail.token')}</span><span><code>{b.token_hint}…</code>{b.rotated_at ? ` · ${t('org.agents.detail.rotated', { when: fmtWhen(b.rotated_at, lang) })}` : ''}</span></div>
                  </div>
                  <p className="note">{t('org.agents.detail.hint')}</p>
                  <div className="acts">{onOpenCrew && <button type="button" className="btn sm" onClick={() => onOpenCrew(b.crew_id)}><I name="star" size={13} />{t('org.agents.detail.openCrew')}</button>}<button type="button" className="btn sm ghost text" onClick={() => setOpenBot(null)}>{t('ui.close')}</button></div>
                </div>
              )}
            </div>); })}
        </div>)}
    </section>
  ); }
  if (part === 'node') return (
    <section className="msgr-setcard">
      <h2>{t('org.node')}</h2><p>{t('org.node.desc')}</p>
      <div className="row">
        <span className={`msgr-tag${nodeAlive ? ' on' : ''}`}>{nodeStatus}</span>
        <button type="button" className={`btn sm${nodeSet ? '' : ' btn-primary'}`} disabled={busy} onClick={() => setNodeGuide((v) => !v)} aria-expanded={nodeGuide}>{nodeSet ? t('org.node.reconnect') : t('org.node.connect')}</button>
      </div>
      {nodeGuide && (
        <div className="msgr-node-cmd">
          <ol className="steps">
            <li>{t('org.node.step1')}</li>
            <li>{t('org.node.step2')}</li>
            <li>{t('org.node.step3')}</li>
          </ol>
          {nodeInvite ? nodeCmdBlock : <div className="acts"><button type="button" className="btn btn-primary sm" disabled={busy} onClick={makeNodeInvite}><I name="doc" size={13} />{t('org.node.make')}</button></div>}
          {nodeInvite && <div className="acts"><button type="button" className="btn sm ghost" disabled={busy} onClick={makeNodeInvite}>{t('org.node.remake')}</button><button type="button" className="btn sm ghost" disabled={busy} onClick={() => revoke(nodeInvite)}>{t('org.invite.revoke')}</button></div>}
          <p className="note">{t('org.node.hint')}</p>
        </div>
      )}
    </section>
  );
  if (part === 'audit') return (
    <section className="msgr-setcard">
      <h2>{t('org.audit')}</h2>
      {audit === null
        ? <div className="row"><button type="button" className="btn sm" onClick={() => loadAudit().catch((e) => onError(e.message))}><I name="doc" size={13} />{t('org.audit.load')}</button></div>
        : (<div className="msgr-audit">
            {!audit.length && <p className="empty">{t('org.audit.empty')}</p>}
            {audit.map((a) => <div key={a.id} className="row"><span className="when">{fmtWhen(a.at, lang)}</span><span className="who">{a.actor_user_id ? nameOfUser(a.actor_user_id) : (a.actor_crew_id ? t('org.crews') : t('org.audit.system'))}</span><span className="act">{a.action}</span><span className="tgt">{a.target_kind}{a.target_id ? ` · ${String(a.target_id).slice(0, 8)}` : ''}</span></div>)}
            <div className="row"><button type="button" className="btn sm" onClick={() => loadAudit().catch((e) => onError(e.message))}>{t('org.audit.reload')}</button></div>
          </div>)}
    </section>
  );
  const nomineeName = transfer && transfer !== 'pick' ? (members.find((m) => m.user_id === transfer)?.display_name || transfer.slice(0, 8)) : '';
  return (
    <section className="msgr-setcard">
      <h2>{t('set.org')}</h2><p>{t('set.org.desc')}</p>
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
      <div className="row">
        <span className="msgr-klabel">{t('org.name')}</span>
        <input className="msgr-input inline" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }} />
        <button type="button" className="btn btn-primary sm" disabled={busy || !name.trim() || name.trim() === org.name} onClick={saveName}><I name="check" size={13} />{t('ui.save')}</button>
      </div>
      {isOwner && (<>
        <div className="row">
          <label className="switchrow"><input type="checkbox" checked={domainOn} disabled={busy || !myDomain} onChange={toggleDomain} /><span>{t('org.domain.toggle', { domain: org.auto_join_domain ?? myDomain })}</span></label>
        </div>
        <p className="note">{t('org.domain.note')}</p>
        <div className="row">
          <span className="msgr-klabel">{t('org.transfer')}</span>
          {org.pending_owner_user_id
            ? <><span className="msgr-tag">{t('org.transfer.pending', { name: nameOfUser(org.pending_owner_user_id) })}</span><button type="button" className="btn sm ghost" disabled={busy} onClick={() => patchOrg({ pending_owner_user_id: null }, t('org.transfer.cancelled'))} title={t('org.transfer.cancel')} aria-label={t('org.transfer.cancel')}><I name="x" size={13} /></button></>
            : transfer === null ? <button type="button" className="btn sm" disabled={busy} onClick={() => setTransfer('pick')}>{t('org.transfer.start')}</button>
            : transfer !== 'pick' ? <span className="confirm-inline"><span>{t('org.transfer.confirm', { name: nomineeName })}</span><button type="button" className="btn btn-primary sm" disabled={busy} onClick={async () => { await patchOrg({ pending_owner_user_id: transfer }, t('org.transfer.sent', { name: nomineeName })); setTransfer(null); }}>{t('org.transfer.do')}</button><button type="button" className="btn sm" onClick={() => setTransfer(null)}>{t('ui.cancel')}</button></span>
            : admins.length ? <div className="picks">{admins.map((m) => <button key={m.user_id} type="button" className="msgr-chan" disabled={busy} onClick={() => setTransfer(m.user_id)}><span>{m.display_name || m.user_id.slice(0, 8)}</span></button>)}<button type="button" className="btn sm ghost" onClick={() => setTransfer(null)}>{t('ui.cancel')}</button></div> : <span className="sub">{t('org.owner.noAdmins')}</span>}
        </div>
        <p className="note">{t('org.transfer.desc')}</p>
        <div className="row">
          <span className="msgr-klabel">{t('org.delete')}</span>
          {delName === null
            ? <button type="button" className="btn sm" disabled={busy} onClick={() => setDelName('')}><I name="x" size={13} />{t('org.delete.start')}</button>
            : <>
                <input className="msgr-input inline" placeholder={t('org.delete.typeName', { name: org.name })} value={delName} onChange={(e) => setDelName(e.target.value)} autoFocus />
                <button type="button" className="btn btn-primary sm danger" disabled={busy || delName.trim() !== org.name} onClick={deleteOrg}>{t('org.delete.confirm')}</button>
                <button type="button" className="btn sm" onClick={() => setDelName(null)}>{t('ui.cancel')}</button>
              </>}
        </div>
        <p className="note">{t('org.delete.desc')}</p>
      </>)}
    </section>
  );
}

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
    if (res.error) return onError(friendlyErr(res.error.message, t));
    if (!res.data?.length) return onError(t('set.policy.adminOnly'));
    onNote(t('set.policy.saved')); onChanged();
  };
  const ro = !isAdmin || busy;
  const nodeRunners = Array.isArray(org?.node_info?.runners) ? org.node_info.runners : []; // 서버가 하트비트에 실은 목록 — 있으면 드롭다운, 없으면 텍스트(정직)
  const [adv, setAdv] = useState(false); // 고급(기억·게스트 좌석·엔진·잠금)은 접어 둔다 — 기본값 그대로면 볼 일이 없다
  return (
    <section className="msgr-setcard">
      <h2>{t('set.policy')}</h2><p>{t('set.policy.desc')}</p>
      <div className="q">
        <span className="qlabel">{t('set.policy.q.allow')}</span>
        <div className="msgr-seg" role="radiogroup" aria-label={t('set.policy.q.allow')}>
          {['all', 'list', 'owner'].map((v) => <button key={v} type="button" role="radio" aria-checked={draft.allow_default === v} className={draft.allow_default === v ? 'active' : ''} disabled={ro} onClick={() => set({ allow_default: v })}>{t(`crew.allow.${v}`)}</button>)}
        </div>
        <label className="switchrow"><input type="checkbox" checked={!!draft.allow_locked} disabled={ro} onChange={(e) => set({ allow_locked: e.target.checked })} /><span>{t('set.policy.lock2')}</span></label>
      </div>
      <div className="q">
        <span className="qlabel">{t('set.policy.q.approval')}</span>
        <div className="msgr-seg" role="radiogroup" aria-label={t('set.policy.q.approval')}>
          {['admin', 'approvers', 'owner'].map((v) => <button key={v} type="button" role="radio" aria-checked={(draft.approval_high_by ?? 'admin') === v} className={(draft.approval_high_by ?? 'admin') === v ? 'active' : ''} disabled={ro} onClick={() => set({ approval_high_by: v })}>{t(`set.policy.approval.${v}`)}</button>)}
        </div>
        {(draft.approval_high_by === 'approvers') && (
          <div className="picks">{members.filter((m) => m.role !== 'owner' && m.role !== 'guest' && m.user_id !== org.service_user_id).map((m) => { const on = (draft.approver_user_ids ?? []).includes(m.user_id); /* 게스트 제외: 공개 채널을 못 읽어 결재를 확정할 수 없다 */ return <button key={m.user_id} type="button" className={`msgr-chan${on ? ' active' : ''}`} aria-pressed={on} disabled={ro} onClick={() => set({ approver_user_ids: on ? (draft.approver_user_ids ?? []).filter((x) => x !== m.user_id) : [...(draft.approver_user_ids ?? []), m.user_id] })}><span>{m.display_name || m.user_id.slice(0, 8)}</span></button>; })}</div>
        )}
        <span className="note">{t('set.policy.approval.desc')}</span>
      </div>
      <div className="q">
        <span className="qlabel">{t('set.policy.q.crewCreate')}</span>
        <div className="msgr-seg" role="radiogroup" aria-label={t('set.policy.q.crewCreate')}>
          {['admin', 'channel_admin', 'member'].map((v) => <button key={v} type="button" role="radio" aria-checked={(draft.crew_create ?? 'channel_admin') === v} className={(draft.crew_create ?? 'channel_admin') === v ? 'active' : ''} disabled={ro} onClick={() => set({ crew_create: v })}>{t(`set.policy.crewCreate.${v}`)}</button>)}
        </div>
      </div>
      <div className="msgr-fold">
        <button type="button" className="fold-head" onClick={() => setAdv((v) => !v)} aria-expanded={adv}><h3>{t('set.policy.advanced')}</h3><I name="caret" size={14} className={adv ? 'open' : ''} /></button>
        {adv && (<>
          <div className="q">
            <label className="switchrow"><input type="checkbox" checked={draft.crew_memory_default !== false} disabled={ro} onChange={(e) => set({ crew_memory_default: e.target.checked })} /><span>{t('set.policy.memory2')}</span></label>
            <label className="switchrow"><input type="checkbox" checked={!!draft.crew_memory_locked} disabled={ro} onChange={(e) => set({ crew_memory_locked: e.target.checked })} /><span>{t('set.policy.lock3')}</span></label>
          </div>
          <div className="q">
            <label className="switchrow"><input type="checkbox" checked={!!draft.guest_seats} disabled={ro} onChange={(e) => set({ guest_seats: e.target.checked })} /><span>{t('set.policy.guests.seats')}</span></label>
            <span className="note">{t('set.policy.guests.desc')}</span>
          </div>
          <div className="q">
            <span className="qlabel">{t('set.policy.crewEngine')}</span>
            {nodeRunners.length ? (<>
              <select className="msgr-input inline" value={draft.crew_runner ?? ''} disabled={ro} onChange={(e) => set({ crew_runner: e.target.value || null, crew_model: null })}>
                <option value="">{t('set.policy.crewEngine.default')}</option>
                {nodeRunners.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              {draft.crew_runner && (nodeRunners.find((r) => r.id === draft.crew_runner)?.models ?? []).length > 0 && (
                <select className="msgr-input inline wide" value={draft.crew_model ?? ''} disabled={ro} onChange={(e) => set({ crew_model: e.target.value || null })}>
                  <option value="">{t('set.policy.crewEngine.defaultModel')}</option>
                  {nodeRunners.find((r) => r.id === draft.crew_runner).models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.free ? ` · ${t('set.policy.crewEngine.free')}` : ''}</option>)}
                </select>
              )}
            </>) : (<>
              <input className="msgr-input inline" placeholder={t('set.policy.crewEngine.runner')} value={draft.crew_runner ?? ''} maxLength={32} disabled={ro} onChange={(e) => set({ crew_runner: e.target.value })} />
              <input className="msgr-input inline wide" placeholder={t('set.policy.crewEngine.model')} value={draft.crew_model ?? ''} maxLength={120} disabled={ro} onChange={(e) => set({ crew_model: e.target.value })} />
            </>)}
            <span className="note">{t('set.policy.crewEngine.desc')}</span>
          </div>
          <p className="note">{t('set.policy.limit')}</p>
        </>)}
      </div>
      {isAdmin ? <div className="row"><button type="button" className="btn btn-primary sm" disabled={busy || !dirty} onClick={save}><I name="check" size={13} />{t('ui.save')}</button></div> : <p className="note">{t('set.policy.adminOnly')}</p>}
    </section>
  );
}

function EmptyOrg({ org, onMenu, createOrg, createChannel, invite, joinable = [], joinDomain, deletedOrgs = [], restoreOrg }) {
  const { t } = useT();
  const steps = org ? [
    ['mark', t('ch.step1'), t('ch.step1.sub'), <button key="a" type="button" className="btn btn-primary sm" onClick={createChannel}><I name="hash" size={13} />{t('ch.new')}</button>],
    ['', t('ch.step2'), t('ch.step2.sub'), invite ? <button key="b" type="button" className="btn sm" onClick={invite}><I name="copy" size={13} />{t('org.invite')}</button> : null],
    ['', t('ch.step3'), t('ch.step3.sub'), null],
  ] : [
    ...(deletedOrgs.length ? [['', t('org.step.restore'), t('org.step.restore.sub'), <div key="r" className="msgr-chips">{deletedOrgs.map((o) => <button key={o.id} type="button" className="msgr-chan" onClick={() => restoreOrg(o)}><span>{o.name}</span><span className="msgr-klabel">{t('org.restore.cta', { days: Math.max(0, Math.ceil((Date.parse(o.purge_at) - Date.now()) / 86_400_000)) })}</span></button>)}</div>]] : []), // J-5
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
function Channel({ channel, orgId, org, uid, isAdmin, locked = false, policy, members, crews, people = [], chCrews = [], nameOfUser, crewOf, event, typing, progress = {}, onRead, muted = false, broadcast, onError, onMenu, onCrew, onTitle, onCrewAdd, mentionReq, onMentionDone, dmName }) {
  const { t, lang } = useT();
  const [msgs, setMsgs] = useState(null); const [aps, setAps] = useState({}); const [atts, setAtts] = useState({});
  const [tab, setTab] = useState('all');
  const feed = useRef(null);
  const [sbw, setSbw] = useState(0); // 스레드 스크롤바 폭의 절반 — 독 좌우를 대화 열과 맞춘다(오버레이 스크롤바면 0)
  useEffect(() => { const el = feed.current; if (!el) return; const m = () => setSbw((el.offsetWidth - el.clientWidth) / 2); m(); window.addEventListener('resize', m); return () => window.removeEventListener('resize', m); }, []);
  const chId = channel.id;
  const load = useCallback(async (afterId = 0) => {
    const rows = await q(supabase.from('msgr_messages').select('id, author_kind, author_user_id, crew_id, kind, body, mentions, reply_to, created_at, edited_at, deleted_at, meta')
      .eq('channel_id', chId).gt('id', afterId).order('id', { ascending: afterId ? true : false }).limit(PAGE));
    const list = afterId ? rows : rows.reverse();
    setMsgs((cur) => { const base = cur ?? []; const seen = new Set(base.map((m) => m.id)); return afterId ? [...base, ...list.filter((m) => !seen.has(m.id))] : list; });
    const ids = list.map((m) => m.id);
    if (ids.length) {
      const a = await q(supabase.from('msgr_attachments').select('id, message_id, storage_path, name, mime, bytes').in('message_id', ids));
      setAtts((cur) => { const n = { ...cur }; for (const r of a) (n[r.message_id] ??= []).push(r); return n; });
      const rx = await q(supabase.from('msgr_reactions').select('message_id, user_id, emoji').in('message_id', ids));
      setReacts((cur) => { const n = { ...cur }; for (const id of ids) n[id] = []; for (const r of rx) (n[r.message_id] ??= []).push(r); return n; });
    }
    if (!afterId) { const rd = await q(supabase.from('msgr_reads').select('last_read_id').eq('channel_id', chId).eq('user_id', uid).maybeSingle()).catch(() => null); setDivider(rd?.last_read_id ?? 0); } // 새 메시지 구분선 기준 — 열 때 한 번 고정
    const apRows = await q(supabase.from('msgr_crew_approvals').select('id, crew_id, approval_id, action, reason, status, decided_by, decided_at, message_id, risk, kind, payload').eq('channel_id', chId));
    setAps(Object.fromEntries(apRows.map((r) => [r.id, r])));
  }, [chId]);
  useEffect(() => { load().catch((e) => onError(e.message)); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const [reacts, setReacts] = useState({}); const [divider, setDivider] = useState(0); // 반응(메시지별)·새 메시지 구분선(열 때의 읽음 커서)
  const reloadReacts = useCallback(async (id) => { const rx = await q(supabase.from('msgr_reactions').select('message_id, user_id, emoji').eq('message_id', id)); setReacts((cur) => ({ ...cur, [id]: rx })); }, []);
  const reloadMsg = useCallback(async (id) => { const row = await q(supabase.from('msgr_messages').select('id, author_kind, author_user_id, crew_id, kind, body, mentions, reply_to, created_at, edited_at, deleted_at, meta').eq('id', id).maybeSingle()); if (row) setMsgs((cur) => (cur ?? []).map((m) => (m.id === id ? row : m))); }, []);
  const toggleReact = async (m, emoji) => { try { const mine = (reacts[m.id] ?? []).some((r) => r.user_id === uid && r.emoji === emoji); if (mine) await q(supabase.from('msgr_reactions').delete().eq('message_id', m.id).eq('user_id', uid).eq('emoji', emoji)); else await q(supabase.from('msgr_reactions').insert({ message_id: m.id, user_id: uid, emoji })); await reloadReacts(m.id); broadcast?.('reaction', { channel_id: chId, message_id: m.id }); } catch (e) { onError(e.message); } };
  const editMsg = async (m, body) => { try { await q(supabase.from('msgr_messages').update({ body, edited_at: new Date().toISOString() }).eq('id', m.id)); await reloadMsg(m.id); broadcast?.('edit', { channel_id: chId, message_id: m.id }); } catch (e) { onError(e.message); } };
  const deleteMsg = async (m) => { try { await q(supabase.from('msgr_messages').update({ body: '', deleted_at: new Date().toISOString() }).eq('id', m.id)); await reloadMsg(m.id); broadcast?.('edit', { channel_id: chId, message_id: m.id }); } catch (e) { onError(e.message); } };
  const lastId = msgs?.at(-1)?.id ?? 0;
  useEffect(() => {
    if (!event) return;
    if ((event.kind === 'message' || event.kind === 'approval') && event.channel_id === chId) load(lastId).catch(() => {});
    if (event.kind === 'reaction' && event.channel_id === chId && event.message_id) reloadReacts(event.message_id).catch(() => {});
    if (event.kind === 'edit' && event.channel_id === chId && event.message_id) reloadMsg(event.message_id).catch(() => {});
  }, [event]); // eslint-disable-line react-hooks/exhaustive-deps
  const stick = useRef(true); // 바닥 고정 여부 — 사용자가 바닥에서 40px 넘게 올려두면 false(QA: 열릴 때 30px 모자라게 멈춰 마지막 메시지가 가려졌다)
  useEffect(() => { stick.current = true; }, [chId]);
  useEffect(() => {
    const el = feed.current; if (!el) return;
    // 고정 해제는 사용자 의도(휠·터치·키·스크롤바 드래그)가 있을 때만 — 프로그램 스크롤(toBottom) 뒤 늦게 도착한 scroll 이벤트가
    // 그 사이 자란 내용(실행 카드·Markdown 지연 렌더) 때문에 gap≥40으로 읽혀 고정을 풀던 경합(실측 2026-09-09: gap 294px에서 멈춤).
    let userAt = 0; let dragging = false;
    const mark = () => { userAt = Date.now(); };
    const onScroll = () => { const gap = el.scrollHeight - el.scrollTop - el.clientHeight; if (gap < 40) stick.current = true; else if (dragging || Date.now() - userAt < 600) stick.current = false; };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', mark, { passive: true }); el.addEventListener('touchmove', mark, { passive: true }); el.addEventListener('keydown', mark);
    const down = () => { dragging = true; }; const up = () => { dragging = false; };
    el.addEventListener('pointerdown', down); window.addEventListener('pointerup', up);
    const toBottom = () => { if (stick.current) el.scrollTop = el.scrollHeight; };
    const ro = new ResizeObserver(toBottom); // 렌더 뒤 높이 변화(Markdown·첨부·타이핑 표시)에도 바닥을 따라간다
    const spine = el.firstElementChild; if (spine) ro.observe(spine);
    toBottom();
    return () => { el.removeEventListener('scroll', onScroll); el.removeEventListener('wheel', mark); el.removeEventListener('touchmove', mark); el.removeEventListener('keydown', mark); el.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); ro.disconnect(); };
  }, [chId]);
  useEffect(() => { const el = feed.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [msgs?.length]);
  useEffect(() => { if (!lastId) return; const mark = () => { if (document.visibilityState !== 'hidden') onRead?.(chId, lastId); }; mark(); document.addEventListener('visibilitychange', mark); return () => document.removeEventListener('visibilitychange', mark); }, [chId, lastId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 폴링 폴백(10s) — Realtime이 끊기거나 구독이 거부돼도 새 메시지가 화면에 도달한다(정본은 언제나 조회, 방송은 깨우기 신호)
  useEffect(() => { const iv = setInterval(() => load(lastId).catch(() => {}), 10_000); return () => clearInterval(iv); }, [load, lastId]);
  const decide = async (ap, status) => {
    const res = await supabase.from('msgr_crew_approvals').update({ status, decided_by: uid, decided_at: new Date().toISOString() }).eq('id', ap.id).select('id');
    if (res.error) return onError(res.error.message);
    if (!res.data?.length) return onError(t(ap.risk === 'high' ? 'ap.approverOnly' : 'ap.ownerOnly')); // RLS 0행 = 결재권 없음(최종 판정은 서버 msgr_can_decide)
    load(lastId).catch(() => {});
  };
  const typingCrews = Object.entries(typing).filter(([k, at]) => k.startsWith(`${chId}:`) && Date.now() - at < 6000).map(([k]) => crewOf(k.split(':')[1])).filter(Boolean);
  // 실행 카드 — progress 방송(1.5초 주기)이 있는 크루는 점 세 개 대신 단계·도구·사고 과정 카드. 8초 무갱신이면 만료(브리지 심박 30초는 typing이 덮는다).
  const working = Object.entries(progress).filter(([k, p]) => k.startsWith(`${chId}:`) && Date.now() - p.at < 8000 && typing[k] && Date.now() - typing[k] < 6000).map(([k, p]) => [crewOf(k.split(':')[1]), p]).filter(([c]) => c);
  const workingIds = new Set(working.map(([c]) => c.id));
  const apOf = (m) => m.kind === 'approval_card' ? aps[(m.mentions ?? []).find((x) => x.kind === 'approval')?.id] : null;
  const isMention = (m) => (m.mentions ?? []).some((x) => x.kind === 'user' && x.id === uid);
  const all = msgs ?? [];
  // 배지 수와 탭 모수는 같은 술어(검수 M2): 결재 탭 = 대기 중인 결재만
  const isPending = (m) => apOf(m)?.status === 'pending';
  const counts = { mention: all.filter(isMention).length, approval: all.filter(isPending).length, crew: all.filter((m) => m.author_kind === 'crew').length };
  const shown = all.filter((m) => tab === 'all' || (tab === 'mention' && isMention(m)) || (tab === 'approval' && isPending(m)) || (tab === 'crew' && m.author_kind === 'crew'));
  const rows = []; let day = null; let newLine = false;
  for (const m of shown) {
    if (divider > 0 && !newLine && m.id > divider && !(m.author_kind === 'user' && m.author_user_id === uid)) { newLine = true; rows.push(<div key="newline" className="msgr-newline"><span>{t('msg.new')}</span></div>); }
    const k = dayKey(m.created_at);
    if (k !== day) { day = k; const [d, w] = fmtDay(m.created_at, lang); const today = k === new Date().toDateString(); rows.push(<div key={`d${k}`} className="msgr-tnode"><span className={`msgr-dot${today ? ' mark' : ''}`} /><span className="msgr-klabel"><b>{d}</b> {w}</span></div>); }
    rows.push(<Message key={m.id} m={m} uid={uid} lang={lang} t={t} nameOfUser={nameOfUser} crewOf={crewOf} isAdmin={isAdmin} policy={policy} ap={apOf(m)} atts={atts[m.id] ?? []} decide={decide} parent={m.reply_to ? all.find((x) => x.id === m.reply_to) : null} onCrew={onCrew} onError={onError} reacts={reacts[m.id] ?? []} onReact={toggleReact} onEdit={editMsg} onDelete={deleteMsg} />);
  }
  const tabs = [['all', null, 0], ['mention', 'at', counts.mention], ['approval', 'stamp', counts.approval], ['crew', 'star', counts.crew]];
  return (<>
    <div className="msgr-top">
      <button type="button" className="msgr-menu" onClick={onMenu} aria-label={t('ui.menu')}><I name="menu" /></button>
      <button type="button" className="title msgr-titlebtn" onClick={onTitle} title={t('ch.sheet')}><I name={channel.kind === 'private' ? 'lock' : channel.kind === 'dm' ? 'at' : 'hash'} size={18} />{channel.kind === 'dm' ? dmName(channel) : channel.name}<I name="caret" size={13} className="caret" /></button>
      {channel.topic && <span className="topic">{channel.topic}</span>}
      {muted && <span className="msgr-klabel" title={t('ch.muted')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><I name="belloff" size={13} />{t('ch.muted')}</span>}
      {channel.crew_memory === false && <span className="msgr-klabel" title={t('ch.crewMemory')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><I name="memoff" size={13} />{t('ch.memoryOff')}</span>}
      <button type="button" className="members" onClick={onTitle} title={t('ch.composition')} aria-label={t('ch.composition')}>{people.slice(0, 4).map((m) => <Av key={m.user_id} name={m.display_name || m.user_id} size="sm" />)}{chCrews.slice(0, 3).map((c) => <Av key={c.id} name={c.display_name} crew size="sm" company={crewTier(c, org) === 'company'} />)}<span className="n">{t('ch.composition.count', { p: people.length, c: chCrews.length })}</span></button>
      {channel.kind !== 'dm' && <button type="button" className="btn sm crewbtn" onClick={onCrewAdd} title={t('ch.crews.btn.title')}><I name="star" size={13} />{t('ch.crews.btn')}</button>}
      <div className="msgr-seg" role="tablist">{tabs.map(([k, ic, n]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{ic && <I name={ic} size={13} />}{t(`tab.${k}`)}{n > 0 && <span className="n">{n}</span>}</button>)}</div>
    </div>
    <div className="msgr-thread" ref={feed}>
      <div className="msgr-spine">
        {msgs === null && <div className="msgr-row ghost"><span className="msgr-av" /><div className="msgr-skel"><i /><i /><i /></div></div>}
        {msgs !== null && !all.length && <div className="msgr-row ghost"><span className="msgr-av" /><div className="msgr-sys">{t('ch.empty')}</div></div>}
        {rows}
        {working.map(([c, p]) => <ExecCard key={`exec-${c.id}`} crew={c} p={p} t={t} />)}
        {typingCrews.filter((c) => !workingIds.has(c.id)).map((c) => <div key={`typing-${c.id}`} className="msgr-row"><Av name={c.display_name} crew /><div><div className="who">{c.display_name}<span className="role">{c.role_text}</span></div><div className="msgr-typing"><i /><i /><i /></div></div></div>)}
      </div>
    </div>
    <Composer chId={chId} orgId={orgId} org={org} uid={uid} members={members} crews={crews} channel={channel} locked={locked} sbw={sbw} typingCrews={typingCrews} mentionReq={mentionReq} onMentionDone={onMentionDone} onSent={() => load(lastId).catch(() => {})} onError={onError} />
  </>);
}

/** 슬랙식 반응 피커 — 검색 + 자주 사용 + 분류. 선택·Esc·바깥 클릭으로 닫힘. */
function EmojiPicker({ t, onPick, onClose }) {
  const [q, setQ] = useState(''); const ref = useRef(null);
  useEffect(() => { const off = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); }; const key = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('mousedown', off); document.addEventListener('keydown', key); return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', key); }; }, [onClose]);
  const hits = searchEmoji(q);
  const grid = (list, key) => <div key={key} className="grid">{list.map((e) => <button key={e} type="button" onClick={() => onPick(e)} title={e}>{e}</button>)}</div>;
  return (
    <div className="msgr-emojipop" ref={ref} role="dialog" aria-label={t('msg.react')} onClick={(e) => e.stopPropagation()}>
      <input className="msgr-input sm" placeholder={t('emoji.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="body">
        {hits ? (hits.length ? grid(hits, 'hits') : <p className="msgr-sys">{t('emoji.none')}</p>) : (<>
          <div className="msgr-klabel">{t('emoji.frequent')}</div>{grid(topEmoji(8), 'freq')}
          {EMOJI_GROUPS.map((g) => <div key={g.key} className="sec"><div className="msgr-klabel">{t(`emoji.${g.key}`)}</div>{grid(g.items.map(([e]) => e), g.key)}</div>)}
        </>)}
      </div>
    </div>
  );
}
function Message({ m, uid, lang, t, nameOfUser, crewOf, isAdmin, policy, ap, atts, decide, parent, onCrew, onError, reacts = [], onReact, onEdit, onDelete }) {
  const [copied, setCopied] = useState(false);
  const [pick, setPick] = useState(false); const [editing, setEditing] = useState(false); const [draft, setDraft] = useState(''); const [confirmDel, setConfirmDel] = useState(false);
  const groups = Object.entries(reacts.reduce((acc, r) => { (acc[r.emoji] ??= []).push(r.user_id); return acc; }, {}));
  const chips = groups.length > 0 && <div className="msgr-reacts">{groups.map(([e, users]) => <button key={e} type="button" className={users.includes(uid) ? 'on' : ''} onClick={() => onReact?.(m, e)} title={users.map((u) => nameOfUser(u)).join(', ')}>{e}<span>{users.length}</span></button>)}</div>;
  const react = (e) => { bumpEmoji(e); onReact?.(m, e); };
  const picker = pick && <EmojiPicker t={t} onPick={(e) => { setPick(false); react(e); }} onClose={() => setPick(false)} />;
  const quick = topEmoji(3);
  const edited = m.edited_at && !m.deleted_at && <span className="msgr-klabel">{t('msg.edited')}</span>;
  const crew = m.crew_id ? crewOf(m.crew_id) : null;
  const name = m.author_kind === 'user' ? nameOfUser(m.author_user_id) : (crew?.display_name ?? t('org.crews'));
  const body = m.deleted_at ? '' : m.body;
  const copy = () => { navigator.clipboard?.writeText(body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); };
  const mine = m.author_kind === 'user' && m.author_user_id === uid;
  const quote = parent && <div className="msgr-quote"><I name="reply" size={13} /><span className="q">{parent.author_kind === 'user' ? nameOfUser(parent.author_user_id) : crewOf(parent.crew_id)?.display_name}: {parent.body}</span></div>; // 긴 원문은 한 줄 말줄임(QA: 카드 밖으로 잘림)
  const attRow = atts.length > 0 && <div>{atts.map((a) => <Attachment key={a.id} a={a} onError={onError} />)}</div>;
  const acts = !ap && !m.deleted_at && !editing && (
    <div className="msgr-acts">
      <button type="button" onClick={copy}><I name="copy" size={12} />{copied ? t('ui.copied') : t('ui.copy')}</button>
      {quick.map((e) => <button key={e} type="button" className="quick" onClick={() => react(e)} title={t('msg.react')}>{e}</button>)}
      <button type="button" onClick={() => setPick((v) => !v)} aria-expanded={pick}><I name="star" size={12} />{t('msg.react')}</button>
      {mine && m.kind === 'text' && <button type="button" onClick={() => { setDraft(m.body); setEditing(true); }}><I name="gear" size={12} />{t('ui.edit')}</button>}
      {mine && (confirmDel ? <button type="button" className="danger" onClick={() => { setConfirmDel(false); onDelete?.(m); }}><I name="x" size={12} />{t('msg.delete.confirm')}</button> : <button type="button" onClick={() => setConfirmDel(true)}><I name="x" size={12} />{t('ui.delete')}</button>)}
      {picker}
    </div>
  );
  const editor = editing && (
    <form className="msgr-editbox" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) onEdit?.(m, draft.trim()); setEditing(false); }}>
      <textarea className="msgr-input" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form.requestSubmit(); } }} autoFocus />
      <div className="acts"><button type="submit" className="btn btn-primary sm" disabled={!draft.trim()}>{t('ui.save')}</button><button type="button" className="btn sm" onClick={() => setEditing(false)}>{t('ui.cancel')}</button></div>
    </form>
  );
  if (mine) return ( // 내 글 — 척추 반대편 차콜 버블(20/6/20/20)
    <div className="msgr-mine">
      {editing ? editor : <div className="bubble">{quote}{m.deleted_at ? <i>{t('msg.deleted')}</i> : <Body text={body} />}</div>}
      {attRow}
      {chips}
      <div className="meta">{edited}<I name="check" size={12} /><span className="mono">{fmtTs(m.created_at, lang)}</span></div>
      {acts}
    </div>
  );
  const isCrew = m.author_kind === 'crew';
  return ( // 동료·크루 글 — 척추 위 아바타(사람 원 / 크루 타일), 크루 답은 척추에 붙는 시트
    <div className="msgr-row">
      {isCrew && crew ? <button type="button" className="msgr-avbtn" onClick={() => onCrew?.(crew.id)} title={t('crew.sheet')}><Av name={name} crew /></button> : <Av name={name} crew={isCrew} />}
      <div style={{ minWidth: 0 }}>
        <div className="who">{isCrew && crew ? <button type="button" className="msgr-namebtn" onClick={() => onCrew?.(crew.id)}>{name}</button> : name}{edited}{crew?.role_text && <span className="role">{crew.role_text} · {t('org.crews')}</span>}<span className="ts">{fmtTs(m.created_at, lang)}</span></div>
        {m.deleted_at ? <div className="msgr-sys">{t('msg.deleted')}</div>
          : ap ? <Slip ap={ap} uid={uid} lang={lang} t={t} crew={crew} nameOfUser={nameOfUser} decide={decide} isAdmin={isAdmin} policy={policy} />
          : m.kind === 'system' ? <div className="msgr-sys">{body}</div>
          : isCrew ? <div className="msgr-sheet">{quote}{m.meta?.trace && <Trace trace={m.meta.trace} t={t} />}<Markdown text={body} /></div>
          : <div className="text">{quote}<Body text={body} /></div>}
        {attRow}
        {chips}
        {acts}
      </div>
    </div>
  );
}

/** 단계 라벨 — 서버는 코드만 남기고 여기서 번역(아르고 stageLabel과 같은 규칙). */
function stageLabel(t, stage, detail = '') { if (!stage) return t('chat.stage.work'); return stage === 'runner' ? t('chat.stage.runner', { name: detail || '' }) : t(`chat.stage.${stage}`); }
const fmtSec = (ms) => `${Math.max(0, Math.round((ms ?? 0) / 100) / 10)}s`;
/** 단계 목록 — 클로드코드의 도구 라벨처럼 한 줄에 단계·디테일·시각. */
function StepList({ steps = [], t }) {
  if (!steps.length) return null;
  return <ol className="msgr-steps">{steps.map((s, i) => <li key={i}><span className="mono">{fmtSec(s.t)}</span><span className="st">{stageLabel(t, s.stage, s.detail)}</span>{s.detail && s.stage !== 'runner' && <span className="dt mono" title={s.detail}>{s.detail}</span>}</li>)}</ol>;
}
/** 실행 카드 — 크루가 일하는 동안 점 세 개 대신 단계·경과·도구 단계·사고 과정·부분 텍스트를 드롭다운으로(유건 요청 2026-09-09: 클로드코드·코덱스처럼 실시간). */
function ExecCard({ crew, p, t }) {
  const [, tick] = useState(0);
  useEffect(() => { const iv = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(iv); }, []);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('argo-msgr-exec-open') !== '0'; } catch { return true; } });
  const toggle = (e) => { setOpen(e.currentTarget.open); try { localStorage.setItem('argo-msgr-exec-open', e.currentTarget.open ? '1' : '0'); } catch {} };
  const elapsed = Math.max(0, Date.now() - (p.startedAt ?? p.at));
  const tools = (p.steps ?? []).filter((s) => s.stage !== 'think' && s.stage !== 'boot' && s.stage !== 'runner').length;
  return (
    <div className="msgr-row">
      <Av name={crew.display_name} crew />
      <div style={{ minWidth: 0 }}>
        <div className="who">{crew.display_name}<span className="role">{crew.role_text}</span></div>
        <details className="msgr-exec" open={open} onToggle={toggle}>
          <summary><span className="msgr-dot mark pulse" /><span className="st">{stageLabel(t, p.stage, p.detail)}</span>{p.detail && p.stage !== 'runner' && <span className="dt mono">{p.detail}</span>}<span className="msgr-klabel">{t('exec.meta', { s: fmtSec(elapsed), n: tools })}</span><I name="caret" size={12} className="caret" /></summary>
          <div className="body">
            {p.thought && <div className="sec"><div className="msgr-klabel">{t('exec.thought')}</div><pre className="thought">{p.thought}</pre></div>}
            <div className="sec"><div className="msgr-klabel">{t('exec.steps')}</div><StepList steps={p.steps} t={t} />{!(p.steps ?? []).length && <div className="msgr-sys">{t('exec.noSteps')}</div>}</div>
            {p.partial && <div className="sec"><div className="msgr-klabel">{t('exec.partial')}</div><Markdown text={p.partial} /></div>}
          </div>
        </details>
      </div>
    </div>
  );
}
/** 궤적 — 완료된 답글 위의 접힌 '사고 과정 · 도구 N회 · 경과' 드롭다운(기본 접힘). */
function Trace({ trace, t }) {
  const steps = trace.steps ?? [];
  const tools = steps.filter((s) => s.stage !== 'think' && s.stage !== 'boot' && s.stage !== 'runner').length;
  if (!steps.length && !trace.thought) return null;
  return (
    <details className="msgr-trace">
      <summary><I name="star" size={12} /><span>{t('trace.summary', { s: fmtSec(trace.ms), n: tools })}</span>{trace.model && <span className="msgr-klabel mono">{trace.model}</span>}<I name="caret" size={12} className="caret" /></summary>
      <div className="body">
        {trace.thought && <div className="sec"><div className="msgr-klabel">{t('exec.thought')}</div><pre className="thought">{trace.thought}</pre></div>}
        {steps.length > 0 && <div className="sec"><div className="msgr-klabel">{t('exec.steps')}</div><StepList steps={steps} t={t} /></div>}
      </div>
    </details>
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
function Composer({ chId, orgId, org, uid, members, crews, channel, locked = false, sbw = 0, typingCrews, mentionReq, onMentionDone, onSent, onError }) {
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
  const mentionCrew = (c) => { // 채널 시트 "@로 부르기" — 작성창 끝에 멘션을 넣는다(공개 채널은 이것이 '추가')
    const name = c.display_name ?? c.name; const base = text && !/\s$/.test(text) ? `${text} ` : text; const next = `${base}@${name} `;
    setText(next); setMentions((ms) => ms.some((x) => x.id === c.id) ? ms : [...ms, { kind: 'crew', id: c.id, name }]);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(next.length, next.length); autosize(ta.current); });
  };
  useEffect(() => { if (!mentionReq) return; mentionCrew(mentionReq); onMentionDone?.(); }, [mentionReq]); // eslint-disable-line react-hooks/exhaustive-deps
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
