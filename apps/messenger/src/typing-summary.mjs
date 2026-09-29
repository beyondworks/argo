// '입력 중' 여러 크루 요약(순수) — 유건 확정 2026-09-29.
// 1명이면 그 이름, 2명 이상이면 가장 먼저 입력을 시작한 크루의 이름 + 나머지 인원("오길비 외 13명").
// 시작 순서는 호출자가 준 startedAt(그 크루가 지금 이어지는 입력을 처음 시작한 시각) 오름차순 — 마지막 방송 시각(매 방송마다 갱신되는 at)과는 다르다.
// 경계(유건 확정): 입력이 6초 넘게 끊겼다 다시 시작하면 "지금 이어지는 입력"만 보고 새 시작으로 본다(끊기기 전 더 이른 최초 시작은 안 본다).
export function orderByStart(crews) {
  return [...crews].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || String(a.id).localeCompare(String(b.id)));
}

// {first, othersCount} — first는 가장 먼저 시작한 크루, othersCount = 나머지 인원(0이면 단독)
export function typingSummary(crews) {
  const ordered = orderByStart(crews);
  return { first: ordered[0] ?? null, othersCount: Math.max(0, ordered.length - 1) };
}

// t(key, vars) 호출에 바로 넣을 수 있는 {key, vars} — summary.first가 없으면 null(보여줄 것이 없다)
export function typingLabelParams({ first, othersCount } = {}) {
  if (!first) return null;
  return othersCount > 0
    ? { key: 'msg.typing.others', vars: { name: first.name, n: othersCount } }
    : { key: 'msg.typing', vars: { name: first.name } };
}

// 스레드 안 '입력 중' 말풍선 — 3명까지는 크루별로 각자, 4명부터 얼굴을 겹친 말풍선 하나로 묶는다(유건 확정: 얼굴 4개 고정).
export const BUBBLE_GROUP_THRESHOLD = 4;
export const BUBBLE_GROUP_FACES = 4; // 그룹 말풍선에 겹쳐 보일 얼굴 개수(시작 순서대로, 5명이어도 4개까지만)

export function shouldGroupTypingBubbles(count) {
  return count >= BUBBLE_GROUP_THRESHOLD;
}

export function typingBubbleFaces(crews) {
  return orderByStart(crews).slice(0, BUBBLE_GROUP_FACES);
}
