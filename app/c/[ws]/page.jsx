'use client';
// 데크 — 대시보드: 스탯 타일 + 크루 영입/카드 + 기억 구성 도넛 + 최근 기억 피드.
import { use, useEffect, useState } from 'react';
import { Avatar, Icon, Donut, Spinner, Skeleton, api, timeAgo, tsFromRel } from '../../ui';

const HIRE_STAGES = ['지원서를 읽는 중', '페르소나 카드를 쓰는 중', '합류 준비 중'];

export default function Deck({ params }) {
  const { ws } = use(params);
  const [data, setData] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [hiring, setHiring] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  function load() {
    api(`/api/companies/${ws}`).then(setData).catch((e) => setError(String(e.message)));
  }
  useEffect(load, [ws]);

  useEffect(() => {
    const h = (e) => setQ(String(e.detail || '').toLowerCase());
    window.addEventListener('argo:search', h);
    return () => window.removeEventListener('argo:search', h);
  }, []);

  useEffect(() => {
    if (!hiring) return;
    const t = setInterval(() => setStage((s) => Math.min(s + 1, HIRE_STAGES.length - 1)), 9000);
    return () => clearInterval(t);
  }, [hiring]);

  async function hire(e) {
    e.preventDefault();
    if (!prompt.trim() || hiring) return;
    setHiring(true); setStage(0); setError('');
    try {
      await api(`/api/companies/${ws}/agents`, { prompt });
      setPrompt('');
      load();
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (err) {
      setError(String(err.message));
    } finally {
      setHiring(false);
    }
  }

  const stats = data?.stats;
  const agents = (data?.agents ?? []).filter(
    (a) => !q || `${a.name} ${a.role} ${a.expertise.join(' ')}`.toLowerCase().includes(q)
  );
  const memories = (data?.memories ?? []).filter((m) => !q || m.title.toLowerCase().includes(q));

  const TILES = stats && [
    { label: '크루', value: data.agents.length, chip: ['lav', '항해 중'], icon: 'user' },
    { label: '기억', value: data.memoryCount, chip: ['mint', `오늘 +${stats.today}`], icon: 'doc' },
    { label: '기억 연결', value: stats.links, chip: ['sun', '자동 링크'], icon: 'link' },
    { label: '지식 노트', value: stats.notes, chip: ['peach', '크루 작성'], icon: 'bolt' },
  ];

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {/* 스탯 타일 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14 }}>
        {TILES
          ? TILES.map((t, i) => (
              <div key={t.label} className="card tile fade-up" style={{ animationDelay: `${0.04 * i}s` }}>
                <div className="tile-top">
                  <span className="tile-label">{t.label}</span>
                  <span className={`chip ${t.chip[0]}`}><span className="dot" />{t.chip[1]}</span>
                </div>
                <div className="num">{t.value}</div>
              </div>
            ))
          : [0, 1, 2, 3].map((i) => <Skeleton key={i} h={96} style={{ borderRadius: 20 }} />)}
      </div>

      {/* 크루 영입 */}
      <form onSubmit={hire} className="input-pill">
        <span style={{ color: 'var(--ink-3)', display: 'inline-flex' }}><Icon name="bolt" size={16} /></span>
        <input
          placeholder="어떤 전문가가 필요하세요? — 예: 뉴스레터를 쓰는 시니어 에디터"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={hiring}
        />
        {!hiring && <span className="kbd">↵</span>}
        <button className="btn btn-dark" disabled={hiring || !prompt.trim()}>
          {hiring ? <Spinner /> : <Icon name="plus" size={14} />}
          크루 영입
        </button>
      </form>
      {hiring && <p style={{ fontSize: 12.5, color: 'var(--lav-strong)', fontWeight: 600, padding: '0 8px' }}>{HIRE_STAGES[stage]}… 완료되면 바로 합류합니다.</p>}
      {error && <p style={{ fontSize: 13, color: 'var(--coral)', padding: '0 8px' }}>{error}</p>}

      {/* 본문: 크루 + 우측 레일 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 14, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div className="card">
            <div className="card-head">
              <span className="card-title">크루</span>
              <span className="chip">{data ? `${agents.length}명` : '—'}</span>
            </div>
            {data === null ? (
              <div style={{ padding: '0 20px 20px' }}><Skeleton h={120} /></div>
            ) : agents.length === 0 ? (
              <p style={{ padding: '4px 20px 22px', color: 'var(--ink-3)', fontSize: 13 }}>
                {q ? '검색과 일치하는 크루가 없습니다.' : '아직 크루가 없습니다. 위 입력창에 한 줄만 적어보세요.'}
              </p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12, padding: '4px 20px 20px' }}>
                {agents.map((a, i) => (
                  <a
                    key={a.slug}
                    href={`/c/${ws}/crew/${a.slug}`}
                    className="card card-i fade-up"
                    style={{ padding: 16, boxShadow: 'none', background: 'var(--surface-2)', animationDelay: `${0.04 * i}s`, display: 'flex', flexDirection: 'column', gap: 10 }}
                  >
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <Avatar name={a.name} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700 }}>{a.name}</div>
                        <span className="chip lav" style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block' }}>{a.role}</span>
                      </div>
                    </div>
                    {a.expertise.length > 0 && (
                      <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12.5, color: 'var(--ink-2)' }}>
                        {a.expertise.slice(0, 3).map((x) => (
                          <li key={x} style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>· {x}</li>
                        ))}
                      </ul>
                    )}
                    <span className="btn sm" style={{ marginTop: 'auto', alignSelf: 'flex-start', background: 'var(--surface)' }}>
                      대화하기 <Icon name="arrow" size={13} />
                    </span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 14 }}>
          {/* 기억 구성 도넛 */}
          <div className="card" style={{ padding: '18px 20px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span className="card-title">기억 구성</span>
              <a href={`/c/${ws}/vault`} className="chip lav">전체 보기</a>
            </div>
            {stats ? (
              <div style={{ display: 'grid', placeItems: 'center', gap: 12 }}>
                <Donut
                  size={150}
                  segments={[
                    { value: stats.conversations, color: 'var(--lav)' },
                    { value: stats.notes, color: 'var(--mint)' },
                  ]}
                  centerTop={data.memoryCount}
                  centerSub="기억"
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                  <span className="chip lav"><span className="dot" />대화 기록 {stats.conversations}</span>
                  <span className="chip mint"><span className="dot" />지식 노트 {stats.notes}</span>
                </div>
              </div>
            ) : (
              <Skeleton h={170} />
            )}
          </div>

          {/* 최근 기억 */}
          <div className="card" style={{ overflow: 'hidden' }}>
            <div className="card-head" style={{ paddingBottom: 8 }}>
              <span className="card-title">최근 기억</span>
            </div>
            {data === null ? (
              <div style={{ padding: '0 20px 20px' }}><Skeleton h={100} /></div>
            ) : memories.length === 0 ? (
              <p style={{ padding: '0 20px 20px', color: 'var(--ink-3)', fontSize: 13 }}>
                {q ? '검색과 일치하는 기억이 없습니다.' : '크루와 첫 대화를 나누면 여기에 쌓입니다.'}
              </p>
            ) : (
              memories.map((m) => (
                <a key={m.rel} href={`/c/${ws}/vault?doc=${encodeURIComponent(m.rel)}`} className="row">
                  <span className={`icon-circle ${m.dir === 'notes' ? 'mint' : 'lav'}`}>
                    <Icon name={m.dir === 'notes' ? 'bolt' : 'doc'} size={15} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{m.title}</span>
                    <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                      {timeAgo(tsFromRel(m.rel) ?? m.mtime)}{m.links.length > 0 && ` · 연결 ${m.links.length}`}
                    </span>
                  </span>
                </a>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
