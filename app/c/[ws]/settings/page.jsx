'use client';
// 설정 — 회사 정보 수정, 제원, 위험 구역(보관).
import { Suspense, use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Icon, Spinner, Skeleton, DangerModal, ConfirmModal, api, imeGuard, isTauriApp, openFolderDialog, isFolderDialogBroken, FOLDER_DIALOG_EVENT } from '../../../ui';
import { useLang, KRW_RATE } from '../../../i18n';
import { useTheme, THEMES } from '../../../theme';
import { AiConnectionCard, fieldStyle, usableRunnerNames } from '../../../runner-connect';
import { useAppUpdate } from '../../../use-app-update';
import { proRowActive, trialBadgeState } from '../../../../src/entitlement.mjs';
import { CHANNEL_EVENTS } from '../../../../src/channel-events.mjs'; // 순수 상수 — connections.mjs는 fs를 끌어 클라 번들이 깨진다

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
      <ExportCard ws={ws} />
      <ImportCard ws={ws} />
      </Section>

      <div ref={aiRef} style={{ scrollMarginTop: 84 }}>
        <Section label={t('settings.ai.section')}>
          <AiConnectionCard ws={ws} accordion />
        </Section>
      </div>

      <Section label={t('settings.devices.section')}>
        <DevicesCard ws={ws} />
        <UpdateCard />
      </Section>

      <Section label={t('settings.capabilities')}>
        <WorkRootsCard ws={ws} />
        <SystemPermissionsCard />
      </Section>

      <Section label={t('settings.connections')}>
      <ConnectionCard ws={ws} kind="telegram" title={t('activity.telegram')}
        help={t('settings.conn.tgHelp')}
        agents={data?.agents ?? []} />
      <ConnectionCard ws={ws} kind="slack" title={t('activity.slack')}
        help={t('settings.conn.slackHelp')}
        agents={data?.agents ?? []} />
      <ConnectorsCard ws={ws} />
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
        <Link href="/legal" style={{ color: 'inherit' }}>{t('legal.link')}</Link>
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
  // 등록을 빠뜨리면 칩의 색 점이 **빈 원**으로 나온다(실사용 지적 2026-08-01) — 새 테마를 넣을 때 함께.
  graphite: ['#f0f0f0', '#202020', '#1a1a1a'],   // 자동 — 밝은 판·어두운 판을 함께 보여 시스템 따라감을 드러낸다
  'graphite-light': ['#f0f0f0', '#ffffff', '#1a1a1a'],
  'graphite-dark': ['#202020', '#252525', '#ededed'],
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

/** 폴더 지정 필드 — 데스크톱은 **버튼 하나로 Finder/탐색기**를 열고 고른 경로를 옆에 보여준다.
    경로 입력창은 웹 전용이다(브라우저는 실경로를 주지 않는다). 유건 지시 2026-07-28:
    "경로를 입력하는 창 자체가 필요 없이 버튼 누르면 finder 열려서 선택 가능해야 함".
    픽커가 실패하면(구버전 바이너리에 dialog 플러그인 부재 등) 그때만 입력창을 드러낸다 —
    감춘 채로 두면 사용자가 아무것도 못 하는 막다른 길이 된다(v0.1.32 실사고). */
function FolderField({ value, onChange, placeholder, pickTitle, disabled }) {
  const { t } = useLang();
  const [isApp, setIsApp] = useState(false);
  const [pickerDead, setPickerDead] = useState(false); // 실패 1회 → 입력 폴백 유지
  // 다른 카드의 실패·성공을 따라간다. 세 카드가 **동시에 떠 있어** 마운트 이펙트만으론 못 배우므로
  // 이벤트도 구독한다(재검수 LOW-2 — 안 그러면 카드마다 한 번씩 헛클릭이 그대로 남는다).
  useEffect(() => {
    setIsApp(isTauriApp());
    const sync = () => setPickerDead(isFolderDialogBroken());
    sync();
    window.addEventListener(FOLDER_DIALOG_EVENT, sync);
    return () => window.removeEventListener(FOLDER_DIALOG_EVENT, sync);
  }, []);

  async function pick() {
    try {
      const d = await openFolderDialog(pickTitle);
      if (d) onChange(d); // null = 사용자 취소 — 고른 값을 지우지 않는다
    } catch { setPickerDead(true); } // 사유는 아래 폴백에서 화면에 표시(warn은 openFolderDialog가 남긴다)
  }

  if (!isApp || pickerDead) {
    return (
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 4 }}>
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
          {...imeGuard} style={{ ...fieldStyle, width: '100%', fontSize: 12 }} />
        {/* 데스크톱인데 입력창이 보인다 = 픽커가 죽은 것 — 말없이 바꾸면 "버튼이 사라졌다"가 된다(분리 검수 H1) */}
        {isApp && <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: 0, lineHeight: 1.5 }}>{t('common.pickerUnavailable')}</p>}
      </div>
    );
  }
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
      <button className="btn" type="button" onClick={pick} disabled={disabled} style={{ flex: 'none' }}>
        <Icon name="folder" size={13} /> {t('common.browse')}
      </button>
      <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: 11.5, overflowWrap: 'anywhere', color: value ? 'var(--fg-1)' : 'var(--fg-3)' }}>
        {value || t('common.noFolderChosen')}
      </span>
    </div>
  );
}

