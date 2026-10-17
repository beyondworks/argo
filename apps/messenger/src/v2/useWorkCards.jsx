// 메신저 v2 일 카드를 기존 채널 화면(App.jsx Channel)에 끼우는 훅(U6c-1b ②). 카드 모양은 WorkCard.jsx, 상태 계산은 work-card.mjs.
// 읽는 때: 방을 열 때 한 번(loadWorks), 일 표지('v2work' — 서버 U6c-1a)가 왔을 때는 요청 없이 합친다. 결재 행이 필요한 때(결재 대기로 바뀜·결재 대기에서 벗어남)만 다시 읽는다.
// 진행 단계는 볼 때만 v2:wk:를 구독한다(연결 상태 기계 watchWork). 결과 모름 카드는 펼칠 때만 msgr2_work_status를 읽는다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmModal } from '@argo/ui';
import { WorkCard } from './WorkCard.jsx';
import { workCard } from './work-card.mjs';
import { loadWorks, workStatus, cancelWork, decideApproval } from './data.mjs';

const LIVE = ['accepted', 'running', 'awaiting_approval'];

/**
 * enabled: v2 모드, client: 조회 클라이언트, machine: 연결 상태 기계(없으면 진행 구독 없음), chId: 방, uid: 나, event: 셸이 넘기는 방송 사건,
 * nameOf(kind, id): 이름, t: 사전, onError(text).
 * 반환: { hides(m) — 카드가 대신 그리는 글인가, before(m) — 이 글 앞에 그릴 카드들, after(m) — 이 글 바로 아래 카드들, rest() — 남은 카드들, modal }
 */
