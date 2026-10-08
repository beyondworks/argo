// 업무 현황(유건 10/8) 읽기 — 서버 office_work_status 함수 하나로만(쓰기 0). 예시 모드(서버 설정 없음)는 data/work-status-sample.js.
// 부하: 화면을 연 사람 1명당 열 때 1회 + 화면이 보이는 동안 60초에 1회 + 탭 복귀(1분에 한 번까지, core/refetch.js). 폴링은 화면이 보일 때만.
import { configured } from './supabase.js';
import { rpc, orgOf } from './tasks.js';

export const POLL_MS = 60_000;
/** 그 조직 공간의 업무 현황 — 개인 공간은 화면이 막는다(조직 전용). 반환 모양은 core/work-status-model.js buildStatus의 data */
export async function loadWorkStatus(space) {
  if (!configured) return (await import('../data/work-status-sample.js')).sampleWorkStatus(space);
  return rpc('office_work_status', { p_org: orgOf(space) });
}
const ERRORS = { business_forbidden: 'ws.err.forbidden', task_signin: 'ws.err.signin', session_input: 'ws.err.load' };
/** 읽기 실패 문구(사전 키) — 권한·로그인처럼 다시 시도해도 같은 사유는 그 사유로 */
export const statusError = (e) => ERRORS[e?.message] ?? (String(e?.code) === '42501' ? 'ws.err.forbidden' : 'ws.err.load');
