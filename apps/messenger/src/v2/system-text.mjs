// 메신저 v2 시스템 글(D15): 서버는 본문 없이 meta.code + 값만 보낸다. 화면이 지금 언어(ko/en) 사전 키로 그린다.
// 코드 정본: supabase/migrations/20261018000000_msgr2_work.sql(work.limit·work.error·work.cancelled·topic.resolved), 약속 v1 LATE_MARK(work.late).
import { WORK_ERROR_CODES, LATE_MARK } from '../../../../packages/agent-link/contract/v1.mjs';

export const LIMIT_KINDS = Object.freeze(['streak', 'agent_minute', 'room_minute', 'topic', 'owner_day', 'depth']);

/**
 * meta → { key, vars, late } | null(시스템 글 코드가 아님). 모르는 코드·값은 일반 문구 키로(화면이 깨지지 않게).
 * nameOf(kind, id): 사람·에이전트 이름(모르면 빈 문자열).
 */
export function systemLine(meta, nameOf = () => '') {
  const code = meta && typeof meta === 'object' ? meta.code : null;
  if (typeof code !== 'string' || !code) return null;
  const late = meta.mark === LATE_MARK;
  const agent = meta.agent ? nameOf('agent', meta.agent) : '';
  if (code === 'work.limit') {
    const k = LIMIT_KINDS.includes(meta.limit) ? meta.limit : 'other';
    return { key: `v2.sys.limit.${k}`, vars: { agent }, late };
  }
  if (code === 'work.error') {
    const e = WORK_ERROR_CODES.includes(meta.error) ? meta.error : 'internal';
    return { key: `v2.sys.error.${e}`, vars: { agent }, late };
  }
  if (code === 'work.cancelled') return { key: 'v2.sys.cancelled', vars: { name: meta.by ? nameOf('user', meta.by) : '', agent }, late };
  if (code === 'topic.resolved') return { key: 'v2.sys.resolved', vars: { name: meta.by ? nameOf('user', meta.by) : '' }, late };
  return { key: 'v2.sys.unknown', vars: {}, late };
}
