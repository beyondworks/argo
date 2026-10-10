// argo run 시작 안내의 판정 — 실행 담당(리스)을 실제로 판정한 뒤에만 결과를 말한다(src/sync.mjs leaseCheck 값을 읽기만, 쓰기·네트워크 없음).
// VPS 0.1.100 제보(2026-10-10): 시작 줄이 판정 전에 "이 기기가 실행을 먼저 맡음"이라 했고, 25초 뒤 실제로는 맥에 양보했다.
// leaseState.leader는 기동 때 참으로 시작하니(sync.mjs) 그 값만 보고 말하면 안 된다 — 확인된 보유(ownedAt > 0)만 '맡음'이다.

/** 지금 말할 수 있는 실행 담당 결과. null = 아직 판정 전(말하지 않는다).
    { kind: 'leader' } 이 기기가 맡음 · { kind: 'other', holder } 다른 기기가 맡음 · { kind: 'waiting' } 아직 아무도(러너 없음 양보·예비 대기 등)
    ttl = 리스 수명(src/sync.mjs LEASE_TTL_MS를 호출자가 넘긴다) — 이보다 오래된 남의 리스 글은 담당이 아니다. */
export function runRoleState(check, me, now = Date.now(), ttl = 120_000) {
  if (!check?.syncOn || !check.checkedAt) return null;
  // 쓰고 다시 읽어 확인하는 중이면 아직 모른다. 확인된 보유라도 실제 실행 판정(isCloudLeader — 엄격 판정의 확인 기한·잠에서 깬 뒤 재확인)이
  // 꺼져 있으면 지금은 실행하지 않으니 '맡았다'고 하지 않는다(분리 검수 M2). active는 호출자가 isCloudLeader()로 채운다(없으면 보유만 본다).
  if (check.leader) return !(check.ownedAt > 0) ? null : check.active === false ? { kind: 'waiting' } : { kind: 'leader' };
  const h = check.holder;
  if (h?.deviceId && h.deviceId !== me && now - (Number(h.ts) || 0) < ttl) return { kind: 'other', holder: h.deviceId };
  return { kind: 'waiting' };
}

/** 다시 알릴 만큼 바뀌었는가 — 판정 전(null) 순간은 알리지 않고, 결과나 담당 기기가 바뀔 때만. */
export function roleChanged(prev, next) {
  if (!next) return false;
  return !prev || prev.kind !== next.kind || prev.holder !== next.holder;
}
