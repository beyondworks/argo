// 크루 간 위임 제한 — 값의 단일 원천.
// 켜짐(on) = 종전 제한 그대로. 꺼짐(off) = 사용자가 대화방(1:1 스레드·회의실)에서 스위치로 푼 상태 — 그래도 상한은 있다.
//
//   delegate  한 턴(크루 한 번의 대답)에 결과를 기다리며 맡기는 위임(delegate) 횟수
//   mail      한 턴에 보내는 쪽지(send_to_crew) 횟수 — delegate와 따로 센다. 둘은 처음부터 별개 카운터였고(종전 각 2회),
//             delegate는 호출한 턴 안에서 동료 턴을 동기로 돌리지만 쪽지는 나중 턴 1건을 만들 뿐이라 비용 모양이 다르다.
//   hop       위임받은 일을 다시 넘기는 단계(사장→A→B→…). 이 값 이상에서는 동료 목록을 비운다(hop >= 값).
//   relay     회의실 `@A > @B > …` 이어받기 최대 인원
//   rounds    회의실 반응 라운드를 포함한 최대 라운드 수(1라운드 + 반응 라운드들)
//   tree      (풀림 전용) 사용자 메시지 하나에서 이어지는 **크루 턴 합계** — 위임받은 동료 턴 + 쪽지 배달 턴(받는 사람) + cc 배달 턴.
//             위 항목은 모두 한 턴·한 줄 기준이라 동료가 또 위임하면 곱해진다(10 × 단계 4). 이 합계가 그 곱셈을 막는다(유건 2026-10-01: 30회).
//             켜짐은 null — 종전 2회·2단계가 곱셈을 이미 작게 묶는다.
//
// 메신저(팀 메신저) 크루 턴은 이 스위치의 범위가 아니다: limitsFor가 메신저 맥락이면 값이 무엇이든 on을 돌려준다.
// 값을 쓰는 곳은 전부 이 표만 본다(chat.mjs 위임·쪽지·단계·프롬프트, cli-directives 쪽지 블록, crewmail 회신 안내, room.mjs).
export const DELEGATION_LIMITS = Object.freeze({
  on: Object.freeze({ relaxed: false, delegate: 2, mail: 2, hop: 2, relay: 3, rounds: 2, tree: null }),
  off: Object.freeze({ relaxed: true, delegate: 10, mail: 10, hop: 4, relay: 6, rounds: 4, tree: 30 }),
});

/** 메신저 크루 턴의 맥락인가 — 'msgr'(채널 턴)·'msgr-rules'(그 채널에서 위임받은 동료 턴). */
export const isMessengerCtx = (ctx) => ctx?.kind === 'msgr' || ctx?.kind === 'msgr-rules';

/** 이 턴에 적용할 제한 표. relaxed는 **엄격한 true만** 푼다(문자열·1 등은 켜짐 — fail-closed), 메신저 맥락은 항상 켜짐. */
export function limitsFor(relaxed, ctx = null) {
  return relaxed === true && !isMessengerCtx(ctx) ? DELEGATION_LIMITS.off : DELEGATION_LIMITS.on;
}

/** 저장된 대화방 값(thread·room 파일의 delegationLimit)이 "풀림"인가 — 필드 부재(새 대화)·true는 켜짐. */
export const isRelaxedStored = (stored) => stored?.delegationLimit === false;

/** 새 대화·새 회의가 기본값(켜짐)으로 시작하게 하는 필드 — **항상 명시적 true**.
    필드를 지우기만 하면 동기화 병합(mergeThread의 `{...other, ...primary}`)에서 다른 기기의 옛 꺼짐이 새 대화로 되살아나고,
    이전 값이 기본이던 때만 쓰면 다른 기기가 그 사이 푼 값이 경합에서 새 대화로 번진다(검수 2026-10-01 LOW-2). */
export const resetDelegationLimit = () => ({ delegationLimit: true });

// ── 합계 예산(tree) — 사용자 메시지 하나에서 이어지는 크루 턴의 총량.
// 같은 프로세스 안에서 위임 동료 턴(동기)은 객체를 그대로 공유하고, 쪽지 배달 턴(비동기·파일)은 쪽지 파일의 `tree: id`로 이 레지스트리를 찾는다.
// 레지스트리는 프로세스마다 따로다(globalThis — Next가 모듈을 여러 사본으로 번들해도 하나). 앱과 CLI가 별개 프로세스면 서로의 예산을 못 본다 —
// 그 경우 id를 모르는 풀린 쪽지는 **제한 상태로 배달**한다(fail-closed). 남은 수를 쪽지 파일에 싣는 방식은 형제 쪽지가 같은 값을 들고 가
// 각자 쓰므로 합계가 틀려 택하지 않았다(레지스트리는 정확하고, 틀리는 방향이 "덜 풀림"뿐이다).
const TREE_TTL_MS = 24 * 3600_000;
const trees = () => (globalThis.__argoDelegTrees ??= new Map());

/** 새 합계 예산. origin = 이 풀림을 켠 대화방({kind:'chat', slug} | {kind:'room'}) — 배달 직전에 그 스위치를 다시 읽는다. */
export function newTree(origin = null) {
  const now = Date.now();
  const map = trees();
  for (const [id, t] of map) if (t.exp <= now) map.delete(id); // 만료분 청소 — 쌓이기만 하는 객체의 보존 기간(24시간)
  const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const tree = { id, left: DELEGATION_LIMITS.off.tree, exp: now + TREE_TTL_MS, origin };
  map.set(id, tree);
  return tree;
}
/** id로 살아 있는 예산 찾기 — 모르거나 만료면 null(호출부는 제한 상태로 처리). */
export function getTree(id) {
  if (typeof id !== 'string') return null;
  const t = trees().get(id);
  if (!t) return null;
  if (t.exp <= Date.now()) { trees().delete(id); return null; }
  return t;
}
/** n만큼 차감 — 모자라면 한 푼도 차감하지 않고 false. 단일 스레드(이벤트 루프)라 확인-차감 사이에 끼어드는 것이 없다. */
export function spendTree(tree, n = 1) {
  if (!tree || !(tree.left >= n)) return false;
  tree.left -= n;
  return true;
}
