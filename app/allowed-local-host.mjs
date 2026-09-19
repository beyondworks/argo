const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/;

/**
 * 로컬 무인증 모드에서 받을 Host를 제한한다.
 * 루프백은 항상 허용하고, LAN 접근은 ARGO_LOCAL_HOSTS의 쉼표 구분 정확 일치만 허용한다.
 */
export function isAllowedLocalHost(host, configured = process.env.ARGO_LOCAL_HOSTS || '') {
  const normalized = String(host || '').trim().toLowerCase();
  if (LOOPBACK_HOST_RE.test(normalized)) return true;
  return String(configured)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized);
}
