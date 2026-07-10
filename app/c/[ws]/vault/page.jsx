'use client';
// 기억(Vault) — 회사의 뇌. 별자리 그래프 + 문서 목록 + 뷰어.
// 문서 하나하나가 별, [[링크]]가 별자리 선 — 기억이 쌓일수록 하늘이 찬다.
import { Suspense, use, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Markdown, Oars, api, timeAgo, tsFromRel } from '../../../ui';

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
      <div className="eyebrow">기억</div>
      <h1 className="display" style={{ fontSize: 30, margin: '6px 0 8px' }}>회사의 밤하늘</h1>
      <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 24 }}>
        모든 항해가 별로 남고, 비슷한 기억끼리 별자리로 이어집니다. 크루는 이 하늘을 읽고 맥락을 이어갑니다.
      </p>

      {docs === null ? (
        <div className="empty"><Oars /></div>
      ) : docs.length === 0 ? (
        <div className="empty">아직 기록된 기억이 없습니다. 크루와 첫 대화를 나누면 별이 뜹니다.</div>
      ) : (
        <>
          <Constellation docs={docs} selected={selected} onSelect={setSelected} />

          <div style={{ display: 'grid', gridTemplateColumns: '290px 1fr', gap: 16, marginTop: 18, alignItems: 'start' }}>
            <div className="card" style={{ padding: '6px 0', maxHeight: 520, overflowY: 'auto' }}>
              {docs.map((d) => {
                const active = selected === d.rel;
                return (
                  <button
                    key={d.rel}
                    onClick={() => setSelected(d.rel)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', padding: '10px 16px',
                      borderBottom: '1px solid var(--line-soft)',
                      background: active ? 'var(--gold-dim)' : 'transparent',
                    }}
                  >
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 650, color: active ? 'var(--gold-2)' : 'var(--ink-2)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                      {d.title}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                      {d.dir === 'notes' ? '지식 노트' : '대화 기록'} · {timeAgo(tsFromRel(d.rel) ?? d.mtime)}
                      {d.links.length > 0 && <span style={{ color: 'var(--gold)' }}> · 연결 {d.links.length}</span>}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="card" style={{ padding: 22, minHeight: 300 }}>
              {!selected ? (
                <p style={{ color: 'var(--ink-3)', fontSize: 13 }}>왼쪽 목록이나 별을 눌러 기억을 열어보세요.</p>
              ) : loadingDoc ? (
                <Oars />
              ) : (
                <>
                  <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 12, fontFamily: 'ui-monospace, monospace' }}>{selected}</div>
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

/** 별자리 그래프 — 골든앵글 나선 배치, 링크는 은은한 금선. */
function Constellation({ docs, selected, onSelect }) {
  const W = 860, H = 240;
  const layout = useMemo(() => {
    const nodes = docs.map((d, i) => {
      const r = 26 + 30 * Math.sqrt(i);
      const th = i * 2.39996; // golden angle
      return {
        ...d,
        key: d.rel.replace(/\.md$/, ''),
        x: W / 2 + r * Math.cos(th) * 1.75,
        y: H / 2 + r * Math.sin(th) * 0.62,
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
    <div className="card" style={{ padding: 8 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }}>
        <defs>
          <radialGradient id="starGlow">
            <stop offset="0%" stopColor="rgba(240,210,148,0.85)" />
            <stop offset="100%" stopColor="rgba(240,210,148,0)" />
          </radialGradient>
        </defs>
        {layout.edges.map(([a, b], i) => (
          <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(217,172,92,0.28)" strokeWidth="1" />
        ))}
        {layout.nodes.map((n) => {
          const active = selected === n.rel;
          return (
            <g key={n.rel} onClick={() => onSelect(n.rel)} style={{ cursor: 'pointer' }}>
              <circle cx={n.x} cy={n.y} r={active ? 16 : 11} fill="url(#starGlow)" opacity={active ? 1 : 0.55} />
              <circle cx={n.x} cy={n.y} r={active ? 4 : 2.6} fill={active ? '#F0D294' : n.dir === 'notes' ? '#7FB4A8' : '#D9AC5C'} />
              <title>{n.title}</title>
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 14, padding: '4px 10px 6px', fontSize: 11, color: 'var(--ink-3)' }}>
        <span><span style={{ color: 'var(--gold)' }}>●</span> 대화 기록</span>
        <span><span style={{ color: 'var(--sea)' }}>●</span> 지식 노트</span>
        <span style={{ marginLeft: 'auto' }}>별 {docs.length} · 별자리 선 {layout.edges.length}</span>
      </div>
    </div>
  );
}
