// 메신저 v2 일 카드(U6 ②): 에이전트 일 1건 = 토픽 하나(D4). 기존 메시지 목록 안에, 일을 시킨 글 바로 아래에 카드로 그린다.
// 상태는 서버 표(msgr2_works) 값을 약속 v1 effectiveState로 읽을 때 계산한다(expired·stalled — 크론 없음). 승인은 msgr2_approvals, 진행은 v2:wk: 방송.
import { effectiveState } from '../../../../packages/agent-link/contract/v1.mjs';

/** 카드 단계 — 화면 문구 키 v2.work.<phase>. */
export const PHASES = Object.freeze({
  offered: 'waiting', // 본체가 받기를 기다림
  accepted: 'received', // 받음
  running: 'working', // 진행
  awaiting_approval: 'approval', // 결재 대기
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  expired: 'expired', // 아무 본체도 받지 않았다
  stalled: 'unknown', // 결과 모름(리스가 끝났고 결과가 없다)
});

/**
 * work: msgr2_works 행(state·expires_at·lease_until·has_result·late·error_code·owner_user_id·root_user_id),
 * approval: 그 일의 가장 최근 승인 행(없으면 null), progress: { stage, note, at } | null(v2:wk: 방송), effects: msgr2_work_status의 effects(선택).
 * 반환: 카드 보기 모델.
 */
export function workCard({ work, approval = null, progress = null, effects = [], uid = null, now = Date.now() }) {
  const st = effectiveState(work, now);
  const phase = PHASES[st] ?? 'unknown';
  const live = ['offered', 'accepted', 'running', 'awaiting_approval', 'stalled'].includes(st);
  const apPending = !!(approval && approval.state === 'pending' && Date.parse(approval.expires_at) > now);
  return {
    workId: work.id, agentId: work.agent_id, topicId: work.topic_id, state: st, phase,
    late: !!work.late, error: st === 'failed' ? (work.error_code || 'internal') : null,
    stage: (st === 'running' || st === 'accepted') && progress?.stage ? progress.stage : null,
    approval: approval ? { id: approval.id, action: approval.action, risk: approval.risk, summary: approval.summary,
      state: approval.state === 'pending' && !apPending ? 'expired' : approval.state } : null,
    // 결재는 앱 기기 + 에이전트 주인만(서버 msgr2_approval_decide와 같은 조건 — 화면 단추 조건을 맞춘다, U2 미룸)
    canDecide: st === 'awaiting_approval' && apPending && uid != null && uid === work.owner_user_id,
    // 취소는 지시한 사람·주인(서버 msgr2_work_cancel)
    canCancel: live && uid != null && (uid === work.root_user_id || uid === work.owner_user_id),
    unknownEffects: effects.filter((e) => e.state === 'unknown').map((e) => e.key),
  };
}

/**
 * 메시지 목록에 일 카드를 끼운다. 카드는 그 일을 시킨 글(source_message_id) 바로 아래, 그 글이 목록에 없으면 일이 생긴 시각 자리.
 * 승인 요청 카드 글(kind 'card', meta.code 'approval.request')과 카드가 있는 일의 오류 시스템 글(work.error)은 일 카드가 대신 그리므로 목록에서 뺀다.
 * 반환: [{ type: 'msg', m } | { type: 'work', work }] 시간순.
 */
export function timeline(messages = [], works = []) {
  const wids = new Set(works.map((w) => w.id));
  // 승인 요청 카드 글과, 카드가 있는 일의 오류 시스템 글(카드가 같은 문구를 보인다)은 일 카드가 대신 그린다
  const msgs = messages.filter((m) => !(m.kind === 'card' && m.meta?.code === 'approval.request')
    && !(m.meta?.code === 'work.error' && wids.has(m.meta?.work ?? m.work_id)));
  const bySource = new Map();
  const loose = [];
  const ids = new Set(msgs.map((m) => Number(m.id)));
  for (const w of works) {
    if (w.source_message_id != null && ids.has(Number(w.source_message_id))) {
      const k = Number(w.source_message_id);
      (bySource.get(k) || bySource.set(k, []).get(k)).push(w);
    } else loose.push(w);
  }
  const out = [];
  const sortedLoose = [...loose].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let li = 0;
  for (const m of [...msgs].sort((a, b) => Number(a.id) - Number(b.id))) {
    while (li < sortedLoose.length && Date.parse(sortedLoose[li].created_at) < Date.parse(m.created_at)) out.push({ type: 'work', work: sortedLoose[li++] });
    out.push({ type: 'msg', m });
    for (const w of (bySource.get(Number(m.id)) || []).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) out.push({ type: 'work', work: w });
  }
  while (li < sortedLoose.length) out.push({ type: 'work', work: sortedLoose[li++] });
  return out;
}
