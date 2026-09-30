// 분석 기간(유건 9/30): 이번 달·올해·전체(첫 거래일부터) 버튼, 직접 고른 날짜는 preset 'custom'. 기본은 전체.
// 분석 화면에서만 쓰므로 첫 화면 묶음(dashboard-model.js)과 떼어 둔다(첫 화면 JS 150KB 상한).
import { dateOnly } from './dashboard-model.js';

export const PRESETS = ['month', 'year', 'all'];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function presetPeriod(preset, today = new Date(), first = null) {
  const to = ymd(today);
  if (preset === 'year') return { from: `${today.getFullYear()}-01-01`, to };
  const month = ymd(new Date(today.getFullYear(), today.getMonth(), 1));
  if (preset !== 'all' || !dateOnly(first)) return { from: month, to };
  const floor = ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3650)); // 조회 상한(약 10년)
  return { from: first > to ? month : first < floor ? floor : first, to };
}
/** 저장된 조건 → 실제 날짜. 프리셋이면 오늘 기준으로 다시 계산한다 */
export const resolveFilters = (filters, today = new Date(), first = null) => (filters && PRESETS.includes(filters.preset) ? { ...filters, ...presetPeriod(filters.preset, today, first) } : filters);
/** 첫 거래일 — 거래 활동·청구입금 기록 중 가장 이른 한국 날짜 */
export function firstDay(data) {
  const ats = [...(data?.activity ?? []), ...(data?.entries ?? [])].map((r) => Date.parse(r.at)).filter(Number.isFinite);
  if (!ats.length) return null;
  return new Date(Math.min(...ats) + 9 * 3600000).toISOString().slice(0, 10);
}
