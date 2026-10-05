// 공유·게시 창과 "크루에게 맡기기" 창.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, showToast } from './Overlay.jsx';
import { Sheet } from './Panel.jsx';
import { Icon } from './Icon.jsx';
import { Face } from './Face.jsx';
import { t, ago, useLang, registerDict } from '../core/i18n.js';
import { useUi, setUi } from '../core/ui-state.js';
import { useStore, assign, sendToCrew, update, getState } from '../core/store.js';
import { crewsIn } from '../core/crew-list.js';
import { imeGuardWith } from '../core/ime.js';
import { SPACES, ME, getMode } from '../core/session.js';
import { getClient } from '../core/supabase.js';
import { baseOf } from '../core/commands.js';
import { flushNow, outbox } from '../core/sync.js';
import { loadPageContent } from '../core/pull.js';
import { readMail } from '../core/mail.js';
import { composeAssign, composeSet, composeTools, htmlText, docText, mentionAt, mentionCands, putMention, maskedNote, assignTarget } from '../core/crew-assign.js';
import { openExternal } from '../core/platform.js';
import { FAMILY } from '../core/family.js';
import { hideAllOn } from '../core/hide-all.js';
import { rpc } from '../core/tasks.js';
import { DocView } from './DocView.jsx';
import { publicWebUrl } from '../core/platform.js';
import { DIALOG_DICT } from './dialogs-i18n.js';
import { Hide } from '../business/Redact.jsx';

registerDict(DIALOG_DICT);

/** 서버에서 공유 상태를 읽는다 — 사람 목록 RPC가 거절되면 이 사람은 전체 권한이 아니다(서버가 기준). */
async function loadShare(id) {
  const sb = await getClient();
  if (!sb || getMode() !== 'signedIn') return 'sample';
  const [people, link] = await Promise.all([
    sb.rpc('office_page_people', { p_page: id }),
    sb.from('office_shares').select('link_token, published, allow_index').eq('page_id', id).eq('principal_kind', 'link').maybeSingle(),
  ]);
  if (people.error) return 'denied';
  return { people: people.data ?? [], link: link.data ?? null };
}