/** 회사 데이터 내보내기 — 지정 폴더로 복사(백업·이사·보관. A갈래 신고 대응 2026-07-28).
    자격 파일(.secrets·connections·mcp)·심링크는 제외된다 — 정책 정본은 src/export.mjs. */
function ExportCard({ ws }) {
  const { t } = useLang();
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { target, files }
  const [err, setErr] = useState('');

  async function doExport(e) {
    e.preventDefault();
    if (busy || !dest.trim()) return;
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await api(`/api/companies/${ws}/export`, { dest: dest.trim() });
      setResult(r);
    } catch (ex) {
      const key = `settings.workroots.err.${String(ex.message || '')}`; // 목적지 검증 코드 공유(workroots 재사용)
      const mapped = t(key);
      setErr(mapped === key ? t('settings.export.err') : mapped);
    } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ padding: 18, gridColumn: '1 / -1', display: 'grid', gap: 8, alignContent: 'start' }}>
      <span className="card-title">{t('settings.export.title')}</span>
      <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('settings.export.desc')}</p>
      <form onSubmit={doExport} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <FolderField value={dest} onChange={setDest} placeholder={t('settings.export.placeholder')}
          pickTitle={t('settings.export.pickTitle')} disabled={busy} />
        <button className="btn" type="submit" disabled={busy || !dest.trim()} style={{ flex: 'none' }}>{busy ? <Spinner /> : t('settings.export.run')}</button>
      </form>
      {err && <p style={{ fontSize: 11.5, color: 'var(--danger)', margin: 0 }}>{err}</p>}
      {result && (
        <p style={{ fontSize: 11.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>
          {t('settings.export.done', { n: result.files })}
          <span className="mono" style={{ fontSize: 10.5, display: 'block', overflowWrap: 'anywhere' }}>{result.target}</span>
        </p>
      )}
      <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '2px 0 0', lineHeight: 1.6 }}>{t('settings.export.note')}</p>
    </div>
  );
}

/** 옵시디언에서 가져오기 — 외부 볼트를 Argo 기억 구조로 증류 복사(분류 정본은 src/obsidian-import.mjs).
    흐름: 폴더 선택 → 미리보기(드라이런) → 가져오기 → 진행률(실행 중에만 1초 폴링) → 결과+미분류 안내.
    덮어쓰기가 원천 없어(충돌은 접미 번호) DangerModal 불요 — 미리보기가 실행 확인 역할을 한다. */
