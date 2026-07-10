'use client';
// 홈 — 회사 목록과 생성. 계기판 톤의 조용한 온보딩.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Logo, Icon, Avatar, Spinner, Skeleton, api, imeGuard, timeAgo } from './ui';
import { useLang } from './i18n';

export default function Home() {
  const { t, lang } = useLang();
  const router = useRouter();
  const [companies, setCompanies] = useState(null);
  const [name, setName] = useState('');
  const [presets, setPresets] = useState([]);
  const [preset, setPreset] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/companies').then((d) => { setCompanies(d.companies); setPresets(d.presets ?? []); }).catch((e) => setError(String(e.message)));
  }, []);

  async function create(e) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true); setError('');
    try {
      const { company } = await api('/api/companies', { name, preset });
      router.push(`/c/${company.id}`);
    } catch (err) {
      setError(String(err.message)); setCreating(false);
    }
  }

  return (
    <div>
      <header className="topbar" style={{ justifyContent: 'space-between' }}>
        <Logo />
        <span className="microlabel">{t('home.tagline')}</span>
      </header>

      <main style={{ maxWidth: 660, margin: '0 auto', padding: '64px 24px 90px' }}>
        <div className="fade-up" style={{ marginBottom: 30 }}>
          <div className="microlabel" style={{ marginBottom: 12 }}>{t('home.boarding')}</div>
          <h1 style={{ fontSize: 26, fontWeight: 750, letterSpacing: '-0.02em', lineHeight: 1.32 }}>
            {t('home.headline1')}<br />{t('home.headline2')}
          </h1>
          <p style={{ fontSize: 14, color: 'var(--fg-2)', marginTop: 10, maxWidth: 440 }}>
            {t('home.desc')}
          </p>
        </div>

        <form onSubmit={create} className="input-bar fade-up" style={{ animationDelay: '0.06s' }}>
          <input suppressHydrationWarning
            placeholder={t('home.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
            autoFocus
            {...imeGuard}
          />
          <button className="btn btn-primary" disabled={creating || !name.trim()}>
            {creating ? <Spinner /> : <Icon name="plus" size={14} />}
            {t('home.createBtn')}
          </button>
        </form>
        {error && <p style={{ color: 'var(--danger)', marginTop: 10, fontSize: 13 }}>{error}</p>}

        {/* 시작 프리셋 — 고르면 크루 2명 + 아침 브리핑 루틴이 즉시 꾸려진다 (빈 배로도 출항 가능) */}
        <div className="fade-up" style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', animationDelay: '0.1s' }}>
          <span className="microlabel" style={{ marginRight: 2 }}>{t('home.startCrewLabel')}</span>
          <button type="button" className="chip" onClick={() => setPreset('')}
            style={{ cursor: 'pointer', ...(preset === '' ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' } : {}) }}>
            {t('home.emptyShip')}
          </button>
          {presets.map((p) => (
            <button key={p.key} type="button" className="chip" onClick={() => setPreset(p.key)} title={p.desc}
              style={{ cursor: 'pointer', ...(preset === p.key ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' } : {}) }}>
              {p.label}
            </button>
          ))}
          {preset && (
            <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
              {presets.find((p) => p.key === preset)?.desc}{t('home.morningBriefingIncluded')}
            </span>
          )}
        </div>

        <section style={{ marginTop: 42 }}>
          <div className="microlabel" style={{ marginBottom: 10 }}>{t('home.myCompanies')}</div>
          {companies === null ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <Skeleton h={70} style={{ borderRadius: 16 }} />
              <Skeleton h={70} style={{ borderRadius: 16 }} />
            </div>
          ) : companies.length === 0 ? (
            <div className="empty">{t('home.noCompanies')}</div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {companies.map((c, i) => (
                <a
                  key={c.id}
                  href={`/c/${c.id}`}
                  className="card card-i fade-up"
                  style={{ padding: '15px 18px', display: 'flex', alignItems: 'center', gap: 13, animationDelay: `${0.04 * i}s` }}
                >
                  <Avatar name={c.name} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{c.name}</div>
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', marginTop: 1 }}>{timeAgo(c.created, lang)}{t('home.createdSuffix')}</div>
                  </div>
                  <span className="chip">{t('nav.crewCount', { n: c.crew })}</span>
                  <span className="chip">{t('home.memoryCount', { n: c.memories })}</span>
                  <span style={{ color: 'var(--fg-3)', display: 'inline-flex' }}><Icon name="arrow" size={15} /></span>
                </a>
              ))}
            </div>
          )}
        </section>

        <footer className="microlabel" style={{ marginTop: 70 }}>
          {t('home.footer')}
        </footer>
      </main>
    </div>
  );
}
