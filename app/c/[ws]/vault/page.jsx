'use client';
// 기억 — 문서가 별, [[링크]]가 선인 그래프 + 문서 목록/뷰어. 톤은 절제.
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

  useEffect(() => {
    api(`/api/companies/${ws}/vault`).then((d) => setDocs(d.docs)).catch(() => setDocs([]));
  }, [ws]);

  useEffect(() => {
    if (!selected) { setContent(''); return; }
    setLoadingDoc(true);
    api(`/api/companies/${ws}/vault?rel=${encodeURIComponent(selected)}`)
      .then((d) => setContent(d.content))
      .catch((e) => setContent(`(문서를 열 수 없습니다: ${e.message})`))
      .finally(() => setLoadingDoc(false));
  }, [ws, selected]);

  const openWiki = (name) => setSelected(name.endsWith('.md') ? name : `${name}.md`);

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 className="page-title">기억</h1>
        <p className="page-sub">모든 턴이 기록으로 남고, 비슷한 기억끼리 자동으로 이어집니다. 크루는 이 그래프를 읽고 맥락을 이어갑니다.</p>
      </div>

      {docs === null ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <Skeleton h={200} /><Skeleton h={300} />
        </div>
      ) : docs.length === 0 ? (
        <div className="empty">아직 기록된 기억이 없습니다. 크루와 첫 대화를 나누면 여기에 쌓입니다.</div>
      ) : (
        <>
          <Constellation docs={docs} selected={selected} onSelect={setSelected} />

          <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 14, marginTop: 14, alignItems: 'start' }}>
            <div className="card" style={{ overflow: 'hidden', maxHeight: 540, overflowY: 'auto' }}>
              {docs.map((d) => {
                const active = selected === d.rel;
                return (
                  <button key={d.rel} onClick={() => setSelected(d.rel)} className={`row${active ? ' active' : ''}`}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: active ? 650 : 500, color: active ? 'var(--fg)' : 'var(--fg-2)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                        {d.title}
                      </span>
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--fg-3)', marginTop: 1 }}>
                        {d.dir === 'notes' ? '지식 노트' : '대화 기록'} · {timeAgo(tsFromRel(d.rel) ?? d.mtime)}
                        {d.links.length > 0 && <span style={{ color: 'var(--accent)' }}> · 연결 {d.links.length}</span>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="card" style={{ padding: 22, minHeight: 320 }}>
              {!selected ? (
                <div style={{ color: 'var(--fg-3)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="doc" size={14} /> 왼쪽 목록이나 별을 눌러 기억을 열어보세요.
                </div>
              ) : loadingDoc ? (
                <Spinner />
              ) : (
                <>
                  <div style={{ fontSize: 11, color: 'var(--fg-3)', marginBottom: 14, fontFamily: 'var(--mono)' }}>{selected}</div>
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

/** 기억 그래프 — 골든앵글 배치. 배경은 표면색, 별·선만 골드. */
function Constellation({ docs, selected, onSelect }) {
  const W = 860, H = 200;
  const layout = useMemo(() => {
    const nodes = docs.map((d, i) => {
      const r = 22 + 26 * Math.sqrt(i);
      const th = i * 2.39996;
      return {
        ...d,
        key: d.rel.replace(/\.md$/, ''),
        x: W / 2 + r * Math.cos(th) * 1.8,
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
    <div className="card" style={{ padding: 6 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
        {layout.edges.map(([a, b], i) => (
          <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--accent-line)" strokeWidth="1" />
        ))}
        {layout.nodes.map((n) => {
          const active = selected === n.rel;
          return (
            <g key={n.rel} onClick={() => onSelect(n.rel)} style={{ cursor: 'pointer' }}>
              <circle cx={n.x} cy={n.y} r="12" fill="transparent" />
              {active && <circle cx={n.x} cy={n.y} r="9" fill="var(--accent-soft)" stroke="var(--accent-line)" />}
              <circle cx={n.x} cy={n.y} r={active ? 4 : 3} fill={n.dir === 'notes' ? 'var(--fg-3)' : 'var(--accent)'} style={{ transition: 'r 0.15s' }} />
              <title>{n.title}</title>
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 14, padding: '2px 10px 6px', fontSize: 11, color: 'var(--fg-3)' }}>
        <span><span style={{ color: 'var(--accent)' }}>●</span> 대화 기록</span>
        <span><span style={{ color: 'var(--fg-3)' }}>●</span> 지식 노트</span>
        <span style={{ marginLeft: 'auto' }}>기억 {docs.length} · 연결 {layout.edges.length}</span>
      </div>
    </div>
  );
}
