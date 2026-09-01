/** 비움·되살림 각인 — "새 대화"·"회의 마치기"(비움)와 "대화 이어가기"·"회의 다시 열기"(되살림)를
    한 축의 두 사건으로 두고, mergeThread가 최신값으로 승부한다(src/sync.mjs).

    각인이 필요한 이유: 동기화는 union 병합이라, 각인이 없으면 원격이 든 옛 메시지가 그대로 되살아나
    "새 대화"가 8초 만에 옛 대화로 돌아온다(실사용 제보 2026-09-01 — 로컬 0건 + 원격 851건 → 851건).

    **"순서"와 "자르는 지점"을 분리한다(분리 검수 3R MEDIUM-1).**
    - resetAt·resumedAt = **순서값**. 어느 사건이 최신인지 겨루는 용도로만 쓴다. 되살림은 원격의
      미지 tombstone(값을 모른다)을 이겨야 하므로 벽시계를 쓸 수밖에 없고, 비움은 그 되살림보다
      커야 하므로(단조) 벽시계 오염을 물려받을 수 있다 — 그래서 순서값으로 메시지를 자르면 안 된다.
    - cutTs = **자르는 지점**. 비울 때 로컬이 실제로 본 메시지의 최대 ts + 1. 실존 ts에만 앵커되므로
      부풀지 않고, "이미 있던 것만" 정확히 자르며 못 본 것(다른 기기의 새 메시지)은 자르지 않는다.
      2R MEDIUM-2의 재현(시계 +1h 기기의 리셋이 상대 기기 신규 메시지를 삭제)과 3R MEDIUM-1의
      재현(시계 +1h 기기의 **되살림 → 비움** 경유로 같은 삭제)을 모두 막는다.

    단조: 두 순서값 각각 직전 두 마커보다 엄격히 크게. 아니면 되살림 뒤의 비움이 resumedAt에 눌려
    무효가 되고(resetAt <= resumedAt이면 cut 0), 연속 리셋이 앞선 tombstone을 후퇴시킨다.

    알려진 한계 2가지:
    - ts가 없는 메시지는 0으로 취급돼 비움에 항상 잘린다(sync.mjs의 `Number(m?.ts) || 0`).
      현행 writer 8곳은 전부 ts를 넣으므로(grep 확인) 실데이터에는 해당이 없다고 본다.
    - 비움 시점에 로컬이 아직 못 받은 원격 메시지는 살아남아 "새 대화가 안 비었다"로 보일 수 있다
      (8초 주기 밖 — 오프라인 복귀·기동 직후). 못 본 것을 지우는 쪽이 더 나쁘므로 의도된 트레이드다. */

const lastTsOf = (t) => Math.max(0, ...(t?.messages ?? []).map((m) => Number(m?.ts) || 0));
const priorOf = (t) => Math.max(Number(t?.resetAt) || 0, Number(t?.resumedAt) || 0);

/** 비움 각인 — 스프레드로 쓴다: { messages: [], ...resetStamp(prev) }. prev = 비우기 직전 스레드/방.
    cutTs에 직전 cutTs 하한이 필요한 이유(분리 검수 4R HIGH-1): **빈 스레드 재비움**(슬래시 /new와
    DELETE API는 버튼과 달리 빈 스레드에서도 도달)에서 lastTsOf=0이라 cutTs가 1로 후퇴하는데,
    1은 truthy라 sync.mjs의 resetAt 폴백(cutTs || resetAt)도 안 걸려 자르기가 "ts<1" = 무효가 되고
    원 제보(원격 851건 부활)가 그대로 재발한다(실측). 자르기 지점은 순서를 겨루지 않으므로
    엄격 증가는 불요 — 후퇴만 막는다(lastTs가 안 늘었으면 자를 것도 안 늘었다). */
export const resetStamp = (prev) => ({
  resetAt: Math.max(lastTsOf(prev) + 1, priorOf(prev) + 1), // 순서 — 직전 되살림을 반드시 이긴다
  cutTs: Math.max(lastTsOf(prev) + 1, Number(prev?.cutTs) || 0), // 자르는 지점 — 벽시계 미오염 + 후퇴 금지
});

/** 되살림 각인 — 벽시계와 직전 마커 중 큰 쪽. prev = 되살리기 직전의 현재 스레드/방(= 각인 보유자). */
export const resumeStamp = (prev, now = Date.now()) => Math.max(now, priorOf(prev) + 1);
