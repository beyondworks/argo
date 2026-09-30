// 설정·휴지통·공유받은 항목·공개 게시 화면.
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ui/Icon.jsx';
import { showToast } from '../ui/Overlay.jsx';
import { t, ago, useLang, getLang, setLang } from '../core/i18n.js';
import { FAMILIES, MODES, SHELLS, applyTheme, applyShell, readTheme, readShell, familyOf, modeOf } from '../core/theme.js';
import { useStore, restorePage, resetDraft } from '../core/store.js';
import { Link } from '../core/router.jsx';
import { baseOf, mod } from '../core/commands.js';
import { SPACES, ME, getMode, signOut } from '../core/session.js';
import { getClient } from '../core/supabase.js';
import { DocView } from '../ui/DocView.jsx';

// 색상 견본 — [바탕, 사이드바, 강조] 라이트 값(정본은 tokens.css·themes.css). 표시용이라 다크 값은 두지 않는다.
const SWATCH = {
  linen: ['#e9e6df', '#1f1e1b', '#e8e400'], graphite: ['#fafafa', '#f0f0f0', '#1a1a1a'], cream: ['#fbf3e5', '#111111', '#f4b8dc'],
  sand: ['#e2dac7', '#f1f0ee', '#c62d26'], peach: ['#ede0d7', '#ffffff', '#f97723'], mist: ['#d0d1cc', '#f2f2ef', '#6f4fd6'],
  glow: ['linear-gradient(135deg, #f2c3b1, #f2e5b0)', '#fff9f1', '#c8a4ee'],
};

/** 셸 견본 — 지금 고른 색으로 그린 작은 창. 모양만 셸마다 다르다 */
function ShellMini({ shell }) {
  return <span className="shell-mini" data-s={shell} aria-hidden="true"><span className="sm-win"><span className="sm-side"><i /><i /><i /></span><span className="sm-main"><i /><i /></span></span></span>;
}

