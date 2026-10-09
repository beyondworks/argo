'use client';
// 작업 과정 — 1:1 대화와 회의실이 **같은 컴포넌트**를 쓴다(유건 요청 2026-10-09: Claude Code·Codex처럼 생각·도구·실행 중인 작업이 차례로 쌓여 보이고,
// 누르면 상세가 펼쳐진다). 진행 중엔 폴 조각을 합친 목록(입력 300자·결과 앞 20줄)을, 끝난 뒤엔 답 아래 접힌 '작업 과정 · N단계 · 걸린 시간'을 그린다.
// 전체(긴 입력·20줄 넘는 결과)는 누를 때만 /trace로 받는다 — 폴링에 싣지 않는다. 값은 서버가 저장할 때 이미 가렸다(maskSecrets).
import { useId, useState } from 'react';
import { Icon, Spinner, ArgoSpinner, api } from '../../ui';
import { useLang } from '../../i18n';
import { fmtTraceDur, stepTitle, nestSteps } from '../../lib/trace-view.mjs';

const PREVIEW = 20;
const TASK_TOOLS = /^(Task|Agent|TodoWrite)$/;
const iconOf = (s) => (s.kind === 'think' ? 'pulse' : s.kind === 'task' ? 'tasks'
  : s.name === 'Bash' ? 'play' : /^(Read|Glob|Grep)$/.test(s.name) ? 'search' : /^(Write|Edit|NotebookEdit)$/.test(s.name) ? 'edit'
    : /^Web/.test(s.name) ? 'link' : 'bolt');

const pre = { margin: 0, padding: '7px 9px', borderRadius: 8, background: 'var(--card-2)', border: '1px solid var(--border)', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--fg-2)', maxHeight: 360, overflow: 'auto' };
const linkBtn = { border: 0, background: 'transparent', padding: 0, color: 'var(--primary)', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, justifySelf: 'start', textAlign: 'left' }; // 격자 칸에서 늘어나 가운데로 가지 않게

function StatusMark({ step, t }) {
  if (step.status === 'run') return <Spinner size={11} />;
  if (step.status === 'err') return <span style={{ color: 'var(--danger)', fontSize: 11, fontWeight: 650 }}>{t('trace.failed')}</span>;
  if (step.status === 'stop') return <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{t('trace.stopped')}</span>;
  return step.kind === 'think' || !(step.ms >= 100) ? null : <span className="mono" style={{ color: 'var(--fg-3)', fontSize: 10.5 }}>{fmtTraceDur(t, step.ms)}</span>; // 0.1초 미만은 시간 표기 생략('0초' 잡음)
}