function ImportCard({ ws }) {
  const { t } = useLang();
  const [src, setSrc] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(null);     // 드라이런 결과 — 실행 전 "몇 건이 어디로"
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null);
  const [err, setErr] = useState('');

  // 폴더가 바뀌면 이전 미리보기·결과는 무효 — 다른 볼트의 계획을 그대로 실행하는 사고를 막는다.
  function chooseSrc(v) { setSrc(v); setPlan(null); setResult(null); setErr(''); }

  function fail(ex) {
    const code = String(ex.message || '');
    // import 전용 코드 우선, 경로 검증 코드(workroots 재사용)는 기존 문구를 공유
    for (const k of [`settings.import.err.${code}`, `settings.workroots.err.${code}`]) {
      const m = t(k);
      if (m !== k) { setErr(m); return; }
    }
    setErr(t('settings.import.err'));
  }

  async function preview(e) {
    e.preventDefault();
    if (busy || !src.trim()) return;
    setBusy(true); setErr(''); setPlan(null); setResult(null);
    try { setPlan(await api(`/api/companies/${ws}/import/obsidian`, { src: src.trim(), dryRun: true })); }
    catch (ex) { fail(ex); }
    finally { setBusy(false); }
  }

  async function run() {
    if (busy || !plan) return;
    setBusy(true); setErr(''); setResult(null); setProgress(null);
    const poll = setInterval(async () => {
      try {
        const s = await api(`/api/companies/${ws}/import/obsidian`);
        if (s?.phase === 'copy') setProgress(s);
      } catch { /* 진행 표시는 장식 — 실패해도 임포트는 계속 */ }
    }, 1000);
    try {
      const r = await api(`/api/companies/${ws}/import/obsidian`, { src: src.trim() });
      setResult(r); setPlan(null);
    } catch (ex) { fail(ex); }
    finally { clearInterval(poll); setBusy(false); setProgress(null); }
  }

  const planVars = (x) => ({ j: x.journal, n: x.notes, f: x.files, u: x.unsorted, s: x.skipped, a: x.already });
  return (
    <div className="card" style={{ padding: 18, gridColumn: '1 / -1', display: 'grid', gap: 8, alignContent: 'start' }}>
      <span className="card-title">{t('settings.import.title')}</span>
      <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('settings.import.desc')}</p>
      <form onSubmit={preview} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <FolderField value={src} onChange={chooseSrc} placeholder={t('settings.import.placeholder')}
          pickTitle={t('settings.import.pickTitle')} disabled={busy} />
        <button className="btn" type="submit" disabled={busy || !src.trim()} style={{ flex: 'none' }}>{busy && !plan ? <Spinner /> : t('settings.import.preview')}</button>
      </form>
      {plan && (
        <div style={{ display: 'grid', gap: 6 }}>
          <p style={{ fontSize: 12, color: 'var(--fg-1)', margin: 0 }}>{t('settings.import.plan', planVars(plan))}</p>
          {plan.filesItems?.length > 0 && (
            // 첨부로 "무엇이" 들어오는지 실행 전에 보여준다 — 개수만으로는 볼트 아닌 폴더를 고른
            // 오조작(문서 폴더 통째 등)을 알아챌 지점이 없다(분리 검수 HIGH-1의 UI 축)
            <p style={{ fontSize: 11.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>
              {t('settings.import.filesPreview', { n: plan.files })}{' '}
              <span className="mono" style={{ fontSize: 10.5, overflowWrap: 'anywhere' }}>
                {plan.filesItems.slice(0, 5).join(', ')}{plan.files > 5 ? ` … (+${plan.files - 5})` : ''}
              </span>
            </p>
          )}
          <p style={{ fontSize: 11.5, color: 'var(--fg-2)', margin: 0 }}>{t('settings.import.planGo')}</p>
          <div>
            <button className="btn btn-primary" type="button" onClick={run} disabled={busy}>
              {busy ? <Spinner /> : t('settings.import.run')}
            </button>
          </div>
        </div>
      )}
      {progress && (
        <p style={{ fontSize: 11.5, color: 'var(--fg-2)', margin: 0 }}>{t('settings.import.progress', { done: progress.done ?? 0, total: progress.total ?? 0 })}</p>
      )}
      {err && <p style={{ fontSize: 11.5, color: 'var(--danger)', margin: 0 }}>{err}</p>}
      {result && (
        <div style={{ display: 'grid', gap: 4 }}>
          <p style={{ fontSize: 12, color: 'var(--fg-1)', margin: 0 }}>{t('settings.import.done', planVars(result))}</p>
          {result.unsorted > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--fg-2)', lineHeight: 1.6 }}>
              {t('settings.import.unsorted', { n: result.unsorted })}
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {result.unsortedItems.slice(0, 6).map((u) => (
                  <li key={u.rel} className="mono" style={{ fontSize: 10.5, overflowWrap: 'anywhere' }}>
                    {u.rel} — {t(`settings.import.reason.${u.reason}`)}
                  </li>
                ))}
              </ul>
              {result.unsorted > 6 && <span>{t('settings.import.unsortedMore', { n: result.unsorted - 6 })}</span>}
            </div>
          )}
          {result.skipped > 0 && result.skippedItems?.length > 0 && (
            // "무엇을 안 가져왔는지"가 오조작 감지의 핵심 — 숫자만 보여주면 이유는 리포트를 열어야
            // 안다(재검수 관찰 반영). 미분류와 같은 규격으로 상위 6건 + 이유를 그 자리에서 노출.
            <div style={{ fontSize: 11.5, color: 'var(--fg-2)', lineHeight: 1.6 }}>
              {t('settings.import.skippedList', { n: result.skipped })}
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {result.skippedItems.slice(0, 6).map((s) => (
                  <li key={s.rel} className="mono" style={{ fontSize: 10.5, overflowWrap: 'anywhere' }}>
                    {s.rel} — {t(`settings.import.reason.${s.reason}`)}
                  </li>
                ))}
              </ul>
              {result.skipped > 6 && <span>{t('settings.import.unsortedMore', { n: result.skipped - 6 })}</span>}
            </div>
          )}
          {result.reportRel && (
            <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: 0 }}>
              {t('settings.import.report')}:{' '}
              <a href={`/api/companies/${ws}/files?rel=${encodeURIComponent(result.reportRel.replace(/^vault\//, ''))}`}
                target="_blank" rel="noopener noreferrer" className="mono"
                style={{ fontSize: 10.5, overflowWrap: 'anywhere', color: 'var(--fg-2)' }}>
                {result.reportRel}
              </a>
            </p>
          )}
        </div>
      )}
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



/** 외부 작업 폴더 — 사장이 지정한 폴더를 크루의 확장 책상으로 연다(fs 능력과 독립 — "전부"가 아니라
    "이 폴더만" 여는 더 좁은 위임). 기기 로컬(경로는 기기 고유값 — 동기화 안 됨). 실사용 신고 최다
    클러스터(홈 밖 경로 차단, 11건) 해소. 검증·보안 경계는 src/workroots.mjs가 정본. */
/** 로그인만으로 붙는 외부 서비스(커넥터) — 카탈로그 × 이 회사 연결 상태.
    "연결"은 브라우저 동의 창을 열고 **끝나기를 기다리지 않는다**(사용자가 구글에서 로그인하는 동안
    응답이 막히면 화면이 죽은 것처럼 보인다). 완료는 목록을 다시 읽어 상태로 관측한다 — 코어와 같은 계약. */
