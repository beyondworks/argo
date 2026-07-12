'use client';
// 설정 — 회사 정보 수정, 제원, 위험 구역(보관).
import { use, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon, Spinner, Skeleton, DangerModal, api, imeGuard } from '../../../ui';
import { useLang, KRW_RATE } from '../../../i18n';
import { useTheme, THEMES } from '../../../theme';

export default function Settings({ params }) {
  const { ws } = use(params);
  const { t, lang } = useLang();
  const router = useRouter();
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [budget, setBudget] = useState(''); // 화면 표시값 — ko는 원화, en은 달러
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

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
    [t('deck.nameplate.engine'), 'Claude Agent SDK'],
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

      <LanguageCard />
      <ThemeCard />
      </Section>

      <Section label={t('settings.ai.section')}>
        <AiConnectionCard ws={ws} />
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

/** 테마 스와치 — 각 테마의 캔버스/카드/프라이머리 토큰을 그대로 보여주는 미니 프리뷰. */
const THEME_SWATCHES = {
  argo: ['#e3e5d6', '#e9ebdd', '#22241c'],
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
};

function ThemeCard() {
  const { theme, setTheme } = useTheme();
  const { t } = useLang();
  return (
    <div className="card" style={{ padding: 18, gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="card-title">{t('settings.theme')}</span>
      <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('settings.theme.desc')}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {THEMES.map((code) => {
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

/** AI 연결(러너별 BYOK/BYOA) — 4러너(Claude·Codex·Gemini·GLM) 각각을 회사 계정에 연결하는 관문.
    러너마다 (a) 상태 칩(회사 연결됨/이 컴퓨터 로그인/미연결) (b) 인증 방식 선택(API키·OAuth)
    (c) 방식별 입력·저장·검증·제거 또는 CLI 로그인 안내. 응답엔 마스킹만 실린다(보안 규칙). */
const RUNNER_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', glm: 'GLM' };
const RUNNER_ORDER = ['claude', 'codex', 'gemini', 'glm'];

function AiConnectionCard({ ws }) {
  const { t } = useLang();
  const [runners, setRunners] = useState(null); // { [id]: status } | null(로딩)

  function load() {
    api(`/api/companies/${ws}/keys`).then((d) => setRunners(d.runners ?? {})).catch(() => setRunners({}));
  }
  useEffect(load, [ws]);

  return (
    <div className="card" style={{ padding: 18, gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="card-title">{t('settings.runners.title')}</span>
      <p style={{ fontSize: 12, color: 'var(--fg-2)', margin: '4px 0 6px', lineHeight: 1.6 }}>{t('settings.runners.help')}</p>
      {!runners ? <Skeleton h={180} /> : RUNNER_ORDER.map((id, i) => (
        <RunnerRow key={id} ws={ws} id={id} st={runners[id]} onChange={load} first={i === 0} />
      ))}
    </div>
  );
}

/** 러너 1행 — 상태 칩 + 방식 탭 + (API키/붙여넣기 토큰 입력) 또는 (CLI 로그인 안내). */
function RunnerRow({ ws, id, st, onChange, first }) {
  const { t } = useLang();
  const methods = st?.methods ?? ['apikey'];
  const hasOauth = methods.includes('oauth');
  const oauthPaste = !!st?.oauthPasteable;
  const connectable = !!st?.connectable;
  const company = st?.company ?? { connected: false };
  const [method, setMethod] = useState(company.connected ? company.type : 'apikey');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef(null);   // setInterval 핸들
  const pollN = useRef(0);        // 폴링 횟수 (최대 60 = 약 2분)
  const alive = useRef(true);     // 언마운트 후 stale setState 차단

  // 연결/제거로 상태가 바뀌면 선택 방식을 회사 연결 방식에 맞춘다
  useEffect(() => { if (company.connected) setMethod(company.type); }, [company.connected, company.type]);

  // 언마운트 시 폴링 정리 — stale 폴링/setState 누수 방지
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, []);

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (alive.current) setPolling(false);
  }

  function startPoll() {
    pollN.current = 0;
    setPolling(true);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      pollN.current += 1;
      if (pollN.current > 60) { stopPoll(); return; }
      try {
        const res = await fetch(`/api/companies/${ws}/keys/connect?runner=${encodeURIComponent(id)}`);
        const d = await res.json();
        if (!alive.current) return;
        if (d.authed) {
          stopPoll();
          setOk(true); setMsg(t('settings.runners.connected'));
          window.dispatchEvent(new Event('argo:refresh'));
          onChange();
        }
      } catch { /* 폴링 실패는 조용히 재시도 */ }
    }, 2000);
  }

  async function connect() {
    if (busy || polling) return;
    setBusy('connect'); setMsg(''); setOk(false);
    try {
      const res = await fetch(`/api/companies/${ws}/keys/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runner: id }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) {
        setOk(false);
        setMsg(d.reason === 'not-installed'
          ? t('settings.runners.connectNotInstalled', { runner: id })
          : t('settings.runners.connectFailed'));
        return;
      }
      setOk(true); setMsg(t('settings.runners.connectOpened'));
      startPoll();
    } catch {
      setOk(false); setMsg(t('settings.runners.connectFailed'));
    } finally {
      setBusy('');
    }
  }

  async function save(verify) {
    if (busy || !value.trim()) return;
    setBusy(verify ? 'verify' : 'save'); setMsg(''); setOk(false);
    try {
      const res = await fetch(`/api/companies/${ws}/keys`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runner: id, type: method, value: value.trim(), verify }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setValue(''); setOk(true); setMsg(verify ? t('settings.runners.verified') : t('settings.runners.saved'));
      window.dispatchEvent(new Event('argo:refresh'));
      onChange();
    } catch (e) {
      setMsg(String(e.message));
    } finally {
      setBusy('');
    }
  }

  async function remove() {
    if (busy) return;
    setBusy('remove'); setMsg(''); setOk(false);
    try {
      await fetch(`/api/companies/${ws}/keys?runner=${encodeURIComponent(id)}`, { method: 'DELETE' });
      window.dispatchEvent(new Event('argo:refresh'));
      onChange();
    } finally {
      setBusy('');
    }
  }

  const chip = company.connected ? (
    <span className="chip" style={{ color: 'var(--ok)', borderColor: 'currentColor' }}>
      <span className="dot" />{t('settings.runners.companyConnected')} · {t(`settings.runners.method.${company.type}`)} · <span className="mono" style={{ fontSize: 10.5 }}>{company.masked}</span>
    </span>
  ) : st?.hostAuthed ? (
    <span className="chip" style={{ color: 'var(--ok)', borderColor: 'currentColor' }}>
      <span className="dot" />{t('settings.runners.hostConnected')}
    </span>
  ) : (
    <span className="chip">{t('settings.runners.none')}</span>
  );

  const oauthCli = method === 'oauth' && !oauthPaste; // 붙여넣기 불가한 OAuth (codex/gemini)
  const removeBtn = company.connected && (
    <div>
      <button className="btn sm" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={!!busy} onClick={remove}>
        {busy === 'remove' ? <Spinner size={12} /> : t('settings.runners.remove')}
      </button>
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 8, padding: '12px 0', ...(first ? {} : { borderTop: '1px dashed var(--border-soft)' }) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 650 }}>{RUNNER_NAMES[id]}</span>
        {chip}
      </div>
      {hasOauth && (
        <div style={{ display: 'flex', gap: 6 }}>
          {methods.map((m) => (
            <button key={m} className="chip" onClick={() => { setMethod(m); setMsg(''); }} aria-pressed={method === m}
              style={{ cursor: 'pointer', padding: '4px 12px', fontSize: 12, ...(method === m ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' } : {}) }}>
              {t(`settings.runners.method.${m}`)}
            </button>
          ))}
        </div>
      )}
      {oauthCli ? (
        connectable ? (
          /* codex — 벤더 CLI 브라우저 로그인 대행 (Connect 버튼 + 폴링) */
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary sm" disabled={!!busy || polling} onClick={connect}>
                {busy === 'connect' || polling ? <Spinner size={12} /> : t('settings.runners.connect')}
              </button>
              {st?.hostAuthed && (
                <span className="chip"><span className="dot" />{t('settings.runners.hostInUse')}</span>
              )}
              {msg && <span style={{ fontSize: 12, color: ok ? 'var(--fg-2)' : 'var(--danger)' }}>{msg}</span>}
            </div>
            {removeBtn}
          </div>
        ) : (
          /* gemini 등 — 설치·로그인은 이 컴퓨터에서 (입력창 없음) */
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.6 }}>
              {st?.hostInstalled
                ? t('settings.runners.hostLoginUsed', { runner: id })
                : t('settings.runners.hostInstall', { runner: id })}
              {st?.hostInstalled && (
                <span style={{ marginLeft: 8, color: st?.hostAuthed ? 'var(--ok)' : 'var(--warn)' }}>
                  {st?.hostAuthed ? t('settings.runners.hostAuthed') : t('settings.runners.hostNotAuthed')}
                </span>
              )}
            </div>
            {removeBtn}
          </div>
        )
      ) : (
        <>
          <input suppressHydrationWarning type="password" value={value} onChange={(e) => setValue(e.target.value)}
            placeholder={method === 'oauth' ? t('settings.runners.tokenPlaceholder') : t('settings.runners.keyPlaceholder')} style={fieldStyle} />
          <p style={{ fontSize: 11.5, color: 'var(--fg-3)', margin: 0, lineHeight: 1.6 }}>
            {method === 'oauth' ? (
              t('settings.runners.oauthGuide')
            ) : (
              <>
                {t('settings.runners.keyGuide')}{' '}
                {st?.keyUrl && (
                  <a href={st.keyUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--fg)', textDecoration: 'underline' }}>{t('settings.runners.keyLink')}</a>
                )}
              </>
            )}
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary sm" disabled={!!busy || !value.trim()} onClick={() => save(true)}>
              {busy === 'verify' ? <Spinner size={12} /> : t('settings.runners.saveVerify')}
            </button>
            <button className="btn sm" disabled={!!busy || !value.trim()} onClick={() => save(false)}>
              {busy === 'save' ? <Spinner size={12} /> : t('settings.runners.saveOnly')}
            </button>
            {company.connected && (
              <button className="btn sm" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={!!busy} onClick={remove}>
                {busy === 'remove' ? <Spinner size={12} /> : t('settings.runners.remove')}
              </button>
            )}
            {msg && <span style={{ fontSize: 12, color: ok ? 'var(--fg-2)' : 'var(--danger)' }}>{msg}</span>}
          </div>
        </>
      )}
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

const fieldStyle = { height: 34, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12.5, width: '100%' };

/** 메신저 연결 카드 — 토큰은 서버에만 저장(화면은 마스킹), 가동 토글로 게이트웨이 시작/중지. */
function ConnectionCard({ ws, kind, title, help, agents }) {
  const { t } = useLang();
  const [conn, setConn] = useState(null);
  const [gw, setGw] = useState(null);
  const [token, setToken] = useState('');
  const [channel, setChannel] = useState('');
  const [crew, setCrew] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  function load() {
    api(`/api/companies/${ws}/connections`).then((d) => {
      const c = d.connections[kind];
      setConn(c); setGw(d.gateway?.[kind] ?? null);
      setChannel(c.channel ?? ''); setCrew(c.defaultCrew ?? '');
    }).catch(() => setConn({}));
  }
  useEffect(load, [ws]);

  // 가동 중엔 폴러 하트비트를 8초마다 — "연동 안 됨"이 화면에서 바로 보인다
  useEffect(() => {
    if (!conn?.enabled) return;
    const t = setInterval(() => {
      api(`/api/companies/${ws}/connections`).then((d) => setGw(d.gateway?.[kind] ?? null)).catch(() => {});
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
        <span className="chip">{on ? <><span className="dot" />{t('settings.conn.on')}</> : t('settings.conn.off')}{kind === 'telegram' && conn?.chatId ? t('settings.conn.pairedSuffix') : ''}</span>
      </div>
      {on && gw && (
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
      {kind === 'slack' && (
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="microlabel">{t('settings.conn.channel')}</span>
          <input suppressHydrationWarning value={channel} onChange={(e) => setChannel(e.target.value)} placeholder={t('settings.conn.channelPlaceholder')} style={fieldStyle} />
        </label>
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
          {sync.lastError && <span style={{ color: 'var(--danger)', fontSize: 12 }}>{sync.lastError}</span>}
        </div>
      ) : (
        <p style={{ fontSize: 12.5, color: 'var(--fg-3)', margin: 0, lineHeight: 1.55 }}>{t('settings.sync.offHelp')}</p>
      )}
    </div>
  );
}
