/** 비움·되살림 각인 — "새 대화"·"회의 마치기"(비움)와 "대화 이어가기"·"회의 다시 열기"(되살림)를
    한 축의 두 사건으로 두고, mergeThread가 최신값으로 승부한다(src/sync.mjs: cutAt = resumedAt >= resetAt ? 0 : resetAt).

    각인이 필요한 이유: 동기화는 union 병합이라, 각인이 없으면 원격이 든 옛 메시지가 그대로 되살아나
    "새 대화"가 8초 만에 옛 대화로 돌아온다(실사용 제보 2026-09-01 — 로컬 0건 + 원격 851건 → 851건).

    **비움 각인에 벽시계(Date.now)를 쓰지 않는다.** 기기 시계가 앞서 있으면 tombstone이 미래 시각이 되고,
    그 뒤 다른 기기가 실제로 쓴 메시지(더 작은 ts)까지 잘라 조용히 삭제한다 — 잘린 메시지는 .archive에도
    없어 어디에도 남지 않는다(분리 검수 2R MEDIUM-2 재현: 시계 +1h 기기의 리셋이 상대 기기 신규 메시지를
    0건으로 만듦). 대신 **로컬이 실제로 본 것의 상한**(마지막 ts)을 앵커로 쓴다: "이미 있던 것만" 정확히
    자르고, 못 본 것은 자르지 않는다(비파괴 방향으로 오차를 낸다).

    되살림 각인은 벽시계를 써도 안전하다 — 되살림은 자르기를 **끄기만** 하므로 커도 파괴적이지 않다.

    두 각인 모두 직전 두 마커보다 **엄격히 크게** 만든다(단조). 그러지 않으면 되살림 뒤의 비움이
    resumedAt에 눌려 무효가 되고(resetAt <= resumedAt이면 cutAt=0), 연속 리셋이 앞선 tombstone을
    후퇴시킨다.

    알려진 한계: ts가 없는 메시지는 0으로 취급돼 비움에 항상 잘린다(sync.mjs의 `Number(m?.ts) || 0`).
    현행 writer 8곳은 전부 ts를 넣으므로(grep 확인) 실데이터에는 해당이 없다고 보며, 보존 쪽으로 바꾸면
    "리셋 이후에도 옛 대화가 남는" 원 제보를 다시 여는 트레이드라 현행을 유지한다. */

const lastTsOf = (t) => Math.max(0, ...(t?.messages ?? []).map((m) => Number(m?.ts) || 0));
const priorOf = (t) => Math.max(Number(t?.resetAt) || 0, Number(t?.resumedAt) || 0);

/** 비움 각인 — 지금 버리는 대화의 마지막 ts 기준(벽시계 미사용). prev = 비우기 직전 스레드/방. */
export const resetStamp = (prev) => Math.max(lastTsOf(prev) + 1, priorOf(prev) + 1);

/** 되살림 각인 — 벽시계와 직전 마커 중 큰 쪽. prev = 되살리기 직전의 현재 스레드/방(= 각인 보유자). */
export const resumeStamp = (prev, now = Date.now()) => Math.max(now, priorOf(prev) + 1);