function ConnectorsCard({ ws }) {
  const { t } = useLang();
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [waiting, setWaiting] = useState('');

  const load = useCallback(() => api(`/api/companies/${ws}/connectors`)
    // 로드 실패를 "연결할 게 없음"과 구분한다 — 일시 장애가 카탈로그 소실처럼 읽히면 안 된다.
    .then((d) => setRows(d.connectors ?? []))
    .catch(() => { setRows([]); setErr(t('settings.connectors.err.load')); }), [ws, t]);
  useEffect(() => { load(); }, [load]);

  // 동의 창이 떠 있는 동안만 짧게 폴링 — 인가는 다른 창에서 끝나므로 이 화면은 알 길이 없다.
  useEffect(() => {
    if (!waiting) return undefined;
    const iv = setInterval(load, 2500);
    const stop = setTimeout(() => setWaiting(''), 180_000); // 코어 인가 타임아웃과 같은 지평
    return () => { clearInterval(iv); clearTimeout(stop); };
  }, [waiting, load]);
  useEffect(() => {
    if (waiting && rows?.find((r) => r.id === waiting)?.status === 'connected') setWaiting('');
  }, [rows, waiting]);

  async function act(id, action) {
    if (busy) return;
    setBusy(id); setErr('');
    try {
      const d = await api(`/api/companies/${ws}/connectors`, { id, action });
      if (action === 'connect' && d.authUrl) {
        window.open(d.authUrl, '_blank', 'noopener,noreferrer'); // 동의는 사용자 계정 행위 — 새 창에서
        setWaiting(id);
      }
      await load();
    } catch (e) {
      setErr(String(e.message));
    } finally { setBusy(''); }
  }

  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{t('settings.connectors.title')}</strong>
      </div>
      <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: 0, lineHeight: 1.7 }}>{t('settings.connectors.help')}</p>
      {rows === null && <Skeleton h={44} />}
      {rows?.length === 0 && <p style={{ fontSize: 12, color: 'var(--fg-3)', margin: 0 }}>{t('settings.connectors.empty')}</p>}
      {rows?.map((r) => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--border-soft)' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</span>
              <span className="chip" style={{ fontSize: 10 }}>{t(`settings.connectors.status.${r.status}`)}</span>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--fg-2)', margin: '3px 0 0', lineHeight: 1.6 }}>{r.note}</p>
            {/* 연결 뒤에도 결재가 필요한 것을 미리 알린다 — 눌러 보고서야 알면 "왜 안 되지"가 된다. */}
            {!!r.dangerous?.length && (
              <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '3px 0 0' }}>
                {t('settings.connectors.approvalNote', { n: r.dangerous.length })}
              </p>
            )}
            {r.error && <p style={{ fontSize: 11.5, color: 'var(--danger)', margin: '3px 0 0' }}>{r.error}</p>}
          </div>
          {r.notReady ? (
            /* 이 빌드에 연결 자격이 안 실렸다 — 버튼을 그리면 눌렀을 때 개발자용 오류가 뜬다.
               못 하는 것은 화면에 정직하게 적는다(조용한 무동작·거짓 버튼 금지). */
            <span className="chip" style={{ flex: 'none' }}>{t('settings.connectors.notReady')}</span>
          ) : r.status === 'connected' ? (
            <button type="button" className="btn sm" disabled={busy === r.id} onClick={() => act(r.id, 'disconnect')}>
              {busy === r.id ? <Spinner size={12} /> : t('settings.connectors.disconnect')}
            </button>
          ) : (
            <button type="button" className="btn sm btn-primary" disabled={busy === r.id} onClick={() => act(r.id, 'connect')}>
              {busy === r.id ? <Spinner size={12} /> : t(r.status === 'reauth' ? 'settings.connectors.reconnect' : 'settings.connectors.connect')}
            </button>
          )}
        </div>
      ))}
      {waiting && <p style={{ fontSize: 11.5, color: 'var(--fg-2)', margin: 0 }}>{t('settings.connectors.waiting')}</p>}
      {err && <p style={{ fontSize: 11.5, color: 'var(--danger)', margin: 0 }}>{err}</p>}
    </div>
  );
}

function WorkRootsCard({ ws }) {
  const { t } = useLang();
  const [roots, setRoots] = useState(null);
  const [max, setMax] = useState(8);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    // 로드 실패를 빈 목록과 구분 — "없습니다"로 보이면 일시 장애가 데이터 소실처럼 읽힌다(분리 검수 LOW)
    api(`/api/companies/${ws}/workroots`).then((d) => { setRoots(d.roots); setMax(d.max); })
      .catch(() => { setRoots([]); setErr(t('settings.workroots.err.load')); });
  }, [ws]);

  async function mutate(body) {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      const d = await api(`/api/companies/${ws}/workroots`, body);
      setRoots(d.roots);
      if (body.add) setInput('');
    } catch (e) {
      // 서버는 코드만 반환(K7 계열 예방) — 여기서 i18n 매핑. 미등록 코드는 일반 문구로.
      const key = `settings.workroots.err.${String(e.message || '')}`;
      const mapped = t(key);
      setErr(mapped === key ? t('settings.workroots.err.invalid') : mapped);
    } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ padding: 18, gridColumn: '1 / -1', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="card-title">{t('settings.workroots.title')}</span>
        <span className="chip">{t('settings.workroots.deviceLocal')}</span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('settings.workroots.desc')}</p>
      {roots === null ? <Skeleton h={60} /> : (
        <>
          {roots.length === 0 && <p style={{ fontSize: 12, color: 'var(--fg-3)', margin: '4px 0' }}>{t('settings.workroots.empty')}</p>}
          {roots.map((r) => (
            <div key={r} className="row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px' }}>
              <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: 11.5, overflowWrap: 'anywhere' }}>{r}</span>
              <button className="btn" onClick={() => mutate({ remove: r })} disabled={busy} style={{ fontSize: 11.5 }}>
                {t('settings.workroots.remove')}
              </button>
            </div>
          ))}
          {roots.length < max && (
            <form onSubmit={(e) => { e.preventDefault(); if (input.trim()) mutate({ add: input.trim() }); }}
              style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
              <FolderField value={input} onChange={setInput} placeholder={t('settings.workroots.placeholder')}
                pickTitle={t('settings.workroots.pickTitle')} disabled={busy} />
              <button className="btn" type="submit" disabled={busy || !input.trim()} style={{ flex: 'none' }}>{busy ? <Spinner /> : t('settings.workroots.add')}</button>
            </form>
          )}
          {err && <p style={{ fontSize: 11.5, color: 'var(--danger)', margin: '2px 0 0' }}>{err}</p>}
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '6px 0 0', lineHeight: 1.6 }}>{t('settings.workroots.runnerNote')}</p>
        </>
      )}
    </div>
  );
}