export function ShareDialog() {
  useLang();
  const { share } = useUi();
  const page = useStore((s) => s.pages.find((p) => p.id === share));
  const [tab, setTab] = useState('share');
  const [st, setSt] = useState(null);                          // null 불러오는 중 | 'sample' | 'denied' | { people, link }
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  // 바꿀 때마다 서버에서 다시 읽는다. 늦게 도착한 옛 응답이 새 상태를 덮지 않게 마지막 요청만 반영(9/27 실측: 역할 변경 뒤 게시가 꺼져 보임)
  const refresh = (id = share) => { const n = ++seq.current; return loadShare(id).then((v) => n === seq.current && setSt(v)).catch(() => n === seq.current && setSt('denied')); };
  useEffect(() => {
    if (!share) return undefined;
    setTab('share'); setEmail(''); setSt(null);
    refresh(share);
    return () => { seq.current++; };                          // 창을 닫거나 바꾸면 진행 중 응답을 버린다
  }, [share]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!page) return null;
  const sp = SPACES.find((s) => s.key === page.space);
  const isOrg = sp?.kind === 'org';
  const pageUrl = publicWebUrl(`${baseOf(page.space)}/p/${page.id}`);
  const pubUrl = st?.link?.link_token ? publicWebUrl(`/s/${st.link.link_token}`) : '';
  const can = st && typeof st === 'object';
  const call = async (fn, args) => {
    setBusy(true);
    try { const sb = await getClient(); const { data, error } = await sb.rpc(fn, args); if (error) throw error; return { data }; }
    catch { showToast(t('share.failed')); return null; }
    finally { setBusy(false); }
  };
  const invite = async () => {
    const q = email.trim().toLowerCase();
    if (!q) return;
    const found = await call('msgr_find_user', { q });
    if (!found) return;
    const u = (found.data ?? []).find((x) => q.includes('@') || x.handle === q);  // 아이디는 앞부분이 아니라 정확히 같을 때만
    if (!u) { showToast(t('share.notFound')); return; }
    if (await call('office_share_set', { p_page: page.id, p_user: u.user_id, p_role: 'view' })) { setEmail(''); refresh(); }
  };
  const setRole = async (userId, role) => { if (await call('office_share_set', { p_page: page.id, p_user: userId, p_role: role || null })) refresh(); };
  const setGeneral = async (g) => {
    if (await call('office_page_set_general', { p_page: page.id, p_general: g })) update((s) => ({ pages: s.pages.map((p) => (p.id === page.id ? { ...p, general: g } : p)) }));
  };
  const publish = async (on) => { if (await call('office_page_publish', { p_page: page.id, p_on: on })) refresh(); };
  const setIndex = async (on) => { if (await call('office_page_set_index', { p_page: page.id, p_on: on })) refresh(); };
  const copy = async (url) => { try { await navigator.clipboard.writeText(url); showToast(t('page.linkCopied')); } catch { showToast(url); } };
  const roleSelect = (value, onChange) => (
    <select className="select" value={value} disabled={busy} onChange={(e) => onChange(e.target.value)}>
      {['full', 'edit', 'view'].map((r) => <option key={r} value={r}>{t(`share.role.${r}`)}</option>)}
      <option value="">{t('share.remove')}</option>
    </select>
  );
  const note = st === 'sample' ? t('share.sample') : st === 'denied' ? t('share.readOnly') : null;
  return (
    <Modal open onClose={() => setUi({ share: null })} title={page.title || t('page.untitled')} width={520}
      footer={<><button type="button" className="btn ghost" onClick={() => copy(pageUrl)}><Icon name="link" size={14} />{t('share.copy')}</button><button type="button" className="btn primary" onClick={() => setUi({ share: null })}>{t('close')}</button></>}>
      <div className="tabs" role="tablist">
        {['share', 'publish'].map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}>{t(k === 'share' ? 'share.title' : 'share.publish')}</button>)}
      </div>
      {note && <p className="dim small share-note"><Icon name="lock" size={12} /> {note}</p>}
      {!st && <div className="share skeleton-lines" aria-busy="true"><span /><span /></div>}
      {can && (tab === 'share' ? <div className="share">
        <div className="invite"><input className="input" value={email} placeholder={t('share.invitePh')} onChange={(e) => setEmail(e.target.value)} {...imeGuardWith((e) => { if (e.key === 'Enter') invite(); })} /><button type="button" className="btn primary" disabled={busy || !email.trim()} onClick={invite}>{t('share.invite')}</button></div>
        <div className="people">
          <div className="person"><span className="avatar">{ME.name[0]}</span><span className="person-main"><b>{ME.name} ({t('share.you')})</b><small><Hide k="mail:me">{ME.email}</Hide></small></span><span className="dim small">{t('share.role.full')}</span></div>
          {st.people.filter((p) => p.user_id !== ME.id).map((p) => <div key={p.user_id} className="person"><span className="avatar">{(p.name || '?')[0]}</span><span className="person-main"><b>{p.name}</b></span>{roleSelect(p.role, (r) => setRole(p.user_id, r))}</div>)}
        </div>
        <div className="field-block">
          <span className="label">{t('share.general')}</span>
          <div className="general">
            <Icon name={page.general === 'invited' || !isOrg ? 'lock' : 'person'} />
            {isOrg ? <select className="select grow" value={page.general ?? 'org_edit'} disabled={busy} onChange={(e) => setGeneral(e.target.value)}>
              <option value="invited">{t('share.g.invited')}</option>
              <option value="org_view">{t('share.g.org', { org: sp.name })}</option>
              <option value="org_edit">{t('share.g.orgEdit', { org: sp.name })}</option>
            </select> : <span className="grow">{t('share.g.invited')}</span>}
          </div>
        </div>
      </div> : <div className="share">
        <label className="switch-row"><span><b>{t('share.pubOn')}</b><small>{t('share.pubDesc')}</small></span><input type="checkbox" role="switch" disabled={busy} checked={!!st.link?.published} onChange={(e) => publish(e.target.checked)} /></label>
        {st.link?.published && <>
          <div className="url-row"><Icon name="globe" size={14} /><a href={pubUrl} target="_blank" rel="noopener">{pubUrl}</a><button type="button" className="btn sm" onClick={() => copy(pubUrl)}>{t('share.copy')}</button></div>
          <label className="switch-row"><span><b>{t('share.index')}</b></span><input type="checkbox" role="switch" disabled={busy} checked={!!st.link.allow_index} onChange={(e) => setIndex(e.target.checked)} /></label>
          {isOrg && <p className="dim small"><Icon name="layout" size={12} /> {t('share.logo', { org: sp.name })}</p>}
          <p className="dim small"><Icon name="lock" size={12} /> {t('share.hidden')}</p>
        </>}
      </div>)}
    </Modal>
  );
}

