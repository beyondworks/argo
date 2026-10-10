// 목표 하트비트의 시각 판정(순수 — 노드 의존 0). 루틴 스케줄러(scheduler.mjs claimRoutine)·루틴 판정(routines.mjs isDue)·화면이 같은 규칙을 쓴다.
// 목표 하트비트 = routines.json의 루틴 한 종류(kind 'goal'). 새 스케줄러를 두지 않고 루틴 스케줄러의 선점(lastRun 각인)·동기화·리더 게이트를 그대로 탄다.
// schedule.type은 'goal'이다 — 이 종류를 모르는 옛 버전 기기의 isDue는 시각 칸이 없어 발화하지 않는다(옛 기기가 리더면 목표 하트비트는 쉰다 — 잘못 돌지는 않는다).
import { zonedParts } from './routine-time.mjs';

export const GOAL = Object.freeze({
  minEveryMin: 10,        // 확인 간격 하한(분) — 루틴 interval과 같은 하한
  maxEveryMin: 1440,      // 상한(하루)
  defaultEveryMin: 60,
  defaultDays: 7,         // 기한 기본
  maxDays: 30,            // 기한 상한
  dailyMax: 48,           // 목표 하나의 하루 최대 회차(회사 시간대 날짜) — 넘으면 그날은 더 돌지 않고 다음 날 이어 간다
  maxActive: 5,           // 동시에 켤 수 있는 목표 수(진행 중만 센다 — 일시 정지·끝난 목표는 세지 않는다)
  notesKeep: 5,           // 지난 회차 메모 보관 수
  notesShown: 3,          // 회차 지시에 싣는 메모 수(회차 맥락은 가볍게)
  noteMax: 200,           // 메모 한 줄 상한
  failStop: 3,            // 연속 실패 상한 — 닿으면 멈추고 알린다
  keepFinished: 20,       // 끝난 목표 기록 보관 수(삭제하지 않고 completed로 남긴다 — 넘친 오래된 기록만 정리)
  deliverRetryMin: Object.freeze([5, 15, 60]), // 알림 다시 보내기 간격(분)
  deliverGiveUpMs: 24 * 60 * 60_000,           // 알림을 24시간 못 보내면 포기(기록은 대화·목록에 남는다)
});

export const GOAL_ACTIVE = 'active';
export const GOAL_PAUSED = 'paused';
export const GOAL_ENDED = Object.freeze(['done', 'blocked', 'expired', 'failed', 'stopped']);

