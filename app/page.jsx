'use client';
// 항구(Harbor) — 회사 목록과 진수. Argo의 첫 화면.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wordmark, Oars, api, timeAgo } from './ui';

export default function Harbor() {
  const router = useRouter();
  const [companies, setCompanies] = useState(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/companies').then((d) => setCompanies(d.companies)).catch((e) => setError(String(e.message)));
  }, []);

  async function launch(e) {
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
    <div className="page" style={{ maxWidth: 880 }}>
      <header style={{ textAlign: 'center', padding: '96px 0 60px' }}>
        <div className="fade-up">
          <Wordmark size={44} />
        </div>
        <p className="fade-up" style={{ marginTop: 18, fontSize: 17, color: 'var(--ink-2)', animationDelay: '0.08s' }}>
          프롬프트 한 줄로 전문 AI 크루를 영입하세요.
          <br />
          회사는 폴더 단위 기억으로 맥락을 쌓으며 함께 항해합니다.
        </p>
      </header>

      <form onSubmit={launch} className="card fade-up" style={{ display: 'flex', gap: 10, padding: 14, alignItems: 'center', animationDelay: '0.16s' }}>
        <input
          className="input"
          style={{ border: 'none', background: 'transparent', boxShadow: 'none', fontSize: 15 }}
          placeholder="새 회사 이름 — 예: 밤바다 스튜디오"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={creating}
        />
        <button className="btn btn-gold" disabled={creating || !name.trim()}>
          {creating ? <Oars /> : '배 띄우기'}
        </button>
      </form>
      {error && <p style={{ color: 'var(--danger)', marginTop: 10, fontSize: 13 }}>{error}</p>}

      <section style={{ marginTop: 46 }}>
        <div className="eyebrow" style={{ marginBottom: 14 }}>정박 중인 회사</div>
        {companies === null ? (
          <div className="empty"><Oars /></div>
        ) : companies.length === 0 ? (
          <div className="empty">
            아직 진수한 회사가 없습니다. 위에서 첫 배를 띄워보세요.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 14 }}>
            {companies.map((c, i) => (
              <a key={c.id} href={`/c/${c.id}`} className="card lift fade-up" style={{ padding: '18px 20px', animationDelay: `${0.05 * i}s` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <strong className="display" style={{ fontSize: 20 }}>{c.name}</strong>
                  <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{timeAgo(c.created)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                  <span className="chip gold">크루 {c.crew}</span>
                  <span className="chip">기억 {c.memories}</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </section>

      <footer style={{ marginTop: 90, textAlign: 'center', color: 'var(--ink-3)', fontSize: 12 }}>
        Argo — 전문성이 다른 크루가 한 배를 타고, 같은 목표를 향해 노를 젓습니다.
      </footer>
    </div>
  );
}
