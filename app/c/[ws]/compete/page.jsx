'use client';
// 경쟁 시안 — 같은 과제를 크루 2~3명에게 동시에 맡기고, 시안을 나란히 비교해 채택한다(경쟁 PT).
// 격리: 경쟁 중 시안은 크루 개인 대화를 오염시키지 않고, 채택본만 승자 스레드에 기록된다.
// 레이아웃은 회의실과 같은 문법 — 헤더 라인 → 전체 높이 카드 → 하단 고정 컴포저 → 힌트 (UI 일관성).
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Icon, Markdown, ArgoSpinner, Skeleton, ConfirmModal, InputModal, api, imeGuard } from '../../../ui';
import { useLang } from '../../../i18n';

const MAX_PICK = 3;

export default function Compete({ params }) {
  const { ws } = use(params);
  const { t } = useLang();
  const [agents, setAgents] = useState([]);
  const [list, setList] = useState(null);      // 좌측 레일 — 경쟁 목록
  const [renameComp, setRenameComp] = useState(null); // 경쟁명 편집 모달 대상
  // 경쟁명 편집·고정 — 세션 레일과 동일 계약(PATCH /compete/[id] {title}|{pinned})
  async function doRenameComp(title) {
    const c = renameComp; setRenameComp(null);
    if (!c) return;
    try {
      await fetch(`/api/companies/${ws}/compete/${c.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      loadList();
    } catch { /* 레일 갱신 실패는 다음 로드에서 복구 */ }
  }
  async function doTogglePin(c) {
    try {
      await fetch(`/api/companies/${ws}/compete/${c.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: !c.pinned }),
      });
      loadList();
    } catch { /* 동일 */ }
  }
  const [comp, setComp] = useState(null);      // 열람 중 경쟁 (null = 새 경쟁)
  const [prompt, setPrompt] = useState('');
  const [pickedCrew, setPickedCrew] = useState(''); // 경쟁을 받을 크루 1명(slug)
  const [pickedModels, setPickedModels] = useState([]); // "runner:model" 페어 2~3개
  const [runners, setRunners] = useState(null); // 러너 카탈로그(연결 상태 포함) — 모델 선택지
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adoptTarget, setAdoptTarget] = useState(null); // 채택 확인 모달 대상(entrant key — 레거시는 slug)
  const compRef = useRef(null);
  compRef.current = comp;

  const loadList = useCallback(() => {
    api(`/api/companies/${ws}/compete`).then((d) => setList(d.competitions ?? [])).catch(() => setList([]));
  }, [ws]);
  useEffect(() => {
    loadList();
    api(`/api/companies/${ws}/agents`).then((d) => {
      const list = d.agents ?? [];
      setAgents(list);
      setPickedCrew((cur) => cur || (list[0]?.slug ?? '')); // 크루가 있으면 첫 크루 기본 선택(빈 드롭다운 방지)
    }).catch(() => {});
    api(`/api/runners?ws=${ws}`).then((d) => setRunners(d.runners ?? [])).catch(() => setRunners([]));
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

  const toggleModel = (pair) => setPickedModels((p) =>
    p.includes(pair) ? p.filter((x) => x !== pair) : p.length >= MAX_PICK ? p : [...p, pair]);

  async function start(e) {
    e.preventDefault();
    if (busy || !prompt.trim() || !pickedCrew || pickedModels.length < 2) return;
    setBusy(true); setError('');
    try {
      const entrants = pickedModels.map((pair) => {
        const [runner, ...rest] = pair.split(':');
        return { slug: pickedCrew, runner, model: rest.join(':') };
      });
      const d = await api(`/api/companies/${ws}/compete`, { prompt: prompt.trim(), entrants });
      setComp(d); setPrompt(''); setPickedModels([]);
      loadList();
    } catch (err) { setError(String(err.message)); } finally { setBusy(false); }
  }

  async function openComp(id) {
    if (!id) { setComp(null); setError(''); return; }
    try { setComp(await api(`/api/companies/${ws}/compete/${id}`)); setError(''); }
    catch (e) { setError(String(e.message)); }
  }

  function adopt(ref) { if (!busy) setAdoptTarget(ref); } // window.confirm(Tauri 무동작) 대신 인앱 ConfirmModal
  async function doAdopt() {
    const ref = adoptTarget;
    if (!ref || busy) return;
    setBusy(true); setError(''); setAdoptTarget(null);
    try {
      const d = await api(`/api/companies/${ws}/compete/${comp.id}`, { action: 'adopt', slug: ref });
      setComp(d); loadList();
      window.dispatchEvent(new Event('argo:refresh'));
    } catch (err) { setError(String(err.message)); } finally { setBusy(false); }
  }

  const winnerEnt = comp?.winner ? comp.entrants.find((x) => (x.key ?? x.slug) === comp.winner) : null;
  const winnerName = winnerEnt ? `${winnerEnt.name}${winnerEnt.modelLabel ? ` · ${winnerEnt.modelLabel}` : ''}` : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '216px minmax(0, 1fr)', gap: 18, alignItems: 'start', height: 'calc(100vh - 100px)', marginBottom: -70 }}>
      {adoptTarget && (
        <ConfirmModal
          title={t('compete.adopt')}
          description={t('compete.confirmAdopt', { name: (() => { const e = comp?.entrants.find((x) => (x.key ?? x.slug) === adoptTarget); return e ? `${e.name}${e.modelLabel ? ` · ${e.modelLabel}` : ''}` : adoptTarget; })() })}
          confirmLabel={t('common.confirm')}
          tone="primary"
          busy={busy}
          onConfirm={doAdopt}
          onClose={() => setAdoptTarget(null)}
        />
      )}
      {/* offset 100 = topbar56+상단26+하단여백18, marginBottom -70 = .content 하단 패딩(88) 상쇄로 body 스크롤 방지(입력창 하향·대화영역 확대). 본문 컬럼 minHeight:0과 한 세트(회의실·DM 동일). */}
      {/* 경쟁 레일 — 지난 경쟁이 적재된다. 무템플릿 grid 함정 방지: minmax(0,1fr) */}
      <div className="side-rail" style={{ position: 'sticky', top: 72, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, width: 216 }}>
        <span className="microlabel" style={{ padding: '2px 6px 4px' }}>
          {t('compete.sessions.title')}{list?.length ? ` · ${list.length}` : ''}
        </span>
        <button className={`nav-item${!comp ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => openComp(null)}>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{t('compete.new')}</span>
            <span className="nav-sub">{t('compete.sessions.newSub')}</span>
          </span>
        </button>
        {(list ?? []).map((c) => {
          const active = comp?.id === c.id;
          const pinColor = active ? 'var(--primary-fg)' : 'var(--primary)'; // 활성 골드 배경 위 골드 핀 겹침 방지(세션 레일 공통)
          const actColor = active ? 'var(--primary-fg)' : 'var(--fg-3)';
          return (
          <div key={c.id} className="rail-item" style={{ position: 'relative' }}>
            <button className={`nav-item${active ? ' active' : ''}`} style={{ width: '100%', textAlign: 'left', cursor: 'pointer', paddingRight: 48 }} onClick={() => openComp(c.id)}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600 }}>
                  {c.pinned && <Icon name="pin" size={11} style={{ flex: 'none', color: pinColor }} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title || c.topic}</span>
                </span>
                <span className="nav-sub" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  {c.status === 'running' && <ArgoSpinner size={10} />}
                  {new Date(c.createdAt).toLocaleDateString('sv-SE')} · {c.entrants[0]?.modelLabel ? `${c.entrants[0].name} · ${c.entrants.map((e) => e.modelLabel ?? '?').join(' vs ')}` : c.entrants.map((e) => e.name).join(' · ')}
                </span>
              </span>
            </button>
            <span className="rail-actions" style={{ position: 'absolute', right: 5, top: 7, display: 'flex', gap: 1 }}>
              <button type="button" title={c.pinned ? t('chat.sessions.unpin') : t('chat.sessions.pin')} aria-label={c.pinned ? t('chat.sessions.unpin') : t('chat.sessions.pin')}
                onClick={(e) => { e.stopPropagation(); doTogglePin(c); }}
                style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, border: 0, background: 'transparent', color: c.pinned ? pinColor : actColor, cursor: 'pointer', borderRadius: 6 }}>
                <Icon name="pin" size={12} />
              </button>
              <button type="button" title={t('chat.sessions.rename')} aria-label={t('chat.sessions.rename')}
                onClick={(e) => { e.stopPropagation(); setRenameComp(c); }}
                style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, border: 0, background: 'transparent', color: actColor, cursor: 'pointer', borderRadius: 6 }}>
                <Icon name="edit" size={12} />
              </button>
            </span>
          </div>
          );
        })}
        {list !== null && list.length === 0 && (
          <span style={{ fontSize: 11.5, color: 'var(--fg-3)', padding: '2px 6px', lineHeight: 1.5 }}>{t('compete.sessions.empty')}</span>
        )}
        {list === null && <Skeleton h={48} />}
      </div>

      {renameComp && (
        <InputModal
          title={t('chat.sessions.renameTitle')}
          defaultValue={renameComp.title || renameComp.topic || ''}
          placeholder={t('chat.sessions.renamePh')}
          confirmLabel={t('common.save')}
          onConfirm={doRenameComp}
          onClose={() => setRenameComp(null)}
        />
      )}

      {/* 본문 — 회의실과 동일 문법: 헤더 라인 / 전체 높이 카드 / 하단 컴포저 */}
      <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 12, height: '100%', minWidth: 0, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="microlabel">{t('compete.header')}</span>
          <span className="rule" style={{ flex: 1 }} />
          {comp?.status === 'running' && <span className="chip" style={{ flex: 'none' }}><ArgoSpinner size={11} /> {t('compete.running')}</span>}
          {comp?.winner && <span className="chip" style={{ borderColor: 'var(--warn)', color: 'var(--warn)', fontWeight: 700, flex: 'none' }}>{t('compete.adopted')}</span>}
        </div>

        <div className="card" style={{ padding: '16px 18px', overflowY: 'auto', minHeight: 0 }}>
          {!comp ? (
            <div className="empty">{t('compete.emptyMain')}</div>
          ) : (
            <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <Icon name="bolt" size={14} style={{ marginTop: 2, flex: 'none' }} />
                <span style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', minWidth: 0 }}>{comp.prompt}</span>
              </div>
              {comp.winner && (
                <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0 }}>
                  {t('compete.adoptedNote', { name: winnerName })}{' '}
                  <a href={`/c/${ws}/crew/${winnerEnt?.slug ?? comp.winner}`} style={{ color: 'var(--primary-strong)', fontWeight: 650 }}>{t('compete.goCrew')} →</a>
                </p>
              )}
              {/* 무템플릿 grid 함정 방지 — 컬럼형 grid에는 항상 minmax(0,1fr) */}
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${comp.entrants.length}, minmax(0, 1fr))`, gap: 12, alignItems: 'start' }}>
                {comp.entrants.map((e) => {
                  const ref = e.key ?? e.slug; // 신형=key(모델 경쟁), 레거시=slug(크루 경쟁)
                  const isWinner = comp.winner === ref;
                  return (
                    <div key={ref} className="card" style={{
                      padding: '14px 16px', display: 'grid', gap: 10, minWidth: 0,
                      ...(isWinner ? { borderColor: 'var(--warn)', boxShadow: '0 0 0 1px var(--warn)' } : {}),
                      ...(comp.winner && !isWinner ? { opacity: 0.55 } : {}),
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Avatar name={e.name} size={24} />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 12.5, fontWeight: 650 }}>{e.name}</span>
                          {/* 모델 경쟁이면 어떤 모델의 답인지가 비교 축 — 역할 대신 모델을 보인다 */}
                          <span style={{ display: 'block', fontSize: 11, color: 'var(--fg-3)', fontFamily: e.modelLabel ? 'var(--mono)' : undefined }}>{e.modelLabel || e.role}</span>
                        </span>
                        <span style={{ flex: 1 }} />
                        {e.status === 'running' && <ArgoSpinner size={13} />}
                        {isWinner && <span className="chip" style={{ borderColor: 'var(--warn)', color: 'var(--warn)', fontWeight: 700 }}>{t('compete.adopted')}</span>}
                        {e.status === 'error' && <span className="chip" style={{ color: 'var(--danger)' }}>{t('compete.failed')}</span>}
                      </div>
                      <div style={{ fontSize: 13, minWidth: 0 }}>
                        {e.status === 'running' && <Skeleton h={80} />}
                        {e.status === 'error' && <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0, whiteSpace: 'pre-wrap' }}>{e.error}</p>}
                        {e.status === 'done' && <Markdown text={e.reply ?? ''} />}
                      </div>
                      {e.status === 'done' && !comp.winner && (
                        <button className="btn btn-primary sm" disabled={busy} onClick={() => adopt(ref)} style={{ justifySelf: 'start' }}>
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

        {comp ? (
          /* 열람 중 — 회의실 보관 열람과 동일한 하단 바 문법 */
          <div className="card" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--fg-2)' }}>
            <Icon name="bolt" size={13} /> {comp.winner ? t('compete.closedBar') : comp.status === 'running' ? t('compete.runningBar') : t('compete.doneBar')}
            <span style={{ flex: 1 }} />
            <button className="btn btn-primary sm" onClick={() => openComp(null)}>{t('compete.new')}</button>
          </div>
        ) : (
          /* 새 경쟁 컴포저 — 회의실 컴포저와 동일 문법: 칩 행 → input-bar → 힌트 */
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="microlabel" style={{ marginRight: 3 }}>{t('compete.pick')}</span>
              {/* 크루 1명 — 등록된 모든 크루 중 선택(드롭다운) */}
              <select value={pickedCrew} onChange={(e) => setPickedCrew(e.target.value)} disabled={busy}
                style={{ height: 28, padding: '0 8px', background: 'var(--card-2)', border: '1px solid var(--border)', borderRadius: 8, outline: 'none', fontSize: 12, color: 'var(--fg)', maxWidth: 220 }}>
                {agents.length === 0 && <option value="">—</option>}
                {agents.map((a) => <option key={a.slug} value={a.slug}>{a.name} — {a.role}</option>)}
              </select>
              {agents.length === 0 && (
                <a href={`/c/${ws}`} style={{ fontSize: 12, color: 'var(--primary-strong)', fontWeight: 650 }}>{t('nav.hire')} →</a>
              )}
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="microlabel" style={{ marginRight: 3 }}>{t('compete.pickModels')}</span>
              {/* 연결된 러너의 모델만 선택 가능 — 미연결 러너 모델은 비활성(설정에서 연결 후) */}
              {(runners ?? []).flatMap((r) => r.models.map((m) => {
                const pair = `${r.id}:${m.id}`;
                const on = pickedModels.includes(pair);
                return (
                  <button type="button" key={pair} className="chip" onClick={() => toggleModel(pair)} disabled={!r.authed || busy}
                    aria-pressed={on} title={`${r.name} · ${m.label}`}
                    style={{ cursor: r.authed ? 'pointer' : 'not-allowed', opacity: r.authed ? 1 : 0.45,
                      ...(on ? { background: 'var(--primary)', color: 'var(--primary-fg)', borderColor: 'var(--primary)' } : {}) }}>
                    {m.label}{m.gated ? ` — ${t('runner.gatedBadge')}` : ''}
                  </button>
                );
              }))}
              {runners === null && <Skeleton h={22} w={160} />}
            </div>
            {error && <p style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0 }}>{error}</p>}
            <form onSubmit={start} className="input-bar">
              <input suppressHydrationWarning
                placeholder={t('compete.placeholder')}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={busy}
                {...imeGuard}
              />
              <button className="btn btn-primary btn-icon" disabled={busy || !prompt.trim() || !pickedCrew || pickedModels.length < 2} aria-label={t('compete.start')}>
                {busy ? <ArgoSpinner size={14} /> : <Icon name="send" size={15} />}
              </button>
            </form>
            <p style={{ fontSize: 11, color: pickedModels.length >= 2 ? 'var(--warn)' : 'var(--fg-3)', margin: 0 }}>
              {pickedModels.length >= 2 ? t('compete.costNote', { n: pickedModels.length }) : t('compete.hint')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