export function useWorkCards({ enabled, client, machine, chId, uid, event, nameOf, t, onError }) {
  const [works, setWorks] = useState([]); const [approvals, setApprovals] = useState([]);
  const [progress, setProgress] = useState(() => new Map()); const [effects, setEffects] = useState(() => new Map());
  const [busy, setBusy] = useState(null); const [cancelAsk, setCancelAsk] = useState(null);
  const chRef = useRef(chId); chRef.current = chId;
  const worksRef = useRef(works); worksRef.current = works;

  const reload = useCallback(async (room) => {
    try { const d = await loadWorks(client, room); if (room === chRef.current) { setWorks(d.works); setApprovals(d.approvals); } } catch { /* 다음 표지에 다시 읽는다 */ }
  }, [client]);
  useEffect(() => { if (!enabled || !chId) return; setWorks([]); setApprovals([]); setProgress(new Map()); setEffects(new Map()); void reload(chId); }, [enabled, chId, reload]);

  useEffect(() => {
    if (!enabled || !event) return;
    if (event.kind === 'v2work' && event.channel_id === chRef.current) {
      const prev = new Map(worksRef.current.map((w) => [w.id, w]));
      const incoming = event.works ?? [];
      setWorks((cur) => { const m = new Map(cur.map((w) => [w.id, w])); for (const w of incoming) m.set(w.id, { ...m.get(w.id), ...w }); return [...m.values()]; });
      // 결재 행은 표지에 없다 — 결재 대기로 바뀌었거나 결재 대기에서 벗어난 일이 있을 때만 다시 읽는다
      if (incoming.some((w) => w.state === 'awaiting_approval' || prev.get(w.id)?.state === 'awaiting_approval')) void reload(chRef.current);
    }
    if (event.kind === 'v2progress' && event.workId) setProgress((p) => new Map(p).set(event.workId, { stage: event.stage, note: event.note, at: event.at }));
    if (event.kind === 'rt_up' && chRef.current) void reload(chRef.current); // 끊긴 동안 놓친 표지
  }, [enabled, event, reload]);

  // 진행 중인 일만 v2:wk:(와 주인의 v2:pr:)를 구독한다
  const liveKey = useMemo(() => works.filter((w) => LIVE.includes(w.state)).map((w) => `${w.id}|${w.owner_user_id ?? ''}`).sort().join(','), [works]);
  useEffect(() => {
    if (!enabled || !machine || !liveKey) return undefined;
    const offs = liveKey.split(',').map((k) => { const [id, owner] = k.split('|'); return machine.watchWork(id, owner ? { owner } : undefined); });
    return () => offs.forEach((f) => { try { f?.(); } catch { /* 이미 닫힘 */ } });
  }, [enabled, machine, liveKey]);

  const approvalOf = useCallback((wid) => approvals.filter((a) => a.work_id === wid).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null, [approvals]);
  const cards = useMemo(() => works.map((w) => ({ w, card: workCard({ work: w, approval: approvalOf(w.id), progress: progress.get(w.id) ?? null, effects: effects.get(w.id) ?? [], uid }) }))
    .sort((a, b) => Date.parse(a.w.created_at) - Date.parse(b.w.created_at)), [works, approvalOf, progress, effects, uid]);
  const ids = useMemo(() => new Set(works.map((w) => w.id)), [works]);

  const decide = async (card, decision) => {
    if (busy || !card.approval) return;
    setBusy(`${card.workId}:${decision}`);
    try { await decideApproval(client, card.approval.id, decision); await reload(chRef.current); } catch { onError?.(t('v2.ap.failed')); } finally { setBusy(null); }
  };
  const doCancel = async () => {
    const card = cancelAsk; if (!card) return;
    setBusy(`${card.workId}:cancel`);
    try { await cancelWork(client, card.workId); setCancelAsk(null); await reload(chRef.current); } catch { onError?.(t('v2.work.cancel.failed')); } finally { setBusy(null); }
  };
  const loadEffects = async (workId) => { try { const s = await workStatus(client, workId); setEffects((m) => new Map(m).set(workId, s?.effects ?? [])); } catch { /* 표시만 못 한다 */ } };
  const render = (c) => <WorkCard key={`w${c.w.id}`} card={c.card} t={t} nameOf={nameOf} busy={busy} onDecide={decide} onCancel={setCancelAsk} onEffects={loadEffects} />;

  const placed = useRef(new Set());
  return {
    enabled,
    /** 카드가 대신 그리는 글: 승인 요청 카드 글, 카드가 있는 일의 오류 시스템 글 */
    hides: (m) => enabled && ((m.kind === 'approval_card' && m.meta?.code === 'approval.request') || (m.kind === 'system' && m.meta?.code === 'work.error' && ids.has(m.meta?.work ?? m.work_id))),
    /** 그리기 한 번의 시작 — 어느 카드를 이미 놓았는지 비운다 */
    begin: () => { placed.current = new Set(); },
    /** 시킨 글을 못 찾은 카드 중 이 글보다 먼저 생긴 것(시각 자리) */
    before: (m, sourceIds) => (enabled ? cards.filter((c) => !placed.current.has(c.w.id) && !sourceIds.has(Number(c.w.source_message_id)) && Date.parse(c.w.created_at) < Date.parse(m.created_at)).map((c) => (placed.current.add(c.w.id), render(c))) : []),
    /** 이 글이 시킨 일의 카드(바로 아래) */
    after: (m) => (enabled ? cards.filter((c) => !placed.current.has(c.w.id) && Number(c.w.source_message_id) === Number(m.id)).map((c) => (placed.current.add(c.w.id), render(c))) : []),
    /** 아직 놓지 않은 카드(목록 끝) */
    rest: () => (enabled ? cards.filter((c) => !placed.current.has(c.w.id)).map((c) => (placed.current.add(c.w.id), render(c))) : []),
    modal: enabled && cancelAsk ? <ConfirmModal key="v2-cancel" title={t('v2.work.cancel.title')} description={t('v2.work.cancel.desc')} confirmLabel={t('v2.work.cancel.confirm')} busy={busy === `${cancelAsk.workId}:cancel`} onConfirm={doCancel} onClose={() => setCancelAsk(null)} /> : null,
  };
}
