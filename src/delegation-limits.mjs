// 크루 간 위임 제한 — 값의 단일 원천.
// 켜짐(on) = 종전 제한 그대로. 꺼짐(off) = 사용자가 대화방(1:1 스레드·회의실)에서 스위치로 푼 상태 — 그래도 상한은 있다.
//
//   delegate  한 턴(크루 한 번의 대답)에 결과를 기다리며 맡기는 위임(delegate) 횟수
//   mail      한 턴에 보내는 쪽지(send_to_crew) 횟수 — delegate와 따로 센다. 둘은 처음부터 별개 카운터였고(종전 각 2회),
//             delegate는 호출한 턴 안에서 동료 턴을 동기로 돌리지만 쪽지는 나중 턴 1건을 만들 뿐이라 비용 모양이 다르다.
//   hop       위임받은 일을 다시 넘기는 단계(사장→A→B→…). 이 값 이상에서는 동료 목록을 비운다(hop >= 값).
//   relay     회의실 `@A > @B > …` 이어받기 최대 인원
//   rounds    회의실 반응 라운드를 포함한 최대 라운드 수(1라운드 + 반응 라운드들)
//
// 메신저(팀 메신저) 크루 턴은 이 스위치의 범위가 아니다: limitsFor가 메신저 맥락이면 값이 무엇이든 on을 돌려준다.
// 값을 쓰는 곳은 전부 이 표만 본다(chat.mjs 위임·쪽지·단계·프롬프트, cli-directives 쪽지 블록, crewmail 회신 안내, room.mjs).
export const DELEGATION_LIMITS = Object.freeze({
  on: Object.freeze({ relaxed: false, delegate: 2, mail: 2, hop: 2, relay: 3, rounds: 2 }),
  off: Object.freeze({ relaxed: true, delegate: 10, mail: 10, hop: 4, relay: 6, rounds: 4 }),
});

/** 메신저 크루 턴의 맥락인가 — 'msgr'(채널 턴)·'msgr-rules'(그 채널에서 위임받은 동료 턴). */
export const isMessengerCtx = (ctx) => ctx?.kind === 'msgr' || ctx?.kind === 'msgr-rules';

/** 이 턴에 적용할 제한 표. relaxed는 **엄격한 true만** 푼다(문자열·1 등은 켜짐 — fail-closed), 메신저 맥락은 항상 켜짐. */
export function limitsFor(relaxed, ctx = null) {
  return relaxed === true && !isMessengerCtx(ctx) ? DELEGATION_LIMITS.off : DELEGATION_LIMITS.on;
}

/** 저장된 대화방 값(thread·room 파일의 delegationLimit)이 "풀림"인가 — 필드 부재(새 대화)·true는 켜짐. */
export const isRelaxedStored = (stored) => stored?.delegationLimit === false;

/** 새 대화·새 회의가 기본값(켜짐)으로 시작하게 하는 필드 — 이전 값이 풀림이었을 때만 **명시적 true**를 쓴다.
    필드를 지우기만 하면 동기화 병합(mergeThread의 `{...other, ...primary}`)에서 다른 기기의 옛 꺼짐이 새 대화로 되살아난다. */
export const resetDelegationLimit = (prev) => (isRelaxedStored(prev) ? { delegationLimit: true } : {});
