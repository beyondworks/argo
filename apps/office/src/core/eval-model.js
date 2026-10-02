// 평가 레포트 규칙(트랙 C, 유건 10/2 — 인트라넷 인사고과 레포트를 성과 기록 옆으로). 순수 함수만, 테스트로 잠근다.
// 인트라넷과 같은 5항목·종합점수·총평·기간 업무내용·성과. 오피스는 여기에 근거(공유된 성과 기록 합계)·판(고치기 이력)·추이를 더한다.

import { SCOPE_FROM_KO, TYPE_FROM_KO, DATE_UNITS as U } from './match-i18n.js';

export const SCORE_KEYS = ['performance', 'quality', 'productivity', 'expertise', 'collaboration'];
export const SCOPES = ['week', 'month', 'year'];
// 인트라넷 범위·대상유형 이름 → 오피스 값(이관이 쓴다)
export { SCOPE_FROM_KO, TYPE_FROM_KO };

/** 종합점수 색 단계 — 인트라넷과 같은 경계(80 이상 좋음, 60 이상 보통, 그 밑 낮음) */
export const scoreTone = (v) => (v == null ? 'none' : v >= 80 ? 'good' : v >= 60 ? 'mid' : 'low');

const clampScore = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Math.max(0, Math.min(100, Math.round(Number(v)))));
/** 준 항목의 평균(서버와 같은 반올림). 하나도 없으면 null */
export function autoTotal(scores) {
  const xs = SCORE_KEYS.map((k) => clampScore(scores?.[k])).filter((x) => x != null);
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}

/** 레이더 꼭짓점 — 12시 방향부터 시계 방향, 값 0~100을 반지름으로. 빈 값은 0. 반환 [x, y] 목록(cx·cy 기준 좌표) */
export function radarPoints(scores, r, cx = 0, cy = 0) {
  return SCORE_KEYS.map((k, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / SCORE_KEYS.length;
    const v = (clampScore(scores?.[k]) ?? 0) / 100;
    return [+(cx + Math.cos(a) * r * v).toFixed(2), +(cy + Math.sin(a) * r * v).toFixed(2)];
  });
}
export const hasScores = (e) => SCORE_KEYS.some((k) => e?.[k] != null && e[k] > 0);

/** 지금 판만(새 판으로 대체된 것 빼기) */
export const currentOnly = (evals) => (evals ?? []).filter((e) => !e.replaced_by);

/** 한 레포트의 판 목록(첫 판 → 지금 판) */
export function versionsOf(evals, id) {
  const byId = new Map((evals ?? []).map((e) => [e.id, e]));
  let cur = byId.get(id);
  if (!cur) return [];
  while (cur.replaced_by && byId.has(cur.replaced_by)) cur = byId.get(cur.replaced_by);
  const out = [cur];
  while (out[0].replaces && byId.has(out[0].replaces)) out.unshift(byId.get(out[0].replaces));
  return out;
}

/** 대상 열쇠 — 사람은 계정, 계정 없는 사람·크루는 이름 */
export const subjectKey = (e) => (e.subject_user ? `u:${e.subject_user}` : `${e.subject_kind}:${e.subject_name}`);

/** 대상 목록(고르기용) — 이름순, 한 번씩 */
export function subjectsOf(evals, locale = 'ko') {
  const m = new Map();
  for (const e of evals ?? []) if (!m.has(subjectKey(e))) m.set(subjectKey(e), { key: subjectKey(e), name: e.subject_name, kind: e.subject_kind, type: e.subject_type });
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, locale));
}

/** 범위 탭·대상 고르기 — 지금 판만, 최근 기간 먼저 */
export function filterEvals(evals, { scope = 'all', subject = 'all' } = {}) {
  return currentOnly(evals).filter((e) => (scope === 'all' || e.scope === scope) && (subject === 'all' || subjectKey(e) === subject))
    .sort((a, b) => (a.period_from === b.period_from ? String(b.created_at).localeCompare(String(a.created_at)) : a.period_from < b.period_from ? 1 : -1));
}

