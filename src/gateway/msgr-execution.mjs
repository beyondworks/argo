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
    claimExecution: (key) => rpc(key.workRunId ? 'msgr_work_execution_claim' : 'msgr_execution_claim', args(key)),
    heartbeatExecution: (key) => rpc('msgr_execution_heartbeat', args(key)),
    finishExecution: (key, reply) => rpc('msgr_execution_finish', { ...args(key), p_reply: reply }),
  };
}

// 이 프로세스가 시작한 시도. 잡 파일에 phase=running이 남았는데 여기 없으면, 같은 기기의 앞 프로세스가 답하던 중에 죽은 것이다(D25) —
// 큐는 선점 심박이 끊긴 잡만 되돌리므로(queue.mjs CLAIM_MAX_AGE_MS) 살아 있는 턴이 이렇게 다시 집히지 않는다.
// globalThis: Next가 이 모듈을 서버 엔트리마다 따로 번들해도 한 프로세스에 등록부 하나(src/turn-abort.mjs 선례) — 사본마다 Set이면
// 다른 사본이 시작한 살아 있는 시도를 끊긴 턴으로 오판해 거짓 중단 안내를 올린다(검수 #648 권고).
const startedHere = (globalThis.__argoMsgrStarted ??= new Set());
const keyOf = (wsId, job) => ({ wsId, crewId: job.crewId, msgId: job.msgId, channelId: job.channelId, attempt: job.msgrExecution.attempt, ...(job.workRunId ? { workRunId: job.workRunId } : {}) });
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
  // 끊긴 턴은 다시 돌리지 않는다(도구 부작용 중복). 중단 답으로 닫는 것은 호출자 몫 — finish RPC가 시도 소유권을 다시 확인한다.
  const stale = Date.now() - Date.parse(claim.heartbeat_at) > EXECUTION_STALE_MS;
  if (!claim.acquired && job.msgrExecution.phase === 'running' && !startedHere.has(job.msgrExecution.attempt)) return { kind: 'interrupted', stale };
  // 동일 attempt 재호출도 acquired=false: RPC 응답 유실/프로세스 재시작 뒤 실제 실행 여부는 단정할 수 없다.
  if (!claim.acquired) return { kind: 'pending', stale };
  startedHere.add(job.msgrExecution.attempt);
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