const ms = (v) => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : NaN; };
const ymd = (p) => `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
/** 그 시간대의 오늘 날짜 'YYYY-MM-DD' */
export const goalDate = (now, tz) => ymd(zonedParts(now instanceof Date ? now : new Date(now), tz ?? null));
export const isGoal = (r) => r?.kind === 'goal' && !!r.goal && typeof r.goal === 'object';
export const everyMs = (r) => {
  const n = Math.floor(Number(r?.schedule?.everyMinutes));
  return Number.isFinite(n) && n >= GOAL.minEveryMin ? Math.min(n, GOAL.maxEveryMin) * 60_000 : GOAL.defaultEveryMin * 60_000;
};
export const retryMs = (tries) => GOAL.deliverRetryMin[Math.min(Math.max(0, tries), GOAL.deliverRetryMin.length - 1)] * 60_000;
/** 오늘 이 목표가 돈 회차 수 */
export const runsToday = (r, now) => (r.goal?.day?.date === goalDate(now, r.schedule?.tz) ? Math.max(0, Number(r.goal.day.runs) || 0) : 0);

/** 지금 이 목표에 할 일(순수) — 'deliver'(못 보낸 알림 다시 보내기) | 'expire'(기한 지남 — 모델 턴 없이 끄고 알림) | 'check'(회차 — 모델 턴 1번) | null.
    할 일이 없으면 null — 스케줄러 틱은 이 판정만 하고 쓰기·호출 0이다. */
export function goalMode(r, now = new Date()) {
  if (!isGoal(r)) return null;
  const g = r.goal; const t = now.getTime();
  // 일시 정지한 목표도 기한이 지나면 끝낸다('기한 지나 끝남' 알림 1회) — 남으면 정리되지 않고 개수 자리를 차지한다(재검수 LOW-4)
  if (!r.enabled) return g.status === GOAL_PAUSED && !(t < ms(g.deadline)) ? 'expire' : null;
  if (g.outbox && !(t < ms(g.outbox.nextAt))) return 'deliver';
  if (g.status !== GOAL_ACTIVE) return null;
  if (!(t < ms(g.deadline))) return 'expire';
  if (t < ms(g.nextAt)) return null;
  if (runsToday(r, now) >= GOAL.dailyMax) return null; // 하루 상한 — 날짜가 바뀌면 다시 돈다(그 사이 쓰기 0)
  return 'check';
}

/** 실행 직전 선점(순수, r을 고친다) — 스케줄러가 routines.json 잠금 안에서 부른다(claimRoutine). 반환 = 선점한 할 일 또는 null.
    다음 실행 시각을 **실행 전에** 먼저 옮긴다: 실행이 길어지거나 프로세스가 죽거나 다른 기기가 같은 파일을 읽어도 같은 회차를 두 번 쏘지 않는다. */
export function claimGoal(r, now = new Date()) {
  const mode = goalMode(r, now);
  if (!mode) return null;
  const g = r.goal; const t = now.getTime(); const iso = now.toISOString();
  r.lastRun = iso;
  if (mode === 'deliver') {
    g.outbox = { ...g.outbox, nextAt: new Date(t + retryMs(g.outbox.tries ?? 0)).toISOString() };
  } else if (mode === 'expire') {
    // 기한 지남 — 상태를 여기서 바꾸고 알림을 대기열에 둔다(실행이 죽어도 다음 틱이 그 알림을 보낸다). 모델 턴 없음.
    g.status = 'expired'; g.endedAt = iso; r.enabled = true; // 알림을 보내는 동안 켜 둔다(보낸 뒤·포기한 뒤 꺼진다) — 일시 정지에서 온 경우도
    g.outbox = { kind: 'expired', basis: `goal:${r.id}:expired`, tries: 0, nextAt: new Date(t + retryMs(0)).toISOString(), until: new Date(t + GOAL.deliverGiveUpMs).toISOString() };
    g.claim = { mode: 'deliver', at: iso };
    return 'deliver';
  } else {
    g.nextAt = new Date(t + everyMs(r)).toISOString();
    const date = goalDate(now, r.schedule?.tz);
    g.day = { date, runs: runsToday(r, now) + 1 };
    g.runs = (Number(g.runs) || 0) + 1;
  }
  g.claim = { mode, at: iso };
  return mode;
}

/** 에이전트가 정한 다음 확인 시각을 맞춘다(순수) — 이번 회차 시작 + 최소 간격 ~ 기한 안. 범위 밖이면 가까운 끝으로. 못 읽으면 null(claim이 정한 값 유지). */
export function clampNextAt(raw, { startedAt, deadline }) {
  const t = typeof raw === 'number' ? raw : ms(raw);
  if (!Number.isFinite(t)) return null;
  const lo = startedAt + GOAL.minEveryMin * 60_000;
  const hi = ms(deadline);
  const v = Math.max(lo, t);
  return Number.isFinite(hi) ? Math.min(v, hi) : v;
}

/** 화면 상태(순수) — 'active' | 'paused' | 'sending'(끝났고 알림을 보내는 중) | 끝난 상태 이름. */
export function goalView(r) {
  const g = r?.goal ?? {};
  if (GOAL_ENDED.includes(g.status)) return g.outbox && r.enabled ? 'sending' : g.status;
  if (!r?.enabled || g.status === GOAL_PAUSED) return 'paused';
  return 'active';
}
