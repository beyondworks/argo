// 능동 비서 상태 — <회사>/.assistant/state.json(기기 로컬, 동기화 제외·원격 불가시: sync.mjs isAssistantStateRel, 에이전트 셸 방어: permission-gate BASH_DOT_DIR_RE).
// 담는 것: 보낸 키(14일), 보류 목록(조용한 시간·잠든 사이 지난 일정), 대기열(보낼 글 1건 이하, 기한 있음), 일정 확인 범위, 아침·저녁 묶음을 처리한 날짜,
// 오늘 보낸 즉시 알림 수, 마지막 상태.
// 쓰기는 값이 바뀐 때만 — tick.mjs save가 직전에 쓴 내용과 비교한다(유휴 틱 쓰기 0).
import { join } from 'node:path';
import { paths } from '../workspace.mjs';
import { readJson } from '../jsonstore.mjs';

export const STATE_DIR = '.assistant';
export const SENT_KEEP_MS = 14 * 86_400_000;
export const PENDING_MAX = 100; // 보류 목록 상한 — 배달이 오래 막혀도 파일이 커지지 않게(넘치면 오래된 것부터 버린다)
export const PENDING_KEEP_MS = 2 * 86_400_000; // 이틀 지난 "지난 일정" 소식은 쓸모가 없다

export const stateFile = (wsId) => join(paths(wsId).root, STATE_DIR, 'state.json');

export function emptyState() {
  return { v: 1, sent: {}, pending: [], outbox: null, cal: { coveredUntil: 0, readAt: 0 }, bundles: { am: '', pm: '' }, day: { date: '', instant: 0 }, status: null };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** 읽은 값 → 엔진이 쓰는 모양(순수). 모르는 칸·틀린 모양은 버린다. */
export function normalizeState(raw) {
  const s = emptyState();
  if (!raw || typeof raw !== 'object') return s;
  if (raw.sent && typeof raw.sent === 'object') for (const [k, t] of Object.entries(raw.sent)) if (typeof k === 'string' && Number.isFinite(Number(t))) s.sent[k] = Number(t);
  if (Array.isArray(raw.pending)) s.pending = raw.pending.filter((p) => p && typeof p.key === 'string').slice(-PENDING_MAX);
  const o = raw.outbox;
  // 기한(until) 없는 대기열 글은 버린다 — 기한이 없으면 낡은 글이 언제까지고 다시 나갈 수 있다(tick.mjs 대기열 기한)
  if (o && typeof o === 'object' && typeof o.basis === 'string' && typeof o.body === 'string' && Array.isArray(o.keys) && Number.isFinite(Number(o.until))) s.outbox = o;
  s.cal = { coveredUntil: num(raw.cal?.coveredUntil), readAt: num(raw.cal?.readAt) };
  s.bundles = { am: typeof raw.bundles?.am === 'string' ? raw.bundles.am : '', pm: typeof raw.bundles?.pm === 'string' ? raw.bundles.pm : '' };
  s.day = { date: typeof raw.day?.date === 'string' ? raw.day.date : '', instant: num(raw.day?.instant) };
  s.status = raw.status && typeof raw.status.code === 'string' ? { code: raw.status.code, at: num(raw.status.at) } : null;
  return s;
}

/** 상태 읽기 — { state, fresh }. fresh = 이 기기에 상태가 없었다(처음 켬·처음 리더). 손상이면 jsonstore가 .corrupt로 옮기고, 새 상태로 시작한다. */
export async function readState(wsId) {
  try {
    const raw = await readJson(stateFile(wsId), null);
    return raw ? { state: normalizeState(raw), fresh: false } : { state: emptyState(), fresh: true };
  } catch (e) {
    console.error(`[argo] 비서 상태 파일이 손상돼 새로 시작합니다(${wsId}): ${String(e?.message ?? e).slice(0, 120)}`);
    return { state: emptyState(), fresh: true };
  }
}

/** 보낸 키·보류 항목 정리(순수, state를 고친다) — 14일 지난 키, 이틀 지난 보류 항목, 상한 초과분. */
export function pruneState(state, now) {
  for (const [k, t] of Object.entries(state.sent)) if (now - t > SENT_KEEP_MS) delete state.sent[k];
  state.pending = state.pending.filter((p) => !(Number(p.start) > 0 && now - Number(p.start) > PENDING_KEEP_MS)).slice(-PENDING_MAX);
  return state;
}
