// 등급표 — offer.limits.tier(서버가 정한다, D12)마다 본체가 무엇을 하는지의 정본. 연결부(src/agent-link-host.mjs)는 이 표만 본다.
// ownerTools: 주인의 몸(파일·셸·웹·커넥터·브라우저·도구 설치·예약)을 쓰는 도구 묶음. false면 손님 턴 도구 묶음이다 —
//   지금 배포본에서 조직 채널 에이전트가 주인 아닌 사람의 지시로 도는 턴과 같다(chat.mjs isGuestCtx: 권한 게이트 허용 목록 mcp__crew*,
//   SDK allowedTools는 mcp__만, CLI 러너는 손님 턴 거절). 승인 뒤 후속 턴도 그대로 손님이다(OWNER_APPROVAL_LIFTS_GUEST=false).
// approvals·effects·uploads는 약속 tierAllows와 같아야 한다(서버가 같은 표로 tier_denied를 낸다) — 시험이 둘을 대조한다.
// handoffs: 결과의 넘김을 싣는가(동료 목록 offer.peers는 서버가 등급으로 거른다 — guest는 빈 배열).
export const TIER_POLICY = Object.freeze({
  owner: Object.freeze({ run: true, ownerTools: true, approvals: true, effects: true, uploads: true, handoffs: true }),
  team: Object.freeze({ run: true, ownerTools: false, approvals: true, effects: true, uploads: true, handoffs: true }),
  guest: Object.freeze({ run: true, ownerTools: false, approvals: false, effects: false, uploads: false, handoffs: false }),
});

/** 모르는 등급은 guest로 읽는다(fail-closed — 같은 v 안에서 서버가 새 등급을 내도 본체가 권한을 넓히지 않는다). */
export const tierPolicy = (tier) => TIER_POLICY[tier] ?? TIER_POLICY.guest;
