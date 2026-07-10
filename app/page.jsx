'use client';
// 홈 — 회사 목록과 생성. 조용한 온보딩.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Logo, Icon, Spinner, Skeleton, api, timeAgo } from './ui';

export default function Home() {
  const router = useRouter();
  const [companies, setCompanies] = useState(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/companies').then((d) => setCompanies(d.companies)).catch((e) => setError(String(e.message)));
  }, []);

  async function create(e) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true); setError('');
    try {
      const { company } = await api('/api/companies', { name });
      router.push(`/c/${company.id}`);
    } catch (err) {
      setError(String(err.message)); setCreating(false);
    }
  }

  return (
    <div>
      <header style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '14px 24px' }}>
          <Logo />
        </div>
      </header>

      <main style={{ maxWidth: 720, margin: '0 auto', padding: '72px 24px 90px' }}>
        <div className="fade-up" style={{ marginBottom: 36 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.25 }}>
            AI 크루와 함께 일할 회사를 만드세요
          </h1>
          <p className="page-sub" style={{ fontSize: 15, marginTop: 8, maxWidth: 480 }}>
            프롬프트 한 줄이면 전문 크루가 합류합니다. 회사는 폴더 단위 기억으로
            맥락을 쌓고, 비슷한 기억끼리 스스로 이어집니다.
          </p>
        </div>

        <form onSubmit={create} className="input-row fade-up" style={{ animationDelay: '0.06s' }}>
          <input
            placeholder="새 회사 이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
            autoFocus
          />
          <button className="btn btn-primary" disabled={creating || !name.trim()}>
            {creating ? <Spinner /> : <Icon name="plus" size={14} />}
            회사 만들기
          </button>
        </form>
        {error && <p style={{ color: 'var(--danger)', marginTop: 10, fontSize: 13 }}>{error}</p>}

        <section style={{ marginTop: 44 }}>
          <div className="section-label">내 회사</div>
          {companies === null ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <Skeleton h={64} /><Skeleton h={64} />
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
                  style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16, animationDelay: `${0.04 * i}s` }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 650, letterSpacing: '-0.015em' }}>{c.name}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--fg-3)', marginTop: 2 }}>
                      크루 {c.crew} · 기억 {c.memories} · {timeAgo(c.created)} 생성
                    </div>
                  </div>
                  <span style={{ color: 'var(--fg-3)', display: 'inline-flex' }}>
                    <Icon name="back" style={{ transform: 'rotate(180deg)' }} />
                  </span>
                </a>
              ))}
            </div>
          )}
        </section>

        <footer style={{ marginTop: 80, fontSize: 12, color: 'var(--fg-3)' }}>
          Argo — 전문성이 다른 크루가 한 배를 타고, 같은 목표를 향해 갑니다.
        </footer>
      </main>
    </div>
  );
}
