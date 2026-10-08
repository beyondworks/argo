// 실행 담당 역할 — 이 프로세스가 클라우드 리스(src/sync.mjs renewLease)에 어느 순위로 참여하는가. 노드 의존 0(지시문·게이트웨이·CLI가 같이 쓴다).
//   우선(preferred, ARGO_PREFER_LEADER=1 — argo run 기본): 항상 켜 둔 서버가 늘 담당(2026-09-29)
//   일반(normal — 맥 앱·상주 :3001·argo run --no-prefer)
//   예비(standby, ARGO_STANDBY_LEADER=1 — argo run --standby): 다른 기기가 담당하지 않을 때만 맡는 서버(맥 우선·VPS 예비, 2026-10-08)
// 더 높은 역할의 기기는 낮은 역할이 잡은 새 리스를 가져오고, 같은 역할끼리는 먼저 잡은 쪽을 존중한다. 둘 다 켜져 있으면 예비로 본다 — 가져가지 않는 쪽이 안전하다.
export const ROLE_RANK = { standby: 0, normal: 1, preferred: 2 };

export function leaseRole(env = process.env) {
  if (env.ARGO_STANDBY_LEADER === '1') return 'standby';
  if (env.ARGO_PREFER_LEADER === '1') return 'preferred';
  return 'normal';
}

/** 리스 글의 역할 순위 — 표지가 없는 글(옛 버전·일반 기기)은 일반이다. 옛 버전은 standby 표지를 몰라 예비 기기 글도 일반으로 읽는다(그래서 옛 맥은 되찾지 않는다). */
export const docRank = (doc) => (doc?.preferred ? ROLE_RANK.preferred : doc?.standby ? ROLE_RANK.standby : ROLE_RANK.normal);

/** 리스 글에 싣는 역할 표지 — 일반은 아무것도 싣지 않는다(종전 글과 같은 모양). */
export const roleMark = (role) => (role === 'preferred' ? { preferred: true } : role === 'standby' ? { standby: true } : {});
