'use client';
// 홈 — 회사 목록과 생성. 계기판 톤의 조용한 온보딩.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Logo, Icon, Avatar, Spinner, Skeleton, api, imeGuard, timeAgo } from './ui';

export default function Home() {
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
        <span className="microlabel">Crew · Folder Memory · Auto Link</span>
      </header>

      <main style={{ maxWidth: 660, margin: '0 auto', padding: '64px 24px 90px' }}>
        <div className="fade-up" style={{ marginBottom: 30 }}>
          <div className="microlabel" style={{ marginBottom: 12 }}>Boarding</div>
          <h1 style={{ fontSize: 26, fontWeight: 750, letterSpacing: '-0.02em', lineHeight: 1.32 }}>
            AI 크루와 함께 일할<br />회사를 만드세요
          </h1>
          <p style={{ fontSize: 14, color: 'var(--fg-2)', marginTop: 10, maxWidth: 440 }}>
            프롬프트 한 줄이면 전문 크루가 합류합니다. 회사는 폴더 단위 기억으로
            맥락을 쌓고, 비슷한 기억끼리 스스로 이어집니다.
          </p>
        </div>

        <form onSubmit={create} className="input-bar fade-up" style={{ animationDelay: '0.06s' }}>
          <input suppressHydrationWarning
            placeholder="새 회사 이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
            autoFocus
            {...imeGuard}
          />
          <button className="btn btn-primary" disabled={creating || !name.trim()}>
            {creating ? <Spinner /> : <Icon name="plus" size={14} />}
            회사 만들기
          </button>
        </form>
        {error && <p style={{ color: 'var(--danger)', marginTop: 10, fontSize: 13 }}>{error}</p>}

        {/* 시작 프리셋 — 고르면 크루 2명 + 아침 브리핑 루틴이 즉시 꾸려진다 (빈 배로도 출항 가능) */}
        <div className="fade-up" style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', animationDelay: '0.1s' }}>
          <span className="microlabel" style={{ marginRight: 2 }}>시작 크루</span>
          <button type="button" className="chip" onClick={() => setPreset('')}
            style={{ cursor: 'pointer', ...(preset === '' ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' } : {}) }}>
            빈 배
          </button>
          {presets.map((p) => (
            <button key={p.key} type="button" className="chip" onClick={() => setPreset(p.key)} title={p.desc}
              style={{ cursor: 'pointer', ...(preset === p.key ? { background: 'var(--fg)', color: 'var(--bg)', borderColor: 'var(--fg)' } : {}) }}>
              {p.label}
            </button>
          ))}
          {preset && (
            <span style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
              {presets.find((p) => p.key === preset)?.desc} · 아침 브리핑 포함
            </span>
          )}
        </div>

        <section style={{ marginTop: 42 }}>
          <div className="microlabel" style={{ marginBottom: 10 }}>My Companies</div>
          {companies === null ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <Skeleton h={70} style={{ borderRadius: 16 }} />
              <Skeleton h={70} style={{ borderRadius: 16 }} />
            </div>
          ) : companies.length === 0 ? (
            <div className="empty">아직 회사가 없습니다. 위에서 첫 회사를 만들어보세요.</div>
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
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', marginTop: 1 }}>{timeAgo(c.created)} 생성</div>
                  </div>
                  <span className="chip">Crew {c.crew}</span>
                  <span className="chip">Memory {c.memories}</span>
                  <span style={{ color: 'var(--fg-3)', display: 'inline-flex' }}><Icon name="arrow" size={15} /></span>
                </a>
              ))}
            </div>
          )}
        </section>

        <footer className="microlabel" style={{ marginTop: 70 }}>
          Argo — 전문성이 다른 크루가 한 배를 타고, 같은 목표를 향해 갑니다.
        </footer>
      </main>
    </div>
  );
}
