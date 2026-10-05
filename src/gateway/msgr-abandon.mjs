// 큐가 버린 메신저 잡의 안내 — queue.mjs startQueueWorker의 onAbandon 훅(H1, 2026-10-05 분리 검수).
// 문제: 큐가 '영구 오류'(또는 스키마 어긋남이 24시간을 넘긴 잡)를 `.failed` 파일로 빼면서 보낸 사람에게는 아무 흔적도 남기지 않아,
//   그 글은 영영 답이 없었다. 여기서 ① 활동 기록(events.jsonl)에 오류 한 줄 ② 그 채널에 실패 안내 한 줄을 남긴다.
// 안내는 멱등이다 — client_msg_id = `jobfail:<크루 id>:<잡 id>`(msgr_messages 유니크, 같은 잡이 두 번 버려져도 한 줄. insertMessage가 23505를 삼킨다).
// 던지지 않는다 — 안내가 실패해도 큐는 멈추지 않는다(queue.mjs notifyAbandon이 한 번 더 감싸고 시간 상한을 둔다). 활동 기록은 로컬 파일이라 항상 먼저 남긴다.
// msgr.mjs를 건드리지 않고 gateway.mjs의 큐 워커 연결(queueWorkerOptions)에서 붙는다.
import { appendEvent } from '../events.mjs';
import { loadCompany } from '../workspace.mjs';
import { pick } from './protocol.mjs';
import { sessionClient } from './msgr.mjs';

export function makeMsgrAbandonNotifier(wsId, { session = sessionClient } = {}) {
  return async (job, e, info = {}) => {
    const { lang = 'ko' } = (await loadCompany(wsId).catch(() => null)) ?? {};
    const code = e?.code ? ` (${e.code})` : '';
    // 활동 기록 — 활동 화면이 이미 그리는 '오류 턴'(출처 messenger) 모양이라 화면 변경이 없다. 사용자 글 원문은 싣지 않는다.
    await appendEvent(wsId, {
      type: 'turn', slug: job?.slug ?? null, source: 'messenger', ok: false, ms: 0, reason: 'queue-abandoned', ...(e?.code ? { code: e.code } : {}), ...(job?.msgId != null ? { msgId: job.msgId } : {}),
      error: pick(`메신저 글을 처리하지 못해 건너뛰었습니다${code}`, `A messenger message could not be processed and was skipped${code}`, lang),
    });
    const { channelId, crewId, msgId } = job ?? {};
    if (!channelId || !crewId || msgId == null) return; // 보낼 곳을 알 수 없는 손상 잡
    try {
      const c = await session();
      if (!c?.db) { console.error(`[argo] 큐 실패 안내를 넣을 수 없어 건너뜁니다(${wsId}/${job.slug}/${msgId}): 기기 세션 없음`); return; }
      const jobId = String(info.name ?? msgId).replace(/\.json$/, '');
      await c.db.insertMessage({
        channel_id: channelId, author_kind: 'crew', crew_id: crewId, kind: 'system', reply_to: msgId, thread_root: job.threadRoot ?? msgId,
        client_msg_id: `jobfail:${crewId}:${jobId}`,
        body: pick('이 글은 처리하지 못했어요. 다시 보내 주세요.', 'This message could not be processed. Please send it again.', lang),
      });
    } catch (x) {
      console.error(`[argo] 큐 실패 안내를 넣을 수 없어 건너뜁니다(${wsId}/${job.slug}/${msgId}):`, x?.message ?? x);
    }
  };
}
