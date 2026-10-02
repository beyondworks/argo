// 평가 레포트 데이터(트랙 C) — 서버 office_perf_eval_list / office_perf_eval_write 함수로만.
// 부하: 평가 탭을 열 때 1회 읽기, 저장을 누를 때만 쓰기. 폴링 없음. 예시 모드는 data/company-sample.js를 화면 메모리에서.
import { useCallback, useEffect, useState } from 'react';
import { configured } from './supabase.js';
import { rpc, orgOf } from './tasks.js';
import { canManage, ME } from './session.js';
import { perfError } from './perf.js';
import { sampleEvals, sampleEvalWrite } from '../data/company-sample.js';

export function useEvals(space) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const org = orgOf(space);
      const data = configured ? await rpc('office_perf_eval_list', { p_org: org }) : sampleEvals(space, canManage(space), ME.id);
      setState({ data, error: null, loading: false });
    } catch (e) { setState({ data: null, error: perfError(e), loading: false }); }
  }, [space]);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

export async function evalWrite(space, data) {
  try {
    return configured ? await rpc('office_perf_eval_write', { p_org: orgOf(space), p_action: 'eval.add', p_data: data }) : sampleEvalWrite(space, data, ME.name);
  } catch (e) { throw new Error(perfError(e)); }
}