export function Settings() {
  useLang();
  const [theme, setTheme] = useState(readTheme()), [shell, setShell] = useState(readShell());
  const family = familyOf(theme), mode = modeOf(theme);
  const pick = (th) => { applyTheme(th); setTheme(th); };
  const pickShell = (sh) => { applyShell(sh); setShell(sh); };
  const keys = [[`${mod}K`, t('nav.search')], [`${mod}\\`, t('cmd.toggleSidebar')], [`${mod}/`, t('cmd.toggleLang')], [`${mod}⌥N`, t('cmd.newPage')], ['J / K', t('nav.mail')], ['E', t('mail.archiveIt')], ['R', t('mail.reply')], ['Shift+F10', t('more')]];
  return (
    <div className="page-wrap">
      <div className="page-title-row"><h1 className="page-h1">{t('settings.title')}</h1></div>
      <section className="set-card">
        <h2>{t('settings.theme')}</h2>
        <div className="theme-rows">
          <div className="theme-row"><span className="label">{t('settings.mode')}</span>
            <div className="seg" role="radiogroup" aria-label={t('settings.mode')}>{MODES.map((m) => <button key={m || 'system'} type="button" role="radio" aria-checked={mode === m} className={`seg-btn${mode === m ? ' on' : ''}`} onClick={() => pick(family + m)}>{t(`mode.${m.slice(1) || 'system'}`)}</button>)}</div></div>
          <div className="theme-row"><span className="label">{t('settings.shell')}</span>
            <div className="shell-picks" role="radiogroup" aria-label={t('settings.shell')}>{SHELLS.map((sh) => (
              <button key={sh} type="button" role="radio" aria-checked={shell === sh} className={`shell-opt${shell === sh ? ' on' : ''}`} onClick={() => pickShell(sh)}>
                <ShellMini shell={sh} /><span>{t(`shell.${sh}`)}</span></button>))}</div></div>
          <div className="theme-row"><span className="label">{t('settings.color')}</span>
            <div className="color-picks" role="radiogroup" aria-label={t('settings.color')}>{FAMILIES.map((f) => (
              <button key={f} type="button" role="radio" aria-checked={family === f} aria-label={t(`color.${f}`)} title={t(`color.${f}`)} className={`swatch${family === f ? ' on' : ''}`} onClick={() => pick(f + mode)}
                style={{ '--sw-a': SWATCH[f][0], '--sw-b': SWATCH[f][1], '--sw-c': SWATCH[f][2] }}><i /></button>))}</div>
            <span className="dim small">{t(`color.${family}`)}</span></div>
        </div>
      </section>
      <section className="set-card">
        <h2>{t('settings.lang')}</h2>
        <div className="seg">{['ko', 'en'].map((l) => <button key={l} type="button" className={`seg-btn${getLang() === l ? ' on' : ''}`} onClick={() => setLang(l)}>{t(`lang.${l}`)}</button>)}</div>
      </section>
      {getMode() === 'signedIn' && <section className="set-card">
        <h2>{t('settings.account')}</h2>
        <div className="person"><span className="avatar">{ME.name.slice(0, 1)}</span><span className="person-main"><b>{ME.name}</b><small>{ME.email}</small></span><button type="button" className="btn sm" onClick={() => signOut()}>{t('settings.signOut')}</button></div>
      </section>}
      <section className="set-card">
        <h2>{t('settings.mail')}</h2>
        <div className="person"><span className="dot ok" /><span className="person-main"><b>{ME.email}</b><small>IMAP · SMTP</small></span><button type="button" className="btn sm">{t('mail.connect')}</button></div>
      </section>
      <section className="set-card">
        <h2>{t('settings.shortcuts')}</h2>
        <dl className="keys">{keys.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
      </section>
      <button type="button" className="btn ghost" onClick={() => { resetDraft(); showToast(t('settings.reset')); }}>{t('settings.reset')}</button>
    </div>
  );
}

export function Trash({ space }) {
  useLang();
  const trash = useStore((s) => s.trash);
  const rows = useMemo(() => trash.filter((p) => p.space === space && !trash.some((q) => q.id === p.parent)), [trash, space]);
  return (
    <div className="page-wrap">
      <div className="page-title-row"><div><h1 className="page-h1">{t('trash.title')}</h1><p className="dim">{t('trash.note')}</p></div></div>
      {rows.length === 0 ? <div className="empty-state"><Icon name="trash" size={20} /><p>{t('trash.empty')}</p></div>
        : <div className="list">{rows.map((p) => <div key={p.id} className="list-row"><Icon name="doc" size={14} className="dim" /><span className="grow">{p.title || t('page.untitled')}</span><small className="dim">{ago(p.trashedAt)}</small><button type="button" className="btn sm" onClick={() => restorePage(p.id)}>{t('trash.restore')}</button></div>)}</div>}
    </div>
  );
}

export function Shared() {
  useLang();
  const pages = useStore((s) => s.pages);
  const rows = pages.filter((p) => !p.template && p.space === (getMode() === 'signedIn' ? 'shared' : 'lean-studio')); // 로그인하면 남의 내 공간에서 공유받은 페이지
  return (
    <div className="page-wrap">
      <div className="page-title-row"><h1 className="page-h1">{t('shared.title')}</h1></div>
      {rows.length === 0 ? <div className="empty-state"><p>{t('shared.empty')}</p></div>
        : <div className="list">{rows.map((p) => <Link key={p.id} to={`${baseOf(p.space)}/p/${p.id}`} className="list-row"><Icon name="doc" size={14} className="dim" /><span className="grow">{p.title}</span><small className="dim">{SPACES.find((s) => s.key === p.space)?.name} · {ago(p.updated)}</small></Link>)}</div>}
    </div>
  );
}

/** 공개 게시 화면 — 조직 로고가 위에, 하단에 작은 "Argo Office로 만듦". 결재·메일 참조와 비공개 블록은 빠진다. */
export function PublicPage({ id: token }) {
  useLang();
  const local = useStore((s) => s.pages.find((p) => p.id === token));   // 예시 데이터 모드(서버 없음)에서는 페이지 id로 연다
  const [doc, setDoc] = useState(undefined);                             // undefined 불러오는 중 | null 없음·게시 꺼짐
  useEffect(() => {
    let live = true;
    getClient().then(async (sb) => {
      if (!sb) return live && setDoc(null);
      const { data } = await sb.rpc('office_public_page', { p_token: token });
      if (live) setDoc(data ?? null);
    }).catch(() => live && setDoc(null));
    return () => { live = false; };
  }, [token]);
  const view = doc ?? (doc === null && local ? { title: local.title, content: local.content, org: SPACES.find((s) => s.key === local.space && s.kind === 'org')?.name, index: false } : doc);
  useEffect(() => {                                                      // 검색 노출은 기본 끔(유건 확정) — 켠 페이지만 허용
    let m = document.querySelector('meta[name="robots"]');
    if (!m) { m = document.createElement('meta'); m.name = 'robots'; document.head.append(m); }
    m.content = view?.index ? 'index, follow' : 'noindex, nofollow';
    if (view) document.title = view.title || t('page.untitled');
  }, [view]);
  if (view === undefined) return <div className="public" aria-busy="true" />;
  if (!view) return <div className="public"><div className="empty-state"><Icon name="doc" size={20} /><p>{t('public.missing')}</p></div></div>;
  return (
    <div className="public">
      {view.org && <header className="public-head"><span className="space-mark">{view.org.slice(0, 1).toUpperCase()}</span><b>{view.org}</b></header>}
      <article className="public-body prose"><DocView doc={view.content} /></article>
      <footer className="public-foot">{t('public.madeWith')}</footer>
    </div>
  );
}