/** 추이 — 같은 대상·같은 범위의 지금 판 종합점수를 기간 순서로(오래된 것 먼저). 점수 없는 판은 뺀다 */
export function trendOf(evals, e) {
  if (!e) return [];
  return currentOnly(evals).filter((x) => subjectKey(x) === subjectKey(e) && x.scope === e.scope && x.total != null)
    .sort((a, b) => (a.period_from < b.period_from ? -1 : a.period_from > b.period_from ? 1 : String(a.created_at).localeCompare(String(b.created_at))))
    .map((x) => ({ id: x.id, from: x.period_from, total: x.total }));
}

/** 추이 꺾은선 좌표 — w×h 상자, 0~100 */
export function trendPath(points, w, h, pad = 6) {
  if (!points.length) return [];
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  // 세로 눈금은 점수 범위 ±10(0~100 안) — 72·76·81처럼 가까운 점수도 오르내림이 보이게
  const ts = points.map((p) => p.total), lo = Math.max(0, Math.min(...ts) - 10), hi = Math.min(100, Math.max(...ts) + 10);
  return points.map((p, i) => [+(pad + (points.length > 1 ? i * step : (w - pad * 2) / 2)).toFixed(1), +(h - pad - ((p.total - lo) / (hi - lo || 1)) * (h - pad * 2)).toFixed(1)]);
}

/** 평가 쓰기 폼 → 서버 eval.add. 대상·기간이 없으면 null */
export function evalPayload(form, period) {
  const scores = Object.fromEntries(SCORE_KEYS.map((k) => [k, clampScore(form[k])]));
  const total = clampScore(form.total);
  const base = { id: form.id, title: String(form.title ?? '').trim().slice(0, 200), ...scores, total,
    review: String(form.review ?? '').slice(0, 20000), work: String(form.work ?? '').slice(0, 20000), achievements: String(form.achievements ?? '').slice(0, 20000) };
  if (!base.title) return null;
  if (form.replaces) return { ...base, replaces: form.replaces };
  if (!period || !SCOPES.includes(form.scope)) return null;
  if (form.subject_kind === 'crew') {
    const name = String(form.subject_name ?? '').trim();
    return name ? { ...base, subject_kind: 'crew', subject_name: name.slice(0, 100), scope: form.scope, from: period.from, to: period.to } : null;
  }
  return form.subject_user ? { ...base, subject_kind: 'person', subject_user: form.subject_user, subject_type: form.subject_type === 'ceo' ? 'ceo' : 'staff', scope: form.scope, from: period.from, to: period.to } : null;
}

/** 인트라넷 '기간' 글에서 날짜 범위를 짐작(이관). 못 읽으면 기준 날짜가 든 범위의 단위 기간 */
export function parsePeriod(text, scope, fallbackDay) {
  const s = String(text ?? '');
  const full = [...s.matchAll(new RegExp(`(\\d{4})[-./${U.year}]\\s*(\\d{1,2})[-./${U.month}]\\s*(\\d{1,2})`, 'g'))].map((m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  if (full.length >= 2) return { from: full[0] <= full[1] ? full[0] : full[1], to: full[0] <= full[1] ? full[1] : full[0] };
  const short = /(\d{4})[-./]\s*(\d{1,2})[-./]\s*(\d{1,2})\s*[~–]\s*(\d{1,2})[-./]\s*(\d{1,2})(?![-./\d])/.exec(s); // 2026-09-07 ~ 09-13
  if (short) {
    const p2 = (x) => x.padStart(2, '0');
    const from = `${short[1]}-${p2(short[2])}-${p2(short[3])}`, to = `${short[1]}-${p2(short[4])}-${p2(short[5])}`;
    if (to >= from) return { from, to };
  }
  const ym = new RegExp(`(\\d{4})[-./${U.year}]\\s*(\\d{1,2})(?!\\d)`).exec(s);
  if (scope === 'month' && ym) { const y = +ym[1], m = +ym[2]; if (m >= 1 && m <= 12) return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) }; }
  const y = /(\d{4})/.exec(s);
  if (scope === 'year' && y) return { from: `${y[1]}-01-01`, to: `${y[1]}-12-31` };
  const day = fallbackDay ?? new Date().toISOString().slice(0, 10);
  if (scope === 'year') return { from: `${day.slice(0, 4)}-01-01`, to: `${day.slice(0, 4)}-12-31` };
  if (scope === 'month') { const [yy, mm] = day.split('-').map(Number); return { from: `${day.slice(0, 7)}-01`, to: new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10) }; }
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const from = d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 6);
  return { from, to: d.toISOString().slice(0, 10) };
}