/** 시스템 권한 — 데스크톱(Tauri) 전용 안내 카드. 외부 작업 폴더로 크루가 데스크톱·문서·외장
    디스크를 만질 때 OS가 막는 두 갈래를 다룬다: macOS는 TCC(폴더 접근은 첫 접근 시 OS가 묻고,
    전체 디스크 접근은 앱이 직접 요청 불가 — 시스템 설정 딥링크만 가능), Windows는 '제어된 폴더
    액세스'(랜섬웨어 방지)가 쓰기를 조용히 차단한다(실신고: 외장 SSD·문서 폴더). 권한 상태
    실조회는 macOS API가 필요해 후속 — 1차는 안내·딥링크만(2026-07-28 스펙). */
function SystemPermissionsCard() {
  const { t } = useLang();
  // 'mac' | 'win' | null(웹·리눅스 — 카드 자체를 렌더하지 않음). SSR 불일치 방지로 마운트 후 판별.
  const [os, setOs] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!isTauriApp()) return; // 감지는 ui.jsx 단일 출처(use-app-update의 inTauri와 동일 식 — 중복 방지)
    if (/Mac/.test(navigator.platform)) setOs('mac');
    else if (/Win/.test(navigator.platform)) setOs('win');
  }, []);
  if (!os) return null;

  // 설정 딥링크는 http(s)가 아니라 layout의 링크 브리지를 안 탄다 — opener를 직접 호출.
  // openUrl은 async — 스코프 거부·OS 실패가 rejection으로 오므로 catch로 표면화(분리 검수 M2:
  // 이미 막혀서 온 사용자에게 무반응이 최악). capabilities/default.json의 딥링크 허용 목록과 한 쌍.
  const open = (url) => {
    setErr('');
    Promise.resolve(window.__TAURI__?.opener?.openUrl(url))
      .catch(() => setErr(t('settings.perms.openErr')));
  };

  return (
    <div className="card" style={{ padding: 18, gridColumn: '1 / -1', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="card-title">{t('settings.perms.title')}</span>
        <span className="chip">{os === 'mac' ? 'macOS' : 'Windows'}</span>
      </div>
      {os === 'mac' ? (
        <>
          <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('settings.perms.mac.desc')}</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn sm" onClick={() => open('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders')}>
              {t('settings.perms.mac.filesBtn')}
            </button>
            <button type="button" className="btn sm" onClick={() => open('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')}>
              {t('settings.perms.mac.fdaBtn')}
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '2px 0 0', lineHeight: 1.6 }}>{t('settings.perms.mac.fdaNote')}</p>
        </>
      ) : (
        <>
          <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('settings.perms.win.desc')}</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn sm" onClick={() => open('windowsdefender://ransomwareprotection')}>
              {t('settings.perms.win.securityBtn')}
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '2px 0 0', lineHeight: 1.6 }}>{t('settings.perms.win.note')}</p>
        </>
      )}
      {err && <p style={{ fontSize: 11.5, color: 'var(--danger)', margin: '2px 0 0' }}>{err}</p>}
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
      // mutedEvents만은 화면 값을 지킨다 — 디바운스 저장이 아직 안 나갔으면 서버 응답엔 토글 이전 값이
      // 들어 있어, 방금 끈 알림이 다시 켜진 것처럼 보인다(분리 검수 실측). 디스크는 뒤이은 POST가 맞춘다.
      setConn((c) => ({ ...d.connections[kind], ...(c?.mutedEvents ? { mutedEvents: c.mutedEvents } : {}) }));
      setToken('');
      setMsg(enabled ? t('settings.conn.enabling') : t('settings.conn.stopped'));
    } catch (e) {
      setMsg(String(e.message));
    } finally {
      setSaving(false);
    }
  }

  const muted = conn?.mutedEvents ?? [];
  /** 알림 종류 토글 — 화면은 즉시 움직이고 저장은 마지막 클릭 기준 1회만 보낸다.
      클릭마다 POST하면 왕복·fsync·동기화 업로드가 클릭 수만큼 쌓인다(정리 검수 실측). enabled를
      안 보내므로 토큰 재검증(네트워크)도 없다. 응답으로 상태를 덮지 않는다 — 쓰는 주체가 둘이면
      연속 클릭 때 이전 응답이 나중 선택을 되돌린다. */
  const muteSave = useRef(null);
  const mutePending = useRef(null);
  // 화면을 뜨면 대기 중인 저장을 흘려보낸다 — 500ms 안에 이동하면 끈 알림이 조용히 되살아난다.
  useEffect(() => () => {
    if (!muteSave.current) return;
    clearTimeout(muteSave.current);
    api(`/api/companies/${ws}/connections`, { kind, mutedEvents: mutePending.current }).catch(() => {});
  }, [ws, kind]);
  function toggleEvent(ev) {
    const next = muted.includes(ev) ? muted.filter((x) => x !== ev) : [...muted, ev];
    setConn((c) => ({ ...c, mutedEvents: next })); // 함수형 — 연속 클릭의 stale 스냅샷 덮어쓰기 방지
    clearTimeout(muteSave.current);
    mutePending.current = next;
    muteSave.current = setTimeout(() => {
      muteSave.current = null;
      api(`/api/companies/${ws}/connections`, { kind, mutedEvents: next }).catch((e) => setMsg(String(e.message)));
    }, 500);
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
      {/* 이 채널로 보낼 알림 — 연결을 끊지 않고 종류별로 끈다(끈 것은 앱에 그대로 남는다). */}
      {conn?.hasToken && (
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="microlabel">{t('settings.conn.notify')}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {CHANNEL_EVENTS[kind].map((ev) => {
              const onEv = !muted.includes(ev);
              return (
                <button key={ev} type="button" className="chip" onClick={() => toggleEvent(ev)} aria-pressed={onEv}
                  style={{
                    cursor: 'pointer', padding: '5px 12px', fontSize: 12, textTransform: 'none', letterSpacing: 0,
                    ...(onEv ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' } : { opacity: 0.6 }),
                  }}>
                  {t(`settings.conn.ev.${ev}`)}
                </button>
              );
            })}
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>{t('settings.conn.notifyHint')}</span>
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
  const [bill, setBill] = useState(null); // LS 구독 상태(연체·포털) — 없으면 표면 자체가 없다
  useEffect(() => {
    const pull = () => api(`/api/companies/${ws}/connections`).then((d) => setSync(d.sync ?? null)).catch(() => {});
    pull();
    // reconciling=true — 서버가 방금 유실 대사(O2)를 백그라운드로 발사했다는 신호. billing은
    // 폴링이 없어서(1회성 fetch) 잠시 뒤 1회 재조회해야 복구가 리로드 없이 보인다.
    let retry = null;
    api('/api/me/billing').then((d) => {
      setBill(d.billing ?? null);
      if (d.reconciling) retry = setTimeout(() => api('/api/me/billing').then((d2) => setBill(d2.billing ?? null)).catch(() => {}), 8000);
    }).catch(() => {});
    const iv = setInterval(pull, 15000);
    return () => { clearInterval(iv); if (retry) clearTimeout(retry); };
  }, [ws]);
  // 체험 D-day — 동기화를 켠 적 없는 체험자(최대 코호트)도 보여야 해서 sync가 아닌 bill에서 계산.
  // 판정은 trialBadgeState(entitlement.mjs) 단일 원천 — 만료 하한 누락으로 만료자에게 'D-0' 영구
  // 표시되던 회귀(분리 검수 H1)가 그 함수의 테스트로 잠겨 있다.
  const { active: trialActive, imminent: trialImminent, daysLeft: trialDaysLeft } = trialBadgeState(bill?.trialEndsAt, bill?.plan);
  // 표시·결제 분기는 **로그인 계정** 기준이다. sync.plan은 이 기기의 동기화 주체(기기 연동 계정)의
  // 것이라, 한 컴퓨터를 여러 사람이 쓰면 남의 플랜이 보인다(실측 2026-08-05: 무료 계정으로 로그인해도
  // 기기 주인이 Pro면 Pro 배지가 뜨고 업그레이드 버튼이 숨겨졌다 — 낼 방법이 사라진다).
  // bill은 /api/me/billing = currentUser() 경유라 계정별이다. 판정은 서버 is_pro와 같은 공유 술어로.
  // 로컬·게스트(bill=null)만 기기값으로 폴백한다 — 그 모드엔 계정이 없다.
  const acctPlan = bill
    ? (proRowActive({ plan: bill.plan, ends_at: bill.endsAt }) ? 'pro' : trialActive ? 'trial' : 'free')
    : null;
  const plan = acctPlan ?? sync?.plan ?? null;
  const mine = sync?.companies?.[ws];
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="card-title">{t('settings.sync.title')}</span>
        <span style={{ flex: 1 }} />
        {plan === 'pro' ? (
          <span className="pill ok" style={{ flex: 'none' }}>{t('billing.plan.pro')}</span>
        ) : plan === 'trial' || (!plan && trialActive) ? (
          <span className="pill ok" style={{ flex: 'none' }}>
            {trialActive ? t('billing.trialDday', { n: trialDaysLeft }) : t('billing.plan.trial')}
          </span>
        ) : plan === 'free' ? (
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
            {/* 카운터는 **있을 때만** 찍는다 — 이번 사이클에 스킵된 회사(free-plan·foreign-owner)의
                항목은 { ts, skipped }뿐이라 mine 존재만 보면 "↑undefined ↓undefined"가 그대로 노출된다. */}
            {mine?.pushed != null ? ` · ↑${mine.pushed} ↓${mine.pulled}` : ''}
          </span>
          {sync.paywalled ? (
            // "고장"(lastError)과 "페이월"은 다른 상태 — 여기선 빨간 에러 줄 대신 안내+업그레이드를 보인다.
            <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              <span style={{ color: 'var(--danger)', fontSize: 12 }}>
                {/* FREE_STATUSES(lsbilling.mjs)와 동기 유지 — 직접 import하면 node:crypto가 클라 번들에 끌려온다 */}
                {['expired', 'unpaid', 'paused'].includes(bill?.status) ? t('billing.cloudPaused') : t('billing.paywall')}
              </span>
              <UpgradeButtons />
            </div>
          ) : sync.lastError ? (
            <span style={{ color: 'var(--danger)', fontSize: 12 }}>{sync.lastError}</span>
          ) : plan === 'free' ? (
            // 아직 막히진 않았지만(강제 게이트 off 등) free 플랜에 안내 차원으로 노출 — pro면 숨김
            <UpgradeButtons />
          ) : trialActive && !trialImminent ? (
            // 체험 중(D-14~D-4) — 이 구간에 결제 수단이 아예 없었다(실사용 확인 2026-08-05: 신규 계정은
            // plan='trial'이라 free·paywalled·임박 어디에도 안 걸려 버튼이 화면에서 사라졌다).
            // 지금 내겠다는 사람이 낼 수 없는 상태였다. 임박 전이므로 재촉하지 않고 한 줄로만 알린다.
            <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{t('billing.trialUpgradeHint')}</span>
              <UpgradeButtons />
            </div>
          ) : null}
          {trialImminent && (
            // 체험 종료 임박(3일 이내) — 카드 등록 없이 시작한 사용자에게 여기서 처음 결제를 권한다.
            // 협박이 아니라 안심 화법. 본문은 --fg-2(대비 7.45:1 — --primary-strong 2.11:1은 AA 미달, 검수 MEDIUM).
            <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
              <span style={{ color: 'var(--fg-2)', fontSize: 12, fontWeight: 650 }}>{t('billing.trialEnding')}</span>
              <UpgradeButtons />
            </div>
          )}
          {/* 클라우드 자료 내보내기 — 위 분기 사슬과 **직교**로 렌더한다(분리 검수 CRITICAL 2026-07-28).
              사슬 안에 넣으면 ARGO_ENFORCE_PLAN off 구간의 free 사용자가 lastError 분기(RLS push 거부가
              매 사이클 lastError를 채운다)에 걸려 버튼을 영영 못 본다. 데이터 반환 경로는 동기화 고장
              여부와 무관해야 한다 — "데이터 인질 금지"의 요지. plan이 free로 확정됐거나 페이월이면 노출. */}
          {(sync.paywalled || plan === 'free') && <CloudExportRow />}
          {bill?.status === 'past_due' && bill?.hasSub && (
            // 연체 유예 중 — 차단이 아니라 안내다(LS 던닝이 재시도 중, 유예 소진 시 free 강등).
            // href는 클릭 시점 발급 라우트 — 저장된 포털 URL은 24시간 만료라 렌더 금지(재검수 HIGH).
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
              <span style={{ color: 'var(--danger)', fontSize: 12 }}>{t('billing.pastDue')}</span>
              <a className="btn sm" href="/api/me/billing/portal" target="_blank" rel="noreferrer">{t('billing.managePortal')}</a>
            </div>
          )}
          {plan === 'pro' && bill?.hasSub && bill?.status !== 'past_due' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {bill?.status === 'cancelled' && bill?.endsAt && (
                // 해지 유예 중 — 언제까지 쓸 수 있는지 보이게(연간 구독은 해를 넘길 수 있어 연도 포함)
                <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                  {t('billing.cancelledUntil', { date: new Date(bill.endsAt).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'en-US') })}
                </span>
              )}
              <a style={{ fontSize: 12, color: 'var(--fg-3)', width: 'fit-content' }} href="/api/me/billing/portal" target="_blank" rel="noreferrer">{t('billing.managePortal')}</a>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <p style={{ fontSize: 12.5, color: 'var(--fg-3)', margin: 0, lineHeight: 1.55 }}>{t('settings.sync.offHelp')}</p>
          {trialImminent ? (
            // 동기화를 안 켠 체험자에게도 임박 안내 — 이들이 가장 큰 코호트(검수 커버리지 질문 → 포함 결정)
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--fg-2)', fontSize: 12, fontWeight: 650 }}>{t('billing.trialEnding')}</span>
              <UpgradeButtons />
            </div>
          ) : trialActive ? (
            // 임박 전 체험 구간 — 위 sync.on 분기와 같은 이유로 결제 경로를 열어 둔다
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{t('billing.trialUpgradeHint')}</span>
              <UpgradeButtons />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 클라우드 자료 내보내기 — 체험 만료(free) 사용자가 버튼 한 번으로 클라우드에 동결된 자기 자료를
    ~/Documents/Argo-cloud-export-YYYYMMDD/<회사명>/ 아래로 내려받는다("데이터 인질 금지" 원칙).
    목적지·오너는 서버가 정한다(입력 없음) — 정본은 src/cloudexport.mjs. 자격 파일은 제외된다. */
function CloudExportRow() {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { target, files, failed }
  const [err, setErr] = useState('');

  async function run() {
    if (busy) return; // 서버 in-flight 가드와 이중 방어 — 진행 중 재클릭 무시
    setBusy(true); setErr(''); setResult(null);
    try {
      setResult(await api('/api/me/cloud-export', {}));
    } catch (ex) {
      const key = `settings.cloudExport.err.${String(ex.message || '')}`;
      const mapped = t(key);
      setErr(mapped === key ? t('settings.cloudExport.err') : mapped);
    } finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={run} disabled={busy}>{busy ? <Spinner /> : t('settings.cloudExport.run')}</button>
        <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{t('settings.cloudExport.hint')}</span>
      </div>
      {err && <p style={{ fontSize: 11.5, color: 'var(--danger)', margin: 0 }}>{err}</p>}
      {result && (
        <p style={{ fontSize: 11.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>
          {t('settings.cloudExport.done', { n: result.files })}
          {result.failed > 0 ? ` ${t('settings.cloudExport.partial', { n: result.failed })}` : ''}
          <span className="mono" style={{ fontSize: 10.5, display: 'block', overflowWrap: 'anywhere' }}>{result.target}</span>
        </p>
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
  // 결제 의사 신호(fire-and-forget) — 방금 대사가 "구독 없음"을 확정했어도, 곧 결제할 사용자의
  // 복구(웹훅 유실 시 O2 대사)가 24시간 잠기지 않게 부정 확정 게이트만 해제한다. 실패 무해.
  const intent = () => api('/api/me/billing/intent', {}).catch(() => {});
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {LS_MONTHLY && (
        <a className="btn btn-primary sm" href={withRef(LS_MONTHLY)} onClick={intent} target="_blank" rel="noreferrer">{t('billing.upgradeMonthly')}</a>
      )}
      {LS_YEARLY && (
        <a className="btn sm" href={withRef(LS_YEARLY)} onClick={intent} target="_blank" rel="noreferrer">{t('billing.upgradeYearly')}</a>
      )}
    </div>
  );
}

/** 기기 페어링 카드 — 연결 코드를 발급해 다른 기기 홈 화면에 붙여넣으면 이 회사가 그 기기로 내려간다. */
// 앱 업데이트 — Tauri 데스크톱 안에서만 노출. 버튼 하나로 확인 → 다운로드·설치 → 재시작.
// 서명 검증·다운로드는 Rust(updater 플러그인)가 수행, 매니페스트는 argo-agent 릴리스의 latest.json.
function UpdateCard() {
  const { t } = useLang();
  // 상단 뱃지와 동일한 단일 출처(use-app-update) — 네이티브 설치 버전 + Tauri 업데이터.
  const { isApp, current, available, checked, phase, check, install } = useAppUpdate();
  const busy = phase === 'checking' || phase === 'installing';
  // 웹(상주·셀프호스트) — 자가 설치는 없지만 새 버전 존재를 알리고 갱신 방법을 안내한다
  // (실사용 요청 2026-07-27). 데스크톱과 같은 카드 자리·같은 훅(단일 출처).
  if (!isApp) {
    return (
      <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span className="card-title">{t('settings.update.title')}</span>
        <p style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
          {t('settings.update.current', { v: current || '—' })}
          {available ? ` · ${t('settings.update.found', { v: available })}` : ''}
          {!available && checked ? ` · ${t('settings.update.none')}` : ''}
        </p>
        {available && (
          <p style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.7, margin: 0 }}>{t('settings.update.webHow')}</p>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn sm" onClick={check} disabled={busy}>
            {busy ? <Spinner size={12} /> : null}{t('settings.update.check')}
          </button>
          {available && (
            <a className="btn btn-primary sm" href="https://github.com/beyondworks/argo-agent/releases/latest" target="_blank" rel="noopener noreferrer">
              {t('settings.update.webRelease')}
            </a>
          )}
        </div>
        {phase === 'error' && <p style={{ fontSize: 12, color: 'var(--danger)' }}>{t('settings.update.error')}</p>}
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="card-title">{t('settings.update.title')}</span>
      <p style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
        {t('settings.update.current', { v: current || '—' })}
        {available ? ` · ${t('settings.update.found', { v: available })}` : ''}
        {!available && checked ? ` · ${t('settings.update.none')}` : ''}
      </p>
      {available ? (
        <button type="button" className="btn btn-primary sm" onClick={install} disabled={busy} style={{ alignSelf: 'flex-start' }}>
          {busy ? <Spinner size={12} /> : null}
          {phase === 'installing' ? t('settings.update.installing') : t('settings.update.install', { v: available })}
        </button>
      ) : (
        <button type="button" className="btn sm" onClick={check} disabled={busy} style={{ alignSelf: 'flex-start' }}>
          {busy ? <Spinner size={12} /> : null}{t('settings.update.check')}
        </button>
      )}
      {phase === 'ready' && <p style={{ fontSize: 12, color: 'var(--fg-2)' }}>{t('settings.update.restarting')}</p>}
      {phase === 'error' && <p style={{ fontSize: 12, color: 'var(--danger)' }}>{t('settings.update.error')}</p>}
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
