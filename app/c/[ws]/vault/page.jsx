'use client';
// 기억 — 그래프(카드) + 문서 목록(행) + 뷰어(카드). 탑바 검색으로 목록 필터.
import { Suspense, use, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon, Markdown, Spinner, Skeleton, api, timeAgo, tsFromRel } from '../../../ui';

export default function VaultPage({ params }) {
  return (
    <Suspense>
      <Vault params={params} />
    </Suspense>
  );
}

function Vault({ params }) {
  const { ws } = use(params);
  const initialDoc = useSearchParams().get('doc');
  const [docs, setDocs] = useState(null);
  const [selected, setSelected] = useState(initialDoc || null);
  const [content, setContent] = useState('');
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    api(`/api/companies/${ws}/vault`).then((d) => setDocs(d.docs)).catch(() => setDocs([]));
  }, [ws]);

  useEffect(() => {
    const h = (e) => setQ(String(e.detail || '').toLowerCase());
    window.addEventListener('argo:search', h);
    return () => window.removeEventListener('argo:search', h);
  }, []);

  useEffect(() => {
    if (!selected) { setContent(''); return; }
    setLoadingDoc(true);
    api(`/api/companies/${ws}/vault?rel=${encodeURIComponent(selected)}`)
      .then((d) => setContent(d.content))
      .catch((e) => setContent(`(문서를 열 수 없습니다: ${e.message})`))
      .finally(() => setLoadingDoc(false));
  }, [ws, selected]);

  const openWiki = (name) => setSelected(name.endsWith('.md') ? name : `${name}.md`);
  const visible = (docs ?? []).filter((d) => !q || d.title.toLowerCase().includes(q) || d.excerpt.toLowerCase().includes(q));

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {docs === null ? (
        <>
          <Skeleton h={210} style={{ borderRadius: 20 }} />
          <Skeleton h={320} style={{ borderRadius: 20 }} />
        </>
      ) : docs.length === 0 ? (
        <div className="empty">아직 기록된 기억이 없습니다. 크루와 첫 대화를 나누면 여기에 쌓입니다.</div>
      ) : (
        <>
          <Constellation docs={docs} selected={selected} onSelect={setSelected} />

          <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 14, alignItems: 'start' }}>
            <div className="card" style={{ overflow: 'hidden', maxHeight: 560, overflowY: 'auto' }}>
              <div className="card-head" style={{ paddingBottom: 10 }}>
                <span className="card-title">기록</span>
                <span className="chip">{visible.length}</span>
              </div>
              {visible.length === 0 && (
                <p style={{ padding: '0 20px 18px', color: 'var(--ink-3)', fontSize: 13 }}>검색과 일치하는 기억이 없습니다.</p>
              )}
              {visible.map((d) => {
                const active = selected === d.rel;
                return (
                  <button key={d.rel} onClick={() => setSelected(d.rel)} className={`row${active ? ' active' : ''}`}>
                    <span className={`icon-circle ${d.dir === 'notes' ? 'mint' : 'lav'}`}>
                      <Icon name={d.dir === 'notes' ? 'bolt' : 'doc'} size={15} />
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: active ? 700 : 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                        {d.title}
                      </span>
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--ink-3)', marginTop: 1 }}>
                        {timeAgo(tsFromRel(d.rel) ?? d.mtime)}{d.links.length > 0 && ` · 연결 ${d.links.length}`}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="card" style={{ padding: 24, minHeight: 340 }}>
              {!selected ? (
                <div style={{ color: 'var(--ink-3)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="doc" size={14} /> 왼쪽 목록이나 그래프의 점을 눌러 기억을 열어보세요.
                </div>
              ) : loadingDoc ? (
                <Spinner />
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                    <span className="chip" style={{ fontFamily: 'var(--mono)', fontWeight: 500 }}>{selected}</span>
                  </div>
                  <Markdown text={content} onWikiLink={openWiki} />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 기억 그래프 — 골든앵글 배치. 라벤더 점(대화)·민트 점(노트), 옅은 라벤더 선. */
function Constellation({ docs, selected, onSelect }) {
  const W = 1020, H = 210;
  const layout = useMemo(() => {
    const nodes = docs.map((d, i) => {
      const r = 24 + 27 * Math.sqrt(i);
      const th = i * 2.39996;
      return {
        ...d,
        key: d.rel.replace(/\.md$/, ''),
        x: W / 2 + r * Math.cos(th) * 1.9,
        y: H / 2 + r * Math.sin(th) * 0.58,
      };
    });
    const byKey = new Map(nodes.map((n) => [n.key, n]));
    const edges = [];
    const seen = new Set();
    for (const n of nodes) {
      for (const l of n.links) {
        const m = byKey.get(l);
        if (!m) continue;
        const id = [n.key, m.key].sort().join('→');
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push([n, m]);
      }
    }
    return { nodes, edges };
  }, [docs]);

  return (
    <div className="card" style={{ padding: '14px 18px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
        <span className="card-title">기억 그래프</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="chip lav"><span className="dot" />대화 기록</span>
          <span className="chip mint"><span className="dot" />지식 노트</span>
          <span className="chip">연결 {layout.edges.length}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
        {layout.edges.map(([a, b], i) => (
          <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--lav-soft)" strokeWidth="2" />
        ))}
        {layout.nodes.map((n) => {
          const active = selected === n.rel;
          const color = n.dir === 'notes' ? 'var(--mint)' : 'var(--lav)';
          return (
            <g key={n.rel} onClick={() => onSelect(n.rel)} style={{ cursor: 'pointer' }}>
              <circle cx={n.x} cy={n.y} r="13" fill="transparent" />
              {active && <circle cx={n.x} cy={n.y} r="10" fill="none" stroke={color} strokeOpacity="0.35" strokeWidth="3" />}
              <circle cx={n.x} cy={n.y} r={active ? 5 : 4} fill={color} />
              <title>{n.title}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
