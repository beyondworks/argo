// 성과 기록 데이터(유건 9/29) — 서버 office_perf_* 함수로만. 본인 기록은 report, 관리자 화면은 team.
// 부하: 화면을 열거나 기간을 바꿀 때 1회 읽기, 누를 때만 쓰기. 폴링 없음.
import { useCallback, useEffect, useState } from 'react';
import { rpc, orgOf } from './tasks.js';
import { configured } from './supabase.js';
import { perfSample, perfSampleWrite } from '../data/sample.js';

const ERRORS = { perf_forbidden: 'permission', perf_input: 'input', perf_period: 'period', perf_shared: 'shared', perf_locked: 'locked', perf_review: 'review', perf_request: 'request', perf_conflict: 'conflict', task_signin: 'signin' };
export const perfError = (e) => `perf.error.${ERRORS[e?.message] ?? (String(e?.code) === '42501' ? 'permission' : 'failed')}`;

function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try { setState({ data: await fn(), error: null, loading: false }); }
    catch (e) { setState({ data: null, error: perfError(e), loading: false }); }
  }, deps); // deps는 부르는 쪽이 정한다(fn은 매번 새로 만들어진다)
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

// 예시 모드(서버 설정 없음)는 예시 기록을 보여 준다 — 서버 호출 없음
export const usePerfReport = (space, from, to) => useLoad(() => (configured ? rpc('office_perf_report', { p_org: orgOf(space), p_from: from, p_to: to }) : perfSample(from, to)), [space, from, to]);
export const usePerfTeam = (space, period, enabled) => useLoad(() => (enabled ? rpc('office_perf_team', { p_org: orgOf(space), p_period: period }) : null), [space, period, enabled]);

export async function perfWrite(space, action, data) {
  if (!configured) return perfSampleWrite(action, data);
  try { return await rpc('office_perf_write', { p_org: orgOf(space), p_action: action, p_data: data }); }
  catch (e) { throw new Error(perfError(e)); }
}
export async function perfManage(space, action, data) {
  try { return await rpc('office_perf_manage', { p_org: orgOf(space), p_action: action, p_data: data }); }
  catch (e) { throw new Error(perfError(e)); }
}
