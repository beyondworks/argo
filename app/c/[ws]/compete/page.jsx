'use client';
// 경쟁 시안 — 같은 과제를 크루 2~3명에게 동시에 맡기고, 시안을 나란히 비교해 채택한다(경쟁 PT).
// 격리: 경쟁 중 시안은 크루 개인 대화를 오염시키지 않고, 채택본만 승자 스레드에 기록된다.
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Icon, Markdown, ArgoSpinner, Skeleton, api } from '../../../ui';
import { useLang } from '../../../i18n';

const MAX_PICK = 3;

export default function Compete({ params }) {
  const { ws } = use(params);
  const { t } = useLang();
  const [agents, setAgents] = useState([]);
  const [list, setList] = useState(null);      // 좌측 레일 — 경쟁 목록
  const [comp, setComp] = useState(null);      // 열람 중 경쟁 (null = 새 경쟁 폼)
  const [prompt, setPrompt] = useState('');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const compRef = useRef(null);
  compRef.current = comp;

  const loadList = useCallback(() => {
    api(`/api/companies/${ws}/compete`).then((d) => setList(d.competitions ?? [])).catch(() => setList([]));
  }, [ws]);
  useEffect(() => {
    loadList();
    api(`/api/companies/${ws}/agents`).then((d) => setAgents(d.agents ?? [])).catch(() => {});
  }, [ws, loadList]);

  // 진행 중 경쟁 폴링 — 열람 중인 경쟁이 running이면 4초마다 갱신
  useEffect(() => {
    if (comp?.status !== 'running') return;
    const iv = setInterval(() => {
      api(`/api/companies/${ws}/compete/${comp.id}`)
        .then((d) => { if (compRef.current?.id === d.id) { setComp(d); if (d.status !== 'running') loadList(); } })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(iv);
  }, [ws, comp?.id, comp?.status, loadList]);

  const togglePick = (slug) => setPicked((p) =>
    p.includes(slug) ? p.filter((s) => s !== slug) : p.length >= MAX_PICK ? p : [...p, slug]);

  async function start(e) {
    e.preventDefault();
    if (busy || !prompt.trim() || picked.length < 2) return;
    setBusy(true); setError('');
    try {
      const d = await api(`/api/companies/${ws}/compete`, { prompt: prompt.trim(), slugs: picked });
      setComp(d); setPrompt(''); setPicked([]);
      loadList();
    } catch (err) { setError(String(err.message)); } finally { setBusy(false); }
  }

  async function openComp(id) {
    if (!id) { setComp(null); setError(''); return; }
    try { setComp(await api(`/api/companies/${ws}/compete/${id}`)); setError(''); }
    catch (e) { setError(String(e.message)); }
  }

  async function adopt(slug) {
    const name = comp?.entrants.find((x) => x.slug === slug)?.name ?? slug;
    if (busy || !window.confirm(t('compete.confirmAdopt', { name }))) return;
    setBusy(true); setError('');
    try {
      const d = await api(`/api/companies/${ws}/compete/${comp.id}`, { action: 'adopt', slug });
      setComp(d); loadList();
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (err) { setError(String(err.message)); } finally { setBusy(false); }
  }

  const winnerName = comp?.winner ? (comp.entrants.find((x) => x.slug === comp.winner)?.name ?? comp.winner) : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '216px minmax(0, 1fr)', gap: 18, alignItems: 'start' }}>
      {/* 경쟁 레일 — 지난 경쟁이 적재된다 */}
      <div style={{ position: 'sticky', top: 72, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, width: 216 }}>
        <span className="microlabel" style={{ padding: '2px 6px 4px' }}>
          {t('compete.sessions.title')}{list?.length ? ` · ${list.length}` : ''}
        </span>
        <button className={`nav-item${!comp ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => openComp(null)}>
          <Icon name="plus" size={14} />
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t('compete.new')}</span>
        </button>
        {(list ?? []).map((c) => (
          <button key={c.id} className={`nav-item${comp?.id === c.id ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => openComp(c.id)}>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.topic}</span>
              <span className="nav-sub" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                {c.status === 'running' && <ArgoSpinner size={10} />}
                {new Date(c.createdAt).toLocaleDateString('sv-SE')} · {c.entrants.map((e) => e.name).join(' · ')}
              </span>
            </span>
          </button>
        ))}
        {list !== null && list.length === 0 && (
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)', padding: '2px 6px', lineHeight: 1.5 }}>{t('compete.sessions.empty')}</span>
        )}
        {list === null && <Skeleton h={48} />}
      </div>

      {!comp ? (
        /* 새 경쟁 개설 */
        <form onSubmit={start} className="card" style={{ padding: '18px 20px', display: 'grid', gap: 14, maxWidth: 640 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="microlabel">{t('compete.header')}</span>
            <span className="rule" style={{ flex: 1 }} />
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('compete.emptyMain')}</p>
          <textarea
            value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('compete.placeholder')} disabled={busy}
            style={{ width: '100%', minHeight: 90, resize: 'vertical', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 12, padding: '10px 14px', outline: 'none', fontSize: 13.5, lineHeight: 1.65 }}
          />
          <div style={{ display: 'grid', gap: 7 }}>
            <span className="microlabel">{t('compete.pick')}</span>
            {agents.length === 0 && (
              <p style={{ fontSize: 12, color: 'var(--fg-3)', margin: 0 }}>
                <a href={`/c/${ws}`} style={{ color: 'var(--primary-strong)', fontWeight: 650 }}>{t('nav.hire')} →</a>
              </p>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {agents.map((a) => {
                const on = picked.includes(a.slug);
                return (
                  <button type="button" key={a.slug} className="chip" onClick={() => togglePick(a.slug)}
                    aria-pressed={on} title={a.role}
                    style={{ cursor: 'pointer', ...(on ? { background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' } : {}) }}>
                    {a.name} — {a.role}
                  </button>
                );
              })}
            </div>
          </div>
          {picked.length >= 2 && (
            <p style={{ fontSize: 12, color: 'var(--warn)', margin: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon name="bolt" size={12} /> {t('compete.costNote', { n: picked.length })}
            </p>
          )}
          {error && <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0 }}>{error}</p>}
          <div>
            <button className="btn btn-primary" disabled={busy || !prompt.trim() || picked.length < 2}>
              {busy ? <ArgoSpinner size={13} /> : <Icon name="send" size={13} />} {t('compete.start')}
            </button>
          </div>
        </form>
      ) : (
        /* 경쟁 열람 — 시안 나란히 비교 */
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          <div className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <Icon name="bolt" size={14} style={{ marginTop: 2, flex: 'none' }} />
            <span style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', minWidth: 0 }}>{comp.prompt}</span>
            <span style={{ flex: 1 }} />
            {comp.status === 'running' && <span className="chip" style={{ flex: 'none' }}><ArgoSpinner size={11} /> {t('compete.running')}</span>}
          </div>
          {comp.winner && (
            <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0 }}>
              {t('compete.adoptedNote', { name: winnerName })}{' '}
              <a href={`/c/${ws}/crew/${comp.winner}`} style={{ color: 'var(--primary-strong)', fontWeight: 650 }}>{t('compete.goCrew')} →</a>
            </p>
          )}
          {error && <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0 }}>{error}</p>}
          {/* 무템플릿 grid 함정 방지 — 컬럼형 grid에는 항상 minmax(0,1fr) */}
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${comp.entrants.length}, minmax(0, 1fr))`, gap: 12, alignItems: 'start' }}>
            {comp.entrants.map((e) => {
              const isWinner = comp.winner === e.slug;
              return (
                <div key={e.slug} className="card" style={{
                  padding: '14px 16px', display: 'grid', gap: 10, minWidth: 0,
                  ...(isWinner ? { borderColor: 'var(--warn)', boxShadow: '0 0 0 1px var(--warn)' } : {}),
                  ...(comp.winner && !isWinner ? { opacity: 0.55 } : {}),
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Avatar name={e.name} size={24} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 12.5, fontWeight: 650 }}>{e.name}</span>
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--fg-3)' }}>{e.role}</span>
                    </span>
                    <span style={{ flex: 1 }} />
                    {e.status === 'running' && <ArgoSpinner size={13} />}
                    {isWinner && <span className="chip" style={{ borderColor: 'var(--warn)', color: 'var(--warn)', fontWeight: 700 }}>{t('compete.adopted')}</span>}
                    {e.status === 'error' && <span className="chip" style={{ color: 'var(--danger)' }}>{t('compete.failed')}</span>}
                  </div>
                  <div style={{ fontSize: 13, maxHeight: '52vh', overflowY: 'auto', minWidth: 0 }}>
                    {e.status === 'running' && <Skeleton h={80} />}
                    {e.status === 'error' && <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0, whiteSpace: 'pre-wrap' }}>{e.error}</p>}
                    {e.status === 'done' && <Markdown text={e.reply ?? ''} />}
                  </div>
                  {e.status === 'done' && !comp.winner && (
                    <button className="btn btn-primary sm" disabled={busy} onClick={() => adopt(e.slug)} style={{ justifySelf: 'start' }}>
                      {t('compete.adopt')}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
