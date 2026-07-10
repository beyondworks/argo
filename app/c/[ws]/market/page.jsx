'use client';
// 스킬·도구 — 마켓플레이스. 스킬(md 지침)과 MCP 도구를 원클릭 설치/제거.
// 설치 즉시 모든 크루의 다음 턴에 반영된다 (스킬 → 시스템 프롬프트, MCP → mcpServers).
import { use, useEffect, useState } from 'react';
import { Icon, Spinner, Skeleton, api } from '../../../ui';

export default function Market({ params }) {
  const { ws } = use(params);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(''); // 진행 중인 항목 id
  const [error, setError] = useState('');
  const [custom, setCustom] = useState({ name: '', command: '' });

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
    <div style={{ display: 'grid', gap: 14, maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="microlabel">Marketplace · 설치 즉시 모든 크루의 다음 턴에 반영</span>
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
                <div key={s.id} className="card" style={{ background: 'var(--card-2)', padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{s.title}</span>
                    {on ? (
                      <button className="pill ok" style={{ cursor: 'pointer' }} onClick={() => remove('skill', s.id)} title="클릭하면 제거">
                        <span className="dot" />설치됨
                      </button>
                    ) : (
                      <button className="btn sm" onClick={() => install('skill', s.id)} disabled={busy === `skill:${s.id}`}>
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
        {data && data.installedSkills.some((s) => !data.skillCatalog.find((c) => c.id === s.id)) && (
          <div style={{ padding: '0 20px 16px' }}>
            <div className="microlabel" style={{ marginBottom: 6 }}>직접 만든 스킬</div>
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
                  <div key={m.id} className="card" style={{ background: 'var(--card-2)', padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 13 }}>{m.title}</span>
                      {on ? (
                        <button className="pill ok" style={{ cursor: 'pointer' }} onClick={() => remove('mcp', m.id)} title="클릭하면 제거">
                          <span className="dot" />연결됨
                        </button>
                      ) : (
                        <button className="btn sm" onClick={() => install('mcp', m.id)} disabled={busy === `mcp:${m.id}`}>
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
    </div>
  );
}