function StepRow({ step, depth, fullStep: got, loadFull: load, loading, t }) {
  const [open, setOpen] = useState(false);
  // 진행 중에 받은 전체가 이 단계가 끝나기 전 것이면(그때는 결과가 없었다) 낡은 것 — 다시 받는다
  const stale = !!got && got.status === 'run' && step.status !== 'run';
  const fullStep = stale ? null : got;
  const loadFull = () => load?.(step.i, stale);
  const [all, setAll] = useState(false);
  const { label, detail } = stepTitle(step);
  const think = step.kind === 'think';
  const name = think ? t('trace.think') : step.kind === 'task' && !TASK_TOOLS.test(step.name) ? t('trace.runnerTask', { name: step.name }) : label;
  const src = fullStep ?? step; // 전체를 받았으면 그것으로(입력 전체·결과 저장본)
  const input = src.input ?? '';
  const inputCut = !fullStep && (step.inputLen ?? 0) > (step.input ?? '').length;
  const lines = Number(src.lines ?? step.lines) || 0; // 회의실 한눈 보기(glance)는 결과가 없다 — 누르면 전체를 받아 그 값으로
  const resultLines = String(src.result ?? '').split('\n');
  const shown = all ? src.result ?? '' : resultLines.slice(0, PREVIEW).join('\n');
  const more = Math.max(0, lines - PREVIEW);
  const showMore = async () => { if (!fullStep) await loadFull(); setAll(true); };
  const rowId = useId(); // 같은 화면에 기록 여러 개가 펼쳐져도 겹치지 않게
  return (
    <div style={{ marginLeft: depth * 16, minWidth: 0 }}>
      <button type="button" onClick={() => { if (!open && step.glance && !fullStep) loadFull(); setOpen((v) => !v); }} aria-expanded={open} aria-controls={rowId}
        style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', minWidth: 0, border: 0, background: 'transparent', padding: '3px 0', cursor: 'pointer', color: 'var(--fg-2)', textAlign: 'left', fontSize: 12.5 }}>
        <Icon name={iconOf(step)} size={12} style={{ flex: 'none', color: 'var(--fg-3)' }} />
        <span style={{ flex: 'none', fontWeight: 600, color: 'var(--fg)' }}>{name}</span>
        <span className={think ? '' : 'mono'} style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-3)', fontSize: think ? 12 : 11.5 }}>
          {think ? String(step.result ?? '').split('\n')[0] : detail}
        </span>
        <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center' }}><StatusMark step={step} t={t} /></span>
        <span aria-hidden style={{ flex: 'none', color: 'var(--fg-3)', fontSize: 10, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
      </button>
      {open && (
        <div id={rowId} style={{ display: 'grid', gap: 6, padding: '4px 0 8px 19px', minWidth: 0 }}>
          {think ? (
            <div style={{ ...pre, fontFamily: 'inherit', fontSize: 12 }}>{shown || '—'}</div>
          ) : (
            <>
              {input && (
                <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                  <span style={{ fontSize: 10.5, color: 'var(--fg-3)', fontWeight: 600 }}>{t('trace.input')}</span>
                  <div style={pre}>{input}</div>
                  {inputCut && <button type="button" style={linkBtn} disabled={loading} onClick={loadFull}>{loading ? t('trace.loading') : t('trace.fullInput')}</button>}
                </div>
              )}
              {step.glance && !fullStep && loading && <span style={{ fontSize: 11.5, color: 'var(--fg-3)' }}>{t('trace.loading')}</span>}
              {step.status !== 'run' && !(step.glance && !fullStep) && (
                <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                  <span style={{ fontSize: 10.5, color: 'var(--fg-3)', fontWeight: 600 }}>{t('trace.result')}{lines ? ` · ${t('trace.lines', { n: lines })}` : ''}</span>
                  <div style={pre}>{shown || t('trace.noResult')}</div>
                  {!all && more > 0 && (
                    <button type="button" style={linkBtn} disabled={loading} onClick={showMore}>{loading ? t('trace.loading') : t('trace.more', { n: more })}</button>
                  )}
                  {all && src.cut && <span style={{ fontSize: 11, color: 'var(--fg-3)' }}>{t('trace.cutStored')}</span>}
                </div>
              )}
            </>
          )}
          {think && !all && more > 0 && <button type="button" style={linkBtn} disabled={loading} onClick={showMore}>{loading ? t('trace.loading') : t('trace.more', { n: more })}</button>}
        </div>
      )}
    </div>
  );
}

/** 단계 목록 — steps(폴 보기 또는 저장본), full(이미 받은 전체), 없으면 누를 때 /trace로 한 번 받는다. limit = 처음에 보이는 최근 단계 수. */
export function TraceSteps({ ws, slug, traceId, steps, full = null, limit = 0, dropped = 0 }) {
  const { t } = useLang();
  const [fetched, setFetched] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const fullSteps = full ?? fetched;
  const byI = new Map((fullSteps ?? []).map((s) => [s.i, s]));
  // 전체 받기 — 이미 받은 것에 그 단계가 있고 낡지 않았으면 다시 받지 않는다(끝난 기록은 처음부터 다 있다). 진행 중엔 새로 생긴 단계를 누르면 다시 받는다.
  const loadFull = async (needI = null, force = false) => {
    if (loading || !traceId) return;
    if (fullSteps && !force && (needI == null || byI.has(needI))) return;
    if (full) return; // 끝난 기록(전체를 받아 둔 목록)은 다시 받을 것이 없다
    setLoading(true); setErr(false);
    try {
      const d = await api(`/api/companies/${ws}/trace?slug=${encodeURIComponent(slug)}&id=${encodeURIComponent(traceId)}`);
      setFetched(d.trace?.steps ?? []);
    } catch { setErr(true); } finally { setLoading(false); }
  };
  const rows = nestSteps(steps);
  const hidden = limit && !showAll ? Math.max(0, rows.length - limit) : 0;
  return (
    <div style={{ display: 'grid', gap: 1, minWidth: 0 }}>
      {(hidden > 0 || dropped > 0) && (
        <button type="button" style={{ ...linkBtn, justifySelf: 'start', marginBottom: 2, color: 'var(--fg-3)' }} disabled={!hidden} onClick={() => setShowAll(true)}>
          {hidden ? t('trace.earlier', { n: hidden }) : t('trace.dropped', { n: dropped })}
        </button>
      )}
      {rows.slice(hidden).map(({ step, depth }) => (
        <StepRow key={`${step.i}`} step={step} depth={depth} fullStep={byI.get(step.i) ?? null} loadFull={loadFull} loading={loading} t={t} />
      ))}
      {err && <span style={{ fontSize: 11.5, color: 'var(--danger)' }}>{t('trace.loadFail')}</span>}
    </div>
  );
}

/** 진행 중 작업 과정 — 폴 조각을 합친 목록(live). 최근 8단계만 펼쳐 두고 앞은 '앞 N단계' 버튼. */
export function LiveTrace({ ws, slug, trace }) {
  if (!trace?.steps?.length) return null;
  return <TraceSteps ws={ws} slug={slug} traceId={trace.id} steps={trace.steps} limit={8} />;
}

/** 끝난 턴 — 답 아래 접힌 '작업 과정 · N단계 · 걸린 시간'. 펼치면 이 기기 기록을 한 번 받는다(다른 기기는 sum이 없어 그리지 않는다). */
export function TraceSummary({ ws, slug, id, sum }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(false);
  if (!sum || !id || !(sum.n > 0)) return null;
  const toggle = async () => {
    const next = !open; setOpen(next);
    if (!next || data) return;
    setErr(false);
    try { const d = await api(`/api/companies/${ws}/trace?slug=${encodeURIComponent(slug)}&id=${encodeURIComponent(id)}`); setData(d.trace ?? null); }
    catch { setErr(true); }
  };
  return (
    <div style={{ minWidth: 0, marginTop: 4 }}>
      <button type="button" onClick={toggle} aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: 0, background: 'transparent', padding: '2px 4px', cursor: 'pointer', color: 'var(--fg-3)', fontSize: 11.5 }}>
        <Icon name="pulse" size={11} />
        <span>{t('trace.summary', { n: sum.n ?? 0, dur: fmtTraceDur(t, sum.ms) })}</span>
        {sum.ok === false && <span style={{ color: 'var(--danger)' }}>· {t('trace.failed')}</span>}
        <span aria-hidden style={{ fontSize: 10, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
      </button>
      {open && (
        <div className="card" style={{ padding: '8px 12px', marginTop: 4, minWidth: 0 }}>
          {data ? (
            <>
              <TraceSteps ws={ws} slug={slug} traceId={id} steps={data.steps ?? []} full={data.steps ?? []} limit={40} dropped={data.dropped ?? 0} />
              {data.capped && <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--fg-3)' }}>{t('trace.capped')}</p>}
            </>
          ) : err ? (
            <span style={{ fontSize: 11.5, color: 'var(--danger)' }}>{t('trace.loadFail')}</span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--fg-3)' }}><ArgoSpinner size={12} />{t('trace.loading')}</span>
          )}
        </div>
      )}
    </div>
  );
}
