// 기기 링크(/api/device/link) 실패 응답 → 로그인 화면에 보일 문구. 서버는 kind(unreachable|rejected|unknown)와 code를 주고,
// 문구는 표시 언어 사전에서 고른다. kind를 모르는 예전 응답은 서버의 error(ko)를 그대로 쓴다. 순수 함수 — t는 i18n의 t.
const KEYS = { unreachable: 'login.linkUnreachable', rejected: 'login.linkRejected', unknown: 'login.linkUnknown' };

export function linkErrorView(res, t) {
  const key = KEYS[res?.kind];
  return { text: key ? t(key) : String(res?.error ?? ''), code: typeof res?.code === 'string' ? res.code : '' };
}
