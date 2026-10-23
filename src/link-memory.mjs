// 메신저 v2 링크 범위 턴의 기억 칸(유건 2026-10-22 22:4x "본체가 조직 대화를 개인 기억에 섞어 쓰고 조직을 나가도 회수 안 되는 결함부터 고쳐 주세요").
// 링크 범위 = { kind:'link', work, room, owner, memoryOff?, space?, spaceKind?, relayed? } — 연결부(agent-link-host.mjs)가 서버 msgr2_agent_rooms로 방의 공간을 알아 싣는다.
// 이 범위는 쪽지 배달 턴(crewmail)·결재 후속 턴(approvalScope)·위임 턴(childCtx)으로 그대로 이어진다 — 그래서 일지 정책을 여기 한 곳에서 정한다.
//   · 기억 안 남김(memoryOff) → 일지 0
//   · 개인 공간(spaceKind 'personal') → 종전대로 개인 일지(볼트)
//   · 팀 공간(spaceKind 'team' + space uuid) → 조직 칸: 태그 org-<공간>-rm-<방>. saveHandover가 볼트 밖 .msgr-journal/에 쓴다(색인·동기화·셸 접근 밖, 파일 단위 회수).
//     옛 채널 일지(org-<조직>-ch-<채널>)와 이름을 가른다 — 옛 회수(옛 브리지)는 -ch-만 옛 서버에 묻는다. v2에서 새로 생긴 방을 옛 서버가 모른다고 답해 v2 조직 기억을 지우지 않게.
//   · 모름(옛 범위·조회 실패·잘못된 값) → 일지 0(fail-closed — 그 턴 기억만 빠지고 조직 대화가 개인 기억에 섞이지 않는다)
//   · 전해 받은 일(쪽지 배달·위임)의 팀 방 턴 → 일지 0(linkJournal relayed)
// 회수 각인 키(departed.mjs): 옛 채널 = <채널 id>, 링크 팀 방 = link:<방>(그 에이전트 소속으로 판정), 전해 받은 링크 줄 = linkr:<방>(내 에이전트가 하나라도 남았나로 판정).
// 옛 채널 id와 v2 방 id가 같아도(백필이 id를 그대로 옮겼다) 키가 달라 한쪽 회수가 다른 쪽 기록을 지우지 않는다(분리 검수 I-1).
// 의존성 없는 파일이다(chat.mjs·departed.mjs·연결부가 함께 쓴다).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 문맥(mirrorCtx)이 링크 범위면 그 범위, 아니면 null */
export const linkScopeOf = (ctx) => (ctx?.kind === 'scope' && ctx.scope?.kind === 'link' ? ctx.scope : null);

/** 링크 범위의 조직 칸 태그 — 팀 공간이고 공간·방이 uuid일 때만, 아니면 null */
export function linkOrgTag(scope) {
  if (scope?.kind !== 'link' || scope.spaceKind !== 'team') return null;
  const space = String(scope.space ?? ''), room = String(scope.room ?? '');
  return UUID.test(space) && UUID.test(room) ? `org-${space.toLowerCase()}-rm-${room.toLowerCase()}` : null;
}

/** 링크 범위 턴의 일지 정책 — 링크 범위가 아니면 받은 journal 그대로. 부르는 쪽이 이미 끈 일지(off)는 그대로 끈다.
    relayed = 전해 받은 일(쪽지 배달·위임 턴): 팀 방이면 일지를 쓰지 않는다 — 받은 에이전트는 그 방 멤버가 아닐 수 있어 소속으로 회수할 수 없다(옛 규칙 M2와 같이 전해 받은 일은 그 방 기록이 아니다).
    개인 공간은 전해 받은 일도 종전 그대로. */
export function linkJournal(ctx, journal = null, { relayed = false } = {}) {
  const s = linkScopeOf(ctx);
  relayed = relayed || s?.relayed === true; // 범위의 표지 — 쪽지 배달(scheduler)·위임(chat.mjs childCtx)이 싣고, 결재 후속 턴(approvalScope)이 범위째 이어받는다
  if (!s || journal?.off === true) return journal;
  if (s.memoryOff === true) return { off: true };
  if (s.spaceKind === 'personal') return journal;
  const tag = relayed ? null : linkOrgTag(s);
  return tag ? { tag } : { off: true };
}

/** 링크 범위 턴의 활동 기록(events.jsonl — 개인 클라우드로 동기화된다)에 지시 원문을 남기지 않을 때의 대체값. 남겨도 되면 null.
    판정은 linkJournal과 같다: 개인 공간으로 **확인된** 방만 원문(gist·msg·steps)을 남긴다. 팀 공간·모름(옛 범위·조회 실패)·기억 안 남김(memoryOff)은 고정 라벨만.
    링크 범위가 아닌 턴(로컬·옛 채널·위임 등)은 null — 종전 그대로. 원장은 행 합집합 병합이라 나중에 회수로 지울 수 없어 쓰지 않는 쪽으로 막는다(검수 2026-10-23).
    gist 라벨에 방 id 앞 8자를 붙여 활동 화면에서 어느 방의 일인지만 알 수 있게 한다. */
export function linkEventScrub(ctx, lang = 'ko') {
  const s = linkScopeOf(ctx);
  if (!s || (s.spaceKind === 'personal' && s.memoryOff !== true)) return null;
  const team = s.spaceKind === 'team';
  const room = String(s.room ?? '').slice(0, 8);
  const label = lang === 'en' ? (team ? 'Org room request' : 'Messenger room request') : (team ? '조직 방 지시' : '메신저 방 지시');
  return { gist: room ? `${label} (${room})` : label };
}

/** 회수 대상 방 — 팀 공간이라고 **명시된** 링크 범위 줄의 방 id(소문자). 개인 공간·모름(옛 범위·조회 실패)은 회수하지 않는다(D3 현행 유지, 분리 검수 I-2 —
    서버는 내 에이전트가 없는 방의 공간을 알려 주지 않아 모름 줄이 개인 1:1인지 가릴 수 없다). */
export function linkRecallRoom(scope) {
  if (scope?.kind !== 'link' || scope.spaceKind !== 'team') return null;
  const room = String(scope.room ?? '');
  return UUID.test(room) ? room.toLowerCase() : null;
}
