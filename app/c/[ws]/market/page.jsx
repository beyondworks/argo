'use client';
// 스킬·도구 — 마켓플레이스. 내장 카탈로그 + 원격 마켓(skillsmp·공식 MCP 레지스트리) 검색·즉시 설치.
// 설치 즉시 모든 크루의 다음 턴에 반영된다 (스킬 → 시스템 프롬프트, MCP → mcpServers).
import { use, useEffect, useState } from 'react';
import { Icon, Spinner, Skeleton, useScrollLock, api, imeGuard } from '../../../ui';
import { useLang } from '../../../i18n';

const fmtN = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const safeId = (item) => String(item.name ?? '').toLowerCase().replace(/[^a-z0-9가-힣-]/g, '-').replace(/^-+|-+$/g, '');

/** 추천 TOP 20 — 스킬(★순) / MCP(npm 주간 다운로드순). 행 클릭 = 상세. */
function TopList({ ws, kind, installedIds, onInstalled, onDetail }) {
  const { t } = useLang();
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
        {t('market.topLabel', { source: kind === 'skills' ? t('market.sourceSkills') : t('market.sourceMcp') })}
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
                title={t('market.detailHint')}
              >
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-3)', width: 26, flex: 'none' }}>#{i + 1}</span>
                <span style={{ fontWeight: 650, fontSize: 12.5, flex: 'none', maxWidth: 220, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {item.title ?? item.name}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--fg-3)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {item.desc}
                </span>
                {item.needsKey && <span className="chip" style={{ flex: 'none' }}>{t('market.needsKey')}</span>}
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-2)', flex: 'none', width: 82, textAlign: 'right' }}>
                  {kind === 'skills' ? `★ ${fmtN(item.stars ?? 0)}` : t('market.perWeek', { n: fmtN(item.downloads ?? 0) })}
                </span>
                {on ? (
                  <span className="pill ok" style={{ flex: 'none' }}><span className="dot" />{t('market.installed')}</span>
                ) : (
                  <button className="btn sm" style={{ flex: 'none' }} onClick={(e) => install(e, item)} disabled={busy === key}>
                    {busy === key ? <Spinner size={11} /> : t('market.installNow')}
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
  const { t } = useLang();
  useScrollLock();
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
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'var(--overlay)', display: 'grid', placeItems: 'center', padding: 24 }} onClick={onClose}>
      <div className="card fade-up" style={{ width: 'min(600px, 100%)', maxHeight: '84vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title">{item.title ?? item.name}</span>
          <span className="rule" />
          <button className="btn sm" onClick={onClose}>{t('market.close')}</button>
        </div>
        <div style={{ padding: '0 20px 20px', display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className="chip"><span className="dot" />{item.kind === 'skill' ? t('market.skillLabel') : t('market.mcpLabel')}</span>
            {item.stars != null && <span className="chip">★ {fmtN(item.stars)}</span>}
            {item.downloads != null && <span className="chip">{t('market.perWeek', { n: fmtN(item.downloads) })}</span>}
            {item.author && <span className="chip">{item.author}</span>}
            {item.needsKey && <span className="chip danger">{t('market.needsKeyDanger')}</span>}
          </div>

          {item.desc && <p style={{ fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.6 }}>{item.desc}</p>}
          {err && <p style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</p>}
          {!exp && !err && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--fg-2)', fontSize: 12.5, padding: '6px 0' }}>
              <Spinner size={13} /> {t('market.preparingExplain')}
            </div>
          )}
          {exp && (
            <>
              <div>
                <div className="microlabel" style={{ marginBottom: 4 }}>{t('market.whatIsIt')}</div>
                <p style={{ fontSize: 13.5, lineHeight: 1.65 }}>{exp.easy?.what}</p>
              </div>
              {exp.easy?.when?.length > 0 && (
                <div>
                  <div className="microlabel" style={{ marginBottom: 4 }}>{t('market.whenToUse')}</div>
                  <ul style={{ listStyle: 'none', display: 'grid', gap: 4, fontSize: 13, color: 'var(--fg-2)' }}>
                    {exp.easy.when.map((w, i) => <li key={i}>· {w}</li>)}
                  </ul>
                </div>
              )}
              {exp.easy?.examples?.length > 0 && (
                <div>
                  <div className="microlabel" style={{ marginBottom: 6 }}>{t('market.tryPrompts')}</div>
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
                <p style={{ fontSize: 12.5, color: 'var(--danger)' }}>{t('market.caution', { msg: exp.easy.caution })}</p>
              )}
              {exp.raw && (
                <div>
                  <button className="btn sm" onClick={() => setShowRaw((v) => !v)}>{t('market.rawToggle', { state: showRaw ? t('market.collapse') : t('market.expand') })}</button>
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
              <span className="pill ok"><span className="dot" />{t('market.installedNextTurn')}</span>
            ) : (
              <button className="btn btn-primary sm" onClick={install} disabled={busy}>
                {busy ? <Spinner size={12} /> : t('market.installNow')}
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
  const { t } = useLang();
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
        <input suppressHydrationWarning
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          {...imeGuard}
          style={{ flex: 1, minWidth: 160, height: 32, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 999, outline: 'none', fontSize: 12.5 }}
        />
        <button className="btn sm" disabled={searching || !q.trim()}>
          {searching ? <Spinner size={11} /> : <Icon name="search" size={13} />} {t('market.remoteSearchBtn')}
        </button>
      </form>
      {err && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</span>}
      {results !== null && (
        results.length === 0 ? (
          <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>{t('market.noResults')}</span>
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
                  title={t('market.detailHint')}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{item.title ?? item.name}</span>
                    {on ? (
                      <span className="pill ok"><span className="dot" />{t('market.installed')}</span>
                    ) : (
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); install(item); }} disabled={busy === key}>
                        {busy === key ? <Spinner size={11} /> : t('market.installNow')}
                      </button>
                    )}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.55 }}>{item.desc || t('market.noDesc')}</span>
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
  const { t } = useLang();
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

  // 공방 — 직접 쓰는 스킬. 저장 즉시 모든 크루의 다음 턴에 적용된다.
  const [workshop, setWorkshop] = useState({ name: '', md: '' });
  async function addSkill(e) {
    e.preventDefault();
    if (!workshop.name.trim() || !workshop.md.trim()) return;
    setBusy('skill-custom');
    await act('POST', { kind: 'skill-custom', def: { name: workshop.name.trim(), md: workshop.md.trim() } });
    setWorkshop({ name: '', md: '' });
  }

  const installedSkillIds = new Set((data?.installedSkills ?? []).map((s) => s.id));
  const installedMcp = data?.installedMcp ?? {};

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="microlabel">{t('market.header')}</span>
        {error && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>}
      </div>

      {/* ── 스킬 ── */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <span className="card-title"><Icon name="bolt" size={14} />{t('market.skillsSectionTitle')}</span>
          <span className="rule" />
          <span className="pill"><span className="dot" />{data ? t('market.installedCount', { n: data.installedSkills.length }) : '—'}</span>
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
                  title={t('market.detailHint')}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{s.title}</span>
                    {on ? (
                      <button className="pill ok" style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); remove('skill', s.id); }} title={t('market.removeHint')}>
                        <span className="dot" />{t('market.installed')}
                      </button>
                    ) : (
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); install('skill', s.id); }} disabled={busy === `skill:${s.id}`}>
                        {busy === `skill:${s.id}` ? <Spinner size={11} /> : t('market.install')}
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
            placeholder={t('market.skillsmpSearchPlaceholder')}
            installedIds={installedSkillIds}
            onInstalled={load}
            onDetail={setDetail}
          />
        )}
        {data && data.installedSkills.some((s) => !data.skillCatalog.find((c) => c.id === s.id)) && (
          <div style={{ padding: '0 20px 16px' }}>
            <div className="microlabel" style={{ marginBottom: 6 }}>{t('market.externalSkills')}</div>
            {data.installedSkills.filter((s) => !data.skillCatalog.find((c) => c.id === s.id)).map((s) => (
              <div key={s.id} className="row" style={{ borderRadius: 10 }}>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{s.title}</span>
                <span className="mono" style={{ fontSize: 10, color: 'var(--fg-3)' }}>skills/{s.id}.md</span>
                <button className="btn sm btn-icon" style={{ width: 26 }} onClick={() => remove('skill', s.id)}><Icon name="trash" size={12} /></button>
              </div>
            ))}
          </div>
        )}
        {/* 공방 — 사장이 직접 쓰는 스킬(업무 매뉴얼 한 장). 만능 작업대의 아르고식 흡수 */}
        <form onSubmit={addSkill} style={{ display: 'grid', gap: 8, padding: '10px 18px 18px' }}>
          <span className="microlabel">{t('market.workshopLabel')}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div className="input-bar" style={{ background: 'var(--card-2)', flex: '0 0 220px' }}>
              <input placeholder={t('market.workshopNamePlaceholder')} value={workshop.name}
                onChange={(e) => setWorkshop({ ...workshop, name: e.target.value })} {...imeGuard} />
            </div>
            <div className="input-bar" style={{ background: 'var(--card-2)', flex: 1, minWidth: 240 }}>
              <input placeholder={t('market.workshopMdPlaceholder')} value={workshop.md}
                onChange={(e) => setWorkshop({ ...workshop, md: e.target.value })} {...imeGuard} />
            </div>
            <button className="btn btn-primary sm" disabled={!workshop.name.trim() || !workshop.md.trim() || busy === 'skill-custom'} style={{ flex: 'none' }}>
              {busy === 'skill-custom' ? <Spinner size={11} /> : t('market.workshopCreate')}
            </button>
          </div>
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)', lineHeight: 1.5 }}>{t('market.workshopHint')}</span>
        </form>
      </div>

      {/* ── MCP 도구 ── */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head">
          <span className="card-title"><Icon name="market" size={14} />{t('market.mcpSectionTitle')}</span>
          <span className="rule" />
          <span className="pill"><span className="dot" />{data ? t('market.connectedCount', { n: Object.keys(installedMcp).length }) : '—'}</span>
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
                    title={t('market.detailHint')}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 13 }}>{m.title}</span>
                      {on ? (
                        <button className="pill ok" style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); remove('mcp', m.id); }} title={t('market.removeHint')}>
                          <span className="dot" />{t('market.connected')}
                        </button>
                      ) : (
                        <button className="btn sm" onClick={(e) => { e.stopPropagation(); install('mcp', m.id); }} disabled={busy === `mcp:${m.id}`}>
                          {busy === `mcp:${m.id}` ? <Spinner size={11} /> : t('market.install')}
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
              sourceLabel={t('market.remoteMcpSource')}
              placeholder={t('market.mcpSearchPlaceholder')}
              installedIds={new Set(Object.keys(installedMcp))}
              onInstalled={load}
              onDetail={setDetail}
            />

            {/* 이 컴퓨터의 Claude Code MCP 가져오기 — 로컬 앱 전용(호스팅에선 서버가 빈 배열).
                env(토큰)까지 복사돼 바로 동작한다 — 값은 화면에 안 싣고 여부만 표시. */}
            {(data.hostMcp ?? []).length > 0 && (
              <div style={{ padding: '4px 18px 6px', display: 'grid', gap: 6 }}>
                <span className="microlabel">{t('market.hostLabel')}</span>
                {data.hostMcp.map((h) => {
                  const safeId = h.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
                  const on = !!installedMcp[safeId];
                  return (
                    <div key={h.name} className="row">
                      <span style={{ fontWeight: 650, fontSize: 12.5 }}>{h.name}</span>
                      <span className="mono" style={{ flex: 1, fontSize: 10.5, color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.summary}</span>
                      {h.hasEnv && <span className="chip" style={{ fontSize: 10 }}>{t('market.hostEnvChip')}</span>}
                      {on
                        ? <span className="pill" style={{ fontSize: 10.5 }}>{t('market.installed')}</span>
                        : (
                          <button className="btn sm" disabled={busy === `mcp-host:${h.name}`} onClick={async () => {
                            setBusy(`mcp-host:${h.name}`);
                            try { await act('POST', { kind: 'mcp-host', id: h.name }); } finally { setBusy(''); }
                          }}>
                            {busy === `mcp-host:${h.name}` ? <Spinner size={11} /> : t('market.hostImport')}
                          </button>
                        )}
                    </div>
                  );
                })}
                <span className="microlabel">{t('market.hostHint')}</span>
              </div>
            )}

            <form onSubmit={addCustom} style={{ display: 'flex', gap: 8, padding: '10px 18px 18px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="microlabel">{t('market.customLabel')}</span>
              <input suppressHydrationWarning
                placeholder={t('market.customNamePlaceholder')}
                value={custom.name}
                onChange={(e) => setCustom({ ...custom, name: e.target.value })}
                style={{ width: 170, height: 32, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12.5, fontFamily: 'var(--mono)' }}
              />
              <input suppressHydrationWarning
                placeholder={t('market.customCmdPlaceholder')}
                value={custom.command}
                onChange={(e) => setCustom({ ...custom, command: e.target.value })}
                style={{ flex: 1, minWidth: 200, height: 32, padding: '0 12px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12.5, fontFamily: 'var(--mono)' }}
              />
              <button className="btn sm" disabled={!custom.name || !custom.command || busy === 'mcp-custom'}>
                {busy === 'mcp-custom' ? <Spinner size={11} /> : t('market.addBtn')}
              </button>
              <span className="microlabel" style={{ width: '100%' }}>{t('market.customSecretHint')}</span>
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
