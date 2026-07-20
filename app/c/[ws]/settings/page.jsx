'use client';
// 설정 — 회사 정보 수정, 제원, 위험 구역(보관).
import { Suspense, use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Icon, Spinner, Skeleton, DangerModal, ConfirmModal, api, imeGuard } from '../../../ui';
import { useLang, KRW_RATE } from '../../../i18n';
import { useTheme, THEMES } from '../../../theme';
import { AiConnectionCard, fieldStyle, usableRunnerNames } from '../../../runner-connect';

const CONTACT = process.env.NEXT_PUBLIC_ARGO_CONTACT || '';
const LS_MONTHLY = process.env.NEXT_PUBLIC_LS_CHECKOUT_MONTHLY || '';
const LS_YEARLY = process.env.NEXT_PUBLIC_LS_CHECKOUT_YEARLY || '';

export default function SettingsPage({ params }) {
  return (
    <Suspense>
      <Settings params={params} />
    </Suspense>
  );
}

function Settings({ params }) {
  const { ws } = use(params);
  const { t, lang } = useLang();
  const router = useRouter();
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [budget, setBudget] = useState(''); // 화면 표시값 — ko는 원화, en은 달러
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  // 딥링크 ?ai=1 — 데크/홈의 "연결하기"가 러너 연결 섹션으로 바로 데려온다(vault ?doc= 패턴)
  const aiRef = useRef(null);
  const wantAi = useSearchParams().get('ai');
  useEffect(() => {
    if (!wantAi) return;
    requestAnimationFrame(() => aiRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [wantAi, data]);

  useEffect(() => {
    api(`/api/companies/${ws}`).then((d) => {
      setData(d);
      setName(d.company?.name ?? '');
      const usd = d.company?.budgetUsd;
      setBudget(usd ? (lang === 'ko' ? String(Math.round(usd * KRW_RATE)) : String(usd)) : '');
    }).catch(() => setData({}));
  }, [ws, lang]);

  async function saveName(e) {
    e.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true); setMsg('');
    try {
      const budgetUsd = budget === '' ? 0 : (lang === 'ko' ? Number(budget) / KRW_RATE : Number(budget));
      await fetch(`/api/companies/${ws}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, budgetUsd }),
      }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
      window.dispatchEvent(new Event('argo:refresh'));
      setMsg(t('settings.saved'));
    } catch (e2) {
      setMsg(String(e2.message));
    } finally {
      setSaving(false);
    }
  }

  // 명판 '엔진' = 실제 연결 러너 — 데크 명판과 같은 단일 진실(usableRunnerNames). 연결/해제 시 argo:refresh로 갱신.
  const [engines, setEngines] = useState(null);
  useEffect(() => {
    let alive = true;
    const pull = () => api(`/api/companies/${ws}/keys`)
      .then((k) => { if (alive) setEngines(usableRunnerNames(k.runners)); })
      .catch(() => {});
    pull();
    window.addEventListener('argo:refresh', pull);
    return () => { alive = false; window.removeEventListener('argo:refresh', pull); };
  }, [ws]);

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  async function archive() {
    setArchiving(true);
    await fetch(`/api/companies/${ws}`, { method: 'DELETE' });
    router.push('/');
  }

  const c = data?.company;
  const rows = c && [
    [t('deck.nameplate.unit'), c.id],
    [t('deck.nameplate.captain'), c.owner],
    [t('deck.nameplate.commissioned'), String(c.created ?? '').slice(0, 10)],
    [t('deck.nameplate.crew'), `${data.agents?.length ?? 0}`],
    [t('deck.nameplate.vault'), t('settings.nameplate.vaultVal', { n: data.memoryCount ?? 0, links: data.stats?.links ?? 0 })],
    [t('deck.nameplate.engine'), engines === null ? '—' : (engines.join(' · ') || t('deck.nameplate.engineNone'))],
    [t('settings.nameplate.runtime'), t('settings.nameplate.runtimeVal')],
  ];

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 1060, margin: '0 auto', width: '100%' }}>
      <span className="microlabel">{t('settings.head')}</span>

      <Section label={t('settings.general')}>
      <form onSubmit={saveName} className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span className="card-title">{t('settings.companyInfo')}</span>
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="microlabel">{t('settings.companyName')}</span>
          <input suppressHydrationWarning
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...imeGuard}
            style={{ height: 36, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13.5 }}
          />
        </label>
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="microlabel">{lang === 'ko' ? t('settings.budget.ko') : t('settings.budget.en')}</span>
          <input suppressHydrationWarning
            type="number" min="0" step="1" placeholder={t('settings.budget.placeholder')}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            style={{ height: 36, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 13.5 }}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 'auto', paddingTop: 10 }}>
          <button className="btn btn-primary sm" disabled={saving || !name.trim()}>
            {saving ? <Spinner size={12} /> : t('settings.save')}
          </button>
          <span style={{ fontSize: 12, color: msg === t('settings.saved') ? 'var(--fg-2)' : 'var(--danger)' }}>{msg}</span>
        </div>
      </form>

      <div className="card" style={{ padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span className="card-title">{t('settings.spec')}</span>
          <span className="microlabel">{t('deck.snArgo')}</span>
        </div>
        {!rows ? <Skeleton h={130} /> : (
          <div style={{ display: 'grid', gap: 5 }}>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, borderBottom: '1px dashed var(--border-soft)', paddingBottom: 5 }}>
                <span className="microlabel">{k}</span>
                <span className="mono" style={{ fontSize: 11 }}>{v}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
          <span className="barcode" aria-hidden="true" />
          <span className="microlabel">{t('deck.sailTogether')}</span>
        </div>
      </div>

      {/* 화면 언어 + 크루 응답 언어 — 의미상 한 쌍이라 한 열에 세로로 묶는다
          (묶지 않으면 일반 카드 4장이 3열 그리드에서 4번째만 다음 줄에 홀로 떨어짐) */}
      <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
        <LanguageCard />
        <CrewLanguageCard ws={ws} sysLang={data?.company?.lang} />
      </div>
      <ThemeCard />
      <TrashCard ws={ws} />
      </Section>

      <div ref={aiRef} style={{ scrollMarginTop: 84 }}>
        <Section label={t('settings.ai.section')}>
          <AiConnectionCard ws={ws} />
        </Section>
      </div>

      <Section label={t('settings.devices.section')}>
        <DevicesCard ws={ws} />
        <UpdateCard />
      </Section>

      <Section label={t('settings.capabilities')}>
        <CapabilitiesCard ws={ws} />
      </Section>

      <Section label={t('settings.connections')}>
      <ConnectionCard ws={ws} kind="telegram" title={t('activity.telegram')}
        help={t('settings.conn.tgHelp')}
        agents={data?.agents ?? []} />
      <ConnectionCard ws={ws} kind="slack" title={t('activity.slack')}
        help={t('settings.conn.slackHelp')}
        agents={data?.agents ?? []} />
      <SyncCard ws={ws} />
      </Section>

      <Section label={t('settings.danger')}>
      <div className="card" style={{ padding: 18, borderColor: 'var(--danger)', gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <span className="card-title" style={{ color: 'var(--danger)' }}>{t('settings.archive.title')}</span>
          <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: '6px 0 0' }}>
            {t('settings.archive.pathPrefix')}
            <span className="mono" style={{ fontSize: 11 }}> workspaces/.archive/</span>
            {t('settings.archive.pathSuffix')}
          </p>
        </div>
        <button className="btn sm" style={{ color: 'var(--danger)', borderColor: 'var(--danger)', flex: 'none' }} onClick={() => setArchiveOpen(true)}>
          <Icon name="trash" size={13} /> {t('settings.archive.btn')}
        </button>
      </div>
      </Section>

      <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: 'var(--fg-3)', padding: '6px 2px 4px' }}>
        <a href="/legal" style={{ color: 'inherit' }}>{t('legal.link')}</a>
        {CONTACT && <a href={`mailto:${CONTACT}?subject=${encodeURIComponent(t('legal.feedbackSubject'))}`} style={{ color: 'inherit' }}>{t('legal.feedback')}</a>}
      </div>

      {archiveOpen && (
        <DangerModal
          title={t('settings.archive.title')}
          description={t('settings.archive.desc')}
          requireText={data?.company?.name ?? ''}
          phraseKey="danger.phrase.archive"
          confirmLabel={t('settings.archive.btn')}
          busy={archiving}
          onConfirm={archive}
          onClose={() => setArchiveOpen(false)}
        />
      )}
    </div>
  );
}

/** 언어 선택 — 각 옵션 라벨은 언제나 그 언어 자신으로 표기(국제 관례). 단축키 안내 포함. */
function LanguageCard() {
  const { lang, t, setLang } = useLang();
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
  const kbd = isMac ? '⌘ + /' : 'Ctrl + /';
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="card-title">{t('settings.language')}</span>
      <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('settings.language.desc')}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        {[['ko', '한국어'], ['en', 'English']].map(([code, label]) => (
          <button
            key={code}
            className="chip"
            onClick={() => setLang(code)}
            aria-pressed={lang === code}
            style={{
              cursor: 'pointer', padding: '6px 16px', fontSize: 12.5,
              ...(lang === code ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' } : {}),
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto', paddingTop: 10 }}>
        <span className="microlabel">{t('settings.language.shortcut')}</span>
        <span className="kbd mono" style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px' }}>{kbd}</span>
      </div>
    </div>
  );
}

/** 크루 응답 언어 — 시스템(크루 생성) 언어. 화면 언어(argo-lang)와 별개로 회사 단위(company.lang) 저장.
    크루 답변·페르소나·기억이 이 언어를 따른다(백엔드 chat.mjs가 회사 lang을 강제). */
function CrewLanguageCard({ ws, sysLang }) {
  const { t } = useLang();
  const [cur, setCur] = useState(sysLang === 'en' ? 'en' : 'ko');
  useEffect(() => { setCur(sysLang === 'en' ? 'en' : 'ko'); }, [sysLang]);
  const pick = (code) => {
    setCur(code);
    fetch(`/api/companies/${ws}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang: code }),
    }).then(() => window.dispatchEvent(new Event('argo:refresh'))).catch(() => {});
  };
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="card-title">{t('settings.crewLanguage')}</span>
      <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('settings.crewLanguage.desc')}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        {[['ko', '한국어'], ['en', 'English']].map(([code, label]) => (
          <button
            key={code}
            className="chip"
            onClick={() => pick(code)}
            aria-pressed={cur === code}
            style={{
              cursor: 'pointer', padding: '6px 16px', fontSize: 12.5,
              ...(cur === code ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' } : {}),
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 테마 스와치 — 각 테마의 캔버스/카드/프라이머리 토큰을 그대로 보여주는 미니 프리뷰. */
const THEME_SWATCHES = {
  argo: ['#e3e5d6', '#e9ebdd', '#22241c'],
  calm: ['#eff1f4', '#f8f9fb', '#5a6b8c'],
  'calm-dark': ['#1b1e24', '#22262e', '#8098bd'],
  apple: ['#f5f5f7', '#ffffff', '#0071e3'],
  'apple-dark': ['#161617', '#2c2c2e', '#0a84ff'],
  glass: ['#c9d8f2', '#eef3fb', '#0071e3'],
  'glass-dark': ['#1c1c1e', '#39393d', '#0a84ff'],
  clay: ['#ede6d4', '#f6f1e3', '#176862'],
  porcelain: ['#ededeb', '#f6f6f4', '#3478f6'],
  mist: ['#b9c6cd', '#eef3f2', '#5e8b7e'],
  frost: ['#0b0d12', '#2a303c', '#3e82f7'],
  'cream-pop': ['#faf3e8', '#191919', '#ec6bb8'],
  peach: ['#fbeee1', '#fffaf2', '#e2795e'],
  retro: ['#efe3d0', '#f7edda', '#f05423'],
  sketch: ['#fbf7e4', '#fdfaec', '#e9c93a'],
  'tokyo-night': ['#1a1b26', '#292e42', '#7aa2f7'],
  nord: ['#2e3440', '#434c5e', '#88c0d0'],
  everforest: ['#2d353b', '#3d484d', '#a7c080'],
  dracula: ['#282a36', '#44475a', '#bd93f9'],
  monokai: ['#2d2a2e', '#403e41', '#ffd866'],
  'rose-pine': ['#191724', '#26233a', '#c4a7e7'],
  // VS Code 임포트 (마켓플레이스 팔레트 정밀 이식)
  'codex-gh-light': ['#ffffff', '#f6f8fa', '#28a745'],
  'codex-gh-dark': ['#0d1117', '#010409', '#238636'],
  enjoyer: ['#f5f5f5', '#eeeeee', '#818181'],
  'minimal-light': ['#fafafa', '#ffffff', '#007acc'],
  'minimal-dark': ['#2e3440', '#373d48', '#81a1c1'],
};

// 아르고 시그니처 = 라이트/다크/시스템 3-모드. 나머지 테마는 "다른 스킨"으로 분리(모드 토글과 중복 제거).
const MODE_OPTS = [['argo', 'settings.mode.system'], ['argo-light', 'settings.mode.light'], ['argo-dark', 'settings.mode.dark']];
const ARGO_CODES = ['argo', 'argo-light', 'argo-dark'];
function ThemeCard() {
  const { theme, setTheme } = useTheme();
  const { t } = useLang();
  const skins = THEMES.filter((c) => !ARGO_CODES.includes(c));
  return (
    <div className="card" style={{ padding: 18, gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* 모드 — 시스템/라이트/다크 세그먼트 (아르고 시그니처 테마의 밝기) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <span className="card-title">{t('settings.mode')}</span>
        <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('settings.mode.desc')}</p>
        <div role="group" aria-label={t('settings.mode')}
          style={{ display: 'inline-flex', gap: 3, alignSelf: 'flex-start', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 999, padding: 3 }}>
          {MODE_OPTS.map(([code, label]) => (
            <button key={code} onClick={() => setTheme(code)} aria-pressed={theme === code}
              style={{
                cursor: 'pointer', border: 0, borderRadius: 999, padding: '6px 18px', fontSize: 12.5, fontWeight: 600,
                background: theme === code ? 'var(--primary)' : 'transparent',
                color: theme === code ? 'var(--primary-fg)' : 'var(--fg-2)',
                transition: 'background 0.15s, color 0.15s',
              }}>
              {t(label)}
            </button>
          ))}
        </div>
      </div>
      {/* 다른 스킨 — 아르고 대신 다른 색 테마 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <span className="card-title">{t('settings.theme.skin')}</span>
        <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('settings.theme.skin.desc')}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {skins.map((code) => {
            const [bg, card, primary] = THEME_SWATCHES[code] ?? [];
            return (
              <button
                key={code}
                className="chip"
                onClick={() => setTheme(code)}
                aria-pressed={theme === code}
                style={{
                  cursor: 'pointer', padding: '6px 16px', fontSize: 12.5, textTransform: 'none', letterSpacing: 0,
                  ...(theme === code ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' } : {}),
                }}
              >
                <span aria-hidden="true" style={{ display: 'inline-flex', gap: 2, marginRight: 6 }}>
                  {[bg, card, primary].map((c, i) => (
                    <span key={i} style={{ width: 8, height: 8, borderRadius: 999, background: c, border: '1px solid var(--border-soft)' }} />
                  ))}
                </span>
                {t(`settings.theme.${code}`)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** 보관함 — 삭제된 대화(회사 전체)를 모아 복구·영구삭제. 삭제=chats/.trash/로 이동(비파괴). */
function TrashCard({ ws }) {
  const { t } = useLang();
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState('');            // 처리 중 항목 id
  const [purgeTarget, setPurgeTarget] = useState(null);
  const load = useCallback(() => {
    api(`/api/companies/${ws}/trash`).then((d) => setItems(d.items ?? [])).catch(() => setItems([]));
  }, [ws]);
  useEffect(load, [load]);
  async function restore(it) {
    setBusy(it.id);
    try { await api(`/api/companies/${ws}/trash`, { id: it.id }); load(); }
    catch { /* 실패는 다음 시도 */ } finally { setBusy(''); }
  }
  async function doPurge() {
    const it = purgeTarget; setPurgeTarget(null);
    if (!it) return;
    setBusy(it.id);
    try { await fetch(`/api/companies/${ws}/trash?id=${encodeURIComponent(it.id)}`, { method: 'DELETE' }); load(); }
    catch { /* */ } finally { setBusy(''); }
  }
  return (
    <div className="card" style={{ padding: 18, gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="card-title">{t('settings.trash')}{items?.length ? ` · ${items.length}` : ''}</span>
      <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('settings.trash.desc')}</p>
      {items === null ? <Skeleton h={40} /> : items.length === 0 ? (
        <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>{t('settings.trash.empty')}</span>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {items.map((it) => (
            <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--border-soft)', borderRadius: 10, minWidth: 0 }}>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title || it.gist || t('chat.sessions.untitled')}</span>
                <span className="nav-sub">{it.crew} · {new Date(it.ts).toLocaleDateString('sv-SE')} · {t('chat.sessions.msgs', { n: it.count })}</span>
              </span>
              <button type="button" className="btn sm" style={{ flex: 'none' }} disabled={busy === it.id} onClick={() => restore(it)}>
                {busy === it.id ? <Spinner size={11} /> : t('settings.trash.restore')}
              </button>
              <button type="button" className="btn sm" style={{ flex: 'none', color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={busy === it.id} onClick={() => setPurgeTarget(it)}>
                {t('settings.trash.purge')}
              </button>
            </div>
          ))}
        </div>
      )}
      {purgeTarget && (
        <ConfirmModal
          title={t('settings.trash.purgeTitle')}
          description={t('settings.trash.purgeConfirm')}
          confirmLabel={t('settings.trash.purge')}
          tone="danger"
          onConfirm={doPurge}
          onClose={() => setPurgeTarget(null)}
        />
      )}
    </div>
  );
}

/** 로컬 능력 토글 — 전부 opt-in. bypass 꺼짐이면 부작용 실행은 결재 게이트를 탄다. */
const CAP_LABELS = {
  fs: ['settings.caps.fs', 'settings.caps.fs.desc'],
  browser: ['settings.caps.browser', 'settings.caps.browser.desc'],
  shell: ['settings.caps.shell', 'settings.caps.shell.desc'],
  bypass: ['settings.caps.bypass', 'settings.caps.bypass.desc'],
};

function CapabilitiesCard({ ws }) {
  const { t } = useLang();
  const [caps, setCaps] = useState(null);
  const [defs, setDefs] = useState([]);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    api(`/api/companies/${ws}/capabilities`).then((d) => { setCaps(d.capabilities); setDefs(d.defs); }).catch(() => setCaps({}));
  }, [ws]);

  async function toggle(key) {
    if (busy) return;
    setBusy(key);
    try {
      const d = await api(`/api/companies/${ws}/capabilities`, { [key]: !caps[key] });
      setCaps(d.capabilities);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="card" style={{ padding: 18, gridColumn: '1 / -1', display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span className="card-title">{t('settings.caps.title')}</span>
        <span className="chip">{caps?.bypass ? t('settings.caps.bypassOn') : t('settings.caps.gate')}</span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: '0 0 10px', lineHeight: 1.6 }}>
        {t('settings.caps.desc')}
      </p>
      {!caps ? <Skeleton h={120} /> : defs.map(([key]) => {
        const [titleKey, descKey] = CAP_LABELS[key] ?? [];
        return (
        <div key={key} className="row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 8px', ...(key === 'bypass' ? { borderTop: '1px dashed var(--border-soft)', marginTop: 4, paddingTop: 12 } : {}) }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: key === 'bypass' ? 'var(--danger)' : 'var(--fg)' }}>{titleKey ? t(titleKey) : key}</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-2)', marginTop: 2 }}>{descKey ? t(descKey) : ''}</div>
          </div>
          <button
            onClick={() => toggle(key)}
            disabled={busy === key}
            role="switch"
            aria-checked={!!caps[key]}
            style={{
              width: 40, height: 22, borderRadius: 999, flex: 'none', position: 'relative',
              border: '1px solid var(--border)', transition: 'background .15s',
              background: caps[key] ? (key === 'bypass' ? 'var(--danger)' : 'var(--fg)') : 'var(--card-2)',
              cursor: 'pointer',
            }}
          >
            <span style={{
              position: 'absolute', top: 2, left: caps[key] ? 20 : 2, width: 16, height: 16, borderRadius: 999,
              background: caps[key] ? 'var(--bg)' : 'var(--fg-3)', transition: 'left .15s',
            }} />
          </button>
        </div>
        );
      })}
    </div>
  );
}


/** 설정 섹션 — 대시 룰 헤더 + 2열 등고 그리드(내용이 하나면 전체 폭). */
function Section({ label, children }) {
  return (
    <section style={{ display: 'grid', gap: 10, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="microlabel" style={{ flex: 'none' }}>{label}</span>
        <span style={{ flex: 1, borderTop: '1px dashed var(--border-soft)' }} aria-hidden="true" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
        {children}
      </div>
    </section>
  );
}


/** 메신저 연결 카드 — 토큰은 서버에만 저장(화면은 마스킹), 가동 토글로 게이트웨이 시작/중지. */
function ConnectionCard({ ws, kind, title, help, agents }) {
  const { t } = useLang();
  const [conn, setConn] = useState(null);
  const [gw, setGw] = useState(null);
  // 실행 리더 여부 — 크레덴셜은 전 기기에 동기화되지만 폴러는 리더 한 기기만 돈다.
  // 팔로워에서 "중지"로 보이면 연결이 안 된 걸로 오해한다(유건 지적) → "대기"로 구분 표시.
  const [leader, setLeader] = useState(true);
  const [token, setToken] = useState('');
  const [channel, setChannel] = useState('');
  const [crew, setCrew] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  function load() {
    api(`/api/companies/${ws}/connections`).then((d) => {
      const c = d.connections[kind];
      setConn(c); setGw(d.gateway?.[kind] ?? null);
      setLeader(d.sync?.on ? !!d.sync.leader : true);
      setChannel(c.channel ?? ''); setCrew(c.defaultCrew ?? '');
    }).catch(() => setConn({}));
  }
  useEffect(load, [ws]);

  // 가동 중엔 폴러 하트비트를 8초마다 — "연동 안 됨"이 화면에서 바로 보인다
  useEffect(() => {
    if (!conn?.enabled) return;
    const t = setInterval(() => {
      api(`/api/companies/${ws}/connections`).then((d) => {
        setGw(d.gateway?.[kind] ?? null);
        setLeader(d.sync?.on ? !!d.sync.leader : true);
      }).catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, [ws, kind, conn?.enabled]);

  async function save(enabled) {
    setSaving(true); setMsg('');
    try {
      const d = await api(`/api/companies/${ws}/connections`, {
        kind, token, enabled, defaultCrew: crew, ...(kind === 'slack' ? { channel } : {}),
      });
      setConn(d.connections[kind]); setToken('');
      setMsg(enabled ? t('settings.conn.enabling') : t('settings.conn.stopped'));
    } catch (e) {
      setMsg(String(e.message));
    } finally {
      setSaving(false);
    }
  }

  const on = conn?.enabled;
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span className="card-title" style={{ minWidth: 0 }}>
          {title}{t('settings.conn.suffix')}
          {conn?.botUsername && <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', marginLeft: 7 }}>{conn.botUsername}</span>}
        </span>
        <span className="chip">
          {on
            ? (leader ? <><span className="dot" />{t('settings.conn.on')}</> : <><span className="dot" style={{ background: 'var(--warn)' }} />{t('settings.conn.onStandby')}</>)
            : t('settings.conn.off')}
          {(kind === 'telegram' ? conn?.chatId : conn?.paired) ? t('settings.conn.pairedSuffix') : ''}
        </span>
      </div>
      {on && !leader ? (
        // 팔로워 — 폴러는 리더 기기에서 돈다. "중지"처럼 보이지 않게 승계 대기임을 명시.
        <div style={{ fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--fg-2)' }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'currentColor' }} aria-hidden="true" />
          {t('settings.conn.gwFollower')}
        </div>
      ) : on && gw && (
        <div style={{ fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 6, color: gw.alive ? 'var(--ok)' : gw.error ? 'var(--danger)' : 'var(--warn)' }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'currentColor' }} aria-hidden="true" />
          {gw.alive
            ? t('settings.conn.gwAlive', { s: Math.max(0, Math.round((Date.now() - gw.lastTs) / 1000)) })
            : gw.error
              ? t('settings.conn.gwError', { msg: String(gw.error).slice(0, 80) })
              : t('settings.conn.gwWaiting')}
        </div>
      )}
      <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{help}</p>
      <label style={{ display: 'grid', gap: 5 }}>
        <span className="microlabel">{t('settings.conn.token')}{conn?.hasToken ? ` · ${t('settings.conn.tokenSaved')} ${conn.token}` : ''}</span>
        <input suppressHydrationWarning type="password" value={token} onChange={(e) => setToken(e.target.value)}
          placeholder={conn?.hasToken ? t('settings.conn.tokenPlaceholder') : (kind === 'telegram' ? t('settings.conn.telegramPlaceholder') : t('settings.conn.slackPlaceholder'))} style={fieldStyle} />
      </label>
      {/* 페어링 코드 — 봇에 먼저 말건 사람이 주인이 되는 것을 막는다. 사장이 이 코드를 봇에 보내야 연결된다. */}
      {kind === 'telegram' && on && conn?.hasToken && !conn?.chatId && conn?.pairCode && (
        <div style={{ display: 'grid', gap: 5, padding: '10px 12px', borderRadius: 10, background: 'var(--card-2)', border: '1px solid var(--border)' }}>
          <span className="microlabel">{t('settings.conn.pairCodeLabel')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="mono" style={{ fontSize: 22, letterSpacing: 4, fontWeight: 600, color: 'var(--accent, var(--fg))' }}>{conn.pairCode}</span>
            <button type="button" className="btn sm" style={{ flex: 'none' }}
              onClick={() => navigator.clipboard?.writeText(conn.pairCode).catch(() => {})}>{t('common.copy')}</button>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>{t('settings.conn.pairCodeHelp')}</span>
        </div>
      )}
      {kind === 'slack' && (
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="microlabel">{t('settings.conn.channel')}</span>
          <input suppressHydrationWarning value={channel} onChange={(e) => setChannel(e.target.value)} placeholder={t('settings.conn.channelPlaceholder')} style={fieldStyle} />
        </label>
      )}
      {/* 슬랙 페어링 코드 — 채널에 이 코드를 보낸 사람이 사장으로 고정된다(그 전엔 봇이 지시를 실행하지 않음) */}
      {kind === 'slack' && on && conn?.hasToken && !conn?.paired && conn?.pairCode && (
        <div style={{ display: 'grid', gap: 5, padding: '10px 12px', borderRadius: 10, background: 'var(--card-2)', border: '1px solid var(--border)' }}>
          <span className="microlabel">{t('settings.conn.pairCodeLabelSlack')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="mono" style={{ fontSize: 22, letterSpacing: 4, fontWeight: 600, color: 'var(--accent, var(--fg))' }}>{conn.pairCode}</span>
            <button type="button" className="btn sm" style={{ flex: 'none' }}
              onClick={() => navigator.clipboard?.writeText(conn.pairCode).catch(() => {})}>{t('common.copy')}</button>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>{t('settings.conn.pairCodeHelpSlack')}</span>
        </div>
      )}
      <label style={{ display: 'grid', gap: 5 }}>
        <span className="microlabel">{t('settings.conn.defaultCrew')}</span>
        <select value={crew} onChange={(e) => setCrew(e.target.value)} style={fieldStyle}>
          <option value="">{t('settings.conn.firstCrew')}</option>
          {agents.map((a) => <option key={a.slug} value={a.slug}>{a.name} — {a.role}</option>)}
        </select>
      </label>
      {kind === 'telegram' && agents.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="microlabel">{t('settings.conn.reachable')}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {agents.map((a) => (
              <span key={a.slug} className="chip" title={a.role}>
                @{a.name}{(crew ? a.slug === crew : a.slug === agents[0]?.slug) ? ` · ${t('settings.conn.defaultChip')}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 'auto', paddingTop: 10 }}>
        <button className="btn btn-primary sm" disabled={saving || (!conn?.hasToken && !token.trim())} onClick={() => save(true)}>
          {saving ? <Spinner size={12} /> : on ? t('settings.conn.saveSettings') : t('settings.conn.on')}
        </button>
        {on && <button className="btn sm" disabled={saving} onClick={() => save(false)}>{t('settings.conn.off')}</button>}
        <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{msg}</span>
      </div>
    </div>
  );
}

/** 기기 간 동기화 카드 — 회사 폴더가 클라우드에 복제되는 상태를 보이게 한다("보이는 상태" 원칙). */
function SyncCard({ ws }) {
  const { t, lang } = useLang();
  const [sync, setSync] = useState(null);
  useEffect(() => {
    const pull = () => api(`/api/companies/${ws}/connections`).then((d) => setSync(d.sync ?? null)).catch(() => {});
    pull();
    const iv = setInterval(pull, 15000);
    return () => clearInterval(iv);
  }, [ws]);
  const mine = sync?.companies?.[ws];
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="card-title">{t('settings.sync.title')}</span>
        <span style={{ flex: 1 }} />
        {sync?.plan === 'pro' ? (
          <span className="pill ok" style={{ flex: 'none' }}>{t('billing.plan.pro')}</span>
        ) : sync?.plan === 'free' ? (
          <span className="pill" style={{ flex: 'none' }}>{t('billing.plan.free')}</span>
        ) : null}
        {sync === null ? <Skeleton h={18} w={70} /> : sync.on ? (
          <span className="pill ok" style={{ flex: 'none' }}><span className="dot" />{t('settings.sync.on')}</span>
        ) : (
          <span className="pill" style={{ flex: 'none' }}><span className="dot" />{t('settings.sync.off')}</span>
        )}
      </div>
      {sync?.on ? (
        <div style={{ display: 'grid', gap: 4, fontSize: 12.5, color: 'var(--fg-2)' }}>
          <span>{sync.leader ? t('settings.sync.leader') : t('settings.sync.follower')}</span>
          <span>
            {t('settings.sync.last')}: {sync.lastTs ? new Date(sync.lastTs).toLocaleTimeString(lang === 'ko' ? 'ko-KR' : 'en-US') : '—'}
            {mine ? ` · ↑${mine.pushed} ↓${mine.pulled}` : ''}
          </span>
          {sync.paywalled ? (
            // "고장"(lastError)과 "페이월"은 다른 상태 — 여기선 빨간 에러 줄 대신 안내+업그레이드를 보인다.
            <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              <span style={{ color: 'var(--danger)', fontSize: 12 }}>{t('billing.paywall')}</span>
              <UpgradeButtons />
            </div>
          ) : sync.lastError ? (
            <span style={{ color: 'var(--danger)', fontSize: 12 }}>{sync.lastError}</span>
          ) : sync.plan === 'free' ? (
            // 아직 막히진 않았지만(강제 게이트 off 등) free 플랜에 안내 차원으로 노출 — pro면 숨김
            <UpgradeButtons />
          ) : null}
        </div>
      ) : (
        <p style={{ fontSize: 12.5, color: 'var(--fg-3)', margin: 0, lineHeight: 1.55 }}>{t('settings.sync.offHelp')}</p>
      )}
    </div>
  );
}

/** 업그레이드 버튼 — /api/me로 user(id/email) 확보 후 LS 체크아웃 링크에 붙인다.
    env 미설정이면 comingSoon, user 미확보(로딩·실패) 중엔 버튼을 렌더하지 않는다(안전). */
function UpgradeButtons() {
  const { t } = useLang();
  const [user, setUser] = useState(null);
  useEffect(() => { api('/api/me').then((d) => setUser(d.user ?? null)).catch(() => {}); }, []);

  if (!LS_MONTHLY && !LS_YEARLY) return <p style={{ fontSize: 12, color: 'var(--fg-3)', margin: 0 }}>{t('billing.comingSoon')}</p>;
  if (!user) return null; // /api/me 미확보 — user_id/email 없이 링크를 만들지 않는다

  const withRef = (base) => `${base}${base.includes('?') ? '&' : '?'}checkout[custom][user_id]=${encodeURIComponent(user.id)}&checkout[email]=${encodeURIComponent(user.email)}`;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {LS_MONTHLY && (
        <a className="btn btn-primary sm" href={withRef(LS_MONTHLY)} target="_blank" rel="noreferrer">{t('billing.upgradeMonthly')}</a>
      )}
      {LS_YEARLY && (
        <a className="btn sm" href={withRef(LS_YEARLY)} target="_blank" rel="noreferrer">{t('billing.upgradeYearly')}</a>
      )}
    </div>
  );
}

/** 기기 페어링 카드 — 연결 코드를 발급해 다른 기기 홈 화면에 붙여넣으면 이 회사가 그 기기로 내려간다. */
// 앱 업데이트 — Tauri 데스크톱 안에서만 노출. 버튼 하나로 확인 → 다운로드·설치 → 재시작.
// 서명 검증·다운로드는 Rust(updater 플러그인)가 수행, 매니페스트는 argo-agent 릴리스의 latest.json.
function UpdateCard() {
  const { t } = useLang();
  const [isApp, setIsApp] = useState(false);
  const [version, setVersion] = useState('');
  const [state, setState] = useState('idle'); // idle | checking | none | found | installing | ready | error
  const [next, setNext] = useState('');
  const updRef = useRef(null);
  useEffect(() => {
    const inApp = '__TAURI_INTERNALS__' in window || navigator.userAgent.includes('Tauri');
    setIsApp(inApp);
    if (inApp) import('@tauri-apps/api/app').then((m) => m.getVersion()).then(setVersion).catch(() => {});
  }, []);
  const check = useCallback(async () => {
    setState('checking');
    try {
      const upd = await (await import('@tauri-apps/plugin-updater')).check();
      if (!upd) { setState('none'); return; }
      updRef.current = upd; setNext(upd.version); setState('found');
    } catch { setState('error'); }
  }, []);
  const install = useCallback(async () => {
    setState('installing');
    try {
      await updRef.current.downloadAndInstall();
      setState('ready');
      await (await import('@tauri-apps/plugin-process')).relaunch();
    } catch { setState('error'); }
  }, []);
  if (!isApp) return null;
  const busy = state === 'checking' || state === 'installing';
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="card-title">{t('settings.update.title')}</span>
      <p style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
        {t('settings.update.current', { v: version || '—' })}
        {state === 'found' || state === 'installing' ? ` · ${t('settings.update.found', { v: next })}` : ''}
        {state === 'none' ? ` · ${t('settings.update.none')}` : ''}
      </p>
      {state === 'found' || state === 'installing' ? (
        <button type="button" className="btn btn-primary sm" onClick={install} disabled={busy} style={{ alignSelf: 'flex-start' }}>
          {busy ? <Spinner size={12} /> : null}
          {state === 'installing' ? t('settings.update.installing') : t('settings.update.install', { v: next })}
        </button>
      ) : (
        <button type="button" className="btn sm" onClick={check} disabled={busy} style={{ alignSelf: 'flex-start' }}>
          {busy ? <Spinner size={12} /> : null}{t('settings.update.check')}
        </button>
      )}
      {state === 'ready' && <p style={{ fontSize: 12, color: 'var(--fg-2)' }}>{t('settings.update.restarting')}</p>}
      {state === 'error' && <p style={{ fontSize: 12, color: 'var(--danger)' }}>{t('settings.update.error')}</p>}
    </div>
  );
}

function DevicesCard({ ws }) {
  const { t } = useLang();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  // 호스팅 인증(authOn)이면 계정 동기화로 대체됨 — 셀프호스팅 연결 코드 UI는 authOn=false일 때만
  const [authOn, setAuthOn] = useState(false);
  useEffect(() => { api('/api/me').then((d) => setAuthOn(!!d.authOn)).catch(() => {}); }, []);

  async function generate() {
    setBusy(true); setError(''); setCopied(false);
    try { setCode((await api(`/api/companies/${ws}/devices`, {})).code); }
    catch (e) { setError(String(e.message)); }
    setBusy(false);
  }

  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="card-title">{t('settings.devices.title')}</span>
      {authOn ? (
        <p style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{t('settings.devices.loginMode')}</p>
      ) : (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{t('settings.devices.desc')}</p>
          {!code ? (
            <button type="button" className="btn btn-primary sm" onClick={generate} disabled={busy} style={{ alignSelf: 'flex-start' }}>
              {busy ? <Spinner size={12} /> : null}{t('settings.devices.generate')}
            </button>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-2)', wordBreak: 'break-all' }}>
                  {code.slice(0, 26)}…{code.slice(-6)}
                </span>
                <button type="button" className="btn sm"
                  onClick={() => { navigator.clipboard?.writeText(code).catch(() => {}); setCopied(true); }}>
                  {copied ? t('common.copied') : t('common.copy')}
                </button>
              </div>
              <p style={{ fontSize: 11.5, color: 'var(--warn, var(--fg-2))' }}>{t('settings.devices.warn')}</p>
            </>
          )}
          {error && <p style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</p>}
        </>
      )}
    </div>
  );
}
