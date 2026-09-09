// 메시지의 실행권은 DB에 영구 보존한다. 심박 만료는 관측 신호이며 다른 기기의 재실행 허가가 아니다.
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../jsonstore.mjs';

export const EXECUTION_HEARTBEAT_MS = 30_000;
export const EXECUTION_STALE_MS = 5 * 60_000;

export function executionDb(client) {
  const rpc = async (name, args) => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(`msgr execution: ${error.message}`);
    return data;
  };
  const args = ({ wsId, crewId, msgId, channelId, attempt }) => ({
    p_ws: wsId, p_crew: crewId, p_source: msgId, p_channel: channelId, p_attempt: attempt,
  });
  return {
    claimExecution: (key) => rpc('msgr_execution_claim', args(key)),
    heartbeatExecution: (key) => rpc('msgr_execution_heartbeat', args(key)),
    finishExecution: (key, reply) => rpc('msgr_execution_finish', { ...args(key), p_reply: reply }),
  };
}

const keyOf = (wsId, job) => ({ wsId, crewId: job.crewId, msgId: job.msgId, channelId: job.channelId, attempt: job.msgrExecution.attempt });
async function checkpoint(job, execution, meta) {
  // 메모리도 먼저 바꾼다: 결과 저장이 실패한 동일 프로세스에서 다시 실행하는 일을 막는다.
  job.msgrExecution = execution;
  if (meta.path) await writeJsonAtomic(meta.path, job);
}

export async function beginMessengerExecution(wsId, db, job, meta = {}) {
  if (job.msgrExecution?.replyRow) {
    const row = await finishMessengerExecution(wsId, db, job, job.msgrExecution.replyRow, meta);
    return { kind: 'completed', row };
  }
  if (!job.msgrExecution) await checkpoint(job, { attempt: randomUUID(), phase: 'claiming' }, meta);
  const claim = await db.claimExecution(keyOf(wsId, job));
  if (claim.state === 'completed') return { kind: 'completed', row: { id: claim.reply_id } };
  // 동일 attempt 재호출도 acquired=false: RPC 응답 유실/프로세스 재시작 뒤 실제 실행 여부는 단정할 수 없다.
  if (!claim.acquired) return { kind: 'pending', stale: Date.now() - Date.parse(claim.heartbeat_at) > EXECUTION_STALE_MS };
  await checkpoint(job, { ...job.msgrExecution, phase: 'running' }, meta);
  return { kind: 'run' };
}

export async function finishMessengerExecution(wsId, db, job, replyRow, meta = {}) {
  if (!job.msgrExecution?.attempt) throw new Error('메신저 실행권이 없어 답글을 게시하지 못했습니다');
  await checkpoint(job, { ...job.msgrExecution, phase: 'publishing', replyRow }, meta);
  // RPC는 답글 INSERT와 completed 변경을 한 트랜잭션에 수행한다. 응답을 잃어도 같은 reply_id를 돌려준다.
  const row = await db.finishExecution(keyOf(wsId, job), replyRow);
  if (!row?.id) throw new Error('메신저 답글 저장 확인을 받지 못했습니다');
  return row;
}

export function executionHeartbeat(wsId, db, job, { intervalMs = EXECUTION_HEARTBEAT_MS, log = console.error } = {}) {
  let inflight = false;
  const timer = setInterval(async () => {
    if (inflight) return;
    inflight = true;
    try { await db.heartbeatExecution(keyOf(wsId, job)); }
    catch (error) { log('[argo] msgr 실행 심박 실패 — 실행권은 다른 기기로 넘기지 않습니다:', error.message); }
    finally { inflight = false; }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