/** 버전 기록 — 10분 넘게 쉬었다 고치거나 되돌릴 때 서버가 남긴 모습. 되돌리기도 되돌릴 수 있다(되돌리기 직전 모습이 남는다). */
export function HistorySheet() {
  useLang();
  const { history: id } = useUi();
  const page = useStore((s) => s.pages.find((p) => p.id === id));
  const [rows, setRows] = useState(null);                       // null 불러오는 중 | 'sample' | 목록
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const load = async () => {
    const n = ++seq.current;
    const sb = await getClient();
    if (!sb || getMode() !== 'signedIn') { if (n === seq.current) setRows('sample'); return; }
    const { data, error } = await sb.from('office_page_versions').select('version, title, created_at').eq('page_id', id).order('version', { ascending: false }).limit(100);
    if (n === seq.current) setRows(error ? [] : data);
  };
  useEffect(() => { if (!id) return undefined; setRows(null); setSel(null); load(); return () => { seq.current++; }; }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!id || !page) return null;
  const preview = async (v) => {
    const sb = await getClient();
    const { data } = await sb.from('office_page_versions').select('version, title, content').eq('page_id', id).eq('version', v).maybeSingle();
    if (data) setSel(data);
  };
  const restore = async (v, undoing = false) => {
    setBusy(true);
    try {
      await flushNow();                                          // 안 보낸 편집이 있으면 먼저 보낸다 — 못 보내면 되돌리지 않는다(되돌린 뒤 옛 편집이 덮으면 안 된다)
      if (outbox.has(`page:${id}`) || outbox.has(`page-create:${id}`)) { showToast(t('history.pending')); return; }
      const prev = page.version;
      const sb = await getClient();
      const { data, error } = await sb.rpc('office_page_restore', { p_id: id, p_version: v });
      if (error) throw error;
      update((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, version: data } : p)) }));
      await loadPageContent(id, { force: true });
      setSel(null); load();
      if (!undoing) showToast(t('history.restored', { n: v }), { undo: () => restore(prev, true) });
    } catch { showToast(t('history.failed')); }
    finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={() => setUi({ history: null })} title={t('page.history')}>
      {rows === null ? <div className="skeleton-lines" aria-busy="true"><span /><span /></div>
        : rows === 'sample' ? <p className="dim small">{t('history.sample')}</p>
          : !rows.length ? <div className="empty-state"><Icon name="history" size={20} /><p>{t('history.empty')}</p></div>
            : <div className="history">
              <div className="list">{rows.map((r) => (
                <button key={r.version} type="button" className={`list-row${sel?.version === r.version ? ' on' : ''}`} onClick={() => preview(r.version)}>
                  <Icon name="history" size={14} className="dim" /><span className="grow">{r.title || t('page.untitled')}</span><small className="dim">{t('history.version', { n: r.version })} · {ago(r.created_at)}</small>
                </button>))}
              </div>
              {sel ? <div className="history-preview">
                <article className="prose"><DocView doc={sel.content} /></article>
                <button type="button" className="btn primary" disabled={busy} onClick={() => restore(sel.version)}>{t('history.restore')}</button>
              </div> : <p className="dim small">{t('history.pick')}</p>}
            </div>}
    </Sheet>
  );
}

const TASKS = ['summary', 'todos', 'reply', 'custom'];

