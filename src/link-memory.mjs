// 메신저 v2 링크 범위 턴의 기억 칸(유건 2026-10-22 22:4x "본체가 조직 대화를 개인 기억에 섞어 쓰고 조직을 나가도 회수 안 되는 결함부터 고쳐 주세요").
// 링크 범위 = { kind:'link', work, room, owner, memoryOff?, space?, spaceKind? } — 연결부(agent-link-host.mjs)가 서버 msgr2_agent_rooms로 방의 공간을 알아 싣는다.
// 이 범위는 쪽지 배달 턴(crewmail)·결재 후속 턴(approvalScope)·위임 턴(childCtx)으로 그대로 이어진다 — 그래서 일지 정책을 여기 한 곳에서 정한다.
//   · 기억 안 남김(memoryOff) → 일지 0
//   · 개인 공간(spaceKind 'personal') → 종전대로 개인 일지(볼트)
//   · 팀 공간(spaceKind 'team' + space uuid) → 조직 칸: 태그 org-<공간>-ch-<방>. saveHandover가 볼트 밖 .msgr-journal/에 쓴다(색인·동기화·셸 접근 밖, 파일 단위 회수)
//   · 모름(옛 범위·조회 실패·잘못된 값) → 일지 0(fail-closed — 그 턴 기억만 빠지고 조직 대화가 개인 기억에 섞이지 않는다)
// 의존성 없는 파일이다(chat.mjs·departed.mjs·연결부가 함께 쓴다).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 문맥(mirrorCtx)이 링크 범위면 그 범위, 아니면 null */
export const linkScopeOf = (ctx) => (ctx?.kind === 'scope' && ctx.scope?.kind === 'link' ? ctx.scope : null);

/** 링크 범위의 조직 칸 태그 — 팀 공간이고 공간·방이 uuid일 때만, 아니면 null */
export function linkOrgTag(scope) {
  if (scope?.kind !== 'link' || scope.spaceKind !== 'team') return null;
  const space = String(scope.space ?? ''), room = String(scope.room ?? '');
  return UUID.test(space) && UUID.test(room) ? `org-${space.toLowerCase()}-ch-${room.toLowerCase()}` : null;
}

/** 링크 범위 턴의 일지 정책 — 링크 범위가 아니면 받은 journal 그대로. 부르는 쪽이 이미 끈 일지(off)는 그대로 끈다. */
export function linkJournal(ctx, journal = null) {
  const s = linkScopeOf(ctx);
  if (!s || journal?.off === true) return journal;
  if (s.memoryOff === true) return { off: true };
  if (s.spaceKind === 'personal') return journal;
  const tag = linkOrgTag(s);
  return tag ? { tag } : { off: true };
}

/** 회수 대상 방 — 링크 범위 줄 가운데 개인 공간이 아닌 것(팀·모름)의 방 id(소문자). 개인 공간 기록은 회수하지 않는다(D3 현행 유지). */
export function linkRecallRoom(scope) {
  if (scope?.kind !== 'link' || scope.spaceKind === 'personal') return null;
  const room = String(scope.room ?? '');
  return UUID.test(room) ? room.toLowerCase() : null;
}
