// 메신저 v2 초대함(받은 사람 지정 초대) — 남은 기간 표시·거절. 목록 읽기는 v2/my-invites.mjs, 화면은 v2/InvitesCard.jsx·InvitePreview(onDecline).
// 서버: msgr2_invite_decline(p_code) → true(거절함) | false(이미 정해짐 — 수락·취소·거절·만료로 더는 거절할 것이 없음). 앱 기기가 아니면 오류.

const HOUR = 3_600_000, DAY = 24 * HOUR;

/** 만료 시각 → 남은 기간 문구 키와 값. 없으면 기한 없음, 지났으면 만료, 1시간 안이면 곧, 하루 안이면 시간, 그 밖은 날(올림). */
export function inviteLeft(expiresAt, now = Date.now()) {
  if (expiresAt == null || expiresAt === '') return { key: 'inv.box.left.never', n: null };
  const at = Date.parse(String(expiresAt));
  if (!Number.isFinite(at)) return { key: 'inv.box.left.never', n: null };
  const left = at - now;
  if (left <= 0) return { key: 'inv.box.left.expired', n: null };
  if (left < HOUR) return { key: 'inv.box.left.soon', n: null };
  if (left < DAY) return { key: 'inv.box.left.hours', n: Math.ceil(left / HOUR) };
  return { key: 'inv.box.left.days', n: Math.ceil(left / DAY) };
}

/** 거절 — 'declined'(이번에 거절함) | 'gone'(이미 정해져 더 거절할 것이 없음 — 목록에서 빼면 된다). 오류는 메시지를 담아 던진다. */
export async function declineInvite(rpc, code) {
  const r = await rpc('msgr2_invite_decline', { p_code: code });
  if (r?.error) throw new Error(r.error.message || 'msgr2_invite_decline_failed');
  return r?.data === true ? 'declined' : 'gone';
}

/** 거절한 뒤 목록에서 그 초대를 바로 뺀다(서버 다시 읽기 전 — 같은 공간의 다른 초대가 있으면 다시 읽기가 채운다). */
export const withoutInvite = (list, code) => (list ?? []).filter((v) => v.code !== code);