export function AssignSheet() {
  useLang();
  const { assign: a } = useUi();
  const [crew, setCrew] = useState(null);
  const [task, setTask] = useState('summary');
  const [text, setText] = useState('');
  const [at, setAt] = useState(null), [hi, setHi] = useState(0); // '@' 후보 목록이 열린 자리({ start, q, caret })와 강조한 줄
  const box = useRef(null), shut = useRef(-1); // shut: Esc로 닫은 '@'의 자리 — 키를 뗄 때(onSelect) 다시 열지 않게
  const [sets, setSets] = useState([]), [setId, setSetId] = useState(''); // 업무 세트(4단계) — 고르면 노하우·도구·점검 목록이 글에 실린다
  const orgOfSheet = SPACES.find((sp) => sp.kind === 'org' && sp.key === a?.space)?.id ?? null; // 내 공간이면 null — 업무 세트는 내 것(office_asset_ctx p_org NULL = 개인)
  // AI 이용 동의(CX-11) — 창을 열 때 한 번 읽는다(사람이 열 때만, 주기 없음). undefined 읽는 중, null 동의 안 함 → 이 창에서 동의(메신저와 같은 기록·같은 문구)
  const [consent, setConsent] = useState(undefined), [agreeing, setAgreeing] = useState(false);
  useEffect(() => { if (a) { setCrew(a.crew ?? null); setTask(a.items?.some((i) => i.kind === 'mail') ? 'summary' : 'custom'); setText(''); setAt(null); shut.current = -1; setSetId(''); } }, [a]);
  useEffect(() => {
    let live = true;
    setConsent(undefined); setSets([]);
    if (a && getMode() === 'signedIn') {
      rpc('office_asset_list', { p_org: orgOfSheet }).then((l) => { if (live) setSets([...l.company, ...l.mine].filter((x) => x.kind === 'set')); }).catch(() => {});
      rpc('msgr_my_ai_consent', {}).then((v) => { if (live) setConsent(v ?? null); }, () => { if (live) setConsent('?'); }); // 못 읽으면 막지 않는다 — 보낼 때 다시 확인한다(crew-assign.js)
    }
    return () => { live = false; };
  }, [a, orgOfSheet]);
  const label = useMemo(() => a?.items?.map((i) => i.label).filter(Boolean).join(', ') ?? '', [a]);
  const allCrews = useStore((s) => s.crews);
  const live = getMode() === 'signedIn';
  // 1:1 방은 내 크루와만 열린다(msgr_create_channel·메신저와 같은 규칙) — 로그인 상태에서는 내 크루만 보인다
  const crews = crewsIn(allCrews, a?.space ?? 'me', ME.id).filter((c) => !live || (c.owner === ME.id && !c.company && (c.access ?? 'ok') === 'ok')); // 꺼진 크루·권한 없는 크루는 빼고(사이드바와 같은 규칙)
  const [busy, setBusy] = useState(false);
  if (!a) return null;
  // 좌측에서 고른 에이전트면 그 한 명만(유건 9/30) — 메일·페이지 메뉴에서 열었으면 고르기 칸. 내 공간은 같은 에이전트를 한 줄로 묶었다(묶인 행 id 어느 것으로 열어도 그 줄)
  const main = crews.find((x) => x.id === crew || x.ids?.includes(crew)), fixed = !!a.crew && !!main && (main.id === a.crew || !!main.ids?.includes(a.crew));
  // '@' 멘션 — 글에 "@이름"만 넣고, 넘김은 주 에이전트가 메신저 @넘김으로 한다(협업 태그 없음)
  const cands = at && main ? mentionCands(allCrews, main, at.q).slice(0, 8) : [];
  const sync = (el) => {
    const m = mentionAt(el.value, el.selectionStart);
    if (!m) shut.current = -1;
    setAt(m && m.start !== shut.current && el.selectionStart === el.selectionEnd ? { ...m, caret: el.selectionStart } : null);
  };
  const pick = (c) => {
    const r = putMention(text, at, at.caret, c.name);
    setText(r.text); setAt(null);
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(r.caret, r.caret); });
  };
  const onKey = (e) => {
    if (!cands.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => (i + (e.key === 'ArrowDown' ? 1 : cands.length - 1)) % cands.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pick(cands[Math.min(hi, cands.length - 1)]); }
    else if (e.key === 'Escape') { e.stopPropagation(); shut.current = at.start; setAt(null); } // 창은 닫지 않고 목록만
  };
  const hasMail = a.items.some((i) => i.kind === 'mail');
  const close = () => setUi({ assign: null });
  const go = async () => {
    const c = main;
    if (!c || busy) return;
    if (!live) { // 예시 데이터 — 화면에서만
      assign({ space: c.space ?? a.space, crew, goal: task === 'custom' ? (text || label) : [`${t(`crew.task.${task}`)} · ${label}`, text.trim()].filter(Boolean).join(' — ') });
      close(); showToast(t('crew.handed', { crew: c.name })); return;
    }
    const target = assignTarget(c, allCrews, SPACES); // 내 에이전트는 개인 1:1(메신저 에이전트 탭과 같은 방, CX-03), 없으면 조직 1:1
    if (!target.orgId && !target.personalId) { showToast(t('crew.fail.not_allowed')); return; }
    setBusy(true);
    try {
      // 자료를 글자로 — 메일은 본문(이 탭에만 있는 것), 페이지는 본문, 파일·기록은 이름만. 못 불러오면 보내지 않는다(빈 자료로 맡기지 않게)
      // 거래·거래처·일정·견적/계약·회사 정보(17차)는 메뉴를 누른 화면이 이미 글자(text)를 뽑아 넘겼다 — 그대로 싣는다
      const items = await Promise.all(a.items.map(async (i) => {
        if (i.kind === 'mail') {
          const m = getState().mails.find((x) => x.id === i.id);
          if (!m?.account) return { ...i };
          const full = await readMail(m);
          return { ...i, from: full.from ?? m.from, text: htmlText(full.html) };
        }
        if (i.kind === 'page') {
          let page = getState().pages.find((x) => x.id === i.id);
          if (page && page.content === undefined) { await loadPageContent(i.id); page = getState().pages.find((x) => x.id === i.id); }
          return { ...i, text: docText(page?.content) };
        }
        return { ...i };
      }));
      const asked = task === 'custom' ? text.trim() || label : [t(`crew.ask.${task}`), text.trim()].filter(Boolean).join('\n\n'); // 미리 정한 일에도 덧붙인 말(@넘김 포함)을 싣는다
      const used = setId ? await rpc('office_asset_write', { p_org: orgOfSheet, p_action: 'asset.use', p_data: { id: setId } }) : null; // 세트는 목록을 읽은 공간에서
      // 이 크루에게 배정·켜진 도구(5단계) — 세트가 이미 실은 도구는 빼고. 크루가 사는 조직(없으면 내 것만)
      const mine = await rpc('office_asset_write', { p_org: target.orgId, p_action: 'crew.tools', p_data: { id: crypto.randomUUID(), crew_id: c.id } }).then((r) => r.tools).catch(() => []);
      const extra = mine.filter((x) => !used?.tool_list?.some((y) => y.id === x.id));
      const instruction = [asked, used && composeSet(used, t), composeTools(extra, t)].filter(Boolean).join('\n\n');
      sendToCrew({ ...target, crewName: c.name, ...composeAssign({ instruction, items, t }) });
      close(); showToast(t('crew.sending', { crew: c.name }));
    } catch { showToast(t('crew.fail.read')); }
    finally { setBusy(false); }
  };
  const agree = async () => { setAgreeing(true); try { setConsent((await rpc('msgr_set_ai_consent', { consent: true })) ?? null); } catch { showToast(t('consent.failed')); } finally { setAgreeing(false); } };
  // 동의하지 않았으면 쓰기 전에 이 창에서 동의(메신저 개인 공간 동의 화면과 같은 문구·같은 기록 msgr_set_ai_consent — 계정마다 한 번, 두 앱에 같이 적용, CX-11)
  if (consent === null) return (
    <Sheet open onClose={close} title={t('consent.title')}
      footer={<><button type="button" className="btn" disabled={agreeing} onClick={close}>{t('consent.later')}</button><button type="button" className="btn primary" disabled={agreeing} onClick={agree}><Icon name="check" size={14} />{t('consent.confirm')}</button></>}>
      <p>{t('consent.desc')}</p>
      <p className="dim small">{t('consent.note')}</p>
      <p><button type="button" className="link-btn small" onClick={() => openExternal(FAMILY.privacy)}>{t('consent.privacy')}</button></p>
    </Sheet>
  );
  return (
    <Sheet open onClose={close} title={fixed ? t('crew.assignTo', { crew: main.name }) : t('crew.assign')}
      footer={<><button type="button" className="btn" onClick={close}>{t('cancel')}</button><button type="button" className="btn primary" disabled={busy || !main || (live && consent === undefined) || (task === 'custom' && !text.trim() && !label)} onClick={go}><Icon name="hand" size={14} />{t('crew.go')}</button></>}>
      {main && <div className="ap-who assign-who"><Face id={main.id} size={32} /><div><b>{main.name}</b>{(main.job || main.role) && <small className="dim">{main.job || main.role}</small>}</div></div>}{/* 맡을 에이전트 얼굴(유건 9/30) */}
      {main?.on === false && <p className="data-note"><Icon name="info" size={12} />{t('crew.offNote')}</p>}{/* 꺼진 에이전트 — 메신저와 같은 90초 기준(CX-06) */}
      {a.items.length > 0 && <div className="assign-items">{a.items.map((i) => <span key={`${i.kind}-${i.id}`} className="chip"><Icon name={{ mail: 'mail', page: 'doc', file: 'file', record: 'run', deal: 'deal', customer: 'person', event: 'calendar', doc: 'sign', company: 'building' }[i.kind]} size={12} />{i.label}</span>)}</div>}
      {!fixed && <label className="field-block"><span className="label">{t('crew.to')}</span>
        {crews.length ? <select className="input" value={main?.id ?? crew ?? ''} onChange={(e) => { setCrew(e.target.value || null); setAt(null); }}><option value="" disabled>{t('crew.pick')}</option>{crews.map((c) => <option key={c.id} value={c.id}>{c.name}{c.role ? ` · ${c.role}` : ''}</option>)}</select>
          : <p className="dim small">{t('crew.fail.no_crew')}</p>}</label>}
      <div className="field-block"><span className="label">{t('crew.what')}</span>
        {a.items.length > 0 && <div className="seg">{TASKS.filter((k) => hasMail || k !== 'reply').map((k) => <button key={k} type="button" className={`seg-btn${task === k ? ' on' : ''}`} aria-pressed={task === k} onClick={() => setTask(k)}>{t(`crew.task.${k}`)}</button>)}</div>}
        <div className="mention-wrap">
          <textarea ref={box} data-autofocus className="input area" rows={4} value={text} placeholder={t(task === 'custom' ? 'crew.customPh' : 'crew.morePh')} aria-label={t(task === 'custom' ? 'crew.customPh' : 'crew.morePh')}
            aria-autocomplete="list" aria-controls={cands.length ? 'assign-mention' : undefined} aria-activedescendant={cands.length ? `assign-mention-${Math.min(hi, cands.length - 1)}` : undefined}
            onChange={(e) => { setText(e.target.value); setHi(0); sync(e.target); }} onSelect={(e) => sync(e.target)} onBlur={() => setAt(null)} {...imeGuardWith(onKey)} />
          {cands.length > 0 && <div id="assign-mention" role="listbox" className="mention-list">{cands.map((c, i) => (
            <div key={c.id} id={`assign-mention-${i}`} role="option" aria-selected={i === Math.min(hi, cands.length - 1)} className={`mention-opt${i === Math.min(hi, cands.length - 1) ? ' on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }} onMouseEnter={() => setHi(i)}>
              <Face id={c.id} size={20} /><b>{c.name}</b><small>{c.owner === ME.id || !c.owner ? c.role : c.ownerName ?? ''}</small></div>))}</div>}
          {at && main && !at.q && !cands.length && <p className="dim small">{t('crew.mention.none')}</p>}
        </div>
      </div>
      {sets.length > 0 && <label className="field-block"><span className="label">{t('crew.set.pick')}</span>
        <select className="input" value={setId} onChange={(e) => setSetId(e.target.value)}><option value="">{t('crew.set.none')}</option>{sets.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>}
      {maskedNote(a.items, hideAllOn()) && <p className="data-note"><Icon name="eyeOff" size={12} />{t('crew.maskedNote')}</p>}
      <p className="data-note"><Icon name="lock" size={12} />{t('crew.dataNote')}</p>
    </Sheet>
  );
}
