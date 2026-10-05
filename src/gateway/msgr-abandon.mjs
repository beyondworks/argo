// 큐가 버리거나 오래 붙잡은 메신저 잡의 안내 — queue.mjs startQueueWorker의 onAbandon·onStalled 훅(H1, 2026-10-05 분리 검수 + 2차 LOW-3·4).
// 문제: 큐가 '영구 오류'(또는 스키마 어긋남이 24시간을 넘긴 잡)를 `.failed` 파일로 빼면서 보낸 사람에게는 아무 흔적도 남기지 않아,
//   그 글은 영영 답이 없었다. 여기서 ① 활동 기록(events.jsonl)에 오류 한 줄 ② 그 채널에 실패 안내 한 줄을 남긴다.
// 스키마 어긋남(앱이 라이브 마이그레이션보다 먼저 나간 동안)으로 10분 넘게 막힌 잡은 보낸 사람이 최대 24시간 아무 표시도 못 받는다 → onStalled가 "늦어지고 있다"를 한 번 남긴다.
// 안내는 모두 멱등이다 — client_msg_id = `jobfail:<크루 id>:<잡 id>` / `jobwait:<크루 id>:<잡 id>`(msgr_messages 유니크, 같은 잡이 두 번 불려도 한 줄. insertMessage가 23505를 삼킨다).
// kind='system'이라 targetsCrew(kind !== 'text'면 false)가 걸러 어떤 크루 턴도 다시 만들지 않는다(되먹임 없음).
// 반환값 — true = 보냈다(또는 보낼 곳이 없다·권한이 없어 다시 보내도 같다), false = 못 보냈다(일시 실패): 큐가 .failed에 미전송 표지를 남겨 시작 때·다음 성공 처리 때 다시 부른다(LOW-4).
//   NOTICE_NO_SESSION = 기기 세션이 없어 DB 호출을 하지 않았다 — 시도로 세지 않는다(3차 F3: 세션 없이 앱을 몇 번 켜는 동안 5회 상한이 소진돼 세션이 생겨도 안내가 안 나갔다).
// 던지지 않는다 — 안내가 실패해도 큐는 멈추지 않는다(queue.mjs callHook이 한 번 더 감싸고 시간 상한을 둔다). 활동 기록은 로컬 파일이라 항상 먼저 남긴다(재시도 때는 다시 쓰지 않는다).
// msgr.mjs를 건드리지 않고 gateway.mjs의 큐 워커 연결(queueWorkerOptions)에서 붙는다.
import { appendEvent } from '../events.mjs';
import { loadCompany } from '../workspace.mjs';
import { pick } from './protocol.mjs';
import { sessionClient } from './msgr.mjs';
import { NOTICE_NO_SESSION } from './queue.mjs';

// 다시 보내도 같은 결과인 쓰기 실패 — 권한(RLS 42501)·제약(23xxx)·msgr_not_allowed. msgr.mjs permanentWrite와 같은 규칙(그 함수는 파일 밖으로 내보내지 않는다).
const permanentWrite = (e) => e?.code === '42501' || String(e?.code ?? '').startsWith('23') || /msgr_not_allowed/.test(String(e?.message ?? ''));

/** 안내 글 하나를 채널에 넣는다 — 위 반환 규칙. */
async function postNotice(wsId, session, job, info, prefix, body) {
  const { channelId, crewId, msgId } = job ?? {};
  if (!channelId || !crewId || msgId == null) return true; // 보낼 곳을 알 수 없는 손상 잡 — 다시 보낼 이유가 없다
  try {
    const c = await session();
    if (!c?.db) { console.error(`[argo] 큐 안내를 넣을 수 없어 건너뜁니다(${wsId}/${job.slug}/${msgId}): 기기 세션 없음`); return NOTICE_NO_SESSION; }
    const jobId = String(info.name ?? msgId).replace(/\.json$/, '');
    await c.db.insertMessage({
      channel_id: channelId, author_kind: 'crew', crew_id: crewId, kind: 'system', reply_to: msgId, thread_root: job.threadRoot ?? msgId,
      client_msg_id: `${prefix}:${crewId}:${jobId}`, body,
    });
    return true;
  } catch (x) {
    console.error(`[argo] 큐 안내를 넣을 수 없어 건너뜁니다(${wsId}/${job.slug}/${msgId}):`, x?.message ?? x);
    return permanentWrite(x);
  }
}

const langOf = async (wsId) => ((await loadCompany(wsId).catch(() => null)) ?? {}).lang ?? 'ko';

/** 버린 잡 안내 — info.reason: 'permanent'(다시 해도 같은 결과인 오류)·'schema-age'(스키마 어긋남이 24시간을 넘겨 포기). info.retry = 미전송 재전송(활동 기록은 다시 쓰지 않는다). */
export function makeMsgrAbandonNotifier(wsId, { session = sessionClient } = {}) {
  return async (job, e, info = {}) => {
    const lang = await langOf(wsId);
    const code = e?.code ? ` (${e.code})` : '';
    // 활동 기록 — 활동 화면이 이미 그리는 '오류 턴'(출처 messenger) 모양이라 화면 변경이 없다. 사용자 글 원문은 싣지 않는다.
    if (!info.retry) {
      await appendEvent(wsId, {
        type: 'turn', slug: job?.slug ?? null, source: 'messenger', ok: false, ms: 0, reason: 'queue-abandoned', ...(e?.code ? { code: e.code } : {}), ...(job?.msgId != null ? { msgId: job.msgId } : {}),
        error: pick(`메신저 글을 처리하지 못해 건너뛰었습니다${code}`, `A messenger message could not be processed and was skipped${code}`, lang),
      });
    }
    // 영구 오류는 다시 보내도 같은 결과일 수 있다 — "다시 보내 주세요"만 말하지 않는다(2차 LOW-4). 이 글을 보는 사람은 메신저 사용자(손님·멤버 — Argo 앱이 없을 수 있다)라
    // 앱의 '피드백' 같은 입구를 말하지 않고 메신저에서 할 수 있는 행동으로 안내한다: 다시 보내 보기, 계속되면 이 에이전트의 주인에게 알리기(3차 F4). 용어는 '사용자'·'에이전트'.
    // 24시간 상한 폐기는 그 사이 마이그레이션이 적용됐을 가능성이 커서 다시 보내면 된다.
    const body = info.reason === 'schema-age'
      ? pick('이 글은 처리하지 못했어요. 다시 보내 주세요.', 'This message could not be processed. Please send it again.', lang)
      : pick('이 글은 처리하지 못했어요. 다시 보내 보고, 같은 문제가 계속되면 이 에이전트의 주인에게 알려 주세요.',
        "This message could not be processed. Try sending it again; if it keeps happening, let this agent's owner know.", lang);
    return postNotice(wsId, session, job, info, 'jobfail', body);
  };
}

/** 스키마 어긋남 지연 안내 — 10분 넘게 막힌 잡의 채널에 "업데이트 적용 중이라 늦어진다"를 한 번. 잡은 큐에 남아 자동으로 다시 시도된다. 활동 기록은 남기지 않는다(버린 것이 아니다). */
export function makeMsgrStallNotifier(wsId, { session = sessionClient } = {}) {
  return async (job, _e, info = {}) => {
    const lang = await langOf(wsId);
    return postNotice(wsId, session, job, info, 'jobwait',
      pick('업데이트를 적용하는 중이라 답이 늦어지고 있어요. 자동으로 다시 시도합니다.', 'An update is being applied, so the reply is delayed. It will retry automatically.', lang));
  };
}
