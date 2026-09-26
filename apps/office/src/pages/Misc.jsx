// 설정·휴지통·공유받은 항목·공개 게시 화면.
import { useMemo, useState } from 'react';
import { Icon } from '../ui/Icon.jsx';
import { showToast } from '../ui/Overlay.jsx';
import { t, ago, useLang, getLang, setLang } from '../core/i18n.js';
import { THEMES, applyTheme, readTheme } from '../core/theme.js';
import { useStore, restorePage, resetDraft } from '../core/store.js';
import { Link } from '../core/router.jsx';
import { baseOf, mod } from '../core/commands.js';
import { SPACES, ME } from '../data/sample.js';

/** 테마 미리보기 — 앱을 작게 줄인 모습(사이드바·캔버스·카드·글줄). "시스템"은 라이트와 다크를 대각선으로 반씩 보여 준다. */
function Mini({ tone }) {
  return (
    <span className="mini" data-pv={tone} aria-hidden="true">
      <span className="mini-side"><i /><i /><i /></span>
      <span className="mini-main"><span className="mini-card"><i /><i className="short" /></span><span className="mini-card"><i /><i className="mark" /></span></span>
    </span>
  );
}
function ThemeThumb({ theme }) {
  const [family, mode] = theme.split('-');
  if (!mode) return <span className="thumb"><Mini tone={`${family}-light`} /><span className="thumb-dark"><Mini tone={`${family}-dark`} /></span></span>;
  return <span className="thumb"><Mini tone={theme} /></span>;
}

export function Settings() {
  useLang();
  const [theme, setTheme] = useState(readTheme());
  const pick = (th) => { applyTheme(th); setTheme(th); };
  const keys = [[`${mod}K`, t('nav.search')], [`${mod}\\`, t('cmd.toggleSidebar')], [`${mod}/`, t('cmd.toggleLang')], [`${mod}⌥N`, t('cmd.newPage')], ['J / K', t('nav.mail')], ['E', t('mail.archiveIt')], ['R', t('mail.reply')], ['Shift+F10', t('more')]];
  return (
    <div className="page-wrap">
      <div className="page-title-row"><h1 className="page-h1">{t('settings.title')}</h1></div>
      <section className="set-card">
        <h2>{t('settings.theme')}</h2>
        <div className="theme-grid" role="radiogroup" aria-label={t('settings.theme')}>{THEMES.map((th) => (
          <button key={th} type="button" role="radio" aria-checked={theme === th} className={`theme-opt${theme === th ? ' on' : ''}`} onClick={() => pick(th)}>
            <ThemeThumb theme={th} />
            <span className="theme-name">{t(`theme.${th}`)}{theme === th && <Icon name="check" size={14} />}</span>
          </button>))}</div>
      </section>
      <section className="set-card">
        <h2>{t('settings.lang')}</h2>
        <div className="seg">{['ko', 'en'].map((l) => <button key={l} type="button" className={`seg-btn${getLang() === l ? ' on' : ''}`} onClick={() => setLang(l)}>{t(`lang.${l}`)}</button>)}</div>
      </section>
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
  const rows = pages.filter((p) => p.space === 'lean-studio');
  return (
    <div className="page-wrap">
      <div className="page-title-row"><h1 className="page-h1">{t('shared.title')}</h1></div>
      {rows.length === 0 ? <div className="empty-state"><p>{t('shared.empty')}</p></div>
        : <div className="list">{rows.map((p) => <Link key={p.id} to={`${baseOf(p.space)}/p/${p.id}`} className="list-row"><Icon name="doc" size={14} className="dim" /><span className="grow">{p.title}</span><small className="dim">{SPACES.find((s) => s.key === p.space)?.name} · {ago(p.updated)}</small></Link>)}</div>}
    </div>
  );
}

/** 공개 게시 화면 — 조직 로고가 위에, 하단에 작은 "Argo Office로 만듦". 결재·메일 참조와 비공개 블록은 빠진다. */
export function PublicPage({ id }) {
  useLang();
  const page = useStore((s) => s.pages.find((p) => p.id === id));
  const org = SPACES.find((s) => s.key === page?.space && s.kind === 'org');
  if (!page) return <div className="public"><div className="empty-state"><p>{t('mail.empty')}</p></div></div>;
  const text = (n) => (n.content ?? []).map((c) => c.text ?? text(c)).join('');
  return (
    <div className="public">
      <header className="public-head"><span className="space-mark">{org?.mark ?? ME.name[0]}</span><b>{org?.name ?? ME.name}</b></header>
      <article className="public-body prose">
        {(page.content.content ?? []).map((n, i) => n.type === 'heading' ? <h1 key={i} className={`h${n.attrs.level}`}>{text(n)}</h1>
          : n.type === 'paragraph' ? <p key={i}>{text(n)}</p>
            : <ul key={i}>{(n.content ?? []).map((li, j) => <li key={j}>{text(li)}</li>)}</ul>)}
      </article>
      <footer className="public-foot">{t('public.madeWith')}</footer>
    </div>
  );
}
