'use client';
// 홈 — 회사 목록과 생성.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Logo, Icon, Avatar, Spinner, Skeleton, api, timeAgo } from './ui';

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
      <header className="topbar" style={{ justifyContent: 'space-between' }}>
        <Logo />
        <span className="chip lav"><span className="dot" />폴더 단위 기억으로 항해하는 AI 크루</span>
      </header>

      <main style={{ maxWidth: 680, margin: '0 auto', padding: '64px 24px 90px' }}>
        <div className="fade-up" style={{ marginBottom: 30 }}>
          <h1 style={{ fontSize: 27, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.3 }}>
            AI 크루와 함께 일할<br />회사를 만드세요
          </h1>
          <p style={{ fontSize: 14.5, color: 'var(--ink-2)', marginTop: 10, maxWidth: 440 }}>
            프롬프트 한 줄이면 전문 크루가 합류합니다. 회사는 폴더 단위 기억으로
            맥락을 쌓고, 비슷한 기억끼리 스스로 이어집니다.
          </p>
        </div>

        <form onSubmit={create} className="input-pill fade-up" style={{ animationDelay: '0.06s' }}>
          <input
            placeholder="새 회사 이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
            autoFocus
          />
          <button className="btn btn-dark" disabled={creating || !name.trim()}>
            {creating ? <Spinner /> : <Icon name="plus" size={14} />}
            회사 만들기
          </button>
        </form>
        {error && <p style={{ color: 'var(--coral)', marginTop: 10, fontSize: 13 }}>{error}</p>}

        <section style={{ marginTop: 40 }}>
          <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--ink-3)', marginBottom: 10 }}>내 회사</div>
          {companies === null ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <Skeleton h={72} style={{ borderRadius: 20 }} />
              <Skeleton h={72} style={{ borderRadius: 20 }} />
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
                  style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14, animationDelay: `${0.04 * i}s` }}
                >
                  <Avatar name={c.name} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: '-0.015em' }}>{c.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 1 }}>{timeAgo(c.created)} 생성</div>
                  </div>
                  <span className="chip lav">크루 {c.crew}</span>
                  <span className="chip mint">기억 {c.memories}</span>
                  <span style={{ color: 'var(--ink-3)', display: 'inline-flex' }}><Icon name="arrow" size={15} /></span>
                </a>
              ))}
            </div>
          )}
        </section>

        <footer style={{ marginTop: 70, fontSize: 12, color: 'var(--ink-3)' }}>
          Argo — 전문성이 다른 크루가 한 배를 타고, 같은 목표를 향해 갑니다.
        </footer>
      </main>
    </div>
  );
}
