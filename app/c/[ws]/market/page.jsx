'use client';
// 스킬·도구 — 마켓플레이스. 내장 카탈로그 + 원격 마켓(skillsmp·공식 MCP 레지스트리) 검색·즉시 설치.
// 설치 즉시 모든 크루의 다음 턴에 반영된다 (스킬 → 시스템 프롬프트, MCP → mcpServers).
import { use, useEffect, useState } from 'react';
import { Icon, Spinner, Skeleton, api, imeGuard } from '../../../ui';

const fmtN = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const safeId = (item) => String(item.name ?? '').toLowerCase().replace(/[^a-z0-9가-힣-]/g, '-').replace(/^-+|-+$/g, '');

/** 추천 TOP 20 — 스킬(★순) / MCP(npm 주간 다운로드순). 행 클릭 = 상세. */
function TopList({ ws, kind, installedIds, onInstalled, onDetail }) {
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api(`/api/companies/${ws}/market?top=${kind}`)
      .then((d) => { setItems(d.results); if (d.error) setErr(d.error); })
      .catch((e) => { setItems([]); setErr(String(e.message)); });
  }, [ws, kind]);

  async function install(e, item) {
    e.stopPropagation();
    const key = item.id ?? item.name;
    setBusy(key); setErr('');
    try {
      const res = await fetch(`/api/companies/${ws}/market`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: kind === 'skills' ? 'remote-skill' : 'remote-mcp', item }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      onInstalled();
    } catch (e2) {
      setErr(String(e2.message));
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ padding: '0 18px 14px' }}>
      <div className="microlabel" style={{ margin: '4px 0 8px' }}>
        추천 Top 20 · {kind === 'skills' ? 'skillsmp 인기순 (★)' : 'npm 주간 다운로드순'}
      </div>
      {err && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span>}
      {items === null ? (
        <Skeleton h={120} />
      ) : (
        <div style={{ border: '1px solid var(--border-soft)', borderRadius: 12, overflow: 'hidden' }}>
          {items.map((item, i) => {
            const key = item.id ?? item.name;
            const on = installedIds.has(safeId(item));
            return (
              <div
                key={key}
                className="row"
                style={{ cursor: 'pointer', padding: '9px 14px', borderTop: i === 0 ? 'none' : undefined }}
                onClick={() => onDetail({ ...item, kind: kind === 'skills' ? 'skill' : 'mcp' })}
                title="클릭하면 쉬운 설명을 보여드립니다"
              >
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', width: 26, flex: 'none' }}>#{i + 1}</span>
                <span style={{ fontWeight: 650, fontSize: 12.5, flex: 'none', maxWidth: 220, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {item.title ?? item.name}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--fg-3)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {item.desc}
                </span>
                {item.needsKey && <span className="chip" style={{ flex: 'none' }}>키 필요</span>}
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-2)', flex: 'none', width: 82, textAlign: 'right' }}>
                  {kind === 'skills' ? `★ ${fmtN(item.stars ?? 0)}` : `↓ ${fmtN(item.downloads ?? 0)}/주`}
                </span>
                {on ? (
                  <span className="pill ok" style={{ flex: 'none' }}><span className="dot" />설치됨</span>
                ) : (
                  <button className="btn sm" style={{ flex: 'none' }} onClick={(e) => install(e, item)} disabled={busy === key}>
                    {busy === key ? <Spinner size={11} /> : '즉시 설치'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 상세 모달 — 한글 easy 설명(생성·캐시) + 즉시 설치. */
function DetailModal({ ws, item, installedIds, onInstalled, onClose }) {
  const [exp, setExp] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const installed = installedIds.has(safeId(item));

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    fetch(`/api/companies/${ws}/market`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'explain', item }),
    })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); })
      .then(setExp)
      .catch((e) => setErr(String(e.message)));
    return () => window.removeEventListener('keydown', onKey);
  }, [ws, item, onClose]);

  async function install() {
    setBusy(true); setErr('');
    try {
      const body = item.kind === 'skill'
        ? { kind: item.githubUrl ? 'remote-skill' : 'skill', ...(item.githubUrl ? { item } : { id: item.name }) }
        : { kind: item.install ? 'remote-mcp' : 'mcp', ...(item.install ? { item } : { id: item.name }) };
      const res = await fetch(`/api/companies/${ws}/market`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      onInstalled();
    } catch (e2) {
      setErr(String(e2.message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(37,39,30,0.25)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <div className="card fade-up" style={{ width: 'min(600px, 100%)', maxHeight: '84vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title">{item.title ?? item.name}</span>
          <span className="rule" />
          <button className="btn sm" onClick={onClose}>닫기 ESC</button>
        </div>
        <div style={{ padding: '0 20px 20px', display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className="chip"><span className="dot" />{item.kind === 'skill' ? '스킬 · 작업 지침서' : 'MCP · 외부 연결'}</span>
            {item.stars != null && <span className="chip">★ {fmtN(item.stars)}</span>}
            {item.downloads != null && <span className="chip">↓ {fmtN(item.downloads)}/주</span>}
            {item.author && <span className="chip">{item.author}</span>}
            {item.needsKey && <span className="chip danger">API 키 필요</span>}
          </div>

          {item.desc && <p style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.6 }}>{item.desc}</p>}
          {err && <p style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</p>}
          {!exp && !err && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--fg-2)', fontSize: 12.5, padding: '6px 0' }}>
              <Spinner size={13} /> 쉬운 설명을 준비하고 있어요… (처음 한 번만 걸려요)
            </div>
          )}
          {exp && (
            <>
              <div>
                <div className="microlabel" style={{ marginBottom: 4 }}>이게 뭐예요?</div>
                <p style={{ fontSize: 13.5, lineHeight: 1.65 }}>{exp.easy?.what}</p>
              </div>
              {exp.easy?.when?.length > 0 && (
                <div>
                  <div className="microlabel" style={{ marginBottom: 4 }}>언제 쓰면 좋아요?</div>
                  <ul style={{ listStyle: 'none', display: 'grid', gap: 4, fontSize: 13, color: 'var(--fg-2)' }}>
                    {exp.easy.when.map((w, i) => <li key={i}>· {w}</li>)}
                  </ul>
                </div>
              )}
              {exp.easy?.examples?.length > 0 && (
                <div>
                  <div className="microlabel" style={{ marginBottom: 6 }}>크루에게 이렇게 시켜보세요</div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {exp.easy.examples.map((ex, i) => (
                      <div key={i} className="card" style={{ background: 'var(--card-2)', padding: '8px 12px', fontSize: 12.5 }}>
                        “{ex}”
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {exp.easy?.caution && (
                <p style={{ fontSize: 12.5, color: 'var(--danger)' }}>주의 — {exp.easy.caution}</p>
              )}
              {exp.raw && (
                <div>
                  <button className="btn sm" onClick={() => setShowRaw((v) => !v)}>원문 {showRaw ? '접기' : '보기'}</button>
                  {showRaw && (
                    <pre className="mono" style={{ marginTop: 8, fontSize: 10.5, lineHeight: 1.6, background: 'var(--card-2)', border: '1px solid var(--border-soft)', borderRadius: 10, padding: 12, whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto' }}>
                      {exp.raw}
                    </pre>
                  )}
                </div>
              )}
            </>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            {installed ? (
              <span className="pill ok"><span className="dot" />설치됨 — 다음 턴부터 반영</span>
            ) : (
              <button className="btn btn-primary sm" onClick={install} disabled={busy}>
                {busy ? <Spinner size={12} /> : '즉시 설치'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 원격 마켓 검색 + 즉시 설치 — kind: 'skills' | 'mcp' */
function RemoteSearch({ ws, kind, placeholder, sourceLabel, installedIds, onInstalled, onDetail }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  async function search(e) {
    e.preventDefault();
    if (!q.trim() || searching) return;
    setSearching(true); setErr(''); setResults(null);
    try {
      const d = await api(`/api/companies/${ws}/market?remote=${kind}&q=${encodeURIComponent(q.trim())}`);
      setResults(d.results);
      if (d.error) setErr(d.error);
    } catch (e2) {
      setErr(String(e2.message)); setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function install(item) {
    const key = item.id ?? item.name;
    setBusy(key); setErr('');
    try {
      const res = await fetch(`/api/companies/${ws}/market`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: kind === 'skills' ? 'remote-skill' : 'remote-mcp', item }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      onInstalled();
    } catch (e2) {
      setErr(String(e2.message));
    } finally {
      setBusy('');
    }
  }

  const safeId = (item) => String(item.name ?? '').toLowerCase().replace(/[^a-z0-9가-힣-]/g, '-').replace(/^-+|-+$/g, '');

  return (
    <div style={{ padding: '0 18px 16px', display: 'grid', gap: 10 }}>
      <form onSubmit={search} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span className="microlabel" style={{ flex: 'none' }}>{sourceLabel}</span>
        <input
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          {...imeGuard}
          style={{ flex: 1, minWidth: 160, height: 32, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 999, outline: 'none', fontSize: 12.5 }}
        />
        <button className="btn sm" disabled={searching || !q.trim()}>
          {searching ? <Spinner size={11} /> : <Icon name="search" size={13} />} 검색
        </button>
      </form>
      {err && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span>}
      {results !== null && (
        results.length === 0 ? (
          <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>검색 결과가 없습니다.</span>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
            {results.map((item) => {
              const key = item.id ?? item.name;
              const on = installedIds.has(safeId(item));
              return (
                <div
                  key={key}
                  className="card card-i fade-up"
                  style={{ background: 'var(--card-2)', padding: 14, display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer' }}
                  onClick={() => onDetail?.({ ...item, kind: kind === 'skills' ? 'skill' : 'mcp' })}
                  title="클릭하면 쉬운 설명을 보여드립니다"
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{item.title ?? item.name}</span>
                    {on ? (
                      <span className="pill ok"><span className="dot" />설치됨</span>
                    ) : (
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); install(item); }} disabled={busy === key}>
                        {busy === key ? <Spinner size={11} /> : '즉시 설치'}
                      </button>
                    )}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.55 }}>{item.desc || '설명 없음'}</span>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {kind === 'skills'
                      ? `${item.author ?? ''} · ★${item.stars ?? 0}`
                      : item.install?.kind === 'npm' ? `npx -y ${item.install.pkg}` : `remote · ${item.install?.url ?? ''}`}
                  </span>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

export default function Market({ params }) {
  const { ws } = use(params);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(''); // 진행 중인 항목 id
  const [error, setError] = useState('');
  const [custom, setCustom] = useState({ name: '', command: '' });
  const [detail, setDetail] = useState(null); // 상세 모달 대상

  function load() {
    api(`/api/companies/${ws}/market`).then(setData).catch((e) => setError(String(e.message)));
  }
  useEffect(load, [ws]);

  async function act(method, body, qs = '') {
    setError('');
    try {
      const res = await fetch(`/api/companies/${ws}/market${qs}`, {
        method,
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      load();
    } catch (e) {
      setError(String(e.message));
    } finally {
      setBusy('');
    }
  }

  const install = (kind, id) => { setBusy(`${kind}:${id}`); act('POST', { kind, id }); };
  const remove = (kind, id) => { setBusy(`${kind}:${id}`); act('DELETE', null, `?kind=${kind}&id=${encodeURIComponent(id)}`); };

  async function addCustom(e) {
    e.preventDefault();
    if (!custom.name || !custom.command) return;
    const [command, ...args] = custom.command.trim().split(/\s+/);
    setBusy('mcp-custom');
    await act('POST', { kind: 'mcp-custom', def: { name: custom.name.trim(), command, args } });
    setCustom({ name: '', command: '' });
  }

  const installedSkillIds = new Set((data?.installedSkills ?? []).map((s) => s.id));
  const installedMcp = data?.installedMcp ?? {};

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="microlabel">Marketplace · 검색 → 즉시 설치 → 다음 턴 반영</span>
        {error && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>}
      </div>

      {/* ── 스킬 ── */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <span className="card-title"><Icon name="bolt" size={14} />스킬 — 지시형 지침</span>
          <span className="rule" />
          <span className="pill"><span className="dot" />{data ? `${data.installedSkills.length} 설치됨` : '—'}</span>
        </div>
        {data === null ? (
          <div style={{ padding: '0 18px 18px' }}><Skeleton h={90} /></div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10, padding: '2px 18px 18px' }}>
            {data.skillCatalog.map((s) => {
              const on = installedSkillIds.has(s.id);
              return (
                <div
                  key={s.id}
                  className="card card-i"
                  style={{ background: 'var(--card-2)', padding: 14, display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer' }}
                  onClick={() => setDetail({ kind: 'skill', name: s.id, title: s.title, desc: s.desc })}
                  title="클릭하면 쉬운 설명을 보여드립니다"
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{s.title}</span>
                    {on ? (
                      <button className="pill ok" style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); remove('skill', s.id); }} title="클릭하면 제거">
                        <span className="dot" />설치됨
                      </button>
                    ) : (
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); install('skill', s.id); }} disabled={busy === `skill:${s.id}`}>
                        {busy === `skill:${s.id}` ? <Spinner size={11} /> : '설치'}
                      </button>
                    )}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.55 }}>{s.desc}</span>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>skills/{s.id}.md</span>
                </div>
              );
            })}
          </div>
        )}
        {data && (
          <TopList ws={ws} kind="skills" installedIds={installedSkillIds} onInstalled={load} onDetail={setDetail} />
        )}
        {data && (
          <RemoteSearch
            ws={ws}
            kind="skills"
            sourceLabel="skillsmp.com"
            placeholder="수천 개 커뮤니티 스킬 검색 — 예: newsletter, seo, youtube"
            installedIds={installedSkillIds}
            onInstalled={load}
            onDetail={setDetail}
          />
        )}
        {data && data.installedSkills.some((s) => !data.skillCatalog.find((c) => c.id === s.id)) && (
          <div style={{ padding: '0 20px 16px' }}>
            <div className="microlabel" style={{ marginBottom: 6 }}>설치된 외부·직접 스킬</div>
            {data.installedSkills.filter((s) => !data.skillCatalog.find((c) => c.id === s.id)).map((s) => (
              <div key={s.id} className="row" style={{ borderRadius: 10 }}>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{s.title}</span>
                <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>skills/{s.id}.md</span>
                <button className="btn sm btn-icon" style={{ width: 26 }} onClick={() => remove('skill', s.id)}><Icon name="trash" size={12} /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── MCP 도구 ── */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <span className="card-title"><Icon name="market" size={14} />MCP 도구 — 외부 연결</span>
          <span className="rule" />
          <span className="pill"><span className="dot" />{data ? `${Object.keys(installedMcp).length} 연결됨` : '—'}</span>
        </div>
        {data === null ? (
          <div style={{ padding: '0 18px 18px' }}><Skeleton h={90} /></div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10, padding: '2px 18px 14px' }}>
              {data.mcpCatalog.map((m) => {
                const on = !!installedMcp[m.id];
                return (
                  <div
                    key={m.id}
                    className="card card-i"
                    style={{ background: 'var(--card-2)', padding: 14, display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer' }}
                    onClick={() => setDetail({ kind: 'mcp', name: m.id, title: m.title, desc: m.desc })}
                    title="클릭하면 쉬운 설명을 보여드립니다"
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 13 }}>{m.title}</span>
                      {on ? (
                        <button className="pill ok" style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); remove('mcp', m.id); }} title="클릭하면 제거">
                          <span className="dot" />연결됨
                        </button>
                      ) : (
                        <button className="btn sm" onClick={(e) => { e.stopPropagation(); install('mcp', m.id); }} disabled={busy === `mcp:${m.id}`}>
                          {busy === `mcp:${m.id}` ? <Spinner size={11} /> : '설치'}
                        </button>
                      )}
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.55 }}>{m.desc}</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.def.command} {m.def.args.join(' ')}
                    </span>
                  </div>
                );
              })}
            </div>

            {Object.entries(installedMcp).filter(([n]) => !data.mcpCatalog.find((c) => c.id === n)).map(([n, def]) => (
              <div key={n} className="row" style={{ margin: '0 18px' }}>
                <span style={{ fontWeight: 650, fontSize: 12.5 }}>{n}</span>
                <span className="mono" style={{ flex: 1, fontSize: 10.5, color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {def.command} {(def.args ?? []).join(' ')}
                </span>
                <button className="btn sm btn-icon" style={{ width: 26 }} onClick={() => remove('mcp', n)}><Icon name="trash" size={12} /></button>
              </div>
            ))}

            <TopList ws={ws} kind="mcp" installedIds={new Set(Object.keys(installedMcp))} onInstalled={load} onDetail={setDetail} />
            <RemoteSearch
              ws={ws}
              kind="mcp"
              sourceLabel="공식 레지스트리"
              placeholder="MCP 서버 검색 — 예: fetch, github, notion, slack"
              installedIds={new Set(Object.keys(installedMcp))}
              onInstalled={load}
              onDetail={setDetail}
            />

            <form onSubmit={addCustom} style={{ display: 'flex', gap: 8, padding: '10px 18px 18px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="microlabel">Custom</span>
              <input
                placeholder="이름 (영소문자-하이픈)"
                value={custom.name}
                onChange={(e) => setCustom({ ...custom, name: e.target.value })}
                style={{ width: 170, height: 32, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12.5, fontFamily: 'var(--mono)' }}
              />
              <input
                placeholder="실행 명령 — 예: npx -y my-mcp-server"
                value={custom.command}
                onChange={(e) => setCustom({ ...custom, command: e.target.value })}
                style={{ flex: 1, minWidth: 200, height: 32, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12.5, fontFamily: 'var(--mono)' }}
              />
              <button className="btn sm" disabled={!custom.name || !custom.command || busy === 'mcp-custom'}>
                {busy === 'mcp-custom' ? <Spinner size={11} /> : '추가'}
              </button>
              <span className="microlabel" style={{ width: '100%' }}>시크릿이 필요한 MCP는 환경변수로만 — 여기에 키를 적지 마세요.</span>
            </form>
          </>
        )}
      </div>

      {detail && (
        <DetailModal
          ws={ws}
          item={detail}
          installedIds={detail.kind === 'skill' ? installedSkillIds : new Set(Object.keys(installedMcp))}
          onInstalled={() => { load(); }}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}
